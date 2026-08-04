import React from 'react';

export interface IconProps {
  isLive?: boolean;
  size?: number;
  color?: string;
}

const W = '#E8E6E3';

const LineIcon = ({
  size = 16,
  color = W,
  children,
}: IconProps & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <g
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    >
      {children}
    </g>
  </svg>
);

export const ComputerIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <rect x="4" y="5" width="16" height="11" rx="2.2" />
    <path d="M8.5 20h7M12 16v4" />
    <path d="M7.2 8.2h.01M10.2 8.2h.01" />
  </LineIcon>
);

export const TerminalIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <rect x="4" y="5" width="16" height="14" rx="2.3" />
    <path d="M7.4 9.2l2.6 2.6-2.6 2.6M12.2 15h4.2" />
  </LineIcon>
);

export const ClockIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5l3.2 1.9" />
    <path d="M8.2 3.9 6.8 2.8M15.8 3.9l1.4-1.1" />
  </LineIcon>
);

export const FileReadIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M7 3.8h7.2L18 7.6v12.1c0 .8-.6 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5V5.3c0-.8.7-1.5 1.5-1.5Z" />
    <path d="M14 4v4h4" />
    <path d="M8.2 14.3c1-1.6 2.3-2.4 3.8-2.4s2.8.8 3.8 2.4c-1 1.6-2.3 2.4-3.8 2.4s-2.8-.8-3.8-2.4Z" />
    <path d="M12 14.3h.01" />
  </LineIcon>
);

export const FileAddIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M7 3.8h7.2L18 7.6v12.1c0 .8-.6 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5V5.3c0-.8.7-1.5 1.5-1.5Z" />
    <path d="M14 4v4h4M9 15h6M12 12v6" />
  </LineIcon>
);

export const FileEditIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M7 3.8h7.2L18 7.6v4.2" />
    <path d="M14 4v4h4" />
    <path d="M6 19.4v-14c0-.9.7-1.6 1.6-1.6" />
    <path d="M9 19.2l6.8-6.8 2.1 2.1-6.8 6.8-3 .8.9-2.9Z" />
  </LineIcon>
);

export const FileDeleteIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M7.5 4h8.2L18 6.3v13.2c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5v-14C6 4.7 6.7 4 7.5 4Z" />
    <path d="M9.2 13.2h5.6" />
  </LineIcon>
);

export const AgentAssetIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <circle cx="12" cy="8.25" r="3.15" />
    <path d="M5.35 19.25c1.12-2.95 3.33-4.42 6.65-4.42s5.53 1.47 6.65 4.42" />
  </LineIcon>
);

export const ImageAssetIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <rect x="4" y="5" width="16" height="14" rx="2.4" />
    <path d="M8 14.6l2.2-2.5 2.2 2.5 1.4-1.5 2.9 3.4" />
    <path d="M15.6 8.8h.01" />
  </LineIcon>
);

export const Folder01Icon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M3.8 7.4c0-.9.7-1.6 1.6-1.6h4l2 2h7.2c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6H5.4c-.9 0-1.6-.7-1.6-1.6V7.4Z" />
    <path d="M4.2 10.1h15.6" />
  </LineIcon>
);

export const FolderAddIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M3.8 7.4c0-.9.7-1.6 1.6-1.6h4l2 2h7.2c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6H5.4c-.9 0-1.6-.7-1.6-1.6V7.4Z" />
    <path d="M9 14.4h6M12 11.4v6" />
  </LineIcon>
);

export const SearchList01Icon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M4 6.6h7M4 11h4.4M4 15.4h5.4" />
    <circle cx="15" cy="11.2" r="3.4" />
    <path d="M17.5 13.7l2.8 2.8" />
  </LineIcon>
);

export const CodeInspectIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M8.2 8.2 4.8 12l3.4 3.8M15.8 8.2 19.2 12l-3.4 3.8" />
    <circle cx="12" cy="12" r="2.4" />
    <path d="M13.8 13.8l2.8 2.8" />
  </LineIcon>
);

export const RefactorIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M5 7h7.5c2 0 3.6 1.6 3.6 3.6V17" />
    <path d="M13.7 14.8 16.1 17l2.4-2.2" />
    <path d="M19 7h-7.5c-2 0-3.6 1.6-3.6 3.6V17" />
    <path d="M10.3 9.2 7.9 7 5.5 9.2" />
  </LineIcon>
);

export const GitBranchIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <circle cx="6.5" cy="5.8" r="2.2" />
    <circle cx="17.5" cy="6.8" r="2.2" />
    <circle cx="6.5" cy="18.2" r="2.2" />
    <path d="M6.5 8v8M8.7 18.2h3.7c2.8 0 5.1-2.3 5.1-5.1V9" />
  </LineIcon>
);

export const CompareFilesIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <rect x="4" y="5" width="6.6" height="14" rx="1.8" />
    <rect x="13.4" y="5" width="6.6" height="14" rx="1.8" />
    <path d="M6.4 9h1.8M15.8 9h1.8M6.4 12h1.8M15.8 15h1.8" />
  </LineIcon>
);

export const ArtifactIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M12 3.8 19.2 8v8L12 20.2 4.8 16V8L12 3.8Z" />
    <path d="M8.8 8.8h6.4M8.8 12h6.4M8.8 15.2h3.6" />
    <path d="M18.2 4.2v2.4M17 5.4h2.4" />
  </LineIcon>
);

export const WebSearchIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M4.3 12h15.4M12 3.8c-2 2.1-3.1 4.9-3.1 8.2s1.1 6.1 3.1 8.2M12 3.8c2 2.1 3.1 4.9 3.1 8.2s-1.1 6.1-3.1 8.2" />
  </LineIcon>
);

export const CheckmarkBadge03Icon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M12 3.5l7 3v5.6c0 4.2-3 6.7-7 8.4-4-1.7-7-4.2-7-8.4V6.5l7-3Z" />
    <path d="M8.8 12.2l2 2 4.4-4.7" />
  </LineIcon>
);

export const DatabaseStackIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <ellipse cx="12" cy="6.2" rx="6.8" ry="2.7" />
    <path d="M5.2 6.2v5.4c0 1.5 3 2.7 6.8 2.7s6.8-1.2 6.8-2.7V6.2" />
    <path d="M5.2 11.6V17c0 1.5 3 2.7 6.8 2.7s6.8-1.2 6.8-2.7v-5.4" />
  </LineIcon>
);

export const NetworkNodeIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <circle cx="6.4" cy="12" r="2.8" />
    <circle cx="17.6" cy="6.5" r="2.8" />
    <circle cx="17.6" cy="17.5" r="2.8" />
    <path d="M9 10.7l6-3M9 13.3l6 3" />
  </LineIcon>
);

// Keep connector artwork on the same asset path used by Gateway.  Action
// cards deliberately resolve this from the trace payload instead of keeping a
// second icon registry in the chat UI, so a connector configured in Gateway
// looks identical while it is being configured, called, or verified.
const CONNECTOR_ALIASES: Record<string, string> = {
  airtable: 'airtable', asana: 'asana', bluebubbles: 'bluebubbles',
  clickup: 'clickup', discord: 'discord', dingtalk: 'dingtalk',
  dropbox: 'dropbox', email: 'email', feishu: 'feishu', figma: 'figma',
  github: 'github', gitlab: 'gitlab', gmail: 'gmail',
  googlecalendar: 'google_calendar', google_calendar: 'google_calendar',
  googledrive: 'google_drive', google_drive: 'google_drive',
  homeassistant: 'homeassistant', hubspot: 'hubspot', instagram: 'instagram',
  irc: 'irc', jira: 'jira', linkedin: 'linkedin', line: 'line',
  linear: 'linear', mattermost: 'mattermost', matrix: 'matrix',
  messenger: 'messenger', monday: 'monday', notion: 'notion',
  onedrive: 'onedrive', outlook: 'outlook_mail', outlookmail: 'outlook_mail',
  outlook_calendar: 'outlook_calendar', outlookcalendar: 'outlook_calendar',
  salesforce: 'salesforce', shopify: 'shopify', signal: 'signal',
  slack: 'slack', sms: 'sms', stripe: 'stripe', teams: 'teams',
  telegram: 'telegram', trello: 'trello', twitter: 'twitter',
  whatsapp: 'whatsapp', whatsappcloud: 'whatsapp', youtube: 'youtube', zoom: 'zoom',
};

const CONNECTOR_TOOL_ALIASES: Record<string, string> = {
  airtable: 'airtable', asana: 'asana', discord: 'discord',
  github: 'github', github_controller: 'github', gitlab: 'gitlab', gmail: 'gmail',
  google_calendar: 'google_calendar', google_drive: 'google_drive', hubspot: 'hubspot',
  jira: 'jira', linear: 'linear', matrix: 'matrix', notion: 'notion',
  outlook_mail: 'outlook_mail', outlook_calendar: 'outlook_calendar',
  slack: 'slack', slack_controller: 'slack', signal: 'signal',
  teams: 'teams', telegram: 'telegram',
  trello: 'trello', whatsapp: 'whatsapp',
  connector_mcp: '', gateway_bridge: '',
};

const connectorToken = (value: unknown) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\/[^/]+\//, '')
  .replace(/^connector[-_:]/, '')
  .replace(/^channel[-_:]/, '')
  .replace(/[\s-]+/g, '_');

export const resolveConnectorId = (...values: unknown[]): string | null => {
  for (const value of values) {
    const token = connectorToken(value);
    if (!token || token === 'connector_mcp' || token === 'gateway_bridge') continue;

    const direct = CONNECTOR_ALIASES[token] || CONNECTOR_TOOL_ALIASES[token];
    if (direct) return direct;

    // Tool names and natural-language trace labels can contain the provider
    // name (for example "Sending Slack").
    for (const [alias, id] of Object.entries(CONNECTOR_ALIASES).sort((left, right) => right[0].length - left[0].length)) {
      if (token.includes(alias)) return id;
    }
  }
  return null;
};

export const getConnectorId = (log: any): string | null => {
  const args = log?.toolArgs || log?.args || {};
  return resolveConnectorId(
    log?.connectorId,
    log?.connector_id,
    args?.connectorId,
    args?.connector_id,
    args?.server_id,
    args?.platform,
    args?.channel,
    args?.provider,
    args?.service,
    log?.platform,
    log?.channel,
    log?.tool,
    log?.name,
    log?.text,
    log?.secondary,
  );
};

export const isConnectorTrace = (log: any): boolean => {
  const toolName = String(log?.tool || log?.name || '').toLowerCase();
  const icon = String(log?.iconCategory || log?.icon || '').toLowerCase();
  return Boolean(
    getConnectorId(log) ||
    icon === 'connector' ||
    toolName === 'gateway_bridge' ||
    toolName === 'connector_mcp' ||
    /(?:^|_)(?:controller|connector|gateway)(?:$|_)/.test(toolName),
  );
};

export const ConnectorIcon = ({
  connectorId,
  size = 18,
  title,
  className = '',
}: {
  connectorId?: string | null;
  size?: number;
  title?: string;
  className?: string;
}) => {
  const id = resolveConnectorId(connectorId);
  if (!id) return <NetworkNodeIcon size={size} color="#B9B1A7" />;
  return (
    <img
      src={`/icons/connectors/${id}.svg`}
      alt=""
      aria-hidden={title ? undefined : true}
      title={title || id.replace(/_/g, ' ')}
      width={size}
      height={size}
      draggable={false}
      className={`select-none object-contain ${className}`}
    />
  );
};

export const ChartLineIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M5 19V5M5 19h14" />
    <path d="M8 15l3.1-3.2 2.7 2.1L18.5 8" />
  </LineIcon>
);

export const MemoryChipIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
    <path d="M9.4 10.2h5.2M9.4 13.8h3.6M9 3.8v2.2M12 3.8v2.2M15 3.8v2.2M9 18v2.2M12 18v2.2M15 18v2.2M3.8 9h2.2M3.8 12h2.2M3.8 15h2.2M18 9h2.2M18 12h2.2M18 15h2.2" />
  </LineIcon>
);

export const ApiNodeIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <rect x="4" y="7" width="6" height="6" rx="1.7" />
    <rect x="14" y="11" width="6" height="6" rx="1.7" />
    <path d="M10 10h2.3c1 0 1.7.7 1.7 1.7V14" />
  </LineIcon>
);

export const PackageBoxIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M12 3.8l7.2 4.1v8.2L12 20.2l-7.2-4.1V7.9L12 3.8Z" />
    <path d="M4.8 7.9l7.2 4.1 7.2-4.1M12 12v8.2" />
  </LineIcon>
);

export const LightbulbLineIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M8.3 13.6c-1.2-1-2-2.5-2-4.2A5.7 5.7 0 0 1 12 3.8a5.7 5.7 0 0 1 5.7 5.6c0 1.7-.8 3.2-2 4.2-.8.7-1.2 1.2-1.2 2.2h-5c0-1-.4-1.5-1.2-2.2Z" />
    <path d="M9.5 19h5M10.2 16h3.6" />
  </LineIcon>
);

export const ActivityPulseIcon = ({ size = 16, color = W }: IconProps) => (
  <LineIcon size={size} color={color}>
    <path d="M4 12h3.1l1.8-5.2 4 10.4 1.8-5.2H20" />
  </LineIcon>
);

export const ReadIcon = FileReadIcon;
export const WriteIcon = ArtifactIcon;
export const EditIcon = FileEditIcon;
export const SearchIcon = SearchList01Icon;
export const GlobeIcon = WebSearchIcon;
export const FolderIcon = Folder01Icon;
export const CodeIcon = CodeInspectIcon;
export const GitIcon = GitBranchIcon;
export const ApiIcon = ApiNodeIcon;
export const ThinkIcon = LightbulbLineIcon;
export const ImageIcon = ImageAssetIcon;
export const DatabaseIcon = DatabaseStackIcon;
export const BotIcon = AgentAssetIcon;
export const SpinnerIcon = ActivityPulseIcon;
export const SlackIconPremium = NetworkNodeIcon;
export const VerifyIcon = CheckmarkBadge03Icon;
export const PackageIcon = PackageBoxIcon;
export const LightbulbIcon = LightbulbLineIcon;
export const MemoryIcon = MemoryChipIcon;
export const DesktopIcon = ComputerIcon;
export const NetworkIcon = NetworkNodeIcon;
export const ChartIcon = ChartLineIcon;
export const SecurityIcon = CheckmarkBadge03Icon;

type SubAgentIdentityStatus = 'spawning' | 'working' | 'completed' | 'error' | 'idle' | string;

// Keep every sub-agent identity on the real public avatar set. Unknown or
// generated names use a deterministic avatar from this same set instead of
// falling back to the old pixel-grid placeholder.
export const SUB_AGENT_ASSET_NAMES = [
  'einstein', 'heisenberg', 'sam', 'dario', 'elon',
  'tesla', 'newton', 'turing', 'ada', 'curie',
  'feynman', 'darwin', 'hawking', 'galileo', 'davinci',
  'aristotle', 'oppenheimer', 'gates', 'jobs', 'pascal',
] as const;

export const getSubAgentAssetName = (name?: string, assetIndex?: number) => {
  const cleanName = String(name || '').trim().toLowerCase();
  if (typeof assetIndex === 'number' && Number.isFinite(assetIndex)) {
    const index = Math.abs(Math.floor(assetIndex)) % SUB_AGENT_ASSET_NAMES.length;
    return SUB_AGENT_ASSET_NAMES[index];
  }
  if ((SUB_AGENT_ASSET_NAMES as readonly string[]).includes(cleanName)) return cleanName;
  return SUB_AGENT_ASSET_NAMES[hashSubAgentName(cleanName || 'subagent') % SUB_AGENT_ASSET_NAMES.length];
};

const hashSubAgentName = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const SubAgentIdentityIcon = ({
  name,
  size = 32,
  className = '',
  title,
  assetIndex,
}: {
  name?: string;
  status?: SubAgentIdentityStatus;
  size?: number;
  className?: string;
  title?: string;
  assetIndex?: number;
}) => {
  const cleanName = String(name || 'Subagent').trim();
  const assetName = getSubAgentAssetName(name, assetIndex);

  return (
    <span
      className={`eterx-subagent-avatar flex items-center justify-center overflow-hidden rounded-full border border-white/[0.08] bg-black/10 ${className}`}
      style={{
        width: size,
        height: size,
      }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      <img
        src={`/icons/sub-agents/${assetName}.png`}
        alt={cleanName}
        className="h-full w-full select-none object-cover"
      />
    </span>
  );
};

const CAT_MAP: Record<string, React.FC<IconProps>> = {
  computer: ComputerIcon,
  desktop: ComputerIcon,
  browser: ComputerIcon,
  ui: ComputerIcon,
  agent: AgentAssetIcon,
  terminal: TerminalIcon,
  command: TerminalIcon,
  clock: ClockIcon,
  schedule: ClockIcon,
  image: ImageAssetIcon,
  file_read: FileReadIcon,
  file_create: FileAddIcon,
  file_edit: FileEditIcon,
  file_delete: FileDeleteIcon,
  folder_read: Folder01Icon,
  folder_create: FolderAddIcon,
  search: SearchList01Icon,
  web_search: WebSearchIcon,
  verification: CheckmarkBadge03Icon,
  safety: CheckmarkBadge03Icon,
  database: DatabaseStackIcon,
  data: DatabaseStackIcon,
  network: NetworkNodeIcon,
  connector: NetworkNodeIcon,
  api: ApiNodeIcon,
  chart: ChartLineIcon,
  memory: MemoryChipIcon,
  package: PackageBoxIcon,
  skill: PackageBoxIcon,
  code: CodeInspectIcon,
  git: GitBranchIcon,
  refactor: RefactorIcon,
  compare: CompareFilesIcon,
  artifact: ArtifactIcon,
};

export const AGENT_ICONS: Record<string, { Icon: React.FC<IconProps>; color: string }> = {
  'Running command': { Icon: TerminalIcon, color: W },
  'Running project command': { Icon: TerminalIcon, color: W },
  'Managing scheduled task': { Icon: ClockIcon, color: W },
  'Reading file': { Icon: FileReadIcon, color: W },
  'Reading PDF': { Icon: FileReadIcon, color: W },
  'Scanning directory': { Icon: Folder01Icon, color: W },
  'Editing file': { Icon: FileEditIcon, color: W },
  'Writing artifact': { Icon: ArtifactIcon, color: W },
  'Searching codebase': { Icon: SearchList01Icon, color: W },
  Researching: { Icon: WebSearchIcon, color: W },
  'Reading source': { Icon: WebSearchIcon, color: W },
  'Deep researching': { Icon: WebSearchIcon, color: W },
  'Analyzing code': { Icon: CodeInspectIcon, color: W },
  'Refactoring code': { Icon: RefactorIcon, color: W },
  'Verifying code': { Icon: CheckmarkBadge03Icon, color: W },
  'Verifying output': { Icon: CheckmarkBadge03Icon, color: W },
  'Git operation': { Icon: GitBranchIcon, color: W },
  'Spawning sub-agents': { Icon: AgentAssetIcon, color: W },
  'API request': { Icon: ApiNodeIcon, color: W },
  'API call': { Icon: ApiNodeIcon, color: W },
  'Database query': { Icon: DatabaseStackIcon, color: W },
  'Generating image': { Icon: ImageAssetIcon, color: W },
  'Loading skill': { Icon: PackageBoxIcon, color: W },
  'Scaffolding project': { Icon: FolderAddIcon, color: W },
  Slack: { Icon: NetworkNodeIcon, color: W },
  'Sending Slack': { Icon: NetworkNodeIcon, color: W },
  'Saving memory': { Icon: MemoryChipIcon, color: W },
  'Reading memory': { Icon: MemoryChipIcon, color: W },
  'Recalling context': { Icon: MemoryChipIcon, color: W },
  'Automating UI': { Icon: ComputerIcon, color: W },
  'Controlling desktop': { Icon: ComputerIcon, color: W },
  'Network operation': { Icon: NetworkNodeIcon, color: W },
  'Generating chart': { Icon: ChartLineIcon, color: W },
  'Analyzing data': { Icon: DatabaseStackIcon, color: W },
  'Running safety check': { Icon: CheckmarkBadge03Icon, color: W },
  'Auditing code': { Icon: CheckmarkBadge03Icon, color: W },
  'Searching images': { Icon: ImageAssetIcon, color: W },
  'Previewing UI': { Icon: ComputerIcon, color: W },
  'Comparing files': { Icon: CompareFilesIcon, color: W },
  Deleted: { Icon: FileDeleteIcon, color: W },
  Deleting: { Icon: FileDeleteIcon, color: W },
};

const SKILL_CATEGORIES: Record<string, string> = {
  web_artifacts_builder: 'file_create',
  senior_frontend: 'file_edit',
  component_architecture: 'file_edit',
  responsive_layout: 'file_edit',
  motion_animations: 'file_edit',
  epic_design: 'file_edit',
  deep_research: 'web_search',
  code_intelligence: 'search',
  smart_refactor: 'refactor',
  performance_profiler: 'verification',
  security_auditor: 'verification',
  database_designer: 'database',
  rag_architect: 'memory',
  api_design_reviewer: 'api',
  data_analyst: 'database',
};

export const resolveAgentIcon = (
  verb: string,
  rawText?: string,
  iconCategory?: string,
): { Icon: React.FC<IconProps>; color: string } => {
  const checkText = `${verb || ''} ${rawText || ''}`.toLowerCase();

  for (const [skill, cat] of Object.entries(SKILL_CATEGORIES)) {
    if (checkText.includes(skill)) {
      iconCategory = cat;
      break;
    }
  }

  if (/delete|remove|unlink|trash/.test(checkText)) return { Icon: FileDeleteIcon, color: W };

  const exact = AGENT_ICONS[verb] || (rawText && AGENT_ICONS[rawText]);
  if (exact) return { ...exact, color: W };

  if (iconCategory && CAT_MAP[iconCategory]) {
    return { Icon: CAT_MAP[iconCategory], color: W };
  }

  const t = checkText.replace(
    /^(?:step\s+\d+[:\s.]*|\[\s*step\s*\d+\s*\]\s*|\(\s*\d+\s*\)|\[\s*\d+(?:\/\d+)?\s*\]|\d+[.:]\s*)/i,
    '',
  );
  const hasFileReference = /\b[\w@./\\-]+\.(?:tsx?|jsx?|html?|css|scss|sass|json|mdx?|ya?ml|py|rb|go|rs|java|kt|c|cpp|h|hpp|cs|php|sql|csv|tsv|xlsx?|docx?|pptx?|pdf|txt|env|lock|toml|ini|xml|svg|png|jpe?g|webp|gif)\b/i.test(t);
  const hasFileReadVerb = /\b(read(?:ing)?|view(?:ing)?|open(?:ing)?|inspect(?:ing)?|parse|parsing|locat(?:e|ing)|review(?:ing)?)\b/i.test(t);

  if (/verif|test|check|audit|safet|lint|policy|guard/.test(t)) return { Icon: CheckmarkBadge03Icon, color: W };
  if (/sub.?agent|\bagent\b|worker|delegate|swarm|team/.test(t)) return { Icon: AgentAssetIcon, color: W };
  if (/image|photo|picture|visual asset|mockup|poster|sprite|screenshot/.test(t)) return { Icon: ImageAssetIcon, color: W };
  if (/git|commit|branch|merge|pull|push|rebase|checkout/.test(t)) return { Icon: GitBranchIcon, color: W };
  if (/compare|diff|delta/.test(t)) return { Icon: CompareFilesIcon, color: W };
  if (/refactor|restructure|rework|cleanup|dedupe|extract/.test(t)) return { Icon: RefactorIcon, color: W };
  if (/code|symbol|typescript|javascript|tsx|jsx/.test(t) && /analyz|inspect|review|scan|understand/.test(t)) return { Icon: CodeInspectIcon, color: W };
  if (/database|sql|query|table|schema|dataset|data\b|csv|xlsx|spreadsheet/.test(t)) return { Icon: DatabaseStackIcon, color: W };
  if (/memory|remember|recall|context|knowledge|rag/.test(t)) return { Icon: MemoryChipIcon, color: W };
  if (/api|endpoint|request|response|webhook|connector|integration/.test(t)) return { Icon: ApiNodeIcon, color: W };
  if (/network|slack|telegram|email|channel|socket|http/.test(t)) return { Icon: NetworkNodeIcon, color: W };
  if (/chart|plot|graph|metric|analytics|report/.test(t)) return { Icon: ChartLineIcon, color: W };
  if (/web|brows|scrap|research|fetch|url|source/.test(t)) return { Icon: WebSearchIcon, color: W };
  if ((hasFileReadVerb && hasFileReference) || /\b(read|view|open|inspect|parse)\b.*\b(file|pdf|docx?|xlsx?|csv|json|markdown|md|content)\b|\b(file|pdf|docx?|xlsx?|csv|json|markdown|md)\b.*\b(read|view|open|inspect|parse)\b/.test(t)) return { Icon: FileReadIcon, color: W };
  if (/scaffold|folder.*(creat|write)|project structure/.test(t)) return { Icon: FolderAddIcon, color: W };
  if (/folder|director|load|skill|package|dependency|install/.test(t)) return { Icon: PackageBoxIcon, color: W };
  if (/search|scan|analyz|find|list|index/.test(t)) return { Icon: SearchList01Icon, color: W };
  if (/edit|modif|updat|refactor|patch|fix|rewrite|rename|move/.test(t)) return { Icon: FileEditIcon, color: W };
  if (/artifact|compose|draft|generate document|generating document/.test(t)) return { Icon: ArtifactIcon, color: W };
  if (/creat|generat|save|write|build|output/.test(t)) return { Icon: FileAddIcon, color: W };
  if (/terminal|command|shell|exec|run|npm|pip|bash|zsh|sh|script|deploy/.test(t)) return { Icon: TerminalIcon, color: W };
  if (/desktop|control|automat|browser|ui|preview/.test(t)) return { Icon: ComputerIcon, color: W };

  return { Icon: TerminalIcon, color: W };
};
