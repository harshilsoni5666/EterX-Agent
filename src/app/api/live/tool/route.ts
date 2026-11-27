import { NextRequest, NextResponse } from 'next/server';
import '../../../../lib/agent/tools';
import { globalToolRegistry } from '../../../../lib/agent/tools/registry';
import { finishDesktopSession } from '../../../../lib/agent/computer/desktop-session';
import { telemetryClientContext } from '../../../../lib/telemetry/client-context';
import { withTelemetryScope } from '../../../../lib/telemetry/runtime';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  jsonError,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LIVE_CONTROL_TOOLS = new Set([
  'browser_control',
  'computer',
  'screen_agent',
  'screenshot_capture',
]);

export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const body = await readJsonObject(req);
    const chatId = cleanString(body.chatId, 180);
    const toolName = cleanString(body.toolName, 80);
    const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input)
      ? { ...body.input, chatId }
      : { chatId };

    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('A valid Live owner chat ID is required.', 400), session);
    }
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    if (!LIVE_CONTROL_TOOLS.has(toolName)) {
      return attachAgentApiSessionCookie(jsonError(`Live cannot invoke tool "${ toolName }".`, 403), session);
    }

    const tool = globalToolRegistry.getTool(toolName);
    if (!tool) {
      return attachAgentApiSessionCookie(jsonError(`Tool "${ toolName }" is unavailable.`, 404), session);
    }
    const parsed = await tool.inputSchema.safeParseAsync(input);
    if (!parsed.success) {
      return attachAgentApiSessionCookie(jsonError('Invalid Live tool arguments.', 400, {
        issues: parsed.error.issues.slice(0, 8),
      }), session);
    }

    const runId = cleanString(body.runId, 180) || `live-${session.sessionId}`;
    // Ending an owned desktop session is allowed even after access is revoked.
    // It does not grant input access or disconnect the browser.
    if (['screen_agent', 'computer'].includes(toolName) && (parsed.data as any).action === 'session_stop') {
      await finishDesktopSession({ chatId, runId }, body.endDesktopRun === true);
      return attachAgentApiSessionCookie(NextResponse.json({ success: true, toolName,
        result: { success: true, action: 'session_stop', result: 'Native desktop session ended.', desktopSession: { active: false } } }), session);
    }
    const computerUseEnabled = body.computerUseEnabled === true;
    const browserAccessEnabled = body.browserAccessEnabled === true;
    const result = await withTelemetryScope({ origin: 'interactive', feature: 'live', role: 'main' }, () => tool.execute(parsed.data, {
      chatId,
      projectId: chatId,
      runId,
      abortSignal: req.signal,
      agentSessionId: session!.sessionId,
      allowBrowserControl: browserAccessEnabled,
      allowHostControl: computerUseEnabled,
      computerUseEnabled,
      allowNetwork: true,
      networkPolicy: 'allow',
      allowedCapabilities: [
        ...(browserAccessEnabled ? ['browser.control'] : []),
        ...(computerUseEnabled ? ['host.control', 'host.screenshot'] : []),
        'network.public',
      ],
    }), { ...telemetryClientContext(req), interactionMode: 'live' });

    return attachAgentApiSessionCookie(NextResponse.json({
      success: result?.success !== false,
      toolName,
      result,
    }), session);
  } catch (error: any) {
    const response = NextResponse.json({
      success: false,
      error: error?.message || 'Live tool execution failed.',
    }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
