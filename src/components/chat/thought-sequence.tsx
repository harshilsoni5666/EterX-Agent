import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useFilePanelActions } from '../../contexts/FilePanelContext';
// Only the Lucide icons actually rendered in JSX (not icon-map/TOOL_META)
import {
  ChevronRight, ChevronDown, Monitor, ShieldHalf, Copy, CheckCircle, Maximize2
} from 'lucide-react';
// @ts-ignore
import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkPlugins, rehypePlugins } from './markdown-renderer';
import { getConnectorIcon } from '../layout/connectors-modal';
import { AGENT_ICONS, resolveAgentIcon, ComputerIcon } from './agent-icons';
import { AgentFace } from './agent-face';


// Brand connector icons — compact SVGs
const C = ({ d, fill, vb = '0 0 24 24', className }: { d: string, fill: string, vb?: string, className?: string }) => <svg className={className} viewBox={vb} fill={fill}><path d={d} /></svg>;
const SlackIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="#E01E5A"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" /></svg>;
const GitHubIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" /></svg>;
const NotionIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" /></svg>;
const LinearIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M3.275 18.025 13.95 7.35l2.7 2.7L5.975 20.725c-.733-.55-1.37-1.183-1.925-1.925-.25-.333-.517-.65-.775-.775zM14.3 7l2.7 2.7 2.075-2.075a9.6 9.6 0 0 0-2.7-2.7L14.3 7zM3.45 17.3a9.614 9.614 0 0 1-2.7-2.7L12 3.35l2.7 2.7L3.45 17.3zm-1.15.9L3.6 19.5c.1.1.2.2.3.275L2.575 21.1A11.95 11.95 0 0 1 .9 18.2h1.4zm18.7-13.5L5.25 20.45c.55.375 1.175.7 1.75.95L21.95 5.45c-.25-.575-.55-1.2-.95-1.75zm1.1 3.5L7.25 22.05c.725.25 1.5.4 2.3.45L22 8.5c-.05-.8-.2-1.575-.45-2.3z" /></svg>;
const JiraIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.004-1.005zm5.089-5.088H5.143a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057a5.215 5.215 0 0 0 5.213 5.215V7.43a1.005 1.005 0 0 0-1.058-1.005zm5.089-5.088H10.232a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 22.806 13.9V2.342a1.005 1.005 0 0 0-1.057-1.005z" /></svg>;
const FigmaIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M8 24c2.208 0 4-1.792 4-4v-4H8c-2.208 0-4 1.792-4 4s1.792 4 4 4zm0-20H4C1.792 4 0 5.792 0 8s1.792 4 4 4h4V4zm4 0v8h4c2.208 0 4-1.792 4-4s-1.792-4-4-4h-4zm4 16c2.208 0 4-1.792 4-4s-1.792-4-4-4h-4v4c0 2.208 1.792 4 4 4zm-4-8H8c-2.208 0-4 1.792-4 4s1.792 4 4 4h4v-8z" /></svg>;
const DiscordIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.492c-1.53-.69-3.17-1.2-4.885-1.49a.075.075 0 0 0-.079.036c-.21.369-.444.85-.608 1.23a18.566 18.566 0 0 0-5.487 0 12.36 12.36 0 0 0-.617-1.23A.077.077 0 0 0 8.562 3c-1.714.29-3.354.8-4.885 1.491a.07.07 0 0 0-.032.027C.533 9.093-.32 13.555.099 17.961a.08.08 0 0 0 .031.055 20.03 20.03 0 0 0 5.993 2.98.078.078 0 0 0 .084-.026 13.83 13.83 0 0 0 1.226-1.963.074.074 0 0 0-.041-.104 13.175 13.175 0 0 1-1.872-.878.075.075 0 0 1-.008-.125c.126-.093.252-.19.372-.287a.075.075 0 0 1 .078-.01c3.927 1.764 8.18 1.764 12.061 0a.075.075 0 0 1 .079.009c.12.098.245.195.372.288a.075.075 0 0 1-.006.125c-.598.344-1.22.635-1.873.877a.075.075 0 0 0-.041.105c.36.687.772 1.341 1.225 1.962a.077.077 0 0 0 .084.028 19.963 19.963 0 0 0 6.002-2.981.076.076 0 0 0 .032-.054c.5-5.094-.838-9.52-3.549-13.442a.06.06 0 0 0-.031-.028z" /></svg>;
const StripeIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" /></svg>;
const VercelIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M24 22.525H0l12-21.05 12 21.05z" /></svg>;
const AirtableIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M12.006.253l-11.05 4.01c-.654.237-.647 1.16.01 1.388l11.068 3.859a3.93 3.93 0 0 0 2.594 0l11.068-3.86c.657-.227.664-1.15.01-1.387l-11.05-4.01a3.93 3.93 0 0 0-2.65 0zM1.419 10.192a.928.928 0 0 0-.924.928v9.148c0 .512.417.917.924.917a.93.93 0 0 0 .296-.048l10.124-3.506a.928.928 0 0 0 .632-.88V7.604a.928.928 0 0 0-1.22-.88L1.419 10.192zm21.162 0l-10.124-3.504a.928.928 0 0 0-1.22.88V16.75a.928.928 0 0 0 .632.88l10.124 3.506a.928.928 0 0 0 1.22-.88v-9.148a.928.928 0 0 0-.632-.916z" /></svg>;
const PostmanIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M13.527.099C6.955-.744.942 3.9.099 10.473c-.843 6.572 3.8 12.584 10.373 13.428 6.573.843 12.587-3.801 13.428-10.374C24.744 6.955 20.101.943 13.527.099zm2.471 7.507l-4.602 4.6-1.62-1.619 4.602-4.6 1.62 1.619zm-7.803-.123l5.18 5.176-1.034 1.035L6.16 8.518l2.035-1.035zm5.536 8.974l-5.18-5.177 1.035-1.034 5.178 5.177-1.033 1.034zm1.036-1.035l-1.619-1.619 4.602-4.6 1.619 1.619-4.602 4.6z" /></svg>;
const TrelloIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M21 0H3C1.343 0 0 1.343 0 3v18c0 1.656 1.343 3 3 3h18c1.656 0 3-1.344 3-3V3c0-1.657-1.344-3-3-3zm-11.5 17c0 .828-.672 1.5-1.5 1.5H5c-.829 0-1.5-.672-1.5-1.5V5c0-.829.671-1.5 1.5-1.5h3c.828 0 1.5.671 1.5 1.5v12zm10 -6c0 .828-.672 1.5-1.5 1.5H15c-.828 0-1.5-.672-1.5-1.5V5c0-.829.672-1.5 1.5-1.5h3c.828 0 1.5.671 1.5 1.5v6z" /></svg>;
const HubSpotIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M18.164 7.93V5.084a2.198 2.198 0 0 0 1.266-1.978V3.04a2.199 2.199 0 0 0-2.198-2.198h-.066a2.199 2.199 0 0 0-2.198 2.198v.066a2.199 2.199 0 0 0 1.266 1.978V7.93a6.232 6.232 0 0 0-2.963 1.302L4.3 4.066a2.45 2.45 0 1 0-1.285 1.465l10.765 5.126a6.236 6.236 0 0 0-.838 3.144 6.236 6.236 0 0 0 3.144 5.413l-1.52 2.89a1.98 1.98 0 1 0 1.74.91l1.52-2.89a6.272 6.272 0 0 0 2.41.48A6.272 6.272 0 0 0 26 13.8a6.272 6.272 0 0 0-7.836-6.07zm.977 9.8a3.492 3.492 0 1 1 0-6.984 3.492 3.492 0 0 1 0 6.984z" transform="scale(0.92) translate(-0.2, 0)" /></svg>;

// Verb-only lookup — icon is ALWAYS resolved by resolveAgentIcon (8 premium icons)
// No Lucide icons stored here — just past-tense display labels
const VERB_MAP: Record<string, string> = {
  'Running command':         'Ran',
  'Running project command': 'Ran',
  'Reading file':            'Read',
  'Scanning directory':      'Listed',
  'Editing file':            'Edited',
  'Writing artifact':        'Created',
  'Searching codebase':      'Searched',
  'Researching':             'Web searched',
  'Reading source':          'Scraped',
  'Deep researching':        'Researched',
  'Analyzing code':          'Analyzed',
  'Refactoring code':        'Refactored',
  'Analyzing workspace':     'Analyzed',
  'Analyzing files':         'Analyzed',
  'Verifying code':          'Verified',
  'Verifying output':        'Verified',
  'Scaffolding project':     'Scaffolded',
  'Git operation':           'Git',
  'Spawning sub-agents':     'Spawned',
  'Decomposing task':        'Decomposed',
  'Loading skill':           'Loaded',
  'API request':             'Called API',
  'API call':                'Called API',
  'Network operation':       'Network',
  'Reading PDF':             'Read PDF',
  'Generating document':     'Generated',
  'Generating image':        'Generated',
  'Generating docs':         'Generated docs',
  'Generating chart':        'Generated',
  'Generating speech':       'Generated',
  'Capturing screen':        'Captured',
  'Evaluating logic':        'Evaluated',
  'Monitoring system':       'Monitored',
  'Managing email':          'Email',
  'Comparing files':         'Compared',
  'Transforming data':       'Transformed',
  'Compressing files':       'Compressed',
  'Database query':          'Queried',
  'Calculating':             'Calculated',
  'Analyzing data':          'Analyzed',
  'Clipboard':               'Clipboard',
  'Extracting transcript':   'Extracted',
  'Reading RSS feed':        'Read feed',
  'WhatsApp':                'WhatsApp',
  'Telegram':                'Telegram',
  'Slack':                   'Slack',
  'Sending Slack':           'Slack',
  'Slack message':           'Slack',
  'GitHub':                  'GitHub',
  'GitHub push':             'Pushed',
  'GitHub PR':               'Pull Request',
  'GitHub issue':            'Issue',
  'Notion':                  'Notion',
  'Notion page':             'Notion',
  'Linear':                  'Linear',
  'Linear issue':            'Linear',
  'Jira':                    'Jira',
  'Jira issue':              'Jira',
  'Figma':                   'Figma',
  'Discord':                 'Discord',
  'Discord message':         'Discord',
  'Stripe':                  'Stripe',
  'Vercel':                  'Vercel',
  'Airtable':                'Airtable',
  'Postman':                 'Postman',
  'Trello':                  'Trello',
  'HubSpot':                 'HubSpot',
  'Safety check':            'Checked',
  'Context operation':       'Context',
  'Saving progress':         'Saved',
  'Background task':         'Background',
  'Creating tool':           'Created tool',
  'Converting markdown':     'Converted',
  'System automation':       'Automated',
  'Managing process':        'Process',
  'HTTP server':             'Server',
  'Processing text':         'Processed',
  'Notifying':               'Notified',
  'Running macro':           'Ran macro',
  'Executing chain':         'Executed',
  'Self-improving':          'Improved',
  'Watching files':          'Watching',
  'Vault operation':         'Vault',
  'Managing environment':    'Env',
  'Scheduled task':          'Scheduled',
};

// getToolMeta — verb extraction only; icon is always resolved by resolveAgentIcon
const getToolMeta = (text: string, type: string, _iconName?: string) => {
  const verb = VERB_MAP[text] || text || 'Action';
  return { icon: null, verb, color: '#E8E6E3' };
};

const displayedTextRegistry = new Map<string, number>();

// No typewriter — show full text immediately for zero-latency reading
const useTypewriter = (targetText: string, _isActive: boolean) => {
  return { displayedText: targetText };
};

// Live-second counter — startRef is null until first live tick, so elapsed is always real
const useThinkTimer = (isLive: boolean) => {
  const [secs, setSecs] = useState(0);
  const startRef = useRef<number | null>(null);   // null until isLive first fires
  const frozenRef = useRef<number | null>(null);  // set once when isLive goes false

  useEffect(() => {
    if (isLive) {
      // Always reset on new live session
      startRef.current = Date.now();
      frozenRef.current = null;
      setSecs(0);
      const id = setInterval(() => {
        setSecs(Math.floor((Date.now() - startRef.current!) / 1000));
      }, 1000);
      return () => clearInterval(id); // stops interval immediately when isLive → false
    } else {
      // Freeze exactly once when thinking ends
      if (startRef.current !== null && frozenRef.current === null) {
        frozenRef.current = Math.floor((Date.now() - startRef.current) / 1000);
        setSecs(frozenRef.current);
      }
    }
  }, [isLive]);

  // Always return the frozen value if available (never re-tick after done)
  return frozenRef.current !== null ? frozenRef.current : secs;
};

export const ProfessionalThought = ({ text, isLatest, isThinking, variant = 'thought', suffix }: { text: string, isLatest: boolean, isThinking: boolean, variant?: 'thought' | 'answer' | 'note', suffix?: React.ReactNode }) => {
  const [open, setOpen] = useState(false);
  const isLive = isLatest && isThinking;
  const secs = useThinkTimer(isLive);

  const renderText = useMemo(() => {
    if (!text) return '';
    let f = text.replace(/!\[.*?\]\(\/absolute.*?\.png\)/gi, '').replace(/<\/?thought>/gi, '');
    f = f.replace(/([^\n])(#{1,6}\s)/g, '$1\n\n$2').replace(/([.!?:])(\s*\n)(#{1,6}\s)/g, '$1\n\n$3');
    return f.trim();
  }, [text]);

  // "Thinking... 4s" while live → "Thought for 4s" when done
  const thinkLabel = isLive
    ? `Thinking... ${secs}s`
    : secs > 0
      ? `Thought for ${secs}s`
      : 'Thought';

  if (variant === 'thought') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="professional-thought w-full"
      >
        <div className={`overflow-hidden rounded-[14px] border bg-[#161616]/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_2px_12px_rgba(0,0,0,0.18)] transition-colors ${ open ? 'border-white/[0.14]' : 'border-white/[0.08] hover:border-white/[0.14]' }`}>
          <button
            onClick={() => setOpen(!open)}
            className="flex min-h-[42px] w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors hover:bg-white/[0.03] group"
          >
            <span className={`flex-1 text-[14.5px] font-semibold ${ isLive ? 'text-[#A0A0A0] eterx-live-text' : 'text-[#6B6966]' }`}>
              {thinkLabel}
            </span>
            <ChevronRight className={`h-4 w-4 text-[#5E5A55] group-hover:text-[#A3A19E] transition-all ${ open ? 'rotate-90' : '' }`} />
          </button>
          <AnimatePresence initial={false}>
            {open && renderText && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="eterx-action-scroll pl-[59px] pr-5 pb-5 pt-1 text-[14px] leading-[1.72] text-[#A8A5A0] overflow-y-auto" style={{ maxHeight: '320px' }}>
                  <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{
                    ...markdownComponents,
                    p: ({ node, ...props }: any) => <p className="mb-3.5 last:mb-0 break-words leading-[1.72] text-[#A8A5A0]" {...props} />,
                    ol: ({ node, ...props }: any) => <ol className="my-3.5 list-decimal space-y-3 pl-6 text-[#A8A5A0]" {...props} />,
                    ul: ({ node, ...props }: any) => <ul className="my-3.5 list-disc space-y-3 pl-6 text-[#A8A5A0]" {...props} />,
                    li: ({ node, ...props }: any) => <li className="pl-2 leading-[1.7] marker:text-[#807D78]" {...props} />,
                    strong: ({ node, ...props }: any) => <strong className="font-semibold text-[#C4C1BC]" {...props} />,
                    a: ({ node, ...props }: any) => <a className="text-[#E2765A] hover:underline" target="_blank" rel="noopener" {...props} />,
                  }}>{renderText}</ReactMarkdown>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    );
  }

  const isNote = variant === 'note';

  return (
    <motion.div
      layout
      initial={isNote ? { opacity: 0, y: 4 } : false}
      animate={isNote ? { opacity: 1, y: 0 } : undefined}
      transition={isNote ? { duration: 0.2, ease: [0.22, 1, 0.36, 1] } : undefined}
      className={`professional-thought relative w-full max-w-full font-sans font-normal selection:bg-[#E2765A]/20 select-text tracking-normal ${ isNote ? 'py-1 text-[15.5px] leading-[1.62] text-[#B6B2AB]' : 'text-[15.5px] leading-[1.78] text-[#C4C1BC]' }`}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{
        ...markdownComponents,
        p: ({ node, ...props }: any) => <p className={`mb-1.5 last:mb-0 break-words tracking-normal ${ isNote ? 'leading-[1.62] text-[#B6B2AB]' : 'leading-[1.78] text-[#C4C1BC]' }`} {...props} />,
        h1: ({ node, ...props }: any) => <h1 className="mt-0 mb-4 text-[24px] font-bold leading-tight text-[#C4C1BC]" {...props} />,
        h2: ({ node, ...props }: any) => <h2 className="mt-0 mb-3 text-[20px] font-bold leading-tight text-[#C4C1BC]" {...props} />,
        h3: ({ node, ...props }: any) => <h3 className="mt-0 mb-3 text-[17px] font-bold leading-tight text-[#C4C1BC]" {...props} />,
        h4: ({ node, ...props }: any) => <h4 className="mt-0 mb-2 text-[15px] font-semibold leading-tight text-[#C4C1BC]" {...props} />,
        strong: ({ node, ...props }: any) => <strong className="font-semibold text-[#D0CDC7]" {...props} />,
        a: ({ node, ...props }: any) => <a className="text-[#E2765A] hover:underline" target="_blank" rel="noopener" {...props} />,
      }}>{renderText}</ReactMarkdown>
      {suffix}
      <style>{`
        .professional-thought > :first-child { margin-top: 0 !important; }
        .professional-thought > p:last-child { display: inline; }
      `}</style>
    </motion.div>
  );
};

// VS Code GitHub Dark — clean single-pass syntax highlighter
const highlightSyntax = (code: string): string => {
  if (!code) return '';
  const KW_FLOW = new Set(['if', 'else', 'elif', 'for', 'while', 'switch', 'case', 'break', 'continue', 'return', 'try', 'catch', 'finally', 'throw', 'raise', 'with', 'match', 'do']);
  const KW_DECL = new Set(['const', 'let', 'var', 'function', 'class', 'async', 'await', 'import', 'export', 'from', 'as', 'type', 'interface', 'enum', 'extends', 'implements', 'static', 'abstract', 'override', 'def', 'lambda', 'pass', 'yield', 'del', 'require', 'fn', 'pub', 'use', 'struct']);
  const KW_VAL = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'NaN', 'Infinity', 'void']);
  const KW_THIS = new Set(['this', 'self', 'super', 'new', 'typeof', 'instanceof', 'in', 'of', 'is', 'not', 'and', 'or', 'delete', 'readonly', 'keyof', 'number', 'string', 'boolean', 'object', 'any', 'never']);
  const e = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const TOKEN = /(\/\/[^\n]*|#[^!\n][^\n]*|\/\*[\s\S]*?\*\/)|(["'`])(?:(?!\2)[^\\]|\\.)*\2|(0x[0-9A-Fa-f]+|\b\d+\.?\d*(?:e[+-]?\d+)?\b)|([A-Z][a-zA-Z0-9_]*)|([a-z_][a-zA-Z0-9_]*)|(--?[a-zA-Z][a-zA-Z0-9-]*)/g;
  let out = '', last = 0;
  for (const m of e.matchAll(TOKEN)) {
    const [full, cmt, , num, pascal, ident, flag] = m;
    out += e.slice(last, m.index!); last = m.index! + full.length;
    if (cmt) out += `<span style="color:#6E7681;font-style:italic">${ full }</span>`;
    else if (m[2]) out += `<span style="color:#A5D6FF">${ full }</span>`;
    else if (num) out += `<span style="color:#79B8FF">${ full }</span>`;
    else if (pascal) out += `<span style="color:#FFA657">${ full }</span>`;
    else if (ident) {
      if (KW_FLOW.has(ident)) out += `<span style="color:#FF7B72">${ full }</span>`;
      else if (KW_DECL.has(ident)) out += `<span style="color:#FF7B72;font-weight:600">${ full }</span>`;
      else if (KW_VAL.has(ident)) out += `<span style="color:#79C0FF">${ full }</span>`;
      else if (KW_THIS.has(ident)) out += `<span style="color:#79C0FF">${ full }</span>`;
      else out += e.slice(last).trimStart().startsWith('(') ? `<span style="color:#D2A8FF">${ full }</span>` : full;
    }
    else if (flag) out += `<span style="color:#56D364">${ full }</span>`;
    else out += full;
  }
  return out + e.slice(last);
};

const FullScreenModal = ({ onClose, children, title }: { onClose: () => void, children: React.ReactNode, title?: string }) => {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h); document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', h); document.body.style.overflow = ''; };
  }, [onClose]);
  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[99999] flex flex-col bg-[#060606]/98 backdrop-blur-xl">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5"><span className="text-[13px] font-mono text-[#8C8A88] font-bold uppercase tracking-widest">{title || 'Preview'}</span><button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-white/5 text-[#8C8A88] hover:text-white transition-all text-xl">×</button></div>
      <div className="flex-1 overflow-hidden">{children}</div>
    </motion.div>, document.body
  );
};

const CopyButton = ({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false);
  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = content;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };
  return (
    <button onClick={handle} className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[#555350] hover:text-[#8C8A88] transition-all flex items-center gap-1.5 border border-white/5">
      {copied ? <CheckCircle className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
      <span className="text-[10px] font-mono uppercase tracking-tighter">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
};

// Converts ANSI escape codes to styled HTML spans
const ansiToHtml = (text: string): string => {
  if (!text) return '';
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ANSI: Record<string, string> = {
    '0': '', '1': 'font-weight:700', '31': 'color:#f85149', '32': 'color:#3fb950',
    '33': 'color:#d29922', '34': 'color:#58a6ff', '35': 'color:#bc8cff',
    '36': 'color:#56d364', '37': 'color:#e6edf3', '90': 'color:#8b949e',
    '91': 'color:#ffa198', '92': 'color:#56d364', '93': 'color:#e3b341',
    '94': 'color:#79c0ff', '95': 'color:#d2a8ff', '96': 'color:#76e3ea',
  };
  return esc.replace(/\x1B\[([0-9;]*)m/g, (_, p) => {
    const style = p.split(';').map((c: string) => ANSI[c] || '').filter(Boolean).join(';');
    return style ? `<span style="${ style }">` : '</span>';
  });
};

const InlineConsole = ({ command, content, exitCode, durationMs }: { command: string, content: string, exitCode?: number, durationMs?: number }) => {
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [content]);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 20);
  };
  const lines = (content || '').split('\n');
  const success = exitCode === 0 || exitCode === undefined;
  const C = () => (
    <div className={`flex flex-col h-full bg-[#0D0D0D] font-mono ${ full ? '' : 'rounded-xl border border-white/[0.07] overflow-hidden ml-5 mt-2 mb-2' }`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#161616] border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <svg className="w-3.5 h-3.5 text-[#555350]" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M4 6l2.5 2L4 10" /><path d="M9 10h3" />
          </svg>
          <span className="text-[11px] text-[#555350] font-bold uppercase tracking-widest">Terminal</span>
        </div>
        <div className="flex items-center gap-2">
          {exitCode !== undefined && (
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${ success ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20' }`}>
              {success ? '✓ exit 0' : `✗ exit ${ exitCode }`}
            </span>
          )}
          {durationMs !== undefined && <span className="text-[10px] text-[#555350] font-mono">{durationMs < 1000 ? `${ durationMs }ms` : `${ (durationMs / 1000).toFixed(1) }s`}</span>}
          <span className="text-[10px] text-[#555350] font-mono">{lines.length} lines</span>
          <CopyButton content={content} />
          {!full && <button onClick={(e) => { e.stopPropagation(); setFull(true); }} className="p-1 text-[#555350] hover:text-[#8C8A88]"><Maximize2 className="w-3 h-3" /></button>}
        </div>
      </div>
      {/* Command line */}
      <div className="flex items-center gap-3 px-4 py-2 bg-[#111] border-b border-white/[0.04]">
        <span className="text-emerald-400 font-bold shrink-0">$</span>
        <span className="text-[13px] text-[#C8C6C3] break-all">{command}</span>
      </div>
      {/* Output */}
      <div className="relative">
        <div ref={scrollRef} onScroll={handleScroll} className={`px-4 py-3 overflow-y-auto custom-scrollbar text-[12.5px] leading-relaxed whitespace-pre-wrap ${ full ? 'flex-1' : 'max-h-[280px]' }`}>
          {content
            ? <span dangerouslySetInnerHTML={{ __html: ansiToHtml(content) }} />
            : <span className="text-[#555350] italic">(no output)</span>
          }
        </div>
        {!atBottom && lines.length > 8 && (
          <button onClick={(e) => { e.stopPropagation(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }} className="absolute bottom-2 right-2 w-6 h-6 flex items-center justify-center rounded-full bg-[#1C1C1E] border border-white/10 text-[#8C8A88] hover:text-white transition-all">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title="Terminal"><C /></FullScreenModal> : <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}><C /></motion.div>}</>;
};

const InlineDiffView = ({ filename, diffLines }: { filename: string, diffLines: any[] }) => {
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(false);
  const added = diffLines.filter(l => l.type === 'added').length;
  const removed = diffLines.filter(l => l.type === 'removed').length;
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 20);
  };
  const C = () => (
    <div className={`flex flex-col bg-[#080808] font-mono ${ full ? 'h-full' : 'rounded-xl border border-white/[0.07] overflow-hidden ml-5 mt-2 mb-2' }`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-[#0E0E0E] border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] font-semibold text-[#C8C6C3]">{filename}</span>
          {added > 0 && <span className="text-[11px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">+{added}</span>}
          {removed > 0 && <span className="text-[11px] font-mono font-bold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">-{removed}</span>}
        </div>
        <div className="flex items-center gap-1">
          <CopyButton content={diffLines.filter(l => l.type !== 'removed').map(l => l.content).join('\n')} />
          {!full && <button onClick={(e) => { e.stopPropagation(); setFull(true); }} className="p-1 text-[#555350] hover:text-[#8C8A88]"><Maximize2 className="w-3 h-3" /></button>}
        </div>
      </div>
      {/* Single unified scroll container — horizontal + vertical together */}
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`overflow-x-auto overflow-y-auto custom-scrollbar text-[12.5px] leading-5 ${ full ? 'flex-1 h-[calc(100vh-60px)]' : 'max-h-[340px]' }`}
        >
          {/* Inner container expands to content width — all lines share same horizontal scroll */}
          <div style={{ minWidth: 'max-content' }}>
            {diffLines.map((l, i) => {
              const isAdd = l.type === 'added';
              const isDel = l.type === 'removed';
              return (
                <div key={i} className={`flex items-stretch ${ isAdd ? 'bg-[#0d2010]' : isDel ? 'bg-[#200d0d]' : 'hover:bg-white/[0.02]'
                  }`}>
                  {/* Left colored bar */}
                  <div className={`w-[3px] shrink-0 ${ isAdd ? 'bg-emerald-500' : isDel ? 'bg-red-500' : 'bg-transparent'
                    }`} />
                  {/* Line number */}
                  <div className="w-[40px] shrink-0 text-right pr-3 select-none text-[10px] py-[3px] text-[#555350] border-r border-white/[0.06]">{l.newLine || (isDel ? l.oldLine : '')}</div>
                  {/* +/- glyph */}
                  <div className={`w-[20px] shrink-0 text-center py-[3px] font-bold ${ isAdd ? 'text-emerald-400' : isDel ? 'text-red-400' : 'text-transparent'
                    }`}>{isAdd ? '+' : isDel ? '-' : ' '}</div>
                  {/* Content — no overflow, parent scrolls */}
                  <div
                    className={`px-3 py-[3px] whitespace-pre ${ isAdd ? 'text-[#aeffc0]' : isDel ? 'text-[#ffb3b3]' : 'text-[#8b949e]'
                      }`}
                    dangerouslySetInnerHTML={{ __html: highlightSyntax(l.content) }}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {!atBottom && diffLines.length > 10 && (
          <button
            onClick={(e) => { e.stopPropagation(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-2 right-2 w-6 h-6 flex items-center justify-center rounded-full bg-[#1C1C1E] border border-white/10 text-[#8C8A88] hover:text-white transition-all"
          ><ChevronDown className="w-3.5 h-3.5" /></button>
        )}
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title={`Diff: ${ filename }`}><C /></FullScreenModal> : <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}><C /></motion.div>}</>;
};

const InlineCodeView = ({ filename, content }: { filename: string, content: string }) => {
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(false);
  const lines = useMemo(() => (content || '').split('\n'), [content]);
  const lineCount = lines.length;
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 20);
  };
  const C = () => (
    <div className={`flex flex-col bg-[#080808] font-mono ${ full ? 'h-full' : 'rounded-xl border border-white/[0.07] overflow-hidden ml-5 mt-2 mb-2' }`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-[#0E0E0E] border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] font-semibold text-[#C8C6C3]">{filename}</span>
          <span className="text-[10px] text-[#555350] font-mono">{lineCount} lines</span>
        </div>
        <div className="flex items-center gap-1">
          <CopyButton content={content} />
          {!full && <button onClick={(e) => { e.stopPropagation(); setFull(true); }} className="p-1 text-[#555350] hover:text-[#8C8A88]"><Maximize2 className="w-3 h-3" /></button>}
        </div>
      </div>
      {/* Single unified scroll container */}
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`overflow-x-auto overflow-y-auto custom-scrollbar text-[12.5px] leading-5 ${ full ? 'h-[calc(100vh-60px)]' : 'max-h-[340px]' }`}
        >
          {/* Inner div expands to content width — all lines share the same horizontal scroll */}
          <div style={{ minWidth: 'max-content' }}>
            {lines.map((l, i) => (
              <div key={i} className="flex items-stretch hover:bg-white/[0.025] group">
                {/* Line number — sticky left via position (plain div, no overflow) */}
                <div className="w-[44px] shrink-0 text-right pr-3 select-none text-[11px] py-[3px] text-[#555350] group-hover:text-[#8C8A88] border-r border-white/[0.06] transition-colors">{i + 1}</div>
                {/* Content — whitespace-pre, no per-line overflow */}
                <div
                  className="px-4 py-[3px] whitespace-pre text-[#8b949e]"
                  dangerouslySetInnerHTML={{ __html: highlightSyntax(l) }}
                />
              </div>
            ))}
          </div>
        </div>
        {!atBottom && lineCount > 10 && (
          <button
            onClick={(e) => { e.stopPropagation(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-2 right-2 w-6 h-6 flex items-center justify-center rounded-full bg-[#1C1C1E] border border-white/10 text-[#8C8A88] hover:text-white transition-all"
          ><ChevronDown className="w-3.5 h-3.5" /></button>
        )}
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title={`File: ${ filename }`}><C /></FullScreenModal> : <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}><C /></motion.div>}</>;
};

// ─── Single row inside a tool card ──────────────────────────────────────────
const ActionChip = ({
  log, isLastChip, isActiveGroup, allLogs,
  isNested = false, inCard = false
}: {
  log: any, isLastChip: boolean, isActiveGroup: boolean, allLogs: any[],
  isNested?: boolean, inCard?: boolean
}) => {
  const isLiveChip = isActiveGroup && isLastChip;
  const isEdit = log.type === 'file_edit';
  const { openPanel } = useFilePanelActions();
  // Determine the filename to show as a blue link
  const rawPath = log.filename && log.filename !== 'system' ? log.filename : '';
  const fileName = rawPath.split(/[\\/]/).pop() || '';
  const hasFile = !!fileName && fileName !== 'system';
  // Subtitle: the secondary arg (command string, URL, query, etc.)
  const subtitle = log.secondary && log.secondary !== log.filename ? String(log.secondary).substring(0, 120) : '';
  const preview = useMemo(() => {
    const myIdx = allLogs.indexOf(log);
    const searchLogs = myIdx !== -1 ? allLogs.slice(myIdx) : allLogs;
    if (log.type === 'command') {
      const cmd = String(log.secondary || '').trim();
      return searchLogs.find((l: any) => l.type === 'console_output' && String(l.command || '').includes(cmd.substring(0, 20))) || null;
    }
    if (isEdit) {
      return searchLogs.find((l: any) => l.type === 'file_preview' && String(l.filename || '').includes(fileName)) || null;
    }
    if (log.type === 'exploration' && (log.text === 'Reading file' || log.text?.toLowerCase().includes('read'))) {
      return searchLogs.find((l: any) => l.type === 'file_preview' && String(l.filename || '').includes(fileName)) || null;
    }
    return null;
  }, [allLogs, isEdit, log, fileName]);
  const [isExpanded, setIsExpanded] = useState(false);
  // Resolve the full path for IDE link
  const fullPath = rawPath || preview?.filepath || '';
  // Past-tense verb for display; live overrides to present tense below
  const meta = useMemo(() => {
    if (isEdit && preview) return {
      icon: null,
      verbDone: preview.isEdit ? 'Edited' : 'Created',
      verbLive: preview.isEdit ? 'Editing' : 'Creating',
      color: '#E8E6E3',
    };
    if (isEdit && !preview) {
      const lowerText = String(log.text || '').toLowerCase();
      const isCreate = lowerText.includes('created') || lowerText.includes('writing') || lowerText.includes('artifact');
      return { icon: null, verbDone: isCreate ? 'Created' : 'Edited', verbLive: isCreate ? 'Creating' : 'Editing', color: '#E8E6E3' };
    }
    const base = getToolMeta(log.text, log.type, log.icon);
    // Map past-tense verbs → live present-tense
    const LIVE_VERBS: Record<string, string> = {
      'Ran': 'Running', 'Read': 'Reading', 'Listed': 'Listing',
      'Edited': 'Editing', 'Created': 'Creating', 'Searched': 'Searching',
      'Web searched': 'Web searching', 'Scraped': 'Scraping',
      'Researched': 'Researching', 'Analyzed': 'Analyzing',
      'Refactored': 'Refactoring', 'Verified': 'Verifying',
      'Scaffolded': 'Scaffolding', 'Loaded': 'Loading',
      'Called API': 'Calling API', 'Generated': 'Generating',
      'Queried': 'Querying', 'Comparing': 'Compared',
    };
    return { ...base, verbDone: base.verb, verbLive: LIVE_VERBS[base.verb] || base.verb };
  }, [isEdit, log.text, log.type, log.icon, preview]);
  const displayVerb = isLiveChip ? (meta.verbLive || meta.verbDone) : (meta.verbDone || (meta as any).verb);
  const hasDetail = hasFile || !!subtitle;
  // Open a file into the IDE panel
  const openInIde = (e: React.MouseEvent, mode?: 'preview') => {
    e.stopPropagation();
    if (!fullPath) return;
    const isHtml = /\.(html|htm)$/i.test(fullPath);
    openPanel({
      filename: fileName,
      filepath: fullPath,
      content: preview?.content || '',
      diffLines: preview?.diffLines,
      isEdit: preview?.isEdit || isEdit,
    });
  };

  // Think chips: no icon, just label
  const isThinkChip = log.text === 'Think' || log.type === 'think';

  return (
    <div className="w-full">
      <div
        onClick={() => preview && setIsExpanded(!isExpanded)}
        className={`flex min-h-[42px] items-center gap-2.5 px-2.5 py-1.5 transition-colors group ${ inCard ? 'rounded-none border-0 bg-transparent hover:bg-white/[0.04]' : preview ? 'cursor-pointer rounded-[14px] border border-white/[0.08] bg-[#161616]/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:bg-[#1C1C1C]/92 hover:border-white/[0.14]' : 'cursor-default rounded-[14px] hover:bg-white/[0.03]' } ${ preview ? 'cursor-pointer' : 'cursor-default' }`}
      >
        {inCard ? <div className="w-0 shrink-0" /> : <div className="w-1 shrink-0" />}
        {!isThinkChip && (() => {
          // Always use the 8 premium white icons via resolveAgentIcon
          const agentEntry = resolveAgentIcon(displayVerb, log.text, log.iconCategory);
          const { Icon: AI, color: ac } = agentEntry;
          return <span className="flex h-7 w-7 items-center justify-center shrink-0"><AI isLive={isLiveChip} size={18} color={isLiveChip ? ac : '#6B6966'} /></span>;
        })()}
        {isThinkChip && <div className="w-1 shrink-0" />}
        <span className={`shrink-0 truncate text-[14.5px] font-semibold leading-tight tracking-normal ${isLiveChip ? 'eterx-live-text' : 'text-[#A7A39E]'}`}>{displayVerb}</span>
        {hasDetail && <span className="shrink-0 text-[#403D39] text-[13px] font-light select-none px-0.5">|</span>}
        {hasFile && (
          <span
            onClick={(e) => openInIde(e)}
            className="min-w-0 truncate font-mono text-[13.5px] leading-tight cursor-pointer hover:underline text-[#4A9CD0]"
          >{fileName}</span>
        )}
        {!hasFile && subtitle && (
          <span className="min-w-0 truncate font-mono text-[13.5px] leading-tight text-[#605D59]">{subtitle}</span>
        )}
        {hasFile && fullPath.toLowerCase().match(/\.(html|htm)$/) && (
          <button
            onClick={(e) => { e.stopPropagation(); openPanel({ filename: fileName, filepath: fullPath, content: preview?.content || '' }); }}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] uppercase font-bold text-[#555350] hover:text-[#4FC1FF] bg-white/5 hover:bg-[#4FC1FF]/10 transition-all border border-white/5 shrink-0"
          ><Monitor className="w-2.5 h-2.5" /> Preview</button>
        )}
        <span className="ml-auto flex shrink-0 items-center justify-end gap-2 pl-3">
          {!isActiveGroup && fullPath && !fullPath.toLowerCase().match(/\.(html|htm)$/) && (
            <button
              onClick={(e) => openInIde(e)}
              className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-[#5D5954] hover:border-[#4FC1FF]/20 hover:bg-[#4FC1FF]/10 hover:text-[#4FC1FF]"
            >IDE</button>
          )}
          <ChevronRight className={`h-4 w-4 shrink-0 transition-all ${preview && isExpanded ? 'rotate-90 text-[#B3B0AA]' : 'text-[#625E58]'} group-hover:translate-x-0.5 group-hover:text-[#B3B0AA]`} />
        </span>
      </div>
      <AnimatePresence>{isExpanded && preview && (
        <div className="w-full">
          {preview.type === 'console_output'
            ? <InlineConsole command={preview.command || subtitle} content={preview.output || preview.content} exitCode={preview.exitCode} durationMs={preview.durationMs} />
            : preview.type === 'file_preview' && preview.isEdit
              ? <InlineDiffView filename={preview.filename || fileName} diffLines={preview.diffLines} />
              : preview.type === 'file_preview'
                ? <InlineCodeView filename={preview.filename || fileName} content={preview.content} />
                : null}
        </div>
      )}</AnimatePresence>
    </div>
  );
};

// Sub-agent answer card
const SubAgentCard = ({ log }: { log: any }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="ml-1 my-1.5 overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex min-h-[42px] items-center gap-3 rounded-[12px] px-2.5 py-1.5 hover:bg-white/[0.035] transition-colors group">
        <span className="flex h-8 w-8 items-center justify-center shrink-0">
          <ComputerIcon size={19} color="#E8E6E3" />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[15px] font-semibold tracking-normal text-[#A7A39E]">{log.agentName || log.secondary || 'Sub-agent result'}</span>
          <span className="block truncate text-[12px] font-medium text-[#625E59]">{log.durationMs ? `${ Math.round(log.durationMs / 1000) }s` : 'Parallel worker output'}</span>
        </span>
        {log.status === 'done' && <span className="text-[11px] font-medium text-emerald-400/80">Done</span>}
        {log.status === 'error' && <span className="text-[11px] font-medium text-red-400/80">Error</span>}
        <ChevronRight className={`h-3.5 w-3.5 text-[#555350] group-hover:text-[#A3A19E] transition-all ${ open ? 'rotate-90' : '' }`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
            <div className="ml-6 border-l border-white/[0.055] pl-4 pb-3 pt-1 text-[12.5px] text-[#8b949e] leading-relaxed whitespace-pre-wrap font-mono max-h-[300px] overflow-y-auto custom-scrollbar">
              {log.result || log.content || log.text || '(no result)'}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Safety warning banner
const SafetyBanner = ({ log }: { log: any }) => (
  <div className="flex items-start gap-2.5 px-3 py-2.5 my-1 rounded-lg bg-red-500/5 border border-red-500/20">
    <ShieldHalf className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
    <div>
      <span className="text-[11px] font-bold text-red-400 uppercase tracking-widest block mb-0.5">Safety Warning</span>
      <span className="text-[12.5px] text-[#f5b5b5]">{log.text || log.secondary}</span>
    </div>
  </div>
);

// ─── Card containing one or more tool rows ────────────────────────────────────
const CollapsibleActionGroup = ({
  logs, isActiveGroup, isLast, allLogs
}: {
  logs: any[], isActiveGroup: boolean, isLast: boolean, allLogs: any[]
}) => {
  const visibleLogs = logs.filter(Boolean);
  if (visibleLogs.length === 0) return null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="w-full overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#1A1A1A]/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_16px_rgba(0,0,0,0.22)]"
    >
      {visibleLogs.map((log, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.18, delay: i * 0.06, ease: 'easeOut' }}
          className={i > 0 ? 'border-t border-white/[0.055]' : ''}
        >
          <ActionChip
            log={log}
            isLastChip={isLast && i === visibleLogs.length - 1}
            isActiveGroup={isActiveGroup}
            allLogs={allLogs}
            isNested={i > 0}
            inCard
          />
        </motion.div>
      ))}
    </motion.div>
  );
};

// Live working indicator — real-time log-state-connected
// 3 modes: thinking (thought_stream/work_note last), acting (real action last), idle (between)

const THINKING_PHRASES = [
  { text: 'Synthesizing deep context', dur: 4500 },
  { text: 'Mapping cognitive pathways', dur: 5000 },
  { text: 'Evaluating strategic branches', dur: 4000 },
  { text: 'Analyzing dimensional constraints', dur: 5500 },
  { text: 'Processing neural embeddings', dur: 4800 },
  { text: 'Cross-referencing active memory', dur: 5200 },
];

const IDLE_PHRASES = [
  { text: 'Structuring next sequence', dur: 4000 },
  { text: 'Awaiting tool resolution', dur: 4500 },
  { text: 'Calibrating local vectors', dur: 5000 },
  { text: 'Validating stream integrity', dur: 3800 },
  { text: 'Synchronizing state', dur: 4200 },
];

const DEFAULT_LIVE_PHRASE = { text: 'Computing execution flow', dur: 4500 };

function makeShuffledQueue<T>(arr: T[], exclude?: T): T[] {
  const source = arr.length > 0 ? arr : [DEFAULT_LIVE_PHRASE as T];
  const filtered = exclude !== undefined ? source.filter(x => x !== exclude) : [...source];
  const pool = filtered.length > 0 ? filtered : [...source];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

const LiveWorkingIndicator = ({ logs }: { logs: any[] }) => {
  // Derive real-time state from the last log
  const getLogState = (ls: any[]): { mode: 'thinking' | 'acting' | 'idle'; label: string | null } => {
    if (ls.length === 0) return { mode: 'thinking', label: null };
    const last = ls[ls.length - 1];
    if (last.type === 'thought_stream' || last.type === 'work_note') return { mode: 'thinking', label: null };
    if (['command', 'exploration', 'file_edit', 'communication', 'progress', 'browser'].includes(last.type)) {
      const meta = getToolMeta(last.text, last.type, last.icon);
      const fileName = (last.filename || '').split(/[\\/]/).pop() || '';
      const label = fileName ? `${ meta.verb } ${ fileName }` : (meta.verb || null);
      return { mode: 'acting', label };
    }
    return { mode: 'idle', label: null };
  };

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef<'thinking' | 'acting' | 'idle'>('idle');
  const queueRef = useRef<{ text: string; dur: number }[]>([]);
  const lastLabelRef = useRef<string>('');

  const [label, setLabel] = useState<string>(() => {
    const s = getLogState(logs);
    return s.label || (s.mode === 'thinking' ? THINKING_PHRASES[0].text : IDLE_PHRASES[0].text);
  });
  const [flip, setFlip] = useState(false);

  const doTransition = (nextText: string, nextDur: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setFlip(true);
    setTimeout(() => {
      setLabel(nextText);
      lastLabelRef.current = nextText;
      setFlip(false);
    }, 260);
    timerRef.current = setTimeout(() => advancePhrase(modeRef.current), nextDur);
  };

  const advancePhrase = (mode: 'thinking' | 'acting' | 'idle') => {
    const pool = mode === 'thinking' ? THINKING_PHRASES : IDLE_PHRASES;
    if (queueRef.current.length === 0) {
      queueRef.current = makeShuffledQueue(pool, pool.find(p => p.text === lastLabelRef.current));
    }
    const next = queueRef.current.shift() || pool[0] || DEFAULT_LIVE_PHRASE;
    doTransition(next.text, next.dur);
  };

  // Mount: start with current state
  useEffect(() => {
    const { mode, label: ctxLabel } = getLogState(logs);
    modeRef.current = mode;
    if (mode === 'acting' && ctxLabel) {
      doTransition(ctxLabel, 4000);
    } else {
      const pool = mode === 'thinking' ? THINKING_PHRASES : IDLE_PHRASES;
      queueRef.current = makeShuffledQueue(pool);
      const first = queueRef.current.shift() || pool[0] || DEFAULT_LIVE_PHRASE;
      doTransition(first.text, first.dur);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  // React to log changes — immediately reflect mode/action
  const prevLogsLenRef = useRef(logs.length);
  useEffect(() => {
    if (logs.length === prevLogsLenRef.current) return;
    prevLogsLenRef.current = logs.length;
    const { mode, label: ctxLabel } = getLogState(logs);
    const prevMode = modeRef.current;
    modeRef.current = mode;

    if (mode === 'acting' && ctxLabel && ctxLabel !== lastLabelRef.current) {
      // New real action — show it immediately
      queueRef.current = [];
      doTransition(ctxLabel, 4200);
    } else if (mode === 'thinking' && prevMode !== 'thinking') {
      // Just entered thinking mode
      queueRef.current = makeShuffledQueue(THINKING_PHRASES);
      const next = queueRef.current.shift() || THINKING_PHRASES[0] || DEFAULT_LIVE_PHRASE;
      doTransition(next.text, next.dur);
    } else if (mode === 'idle' && prevMode !== 'idle') {
      // Just entered idle mode
      queueRef.current = makeShuffledQueue(IDLE_PHRASES);
      const next = queueRef.current.shift() || IDLE_PHRASES[0] || DEFAULT_LIVE_PHRASE;
      doTransition(next.text, next.dur);
    }
    // Same mode: let the current timer naturally advance
  }, [logs.length]);

  return (
    <div className="mt-0.5 mb-1 flex min-h-[34px] w-fit items-center">
      <AgentFace
        size="work"
        mode={modeRef.current === 'acting' ? 'working' : modeRef.current === 'thinking' ? 'thinking' : 'idle'}
        actionKey={label}
        interactive
        syncWithController={false}
        ariaLabel="EterX active agent face"
      />
    </div>
  );
};


// Elapsed time hook
const useElapsed = (active: boolean) => {
  const [t, setT] = useState(0);
  const start = useRef(Date.now());
  useEffect(() => {
    if (!active) return;
    start.current = Date.now();
    const iv = setInterval(() => setT(Math.floor((Date.now() - start.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [active]);
  if (!active) return null;
  const m = Math.floor(t / 60), s = t % 60;
  return m > 0 ? `${ m }m ${ s }s` : `${ s }s`;
};


export const ThinkingProcess = ({ logs, isThinking, isLast }: { logs: any[], isThinking: boolean, isLast: boolean }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // NOTE: 'ask_user' is intentionally excluded here — it's rendered as a full AskUserPrompt
  // card in chat-feed.tsx. Including it here causes a duplicate ActionChip to appear.
  const NOISE_PATTERN = /reconnect|retrying|stalled|stream interrupted|model error|fallback|cancelled/i;
  const flowLogs = logs.filter(l =>
    ['thought_stream', 'work_note', 'command', 'exploration', 'file_edit', 'progress', 'browser', 'safety_warning', 'communication', 'sub_agent_answer', 'sub_agent_result', 'file_preview', 'console_output'].includes(l.type) &&
    !(['progress', 'command', 'exploration'].includes(l.type) && /analyz(?:e|ing) task complexity/i.test(String(l.text || ''))) &&
    !(l.type === 'progress' && NOISE_PATTERN.test(String(l.text || '')))
  );
  const segs: any[] = []; let aBuf: any[] = [];
  const SPEC = new Set(['file_preview', 'console_output', 'sub_agent_answer', 'sub_agent_result', 'safety_warning']);
  const flush = (idx: number) => {
    if (aBuf.length > 0) {
      const unique: any[] = [];
      aBuf.forEach((log, i) => {
        if (i > 0) {
          const prev = unique[unique.length - 1];
          if (log.type === prev.type && log.text === prev.text && log.secondary === prev.secondary) {
            unique[unique.length - 1] = { ...prev, ...log }; return;
          }
        }
        unique.push(log);
      });
      segs.push({ kind: 'action_group', logs: unique, lastIdx: idx });
      aBuf = [];
    }
  };
  flowLogs.forEach((log, idx) => {
    if (log.type === 'thought_stream') { flush(idx - 1); segs.push({ kind: 'thought', log, idx }); }
    else if (log.type === 'work_note') { flush(idx - 1); segs.push({ kind: 'note', log, idx }); }
    else if (log.type === 'safety_warning') { flush(idx - 1); segs.push({ kind: 'safety', log, idx }); }
    else if (log.type === 'sub_agent_answer' || log.type === 'sub_agent_result') { flush(idx - 1); segs.push({ kind: 'subagent', log, idx }); }
    else if (SPEC.has(log.type)) { flush(idx - 1); }
    else { aBuf.push(log); }
  });
  flush(flowLogs.length - 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current && isThinking) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segs.length, isThinking]);
  return (
    <div ref={containerRef} className="w-full flex flex-col gap-1 py-0">
      {segs.map((seg, i) => {
        if (seg.kind === 'thought') return <ProfessionalThought key={`t-${ seg.idx }`} text={seg.log.text} isLatest={isLast && i === segs.length - 1} isThinking={isThinking} />;
        if (seg.kind === 'note') return <ProfessionalThought key={`n-${ seg.idx }`} text={seg.log.text} isLatest={false} isThinking={false} variant="note" />;
        if (seg.kind === 'safety') return <SafetyBanner key={`sf-${ seg.idx }`} log={seg.log} />;
        if (seg.kind === 'subagent') return <SubAgentCard key={`sa-${ seg.idx }`} log={seg.log} />;
        
        // Unpack single action chip — wrap in card so it sits inside the container
        if (seg.logs.length === 1) {
          return (
            <div key={`g-${ seg.lastIdx }`} className="w-full overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#1A1A1A]/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_16px_rgba(0,0,0,0.22)]">
              <ActionChip
                log={seg.logs[0]}
                isLastChip={isLast && i === segs.length - 1}
                isActiveGroup={isThinking && isLast && i === segs.length - 1}
                allLogs={flowLogs}
                isNested={false}
                inCard={true}
              />
            </div>
          );
        }
        return <CollapsibleActionGroup key={`g-${ seg.lastIdx }`} logs={seg.logs} isActiveGroup={isThinking && isLast && i === segs.length - 1} isLast={isLast} allLogs={flowLogs} />;
      })}
      {isThinking && isLast && <LiveWorkingIndicator logs={flowLogs} />}
    </div>
  );
};
