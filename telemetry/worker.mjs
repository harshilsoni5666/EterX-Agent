import { setTimeout as wait } from 'node:timers/promises';
import { countsAsActivity } from '../src/lib/telemetry/protocol.ts';
import { initializeDatabase, maintainDatabase, oldestPartition, openPool, transaction } from './database.mjs';

const HOUR_MS = 3_600_000;
const JOBS_PER_TRANSACTION = 256;
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());

function timestamp(at) {
  return new Date(at).toISOString();
}

function installationDimensions({ platform, arch, version, channel, runtime }) {
  return { platform, arch, version, channel, runtime };
}

function rollup(jobs, now) {
  const hourly = new Map();
  const installations = new Map();
  const daily = new Map();
  const oldest = oldestPartition(now);
  for (const job of jobs) {
    for (const event of job.events) {
      if (event.at < oldest) continue;
      const bucket = timestamp(Math.floor(event.at / HOUR_MS) * HOUR_MS);
      const key = JSON.stringify([bucket, event.name, event.dimensions]);
      let group = hourly.get(key);
      if (!group) {
        group = { bucket, name: event.name, dimensions: event.dimensions, events: 0, measurements: {} };
        hourly.set(key, group);
      }
      group.events++;
      for (const [measurement, value] of Object.entries(event.measurements)) {
        group.measurements[measurement] = (group.measurements[measurement] ?? 0) + value;
      }

      const installation_id = job.installation_id;
      const seen = timestamp(Math.min(event.at, now));
      let installation = installations.get(installation_id);
      if (!installation) {
        installation = {
          installation_id, first_seen_at: seen, last_seen_at: seen, last_active_at: null,
          dimensions: installationDimensions(event.dimensions),
        };
        installations.set(installation_id, installation);
      }
      if (seen < installation.first_seen_at) installation.first_seen_at = seen;
      if (seen > installation.last_seen_at) {
        installation.last_seen_at = seen;
        installation.dimensions = installationDimensions(event.dimensions);
      }
      if (countsAsActivity(event)) {
        if (!installation.last_active_at || seen > installation.last_active_at) installation.last_active_at = seen;
        const day = seen.slice(0, 10);
        daily.set(day + installation_id, { day, installation_id });
      }
    }
  }
  return { hourly: [...hourly.values()], installations: [...installations.values()], daily: [...daily.values()] };
}

async function processJobs(pool) {
  return transaction(pool, async connection => {
    // One transaction combines queue rows across receivers before touching hot counters.
    const { rows: [lock] } = await connection.query('SELECT pg_try_advisory_xact_lock(179022, 2) AS acquired');
    if (!lock.acquired) return 0;
    const { rows: jobs } = await connection.query(`
      SELECT id, installation_id, events FROM telemetry_rollup_queue ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
    `, [JOBS_PER_TRANSACTION]);
    if (!jobs.length) return 0;
    const { hourly, installations, daily } = rollup(jobs, Date.now());

    await connection.query(`
      INSERT INTO telemetry_hourly (bucket, name, dimensions, events, measurements)
      SELECT bucket, name, dimensions, events, measurements FROM jsonb_to_recordset($1::jsonb)
        AS hourly(bucket timestamptz, name text, dimensions jsonb, events bigint, measurements jsonb)
      ON CONFLICT (bucket, name, dimensions) DO UPDATE SET
        events = telemetry_hourly.events + excluded.events,
        measurements = telemetry_sum_measurements(telemetry_hourly.measurements, excluded.measurements)
    `, [JSON.stringify(hourly)]);
    await connection.query(`
      INSERT INTO telemetry_installations (installation_id, first_seen_at, last_seen_at, last_active_at, dimensions)
      SELECT installation_id, first_seen_at, last_seen_at, last_active_at, dimensions FROM jsonb_to_recordset($1::jsonb)
        AS seen(installation_id uuid, first_seen_at timestamptz, last_seen_at timestamptz, last_active_at timestamptz, dimensions jsonb)
      ON CONFLICT (installation_id) DO UPDATE SET
        first_seen_at = least(telemetry_installations.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(telemetry_installations.last_seen_at, excluded.last_seen_at),
        last_active_at = greatest(telemetry_installations.last_active_at, excluded.last_active_at),
        dimensions = CASE WHEN excluded.last_seen_at > telemetry_installations.last_seen_at
          THEN excluded.dimensions ELSE telemetry_installations.dimensions END
      WHERE excluded.first_seen_at < telemetry_installations.first_seen_at
        OR excluded.last_seen_at > telemetry_installations.last_seen_at
        OR excluded.last_active_at > coalesce(telemetry_installations.last_active_at, '-infinity'::timestamptz)
    `, [JSON.stringify(installations)]);
    if (daily.length) {
      await connection.query(`
        WITH first_activity AS (
          INSERT INTO telemetry_active_daily (day, installation_id)
          SELECT day, installation_id FROM jsonb_to_recordset($1::jsonb) AS active(day date, installation_id uuid)
          ON CONFLICT (day, installation_id) DO NOTHING
          RETURNING day
        )
        INSERT INTO telemetry_daily_counts (day, installations)
        SELECT day, count(*) FROM first_activity GROUP BY day
        ON CONFLICT (day) DO UPDATE SET installations = telemetry_daily_counts.installations + excluded.installations
      `, [JSON.stringify(daily)]);
    }
    await connection.query('DELETE FROM telemetry_rollup_queue WHERE id = ANY($1::bigint[])', [jobs.map(job => job.id)]);
    return jobs.length;
  });
}

const pool = openPool(2);
try {
  await initializeDatabase(pool);
  let maintenanceAt = 0;
  console.log('[Telemetry] Rollup worker started.');
  while (!stop.signal.aborted) {
    let delay = 1_000;
    const now = Date.now();
    if (maintenanceAt <= now) {
      try {
        await maintainDatabase(pool, now);
        maintenanceAt = now + HOUR_MS;
      } catch (error) {
        console.error('[Telemetry] Database maintenance will retry', error.code ?? error.name);
        maintenanceAt = now + 60_000;
      }
    }
    try {
      if (await processJobs(pool) === JOBS_PER_TRANSACTION) delay = 0;
    } catch (error) {
      console.error('[Telemetry] Rollup transaction will retry', error.code ?? error.name);
      delay = 5_000;
    }
    await wait(delay, undefined, { signal: stop.signal }).catch(error => {
      if (!stop.signal.aborted) throw error;
    });
  }
} finally {
  await pool.end();
}
