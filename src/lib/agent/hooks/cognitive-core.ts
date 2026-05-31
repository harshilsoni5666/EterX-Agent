/**
 * ═══════════════════════════════════════════════════════════════
 * COGNITIVE CORE INTEGRATION — Wiring Layer for Advanced Reasoning
 * ═══════════════════════════════════════════════════════════════
 *
 * This module provides hook functions that can be called from
 * gemini.ts at strategic points in the ReAct loop. Rather than
 * modifying the massive 4600-line gemini.ts directly, this module
 * exports clean functions that the ReAct loop calls.
 *
 * HOOK POINTS:
 * 1. onTaskStart(message) — Called at the start of executeMessageLoop
 * 2. enhanceSystemPrompt(basePrompt, message) — Augments the system prompt
 * 3. onToolCallComplete(toolName, args, result, success) — After each tool call
 * 4. onFinalAnswer(message, response, toolsUsed, toolResultDigest, filesCreated) — Before returning
 * 5. getVerificationInjection(toolName, args, result) — Get correction text
 */

import {
  cognitiveEngine, deepSelfCorrection, verificationPipeline,
  toolIntelligence, conversationIntelligence, contextIntelligence,
  precisionOutput, type CognitiveState,
} from '../reasoning';
import { workingMemory } from '../memory/working-memory';
import { errorRecovery } from '../resilience/error-recovery';
import { executionMonitor } from '../monitor/execution-monitor';

// ─── State ────────────────────────────────────────────────────────────────────

let _currentCogState: CognitiveState | null = null;
let _recentVerifications: import('../reasoning/verification-pipeline').VerificationResult[] = [];
let _taskStarted = false;

// ─── Hook 1: Task Start ──────────────────────────────────────────────────────

/**
 * Initialize all advanced reasoning engines when a new task begins.
 * Called at the start of runReActLoop.
 */
export function onTaskStart(message: string, availableToolNames: string[], modelName: string): void {
  try {
    // Cognitive Engine — classify and hypothesize
    _currentCogState = cognitiveEngine.initializeState(message, availableToolNames);

    // Conversation Intelligence — detect emotion and intent
    conversationIntelligence.analyzeMessage(message);

    // Working Memory — extract constraints and context
    workingMemory.extractFromMessage(message);
    workingMemory.updateUserModel(message);

    // Execution Monitor — start tracking
    executionMonitor.startTask(_currentCogState.hypotheses[0]?.approach || 'executing');

    // Context Intelligence — set model
    contextIntelligence.setModel(modelName);

    // Reset verifications
    _recentVerifications = [];
    _taskStarted = true;

    console.log(`[CognitiveCore] ⚡ Task classified: ${_currentCogState.problemClass} (confidence: ${(_currentCogState.confidence * 100).toFixed(0)}%)`);
  } catch (err) {
    console.warn('[CognitiveCore] onTaskStart failed (non-blocking):', (err as Error).message);
  }
}

// ─── Hook 2: System Prompt Enhancement ───────────────────────────────────────

/**
 * Augment the system prompt with cognitive layers.
 * Returns additional context to append to the dynamic context.
 */
export function getEnhancedContext(message: string, availableToolNames: string[]): string {
  try {
    const parts: string[] = [];

    // Cognitive directive
    if (_currentCogState) {
      const directive = cognitiveEngine.generateCognitiveDirective(_currentCogState, message);
      if (directive) parts.push(directive);
    }

    // Conversation context (emotion, intent, references)
    const convCtx = conversationIntelligence.buildConversationContext();
    if (convCtx) parts.push(convCtx);

    // Working memory (constraints, learned facts, user model)
    const memCtx = workingMemory.buildFullMemoryContext(message);
    if (memCtx) parts.push(memCtx);

    // Tool predictions
    const predictions = toolIntelligence.predictTools(message, availableToolNames);
    if (predictions.length > 0) {
      parts.push(`Tool predictions: ${predictions.slice(0, 4).map(p => `${p.toolName}(${(p.confidence * 100).toFixed(0)}%)`).join(', ')}`);
    }

    // Execution monitor warnings
    const monitorCtx = executionMonitor.buildMetricsContext();
    if (monitorCtx) parts.push(monitorCtx);

    // Verification alerts from recent tool calls
    const verCtx = verificationPipeline.buildVerificationContext(_recentVerifications);
    if (verCtx) parts.push(verCtx);

    return parts.filter(Boolean).join('\n\n');
  } catch (err) {
    console.warn('[CognitiveCore] getEnhancedContext failed (non-blocking):', (err as Error).message);
    return '';
  }
}

// ─── Hook 3: After Each Tool Call ────────────────────────────────────────────

/**
 * Called after each tool call completes. Runs verification pipeline,
 * updates cognitive state, records tool intelligence data, and
 * generates episodic memory entries.
 *
 * Returns a correction injection string if verification failed,
 * or null if everything passed.
 */
export function onToolCallComplete(
  toolName: string,
  args: Record<string, any>,
  result: any,
  success: boolean,
  durationMs: number,
): string | null {
  try {
    // 1. Verification Pipeline — auto-verify tool results
    const verification = verificationPipeline.verify(toolName, args || {}, result);
    _recentVerifications.push(verification);
    if (_recentVerifications.length > 20) _recentVerifications.shift();

    // 2. Cognitive State — update DAG progress
    if (_currentCogState) {
      const resultSummary = result?.error ? `Error: ${result.error}` : 'Success';
      cognitiveEngine.updateAfterToolCall(_currentCogState, toolName, success, resultSummary);
    }

    // 3. Tool Intelligence — record for learning
    toolIntelligence.recordToolCall(toolName, args || {}, success, durationMs, result?.error);

    // 4. Execution Monitor — record the call
    executionMonitor.recordToolCall(toolName, success, args);
    executionMonitor.recordIteration();

    // 5. Working Memory — record significant events as episodic memory
    if (!success) {
      workingMemory.recordEpisode({
        type: 'error',
        summary: `${toolName} failed: ${String(result?.error || 'unknown').substring(0, 80)}`,
        tools: [toolName],
        outcome: 'failure',
        relevanceKeywords: [toolName, ...(args?.filename || args?.command || '').split(/\s+/).filter((w: string) => w.length > 3)],
      });
    } else if (toolName === 'workspace_write_file' && args?.filename) {
      workingMemory.recordEpisode({
        type: 'task_complete',
        summary: `Created file: ${args.filename}`,
        tools: [toolName],
        outcome: 'success',
        relevanceKeywords: [toolName, String(args.filename).split(/[\\/]/).pop() || ''],
      });
    }

    // 6. Error Recovery — diagnose if failed
    if (!success && result?.error) {
      const diagnosis = errorRecovery.diagnose({
        toolName,
        args: args || {},
        errorMessage: String(result.error),
        previousErrors: [],
        filesModified: [],
      });

      if (diagnosis.canAutoFix && diagnosis.suggestedFix) {
        const recoveryDirective = errorRecovery.generateRecoveryDirective(diagnosis, {
          toolName,
          args: args || {},
          errorMessage: String(result.error),
          previousErrors: [],
          filesModified: [],
        });
        return recoveryDirective;
      }
    }

    // Return verification correction if critical failure
    return verification.correctionInjection;
  } catch (err) {
    console.warn('[CognitiveCore] onToolCallComplete failed (non-blocking):', (err as Error).message);
    return null;
  }
}

// ─── Hook 4: Final Answer Quality Gate ───────────────────────────────────────

/**
 * Assess the quality of the agent's final response before returning it.
 * Returns a correction prompt if quality is too low, or null if it passes.
 */
export function assessFinalAnswer(
  userMessage: string,
  agentResponse: string,
  toolsUsed: string[],
  toolResultDigest: Array<{ tool: string; args: string; result: string }>,
  filesCreated: string[],
): string | null {
  try {
    // 1. Deep Self-Correction — semantic quality assessment
    const assessment = deepSelfCorrection.assess({
      userMessage,
      agentResponse,
      toolsUsed,
      toolResultDigest,
      filesCreated,
    });

    // 2. Output analysis — bloat detection
    const outputAnalysis = precisionOutput.analyze(agentResponse);

    // 3. Record conversation for intelligence
    conversationIntelligence.recordAgentResponse(agentResponse);

    // 4. Record episodic memory
    workingMemory.recordEpisode({
      type: 'task_complete',
      summary: `Completed task: ${userMessage.substring(0, 60)}`,
      tools: toolsUsed,
      outcome: assessment.passes ? 'success' : 'partial',
      relevanceKeywords: userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5),
    });

    // 5. Learn semantic facts from the interaction
    if (filesCreated.length > 0) {
      workingMemory.learnFact({
        domain: 'project_context',
        fact: `Files created in this session: ${filesCreated.join(', ')}`,
        confidence: 0.9,
        source: 'auto-learn',
      });
    }

    // If quality is too low, return the correction prompt
    if (!assessment.passes && assessment.correctionPrompt) {
      console.log(`[CognitiveCore] 🔍 Quality gate triggered: score ${assessment.qualityScore}/100`);
      return assessment.correctionPrompt;
    }

    // If output is bloated, return quality directive
    if (outputAnalysis.bloatScore > 0.3) {
      const directive = precisionOutput.buildQualityDirective(outputAnalysis);
      if (directive) {
        console.log(`[CognitiveCore] ✂️ Output bloat detected: ${(outputAnalysis.bloatScore * 100).toFixed(0)}%`);
        return directive;
      }
    }

    return null; // Passes quality gate
  } catch (err) {
    console.warn('[CognitiveCore] assessFinalAnswer failed (non-blocking):', (err as Error).message);
    return null;
  }
}

// ─── Hook 5: De-bloat Final Text ─────────────────────────────────────────────

/**
 * Remove AI bloat from the final response text.
 * Called right before returning the text to the user.
 */
export function deBloatResponse(text: string): string {
  try {
    return precisionOutput.deBloat(text);
  } catch {
    return text; // Never fail
  }
}

// ─── Hook 6: Get Current Cognitive State ─────────────────────────────────────

export function getCognitiveState(): CognitiveState | null {
  return _currentCogState;
}

// ─── Hook 7: Get Execution Metrics ───────────────────────────────────────────

export function getExecutionMetrics() {
  return executionMonitor.getMetrics();
}
