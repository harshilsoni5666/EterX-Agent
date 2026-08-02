import { globalToolRegistry } from './registry';

// Core tools with distinct, useful runtime capabilities.
import { webSearchTool } from './core/search';
import { apiCallerTool } from './core/api';
import { skillLoaderTool } from './core/skill_loader';
import { systemMonitorTool } from './core/sysmonitor';
import { clipboardTool } from './core/clipboard';
import { desktopNotifyTool } from './core/notify';
import { screenshotTool } from './core/screenshot';
import { ttsTool } from './core/tts';
import { imageGenTool } from './core/imagegen';
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

// Only expose native desktop tools where their required OS facilities are
// built in and their full declared contract is implemented. Linux desktop
// environments vary widely, so optional xclip/espeak/notify utilities are not
// advertised as guaranteed capabilities. The browser remains the portable UI
// automation surface on every platform.
const PLATFORM_TOOLS = process.platform === 'win32'
  ? [clipboardTool, desktopNotifyTool, screenshotTool, ttsTool, computerTool, desktopControlTool, screenAgentTool]
  : process.platform === 'darwin'
    ? [clipboardTool, desktopNotifyTool, screenshotTool, ttsTool]
    : [clipboardTool, screenshotTool];

const BUILTIN_TOOLS = [
  webSearchTool,
  apiCallerTool,
  skillLoaderTool,
  systemMonitorTool,
  sysAutomationTool,
  ...PLATFORM_TOOLS,
  imageGenTool,
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
];

/**
 * Replace the registry with the curated built-in surface. Replacement is
 * intentional: hot reloads must not retain tools removed from this list.
 */
export function bootstrapTools() {
  globalToolRegistry.replaceAllTools(BUILTIN_TOOLS);
  console.log(`[ToolRegistry] ${BUILTIN_TOOLS.length} curated tools ready`);
}

bootstrapTools();
