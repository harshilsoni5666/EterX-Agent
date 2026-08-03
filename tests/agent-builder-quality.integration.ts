import assert from 'node:assert/strict';

async function main() {
  await import('../src/lib/agent/tools/index');
  const {
    AGENT_BUILDER_BASELINE_TOOL_NAMES,
    applyAgentBuilderDefaults,
    evaluateAgentBuilderProfile,
    getCustomAgentAllowedToolNames,
  } = await import('../src/lib/agent/builder-agent');

  const profile = applyAgentBuilderDefaults({
    agentId: 'adaptive-quality-test',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
    name: 'Adaptive Operations Agent',
    mission: 'Interpret and complete grounded operational requests across files, data, research, and communication for a professional team.',
    professionalPrompt: [
      'You are an adaptive operations agent. Classify the user request before acting and choose the appropriate mode for answering, researching, analyzing data, editing files, or completing a controlled action.',
      'Use real user-provided, workspace, connector, or verified external data. Separate observed facts, calculations, assumptions, and recommendations. Never fabricate missing information or claim a result that a tool did not verify.',
      'For complex work, make a bounded plan, use only the tools that materially help, inspect every result, recover once with a different safe approach when needed, and review the final output against the original request. Keep simple answers short and adapt the format to what the user asked for.',
    ].join(' '),
    behaviorRules: [],
    safetyRules: [],
    skills: [],
    directMainTools: [],
    customTools: [],
    notes: [],
  });

  const quality = evaluateAgentBuilderProfile(profile);
  assert.equal(quality.trainingStandard, true);
  assert.equal(quality.ready, true);
  assert.equal(quality.missing.length, 0);
  assert.ok(profile.directMainTools.length >= AGENT_BUILDER_BASELINE_TOOL_NAMES.length);

  const allowed = getCustomAgentAllowedToolNames({
    directMainTools: [{
      toolName: 'web_search',
      purpose: 'Research',
      whenToUse: 'When current evidence is needed',
      attachedAt: new Date().toISOString(),
    }],
    customTools: [],
  });
  assert.equal(allowed.has('web_search'), true);
  assert.equal(allowed.has('workspace_write_file'), false);

  console.log('agent-builder-quality.integration: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
