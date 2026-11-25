CREATE TABLE IF NOT EXISTS telemetry_events (
    month date NOT NULL,
    installation_id uuid NOT NULL,
    event_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    name text NOT NULL,
    dimensions jsonb NOT NULL,
    measurements jsonb NOT NULL,
    PRIMARY KEY (month, installation_id, event_id)
) PARTITION BY RANGE (month);

CREATE TABLE IF NOT EXISTS telemetry_rollup_queue (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    installation_id uuid NOT NULL,
    queued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    events jsonb NOT NULL
) WITH (autovacuum_vacuum_scale_factor = 0.01);

CREATE TABLE IF NOT EXISTS telemetry_hourly (
    bucket timestamptz NOT NULL,
    name text NOT NULL,
    dimensions jsonb NOT NULL,
    events bigint NOT NULL,
    measurements jsonb NOT NULL,
    PRIMARY KEY (bucket, name, dimensions)
) PARTITION BY RANGE (bucket);

CREATE TABLE IF NOT EXISTS telemetry_installations (
    installation_id uuid PRIMARY KEY,
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    last_active_at timestamptz,
    dimensions jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_installations_first_seen ON telemetry_installations(first_seen_at);
CREATE INDEX IF NOT EXISTS telemetry_installations_last_seen ON telemetry_installations(last_seen_at);
CREATE INDEX IF NOT EXISTS telemetry_installations_last_active ON telemetry_installations(last_active_at)
    WHERE last_active_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS telemetry_active_daily (
    day date NOT NULL,
    installation_id uuid NOT NULL,
    PRIMARY KEY (day, installation_id)
) PARTITION BY RANGE (day);

CREATE TABLE IF NOT EXISTS telemetry_daily_counts (
    day date PRIMARY KEY,
    installations bigint NOT NULL
);

CREATE OR REPLACE FUNCTION telemetry_sum_measurements(existing jsonb, incoming jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
    SELECT coalesce(jsonb_object_agg(key, total), '{}'::jsonb)
    FROM (
        SELECT key, sum(value::bigint) AS total
        FROM (
            SELECT * FROM jsonb_each_text(existing)
            UNION ALL
            SELECT * FROM jsonb_each_text(incoming)
        ) AS values_to_add
        GROUP BY key
    ) AS totals;
$$;
