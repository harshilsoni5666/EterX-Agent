import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { DAY_MS, DELIVERY_DAYS } from '../src/lib/telemetry/protocol.ts';

const RETENTION_DAYS = DELIVERY_DAYS + 10;
const PARTITION_TABLES = ['telemetry_events', 'telemetry_hourly', 'telemetry_active_daily'];

export function openPool(max) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('DATABASE_URL or PGHOST is required');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'eterx-telemetry',
    options: '-c timezone=UTC -c synchronous_commit=on',
  });
  pool.on('error', error => console.error('[Telemetry] Idle database connection lost', error.code ?? error.name));
  return pool;
}

export async function transaction(pool, run) {
  const connection = await pool.connect();
  let destroy = false;
  try {
    await connection.query('BEGIN');
    const value = await run(connection);
    await connection.query('COMMIT');
    return value;
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch { destroy = true; }
    throw error;
  } finally {
    connection.release(destroy);
  }
}

export function monthStart(at) {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function oldestPartition(now) {
  return monthStart(now - RETENTION_DAYS * DAY_MS);
}

function nextMonth(at) {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

async function maintainPartitions(connection, now) {
  const { rows } = await connection.query(`
    SELECT child.relname AS name
    FROM pg_inherits
    JOIN pg_class AS child ON child.oid = inhrelid
    WHERE inhparent IN ('telemetry_events'::regclass, 'telemetry_hourly'::regclass, 'telemetry_active_daily'::regclass)
  `);
  const existing = new Set(rows.map(row => row.name));
  const oldest = oldestPartition(now);
  const newest = nextMonth(monthStart(now));
  const oldestSuffix = new Date(oldest).toISOString().slice(0, 7).replace('-', '_');
  for (let month = oldest; month <= newest; month = nextMonth(month)) {
    const from = new Date(month).toISOString().slice(0, 10);
    const to = new Date(nextMonth(month)).toISOString().slice(0, 10);
    const suffix = from.slice(0, 7).replace('-', '_');
    for (const table of PARTITION_TABLES) {
      const name = `${table}_${suffix}`;
      if (!existing.has(name)) await connection.query(
        `CREATE TABLE ${name} PARTITION OF ${table} FOR VALUES FROM ('${from}') TO ('${to}')`,
      );
    }
  }
  for (const name of existing) {
    const suffix = /^(?:telemetry_events|telemetry_hourly|telemetry_active_daily)_(\d{4}_\d{2})$/.exec(name)?.[1];
    if (suffix && suffix < oldestSuffix) await connection.query(`DROP TABLE ${name}`);
  }
}

export async function initializeDatabase(pool) {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await transaction(pool, async connection => {
    await connection.query('SET LOCAL statement_timeout = 60000');
    await connection.query('SELECT pg_advisory_xact_lock(179022, 1)');
    await connection.query(schema);
    await maintainPartitions(connection, Date.now());
  });
}

export async function maintainDatabase(pool, now) {
  await transaction(pool, async connection => {
    const { rows: [row] } = await connection.query('SELECT pg_try_advisory_xact_lock(179022, 1) AS acquired');
    if (!row.acquired) return;
    await maintainPartitions(connection, now);
    await connection.query('DELETE FROM telemetry_daily_counts WHERE day < $1::date', [new Date(oldestPartition(now))]);
    await connection.query(`
      DELETE FROM telemetry_installations WHERE installation_id IN (
        SELECT installation_id FROM telemetry_installations
        WHERE last_seen_at < $1::timestamptz ORDER BY last_seen_at LIMIT 10000
      )
    `, [new Date(now - 180 * DAY_MS)]);
  });
}

export async function acceptEvents(pool, installation, events) {
  if (!events.length) return;
  // Both writes form one durable SQL statement. Replays enqueue only new rows.
  await pool.query(`
    WITH inserted AS (
      INSERT INTO telemetry_events (month, installation_id, event_id, occurred_at, name, dimensions, measurements)
      SELECT date_trunc('month', occurred_at AT TIME ZONE 'UTC')::date, $1::uuid, id::uuid,
        occurred_at, name, dimensions, coalesce(measurements, '{}'::jsonb)
      FROM (
        SELECT id, to_timestamp(at::double precision / 1000) AS occurred_at, name, dimensions, measurements
        FROM jsonb_to_recordset($2::jsonb) AS event(id text, at bigint, name text, dimensions jsonb, measurements jsonb)
      ) AS batch
      ORDER BY occurred_at, id
      ON CONFLICT (month, installation_id, event_id) DO NOTHING
      RETURNING occurred_at, name, dimensions, measurements
    )
    INSERT INTO telemetry_rollup_queue (installation_id, events)
    SELECT $1::uuid, jsonb_agg(jsonb_build_object(
      'at', (extract(epoch FROM occurred_at) * 1000)::bigint,
      'name', name, 'dimensions', dimensions, 'measurements', measurements
    ))
    FROM inserted HAVING count(*) > 0
  `, [installation, JSON.stringify(events)]);
}
