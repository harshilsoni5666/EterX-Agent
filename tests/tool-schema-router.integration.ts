import assert from 'node:assert/strict';
import { globalToolRegistry } from '../src/lib/agent/tools/registry';
import '../src/lib/agent/tools';
import {
  buildSubAgentPinnedContext,
  normalizeSubAgentRuntimeSettings,
} from '../src/lib/agent/sub-agent-settings';

function testFullSurfacePreservesEveryRealTool(): void {
  const expectedTools = [
    'workspace_edit_file',
    'workspace_run_command',
    'spawn_sub_agent',
    'web_search',
    'browser_control',
    'scheduled_tasks',
  ];
  const tools = globalToolRegistry.getAllTools();
  const names = tools.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, 'the curated registry must not contain duplicate tool names');
  for (const name of expectedTools) {
    assert.ok(names.includes(name), `curated registry should expose ${name}`);
  }

  const declarations = globalToolRegistry.getGeminiFunctionDeclarations();
  assert.deepEqual(
    declarations.map(declaration => declaration.name),
    names,
    'the schema declaration surface must preserve every registered tool in order',
  );
  for (const declaration of declarations) {
    assert.equal(declaration.parameters.type, 'object');
    assert.equal(typeof declaration.description, 'string');
  }

  assert.equal(globalToolRegistry.getFunctionDeclaration('workspace_edit_file')?.name, 'workspace_edit_file');
  assert.equal(globalToolRegistry.getFunctionDeclaration('missing_tool'), undefined);
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
    maxRetries: 3,
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
console.log('tool schema registry integration tests passed');
