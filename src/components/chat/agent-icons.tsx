import React from 'react';

// Each icon: size + color props. All default to white (#E8E6E3).
export interface IconProps {
  isLive?: boolean;
  size?: number;
  color?: string;
}

const W = '#E8E6E3'; // universal white

// 1. Computer / browser / desktop control
export const ComputerIcon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="1.25" y="2.25" width="13.5" height="9.5" rx="1.75" stroke={color} strokeWidth="1.15" fill="none" />
    <line x1="1.25" y1="8.75" x2="14.75" y2="8.75" stroke={color} strokeWidth="0.9" opacity="0.25" />
    <circle cx="3.25" cy="4" r="0.65" fill={color} opacity="0.75" />
    <circle cx="5" cy="4" r="0.65" fill={color} opacity="0.75" />
    <circle cx="6.75" cy="4" r="0.65" fill={color} opacity="0.75" />
    <path d="M5.5 11.75 L10.5 11.75" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
    <path d="M8 11.75 L8 13.75" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
    <path d="M6 13.75 L10 13.75" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
  </svg>
);

// 1b. Terminal / command / git / shell
export const TerminalIcon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="1.25" y="2.25" width="13.5" height="11.5" rx="1.75" stroke={color} strokeWidth="1.15" fill="none" />
    <path d="M1.25 5.25 L14.75 5.25" stroke={color} strokeWidth="0.9" opacity="0.3" />
    <circle cx="3.5" cy="3.75" r="0.6" fill={color} opacity="0.5" />
    <circle cx="5.5" cy="3.75" r="0.6" fill={color} opacity="0.5" />
    <circle cx="7.5" cy="3.75" r="0.6" fill={color} opacity="0.5" />
    <path d="M3.5 8.25 L5.5 10 L3.5 11.75" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M7 11.75 L11 11.75" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

// 2. File creation: new files, documents, images, artifacts
export const FileAddIcon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M2.75 1.75h6.5l3 3v9.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z" stroke={color} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9.25 1.75v3h3" stroke={color} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5.5 10.5h4M7.5 8.5v4" stroke={color} strokeWidth="1.25" strokeLinecap="round" />
  </svg>
);

// 3. File editing: editing/patching/refactoring existing files
export const FileEditIcon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M8.25 1.75h-5.5a1 1 0 0 0-1 1v11.5a1 1 0 0 0 1 1h9.5a1 1 0 0 0 1-1V5.75" stroke={color} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.25 1.75v4h4" stroke={color} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5.5 11.5l3.5-3.5 1.5 1.5-3.5 3.5-1.5.5.5-2z" stroke={color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 4. Folder reading: reading files, scanning dirs, loading skills, viewing
export const Folder01Icon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M1.75 3.75h3.5l1.5 1.5H14.25v7a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-8.5z" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M1.75 6.75h12.5" stroke={color} strokeWidth="1.1" strokeLinecap="round" opacity="0.3" />
  </svg>
);

// 5. Folder creation: scaffolding dirs, project structure
export const FolderAddIcon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M1.75 3.75h3.5l1.5 1.5H14.25v7a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-8.5z" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5.5 9.5h4M7.5 7.5v4" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

// 6. Search: codebase search, listing, analyzing, finding patterns
export const SearchList01Icon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M2.25 4.75h5.5M2.25 8.25h3.5M2.25 11.75h5.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="11.25" cy="7.25" r="2.25" stroke={color} strokeWidth="1.2" />
    <path d="M12.75 8.75l2 2" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

// 7. Web search: searching the web, scraping URLs, deep research
export const WebSearchIcon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <circle cx="6" cy="6" r="4.25" stroke={color} strokeWidth="1.15" />
    <path d="M6 1.75c-1.5 2-1.5 6.5 0 8.5M6 1.75c1.5 2 1.5 6.5 0 8.5" stroke={color} strokeWidth="0.8" opacity="0.6" />
    <line x1="1.75" y1="6" x2="10.25" y2="6" stroke={color} strokeWidth="0.8" opacity="0.6" />
    <circle cx="11.5" cy="11.5" r="2.25" stroke={color} strokeWidth="1.2" fill="#0D0D0D" />
    <path d="M13.25 13.25l1.5 1.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

// 8. Verification: tests, checks, audits, type-checks, safety
export const CheckmarkBadge03Icon = ({ size = 16, color = W }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M8 1.5l1.75 1 2-.25.75 1.85 1.85.75-.25 2 1 1.75-1 1.75.25 2-1.85.75-.75 1.85-2-.25-1.75 1-1.75-1-2 .25-.75-1.85-1.85-.75.25-2-1-1.75 1-1.75-.25-2 1.85-.75.75-1.85 2 .25z" stroke={color} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5.5 8l1.75 1.75 3.25-3.5" stroke={color} strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ── All legacy aliases → same 8 icons (all white) ──────────────────────────
export const ReadIcon            = Folder01Icon;
export const WriteIcon           = FileAddIcon;
export const EditIcon            = FileEditIcon;
export const SearchIcon          = SearchList01Icon;
export const GlobeIcon           = WebSearchIcon;
export const FolderIcon          = Folder01Icon;
export const CodeIcon            = TerminalIcon;
export const GitIcon             = TerminalIcon;
export const ApiIcon             = ComputerIcon;
export const ThinkIcon           = ComputerIcon;
export const ImageIcon           = FileAddIcon;
export const DatabaseIcon        = ComputerIcon;
export const BotIcon             = ComputerIcon;
export const SpinnerIcon         = ComputerIcon;
export const SlackIconPremium    = ComputerIcon;
export const VerifyIcon          = CheckmarkBadge03Icon;
export const PackageIcon         = FolderAddIcon;
export const LightbulbIcon       = SearchList01Icon;
export const MemoryIcon          = Folder01Icon;
export const DesktopIcon         = ComputerIcon;
export const NetworkIcon         = ComputerIcon;
export const ChartIcon           = FileAddIcon;
export const SecurityIcon        = CheckmarkBadge03Icon;

// ── Category → icon map (all white) ────────────────────────────────────────
const CAT_MAP: Record<string, React.FC<IconProps>> = {
  computer:      ComputerIcon,
  terminal:      TerminalIcon,
  file_create:   FileAddIcon,
  file_edit:     FileEditIcon,
  folder_read:   Folder01Icon,
  folder_create: FolderAddIcon,
  search:        SearchList01Icon,
  web_search:    WebSearchIcon,
  verification:  CheckmarkBadge03Icon,
};

// ── Exact tool-label → icon (all white) ────────────────────────────────────
export const AGENT_ICONS: Record<string, { Icon: React.FC<IconProps>; color: string }> = {
  'Running command':         { Icon: TerminalIcon,         color: W },
  'Running project command': { Icon: TerminalIcon,         color: W },
  'Reading file':            { Icon: Folder01Icon,         color: W },
  'Scanning directory':      { Icon: Folder01Icon,         color: W },
  'Editing file':            { Icon: FileEditIcon,         color: W },
  'Writing artifact':        { Icon: FileAddIcon,          color: W },
  'Searching codebase':      { Icon: SearchList01Icon,     color: W },
  'Researching':             { Icon: WebSearchIcon,        color: W },
  'Reading source':          { Icon: WebSearchIcon,        color: W },
  'Deep researching':        { Icon: WebSearchIcon,        color: W },
  'Analyzing code':          { Icon: SearchList01Icon,     color: W },
  'Refactoring code':        { Icon: FileEditIcon,         color: W },
  'Verifying code':          { Icon: CheckmarkBadge03Icon, color: W },
  'Verifying output':        { Icon: CheckmarkBadge03Icon, color: W },
  'Git operation':           { Icon: TerminalIcon,         color: W },
  'Spawning sub-agents':     { Icon: ComputerIcon,         color: W },
  'API request':             { Icon: ComputerIcon,         color: W },
  'API call':                { Icon: ComputerIcon,         color: W },
  'Database query':          { Icon: TerminalIcon,         color: W },
  'Generating image':        { Icon: FileAddIcon,          color: W },
  'Loading skill':           { Icon: Folder01Icon,         color: W },
  'Scaffolding project':     { Icon: FolderAddIcon,        color: W },
  'Slack':                   { Icon: ComputerIcon,         color: W },
  'Sending Slack':           { Icon: ComputerIcon,         color: W },
  'Saving memory':           { Icon: FileAddIcon,          color: W },
  'Reading memory':          { Icon: Folder01Icon,         color: W },
  'Recalling context':       { Icon: Folder01Icon,         color: W },
  'Automating UI':           { Icon: ComputerIcon,         color: W },
  'Controlling desktop':     { Icon: ComputerIcon,         color: W },
  'Syncing network':         { Icon: ComputerIcon,         color: W },
  'Generating chart':        { Icon: FileAddIcon,          color: W },
  'Analyzing data':          { Icon: SearchList01Icon,     color: W },
  'Running safety check':    { Icon: CheckmarkBadge03Icon, color: W },
  'Auditing code':           { Icon: CheckmarkBadge03Icon, color: W },
  'Searching images':        { Icon: SearchList01Icon,     color: W },
  'Previewing UI':           { Icon: ComputerIcon,         color: W },
  'Comparing files':         { Icon: SearchList01Icon,     color: W },
};

// ── Skill name → category ──────────────────────────────────────────────────
const SKILL_CATEGORIES: Record<string, string> = {
  web_artifacts_builder: 'file_create',
  senior_frontend:       'file_edit',
  component_architecture:'file_edit',
  responsive_layout:     'file_edit',
  motion_animations:     'file_edit',
  epic_design:           'file_edit',
  deep_research:         'web_search',
  code_intelligence:     'search',
  smart_refactor:        'file_edit',
  project_scaffolder:    'folder_create',
  auto_docs:             'file_create',
  performance_profiler:  'verification',
  security_auditor:      'verification',
  database_designer:     'computer',
  rag_architect:         'computer',
};

// ── resolveAgentIcon: always returns one of the 8 white icons ──────────────
export const resolveAgentIcon = (
  verb: string,
  rawText?: string,
  iconCategory?: string,
): { Icon: React.FC<IconProps>; color: string } => {

  // 1. Skill-name override
  const checkText = ((verb || '') + ' ' + (rawText || '')).toLowerCase();
  for (const [skill, cat] of Object.entries(SKILL_CATEGORIES)) {
    if (checkText.includes(skill)) { iconCategory = cat; break; }
  }

  // 2. Category direct map (8 exact values)
  if (iconCategory && CAT_MAP[iconCategory]) {
    return { Icon: CAT_MAP[iconCategory], color: W };
  }

  // 3. Exact AGENT_ICONS label match
  const exact = AGENT_ICONS[verb] || (rawText && AGENT_ICONS[rawText]);
  if (exact) return { ...exact, color: W };

  // 4. Fuzzy keyword matching — strip step prefixes first
  let t = checkText.replace(
    /^(?:step\s+\d+[:\s.]*|\[\s*step\s*\d+\s*\]\s*|\(\s*\d+\s*\)\s*|\[\s*\d+(?:\/\d+)?\s*\]\s*|\d+[.:]\s*)/i,
    '',
  );

  if (/verif|test|check|audit|safet|lint/.test(t))                              return { Icon: CheckmarkBadge03Icon, color: W };
  if (/web|brows|scrap|research|http|fetch|url/.test(t))                        return { Icon: WebSearchIcon,        color: W };
  if (/search|scan|analyz|find|list|query|index/.test(t))                       return { Icon: SearchList01Icon,     color: W };
  if (/scaffold|folder.*(creat|write)/.test(t))                                 return { Icon: FolderAddIcon,        color: W };
  if (/read|view|open|folder|memory|remember|context|load|skill/.test(t))       return { Icon: Folder01Icon,         color: W };
  if (/edit|modif|updat|refactor|patch|fix|rewrite/.test(t))                    return { Icon: FileEditIcon,         color: W };
  if (/creat|generat|save|chart|plot|image|write|build|output|artifact/.test(t))return { Icon: FileAddIcon,          color: W };
  if (/terminal|command|shell|exec|run|git|npm|pip|bash|zsh|sh|script|deploy/.test(t)) return { Icon: TerminalIcon, color: W };
  if (/desktop|control|automat|browser|ui/.test(t))                             return { Icon: ComputerIcon,         color: W };

  // 5. Final fallback: terminal (most agent work is command-based)
  return { Icon: TerminalIcon, color: W };
};
