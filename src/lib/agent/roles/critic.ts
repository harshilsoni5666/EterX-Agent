import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { ProjectContext } from '../schemas';

/**
 * The Critic Role (Layer 6: Verification Layer)
 * 
 * Independently verifies if the agent's output answers the user's initial request.
 * Uses a LIGHTWEIGHT direct Gemini call — NOT the full agent loop.
 * This prevents the critic from spawning tools, tasks, or consuming agent capacity.
 */
export class Critic {
  private ai: GoogleGenAI | null = null;

  constructor() {
    // Find an API key
    let apiKey = '';
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && value.startsWith('AIza')) {
        apiKey = value;
        break;
      }
    }
    if (!apiKey) {
      apiKey = process.env.GEMINI_API_KEY || process.env.VITE_OPENROUTER_API_KEY || '';
    }
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  /**
   * Evaluates the Agent's generated answer against the User's goal.
   * Returns a boolean indicating if it passes, and feedback if it fails.
   * Uses a lightweight direct API call — NOT the full agent ReAct loop.
   */
  public async evaluateOutput(
    userGoal: string,
    agentOutput: string,
    context: ProjectContext
  ): Promise<{ passed: boolean, feedback: string }> {
    console.log(`[Critic] Evaluating output for goal: "${ userGoal }"`);

    if (!this.ai) {
      console.warn(`[Critic] No API client. Bypassing.`);
      return { passed: true, feedback: 'No API key for critic. Bypassed.' };
    }

    // Truncate output if too long to avoid wasting tokens
    const truncatedOutput = agentOutput.length > 2000
      ? agentOutput.substring(0, 2000) + '\n... [truncated for evaluation]'
      : agentOutput;

    const { globalSessionManager } = require('../session');
    const performedActions = globalSessionManager.getActions().join(', ') || 'No physical tools executed.';

    const evaluationPrompt = `
      You are the HOSTILE AUDITOR of a LOCAL DESKTOP Agent OS called EterX.
      Your job is to AGGRESSIVELY find flaws in the agent's output. You are NOT a friendly reviewer.
      You are the last line of defense before the user sees the output.
      
      ━━━ CRITICAL FACTS ━━━
      - This agent runs LOCALLY on Windows with full filesystem/shell access
      - Local file paths like "C:\\Users\\..." are VALID and accessible
      - The agent creates files on the user's REAL Desktop
      - DO NOT reject for local paths — they ARE correct
      
      ━━━ EVALUATE THIS ━━━
      User Goal: "${ userGoal }"
      Agent Output: "${ truncatedOutput }"
      
      [PHYSICAL ACTIONS PERFORMED]
      ${ performedActions }
      
      ━━━ SCORING DIMENSIONS (rate each 0-100) ━━━
      1. COMPLETENESS: Did the agent address ALL parts of the user's request? (Not just the first part)
      2. ACCURACY: Is the information factually correct? Are there any hallucinated facts?
      3. DEPTH: Is the response thorough enough? Or is it surface-level?
      4. FORMATTING: Is the Markdown clean? Proper headings, lists, code blocks?
      5. ACTIONABILITY: If the user asked for files/code, were they actually created?
      
      ━━━ INTENT INTERPRETATION ━━━
      - "it's just 1 page" / "only X pages" after asking for more = COMPLAINT about length
      - "why stopped" / "continue" = follow-up, not new task
      - Frustration words = previous attempt FAILED
      
      ━━━ AUTO-PASS CONDITIONS (skip detailed audit) ━━━
      - Short conversational messages (greeting, thanks, acknowledgment) → PASS
      - Simple factual Q&A with correct answer → PASS
      - User asked to fix X, agent fixed X → PASS
      
      ━━━ AUTO-FAIL CONDITIONS ━━━
      - Agent's output says "I'll do X" but didn't actually DO it → FAIL
      - Agent rambled about what it WOULD do instead of doing it → FAIL
      - Agent addressed only half the request → FAIL
      - Output contains "TODO", "[placeholder]", or incomplete sections → FAIL
      - Agent re-did work it already did (visible in action log) → FAIL
      
      Respond STRICTLY in JSON:
      {
        "passed": <boolean — true if average score >= 70>,
        "score": <number 0-100>,
        "feedback": "<if failed: specific, actionable feedback in 1-2 sentences. if passed: 'Approved.'>"
      }
    `.trim();

    try {
      // Use the same model family as the main agent for consistency
      const modelCandidates = ['gemini-3-flash-preview', 'gemini-3-flash-preview', 'gemini-2.0-flash'];
      let response: any = null;
      let lastError: any = null;

      for (const model of modelCandidates) {
        try {
          response = await Promise.race([
            this.ai.models.generateContent({
              model,
              contents: [{ role: 'user', parts: [{ text: evaluationPrompt }] }],
              config: {
                thinkingConfig: {
                  thinkingLevel: ThinkingLevel.LOW,
                  includeThoughts: false,
                },
              }
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Critic timeout')), 12000))
          ]);
          break; // Success — exit the model loop
        } catch (err: any) {
          lastError = err;
          if (err.message?.includes('not found') || err.message?.includes('404')) {
            continue; // Try next model
          }
          throw err; // Non-model errors propagate
        }
      }

      if (!response) {
        throw lastError || new Error('All critic models failed');
      }

      const rawText = (response as any).text || '';
      const cleanJson = rawText.replace(/```json/gi, '').replace(/```/gi, '').trim();
      const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleanJson);

      const result = {
        passed: parsed.passed === true,
        feedback: parsed.feedback || "Unable to parse feedback."
      };

      console.log(`[Critic] ${ result.passed ? '✅ PASSED' : '❌ FAILED' }: ${ result.feedback.substring(0, 100) }`);
      return result;
    } catch (error: any) {
      console.error(`[Critic] Evaluation failed: ${ error.message }. Bypassing.`);
      // Fail-open — don't block the agent
      return { passed: true, feedback: 'Critic system error. Bypassed.' };
    }
  }
}
