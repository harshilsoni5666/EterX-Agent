import { callGateway } from './gateway-client';
import { readBotRoutines, writeBotRoutines } from './telegram-bot-routines';
import { computeNextScheduledRun } from '../scheduled-tasks';

type RoutineEvent = { id: string; conversationId: string; botId: string };
const schedulerGlobal = globalThis as typeof globalThis & { __eterxBotRoutineTick?: Promise<RoutineEvent[]> };

/** Discover due work without importing AgentRegistry or any model SDK. The
 * renderer dispatches the accepted event IDs through the normal bot endpoint;
 * that runtime still owns deduplication and skipping busy conversations. */
export async function tickBotRoutines(): Promise<RoutineEvent[]> {
  if (schedulerGlobal.__eterxBotRoutineTick) return schedulerGlobal.__eterxBotRoutineTick;
  const tick = async () => {
    const events: RoutineEvent[] = [];
    const due = readBotRoutines().filter(item => item.enabled && item.nextAt <= Date.now());
    for (const routine of due) {
      const result = await callGateway('bot_routine_event', {
        target: routine.target, conversation_id: routine.conversationId,
        occurrence_id: `${routine.id}_${routine.nextAt}`,
        text: `[Scheduled routine: ${routine.title}]\n${routine.instructions}`,
      }).catch(() => null);
      if (!result?.eventId) continue;
      events.push({ id: result.eventId, conversationId: routine.conversationId, botId: routine.botId });
      const nextAt = computeNextScheduledRun(routine.recurrence, Date.now());
      // Do not overwrite a user's edit made while the gateway was responding.
      writeBotRoutines(readBotRoutines().map(item => item.id === routine.id && item.nextAt === routine.nextAt && item.enabled
        ? { ...item, nextAt: nextAt || item.nextAt, enabled: Boolean(nextAt), lastEventId: result.eventId }
        : item));
    }
    return events;
  };
  const pending = tick();
  schedulerGlobal.__eterxBotRoutineTick = pending;
  try { return await pending; }
  finally { if (schedulerGlobal.__eterxBotRoutineTick === pending) delete schedulerGlobal.__eterxBotRoutineTick; }
}
