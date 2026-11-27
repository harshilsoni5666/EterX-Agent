'use client';

import { useEffect } from 'react';
import { isAppVisible, useAppVisibility } from '../../lib/app-visibility';
import { activeDevelopmentPreview, openDevelopmentPreview, openWorkbenchView } from '../../lib/side-workspace-store';
import { notifyWorkbenchClient, workbenchAction, workbenchUrl } from '../../lib/workbench/client';
import type { PreviewJob, PreviewResult, WorkbenchFocus } from '../../lib/workbench/contracts';
import { useWorkspacePaneVisible } from '../ui/workspace-pane-visibility';

const seen = new Map<string, string>();

export function WorkspaceWorkbenchSync({ chatId, owner }: { chatId: string; owner: string }) {
  const visible = useAppVisibility() && useWorkspacePaneVisible();
  useEffect(() => {
    if (!visible) return;
    const api = (window as any).electronAPI;
    let disposed = false;
    let latestJob = '';
    const feed = new EventSource(workbenchUrl(chatId, 'events'));
    const execute = async (id: string) => {
      if (latestJob === id || !api?.workbenchPreviewAction) return;
      latestJob = id;
      const lease = await workbenchAction<{ job: PreviewJob | null; claim: string }>(chatId, 'claim-preview', { id });
      if (!lease.job) return;
      let result: PreviewResult;
      try {
        const tab = activeDevelopmentPreview(owner);
        if (!tab || disposed || !isAppVisible()) throw new Error('Open the intended local browser preview in this chat first.');
        result = await api.workbenchPreviewAction(tab.id, lease.job.action);
        for (let tries = 0; result.error === 'The preview is starting.' && tries < 5; tries++) {
          await new Promise(resolve => setTimeout(resolve, 160));
          if (disposed || !isAppVisible() || activeDevelopmentPreview(owner)?.id !== tab.id) break;
          result = await api.workbenchPreviewAction(tab.id, lease.job.action);
        }
      } catch (error) {
        result = { success: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1200) };
      }
      await workbenchAction(chatId, 'finish-preview', { id, claim: lease.claim, result });
    };
    feed.onmessage = event => {
      try {
        const { focus, previewJobId } = JSON.parse(event.data) as { focus?: WorkbenchFocus; previewJobId?: string };
        if (focus && seen.get(chatId) !== focus.id) {
          seen.set(chatId, focus.id);
          if (seen.size > 500) seen.delete(seen.keys().next().value!);
          openWorkbenchView(owner, chatId, focus.view, { url: focus.url, taskId: focus.taskId });
          if (focus.view === 'services' && focus.url && api?.workspaceBrowserCreate) {
            try { openDevelopmentPreview(owner, focus.url); }
            catch { /* The service stays available from the Workbench when the tab rail is full. */ }
          }
        }
        if (previewJobId) void execute(previewJobId).catch(() => {});
        notifyWorkbenchClient(chatId);
      } catch { /* A reconnect will deliver the latest state. */ }
    };
    return () => { disposed = true; feed.close(); };
  }, [chatId, owner, visible]);
  return null;
}
