import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip } from './tooltip';

export const safeCopyTextToClipboard = async (text: string): Promise<boolean> => {
  const value = String(text ?? '');
  if (!value || typeof window === 'undefined' || typeof document === 'undefined') return false;

  // Tier 1: Modern Navigator Clipboard API
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back to legacy execCommand below
  }

  // Tier 2: Hidden Textarea ExecCommand
  let textArea: HTMLTextAreaElement | null = null;
  const currentFocus = document.activeElement as HTMLElement | null;
  try {
    if (!document.body || typeof document.execCommand !== 'function') return false;
    textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    textArea.style.opacity = '0';
    textArea.setAttribute('readonly', '');
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, value.length);
    if (document.execCommand('copy')) return true;
  } catch {
    // Fall back to selection range
  } finally {
    textArea?.remove();
    if (currentFocus && typeof currentFocus.focus === 'function') currentFocus.focus();
  }

  // Tier 3: Selection Range Fallback
  let span: HTMLSpanElement | null = null;
  try {
    if (!document.body || typeof document.execCommand !== 'function') return false;
    span = document.createElement('span');
    span.textContent = value;
    span.style.position = 'fixed';
    span.style.left = '-999999px';
    span.style.opacity = '0';
    document.body.appendChild(span);

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(span);
    selection?.removeAllRanges();
    selection?.addRange(range);

    return document.execCommand('copy');
  } catch {
    // ignore
    return false;
  } finally {
    window.getSelection()?.removeAllRanges();
    span?.remove();
  }
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
        aria-label={copied ? "Copied" : "Copy code"}
        className={`p-1.5 hover:bg-white/10 rounded-md transition-all duration-200 text-[#8C8A88] hover:text-white active:scale-90 ${ className }`}
      >
        {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
      </button>
    </Tooltip>
  );
};
