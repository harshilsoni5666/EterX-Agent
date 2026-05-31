"use client";

import React, { CSSProperties, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, CheckCircle2, MessageCircle, Settings2, ShieldCheck } from 'lucide-react';
import { PremiumAgent } from '../ui/premium-icons';

type OrbitIcon = {
  id: string;
  label: string;
  logo: string;
  size: number;
  delay: string;
};

const ORBIT_ICONS: OrbitIcon[] = [
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    logo: '/icons/connectors/whatsapp.svg',
    size: 64,
    delay: '-0.85s',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    logo: '/icons/connectors/telegram.svg',
    size: 64,
    delay: '-2.25s',
  },
  {
    id: 'messenger',
    label: 'Messenger',
    logo: '/icons/connectors/messenger.svg',
    size: 68,
    delay: '-4.1s',
  },
  {
    id: 'line',
    label: 'LINE',
    logo: '/icons/connectors/line.svg',
    size: 64,
    delay: '-6.0s',
  },
  {
    id: 'slack',
    label: 'Slack',
    logo: '/icons/connectors/slack.svg',
    size: 58,
    delay: '-7.4s',
  },
];

const FEATURE_CARDS = [
  {
    icon: ShieldCheck,
    title: 'Trusted agent identity',
    desc: 'One voice, policy, and escalation path across every customer touchpoint.',
  },
  {
    icon: Activity,
    title: 'Context that follows',
    desc: 'Carry customer history, tool state, and decisions from one channel to the next.',
  },
  {
    icon: Settings2,
    title: 'Skill routing',
    desc: 'Send every request to the right workflow, tool, or specialist agent automatically.',
  },
  {
    icon: MessageCircle,
    title: 'Native handoff',
    desc: 'Meet customers on WhatsApp, Telegram, Slack, Messenger, LINE, and web.',
  },
];

const HEADLINE_LINES = [
  'Launch your agent across every customer channel',
  'Deploy one agent across every conversation',
  'Route every message to the right specialist agent',
  'Keep every customer handoff context-aware',
];

const CTA_ICONS = [
  '/icons/connectors/telegram.svg',
  '/icons/connectors/whatsapp.svg',
  '/icons/connectors/messenger.svg',
  '/icons/connectors/line.svg',
  '/icons/connectors/slack.svg',
];

const connectorImage = (src: string, size: number, className = 'h-[58%] w-[58%]') => (
  <img
    src={src}
    alt=""
    width={size}
    height={size}
    loading="eager"
    decoding="async"
    fetchPriority="high"
    className={`${className} object-contain`}
    draggable={false}
  />
);

export const AgentChannelsView = () => {
  const [headlineIndex, setHeadlineIndex] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setHeadlineIndex(index => (index + 1) % HEADLINE_LINES.length);
    }, 4200);

    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="eterx-channels-view flex h-full min-h-0 w-full overflow-hidden bg-[var(--eterx-channel-surface)] px-5 py-4 text-[#33302d] md:px-8 md:py-5">
      <div className="mx-auto flex h-full w-full max-w-[1420px] flex-col items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
          className="eterx-channel-orbit-stage relative h-[282px] w-full max-w-[520px] shrink-0"
        >
          <div className="eterx-channel-phone absolute left-1/2 top-[68px] z-10 h-[206px] w-[252px] -translate-x-1/2 rounded-[34px] border-[5px] border-[#D9D8D5] bg-[linear-gradient(180deg,#F9F9F8_0%,#ECEBE8_100%)] shadow-[0_30px_72px_rgba(45,45,45,0.08)]" />
          <img
            src="/logo.png"
            alt=""
            width={28}
            height={28}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            className="absolute left-1/2 top-[100px] z-20 h-6 w-6 -translate-x-1/2 object-contain opacity-95 drop-shadow-[0_8px_18px_rgba(45,45,45,0.10)]"
            draggable={false}
          />
          <div className="eterx-channel-agent-card absolute left-1/2 top-[142px] z-30 flex h-[72px] w-[372px] -translate-x-1/2 items-center gap-3 rounded-[18px] border border-[#E5E2DE] bg-white/95 px-4 shadow-[0_20px_50px_rgba(34,34,34,0.12)] backdrop-blur-sm">
            <span className="eterx-channel-agent-avatar flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full border border-[#EEEAE4] bg-[#F7F5F2] text-[#34312f] shadow-[0_10px_24px_rgba(44,40,36,0.08)]">
              <PremiumAgent className="h-[23px] w-[23px] brightness-0" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[18px] font-semibold leading-none text-[#33302d]">
                EterX
                <CheckCircle2 className="h-4 w-4 text-[#1398FF]" fill="#1398FF" stroke="white" strokeWidth={2.2} />
              </span>
              <span className="eterx-channel-skeleton-line mt-2.5 block h-2 w-full rounded-full bg-[#E3E2DF]" />
              <span className="eterx-channel-skeleton-line mt-1.5 block h-2 w-[62%] rounded-full bg-[#E3E2DF]" />
            </span>
          </div>

          {ORBIT_ICONS.map(item => {
            const iconStyle = {
              '--delay': item.delay,
              width: item.size,
              height: item.size,
            } as CSSProperties;

            return (
              <span
                key={item.id}
                aria-label={item.label}
                className="eterx-channel-orbit-icon absolute left-1/2 top-[146px] flex items-center justify-center rounded-full bg-white shadow-[0_20px_52px_rgba(40,40,40,0.14)] ring-1 ring-[#ECE9E5]"
                style={iconStyle}
              >
                {connectorImage(item.logo, Math.round(item.size * 0.58))}
              </span>
            );
          })}
        </motion.div>

        <h1 className="relative mt-1 flex h-[62px] w-full items-center justify-center overflow-visible whitespace-nowrap text-center font-serif text-[clamp(31px,2.45vw,44px)] font-semibold leading-none tracking-normal text-[#3B3835]">
          <AnimatePresence mode="wait">
            <motion.span
              key={HEADLINE_LINES[headlineIndex]}
              initial={{ opacity: 0, y: 12, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(9px)' }}
              transition={{ duration: 0.58, ease: [0.22, 1, 0.36, 1] }}
              className="block w-full text-[#3B3835]"
            >
              {HEADLINE_LINES[headlineIndex]}
            </motion.span>
          </AnimatePresence>
        </h1>

        <div className="mt-5 grid w-full grid-cols-4 gap-4">
          {FEATURE_CARDS.map(item => (
            <div
              key={item.title}
              className="eterx-channel-feature-card min-h-[150px] rounded-[20px] border border-[#DEDBD6] bg-white px-5 py-5 text-left shadow-[0_16px_42px_rgba(50,45,40,0.035)]"
            >
              <item.icon className="h-6 w-6 text-[#34312f]" strokeWidth={1.85} />
              <h2 className="mt-5 max-w-[240px] text-[19px] font-semibold leading-snug tracking-normal text-[#3B3835]">
                {item.title}
              </h2>
              <p className="mt-2 max-w-[270px] text-[15px] leading-[1.45] tracking-normal text-[#85817c]">
                {item.desc}
              </p>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="eterx-channel-cta mt-5 inline-flex h-[48px] items-center gap-3 rounded-[14px] border border-[#DCD7CF] bg-[#F1EFEB] px-6 text-[16px] font-bold text-[#353230] shadow-[0_16px_36px_rgba(62,56,48,0.10)] transition hover:bg-[#E9E5DE] active:scale-[0.98]"
        >
          <span className="flex -space-x-2">
            {CTA_ICONS.map(src => (
              <span key={src} className="eterx-channel-cta-icon flex h-7 w-7 items-center justify-center rounded-full border-2 border-[#F1EFEB] bg-white shadow-[0_4px_12px_rgba(50,45,40,0.12)]">
                {connectorImage(src, 20, 'h-5 w-5')}
              </span>
            ))}
          </span>
          <span>Get started</span>
        </button>

        <div className="mt-3 flex w-full max-w-[420px] items-center gap-5 text-[15px] font-semibold text-[#8A8680]">
          <span className="h-px flex-1 bg-[#ECE9E5]" />
          Coming soon
          <span className="h-px flex-1 bg-[#ECE9E5]" />
        </div>
      </div>
    </div>
  );
};

export default AgentChannelsView;
