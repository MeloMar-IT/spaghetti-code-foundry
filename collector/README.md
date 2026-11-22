# Metrics collector

A small receiver for the daily reports that an install shares (#890). It runs as its own process behind the
web server of spaghetti-code-foundry.com, and serves the public totals itself, so a deploy of the site never
overwrites them. It uses Node.js only, no new dependencies, and it has no access to the site's files.

## What it does

| Route | What |
|---|---|
| `POST /api/metrics` | Takes one report (`Content-Type: application/json`, at most 64 KB). Stores it for its install and day; a report for the same install and day replaces the one kept. |
| `DELETE /api/metrics/<install>` | Removes all data of an install. It is gone from the next `metrics.json`. |
| `GET /metrics.json` | The public totals (`HEAD` too). `503` until the first totals are worked out. |

- **Checks.** A report must pass the schema of #893 (`src/metrics-share/report.ts`, the same code the Foundry
  uses). A body over 64 KB, a wrong content type, a wrong schema, a day in the future or a day older than 7 days
  is refused with a fixed reason (for example `too_large`, `bad_schema`, `future_day`, `old_day`). A refusal
  never repeats anything from the body.
- **Limits.** 20 requests an hour per install id and 1000 requests an hour in total. A request over a limit
  gets `429` with `retry_after` (seconds) and the `Retry-After` header.
- **Retention.** Reports older than 400 days are removed.
- **Totals.** Worked out every hour, per day (the last 35 days) and per week (weeks start on Monday), over all
  installs. Changes, speed histograms with their medians, splits, rework, quality shares, cost and tokens per
  model and per built-in step, and use. Every number is shown, also one that a single install gives (`minInstalls` is 1). `sharing` counts
  the installs and accounts of the last 7 days.
- **Privacy.** The receiver never stores or logs an IP address, a header other than the content type, or the
  body of a refused request. It logs no line per request. Only a failure name is logged, never a path, body or
  header. The web server in front of it must not log these requests either (see below).

## Layout

| Path | What |
|---|---|
| `check.ts` | The request checks and the fixed refusal reasons |
| `limits.ts` | The rate limits (sliding one-hour windows, in memory) |
| `store.ts` | The data folder: `reports/<install>/<day>.json`, mode 0600 |
| `totals.ts` | The public totals (pure functions) |
| `server.ts` | The HTTP side and the hourly run |
| `main.ts` | The entry point: reads the environment, listens, shuts down on SIGTERM/SIGINT |
| `tsconfig.json` | Its own build, into `collector/dist/` |

## Build and run

```bash
npm ci
npm run collector                         # builds collector/dist/ (the entry point is dist/collector/main.js)
COLLECTOR_DATA_DIR=/var/lib/scf-collector node collector/dist/collector/main.js
```

Environment variables:

| Name | Default | What |
|---|---|---|
| `COLLECTOR_DATA_DIR` | none, required | An absolute path. The reports are kept here. |
| `COLLECTOR_HOST` | `127.0.0.1` | The address to listen on. Keep it on localhost behind the proxy. |
| `COLLECTOR_PORT` | `8790` | The port to listen on. |
| `COLLECTOR_TOTAL_PER_HOUR` | `1000` | The limit over all requests per hour. |

The process stops with exit code 1 when a variable is wrong. On SIGTERM or SIGINT it stops taking requests and
waits up to 10 seconds for work in progress.

## systemd

`/etc/systemd/system/scf-collector.service`:

```ini
[Unit]
Description=Spaghetti Code Foundry metrics collector
After=network.target

[Service]
User=scf-collector
Group=scf-collector
WorkingDirectory=/opt/spaghetti-code-foundry
ExecStart=/usr/bin/node /opt/spaghetti-code-foundry/collector/dist/collector/main.js
Environment=COLLECTOR_DATA_DIR=/var/lib/scf-collector
Environment=COLLECTOR_HOST=127.0.0.1
Environment=COLLECTOR_PORT=8790
StateDirectory=scf-collector
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/scf-collector

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --no-create-home scf-collector
sudo systemctl daemon-reload
sudo systemctl enable --now scf-collector
systemctl status scf-collector
```

## Web-server proxy (nginx)

Add these to the `server` block of spaghetti-code-foundry.com. The site's own locations stay as they are.

```nginx
# The collector: no access log, no error log with client addresses, no request body on disk.
location = /metrics.json {
    access_log off;
    error_log /dev/null crit;
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Host $host;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_intercept_errors off;
}

location /api/metrics {
    access_log off;
    error_log /dev/null crit;
    client_max_body_size 64k;
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Host $host;
    proxy_request_buffering off;
}
```

Do not pass `X-Forwarded-For` or `X-Real-IP`: the receiver ignores them, and they would only add an address to
the request. The `access_log off` lines are the decision of #890 (no IP address is kept for these paths). If the
site's `server` block turns on a global access log, these locations still log nothing, because `access_log off`
applies to each location.

Reload after a change with `sudo nginx -t && sudo systemctl reload nginx`.

## Checking it

```bash
curl -s http://127.0.0.1:8790/metrics.json            # 503 until the first hourly run, then the totals
curl -s -X DELETE http://127.0.0.1:8790/api/metrics/0123456789abcdef0123456789abcdef
```

The tests run without a server: `npm test -- collector` (they listen on port 0 and use a temporary data folder).
