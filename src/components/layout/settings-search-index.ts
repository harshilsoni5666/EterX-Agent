import { IMPORT_LABELS, IMPORT_PROVIDERS } from '../../lib/imports/types';

type Setting = {
  title: string;
  keywords: string;
  section?: string;
  target?: string;
  fallbackTarget?: string;
};

// The settings tabs mount on demand. Index their public labels and aliases without
// opening tabs or reading any saved settings values. Targets default to row titles.
const SETTINGS: Record<SettingsSearchTab, readonly Setting[]> = {
  general: [
    { title: 'Work mode', keywords: 'general everyday specialist autonomous proxy agent workflow', target: 'work-mode' },
    { title: 'Permissions', keywords: 'sandbox file access allow workspace network commands approvals' },
    { title: 'Always full access', section: 'Permissions', keywords: 'hide permission selector unrestricted file access network commands approvals' },
    { title: 'Continue active chats in background', keywords: 'keep running closed hidden minimized window tasks gateway' },
    { title: 'Run scheduled chats in background', keywords: 'automation scheduled tasks recurring due wake gateway' },
    { title: 'Start background companion at sign-in', keywords: 'launch at login startup boot open automatically gateway tray' },
    { title: 'Default open destination', keywords: 'default editor open files folders workspace last used' },
    { title: 'Scratch workspace retention', keywords: 'temporary project cleanup expiry expiration delete files days storage' },
    { title: 'Integrated terminal shell', keywords: 'command line console powershell pwsh bash cmd zsh smart default' },
    { title: 'Self-improvement', keywords: 'learning reflection learned guidance adaptation agent memory pause' },
    { title: 'Synapse Graph', keywords: 'local graph memory context routing topic continuity file evidence' },
    { title: 'Follow-up behavior', keywords: 'followup steer queue messages interrupt running send' },
    { title: 'Code review', keywords: 'inline detached separate review chat' },
    { title: 'Open source licenses', keywords: 'third party dependencies legal notices license' },
    { title: 'User manual', keywords: 'documentation guide help how to use tutorial' },
    { title: 'Microphone', section: 'Microphone and speech', keywords: 'mic audio input recording device refresh voice', target: 'microphone-device' },
    { title: 'Dictation language', section: 'Microphone and speech', keywords: 'language spoken speech voice typing transcription auto detect', target: 'dictation-language' },
    { title: 'Speech model', section: 'Microphone and speech', keywords: 'local whisper dictation speech to text transcription download manage models stt', target: 'speech-model' },
    { title: 'Turn completion notifications', section: 'Notifications', keywords: 'alerts notification task finished done desktop notify complete important' },
  ],
  profile: [
    { title: 'Profile name', keywords: 'my name account identity display name rename', target: 'profile-name' },
    { title: 'Token activity', keywords: 'usage calendar heatmap daily history input output cached', target: 'profile-token-activity' },
    { title: 'Insights', keywords: 'activity statistics most used model reasoning skills explored total skills used', target: 'profile-insights' },
  ],
  appearance: [
    { title: 'Theme', keywords: 'dark mode light mode system theme color scheme display night white black' },
    { title: 'UI density', keywords: 'spacing text size font size compact comfortable default scaling zoom layout' },
    { title: 'UI font size', keywords: 'text size lettering bigger smaller pixels scaling typography' },
  ],
  import: [
    { title: 'Keep imports in sync', section: 'Automatic sync', keywords: 'auto refresh local sources one way background updates', target: 'import-auto-sync' },
    { title: 'Import from another AI app', keywords: 'migrate conversations chats projects setup instructions skills agents servers export upload', target: 'import-sources' },
    ...IMPORT_PROVIDERS.map(provider => ({
      title: `Import from ${IMPORT_LABELS[provider]}`,
      keywords: 'source options upload export sync now import chats projects local files',
      target: `import-${provider}`,
    })),
    { title: 'Imported setup', keywords: 'imported skills instructions agent server mcp manage toggle', target: 'imported-setup', fallbackTarget: 'import-sources' },
  ],
  configuration: [
    { title: 'Runtime checks', keywords: 'verification streaming grounding agent behavior' },
    { title: 'Critic verification', section: 'Runtime checks', keywords: 'verify review quality control high risk validation pass before delivery' },
    { title: 'Stream responses', section: 'Runtime checks', keywords: 'streaming typewriter live text incremental output response generation realtime' },
    { title: 'Grounding search', section: 'Runtime checks', keywords: 'web search browse internet online lookup sources citations current facts' },
    { title: 'Sub-agents', keywords: 'subagent subagents parallel helper agents delegation' },
    { title: 'Auto sub-agent spawning', section: 'Sub-agents', keywords: 'subagent subagents automatic parallel helper agents delegation spawn' },
    { title: 'Auto-open Work Panel', section: 'Sub-agents', keywords: 'work panel subagent spawned open navigation sidebar' },
    { title: 'Concurrent sub-agents', section: 'Sub-agents', keywords: 'subagent subagents count limit maximum number parallel helpers slots concurrency workers' },
  ],
  agents: [
    { title: 'Agent tools', keywords: 'tool permissions enabled available search agent coding lite heavy general chat restore defaults tool access', target: 'agent-tools' },
  ],
  personalization: [
    { title: 'User name', keywords: 'display name nickname username prompt workspace labels titles' },
    { title: 'Language', keywords: 'app shell localization locale translation interface language' },
    { title: 'Personality', keywords: 'tone response style default behavior concise friendly formal' },
    { title: 'Custom instructions', keywords: 'system prompt preferences workflow guidance behavior persona rules', target: 'personal-instructions' },
  ],
  mcp: [
    { title: 'Enable MCP bridge', keywords: 'model context protocol external client server gateway connection expose' },
  ],
  tokens: [
    { title: 'Show token count', keywords: 'display tokens input output prompt completion usage visibility', target: 'token-count' },
    { title: 'All chats', keywords: 'chat token totals conversation history prompt completion usage', target: 'chat-token-usage' },
    { title: 'Action usage', keywords: 'per action tools usage model input output cached reasoning tokens', target: 'action-token-usage' },
  ],
  context: [
    { title: 'Context compaction', keywords: 'memory summarization history compression capsule' },
    { title: 'Automatic compaction', keywords: 'compress summarize history auto context length overflow token limit' },
    { title: 'Context window size', keywords: 'token budget maximum cap limit model history length global context size' },
    { title: 'Compaction model', keywords: 'model summarization capsule continuation auto provider' },
    { title: 'Custom instructions', section: 'Context compaction', keywords: 'compactor prompt capsule preserve summarize emphasize memory', target: 'compaction-instructions' },
    { title: 'Per-chat context', keywords: 'context budget for this chat override token limit choose chat individual conversation', target: 'chat-context' },
    { title: 'Runtime behavior', keywords: 'context compaction adaptive retention protection automatic resume safe boundaries per chat isolation' },
    { title: 'Adaptive protection', section: 'Runtime behavior', keywords: 'context limit safety model growth compaction threshold' },
    { title: 'Adaptive retention', section: 'Runtime behavior', keywords: 'context tail capsule preserve dense information continuity' },
    { title: 'Per-chat isolation', section: 'Runtime behavior', keywords: 'capsules locks counters retry chat id separation' },
    { title: 'Safe boundary', section: 'Runtime behavior', keywords: 'compaction model iteration safe tool call file edit' },
    { title: 'Automatic resume', section: 'Runtime behavior', keywords: 'continue active run capsule auto compaction after summarizing' },
  ],
  models: [
    { title: 'Model connection', keywords: 'connect model provider local cloud' },
    { title: 'Provider', section: 'Model connection', keywords: 'main agent model provider cloud local vendor' },
    { title: 'Model', section: 'Model connection', keywords: 'main agent default active model select picker catalog' },
    { title: 'API base URL', section: 'Model connection', keywords: 'custom endpoint server gateway override openai compatible host docker local ollama' },
    { title: 'Exact model ID', keywords: 'custom manual model slug exact openrouter model exact groq model snapshot add', target: 'exact-model' },
    { title: 'Chat model list', keywords: 'models picker selector manage selected saved models remove' },
    { title: 'Live model discovery', keywords: 'refresh catalog fetch available models provider availability' },
  ],
  subscription: [
    { title: 'Connect ChatGPT', section: 'Codex', keywords: 'sign in openai subscription plan connect account', target: 'chatgpt-subscription' },
    { title: 'ChatGPT usage', section: 'Codex', keywords: 'subscription limits quota manage usage', target: 'chatgpt-usage', fallbackTarget: 'chatgpt-subscription' },
    { title: 'Available models', section: 'Codex', keywords: 'chatgpt catalog refresh models', target: 'chatgpt-models', fallbackTarget: 'chatgpt-subscription' },
  ],
  api: [
    { title: 'Provider', section: 'API connections', keywords: 'select model provider vendor key pool credentials' },
    { title: 'API keys', section: 'API connections', keywords: 'apikey key pool credentials secret authentication provider model access token add rotate' },
    { title: 'Model', section: 'API connections', keywords: 'add connected provider model manage models chat selector', fallbackTarget: 'API keys' },
    { title: 'API retries', section: 'Service APIs', keywords: 'retry attempts provider key failover maximum max retry count' },
    { title: 'Code platform', section: 'Service APIs', keywords: 'github token personal access pat git repository api key credentials' },
  ],
  'live-convo': [
    { title: 'Live Convo Engine', keywords: 'voice chat real time conversation audio enable streaming' },
    { title: 'Live Provider', keywords: 'voice backend native provider realtime audio transport system speech' },
    { title: 'Live Model', keywords: 'voice model engine realtime ai selected chat model' },
    { title: 'Exact model ID', keywords: 'live provider account snapshot manual override', fallbackTarget: 'Live Provider' },
    { title: 'Voice Persona', keywords: 'voice speaking tts text to speech speaker narrator synthesized output accent' },
    { title: 'Conversational Agent ID', keywords: 'elevenlabs agent identifier native realtime', fallbackTarget: 'Live Provider' },
    { title: 'Provider catalog status', keywords: 'reload refresh available live models voices' },
    { title: 'Gemini Thinking Level', keywords: 'gemini reasoning latency effort live', fallbackTarget: 'Live Provider' },
    { title: 'Audio Modalities', keywords: 'mic input microphone capture speaker output playback mute live voice' },
    { title: 'Mic Input', section: 'Audio Modalities', keywords: 'microphone capture mute live audio', target: 'mic-input' },
    { title: 'Speaker Output', section: 'Audio Modalities', keywords: 'mute playback audio sound voice', target: 'speaker-output' },
    { title: 'Live System Instructions', keywords: 'live custom prompt directives voice agent behavior', target: 'live-instructions', fallbackTarget: 'Live Provider' },
    { title: 'Live Convo Key Pool', keywords: 'live api key authentication credentials realtime provider token', fallbackTarget: 'Live Provider' },
  ],
  git: [
    { title: 'Git integration', keywords: 'version control repository branch composer enable disable' },
    { title: 'Git workspace tab', keywords: 'source control files review terminal stage commit branch history stash diff' },
    { title: 'Auto-refresh local status', keywords: 'automatic refresh polling git changes remote fetch pull push' },
    { title: 'Branch prefix', keywords: 'default branch naming new branches prefill' },
    { title: 'Branch merge method', keywords: 'merge commits squash fast forward strategy' },
    { title: 'Confirm before pushing', keywords: 'push confirmation publish commits repository destination remote approval' },
  ],
  environments: [
    { title: 'Debug mode', section: 'Developer', keywords: 'logs logging console diagnostics traces internal verbose developer' },
    { title: 'Performance telemetry', section: 'Developer', keywords: 'analytics metrics anonymous usage data collection privacy' },
    { title: 'Experimental features', keywords: 'beta early access developer new features feature flags' },
    { title: 'Clear agent memory', section: 'Data', keywords: 'reset delete erase wipe local settings preferences api keys clean' },
    { title: 'Export all settings', section: 'Data', keywords: 'backup download configuration data json local preferences' },
  ],
  browser: [
    { title: 'Use built-in model search first', section: 'Web search', keywords: 'native web grounding browse prefer model builtin search priority' },
    { title: 'Live web intelligence', section: 'Web search', keywords: 'grounding web search enable deep research source reading internet lookup' },
    { title: 'Primary provider', section: 'Web search', keywords: 'main external lookup search engine', target: 'search-provider' },
    { title: 'Custom endpoint', section: 'Web search', keywords: 'service url base url host private deployment relay', target: 'search-endpoint' },
    { title: 'Provider services', section: 'Web search', keywords: 'search read extract crawl map deep research capabilities' },
    { title: 'Provider credentials', section: 'Web search', keywords: 'web search api key pool authentication test connection', target: 'search-credentials' },
    { title: 'Test connection', section: 'Web search', keywords: 'test provider verify service credentials', target: 'test-search-connection', fallbackTarget: 'search-credentials' },
    { title: 'Automatic failover', section: 'Web search', keywords: 'provider fallback backup priority order rotation' },
    { title: 'Enable image generation', section: 'Image generation', keywords: 'generate picture artwork imagegen raster create images' },
    { title: 'Primary provider', section: 'Image generation', keywords: 'image vendor primary engine default', target: 'image-provider' },
    { title: 'Model', section: 'Image generation', keywords: 'image model id imagegen generator', target: 'image-model' },
    { title: 'Custom endpoint', section: 'Image generation', keywords: 'base url service host relay image api', target: 'image-endpoint' },
    { title: 'Provider credentials', section: 'Image generation', keywords: 'image api key pool authentication token', target: 'image-credentials' },
    { title: 'Fallback providers', section: 'Image generation', keywords: 'image failover backup order', target: 'image-fallbacks' },
    { title: 'Test connection', section: 'Image generation', keywords: 'verify image provider credentials', target: 'test-image-connection' },
    { title: 'Enable video generation', section: 'Video generation', keywords: 'generate video animation clips video tool' },
    { title: 'Primary provider', section: 'Video generation', keywords: 'video vendor primary engine default', target: 'video-provider' },
    { title: 'Model', section: 'Video generation', keywords: 'video model id movie animation generator', target: 'video-model' },
    { title: 'Custom endpoint', section: 'Video generation', keywords: 'base url service host relay video api', target: 'video-endpoint' },
    { title: 'Provider credentials', section: 'Video generation', keywords: 'video api key pool authentication token', target: 'video-credentials' },
    { title: 'Fallback providers', section: 'Video generation', keywords: 'video failover backup order', target: 'video-fallbacks' },
    { title: 'Test connection', section: 'Video generation', keywords: 'verify video provider credentials', target: 'test-video-connection' },
  ],
  computer: [
    { title: 'Allow browser control', section: 'Browser control', keywords: 'automation access browser tabs websites navigation', target: 'computer-browser-access' },
    { title: 'Browser session', section: 'Browser control', keywords: 'connect existing signed in chrome edge brave browser launch isolated managed session', target: 'browser-session' },
    { title: 'Allow computer actions', section: 'Desktop control', keywords: 'desktop access control screen screenshot mouse keyboard native apps computer use', target: 'computer-desktop-access' },
    { title: 'Connection details', section: 'Desktop control', keywords: 'runtime status desktop driver service screen input provider setup macos permissions', target: 'computer-connection-details' },
    { title: 'Permission review', section: 'Safety & permissions', keywords: 'approve sensitive desktop actions auto review access permissions', target: 'computer-permission-review' },
  ],
  updates: [
    { title: 'Application updates', keywords: 'updater version update software download restart install release' },
    { title: 'Check for updates', keywords: 'manual check download install latest version check again', target: 'update-actions' },
    { title: 'What’s new', keywords: 'release notes changelog new features version history', target: 'release-notes', fallbackTarget: 'Application updates' },
  ],
};

export type SettingsSearchTab =
  | 'general' | 'profile' | 'appearance' | 'import' | 'configuration' | 'agents'
  | 'personalization' | 'mcp' | 'tokens' | 'context' | 'models' | 'subscription' | 'api' | 'live-convo'
  | 'git' | 'environments' | 'browser' | 'computer' | 'updates';

export type SettingsSearchResult = Omit<Setting, 'keywords' | 'target'> & {
  tab: SettingsSearchTab;
  target: string;
};

export const SETTINGS_TAB_HEADING = 'settings-tab-heading';

const normalize = (value: string) => value.toLowerCase().normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const ignoredWords = new Set([
  'a', 'an', 'and', 'can', 'do', 'for', 'how', 'i', 'in', 'is', 'my', 'of', 'on', 'the', 'to', 'where', 'with',
  'adjust', 'change', 'disable', 'enable', 'find', 'off', 'set', 'setting', 'settings', 'turn',
]);

type IndexedSetting = {
  result: SettingsSearchResult;
  title: string;
  titleWords: string[];
  pathWords: string[];
  keywords: string;
  keywordWords: string[];
};

export function buildSettingsSearchIndex(tabs: readonly { id: SettingsSearchTab; label: string }[]): IndexedSetting[] {
  return tabs.flatMap(({ id, label: tabLabel }) => {
    const page: Setting = { title: tabLabel, keywords: '', target: SETTINGS_TAB_HEADING };
    return [page, ...SETTINGS[id]].map(({ keywords: aliases, title: label, target = label, section, fallbackTarget }) => {
      const title = normalize(label);
      const keywords = normalize(aliases);
      return {
        result: { tab: id, title: label, target, section, fallbackTarget },
        title,
        titleWords: title.split(' '),
        pathWords: normalize(`${tabLabel} ${section ?? ''}`).split(' '),
        keywords,
        keywordWords: keywords.split(' '),
      };
    });
  });
}

function isOneEditAway(term: string, word: string): boolean {
  const difference = word.length - term.length;
  if (Math.abs(difference) > 1) return false;

  let index = 0;
  const shorterLength = Math.min(term.length, word.length);
  while (index < shorterLength && term[index] === word[index]) index++;
  if (difference === 1) return term.slice(index) === word.slice(index + 1);
  if (difference === -1) return term.slice(index + 1) === word.slice(index);
  return term.slice(index + 1) === word.slice(index + 1)
    || (term[index] === word[index + 1] && term[index + 1] === word[index] && term.slice(index + 2) === word.slice(index + 2));
}

function scoreTerm(term: string, entry: IndexedSetting): number {
  if (entry.titleWords.includes(term)) return 60;
  if (entry.titleWords.some(word => word.startsWith(term))) return 48;
  if (entry.keywordWords.includes(term)) return 38;
  if (term.length >= 2 && entry.keywordWords.some(word => word.startsWith(term))) return 30;
  if (term.length >= 3 && entry.titleWords.some(word => word.includes(term))) return 26;
  if (term.length >= 4 && entry.titleWords.some(word => isOneEditAway(term, word))) return 18;
  if (term.length >= 5 && entry.keywordWords.some(word => isOneEditAway(term, word))) return 12;
  return 0;
}

export function searchSettings(index: readonly IndexedSetting[], query: string, activeTab: string): SettingsSearchResult[] {
  const phrase = normalize(query);
  if (!phrase) return [];
  const words = phrase.split(' ');
  const meaningfulWords = words.filter(word => !ignoredWords.has(word));
  const terms = [...new Set(meaningfulWords.length ? meaningfulWords : words)];

  return index.flatMap(entry => {
    if (entry.title === phrase) return [{ result: entry.result, score: 160 }];
    if (entry.title.startsWith(phrase)) return [{ result: entry.result, score: 128 }];
    if (` ${entry.title}`.includes(` ${phrase}`)) return [{ result: entry.result, score: 104 }];

    const contentScores = terms.map(term => scoreTerm(term, entry));
    if (contentScores.every(score => score === 0)) return [];
    const scores = terms.map((term, position) => contentScores[position]
      || (entry.pathWords.includes(term) ? 24 : 0));
    if (scores.includes(0)) return [];

    const phraseBonus = ` ${entry.keywords} `.includes(` ${phrase} `) ? 22 : 0;
    return [{ result: entry.result, score: scores.reduce((sum, score) => sum + score, 0) / scores.length + phraseBonus }];
  }).sort((a, b) => b.score - a.score || Number(b.result.tab === activeTab) - Number(a.result.tab === activeTab))
    .map(match => match.result);
}
