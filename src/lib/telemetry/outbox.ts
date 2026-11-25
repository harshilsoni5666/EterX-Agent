import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getEterxDataDir } from '../agent/storage-paths';
import { openApplicationDatabase } from '../imports/sqlite-reader';
import { BATCH_LIMIT, DAY_MS, DELIVERY_DAYS, type Measurements, type TelemetryEvent } from './protocol';

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
}

export function openOutbox() {
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
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at INTEGER NOT NULL,
        finish_id TEXT NOT NULL, dimensions TEXT NOT NULL, measurements TEXT NOT NULL DEFAULT '{}',
        finished INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS open_turns ON turns(pid) WHERE finished = 0;
    `);
    db.prepare('INSERT OR IGNORE INTO delivery (id, token) VALUES (1, ?)').run(randomBytes(32).toString('hex'));
  } catch (error) {
    db.close();
    throw error;
  }
  const token = String(db.prepare('SELECT token FROM delivery WHERE id = 1').get()?.token);
  const knownEvent = db.prepare('SELECT 1 FROM events WHERE id = ?');
  const insertEvent = db.prepare('INSERT INTO events (id, at, payload) VALUES (?, ?, ?)');
  const getTurn = db.prepare('SELECT * FROM turns WHERE id = ? AND finished = 0');
  const acknowledge = db.prepare('UPDATE events SET payload = NULL WHERE id = ?');

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
    insertEvent.run(event.id, event.at, JSON.stringify(event));
    return true;
  }

  function settle(id: string, outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', at?: number) {
    const turn = getTurn.get(id) as TurnRow | undefined;
    if (!turn) return;
    const dimensions = JSON.parse(turn.dimensions) as TelemetryEvent['dimensions'];
    const measurements = JSON.parse(turn.measurements) as Measurements;
    if (at !== undefined) {
      measurements.durationMs = Math.max(0, at - turn.started_at);
      measurements.durationReports = 1;
    }
    append({
      id: turn.finish_id, name: 'turn.finished', at: at ?? turn.started_at,
      dimensions: { ...dimensions, outcome }, measurements,
    });
    db.prepare("UPDATE turns SET finished = 1, dimensions = '{}', measurements = '{}' WHERE id = ?").run(id);
  }

  return {
    token,
    record(event: TelemetryEvent, turnId?: string) {
      transaction(() => {
        if (!append(event) || !turnId || !event.measurements) return;
        const turn = getTurn.get(turnId) as TurnRow | undefined;
        if (!turn) return;
        const totals: Record<string, number> = JSON.parse(turn.measurements);
        for (const [key, value] of Object.entries(event.measurements)) {
          if (value !== undefined && key !== 'durationMs' && key !== 'durationReports') {
            totals[key] = (totals[key] ?? 0) + value;
          }
        }
        db.prepare('UPDATE turns SET measurements = ? WHERE id = ?').run(JSON.stringify(totals), turnId);
      });
    },
    beginTurn(event: TelemetryEvent, finishId: string) {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM turns WHERE id = ?').get(event.id)) return false;
        if (!append(event)) return false;
        db.prepare('INSERT INTO turns (id, pid, started_at, finish_id, dimensions) VALUES (?, ?, ?, ?, ?)')
          .run(event.id, process.pid, event.at, finishId, JSON.stringify(event.dimensions));
        return true;
      });
    },
    finishTurn(id: string, outcome: 'succeeded' | 'failed' | 'cancelled') {
      transaction(() => settle(id, outcome, Date.now()));
    },
    recoverTurns() {
      const owners = db.prepare('SELECT DISTINCT pid FROM turns WHERE finished = 0 AND pid <> ?').all(process.pid);
      for (const { pid } of owners) {
        try { process.kill(Number(pid), 0); continue; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        }
        transaction(() => {
          const abandoned = db.prepare('SELECT id FROM turns WHERE finished = 0 AND pid = ?').all(Number(pid));
          for (const { id } of abandoned) settle(String(id), 'interrupted');
        });
      }
    },
    prune(now: number) {
      transaction(() => {
        const cutoff = now - DELIVERY_DAYS * DAY_MS;
        db.prepare('DELETE FROM events WHERE at < ?').run(cutoff);
        db.prepare('DELETE FROM turns WHERE started_at < ?').run(cutoff);
        db.prepare(`DELETE FROM events WHERE sequence <= (
          SELECT sequence FROM events ORDER BY sequence DESC LIMIT 1 OFFSET ?
        )`).run(MAX_EVENT_ROWS);
      });
    },
    acquire(now: number) {
      return transaction(() => {
        const state = db.prepare('SELECT lease_until, retry_at, failures FROM delivery WHERE id = 1').get();
        if (!state || Number(state.lease_until) > now || Number(state.retry_at) > now) return;
        const oldest = db.prepare('SELECT payload FROM events WHERE payload IS NOT NULL ORDER BY sequence LIMIT ?').all(BATCH_LIMIT);
        if (!oldest.length) return;
        // Keep live activity visible while an installation catches up on older events.
        const rows = oldest.length < BATCH_LIMIT ? oldest : [
          ...oldest.slice(0, BATCH_LIMIT - RECENT_EVENTS_PER_BATCH),
          ...db.prepare('SELECT payload FROM events WHERE payload IS NOT NULL ORDER BY sequence DESC LIMIT ?')
            .all(RECENT_EVENTS_PER_BATCH).reverse(),
        ];
        const events = rows.map(row => JSON.parse(String(row.payload)) as TelemetryEvent);
        const lease = randomBytes(16).toString('hex');
        db.prepare('UPDATE delivery SET lease = ?, lease_until = ? WHERE id = 1').run(lease, now + LEASE_MS);
        return { lease, events, failures: Number(state.failures) };
      });
    },
    release(lease: string, ids: string[], retryAt: number, failures: number) {
      transaction(() => {
        if (!db.prepare('SELECT 1 FROM delivery WHERE id = 1 AND lease = ?').get(lease)) return;
        for (const id of ids) acknowledge.run(id);
        db.prepare('UPDATE delivery SET lease = NULL, lease_until = 0, retry_at = ?, failures = ? WHERE id = 1')
          .run(retryAt, failures);
      });
    },
  };
}
