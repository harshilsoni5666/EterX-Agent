import { CognitiveReasoningEngine, type CognitiveState } from '../reasoning/cognitive-engine';
import { DeepSelfCorrectionEngine } from '../reasoning/self-correction';
import { ToolIntelligenceEngine } from '../reasoning/tool-intelligence';
import { ConversationIntelligenceEngine } from '../reasoning/conversation-intelligence';
import { ContextIntelligenceEngine } from '../reasoning/context-intelligence';
import { PrecisionOutputEngine } from '../reasoning/output-engine';
import { SemanticWorkingMemory } from '../memory/working-memory';
import { antiHallucination } from '../anti-hallucination';
import { ErrorRecoveryEngine } from '../resilience/error-recovery';
import { ExecutionMonitor } from '../monitor/execution-monitor';
import { ExecutionVelocityMonitor } from './velocity-monitor';

type ToolResultDigestEntry = {
  tool: string;
  args: string;
  result: string;
};

/**
 * Run-scoped cognitive state.
 *
 * Agent executions are concurrent, so reasoning state must never live in a
 * process-wide singleton. Each ReAct run owns one of these sessions and keeps
 * it across provider/key retries.
 */
export class CognitiveCoreSession {
  private readonly cognitiveEngine = new CognitiveReasoningEngine();
  private readonly deepSelfCorrection = new DeepSelfCorrectionEngine();
  private readonly toolIntelligence = new ToolIntelligenceEngine();
  private readonly conversationIntelligence = new ConversationIntelligenceEngine();
  private readonly contextIntelligence = new ContextIntelligenceEngine();
  private readonly precisionOutput = new PrecisionOutputEngine();
  private readonly workingMemory = new SemanticWorkingMemory();
  private readonly errorRecovery = new ErrorRecoveryEngine();
  private readonly executionMonitor = new ExecutionMonitor();
  private readonly velocityMonitor = new ExecutionVelocityMonitor();
  private readonly failurePatternMemory = new Map<string, { error: string; count: number }>();

  private currentCogState: CognitiveState | null = null;
  private taskStarted = false;

  onTaskStart(message: string, availableToolNames: string[], modelName: string): void {
    try {
      this.currentCogState = this.cognitiveEngine.initializeState(message, availableToolNames);
      this.conversationIntelligence.analyzeMessage(message);
      this.workingMemory.extractFromMessage(message);
      this.workingMemory.updateUserModel(message);
      this.executionMonitor.startTask(this.currentCogState.hypotheses[0]?.approach || 'executing');
      this.contextIntelligence.setModel(modelName);
      this.failurePatternMemory.clear();
      this.velocityMonitor.reset();
      this.velocityMonitor.profileTask(message);
      this.taskStarted = true;

      console.log(
        `[CognitiveCore] Task classified: ${this.currentCogState.problemClass} ` +
        `(confidence: ${(this.currentCogState.confidence * 100).toFixed(0)}%)`
      );
    } catch (error: any) {
      console.warn('[CognitiveCore] onTaskStart failed (non-blocking):', error?.message || error);
    }
  }

  getEnhancedContext(message: string, availableToolNames: string[]): string {
    try {
      const parts: string[] = [];

      if (this.currentCogState) {
        const directive = this.cognitiveEngine.generateCognitiveDirective(this.currentCogState, message);
        if (directive) parts.push(directive);
      }

      const conversationContext = this.conversationIntelligence.buildConversationContext();
      if (conversationContext) parts.push(conversationContext);

      const memoryContext = this.workingMemory.buildFullMemoryContext(message);
      if (memoryContext) parts.push(memoryContext);

      const predictions = this.toolIntelligence.predictTools(message, availableToolNames);
      if (predictions.length > 0) {
        parts.push(
          `Tool predictions: ${predictions.slice(0, 4)
            .map(prediction => `${prediction.toolName}(${(prediction.confidence * 100).toFixed(0)}%)`)
            .join(', ')}`
        );
      }

      const monitorContext = this.executionMonitor.buildMetricsContext();
      if (monitorContext) parts.push(monitorContext);

      const velocityNudge = this.velocityMonitor.generateNudge();
      if (velocityNudge) parts.push(velocityNudge);

      return parts.filter(Boolean).join('\n\n');
    } catch (error: any) {
      console.warn('[CognitiveCore] getEnhancedContext failed (non-blocking):', error?.message || error);
      return '';
    }
  }

  onToolCallComplete(
    toolName: string,
    args: Record<string, any>,
    result: any,
    success: boolean,
    durationMs: number,
  ): string | null {
    try {
      if (this.currentCogState) {
        const resultSummary = result?.error ? `Error: ${result.error}` : 'Success';
        this.cognitiveEngine.updateAfterToolCall(this.currentCogState, toolName, success, resultSummary);
      }

      this.toolIntelligence.recordToolCall(toolName, args || {}, success, durationMs, result?.error);
      this.executionMonitor.recordToolCall(toolName, success, args);
      this.executionMonitor.recordIteration();
      this.velocityMonitor.recordToolCall(toolName, args || {}, success, durationMs);
      this.velocityMonitor.recordIteration();

      if (!success) {
        if (result?.error) this.recordToolFailure(toolName, args, String(result.error));
        this.workingMemory.recordEpisode({
          type: 'error',
          summary: `${toolName} failed: ${String(result?.error || 'unknown').substring(0, 80)}`,
          tools: [toolName],
          outcome: 'failure',
          relevanceKeywords: [
            toolName,
            ...String(args?.filename || args?.command || '').split(/\s+/).filter(word => word.length > 3),
          ],
        });
      } else if (toolName === 'workspace_edit_file' && args?.filename) {
        this.workingMemory.recordEpisode({
          type: 'task_complete',
          summary: `Created file: ${args.filename}`,
          tools: [toolName],
          outcome: 'success',
          relevanceKeywords: [toolName, String(args.filename).split(/[\\/]/).pop() || ''],
        });
      }

      if (!success && result?.error) {
        const errorContext = {
          toolName,
          args: args || {},
          errorMessage: String(result.error),
          previousErrors: [],
          filesModified: [],
        };
        const diagnosis = this.errorRecovery.diagnose(errorContext);
        if (diagnosis.canAutoFix && diagnosis.suggestedFix) {
          return this.errorRecovery.generateRecoveryDirective(diagnosis, errorContext);
        }
      }

      return null;
    } catch (error: any) {
      console.warn('[CognitiveCore] onToolCallComplete failed (non-blocking):', error?.message || error);
      return null;
    }
  }

  assessFinalAnswer(
    userMessage: string,
    agentResponse: string,
    toolsUsed: string[],
    toolResultDigest: ToolResultDigestEntry[],
    filesCreated: string[],
  ): string | null {
    try {
      // Pre-emptive Anti-Hallucination Gate
      const ahResult = antiHallucination.verifyFinalAnswer({
        answer: agentResponse,
        filesCreated: new Set(filesCreated),
        commandsRun: toolResultDigest.filter(d => /run|exec|shell/.test(d.tool)).map(d => d.args),
        toolResultDigest: toolResultDigest.map(d => ({ tool: d.tool, result: d.result })),
      });
      if (!ahResult.passed && ahResult.correctionPrompt) {
        console.log(`[CognitiveCore] 🛡️ Anti-Hallucination gate triggered: found ${ahResult.violations.length} violations.`);
        return ahResult.correctionPrompt;
      }

      const assessment = this.deepSelfCorrection.assess({
        userMessage,
        agentResponse,
        toolsUsed,
        toolResultDigest,
        filesCreated,
      });
      const outputAnalysis = this.precisionOutput.analyze(agentResponse);

      this.conversationIntelligence.recordAgentResponse(agentResponse);
      this.workingMemory.recordEpisode({
        type: 'task_complete',
        summary: `Completed task: ${userMessage.substring(0, 60)}`,
        tools: toolsUsed,
        outcome: assessment.passes ? 'success' : 'partial',
        relevanceKeywords: userMessage.toLowerCase().split(/\s+/).filter(word => word.length > 3).slice(0, 5),
      });

      if (filesCreated.length > 0) {
        this.workingMemory.learnFact({
          domain: 'project_context',
          fact: `Files created in this session: ${filesCreated.join(', ')}`,
          confidence: 0.9,
          source: 'auto-learn',
        });
      }

      if (!assessment.passes && assessment.correctionPrompt) {
        console.log(`[CognitiveCore] Quality gate triggered: score ${assessment.qualityScore}/100`);
        return assessment.correctionPrompt;
      }

      if (outputAnalysis.bloatScore > 0.3) {
        const directive = this.precisionOutput.buildQualityDirective(outputAnalysis);
        if (directive) return directive;
      }

      return null;
    } catch (error: any) {
      console.warn('[CognitiveCore] assessFinalAnswer failed (non-blocking):', error?.message || error);
      return null;
    }
  }

  deBloatResponse(text: string): string {
    try {
      return this.precisionOutput.deBloat(text);
    } catch {
      return text;
    }
  }

  getCognitiveState(): CognitiveState | null {
    return this.currentCogState;
  }

  getExecutionMetrics() {
    return this.executionMonitor.getMetrics();
  }

  recordToolFailure(toolName: string, args: any, error: string): void {
    const key = `${toolName}:${JSON.stringify(args || {})}`;
    const existing = this.failurePatternMemory.get(key);
    if (existing) {
      existing.count++;
      existing.error = error;
    } else {
      this.failurePatternMemory.set(key, { error, count: 1 });
    }
  }

  checkToolFailureWarning(toolName: string, args: any): string | null {
    const key = `${toolName}:${JSON.stringify(args || {})}`;
    const record = this.failurePatternMemory.get(key);
    if (record && record.count >= 2) {
      return `Warning: This tool call previously failed ${record.count} times. Last error: "${record.error}". Please correct parameters before trying again.`;
    }
    return null;
  }

  hasStarted(): boolean {
    return this.taskStarted;
  }
}

export function createCognitiveCoreSession(): CognitiveCoreSession {
  return new CognitiveCoreSession();
}

// Backward-compatible process-wide facade for callers that have not migrated.
const defaultSession = createCognitiveCoreSession();

export const onTaskStart = defaultSession.onTaskStart.bind(defaultSession);
export const getEnhancedContext = defaultSession.getEnhancedContext.bind(defaultSession);
export const onToolCallComplete = defaultSession.onToolCallComplete.bind(defaultSession);
export const assessFinalAnswer = defaultSession.assessFinalAnswer.bind(defaultSession);
export const deBloatResponse = defaultSession.deBloatResponse.bind(defaultSession);
export const getCognitiveState = defaultSession.getCognitiveState.bind(defaultSession);
export const getExecutionMetrics = defaultSession.getExecutionMetrics.bind(defaultSession);
export const recordToolFailure = defaultSession.recordToolFailure.bind(defaultSession);
export const checkToolFailureWarning = defaultSession.checkToolFailureWarning.bind(defaultSession);
