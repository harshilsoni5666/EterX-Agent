# EterX product telemetry

EterX ships normalized usage events from its local runtime to an EterX-operated receiver. The receiver commits them to PostgreSQL and a separate worker updates the reporting API. Desktop builds use the same event contract on Windows, macOS, and Linux. The collector and reports run independently of the desktop runtime.

## Local server

From the repository root, set the local database password and admin token, then start the stack. Use the same database password whenever you restart an existing database volume. The example uses PowerShell.

```powershell
$env:ETERX_TELEMETRY_DB_PASSWORD = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
$env:ETERX_TELEMETRY_ADMIN_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
docker compose -f telemetry/compose.yaml up -d --build
```

In the terminal that launches EterX, point the runtime at that receiver. Use the existing **Performance telemetry** setting or explicitly enable telemetry through the environment.

```powershell
$env:ETERX_TELEMETRY_URL = 'http://127.0.0.1:4318/v1/events'
$env:ETERX_TELEMETRY_ENABLED = 'true'
npm run desktop
```

The PostgreSQL named volume retains events, installation counts, and unfinished aggregation work across container and host restarts. The receiver and report listener bind to loopback on ports 4318 and 4319. For an existing PostgreSQL 17+ instance, configure `DATABASE_URL` and `TELEMETRY_ADMIN_TOKEN`, install the locked dependencies with `npm --prefix telemetry ci`, and run `npm --prefix telemetry run serve` and `npm --prefix telemetry run rollup` under a service supervisor. Both processes initialize the schema in the dedicated database.

## Delivery and recovery

- EterX writes events into `telemetry/outbox.sqlite` in its durable application data directory. A timed sender takes leases on up to 100 events. Healthy sends begin after a jittered 5–8 seconds. During catch-up, the app sends batches faster and reserves space for new activity in each batch. Network and receiver failures back off to about five minutes, with support for a longer server `Retry-After`.
- Event IDs and occurrence times stay fixed during delivery retries. The receiver commits the raw events and rollup job together before acknowledging them. A retry after a lost response acknowledges the existing event without adding it to the reports again. The worker commits aggregates and removes its job in one transaction. Pending jobs survive a worker restart.
- An accepted turn and its running state are stored together. On restart, turns whose runtime exited produce an interrupted outcome with the main-agent usage captured so far. The telemetry runtime records the interruption without reissuing a provider request. It uses the original start time when the end time is unknown.
- Delivery has a 90-day window. The desktop outbox retains up to 100,000 event records per installation, including compact IDs for acknowledged events. Retention cleanup removes the oldest records when these bounds are reached. Central raw events and time-based aggregates use monthly partitions retained for 100 days plus the partial month. Installation summaries expire after 180 days without a report.

## What gets collected

| Event | Payload |
| --- | --- |
| `app.started`, `app.heartbeat` | App version, release channel, operating system, CPU architecture, and runtime. Heartbeats are spaced ten minutes apart while the runtime is running. |
| `turn.requested`, `turn.finished` | Accepted chat, agent, and builder runs, with the selected provider and public model. Includes origin, reasoning effort and permission mode where applicable, terminal outcome, duration when known, and accumulated main-agent usage. |
| `model.request` | Provider, public model, outcome, duration where available, and normalized input, output, total, cache read, cache write, and reasoning token counts. Also includes reported image, video, and audio units. Child-agent and auxiliary model work carry their own role. |
| `feature.used` | Search, title generation, and media operations with outcome and duration. Search and media include product provider metadata when available. Compaction and live usage are identifiable on model request events. |

The ledger records token-report coverage through `usageReports`, `inputReports`, `outputReports`, and `cacheReports`. Use `durationReports` as the denominator for mean duration. Global token totals use `model.request`. Turn totals describe main-agent work and overlap those request totals.

Collection uses the existing **Performance telemetry** preference and starts disabled. `ETERX_TELEMETRY_ENABLED=false` pauses recording and delivery and `true` explicitly enables it for a configured runtime. A paused outbox can resume within the delivery window. Wire fields are limited to typed product dimensions and numerical measurements. Public model labels come from EterX's bundled catalog. The payload excludes prompts, responses, files, paths, provider keys, provider account IDs, raw errors, and conversation IDs.

An installation generates a random credential on its own device. The receiver derives a pseudonymous installation ID from it and stores that ID. EterX's current identity is per installation, so two devices used by one person count separately. Only reporting installations can appear in the metrics. The app sends requests to the configured receiver over HTTPS, with HTTP reserved for local loopback.

## Reporting API

The admin listener accepts `Authorization: Bearer <TELEMETRY_ADMIN_TOKEN>` on a private network. Dates and time buckets are UTC. All reports take `days=1..31` and default to seven calendar days, including today.

| Route | Output |
| --- | --- |
| `GET /v1/analytics/overview` | Reporting, new, active, and recently seen installations, daily active counts, event and measurement totals, and rollup lag. |
| `GET /v1/analytics/breakdown?event=model.request&by=provider,model&interval=day` | Up to two dimension groups. Use `interval=none\|hour\|day`, `limit=1..500`, and exact filters such as `role=child` or `outcome=failed`. |
| `GET /v1/analytics/installations?by=platform` | Distinct reporting and active installations by their most recent platform, architecture, version, channel, or runtime. |

Active installations are those with an accepted interactive turn, a completed live provider interaction, or successful standalone search. Recently seen installations include runtime heartbeats and reflect the time the activity occurred. Fetching overview periodically provides a live view as completed batches reach the worker.

```powershell
Invoke-RestMethod 'http://127.0.0.1:4319/v1/analytics/overview?days=7' -Headers @{
  Authorization = "Bearer $env:ETERX_TELEMETRY_ADMIN_TOKEN"
}
```

## Production deployment

1. Put the receiver behind EterX's public HTTPS hostname and route `POST /v1/events` to the ingest listener. Set the request body allowance to at least 128 KiB and the upstream timeout to at least 15 seconds. Apply ingress rate limits and keep the PostgreSQL and administration listeners private. Public clients mint installation credentials, so the edge limits bulk enrollment abuse. Use the receiver's `/readyz` for load balancing and avoid logging authorization headers or event bodies.
2. Set the release variable `ETERX_TELEMETRY_URL` to the full EterX URL ending in `/v1/events`. The desktop packaging step embeds it across operating systems and CPU architectures. The URL is public configuration. Keep the admin token and database credentials on the server.
3. Run receiver replicas against one primary PostgreSQL database and balance them at the edge. The worker uses database locking so additional worker processes can take over if one stops. Give the database durable storage, backups with point-in-time recovery, and a failover replica where required. Watch rollup lag, HTTP 429/503 rates, database write latency, WAL growth, and disk use.

The initial capacity target is about 300,000 daily active installations. At 30 events per active installation per day, that is about nine million events per day, 104 per second on average, and about 1,040 per second at a tenfold burst. Heartbeats from long-running installations can raise that event rate. Size disk and WAL retention from measured events per install and stored bytes per event. The receiver accepts batches, bounds concurrent requests, and uses independent pools for writes and reports. Hourly usage and daily active counts are preaggregated so dashboard reads avoid the raw events. Production capacity depends on ingress batching, database hardware, and peak traffic.

The event taxonomy separates accepted user turns from individual provider requests so usage, feature activity, and daily active installations can be counted independently.
