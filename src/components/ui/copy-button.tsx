import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip } from './tooltip';

export const safeCopyTextToClipboard = async (text: string): Promise<boolean> => {
  if (!text) return false;

  // Tier 1: Modern Navigator Clipboard API
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to legacy execCommand below
  }

  // Tier 2: Hidden Textarea ExecCommand
  try {
    if (typeof document !== 'undefined') {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      textArea.style.opacity = '0';
      textArea.setAttribute('readonly', '');
      document.body.appendChild(textArea);

      const currentFocus = document.activeElement as HTMLElement | null;
      textArea.focus();
      textArea.select();
      if (typeof textArea.setSelectionRange === 'function') {
        textArea.setSelectionRange(0, text.length);
      }

      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      if (currentFocus && typeof currentFocus.focus === 'function') {
        currentFocus.focus();
      }
      if (successful) return true;
    }
  } catch {
    // Fall back to selection range
  }

  // Tier 3: Selection Range Fallback
  try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const span = document.createElement('span');
      span.textContent = text;
      span.style.position = 'fixed';
      span.style.left = '-999999px';
      span.style.opacity = '0';
      document.body.appendChild(span);

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(span);
      selection?.removeAllRanges();
      selection?.addRange(range);

      const successful = document.execCommand('copy');
      selection?.removeAllRanges();
      document.body.removeChild(span);
      if (successful) return true;
    }
  } catch {
    // ignore
  }

  return false;
};

export const CopyButton = ({ text, className = "", side = "bottom" }: { text: string, className?: string, side?: any }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    const ok = await safeCopyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Tooltip text={copied ? "Copied!" : "Copy code"} side={side}>
      <button
        type="button"
        onClick={handleCopy}
        className={`p-1.5 hover:bg-white/10 rounded-md transition-all duration-200 text-[#8C8A88] hover:text-white active:scale-90 ${ className }`}
      >
        {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
      </button>
    </Tooltip>
  );
};
