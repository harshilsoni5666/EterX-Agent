import { createLucideIcon } from 'lucide-react';

// Reference-matched shapes using Lucide's sizing, stroke and accessibility API.
export const CopyChatIcon = createLucideIcon({
  name: 'copy-chat', size: 24,
  node: [
    ['rect', { x: '3', y: '8', width: '13', height: '13', rx: '3', key: 'front' }],
    ['path', { d: 'M9 8V6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-2', key: 'back' }],
  ],
});

export const OpenChatWindowIcon = createLucideIcon({
  name: 'open-chat-window', size: 24,
  node: [
    ['path', { d: 'M16 6V5a2 2 0 0 0-2-2H6a3 3 0 0 0-3 3v8a2 2 0 0 0 2 2h1', key: 'back' }],
    ['rect', { x: '8', y: '8', width: '13', height: '13', rx: '3', key: 'front' }],
    ['path', { d: 'M11 14.5h7m-3-3 3 3-3 3', key: 'arrow' }],
  ],
});
