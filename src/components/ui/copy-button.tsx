import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip } from './tooltip';

export const CopyButton = ({ text, className = "", side = "bottom" }: { text: string, className?: string, side?: any }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Tooltip text={copied ? "Copied!" : "Copy code"} side={side}>
      <button
        onClick={handleCopy}
        className={`p-1.5 hover:bg-white/10 rounded-md transition-all duration-200 text-[#8C8A88] hover:text-white active:scale-90 ${ className }`}
      >
        {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
      </button>
    </Tooltip>
  );
};
