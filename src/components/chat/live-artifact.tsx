import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

interface LiveArtifactProps {
  html?: string;
  css?: string;
  js?: string;
  title?: string;
}

/**
 * LiveArtifact — A high-end sandboxed preview for HTML, CSS, and JS.
 * Renders content in a seamless iframe to prevent style leakage.
 */
export const LiveArtifact: React.FC<LiveArtifactProps> = ({ html = '', css = '', js = '', title = 'Live Component' }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!iframeRef.current) return;

    const doc = iframeRef.current.contentDocument;
    if (!doc) return;

    const fullContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { 
              margin: 0; 
              padding: 20px; 
              color: #E8E6E3; 
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background: transparent;
              overflow-x: hidden;
            }
            ${css}
          </style>
        </head>
        <body>
          ${html}
          <script>
            try {
              ${js}
            } catch (err) {
              console.error('LiveArtifact JS Error:', err);
            }
          </script>
        </body>
      </html>
    `;

    doc.open();
    doc.write(fullContent);
    doc.close();
  }, [html, css, js]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      className="my-8 w-full rounded-[32px] border border-white/10 bg-[#050505] overflow-hidden shadow-2xl"
    >
      <div className="px-6 py-4 bg-white/5 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F56]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#27C93F]" />
          </div>
          <span className="text-[11px] font-black text-white/60 uppercase tracking-widest ml-2">{title}</span>
        </div>
      </div>
      <div className="relative w-full min-h-[300px] bg-transparent">
        <iframe
          ref={iframeRef}
          className="w-full h-full min-h-[300px] border-none"
          title={title}
          sandbox="allow-scripts"
        />
      </div>
    </motion.div>
  );
};
