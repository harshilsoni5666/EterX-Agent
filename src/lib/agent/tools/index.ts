import { globalToolRegistry } from './registry';

// ==========================================
// CORE TOOLS (27 tools)
// ==========================================
import { shellTool } from './core/shell';
import { webSearchTool } from './core/search';
import { calculatorTool } from './core/math';
import { apiCallerTool } from './core/api';
import { jsRunnerTool } from './core/jsrunner';
import { skillLoaderTool } from './core/skill_loader';
import { systemMonitorTool } from './core/sysmonitor';
import { gitTool } from './core/git';
import { clipboardTool } from './core/clipboard';
import { desktopNotifyTool } from './core/notify';
import { jsonTransformTool } from './core/json_transform';
import { screenshotTool } from './core/screenshot';
import { emailTool } from './core/email';
import { ttsTool } from './core/tts';
import { imageGenTool } from './core/imagegen';
import { taskDecomposerTool } from './core/task_decomposer';
import { networkTool } from './core/network';
import { databaseTool } from './core/database';
import { cryptoTool } from './core/crypto';
import { regexTool } from './core/regex';
import { sysAutomationTool } from './core/sys_automation';
import { selfImproveTool } from './core/self_improve';
import { memoryV2Tool } from './core/memory_v2';
import { apiHubTool } from './core/api_hub';
import { apiKeyVaultTool } from './core/api_vault';
import { contextManagerTool } from './core/context_manager';
import { safetyGuardTool } from './core/safety_guard';
import { realTimeVerifierTool } from './core/realtime_verify';
import { spawnSubAgentTool } from './core/spawn_sub_agent';
import { dynamicToolCreatorTool, workspaceAnalyzerTool, macroRunnerTool } from './core/next_gen';
import { dynamicSkillEngine } from '../engines';
import { backgroundTaskTool } from './core/background_task';
import { smartFileAnalyzerTool } from './core/smart_file_analyzer';
import { chartGeneratorTool } from './core/chart_generator';
import { codeIntelTool } from './core/code_intel';
import { deepResearchTool } from './core/deep_research';
import { smartRefactorTool } from './core/smart_refactor';
import { projectScaffolderTool } from './core/project_scaffolder';
import { envManagerTool, autoDocsTool } from './core/env_and_docs';
import { gitIntelTool } from './core/git_intel';
import { desktopControlTool } from './core/desktop_control';
import { browserControlTool } from './core/browser_control';
import { askUserTool } from './core/ask_user';
import { checkpointTool } from './core/checkpoint';
import { uiLivePreviewTool } from './core/ui_preview';

// ==========================================
// WORKSPACE & DATA TOOLS (13 tools)
// ==========================================
import {
  workspaceReadTool, workspaceWriteTool, workspaceListDirectoryTool,
  workspaceSearchTextTool, workspaceEditFileTool
} from './workspace/fileops';
import { workspaceRunCommandTool, workspaceVerifyCodeTool } from './workspace/execution';
import { csvAnalyzerTool } from './workspace/data';
import { docxGeneratorTool } from './workspace/docx';
import { officeArtifactBuilderTool } from './workspace/office_artifacts';
import { compressionTool } from './workspace/compression';
import { codeGeneratorTool } from './workspace/codegen';
import { diffTool } from './workspace/diff';
import { markdownTool } from './workspace/markdown';

// ==========================================
// RESEARCH TOOLS (4 tools)
// ==========================================
import { webScraperTool } from './research/scraper';
import { pdfParserTool } from './research/pdf';
import { youtubeTranscriptTool } from './research/youtube';
import { rssFeedTool } from './research/rss';

// ==========================================
// AUTOMATION TOOLS (5 tools)
// ==========================================
import { schedulerTool } from './automation/scheduler';
import { processManagerTool } from './automation/process_manager';
import { fileWatcherTool } from './automation/file_watcher';
import { httpServerTool } from './automation/http_server';
import { chainExecutorTool } from './automation/chain_executor';
import { agentCronSchedulerTool } from './automation/agent_cron_scheduler';
import { agentConnectorTriggerTool } from './automation/agent_connector_trigger';

// ==========================================
// COMMUNICATION TOOLS (2 tools)
// ==========================================
import { whatsappControllerTool } from './communication/whatsapp';
import { telegramUserControllerTool } from './communication/telegram';
import { slackControllerTool } from './communication/slack';

/**
 * Bootstraps ALL tools into the global registry.
 * Total: 56 tools — EterX Next-Gen Agent OS v5
 */
export function bootstrapTools() {
  globalToolRegistry.registerTools([
    shellTool, webSearchTool, calculatorTool, apiCallerTool,
    jsRunnerTool, skillLoaderTool, systemMonitorTool, gitTool,
    clipboardTool, desktopNotifyTool, jsonTransformTool, screenshotTool,
    emailTool, ttsTool, imageGenTool, taskDecomposerTool, networkTool,
    databaseTool, cryptoTool, regexTool, sysAutomationTool, selfImproveTool, memoryV2Tool,
    apiHubTool, apiKeyVaultTool, contextManagerTool, safetyGuardTool,
    realTimeVerifierTool, spawnSubAgentTool, uiLivePreviewTool,
    dynamicToolCreatorTool, workspaceAnalyzerTool, macroRunnerTool,
    backgroundTaskTool, smartFileAnalyzerTool, chartGeneratorTool, codeIntelTool,
    deepResearchTool, smartRefactorTool, projectScaffolderTool,
    envManagerTool, autoDocsTool, gitIntelTool,
    desktopControlTool, browserControlTool, askUserTool, checkpointTool,
    workspaceReadTool, workspaceWriteTool, workspaceListDirectoryTool,
    workspaceSearchTextTool, workspaceEditFileTool,
    workspaceRunCommandTool, workspaceVerifyCodeTool,
    csvAnalyzerTool, docxGeneratorTool, officeArtifactBuilderTool, compressionTool,
    codeGeneratorTool, diffTool, markdownTool,
    webScraperTool, pdfParserTool, youtubeTranscriptTool, rssFeedTool,
    schedulerTool, processManagerTool, fileWatcherTool, httpServerTool,
    chainExecutorTool, agentCronSchedulerTool, agentConnectorTriggerTool,
    whatsappControllerTool, telegramUserControllerTool, slackControllerTool,
  ]);

  dynamicSkillEngine.initialize().catch(() => { });
  const total = globalToolRegistry.getAllTools().length;
  console.log(`[ToolRegistry] ✅ ${ total } tools ready`);
}

bootstrapTools();
