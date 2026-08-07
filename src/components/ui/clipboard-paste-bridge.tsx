'use client';

import { useEffect } from 'react';
import { safeReadTextFromClipboard } from './copy-button';

const isEditableTarget = (node: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null => {
  if (!(node instanceof HTMLElement)) return null;
  const editable = node.closest('input, textarea, [contenteditable="true"]') as HTMLElement | null;
  if (!editable || !editable.isConnected) return null;
  if (editable instanceof HTMLInputElement) {
    const blockedTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
    if (blockedTypes.has(editable.type) || editable.disabled || editable.readOnly) return null;
  }
  if (editable instanceof HTMLTextAreaElement && (editable.disabled || editable.readOnly)) return null;
  if (!(editable instanceof HTMLInputElement) && !(editable instanceof HTMLTextAreaElement) && !editable.isContentEditable) return null;
  return editable;
};

const insertIntoNativeControl = (target: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  const currentValue = target.value || '';
  const start = Math.max(0, Math.min(target.selectionStart ?? currentValue.length, currentValue.length));
  const end = Math.max(start, Math.min(target.selectionEnd ?? start, currentValue.length));
  const nextValue = `${currentValue.slice(0, start)}${text}${currentValue.slice(end)}`;
  const prototype = Object.getPrototypeOf(target) as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(target, nextValue);
  else target.value = nextValue;
  target.dispatchEvent(typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text })
    : new Event('input', { bubbles: true }));
  target.focus();
  target.selectionStart = target.selectionEnd = start + text.length;
};

const insertIntoContentEditable = (target: HTMLElement, text: string) => {
  target.focus();
  if (document.execCommand?.('insertText', false, text)) return;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !target.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  target.dispatchEvent(typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text })
    : new Event('input', { bubbles: true }));
};

/**
 * Handles the one macOS/Electron case where a paste event reaches the focused
 * control without any text in ClipboardEvent.clipboardData. Normal paste
 * events are left to the browser and to the control's own handler.
 */
export const ClipboardPasteBridge = () => {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = isEditableTarget(event.target);
      if (!target) return;
      // The composer and API-key pool preserve their own selection semantics.
      // Their handlers use the same native fallback after this capture phase.
      if ((target as HTMLElement).dataset.eterxPasteHandler === 'controlled') return;
      const eventText = event.clipboardData?.getData('text/plain') || event.clipboardData?.getData('text') || '';
      if (eventText) return;
      // Preserve native image/file paste for controls that know how to handle
      // it. The bridge is only a text fallback; swallowing file data here
      // would break screenshots pasted into contenteditable fields on macOS.
      const hasFileData = Boolean(
        event.clipboardData?.files?.length ||
        Array.from(event.clipboardData?.items || []).some(item => item.kind === 'file'),
      );
      if (hasFileData) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      void safeReadTextFromClipboard().then((text) => {
        if (!text || !target.isConnected) return;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          insertIntoNativeControl(target, text);
        } else {
          insertIntoContentEditable(target, text);
        }
      });
    };

    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, []);

  return null;
};
