import { globalToolRegistry } from './registry';
import type { ToolDefinition } from '../schemas';

// Shared tools with distinct, useful runtime capabilities. Main, custom, and
// provider runtimes resolve the same names; dedicated Agent Builder controls
// are isolated by shouldExposeToolToRuntime().
import { webSearchTool } from './core/search';
import { skillLoaderTool } from './core/skill_loader';
import { desktopNotifyTool } from './core/notify';
import { screenshotTool } from './core/screenshot';
import { imageGenTool } from './core/imagegen';
import { videoGenTool } from './core/videogen';
import { imageAssetSearchTool } from './core/image_asset_search';
import { taskDecomposerTool } from './core/task_decomposer';
import { spawnSubAgentTool } from './core/spawn_sub_agent';
import { browserControlTool } from './core/browser_control';
import { askUserTool } from './core/ask_user';
import { checkpointTool } from './core/checkpoint';
import { computerTool } from './core/computer';
import { screenAgentTool } from './core/screen_agent';
import { waitTimerTool } from './core/wait_timer';
import { agentCommTool } from './core/agent_comm';
import { scheduledTasksTool } from './core/scheduled_tasks';
import { contextMemoryTool } from './core/context_memory';

// A Codex-style workspace core: one cross-platform terminal for inspection,
// search, execution, and verification, plus the established edit tool that is
// wired to the UI's expandable real-diff experience.
import { workspaceEditFileTool } from './workspace/consolidated_edit';
import { workspaceRunCommandTool } from './workspace/execution';

// Connected communication surfaces.
import { gatewayBridgeTool } from './communication/gateway_bridge';
import { channelAgentTool } from './communication/channel_agent';
import { connectorMcpTool } from './communication/connector_mcp';
import { agentBuilderTools } from './automation/agent_builder';
import { isExecutableAvailable } from './core/shell_resolver';

// Shared desktop tools stay registered on every supported OS so agents do not
// lose the capability name when a machine lacks an optional utility. Their
// providers return an explicit availability/permission message at execution
// time. Optional notification and screenshot tools are still filtered by the
// utilities they actually require.
type PlatformToolCandidate = {
  tool: ToolDefinition;
  available: () => boolean;
};

const PLATFORM_TOOL_CANDIDATES: PlatformToolCandidate[] = process.platform === 'win32'
  ? [
      { tool: desktopNotifyTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
      { tool: screenshotTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
      { tool: computerTool, available: () => true },
      { tool: screenAgentTool, available: () => true },
    ]
  : process.platform === 'darwin'
    ? [
        { tool: desktopNotifyTool, available: () => isExecutableAvailable(['osascript']) },
        { tool: screenshotTool, available: () => isExecutableAvailable(['screencapture']) },
        { tool: computerTool, available: () => true },
        { tool: screenAgentTool, available: () => true },
      ]
    : [
        { tool: desktopNotifyTool, available: () => isExecutableAvailable(['notify-send']) },
        { tool: screenshotTool, available: () => isExecutableAvailable(['grim', 'gnome-screenshot', 'spectacle', 'scrot', 'maim', 'import']) },
        { tool: computerTool, available: () => true },
        { tool: screenAgentTool, available: () => true },
      ];

const PLATFORM_TOOLS = PLATFORM_TOOL_CANDIDATES
  .filter(candidate => candidate.available())
  .map(candidate => candidate.tool);

const BUILTIN_TOOLS = [
  webSearchTool,
  skillLoaderTool,
  ...PLATFORM_TOOLS,
  imageGenTool,
  videoGenTool,
  imageAssetSearchTool,
  taskDecomposerTool,
  spawnSubAgentTool,
  browserControlTool,
  askUserTool,
  checkpointTool,
  waitTimerTool,
  agentCommTool,
  scheduledTasksTool,
  contextMemoryTool,

  workspaceEditFileTool,
  workspaceRunCommandTool,

  channelAgentTool,
  gatewayBridgeTool,
  connectorMcpTool,

  // Agent Builder control surface. These are filtered out of normal agent
  // runs by builder-agent.ts and exposed only in the dedicated builder room.
  ...agentBuilderTools,
];

/**
 * Replace the registry with the shared built-in surface. Replacement is
 * intentional: hot reloads must not retain tools removed from this list. The
 * declaration layer applies runtime isolation for Agent Builder controls.
 */
export function bootstrapTools() {
  globalToolRegistry.replaceAllTools(BUILTIN_TOOLS);
  console.log(`[ToolRegistry] ${BUILTIN_TOOLS.length} curated tools ready`);
}

bootstrapTools();
