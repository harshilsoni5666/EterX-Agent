import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ToolDefinition } from '../src/lib/agent/schemas';
import { routeToolSchemas } from '../src/lib/agent/tools/tool-schema-router';
import {
  buildSubAgentPinnedContext,
  normalizeSubAgentRuntimeSettings,
} from '../src/lib/agent/sub-agent-settings';

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} capability`,
    category: 'core',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: async () => ({}),
  } as ToolDefinition;
}

function testFullSurfacePreservesEveryRealTool(): void {
  const eligibleTools = [
    'workspace_read_file',
    'workspace_write_file',
    'workspace_edit_file',
    'spawn_sub_agent',
    'web_search',
    'browser_control',
    'calculator',
    'deep_research',
    'scheduled_tasks',
  ].map(fakeTool);

  const routed = routeToolSchemas(eligibleTools, 'Please explain the project architecture.', {
    preserveFullSurface: true,
  });
  assert.ok(routed.tools.some(tool => tool.name === 'spawn_sub_agent'));
  assert.equal(routed.deferredToolNames.includes('spawn_sub_agent'), false);
  assert.deepEqual(
    routed.tools.map(tool => tool.name),
    eligibleTools.map(tool => tool.name),
    'production full-surface mode must not infer capability from request wording',
  );
}

function testSettingsRelayIsFreshAndBounded(): void {
  const settings = normalizeSubAgentRuntimeSettings({
    autoSubAgents: false,
    maxSubAgents: 2.9,
    maxRetries: 99,
  });
  assert.deepEqual(buildSubAgentPinnedContext(settings), {
    disableSubAgents: true,
    allowAgentSpawning: false,
    maxSubAgents: 2,
    maxRetries: 5,
  });

  const enabled = normalizeSubAgentRuntimeSettings({
    autoSubAgents: true,
    maxSubAgents: 3,
    maxRetries: 1,
  });
  assert.deepEqual(buildSubAgentPinnedContext(enabled), {
    disableSubAgents: false,
    allowAgentSpawning: true,
    maxSubAgents: 3,
    maxRetries: 1,
  });
}

testFullSurfacePreservesEveryRealTool();
testSettingsRelayIsFreshAndBounded();
console.log('tool schema router integration tests passed');
