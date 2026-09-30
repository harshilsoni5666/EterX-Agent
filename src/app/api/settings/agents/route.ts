import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import '../../../../lib/agent/tools';
import { globalToolRegistry } from '../../../../lib/agent/tools/registry';
import { shouldExposeToolToRuntime } from '../../../../lib/agent/builder-agent';
import { CODING_MODES, CODING_TOOL_DETAILS } from '../../../../lib/code/coding-modes';
import { isBuiltinAgentId, type AgentToolSettingsResponse } from '../../../../lib/agent/builtin-agent-settings';
import { readStoredRuntimeSettings, updateStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };

const TOOL_UI_COPY: Record<string, { label: string; description: string }> = {
  workspace_run_command: { label: 'Terminal', description: 'Run commands, inspect project files and manage processes.' },
  workspace_edit_file: { label: 'File editing', description: 'Create, edit or remove project files.' },
  web_search: { label: 'Web search', description: 'Find current information on the web.' },
  browser_control: { label: 'Browser', description: 'Open websites and interact with browser pages.' },
  ask_user: { label: 'Ask a question', description: 'Request missing information from you.' },
  task_decomposer: { label: 'Task planning', description: 'Create a plan for work with multiple dependent steps.' },
  task_checkpoint: { label: 'Plan updates', description: 'Save progress and update an existing plan.' },
  context_memory: { label: 'Context memory', description: 'Recall relevant details from earlier in this chat.' },
  wait_timer: { label: 'Wait', description: 'Wait for a running task before checking its progress.' },
  scheduled_tasks: { label: 'Scheduled tasks', description: 'Create and manage scheduled work.' },
  get_skill_guidelines: { label: 'Skill guidance', description: 'Load relevant instructions for a specialized task.' },
  image_generator: { label: 'Image generation', description: 'Create or edit images.' },
  image_asset_search: { label: 'Image search', description: 'Find image assets for the current task.' },
  video_generator: { label: 'Video generation', description: 'Create video content.' },
  computer: { label: 'Computer', description: 'View and interact with apps in the EterX computer.' },
  screen_agent: { label: 'Screen control', description: 'See and control the computer screen.' },
  screenshot_capture: { label: 'Screenshot', description: 'Capture a screenshot for the current task.' },
  desktop_notification: { label: 'Notifications', description: 'Show a notification on this device.' },
  agent_communicate: { label: 'Agent messages', description: 'Share updates and coordinate with other agents.' },
  spawn_sub_agent: { label: 'Subagents', description: 'Delegate a well-scoped part of a task.' },
  channel_agent: { label: 'Channel agent', description: 'Work with inboxes and connected channels.' },
  gateway_bridge: { label: 'Gateway', description: 'Connect to enabled gateway services.' },
  connector_mcp: { label: 'Connected services', description: 'Use tools supplied by connected services.' },
};

function catalog(): AgentToolSettingsResponse {
  const tools = globalToolRegistry.getAllTools()
    .filter(tool => typeof tool.execute === 'function' && shouldExposeToolToRuntime(tool.name, false))
    .map(tool => ({
      name: tool.name,
      label: TOOL_UI_COPY[tool.name]?.label || CODING_TOOL_DETAILS[tool.name]?.label || tool.name.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' '),
      description: TOOL_UI_COPY[tool.name]?.description || CODING_TOOL_DETAILS[tool.name]?.description || `${tool.category[0].toUpperCase()}${tool.category.slice(1)} tool for your agent.`,
      category: tool.category,
    })).sort((a, b) => a.label.localeCompare(b.label));
  return {
    tools,
    settings: readStoredRuntimeSettings().agentTools || {},
    defaults: {
      'coding-lite': [...CODING_MODES[0].tools],
      'coding-heavy': [...CODING_MODES[1].tools],
      general: tools.map(tool => tool.name),
      chat: ['web_search'],
    },
  };
}

export async function GET(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  return NextResponse.json(catalog(), { headers });
}

export async function PUT(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  try {
    const body = await req.json();
    const agent = body?.agent;
    if (!isBuiltinAgentId(agent)) return NextResponse.json({ error: 'Unknown agent.' }, { status: 400, headers });
    const reset = body.reset === true;
    const tool = body.tool;
    if (!reset && (typeof body.enabled !== 'boolean' || !catalog().tools.some(entry => entry.name === tool)
      || (agent === 'chat' && tool !== 'web_search'))) {
      return NextResponse.json({ error: 'This tool is not supported by the selected agent.' }, { status: 400, headers });
    }
    await updateStoredRuntimeSettings(current => ({
      agentTools: {
        ...current.agentTools,
        [agent]: reset ? {} : { ...current.agentTools?.[agent], [tool]: body.enabled },
      },
    }));
    return NextResponse.json(catalog(), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save agent tools.' }, { status: 500, headers });
  }
}
