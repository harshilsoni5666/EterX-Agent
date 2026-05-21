import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import OpenAI from 'openai';
import { getMainAgentModelConfig, normalizeMainAgentMode, type MainAgentMode } from './model-routing';

/**
 * Task Planner — selected-model client for deep task decomposition
 * 
 * Uses the active main-agent model when one is selected, with Gemini fallback for
 * legacy planner runs.
 * Separated from the main agent loop so planning doesn't consume main model capacity.
 * 
 * KEY DESIGN:
 * - Expert system prompt trained for generating granular step-by-step execution plans
 * - Returns structured JSON with steps, tools, verification conditions
 * - Fast and lightweight — completes in 2-5 seconds
 * - Steps are action-level (not phase-level) to prevent the agent from looping
 */

const PLANNER_MODELS = [
  'gemini-3.5-flash'
];

const PLANNER_SYSTEM_PROMPT = `You are an expert Task Decomposition Engine for an autonomous AI agent OS called EterX.

Your ONLY job is to take a complex user request and break it down into a precise, granular, step-by-step execution plan that another AI agent will follow to complete the task.

━━━ RULES FOR STEP GENERATION ━━━

1. GRANULARITY: Each step must be a SINGLE atomic action. Not "Build the frontend" but "Write index.html with the page structure and content" then "Write styles.css with all CSS" then "Write script.js with JavaScript logic".

2. SPECIFICITY: Each step must name the EXACT tool(s) to use. Available tools:
   - workspace_write_file: Create a new file with complete content
   - workspace_edit_file: Modify an existing file using search/replace
   - workspace_read_file: Read a file to understand its contents
   - workspace_list_directory: List files in a directory
   - system_shell: Run shell commands (PowerShell on Windows)
   - web_search: Search the web for information (MAX 2 per plan)
   - web_scraper: Scrape a specific URL for data
   - get_skill_guidelines: Load UI/document creation guidelines (ONCE per skill)
   - docx_generator: Generate .docx documents
   - workspace_verify_code: Verify code quality
   - code_execution_js: Run JavaScript code for computation
   - calculator: Math calculations
   - image_generator: Generate images
   - git_operations: Git commands
   - desktop_notification: Notify user
   - csv_analyzer: Analyze CSV data
   - task_scheduler: Schedule recurring tasks

3. VERIFICATION: Each step must have a clear "done_when" condition so the agent knows when to move on.

4. NO REDUNDANCY: Never include:
   - Multiple research steps for the same topic
   - Loading the same skill twice
   - Creating the same file twice (use edit instead)
   - Generic "review" or "planning" steps that don't produce output

5. ORDERING: Steps must be in dependency order. Mark what each step depends on.

6. COMPLETENESS: The plan must cover EVERYTHING needed to deliver a working result. But keep it under 15 steps.

7. TASK-ADAPTIVE: Generate steps that are specific to THIS task. Don't follow generic templates.
   The agent is intelligent — it will figure out what tools and skills to load.
   Just tell it WHAT to do in each step, not HOW to think.

8. FILE-PER-STEP: For any task that creates files, each file should be its own step.
   The agent writes COMPLETE files in one shot — never split a single file across steps.

━━━ OUTPUT FORMAT ━━━

You MUST respond with ONLY a valid JSON object (no markdown, no backticks, no explanation):

{
  "steps": [
    {
      "step": 1,
      "name": "Short action name",
      "description": "Detailed description of what to do in this step, including specific content to create",
      "tools": ["tool_name_1", "tool_name_2"],
      "done_when": "Clear verification condition",
      "depends_on": [],
      "priority": "high"
    }
  ],
  "estimated_complexity": "simple|moderate|complex",
  "estimated_time_minutes": 5
}

RESPOND WITH ONLY THE JSON. NO OTHER TEXT.`;

export class TaskPlannerClient {
  private ai: GoogleGenAI | null = null;
  private mistral: OpenAI | null = null;

  constructor() {
    // Discover API keys (same as main client)
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
    if (!apiKey) {
      console.warn('[TaskPlanner] ⚠️ No API key found. Will use fallback decomposition.');
      return;
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  private parsePlannerResponse(rawText: string, startTime: number, modelName: string) {
    let cleanJson = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanJson = jsonMatch[0];

    const parsed = JSON.parse(cleanJson);
    const elapsed = Date.now() - startTime;

    console.log(`[TaskPlanner] Generated ${ parsed.steps?.length || 0 } steps in ${ elapsed }ms via ${ modelName } (complexity: ${ parsed.estimated_complexity })`);

    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error('No steps generated');
    }

    parsed.steps = parsed.steps.map((s: any, i: number) => ({
      step: i + 1,
      name: String(s.name || `Step ${ i + 1 }`),
      description: String(s.description || ''),
      tools: Array.isArray(s.tools) ? s.tools : [],
      done_when: String(s.done_when || s.verification || 'Step completed'),
      depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
      priority: s.priority || 'high'
    }));

    if (parsed.steps.length > 15) parsed.steps = parsed.steps.slice(0, 15);

    return parsed;
  }

  /**
   * Wraps a promise with a timeout — if it takes too long, reject.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ ms }ms`)), ms))
    ]);
  }

  private getMistralClient(): OpenAI | null {
    const apiKey = process.env.MISTRAL_API_KEY || process.env.MISTRAL_AI_API_KEY || process.env.MISTRALAI_API_KEY || '';
    if (!apiKey) {
      console.warn('[TaskPlanner] No Mistral API key found. Will use fallback decomposition.');
      return null;
    }
    if (!this.mistral) {
      this.mistral = new OpenAI({
        apiKey,
        baseURL: process.env.MISTRAL_BASE_URL || process.env.MISTRAL_API_BASE_URL || 'https://api.mistral.ai/v1',
      });
    }
    return this.mistral;
  }

  /**
   * Generate a deep execution plan for a complex task.
   * Returns structured steps with tools, verification, and dependencies.
   */
  public async decompose(task: string, context?: string, mode: MainAgentMode = 'think'): Promise<{
    steps: Array<{
      step: number;
      name: string;
      description: string;
      tools: string[];
      done_when: string;
      depends_on: number[];
      priority: string;
    }>;
    estimated_complexity: string;
    estimated_time_minutes: number;
  }> {
    const safeMode = normalizeMainAgentMode(mode);
    const modelConfig = getMainAgentModelConfig(safeMode);
    console.log(`[TaskPlanner] Generating deep plan via selected model: ${ modelConfig.modelName }`);
    const startTime = Date.now();

    const prompt = context
      ? `Task: ${ task }\n\nAdditional context: ${ context }`
      : `Task: ${ task }`;

    if (modelConfig.provider === 'mistral') {
      const client = this.getMistralClient();
      if (!client) return this.fallbackDecompose(task);
      try {
        const response = await this.withTimeout(
          client.chat.completions.create({
            model: process.env.MISTRAL_MODEL || process.env.MISTRAL_MODEL_NAME || modelConfig.modelName,
            messages: [
              { role: 'system', content: PLANNER_SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            response_format: { type: 'json_object' },
          } as any),
          15000
        );
        return this.parsePlannerResponse(String(response.choices?.[0]?.message?.content || ''), startTime, modelConfig.modelName);
      } catch (error: any) {
        console.warn(`[TaskPlanner] Selected model ${ modelConfig.modelName } failed: ${ error.message }. Using fallback decomposition.`);
        return this.fallbackDecompose(task);
      }
    }

    if (!this.ai) {
      console.warn('[TaskPlanner] No API client available. Using fallback.');
      return this.fallbackDecompose(task);
    }

    // Try the selected Gemini model first, then any legacy fallbacks.
    const plannerModels = Array.from(new Set([modelConfig.modelName, ...PLANNER_MODELS]));
    for (const modelName of plannerModels) {
      try {
        console.log(`[TaskPlanner] Trying model: ${ modelName }...`);
        const response = await this.withTimeout(
          this.ai.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              systemInstruction: PLANNER_SYSTEM_PROMPT,
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.LOW,
                includeThoughts: false,
              },
            }
          }),
          15000  // 15 second timeout per model attempt
        );

        const rawText = response.text || '';

        // Clean up response — strip markdown fences if present
        let cleanJson = rawText
          .replace(/```json\s*/gi, '')
          .replace(/```\s*/g, '')
          .trim();

        // Try to extract JSON if there's extra text
        const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleanJson = jsonMatch[0];
        }

        const parsed = JSON.parse(cleanJson);
        const elapsed = Date.now() - startTime;

        console.log(`[TaskPlanner] ✅ Generated ${ parsed.steps?.length || 0 } steps in ${ elapsed }ms via ${ modelName } (complexity: ${ parsed.estimated_complexity })`);

        // Validate and sanitize steps
        if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
          throw new Error('No steps generated');
        }

        // Ensure step numbers are sequential
        parsed.steps = parsed.steps.map((s: any, i: number) => ({
          step: i + 1,
          name: String(s.name || `Step ${ i + 1 }`),
          description: String(s.description || ''),
          tools: Array.isArray(s.tools) ? s.tools : [],
          done_when: String(s.done_when || s.verification || 'Step completed'),
          depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
          priority: s.priority || 'high'
        }));

        // Cap at 15 steps
        if (parsed.steps.length > 15) {
          parsed.steps = parsed.steps.slice(0, 15);
        }

        return parsed;
      } catch (modelError: any) {
        console.warn(`[TaskPlanner] ⚠️ Model ${ modelName } failed: ${ modelError.message }. Trying next...`);
        continue; // Try next model in chain
      }
    }

    // All models failed — use fallback
    console.error(`[TaskPlanner] ❌ All models failed. Using fallback decomposition.`);
    return this.fallbackDecompose(task);
  }

  /**
   * Fallback pattern-based decomposition if the API fails.
   */
  private fallbackDecompose(task: string): any {
    // Fully generic fallback — no hardcoded patterns.
    // The agent itself will decide what skills to load, what to research, etc.
    const steps = [
      { step: 1, name: 'Understand & Plan', description: 'Analyze the task requirements and determine the approach', tools: ['web_search'], done_when: 'Requirements understood and approach clear', depends_on: [], priority: 'high' },
      { step: 2, name: 'Setup Environment', description: 'Create any needed directories, files, or configurations', tools: ['system_shell', 'workspace_write_file'], done_when: 'Environment ready for implementation', depends_on: [1], priority: 'high' },
      { step: 3, name: 'Implement Core', description: 'Create the main output files with complete content', tools: ['workspace_write_file'], done_when: 'Core implementation files created', depends_on: [2], priority: 'high' },
      { step: 4, name: 'Implement Details', description: 'Create supporting files, styles, data, and logic', tools: ['workspace_write_file'], done_when: 'All supporting files created', depends_on: [3], priority: 'high' },
      { step: 5, name: 'Verify & Polish', description: 'Review output, fix issues, and ensure quality', tools: ['workspace_read_file', 'workspace_edit_file'], done_when: 'Output verified and polished', depends_on: [4], priority: 'high' },
      { step: 6, name: 'Deliver', description: 'Finalize and notify user of completion', tools: ['desktop_notification'], done_when: 'User notified', depends_on: [5], priority: 'low' }
    ];

    return {
      steps,
      estimated_complexity: 'moderate',
      estimated_time_minutes: 10
    };
  }
}

// Singleton instance
export const globalTaskPlanner = new TaskPlannerClient();
