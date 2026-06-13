export interface AgentSkill {
  id: string;
  name: string;
  icon: string;
  description?: string;
  systemPromptAddendum: string;
  category?: string;
  sourceFile?: string;
  metadata?: Record<string, unknown>;
}
