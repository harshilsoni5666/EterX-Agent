import { globalToolRegistry } from './registry';

// Shared tools with distinct, useful runtime capabilities. The normal Main
// agent applies main-tool-policy.ts before advertising this registry; custom
// and legacy runtimes can still resolve the full shared surface.
import { webSearchTool } from './core/search';
import { apiCallerTool } from './core/api';
import { calculatorTool } from './core/math';
import { jsonTransformTool } from './core/json_transform';
import { regexTool } from './core/regex';
import { skillLoaderTool } from './core/skill_loader';
import { systemMonitorTool } from './core/sysmonitor';
import { clipboardTool } from './core/clipboard';
import { desktopNotifyTool } from './core/notify';
import { screenshotTool } from './core/screenshot';
import { ttsTool } from './core/tts';
import { imageGenTool } from './core/imagegen';
import { videoGenTool } from './core/videogen';
import { imageAssetSearchTool } from './core/image_asset_search';
import { taskDecomposerTool } from './core/task_decomposer';
import { memoryV2Tool } from './core/memory_v2';
import { contextManagerTool } from './core/context_manager';
import { realTimeVerifierTool } from './core/realtime_verify';
import { spawnSubAgentTool } from './core/spawn_sub_agent';
import { backgroundTaskTool } from './core/background_task';
import { deepResearchTool } from './core/deep_research';
import { browserControlTool } from './core/browser_control';
import { askUserTool } from './core/ask_user';
import { checkpointTool } from './core/checkpoint';
import { computerTool } from './core/computer';
import { desktopControlTool } from './core/desktop_control';
import { screenAgentTool } from './core/screen_agent';
import { sysAutomationTool } from './core/sys_automation';
import { waitTimerTool } from './core/wait_timer';
import { agentCommTool } from './core/agent_comm';
import { toolFinderTool } from './core/tool_finder';
import { scheduledTasksTool } from './core/scheduled_tasks';

// Workspace inspection and execution. These are the established file tools
// wired to the UI's created-file preview and expandable real-diff display.
import {
  workspaceReadTool,
  workspaceWriteTool,
  workspaceListDirectoryTool,
  workspaceSearchTextTool,
  workspaceEditFileTool,
} from './workspace/fileops';
import { workspaceStrReplaceTool } from './workspace/str_replace';
import {
  workspaceRunCommandTool,
  workspaceVerifyCodeTool,
} from './workspace/execution';
import {
  workspaceFindFilesTool,
  workspaceReadManyFilesTool,
  workspaceEditManyFilesTool,
} from './workspace/fast_ops';
import { workspaceApplyPatchTool } from './workspace/apply_patch';
import { codeGeneratorTool } from './workspace/codegen';
import { workspaceSemanticSearchTool } from './workspace/semantic_search';
import { workspaceFileOutlineTool } from './workspace/coding_intel';
import { csvAnalyzerTool } from './workspace/data';
import { docxGeneratorTool } from './workspace/docx';
import { officeArtifactBuilderTool } from './workspace/office_artifacts';
import { compressionTool } from './workspace/compression';

// Content research.
import { webScraperTool } from './research/scraper';
import { pdfParserTool } from './research/pdf';
import { docxParserTool } from './research/docx';
import { youtubeTranscriptTool } from './research/youtube';
import { rssFeedTool } from './research/rss';

// Long-running local processes and the connector marked functional in the UI.
import { processManagerTool } from './automation/process_manager';
import { slackControllerTool } from './communication/slack';
import { gatewayBridgeTool } from './communication/gateway_bridge';
import { connectorMcpTool } from './communication/connector_mcp';
import { agentBuilderTools } from './automation/agent_builder';
import { isExecutableAvailable } from './core/shell_resolver';

// Shared desktop tools stay registered on every supported OS so agents do not
// lose the capability name when a machine lacks an optional utility. Their
// providers return an explicit availability/permission message at execution
// time. Optional clipboard, notification, screenshot, and TTS tools are still
// filtered by the utilities they actually require.
type PlatformToolCandidate = {
  tool: typeof clipboardTool;
  available: () => boolean;
};

const PLATFORM_TOOL_CANDIDATES: PlatformToolCandidate[] = process.platform === 'win32'
  ? [
      { tool: clipboardTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
      { tool: desktopNotifyTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
      { tool: screenshotTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
      { tool: ttsTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
      { tool: computerTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
      { tool: desktopControlTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
      { tool: screenAgentTool, available: () => isExecutableAvailable(['powershell.exe', 'pwsh.exe']) },
    ]
  : process.platform === 'darwin'
    ? [
        { tool: clipboardTool, available: () => isExecutableAvailable(['pbpaste']) && isExecutableAvailable(['pbcopy']) },
        { tool: desktopNotifyTool, available: () => isExecutableAvailable(['osascript']) },
        { tool: screenshotTool, available: () => isExecutableAvailable(['screencapture']) },
        { tool: ttsTool, available: () => isExecutableAvailable(['say']) },
        { tool: computerTool, available: () => true },
        { tool: desktopControlTool, available: () => true },
        { tool: screenAgentTool, available: () => true },
      ]
    : [
        { tool: clipboardTool, available: () => (
          isExecutableAvailable(['wl-paste']) && isExecutableAvailable(['wl-copy'])
        ) || isExecutableAvailable(['xclip']) || isExecutableAvailable(['xsel']) },
        { tool: desktopNotifyTool, available: () => isExecutableAvailable(['notify-send']) },
        { tool: screenshotTool, available: () => isExecutableAvailable(['grim', 'gnome-screenshot', 'spectacle', 'scrot', 'maim', 'import']) },
        { tool: ttsTool, available: () => isExecutableAvailable(['espeak', 'spd-say']) },
        { tool: computerTool, available: () => true },
        { tool: desktopControlTool, available: () => true },
        { tool: screenAgentTool, available: () => true },
      ];

const PLATFORM_TOOLS = PLATFORM_TOOL_CANDIDATES
  .filter(candidate => candidate.available())
  .map(candidate => candidate.tool);

const BUILTIN_TOOLS = [
  webSearchTool,
  apiCallerTool,
  calculatorTool,
  jsonTransformTool,
  regexTool,
  skillLoaderTool,
  systemMonitorTool,
  sysAutomationTool,
  ...PLATFORM_TOOLS,
  imageGenTool,
  videoGenTool,
  imageAssetSearchTool,
  taskDecomposerTool,
  memoryV2Tool,
  contextManagerTool,
  realTimeVerifierTool,
  spawnSubAgentTool,
  backgroundTaskTool,
  deepResearchTool,
  browserControlTool,
  askUserTool,
  checkpointTool,
  waitTimerTool,
  agentCommTool,
  toolFinderTool,
  scheduledTasksTool,

  workspaceReadTool,
  workspaceWriteTool,
  workspaceListDirectoryTool,
  workspaceSearchTextTool,
  workspaceEditFileTool,
  workspaceStrReplaceTool,
  workspaceRunCommandTool,
  workspaceVerifyCodeTool,
  workspaceFindFilesTool,
  workspaceReadManyFilesTool,
  workspaceEditManyFilesTool,
  workspaceApplyPatchTool,
  codeGeneratorTool,
  workspaceSemanticSearchTool,
  workspaceFileOutlineTool,
  csvAnalyzerTool,
  docxGeneratorTool,
  officeArtifactBuilderTool,
  compressionTool,

  webScraperTool,
  pdfParserTool,
  docxParserTool,
  youtubeTranscriptTool,
  rssFeedTool,

  processManagerTool,
  slackControllerTool,
  gatewayBridgeTool,
  connectorMcpTool,

  // Agent Builder control surface. These are filtered out of normal agent
  // runs by builder-agent.ts and exposed only in the dedicated builder room.
  ...agentBuilderTools,
];

/**
 * Replace the registry with the shared built-in surface. Replacement is
 * intentional: hot reloads must not retain tools removed from this list. The
 * normal Main agent applies its narrower exposure policy at declaration time.
 */
export function bootstrapTools() {
  globalToolRegistry.replaceAllTools(BUILTIN_TOOLS);
  console.log(`[ToolRegistry] ${BUILTIN_TOOLS.length} curated tools ready`);
}

bootstrapTools();
