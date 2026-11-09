'use client';

import React, { useState } from 'react';
import { FileText, Image as ImageIcon } from 'lucide-react';
import { buildFilePreviewUrl } from '../../lib/path-utils';
import { PASTED_TEXT_MIME } from '../../lib/pasted-text';
import { ChatMediaItem, findChatMedia } from './chat-media';
import { openChatImage } from './image-gallery';
import { openLocalFilePath } from './local-file-link';

export type QueuedMessageAttachment = {
  id?: string;
  name?: string;
  mimeType?: string;
  localPath?: string;
  path?: string;
  preview?: string;
  previewUrl?: string;
  file?: { name?: string; type?: string };
};

function Attachment({ attachment, media }: { attachment: QueuedMessageAttachment; media: ChatMediaItem[] }) {
  const [failedSource, setFailedSource] = useState('');
  const saved = findChatMedia(media, attachment);
  const name = attachment.name || attachment.file?.name || saved?.name || 'Attachment';
  const mime = (attachment.mimeType || attachment.file?.type || saved?.mimeType || '').toLowerCase();
  const extension = name.split('.').pop()?.toLowerCase() || '';
  const isImage = mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(extension);
  const isVideo = mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(extension);
  const path = saved?.path || attachment.localPath || attachment.path;
  const preview = saved?.previewUrl || attachment.previewUrl || buildFilePreviewUrl(path) || attachment.preview || '';
  const text = mime === PASTED_TEXT_MIME || ['txt', 'md', 'csv', 'tsv', 'json', 'log'].includes(extension);
  const document = text || ['pdf', 'docx'].includes(extension);
  const hasThumbnail = (isImage || isVideo) && preview && failedSource !== preview;

  return (
    <button
      type="button"
      aria-label={`Preview ${name}`}
      title={name}
      disabled={!(isImage || isVideo ? preview : path || (document && attachment.file))}
      onClick={event => {
        event.stopPropagation();
        if (isImage) openChatImage(event.currentTarget, preview);
        else if (isVideo) window.dispatchEvent(new CustomEvent('eterx-preview-media', { detail: { previewUrl: preview, kind: 'video', fileName: name } }));
        else if (document) window.dispatchEvent(new CustomEvent(text ? 'eterx-preview-text' : 'eterx-preview-document', {
          detail: { filePath: path, file: attachment.file, name },
        }));
        else if (path) void openLocalFilePath(path);
      }}
      className={hasThumbnail
        ? 'relative h-16 w-20 shrink-0 overflow-hidden rounded-lg border border-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50'
        : 'inline-flex max-w-full items-center gap-1.5 rounded-lg border border-white/10 px-2 py-1.5 text-xs text-white/75 hover:bg-white/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-60'}
    >
      {hasThumbnail ? isVideo
        ? <video src={preview} muted playsInline preload="metadata" onError={() => setFailedSource(preview)} className="h-full w-full object-cover" />
        : <img data-chat-image src={preview} alt={name} loading="lazy" decoding="async" onError={() => setFailedSource(preview)} className="h-full w-full object-cover" />
        : <>{isImage ? <ImageIcon className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}<span className="max-w-[24ch] truncate">{mime === PASTED_TEXT_MIME ? 'Pasted text' : name}</span></>}
    </button>
  );
}

export function QueuedMessageAttachments({ attachments, media = [] }: { attachments: QueuedMessageAttachment[]; media?: ChatMediaItem[] }) {
  return <div className="eterx-user-attachments mt-1.5 flex max-w-full flex-wrap gap-1.5">
    {attachments.map((attachment, index) => <Attachment key={attachment.id || attachment.localPath || attachment.path || index} attachment={attachment} media={media} />)}
  </div>;
}
