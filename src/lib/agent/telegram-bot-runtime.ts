import fs from 'fs-extra';
import path from 'path';
import { agentRegistry } from './agent-registry';
import { getEterxDataDir } from './storage-paths';
import { hydrateServerRuntimeSettings } from './server-runtime-hydration';
import { buildScopedRuntimeSettings } from './runtime-api-keys';
import { isModelProvider, isConcreteModelId, MODEL_PROVIDER_MODE } from './model-selector-store';
import { normalizeThinkingLevelForModel } from './model-routing';
import { getCodingMode } from '../code/coding-modes';
import { callGateway } from './gateway-client';
import { formatVisibleWorkNote } from './work-note';
import { loadCustomAgentProfile } from './builder-agent';
import { localFileLinks, localFileKey, replaceLocalFileLinks, renderTelegramText, cleanText } from './gateways/telegram-presentation.cjs';

type BotNote = { messageId?: number; messageIds?: number[]; text: string; source?: string };
type Receipt = { status: 'starting' | 'running' | 'done'; runId: string; event: any; bot: any; finalText?: string; deliveryId?: string; lastNote?: string; lastNoteAt?: number; activity?: string; startedAt?: number; statusNote?: BotNote; notes?: Record<string, BotNote>; sentFiles?: string[]; sentFileVersions?: Record<string, string>; artifactErrors?: Record<string, string>; preparedFinal?: string };
type BotConversation = { history: any[]; receipts: Record<string, Receipt>; handled?: string[]; quiet?: boolean };
const root = path.join(getEterxDataDir(), 'telegram-bot-context');
const runtimeGlobal = globalThis as typeof globalThis & { __eterxBotRuntime?: TelegramBotRuntime };

// Only public tool categories become fallback status, never tool arguments,
// outputs, internal reasoning, or model-generated claims of completion.
function toolActivity(name: string): string {
  if (/web_search|search_web/.test(name)) return 'Searching the web for your task.';
  if (/browser/.test(name)) return 'Working in the browser.';
  if (/screenshot|computer|desktop/.test(name)) return 'Working with the connected computer.';
  if (/gateway_bridge/.test(name)) return 'Working with the Telegram connection.';
  if (/scheduled_tasks/.test(name)) return 'Working on the requested schedule.';
  if (/image|video|audio/.test(name)) return 'Working with media for your task.';
  if (/file|folder|directory|document|spreadsheet/.test(name)) return 'Working with files for your task.';
  if (/command|terminal|shell/.test(name)) return 'Running a command for your task.';
  if (/spawn_sub_agent/.test(name)) return 'Coordinating agent work on your task.';
  return 'Working on your request.';
}

class TelegramBotRuntime {
  private contexts = new Map<string, BotConversation>();
  private contextLoads = new Map<string, Promise<BotConversation>>();
  private admissions = new Map<string, Promise<unknown>>();
  private incoming = new Map<string, Promise<unknown>>();
  private stoppedBefore = new Map<string, { timestamp: number; updateId: number }>();
  private monitors = new Set<string>();

  private async context(id: string) {
    if (!/^tbot_[a-f0-9]{40}$/.test(id)) throw new Error('Invalid bot conversation.');
    if (!this.contexts.has(id)) {
      let loading = this.contextLoads.get(id);
      if (!loading) {
        loading = fs.readJson(path.join(root, `${id}.json`)).catch(() => ({ history: [], receipts: {} })).then(stored => {
          this.contexts.set(id, stored); return stored;
        });
        this.contextLoads.set(id, loading);
      }
      try { await loading; } finally { this.contextLoads.delete(id); }
    }
    return this.contexts.get(id)!;
  }
  private save(id: string, context: BotConversation) {
    const completed = Object.entries(context.receipts).filter(([, receipt]) => receipt.status === 'done');
    for (const [key] of completed.slice(0, Math.max(0, completed.length - 100))) delete context.receipts[key];
    let historyChars = context.history.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
    while (historyChars > 240000 && context.history.length > 4) historyChars -= JSON.stringify(context.history.shift()).length;
    // Synchronous atomic writes serialize monitor and incoming-message updates.
    fs.ensureDirSync(root);
    const file = path.join(root, `${id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(context), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  async dispatch(eventId: string) {
    const existing = this.incoming.get(eventId);
    if (existing) return existing;
    const incoming = this.dispatchIncoming(eventId);
    this.incoming.set(eventId, incoming);
    try { return await incoming; }
    finally { if (this.incoming.get(eventId) === incoming) this.incoming.delete(eventId); }
  }
  private async dispatchIncoming(eventId: string) {
    const { event, bot } = await callGateway('bot_event_get', { event_id: eventId });
    const control = ['/stop', '/status', '/peek', '/quiet', '/updates'].includes(String(event.text || '').trim());
    if (event.text === '/stop' && (!event.metadata?.targetRunId || event.metadata.targetRunId === agentRegistry.getTraces(event.conversationId).runId)) this.stoppedBefore.set(event.conversationId, { timestamp: Number(event.receivedAt) || Date.now(), updateId: Number(event.metadata?.updateId) });
    // Controls, explicit answers and live text steering must not wait behind
    // attachment downloads. Only admission of a new execution is serialized.
    if (control || event.metadata?.responseKey || (agentRegistry.isRunning(event.conversationId) && !event.attachments?.length)) {
      return this.admit(event, bot);
    }
    const previous = this.admissions.get(event.conversationId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.admit(event, bot));
    this.admissions.set(event.conversationId, next);
    try { return await next; }
    finally { if (this.admissions.get(event.conversationId) === next) this.admissions.delete(event.conversationId); }
  }
  private async send(event: any, text: string, key?: string) {
    return callGateway('messages_send', { platform: 'telegram', target: event.replyTarget, text, delivery_key: key });
  }
  private async ack(event: any) {
    const context = await this.context(event.conversationId);
    context.handled = [...new Set([...(context.handled || []), event.id])].slice(-2000);
    this.save(event.conversationId, context);
    await callGateway('bot_event_ack', { event_id: event.id });
  }
  private wasStopped(event: any) {
    const cutoff = this.stoppedBefore.get(event.conversationId);
    if (!cutoff) return false;
    const updateId = Number(event.metadata?.updateId);
    return Number.isFinite(updateId) && Number.isFinite(cutoff.updateId)
      ? updateId <= cutoff.updateId : Number(event.receivedAt) <= cutoff.timestamp;
  }
  private async admit(event: any, bot: any) {
    const id = event.conversationId;
    const context = await this.context(id);
    if (context.handled?.includes(event.id)) { await this.ack(event); return { status: 'accepted' }; }
    const receipt = context.receipts[event.id];
    if (receipt) {
      if (receipt.status === 'done') { await this.ack(event); return { status: 'accepted' }; }
      if (receipt.finalText !== undefined) { this.monitor(id, receipt); return { status: 'delivering' }; }
      const run = agentRegistry.getTraces(id, -1, receipt.runId);
      if (run.status !== 'idle') { this.monitor(id, receipt); return { status: 'running' }; }
      // A crashed process cannot prove which external actions happened. Never
      // automatically replay side-effectful work on recovery.
      receipt.finalText = 'EterX restarted while I was working. The conversation context is saved. Send “continue” so I can inspect the current state before resuming.';
      this.save(id, context); this.monitor(id, receipt);
      return { status: 'interrupted' };
    }
    const text = String(event.text || '').trim();
    const current = agentRegistry.getTraces(id);
    if (event.metadata?.routine && current.status === 'running') {
      await this.ack(event); return { status: 'skipped-overlap' };
    }
    if (text === '/stop') {
      if (event.metadata?.targetRunId && event.metadata.targetRunId !== current.runId) {
        await this.send(event, 'That task has already ended. Use /stop to stop the current task.', event.id);
        await this.ack(event); return { status: 'expired' };
      }
      agentRegistry.stopAgent(id, 'Stopped from Telegram.', undefined, current.runId);
      await this.send(event, current.status === 'running' ? 'Stopping the current task.' : 'There is no running task in this conversation.', event.id);
      await this.ack(event); return { status: 'stopped' };
    }
    if (text === '/status' || text === '/peek') {
      const recent = Object.values(context.receipts).reverse();
      const active = recent.find(item => item.runId === current.runId) || recent[0];
      const model = current.status === 'running' && active?.bot?.model ? active.bot.model : bot.model;
      const waiting = Object.values((globalThis as any).__pendingAskUser || {}).some((question: any) => question.chatId === id && question.status === 'pending');
      const detail = current.status === 'running'
        ? [waiting ? 'Waiting for your answer to the question above.' : active?.activity || 'Working on your request.', active?.lastNote && !waiting ? `Latest update: ${renderTelegramText(active.lastNote).text.slice(0, 1400)}` : ''].filter(Boolean).join('\n\n')
        : active?.preparedFinal || active?.finalText || 'Ready for your next task.';
      await this.send(event, `${bot.name} · ${current.status === 'idle' ? 'ready' : current.status}${text === '/status' ? `\n${model.provider} / ${model.modelId}${context.quiet ? '\nWork updates are off. Use /updates to enable them.' : ''}` : ''}\n\n${renderTelegramText(detail).text.slice(0, 2600)}`, event.id);
      await this.ack(event); return { status: current.status };
    }
    if (text === '/quiet' || text === '/updates') {
      context.quiet = text === '/quiet'; this.save(id, context);
      if (current.status === 'running') agentRegistry.addSteeringMessage(id, context.quiet ? 'Turn off optional work updates in this conversation. Continue the task; send deliverables, the result, and necessary questions only.' : 'Resume concise, meaningful work updates while continuing the task.', event.id, { createdAt: event.receivedAt }, current.runId);
      await this.send(event, context.quiet ? 'Work updates are off for this conversation. I’ll still send results, files and necessary questions. Use /updates to turn them back on.' : 'Work updates are on for this conversation.', event.id);
      await this.ack(event); return { status: 'accepted' };
    }
    let attachments: any[] = [];
    try {
      if (event.attachments?.length) attachments = await callGateway('bot_attachments', { event_id: event.id });
    } catch (error: any) {
      const detail = String(error?.message || 'The attachment could not be downloaded.').slice(0, 400);
      await this.send(event, `I couldn’t retrieve that attachment. ${detail} Please resend it when the connection is available.`, event.id);
      await this.ack(event); return { status: 'attachment-error' };
    }
    if (this.wasStopped(event)) {
      await this.ack(event); return { status: 'cancelled' };
    }
    const pending = (globalThis as any).__pendingAskUser || {};
    const explicitQuestion = event.metadata?.forceSteering ? undefined : event.metadata?.responseKey;
    const matches = Object.entries(pending).filter(([, value]: [string, any]) => value.chatId === id && value.status === 'pending');
    // Reply-to and buttons address a particular question. A plain message can
    // answer the single pending question, otherwise it remains live steering.
    const singleQuestion: any = matches.length === 1 ? matches[0] : null;
    const canAnswerDirectly = !event.metadata?.forceSteering && singleQuestion && (singleQuestion[1].mode !== 'confirm' || /^(yes|no|approve|decline|cancel)$/i.test(text));
    const questionEntry: any = explicitQuestion ? matches.find(([key]) => key === explicitQuestion) : canAnswerDirectly ? singleQuestion : null;
    if (explicitQuestion && !questionEntry) {
      await this.send(event, 'That question has already been answered or expired. Send a new message to continue.', event.id);
      await this.ack(event); return { status: 'expired' };
    }
    if (questionEntry && (text || attachments.length)) {
      const question = questionEntry[1];
      if (question.mode === 'confirm' && !/^(yes|no|approve|decline|cancel)$/i.test(text)) {
        await this.send(event, 'Please tap Approve or Decline, or reply yes or no to the question.', event.id);
        await this.ack(event); return { status: 'needs-answer' };
      }
      const options = question.options || [];
      const numberSelections = question.mode === 'multi_select' && /^\d+(?:\s*[,;]\s*\d+)*$/.test(text) ? [...new Set(text.split(/[,;]/).map(Number))] : [];
      if (numberSelections.some(index => index < 1 || index > options.length)) {
        await this.send(event, `Choose option numbers from 1 to ${options.length}, or reply in your own words.`, event.id);
        await this.ack(event); return { status: 'needs-answer' };
      }
      const option = event.metadata?.selectedOption || (numberSelections.length ? numberSelections.map(index => options[index - 1]) : options.find((item: any) => [item.label, item.value].some(value => String(value).toLowerCase() === text.toLowerCase())) || (/^[1-8]$/.test(text) ? options[Number(text) - 1] : null));
      const answers = question.questions?.length ? text.split('\n').filter(Boolean) : [];
      if (question.questions?.length && answers.length !== question.questions.length) {
        await this.send(event, `Please reply with ${question.questions.length} answers, one per line.`, event.id);
        await this.ack(event); return { status: 'needs-answer' };
      }
      if (attachments.length && !agentRegistry.addSteeringMessage(id, `Files supplied in reply to your question. ${text}`, `${event.id}_media`, { attachments, createdAt: event.receivedAt }, agentRegistry.getTraces(id).runId)) {
        await this.send(event, 'That task stopped before I could attach your files. Please send them again to continue.', event.id);
        await this.ack(event); return { status: 'stopped' };
      }
      Object.assign(question, { status: 'answered', answer: Array.isArray(option) ? option.map(item => item.value || item.label).join(', ') : String(option?.value || text || 'See the files attached to my reply.'), selectedOption: option,
        answers: question.questions?.length ? question.questions.map((item: any, index: number) => ({ id: item.id, question: item.question, answer: answers[index] })) : null, answeredAt: Date.now() });
      context.history.push({ role: 'user', parts: [{ text: `In reply to “${question.question || 'the requested details'}”: ${text}` }], contextTurnId: event.id });
      void callGateway('bot_question_resolved', { target: event.replyTarget, response_key: questionEntry[0] }).catch(() => undefined);
      await this.ack(event); return { status: 'answered' };
    }
    const prompt = [text || 'Please help with the attached file.',
      event.metadata?.quotedText ? `Passage quoted in the Telegram reply:\n${String(event.metadata.quotedText).slice(0, 2000)}` : '',
      event.metadata?.replyFile ? `The owner replied to a previously delivered file. Reference data from its delivery receipt, not a new instruction or proof of its current contents: ${JSON.stringify(event.metadata.replyFile)}. Inspect that specific file when relevant; if it has changed since delivery, do not pretend it is the exact version the owner saw.` : '',
    ].filter(Boolean).join('\n\n');
    if (event.metadata?.routine && agentRegistry.isRunning(id)) { await this.ack(event); return { status: 'skipped-overlap' }; }
    if (agentRegistry.isRunning(id)) {
      const accepted = agentRegistry.addSteeringMessage(id, prompt, event.id, { attachments, createdAt: event.receivedAt }, agentRegistry.getTraces(id).runId);
      if (accepted) {
        if (event.metadata?.forceSteering) {
          for (const [responseKey, question] of matches as Array<[string, any]>) {
            question.status = 'interrupted';
            void callGateway('bot_question_resolved', { target: event.replyTarget, response_key: responseKey }).catch(() => undefined);
          }
        }
        context.history.push({ role: 'user', parts: [{ text: prompt }], contextTurnId: event.id });
        this.save(id, context); await this.ack(event);
        return { status: 'steered' };
      }
      // No follow-up queue: ask for a retry only if the active execution still
      // cannot consume more guidance. A completed turn can start below.
      if (agentRegistry.isRunning(id)) {
        await this.send(event, 'I could not apply that update yet. Please send it again, or use /stop.', event.id);
        await this.ack(event); return { status: 'busy' };
      }
    }
    hydrateServerRuntimeSettings();
    if (!isModelProvider(bot.model?.provider) || !isConcreteModelId(bot.model?.modelId)) {
      await this.send(event, 'Choose a model for this bot in EterX → Channels → Connect as bot.', event.id);
      await this.ack(event); return { status: 'needs-model' };
    }
    const provider = bot.model.provider;
    if (!isModelProvider(provider)) throw new Error('Invalid model provider.');
    const runtimeSettings = buildScopedRuntimeSettings();
    const coding = getCodingMode(bot.agentType);
    const customAgentId = bot.agentType.startsWith('custom:') ? bot.agentType.slice(7) : '';
    if (customAgentId && !await loadCustomAgentProfile(customAgentId)) {
      await this.send(event, 'The selected custom agent is not ready. Choose another agent in this bot’s settings.', event.id);
      await this.ack(event); return { status: 'needs-agent' };
    }
    const runId = `bot_run_${event.id}`;
    const pinned = {
      triggerSource: 'gateway', source: 'telegram-bot', runLocation: 'local',
      ownerChatId: id, agentSessionId: `telegram_bot_${bot.id}_${id}`, agentName: bot.name,
      telegramBot: { id: bot.id, name: bot.name, instructions: bot.instructions, target: event.replyTarget, quiet: context.quiet === true, startedAt: Date.now(),
        // Preserve references to updates delivered by older runtime versions,
        // before work notes were included in the model's conversation history.
        recentDeliveredUpdates: Object.values(context.receipts).slice(-3).flatMap(item => Object.entries(item.notes || {})
          .filter(([key, note]) => note.messageId && !context.history.some(turn => turn.contextTurnId === `${item.runId}:note:${key}`))
          .map(([, note]) => cleanText(note.text).slice(0, 600))).slice(-4),
        recentDeliveredFiles: Object.values(context.receipts).slice(-3).flatMap(item => (item.sentFiles || []).map(file => ({ path: file, versionAtDelivery: item.sentFileVersions?.[localFileKey(file)] }))).slice(-6),
      },
      workspacePath: bot.workspacePath || undefined,
      ...(bot.workspacePath ? { paths: [bot.workspacePath], isFocusedWorkspace: true } : {}),
      selectedModelProvider: bot.model.provider, selectedModelName: bot.model.modelId, strictModelSelection: true,
      thinkingLevel: normalizeThinkingLevelForModel(bot.thinkingLevel, bot.model.provider, bot.model.modelId),
      allowBrowserControl: bot.allowBrowserControl, allowHostControl: bot.allowHostControl, computerUseEnabled: bot.allowHostControl,
      disableSharedCache: true, exportTranscript: false,
      ...(coding ? { agentRuntime: 'main_coding_agent', agentProfile: coding.profile, agentId: coding.id } : {}),
      ...(customAgentId ? { agentRuntime: 'custom_agent', customAgentId, customAgentName: bot.name } : {}),
    };
    const entry: Receipt = { status: 'starting', runId, event, bot, sentFiles: [], startedAt: Date.now() };
    context.receipts[event.id] = entry;
    this.save(id, context);
    await agentRegistry.waitForStoppedRunToSettle(id, 5000);
    if (this.wasStopped(event)) {
      delete context.receipts[event.id];
      await this.ack(event); return { status: 'cancelled' };
    }
    const result = agentRegistry.startAgent(id, prompt, context.history.slice(-80), MODEL_PROVIDER_MODE[provider], `telegram_${bot.id}_${event.actor.id}`, pinned, attachments, event.actor.displayName || 'Owner', runtimeSettings.preferredGeminiApiKey, runtimeSettings, runId);
    context.history.push({ role: 'user', parts: [{ text: prompt }], contextTurnId: runId });
    context.history = context.history.slice(-160);
    if (result.status !== 'started') entry.finalText = `I couldn’t start: ${result.message}. Update this bot’s settings or send your message again.`;
    else entry.status = 'running';
    this.save(id, context);
    this.monitor(id, entry);
    return result;
  }

  private monitor(id: string, receipt: Receipt) {
    if (this.monitors.has(receipt.runId)) return;
    this.monitors.add(receipt.runId);
    void this.observe(id, receipt).catch(() => {
      // Keep the event unacknowledged. The desktop reconciliation pass retries
      // delivery or attaches to the same run; it never starts duplicate work.
    }).finally(() => this.monitors.delete(receipt.runId));
  }

  private rememberVisibleMessage(context: BotConversation, key: string, text: string) {
    const value = cleanText(text).trim();
    if (!value) return;
    const existing = context.history.find(turn => turn.role === 'model' && turn.contextTurnId === key);
    if (existing) existing.parts = [{ text: value }];
    else context.history.push({ role: 'model', parts: [{ text: value }], contextTurnId: key, telegramVisible: true });
  }

  private async deliverArtifacts(id: string, context: BotConversation, receipt: Receipt, source: string) {
    const text = cleanText(source);
    receipt.sentFileVersions ||= {};
    receipt.artifactErrors ||= {};
    const attached = new Set<string>();
    for (const link of localFileLinks(text)) {
      if (!link.path) continue;
      const key = localFileKey(link.path);
      if (attached.has(key)) continue;
      try {
        const stat = await fs.stat(link.path);
        if (!stat.isFile()) throw new Error('The linked item is not a file.');
        const version = `${stat.size}:${stat.mtimeMs}`;
        const legacySent = receipt.sentFiles?.some(file => localFileKey(file) === key) && !receipt.sentFileVersions[key];
        if (legacySent || receipt.sentFileVersions[key] === version) {
          receipt.sentFileVersions[key] = version; attached.add(key); delete receipt.artifactErrors[key]; continue;
        }
        const result = await callGateway('files_send', { target: receipt.event.replyTarget, file_path: link.path, caption: link.label.slice(0, 900), as_photo: link.image || /\.(png|jpe?g|webp)$/i.test(link.path), media_type: /\.mp4$/i.test(link.path) ? 'video' : undefined });
        receipt.sentFileVersions[key] = result?.eterx_file ? `${result.eterx_file.size}:${result.eterx_file.mtimeMs}` : version;
        receipt.sentFiles = [...new Set([...(receipt.sentFiles || []), link.path])];
        attached.add(key); delete receipt.artifactErrors[key]; this.save(id, context);
      } catch (error: any) {
        const name = link.path.replace(/\\/g, '/').split('/').pop() || 'this file';
        const reason = error?.code === 'ENOENT' ? 'The file no longer exists on the connected computer.' : String(error?.message || 'Please ask me to send it again.').slice(0, 240);
        receipt.artifactErrors[key] = `I couldn’t attach ${name}. ${reason}`;
      }
    }
    return replaceLocalFileLinks(text, link => `${link.label || link.path?.replace(/\\/g, '/').split('/').pop() || 'File'}${link.path && attached.has(localFileKey(link.path)) ? ' (attached)' : ''}`);
  }

  private async clearStatus(receipt: Receipt, force = false) {
    if (!receipt.statusNote && !force) return;
    const result = await callGateway('bot_progress', { target: receipt.event.replyTarget, clear: true, progress_key: `${receipt.runId}:activity`, message_ids: receipt.statusNote?.messageIds }).catch(() => null);
    if (result) receipt.statusNote = undefined;
  }
  private async observe(id: string, receipt: Receipt) {
    const context = await this.context(id);
    let cursor = -1; let lastProgress = 0; let lastTyping = 0; let lastAccess = 0; let lastStatus = 0;
    const questions = new Set<string>();
    const pendingNotes = new Map<string, string>();
    const noteChangedAt = new Map<string, number>();
    const activeTools = new Map<string, string>();
    receipt.startedAt ||= Date.now();
    receipt.notes ||= {};
    while (receipt.finalText === undefined) {
      if (Date.now() - lastAccess > 8000) {
        try { await callGateway('bot_access_check', { target: receipt.event.replyTarget }); }
        catch (error: any) {
          if (['BOT_DISABLED', 'BOT_NOT_PAIRED'].includes(error?.code)) {
            agentRegistry.stopAgent(id, 'Telegram bot disconnected or paused.', undefined, receipt.runId);
            throw error;
          }
          // A gateway restart/network interruption is not a revoked pairing.
          // Keep the task alive and retry delivery from its durable receipt.
        }
        lastAccess = Date.now();
      }
      const state = agentRegistry.getTraces(id, cursor, receipt.runId);
      cursor = state.maxIndex;
      for (const trace of state.traces) {
        if (trace.subAgentId || trace.subAgentChatId || trace.auxiliaryRuntime) continue;
        const tool = String(trace.toolName || trace.tool || (trace.type === 'tool_call' ? trace.name : '') || '');
        if (tool) {
          const key = String(trace.toolCallId || trace.traceId || trace.id || tool);
          if (trace.type === 'tool_result' || trace.endTime || ['completed', 'complete', 'failed', 'error', 'cancelled', 'success'].includes(trace.status)) activeTools.delete(key);
          else if (trace.type === 'tool_call' || trace.status === 'running') activeTools.set(key, toolActivity(tool));
        }
        if ((trace.type === 'work_note' && trace.text) || (trace.type === 'answer_cancel' && trace.replacementText)) {
          const clean = formatVisibleWorkNote(cleanText(trace.text || trace.replacementText));
          const key = String(trace.noteId || trace.replacementNoteId || trace.id || trace.startTime || trace.timestamp);
          if (clean && clean !== pendingNotes.get(key) && clean !== receipt.notes[key]?.source) { pendingNotes.set(key, clean); noteChangedAt.set(key, Date.now()); }
        }
        if (trace.type === 'telegram_file_sent' && trace.path) {
          receipt.sentFiles = [...new Set([...(receipt.sentFiles || []), String(trace.path)])];
          if (Number.isFinite(trace.size) && Number.isFinite(trace.mtimeMs)) {
            receipt.sentFileVersions ||= {};
            receipt.sentFileVersions[localFileKey(trace.path)] = `${trace.size}:${trace.mtimeMs}`;
          }
          this.save(id, context);
        }
        if (trace.type === 'ask_user' && trace.responseKey && !questions.has(trace.responseKey)) {
          const pending = (globalThis as any).__pendingAskUser?.[trace.responseKey];
          if (pending?.status === 'pending') {
            await callGateway('bot_question', { target: receipt.event.replyTarget, question: trace, conversation_id: id });
            questions.add(trace.responseKey);
            const questionText = [trace.question || 'A few details before I continue', trace.context,
              ...(trace.options || []).map((option: any) => `${option.label}${option.description ? ': ' + option.description : ''}`),
              ...(trace.questions || []).map((question: any) => `${question.question}${question.options?.length ? '\n' + question.options.map((option: any) => option.label).join(' / ') : ''}`),
            ].filter(Boolean).join('\n');
            this.rememberVisibleMessage(context, `${receipt.runId}:question:${trace.responseKey}`, questionText);
            receipt.lastNote = 'Waiting for your answer in Telegram.';
            receipt.lastNoteAt = Date.now();
            this.save(id, context);
          }
        }
      }
      const waiting = Object.values((globalThis as any).__pendingAskUser || {}).some((question: any) => question.chatId === id && question.status === 'pending');
      if (!waiting && receipt.lastNote === 'Waiting for your answer in Telegram.') receipt.lastNote = undefined;
      receipt.activity = waiting ? 'Waiting for your answer in Telegram.' : Array.from(activeTools.values()).at(-1) || 'Working on your request.';
      for (const key of questions) {
        if ((globalThis as any).__pendingAskUser?.[key]?.status !== 'pending' || state.status !== 'running') {
          const resolved = await callGateway('bot_question_resolved', { target: receipt.event.replyTarget, response_key: key }).catch(() => null);
          if (resolved) questions.delete(key);
        }
      }
      if (context.quiet || waiting) await this.clearStatus(receipt);
      if (pendingNotes.size && (Date.now() - lastProgress > 3000 || state.status !== 'running')) {
        for (const [key, note] of pendingNotes) {
          if (state.status === 'running' && Date.now() - (noteChangedAt.get(key) || 0) < 1200) continue;
          if (context.quiet) { pendingNotes.delete(key); continue; }
          const existing = receipt.notes[key];
          if (existing?.source === note) { pendingNotes.delete(key); continue; }
          const visible = await this.deliverArtifacts(id, context, receipt, note);
          const result = await callGateway('bot_progress', { target: receipt.event.replyTarget, text: visible, message_id: existing?.messageId, message_ids: existing?.messageIds, progress_key: `${receipt.runId}:${key}` }).catch(() => null);
          if (result?.message_id) {
            receipt.notes[key] = { messageId: result.message_id, messageIds: result.message_ids, text: visible, source: note };
            this.rememberVisibleMessage(context, `${receipt.runId}:note:${key}`, visible);
            receipt.lastNote = visible; receipt.lastNoteAt = Date.now(); pendingNotes.delete(key);
            await this.clearStatus(receipt); this.save(id, context);
          }
        }
        lastProgress = Date.now();
      }
      if (state.status !== 'running') {
        receipt.finalText = state.status === 'completed' ? state.finalAnswer || 'Finished.' : state.status === 'stopped' ? 'Stopped. Send a message when you want to continue.' : state.status === 'idle' ? 'The run was interrupted. Send “continue” to resume from the saved context.' : `I couldn’t finish this task. ${state.error || 'Please try again.'}`;
        context.history.push({ role: 'model', parts: [{ text: receipt.finalText }], contextTurnId: receipt.runId });
        this.save(id, context); break;
      }
      if (!context.quiet && !waiting && Date.now() - receipt.startedAt > 12000 && Date.now() - (receipt.lastNoteAt || 0) > 45000 && Date.now() - lastStatus > 15000) {
        const minutes = Math.floor((Date.now() - receipt.startedAt) / 60000);
        const status = `${receipt.activity}${minutes ? `\nRunning for ${minutes} min.` : ''}\nYou can send guidance while I work.`;
        if (receipt.statusNote?.text !== status) {
          const result = await callGateway('bot_progress', { target: receipt.event.replyTarget, text: status, message_ids: receipt.statusNote?.messageIds, progress_key: `${receipt.runId}:activity`, controls: true, run_id: receipt.runId }).catch(() => null);
          if (result?.message_id) { receipt.statusNote = { messageId: result.message_id, messageIds: result.message_ids, text: status }; this.save(id, context); }
        }
        lastStatus = Date.now();
      }
      if (Date.now() - lastTyping > 4500) { void callGateway('bot_typing', { target: receipt.event.replyTarget }).catch(() => undefined); lastTyping = Date.now(); }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await this.clearStatus(receipt, true);
    // Only explicit deliverable links are uploaded. Tool arguments, private
    // reasoning and arbitrary filesystem observations never become attachments.
    if (!receipt.preparedFinal) {
      const text = await this.deliverArtifacts(id, context, receipt, receipt.finalText || 'Finished.');
      const errors = Object.values(receipt.artifactErrors || {});
      receipt.preparedFinal = [text, ...errors].filter(Boolean).join('\n\n') || 'Finished.';
      this.save(id, context);
    }
    const delivery = await this.send(receipt.event, receipt.preparedFinal, receipt.runId);
    if (!delivery?.ok && !delivery?.retrying) throw new Error('Telegram delivery failed.');
    this.rememberVisibleMessage(context, receipt.runId, receipt.preparedFinal);
    receipt.deliveryId = delivery.deliveryId;
    receipt.status = 'done'; this.save(id, context);
    await this.ack(receipt.event);
  }
}

export const telegramBotRuntime = runtimeGlobal.__eterxBotRuntime ||= new TelegramBotRuntime();
