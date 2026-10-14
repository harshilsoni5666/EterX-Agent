/** One call shape shared by tool instructions, parents, and nested workers. */
export const SUB_AGENT_SPAWN_EXAMPLE = {
  mode: 'spawn',
  tasks: [{
    name: 'Outcome-specific name',
    task: 'Describe one bounded outcome and the inherited user constraints.',
    rationale: 'Explain why independent work on this outcome helps.',
    acceptance: 'Specify the deliverable or evidence the parent needs.',
  }],
} as const;

export const SUB_AGENT_SPAWN_GUIDANCE = `SPAWN ARGUMENT CONTRACT:
- Call spawn_sub_agent with mode="spawn" and a nonempty tasks ARRAY, even for one worker. Canonical example: ${JSON.stringify(SUB_AGENT_SPAWN_EXAMPLE)}
- Put task, name, key, rationale, acceptance, dependsOn, resources, provider, model, and thinkingLevel inside each tasks entry. Top-level agentName/agentId target existing workers; they do not define a new assignment. Top-level mode selects the tool operation; an optional tasks entry mode selects that worker's provider route.
- Supply rationale and acceptance for every Swarm Mode assignment. Inherit user restrictions, state the bounded outcome, declare shared read/write resources, and use dependsOn only for task keys in this batch or existing task IDs in this run. Send independent assignments together in one spawn call.
- consensus, debate, and specialist also require tasks, containing exactly one topic. specialist additionally requires specialistRole. advise/graph/status/collect/join do not create workers.
- An argument or admission rejection starts no workers. Correct the reported arguments before retrying. After admission, keep the returned agentId values; never resubmit accepted assignments merely because workers are queued. Continue useful local work, join when child evidence is needed, and collect by exact ID for retained reports.`;

const CREATION_MODES = new Set(['spawn', 'consensus', 'debate', 'specialist']);

/** Conditional requirements cannot be expressed by a flat provider schema. */
export function getSubAgentCreationArgumentGaps(input: any): string[] {
  if (!CREATION_MODES.has(input?.mode)) return [];
  const missing: string[] = [];
  if (!Array.isArray(input?.tasks) || input.tasks.length === 0) {
    missing.push('tasks');
  } else {
    input.tasks.forEach((task: any, index: number) => {
      if (typeof task?.task !== 'string' || !task.task.trim()) missing.push(`tasks.${index}.task`);
      if (Boolean(task?.provider) !== Boolean(task?.model)) {
        missing.push(`tasks.${index}.${task?.provider ? 'model' : 'provider'}`);
      }
    });
  }
  if (input.mode === 'specialist' && !input.specialistRole) missing.push('specialistRole');
  return missing;
}
