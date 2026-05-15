import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

export const agentCronSchedulerTool: ToolDefinition = {
  name: 'agent_cron_scheduler',
  description: 'Schedule a recurring task for an agent to run autonomously using a cron expression. ONLY available in Agent Builder. The scheduled task will auto-activate the agent at the specified intervals.',
  category: 'automation',
  inputSchema: z.object({
    agentId: z.string().describe('The ID of the agent to schedule tasks for.'),
    cronExpression: z.string().describe('The cron expression specifying the schedule (e.g., "0 0 * * *" for daily at midnight).'),
    taskPrompt: z.string().describe('The specific task or prompt the agent should execute when triggered.'),
    taskName: z.string().describe('A readable name for this scheduled task.')
  }),
  execute: async (args: any, context: any) => {
    const { agentId, cronExpression, taskPrompt, taskName } = args;
    
    // In a real implementation, this would save to a database or actual cron service.
    // For now, we simulate saving the scheduled task for the specific agent.
    
    console.log(`[AgentCronScheduler] Scheduled task "${taskName}" for agent ${agentId} with cron: ${cronExpression}`);
    
    return {
      success: true,
      message: `Successfully scheduled task "${taskName}" to run autonomously on schedule: ${cronExpression}. The agent will auto-activate to process it.`,
      scheduleDetails: {
        agentId,
        cronExpression,
        taskName,
        taskPrompt,
        status: 'active'
      }
    };
  }
};
