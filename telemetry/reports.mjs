import { DAY_MS, DIMENSION_NAMES, EVENT_NAMES, MEASUREMENT_NAMES } from '../src/lib/telemetry/protocol.ts';

const MEASUREMENT_TOTALS = `jsonb_build_object(${MEASUREMENT_NAMES.map(name =>
  `'${name}', coalesce(sum((measurements->>'${name}')::bigint), 0)`).join(', ')})`;

function reportingWindow(params, now) {
  const days = Number(params.get('days') ?? '7');
  if (!Number.isInteger(days) || days < 1 || days > 31) return;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return { days, from: new Date(today - (days - 1) * DAY_MS), until: new Date(today + DAY_MS) };
}

export async function overview(pool, params) {
  const now = Date.now();
  const window = reportingWindow(params, now);
  if (!window) return;
  const { from, until, days } = window;
  const recent = new Date(now - 15 * 60_000);
  const { rows: [{ data }] } = await pool.query(`
    WITH installations AS (
      SELECT count(*)::int AS "reportingInstallations",
        count(*) FILTER (WHERE first_seen_at >= $1 AND first_seen_at < $2)::int AS "newInstallations",
        count(*) FILTER (WHERE last_active_at >= $1)::int AS "activeInstallations",
        count(*) FILTER (WHERE last_seen_at >= $3)::int AS "seenLast15Minutes",
        count(*) FILTER (WHERE last_active_at >= $3)::int AS "activeLast15Minutes"
      FROM telemetry_installations
    ), days AS (
      SELECT ($1::timestamptz)::date + day_number AS day FROM generate_series(0, $4::integer - 1) AS series(day_number)
    ), daily AS (
      SELECT days.day::text AS day, coalesce(active.installations, 0)::int AS "activeInstallations"
      FROM days LEFT JOIN telemetry_daily_counts AS active USING (day)
    ), totals AS (
      SELECT name, sum(events)::double precision AS events, ${MEASUREMENT_TOTALS} AS measurements
      FROM telemetry_hourly WHERE bucket >= $1 AND bucket < $2
      GROUP BY name
    )
    SELECT to_jsonb(installations) || jsonb_build_object(
      'daily', (SELECT jsonb_agg(to_jsonb(daily) ORDER BY day) FROM daily),
      'totals', coalesce((SELECT jsonb_agg(to_jsonb(totals) ORDER BY name) FROM totals), '[]'::jsonb),
      'oldestPendingAt', (SELECT queued_at FROM telemetry_rollup_queue ORDER BY id LIMIT 1)
    ) AS data
    FROM installations
  `, [from, until, recent, days]);
  return {
    from, until, generatedAt: new Date(now), ...data,
    rollupLagSeconds: data.oldestPendingAt ? Math.max(0, Math.floor((now - Date.parse(data.oldestPendingAt)) / 1000)) : 0,
  };
}

export async function installationBreakdown(pool, params) {
  const now = Date.now();
  const window = reportingWindow(params, now);
  const by = params.get('by') ?? 'platform';
  if (!window || !['platform', 'arch', 'version', 'channel', 'runtime'].includes(by)) return;
  const { rows } = await pool.query(`
    SELECT dimensions->>($1::text) AS value, count(*)::int AS "reportingInstallations",
      count(*) FILTER (WHERE last_active_at >= $2::timestamptz)::int AS "activeInstallations",
      count(*) FILTER (WHERE last_seen_at >= $3::timestamptz)::int AS "seenLast15Minutes"
    FROM telemetry_installations GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 500
  `, [by, window.from, new Date(now - 15 * 60_000)]);
  return { from: window.from, by, rows };
}

export async function breakdown(pool, params) {
  const window = reportingWindow(params, Date.now());
  const event = params.get('event') ?? 'model.request';
  const dimensions = (params.get('by') ?? 'provider,model').split(',').filter(Boolean);
  const interval = params.get('interval') ?? 'none';
  const limit = Number(params.get('limit') ?? '200');
  if (!window || !EVENT_NAMES.includes(event) || dimensions.length > 2 || new Set(dimensions).size !== dimensions.length
      || !dimensions.every(dimension => DIMENSION_NAMES.includes(dimension))
      || !['none', 'hour', 'day'].includes(interval) || !Number.isInteger(limit) || limit < 1 || limit > 500) return;

  const group = dimensions.length
    ? `jsonb_build_object(${dimensions.map(dimension => `'${dimension}', dimensions->'${dimension}'`).join(', ')})` : "'{}'::jsonb";
  const bucket = interval === 'none' ? 'NULL::timestamptz' : `date_trunc('${interval}', bucket)`;
  const { from, until } = window;
  const values = [from, until, event, limit];
  const filters = [];
  for (const dimension of DIMENSION_NAMES) {
    const value = params.get(dimension);
    if (value === null) continue;
    if (!value.length || value.length > 96) return;
    values.push(value);
    filters.push(`AND dimensions->>'${dimension}' = $${values.length}`);
  }
  const { rows } = await pool.query(`
    SELECT ${bucket} AS period, ${group} AS dimensions,
      sum(events)::double precision AS events, ${MEASUREMENT_TOTALS} AS measurements
    FROM telemetry_hourly WHERE bucket >= $1 AND bucket < $2 AND name = $3 ${filters.join(' ')}
    GROUP BY 1, 2 ORDER BY period DESC, events DESC, dimensions LIMIT $4
  `, values);
  return { from, until, event, interval, rows };
}
