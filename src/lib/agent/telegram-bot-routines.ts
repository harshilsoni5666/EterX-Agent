import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import { getEterxDataDir } from './storage-paths';
import { computeNextScheduledRun } from '../scheduled-tasks';

export type BotRoutine = { id: string; botId: string; conversationId: string; target: any; title: string; instructions: string; recurrence: string; nextAt: number; enabled: boolean; lastEventId?: string; lastRunAt?: number };
const file = path.join(getEterxDataDir(), 'telegram-bot-context', 'routines.json');
export function readBotRoutines(): BotRoutine[] {
  try { const value = fs.readJsonSync(file); return Array.isArray(value) ? value : []; } catch { return []; }
}
export function writeBotRoutines(routines: BotRoutine[]) {
  fs.ensureDirSync(path.dirname(file));
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(routines), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** The existing scheduled_tasks tool gets a Telegram destination, not a second
 * scheduler agent or a desktop chat. Changes stay scoped to the owning bot. */
export function operateBotRoutine(input: any, context: any) {
  const bot = context.telegramBot;
  const routines = readBotRoutines();
  const owned = routines.filter(item => item.botId === bot.id);
  if (input.operation === 'list') return { success: true, tasks: owned };
  const existing = owned.find(item => item.id === input.taskId);
  if (input.operation !== 'create' && !existing) return { success: false, message: 'This bot has no routine with that ID.' };
  if (input.operation === 'get') return { success: true, task: existing };
  if (input.operation === 'delete') { writeBotRoutines(routines.filter(item => item.id !== existing!.id)); return { success: true, message: 'Routine deleted.' }; }
  const routine: BotRoutine = existing ? { ...existing } : { id: randomUUID(), botId: bot.id, conversationId: context.ownerChatId || context.projectId, target: bot.target, title: '', instructions: '', recurrence: 'none', nextAt: Date.now(), enabled: true };
  if (input.title !== undefined) routine.title = String(input.title).trim().slice(0, 160);
  if (input.instructions !== undefined) routine.instructions = String(input.instructions).trim().slice(0, 16000);
  if (!routine.title || !routine.instructions) return { success: false, message: 'Provide a title and complete instructions.' };
  if (input.recurrence !== undefined) {
    const recurrence = String(input.recurrence).trim();
    if (!['none', 'once'].includes(recurrence) && computeNextScheduledRun(recurrence) === null) return { success: false, message: 'Invalid recurrence.' };
    routine.recurrence = recurrence;
  }
  if (input.scheduledAt !== undefined) {
    const timestamp = Date.parse(String(input.scheduledAt));
    if (!Number.isFinite(timestamp)) return { success: false, message: 'Use an ISO scheduledAt with a timezone.' };
    routine.nextAt = timestamp;
  }
  if (input.operation === 'pause') routine.enabled = false;
  if (['resume', 'run_now'].includes(input.operation)) { routine.enabled = true; if (input.operation === 'run_now') routine.nextAt = Date.now(); }
  if (!existing && owned.length >= 100) return { success: false, message: 'This bot has reached its 100 routine limit.' };
  writeBotRoutines([...routines.filter(item => item.id !== routine.id), routine]);
  return { success: true, task: routine, message: 'Routine saved. It uses this bot’s current model and agent and sends results to this Telegram conversation while the computer and EterX are running. If the bot is already working, the occurrence is skipped rather than queued.' };
}
