import { AgentTask, PlanStep, ProjectContext } from '../schemas';
import { globalToolRegistry } from '../tools/registry';

/**
 * The Planner Role
 * 
 * Layer 3: Responsible for generating step-by-step execution plans
 * based on the classified intent and available tools.
 */
export class Planner {
  /**
   * Generates a multi-step execution plan for a given user goal.
   * In a real implementation this would call Gemini with structured outputs,
   * asking it to return an array matching `PlanStepSchema`.
   */
  public async createPlan(
    userGoal: string, 
    context: ProjectContext
  ): Promise<AgentTask> {
    
    // 1. Gather context and tools
    const availableTools = globalToolRegistry.getAllTools()
      .map(t => ({ name: t.name, description: t.description }));

    console.log(`[Planner] Creating plan for goal: "${userGoal}"`);
    console.log(`[Planner] Available tools context:`, availableTools.length);

    // Placeholder: Return a mocked initial plan structure
    // This will be replaced with actual Gemini API call returning PlanStep[]
    const mockSteps: PlanStep[] = [
      {
        stepNumber: 1,
        action: 'system_shell',
        input: { command: 'echo "Planner Initialized"' },
        expectedOutput: 'Planner verification timestamp or string',
        status: 'pending'
      }
    ];

    const task: AgentTask = {
      taskId: crypto.randomUUID(),
      userGoal,
      taskType: 'automation',
      priority: 'high',
      context,
      plan: mockSteps,
      toolPermissions: {
        system_shell: true,
        file_manager: true
      },
      outputFormat: 'json',
      verification: {
        needsSources: false,
        needsMathCheck: false,
        needsFormatCheck: true
      }
    };

    return task;
  }
}
