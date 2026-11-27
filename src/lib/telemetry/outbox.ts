import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getEterxDataDir } from '../agent/storage-paths';
import { openApplicationDatabase } from '../imports/sqlite-reader';
import {
  BATCH_LIMIT, DAY_MS, DELIVERY_DAYS, normalizeMeasurements,
  type Measurements, type TelemetryEvent, type TelemetryProperties,
} from './protocol';

const LEASE_MS = 45_000;
const MAX_EVENT_ROWS = 100_000;
const RECENT_EVENTS_PER_BATCH = 20;

interface TurnRow {
  id: string;
  pid: number;
  started_at: number;
  finish_id: string;
  dimensions: string;
  measurements: string;
  properties: string;
  sent_at: number | null;
  session_stop_id: string | null;
  session_dimensions: string | null;
}

type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export function openOutbox(owner = randomUUID()) {
  const directory = path.join(getEterxDataDir(), 'telemetry');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = openApplicationDatabase(path.join(directory, 'outbox.sqlite'));
  try {
    db.exec(`
      PRAGMA busy_timeout = 500;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS delivery (
        id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL,
        lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, at INTEGER NOT NULL, payload TEXT
      );
      CREATE INDEX IF NOT EXISTS queued_events ON events(sequence) WHERE payload IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE TABLE IF NOT EXISTS posthog_batches (
        id TEXT PRIMARY KEY, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS posthog_batches_ready ON posthog_batches(retry_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at INTEGER NOT NULL,
        finish_id TEXT NOT NULL, dimensions TEXT NOT NULL, measurements TEXT NOT NULL DEFAULT '{}',
        finished INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS open_turns ON turns(pid) WHERE finished = 0;
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(turns)').all().map(row => row.name));
      if (!columns.has('properties')) db.exec("ALTER TABLE turns ADD COLUMN properties TEXT NOT NULL DEFAULT '{}'");
      if (!columns.has('owner')) db.exec('ALTER TABLE turns ADD COLUMN owner TEXT');
      if (!columns.has('sent_at')) db.exec('ALTER TABLE turns ADD COLUMN sent_at INTEGER');
      if (!columns.has('session_stop_id')) db.exec('ALTER TABLE turns ADD COLUMN session_stop_id TEXT');
      if (!columns.has('session_dimensions')) db.exec('ALTER TABLE turns ADD COLUMN session_dimensions TEXT');
      const eventColumns = new Set(db.prepare('PRAGMA table_info(events)').all().map(row => row.name));
      if (!eventColumns.has('batch_id')) db.exec('ALTER TABLE events ADD COLUMN batch_id TEXT');
      db.exec(`CREATE INDEX IF NOT EXISTS unassigned_events ON events (sequence)
        WHERE payload IS NOT NULL AND batch_id IS NULL;
        CREATE INDEX IF NOT EXISTS events_by_batch ON events (batch_id, sequence) WHERE batch_id IS NOT NULL;`);
      // The previous receiver's network cooldown does not apply to PostHog.
      db.prepare('INSERT OR IGNORE INTO delivery (id, token) VALUES (1, ?)').run(randomBytes(32).toString('hex'));
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version < 2) db.exec('UPDATE delivery SET retry_at = 0, failures = 0 WHERE id = 1; PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }
  const token = String(db.prepare('SELECT token FROM delivery WHERE id = 1').get()?.token);
  if (!/^[0-9a-f]{64}$/.test(token)) {
    db.close();
    throw new Error('The local telemetry installation credential is unavailable.');
  }
  const knownEvent = db.prepare('SELECT 1 FROM events WHERE id = ?');
  const insertEvent = db.prepare('INSERT INTO events (id, at, payload) VALUES (?, ?, ?)');
  const getTurn = db.prepare('SELECT * FROM turns WHERE id = ? AND finished = 0');
  const acknowledge = db.prepare('UPDATE events SET payload = NULL, batch_id = NULL WHERE id = ? AND batch_id = ?');
  const closeTurn = db.prepare(`UPDATE turns SET finished = 1, dimensions = '{}', measurements = '{}',
    properties = '{}', session_dimensions = NULL WHERE id = ?`);

  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // The payload is cleared on acknowledgement. Its compact ID stays for local deduplication.
  function append(event: TelemetryEvent): boolean {
    if (knownEvent.get(event.id)) return false;
    const insertedAt = Date.now();
    insertEvent.run(event.id, event.at, JSON.stringify({ ...event, receivedAt: event.receivedAt ?? insertedAt, insertedAt }));
    return true;
  }

  function settle(id: string, outcome: Outcome, at?: number) {
    const turn = getTurn.get(id) as TurnRow | undefined;
    if (!turn) return;
    const dimensions = JSON.parse(turn.dimensions) as TelemetryEvent['dimensions'];
    const measurements = JSON.parse(turn.measurements) as Measurements;
    const properties = JSON.parse(turn.properties) as TelemetryProperties;
    const sentAt = turn.sent_at === null ? undefined : Number(turn.sent_at);
    const observed = sentAt !== undefined;
    const occurred = at ?? sentAt ?? Number(turn.started_at);
    if (at !== undefined) {
      measurements.durationMs = Math.max(0, at - turn.started_at);
      measurements.durationReports = 1;
    }
    const usageReported = (measurements.usageReports ?? 0) > 0;
    const requests = measurements.requests ?? 0;
    const childRequests = measurements.childRequests ?? 0;
    const childReports = measurements.childUsageReports ?? 0;
    const terminalStatus = outcome === 'succeeded' ? 'completed' : outcome;
    append({
      id: turn.finish_id, name: 'provider.turn.completed', at: occurred,
      dimensions: { ...dimensions, outcome }, measurements: normalizeMeasurements(measurements),
      properties: { ...properties, terminalStatus, lifecycleObserved: observed && at !== undefined,
        usageScope: 'turn', usageReported, usageStatus: usageReported
          ? (measurements.usageReports === requests && measurements.inputReports === requests && measurements.outputReports === requests
            ? 'reported' : 'partial') : 'missing',
        ...(childRequests > 0 ? { childUsageStatus: childReports === 0 ? 'missing'
          : childReports === childRequests ? 'reported' : 'partial' } : {}) },
    });
    if (turn.session_stop_id && sentAt !== undefined && turn.session_dimensions) {
      const sessionDimensions = JSON.parse(turn.session_dimensions) as TelemetryEvent['dimensions'];
      append({
        id: turn.session_stop_id, name: 'provider.session.stopped', at: occurred,
        dimensions: { ...sessionDimensions, outcome },
        properties: { ...properties, provider: sessionDimensions.provider, model: sessionDimensions.model,
          observedModel: undefined, terminalStatus, lifecycleObserved: at !== undefined },
        measurements: at === undefined ? undefined : {
          durationMs: Math.max(0, at - sentAt), durationReports: 1,
        },
      });
    }
    if (dimensions.feature === 'builder') append({
      id: randomUUID().replaceAll('-', ''), name: 'feature.used', at: occurred,
      dimensions: { ...dimensions, outcome }, properties: { ...properties, terminalStatus },
      measurements: { durationMs: measurements.durationMs, durationReports: measurements.durationReports },
    });
    closeTurn.run(id);
  }

  return {
    token,
    record(event: TelemetryEvent, turnId?: string, usage?: 'main' | 'child') {
      transaction(() => {
        if (!append(event) || !turnId) return;
        const turn = getTurn.get(turnId) as TurnRow | undefined;
        if (!turn) return;
        const totals = JSON.parse(turn.measurements) as Measurements;
        const properties = JSON.parse(turn.properties) as TelemetryProperties;
        if (usage === 'main' && event.measurements) {
          for (const [key, value] of Object.entries(event.measurements)) {
            const measurement = key as keyof Measurements;
            if (value !== undefined && key !== 'durationMs' && key !== 'durationReports') {
              totals[measurement] = (totals[measurement] ?? 0) + value;
            }
          }
          const observed = event.properties?.observedModel;
          const requested = JSON.parse(turn.dimensions) as TelemetryEvent['dimensions'];
          if (requested.provider && event.dimensions.provider !== requested.provider) properties.crossProvider = true;
          else if (observed) {
            if (properties.observedModel && properties.observedModel !== observed) properties.mixedModels = true;
            properties.observedModel ??= observed;
          }
        } else if (usage === 'child' && event.measurements) {
          const { inputTokens, outputTokens, usageReports } = event.measurements;
          totals.childRequests = (totals.childRequests ?? 0) + 1;
          totals.childUsageReports = (totals.childUsageReports ?? 0) + (usageReports ?? 0);
          if (inputTokens !== undefined) totals.childInputTokens = (totals.childInputTokens ?? 0) + inputTokens;
          if (outputTokens !== undefined) totals.childOutputTokens = (totals.childOutputTokens ?? 0) + outputTokens;
          properties.hasSubagents = true;
        } else {
          return;
        }
        db.prepare('UPDATE turns SET measurements = ?, properties = ? WHERE id = ?')
          .run(JSON.stringify(totals), JSON.stringify(properties), turnId);
      });
    },
    beginTurn(event: TelemetryEvent, finishId: string) {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM turns WHERE id = ?').get(event.id)) return false;
        if (!append(event)) return false;
        db.prepare('INSERT INTO turns (id, pid, started_at, finish_id, dimensions, properties, owner) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(event.id, process.pid, event.at, finishId, JSON.stringify(event.dimensions), JSON.stringify(event.properties ?? {}), owner);
        return true;
      });
    },
    dispatchTurn(id: string, sent: TelemetryEvent, session: TelemetryEvent, sessionStopId: string) {
      transaction(() => {
        const turn = getTurn.get(id) as TurnRow | undefined;
        if (!turn) return;
        const measurements = JSON.parse(turn.measurements) as Measurements;
        measurements.providerTurns = (measurements.providerTurns ?? 0) + 1;
        db.prepare('UPDATE turns SET measurements = ? WHERE id = ?').run(JSON.stringify(measurements), id);
        if (turn.sent_at !== null) return;
        append(sent);
        append(session);
        db.prepare('UPDATE turns SET sent_at = ?, session_stop_id = ?, session_dimensions = ? WHERE id = ?')
          .run(sent.at, sessionStopId, JSON.stringify(session.dimensions), id);
      });
    },
    updateTurn(id: string, properties: TelemetryProperties, counts: Measurements) {
      transaction(() => {
        const turn = getTurn.get(id) as TurnRow | undefined;
        if (!turn) return;
        const previous = JSON.parse(turn.properties) as TelemetryProperties;
        const measurements = JSON.parse(turn.measurements) as Measurements;
        for (const [key, value] of Object.entries(counts)) {
          const field = key as keyof Measurements;
          if (value !== undefined) measurements[field] = (measurements[field] ?? 0) + value;
        }
        db.prepare('UPDATE turns SET measurements = ?, properties = ? WHERE id = ?')
          .run(JSON.stringify(measurements), JSON.stringify({ ...previous, ...properties }), id);
      });
    },
    finishTurn(id: string, outcome: 'succeeded' | 'failed' | 'cancelled', at = Date.now()) {
      transaction(() => settle(id, outcome, at));
    },
    discardTurn(id: string) {
      closeTurn.run(id);
    },
    hasSession(id: string) {
      const row = getTurn.get(id) as TurnRow | undefined;
      return Boolean(row && row.sent_at !== null);
    },
    recoverTurns() {
      const owners = db.prepare('SELECT DISTINCT pid, owner FROM turns WHERE finished = 0 AND owner IS NOT ?').all(owner);
      for (const row of owners) {
        const pid = Number(row.pid);
        if (pid !== process.pid) {
          try { process.kill(pid, 0); continue; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
          }
        }
        transaction(() => {
          const abandoned = db.prepare('SELECT id FROM turns WHERE finished = 0 AND pid = ? AND owner IS ?').all(pid, row.owner);
          for (const { id } of abandoned) settle(String(id), 'interrupted');
        });
      }
    },
    prune(now: number) {
      transaction(() => {
        const cutoff = now - DELIVERY_DAYS * DAY_MS;
        db.prepare('DELETE FROM events WHERE at < ?').run(cutoff);
        db.prepare('DELETE FROM turns WHERE started_at < ?').run(cutoff);
        const boundary = db.prepare('SELECT sequence FROM events ORDER BY sequence DESC LIMIT 1 OFFSET ?').get(MAX_EVENT_ROWS);
        if (boundary) {
          const overflow = db.prepare('SELECT count(*) AS rows FROM events WHERE sequence <= ?').get(Number(boundary.sequence));
          db.prepare(`DELETE FROM events WHERE sequence IN (
            SELECT sequence FROM events WHERE payload IS NULL ORDER BY sequence LIMIT ?
          )`).run(Number(overflow?.rows ?? 0));
          db.prepare(`DELETE FROM events WHERE sequence <= (
            SELECT sequence FROM events ORDER BY sequence DESC LIMIT 1 OFFSET ?
          )`).run(MAX_EVENT_ROWS);
        }
        db.exec('DELETE FROM posthog_batches WHERE NOT EXISTS (SELECT 1 FROM events WHERE batch_id = posthog_batches.id)');
      });
    },
    acquire(now: number) {
      return transaction(() => {
        const state = db.prepare('SELECT lease_until, retry_at, failures FROM delivery WHERE id = 1').get();
        if (!state || Number(state.lease_until) > now || Number(state.retry_at) > now) return;
        if (db.prepare('SELECT 1 FROM posthog_batches WHERE lease_until > ? LIMIT 1').get(now)) return;
        const ready = db.prepare(`SELECT id, attempts FROM posthog_batches
          WHERE retry_at <= ? ORDER BY retry_at, rowid LIMIT 1`).get(now);
        const requestId = ready ? String(ready.id) : randomUUID();
        if (!ready) {
          const oldest = db.prepare(`SELECT id FROM events WHERE payload IS NOT NULL AND batch_id IS NULL
            ORDER BY sequence LIMIT ?`).all(BATCH_LIMIT);
          if (!oldest.length) return;
          // Reserve some room for current activity when a device comes back with an offline backlog.
          const selected = oldest.length < BATCH_LIMIT ? oldest : [
            ...oldest.slice(0, BATCH_LIMIT - RECENT_EVENTS_PER_BATCH),
            ...db.prepare(`SELECT id FROM events WHERE payload IS NOT NULL AND batch_id IS NULL
              ORDER BY sequence DESC LIMIT ?`).all(RECENT_EVENTS_PER_BATCH).reverse(),
          ];
          db.prepare('INSERT INTO posthog_batches (id, retry_at) VALUES (?, ?)').run(requestId, now);
          const assign = db.prepare('UPDATE events SET batch_id = ? WHERE id = ?');
          for (const row of selected) assign.run(requestId, String(row.id));
        }
        const rows = db.prepare('SELECT payload FROM events WHERE batch_id = ? ORDER BY sequence').all(requestId);
        const events = rows.map(row => JSON.parse(String(row.payload)) as TelemetryEvent);
        const lease = randomUUID();
        const attempts = Number(ready?.attempts ?? 0) + 1;
        db.prepare('UPDATE posthog_batches SET lease = ?, lease_until = ?, attempts = ? WHERE id = ?')
          .run(lease, now + LEASE_MS, attempts, requestId);
        return { requestId, lease, events, attempts, failures: Number(state.failures) };
      });
    },
    release(batch: { requestId: string; lease: string }, ids: string[], retryAt: number, cooldownAt: number, failures: number) {
      transaction(() => {
        if (!db.prepare('SELECT 1 FROM posthog_batches WHERE id = ? AND lease = ?').get(batch.requestId, batch.lease)) return;
        for (const id of ids) acknowledge.run(id, batch.requestId);
        if (db.prepare('SELECT 1 FROM events WHERE batch_id = ? LIMIT 1').get(batch.requestId)) {
          db.prepare('UPDATE posthog_batches SET lease = NULL, lease_until = 0, retry_at = ? WHERE id = ?')
            .run(retryAt, batch.requestId);
        } else {
          db.prepare('DELETE FROM posthog_batches WHERE id = ?').run(batch.requestId);
        }
        db.prepare('UPDATE delivery SET retry_at = ?, failures = ? WHERE id = 1').run(cooldownAt, failures);
      });
    },
  };
}
