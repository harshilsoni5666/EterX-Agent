import React from 'react';
// @ts-ignore
import ReactMarkdown from 'react-markdown';
// @ts-ignore
import remarkGfm from 'remark-gfm';
// @ts-ignore
import remarkMath from 'remark-math';
// @ts-ignore
import rehypeKatex from 'rehype-katex';
// @ts-ignore
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// @ts-ignore
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CopyButton } from '../ui/copy-button';
import { LiveArtifact } from './live-artifact';


/** Re-export remark/rehype plugins for use in other components */
export const remarkPlugins = [remarkGfm, remarkMath];
export const rehypePlugins = [rehypeKatex];

export const markdownComponents = {
  code({ node, inline, className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : '';
    const content = String(children).replace(/\n$/, '');

    if (!inline && language === 'js-preview') {
      return <LiveArtifact js={content} title="JS Logic Preview" />;
    }

    if (!inline && language === 'html-preview') {
      return <LiveArtifact html={content} title="HTML Preview" />;
    }

    if (!inline && (language === 'react-preview' || language === 'preview')) {
      return (
        <div className="my-5 w-full rounded-[32px] border border-white/10 bg-[#050505] overflow-hidden shadow-2xl">
          <div className="p-4 bg-white/5 border-b border-white/5 flex items-center justify-between">
            <div className="flex gap-1.5 ml-2">
              <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F56]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#27C93F]" />
            </div>
            <span className="text-[11px] font-black text-white/40 uppercase tracking-widest px-4">Live Preview</span>
          </div>
          <div className="p-8 min-h-[200px] flex items-center justify-center">
            <div dangerouslySetInnerHTML={{ __html: content }} />
          </div>
        </div>
      );
    }

    return !inline && match ? (
      <div className="my-5 shadow-lg border border-white/5 rounded-xl group/code relative flex flex-col bg-[#1C1B1A]">
        <div className="sticky top-20 z-30 h-0 flex justify-end px-2 pointer-events-none">
          <div className="pointer-events-auto">
            <CopyButton
              text={content}
              side="left"
              className="bg-[#1C1B1A]/80 backdrop-blur-md border border-white/10 opacity-40 group-hover/code:opacity-100 transition-all duration-200 shadow-lg"
            />
          </div>
        </div>
        <div className="overflow-x-auto overflow-y-hidden rounded-xl custom-scrollbar">
          <SyntaxHighlighter
            style={vscDarkPlus as any}
            language={language}
            PreTag="div"
            className="text-[13.5px] leading-relaxed font-mono code-span w-full m-0! bg-[#1C1B1A]! pt-5 pb-4 px-4 min-w-full"
            customStyle={{ margin: 0, background: '#1C1B1A', padding: '1.25rem 1rem' }}
            {...props}
          >
            {content}
          </SyntaxHighlighter>
        </div>
      </div>
    ) : (
      <code className="bg-[#363432] text-[#E2765A] px-1.5 py-0.5 rounded font-mono text-[13.5px]" {...props}>
        {children}
      </code>
    );
  },
  p: ({ node, ...props }: any) => <p className="mb-4 last:mb-0 leading-[1.75]" {...props} />,
  a: ({ node, ...props }: any) => <a className="text-[#E2765A] hover:underline underline-offset-2" target="_blank" rel="noopener noreferrer" {...props} />,
  ul: ({ node, ...props }: any) => <ul className="list-disc pl-6 mb-4 space-y-1.5 marker:text-[#8C8A88]" {...props} />,
  ol: ({ node, ...props }: any) => <ol className="list-decimal pl-6 mb-4 space-y-1.5 marker:text-[#8C8A88]" {...props} />,
  li: ({ node, ...props }: any) => <li className="leading-[1.7]" {...props} />,
  h1: ({ node, ...props }: any) => <h1 className="text-[24px] font-bold mb-4 mt-8 text-[#E8E6E3] leading-tight" {...props} />,
  h2: ({ node, ...props }: any) => <h2 className="text-[20px] font-bold mb-3 mt-6 text-[#E8E6E3] leading-tight" {...props} />,
  h3: ({ node, ...props }: any) => <h3 className="text-[17px] font-bold mb-3 mt-5 text-[#E8E6E3] leading-tight" {...props} />,
  h4: ({ node, ...props }: any) => <h4 className="text-[15px] font-semibold mb-2 mt-4 text-[#E8E6E3] leading-tight" {...props} />,
  h5: ({ node, ...props }: any) => <h5 className="text-[14px] font-semibold mb-2 mt-3 text-[#D2D0CD] leading-tight" {...props} />,
  h6: ({ node, ...props }: any) => <h6 className="text-[13px] font-semibold mb-2 mt-3 text-[#A3A19E] leading-tight" {...props} />,
  strong: ({ node, ...props }: any) => <strong className="font-bold text-[#E8E6E3]" {...props} />,
  em: ({ node, ...props }: any) => <em className="italic text-[#D2D0CD]" {...props} />,
  blockquote: ({ node, ...props }: any) => <blockquote className="border-l-[3px] border-[#E2765A]/50 bg-[#2A2927] py-2 px-4 italic text-[#A3A19E] my-4 rounded-r-lg" {...props} />,
  hr: ({ node, ...props }: any) => <hr className="border-white/10 my-6" {...props} />,
  table: ({ node, ...props }: any) => (
    <div className="my-5 overflow-x-auto custom-scrollbar rounded-xl border border-white/10 shadow-sm">
      <table className="w-full border-collapse text-[14px]" {...props} />
    </div>
  ),
  thead: ({ node, ...props }: any) => <thead className="bg-[#1C1B1A]" {...props} />,
  th: ({ node, ...props }: any) => <th className="border border-white/5 px-4 py-2 text-left font-bold text-[#E8E6E3]" {...props} />,
  td: ({ node, ...props }: any) => <td className="border border-white/5 px-4 py-2 text-[#D2D0CD]" {...props} />,
  tr: ({ node, ...props }: any) => <tr className="hover:bg-white/5 transition-colors" {...props} />,
  img: ({ node, ...props }: any) => <img className="rounded-lg max-w-full my-4 shadow-md border border-white/5" {...props} />,
};
