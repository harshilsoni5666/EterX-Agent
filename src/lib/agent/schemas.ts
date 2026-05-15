import { z } from 'zod';

// ==========================================
// 1. TOOL SCHEMA
// Defines how tools are registered and called
// ==========================================
export const ToolParameterSchema = z.record(z.string(), z.any());

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.enum(['core', 'workspace', 'automation', 'support', 'research', 'communication', 'monitoring']),
  inputSchema: z.any(), // Should be a Zod schema object
  outputSchema: z.any(), // Map to expected output structure
  execute: z.function()
    .args(z.any(), z.any()) // args: parameters, context
    .returns(z.promise(z.any()))
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// ==========================================
// 2. MEMORY SCHEMA
// Defines how short-term and long-term context is stored
// ==========================================
export const MemoryEntrySchema = z.object({
  id: z.string().uuid(),
  timestamp: z.number(),
  type: z.enum(['observation', 'insight', 'user_preference', 'task_result', 'error_log', 'conversation_summary', 'learned_pattern']),
  content: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
  importance: z.number().min(0).max(10).optional().default(5),
  tags: z.array(z.string()).optional()
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const ProjectContextSchema = z.object({
  projectId: z.string(),
  conversationSummary: z.string(),
  uploadedFiles: z.array(z.string()), // File URLs or paths
  recentMemories: z.array(MemoryEntrySchema),
  userPreferences: z.record(z.string(), z.any()).optional(),
  errorHistory: z.array(z.string()).optional(),
  userName: z.string().optional()
});
export type ProjectContext = z.infer<typeof ProjectContextSchema>;

// ==========================================
// 3. TASK SCHEMA
// Internal protocol for agent planning and execution
// ==========================================
export const PlanStepSchema = z.object({
  stepNumber: z.number(),
  action: z.string(), // Maps to the tool name
  input: z.record(z.string(), z.any()), // The payload to the tool
  expectedOutput: z.string(), // What the planner expects this step to return
  status: z.enum(['pending', 'running', 'success', 'failed', 'skipped']).default('pending'),
  result: z.any().optional(),
  error: z.string().optional()
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const TaskSchema = z.object({
  taskId: z.string().uuid(),
  userGoal: z.string(),
  taskType: z.enum([
    'research', 'coding', 'document', 
    'spreadsheet', 'presentation', 'automation', 'analysis',
    'communication', 'devops', 'health_check', 'creative', 'monitoring'
  ]),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  context: ProjectContextSchema,
  plan: z.array(PlanStepSchema),
  toolPermissions: z.record(z.string(), z.boolean()),
  outputFormat: z.enum(['json', 'markdown', 'docx', 'pptx', 'pdf', 'spreadsheet', 'text', 'audio', 'image']),
  verification: z.object({
    needsSources: z.boolean(),
    needsMathCheck: z.boolean(),
    needsFormatCheck: z.boolean()
  })
});
export type AgentTask = z.infer<typeof TaskSchema>;

// ==========================================
// 4. OUTPUT SCHEMA (VERIFIER LAYER)
// Final response wrapped for the user interface
// ==========================================
export const AgentResponseSchema = z.object({
  taskId: z.string(),
  success: z.boolean(),
  finalAnswer: z.string(), // Markdown or text
  artifactsGenerated: z.array(z.string()), // Paths to generated files
  sourcesCited: z.array(z.string()).optional(),
  executionTimeMs: z.number(),
  warnings: z.array(z.string()).optional(),
  trace: z.array(z.any()).optional()
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

// ==========================================
// 5. HEARTBEAT / SCHEDULED TASK SCHEMA
// For proactive agent behavior
// ==========================================
export const HeartbeatTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  intervalMs: z.number(),
  command: z.string(),
  type: z.enum(['shell', 'reminder', 'check']),
  enabled: z.boolean(),
  lastRun: z.number().nullable(),
  nextRun: z.number(),
  runCount: z.number(),
  createdAt: z.number()
});
export type HeartbeatTask = z.infer<typeof HeartbeatTaskSchema>;

// ==========================================
// 6. SUB-AGENT SCHEMA
// For multi-agent orchestration
// ==========================================
export const SubAgentSchema = z.object({
  id: z.string(),
  role: z.string(),  // Named agent identity (Agent-Alpha, Agent-Nova, etc.)
  task: z.string(),
  status: z.enum(['idle', 'spawning', 'running', 'completed', 'failed']),
  result: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional()
});
export type SubAgent = z.infer<typeof SubAgentSchema>;
