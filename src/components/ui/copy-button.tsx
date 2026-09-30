import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip } from './tooltip';

type ClipboardEventLike = {
  clipboardData?: {
    getData: (format: string) => string;
  } | null;
};

const clipboardBlobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
  reader.onerror = () => reject(reader.error || new Error('Could not read clipboard image'));
  reader.readAsDataURL(blob);
});

const getDesktopClipboardApi = (): {
  writeClipboardText?: (value: string) => Promise<boolean | void>;
  writeClipboardPng?: (value: string) => Promise<boolean | void>;
  readClipboardText?: () => Promise<string>;
  readClipboardImage?: () => Promise<string | null>;
} | null => {
  if (typeof window === 'undefined') return null;
  return ((window as any).electronAPI || null) as {
    writeClipboardText?: (value: string) => Promise<boolean | void>;
    writeClipboardPng?: (value: string) => Promise<boolean | void>;
    readClipboardText?: () => Promise<string>;
    readClipboardImage?: () => Promise<string | null>;
  } | null;
};

export const safeCopyTextToClipboard = async (text: string): Promise<boolean> => {
  const value = String(text ?? '');
  if (!value || typeof window === 'undefined' || typeof document === 'undefined') return false;

  // Tier 1: Electron's native clipboard. This works for packaged macOS,
  // Windows, and Linux builds even when Chromium does not grant the renderer
  // a secure-context clipboard permission.
  try {
    const desktopClipboard = getDesktopClipboardApi();
    if (typeof desktopClipboard?.writeClipboardText === 'function') {
      const written = await desktopClipboard.writeClipboardText(value);
      if (written !== false) return true;
    }
  } catch {
    // Fall through to browser clipboard implementations.
  }

  // Tier 2: Modern Navigator Clipboard API
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back to legacy execCommand below
  }

  // Tier 3: Hidden Textarea ExecCommand
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

  // Tier 4: Selection Range Fallback
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

/**
 * Read plain text from a paste event, with a native Electron fallback for
 * macOS/WebContents cases where ClipboardEvent.clipboardData is empty.
 * The event payload always wins so normal browser paste remains synchronous.
 */
export const safeReadTextFromClipboard = async (event?: ClipboardEventLike): Promise<string> => {
  const eventText = event?.clipboardData?.getData('text/plain') || event?.clipboardData?.getData('text') || '';
  if (eventText) return eventText;

  try {
    const desktopClipboard = getDesktopClipboardApi();
    if (typeof desktopClipboard?.readClipboardText === 'function') {
      const nativeText = await desktopClipboard.readClipboardText();
      if (typeof nativeText === 'string' && nativeText) return nativeText;
    }
  } catch {
    // Try the browser API below.
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      return await navigator.clipboard.readText();
    }
  } catch {
    // Empty means there is no readable text available to insert.
  }
  return '';
};

/**
 * Read a native clipboard image as a data URL. Native desktop clipboard APIs
 * are required for packaged Electron windows because Chromium may not expose
 * image data when the renderer is loaded from a local app URL.
 */
export const safeReadImageFromClipboard = async (): Promise<string> => {
  try {
    const desktopClipboard = getDesktopClipboardApi();
    if (typeof desktopClipboard?.readClipboardImage === 'function') {
      const dataUrl = await desktopClipboard.readClipboardImage();
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) return dataUrl;
    }
  } catch {
    // An empty result means there is no native image available.
  }

  // Browser fallback for web/Linux environments where async clipboard access
  // is available but ClipboardEvent did not expose image files.
  try {
    const clipboardApi = typeof navigator !== 'undefined' ? navigator.clipboard as any : null;
    if (typeof clipboardApi?.read === 'function') {
      const items = await clipboardApi.read();
      for (const item of items || []) {
        const imageTypes = Array.from(item.types || []) as string[];
        const imageType = imageTypes.find((type) => type.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const dataUrl = await clipboardBlobToDataUrl(blob);
        if (dataUrl.startsWith('data:image/')) return dataUrl;
      }
    }
  } catch {
    // Browser clipboard permissions are optional; return an empty result.
  }
  return '';
};

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
  reader.onerror = () => reject(reader.error || new Error('Could not read clipboard image'));
  reader.readAsDataURL(blob);
});

/** Copy a rendered PNG through the same native desktop bridge as text copy. */
export const safeCopyPngToClipboard = async (blob: Blob): Promise<boolean> => {
  if (!blob || typeof window === 'undefined') return false;
  try {
    const dataUrl = await blobToDataUrl(blob);
    const desktopClipboard = getDesktopClipboardApi();
    if (typeof desktopClipboard?.writeClipboardPng === 'function') {
      const written = await desktopClipboard.writeClipboardPng(dataUrl);
      if (written !== false) return true;
    }
  } catch {
    // Fall back to the browser image clipboard below.
  }

  try {
    const clipboardApi = typeof navigator !== 'undefined' ? navigator.clipboard as any : null;
    if (clipboardApi?.write && typeof ClipboardItem !== 'undefined') {
      await clipboardApi.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }
  } catch {
    // The caller can offer a download fallback when image clipboard is absent.
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
        aria-label={copied ? "Copied" : "Copy code"}
        className={`p-1.5 hover:bg-white/10 rounded-md transition-all duration-200 text-[#8C8A88] hover:text-white active:scale-90 ${ className }`}
      >
        {copied ? <Check className="w-4 h-4 text-white" /> : <Copy className="w-4 h-4" />}
      </button>
    </Tooltip>
  );
};
