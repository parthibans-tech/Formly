# Alertmanager

Routes alerts from `infra/prometheus/alerts.rules.yml` to receivers
(PagerDuty, Slack). The `severity` label on each alert is the
single dispatch dimension — `page` wakes someone up, `ticket`
files during business hours.

## Files

- `alertmanager.yml` — route tree, inhibit rules, receiver
  declarations. Inline secrets are placeholders (`SECRET_*`,
  `REPLACE/WITH/REAL`); see "Secrets" below.
- `templates/formly.tmpl` — Slack + PagerDuty body templates. One
  glance per page is the design goal.

## Dev

```sh
docker compose -f infra/docker-compose.yml up -d prometheus alertmanager
open http://localhost:9093     # Alertmanager UI
open http://localhost:9091     # Prometheus, alerts tab
```

The dev config has `receiver: "null"` as the root route — alerts
fire and group, but go nowhere. To turn on a Slack-style firehose
locally:

1. Create a personal Slack incoming webhook for a private channel.
2. Edit `alertmanager.yml`: under `receivers: [...].name=dev-firehose`
   replace the `api_url:` placeholder with your webhook.
3. Change the root route's `receiver:` from `"null"` to `dev-firehose`.
4. Reload: `curl -X POST http://localhost:9093/-/reload`.

To trigger a test alert without waiting for real burn:

```sh
# silence-bypass test from the API container or any host:
curl -H "Content-Type: application/json" -d '[{
  "labels":{"alertname":"FormlyManualPing","severity":"ticket","job":"formly-api"},
  "annotations":{"summary":"manual test from CLI"}
}]' http://localhost:9093/api/v2/alerts
```

## Secrets

Don't commit real PagerDuty integration keys or Slack webhook URLs.
Two safe patterns:

1. **Mounted file** — recommended.
   ```yaml
   pagerduty_configs:
     - routing_key_file: /run/secrets/pagerduty_key
   slack_configs:
     - api_url_file: /run/secrets/slack_webhook
   ```
   Then mount `/run/secrets/*` from your secret manager (AWS
   Secrets Manager, Vault, GCP Secret Manager, etc.).

2. **Templated config at deploy time** — render `alertmanager.yml`
   from a template before the container starts, substituting the
   real values. Keep the template in this repo, the rendered file
   out of it.

Both are equally fine; the file-mount approach is cleaner because
secret rotation doesn't require an Alertmanager restart.

## Routing semantics

```
                root (default → "null")
                  │
                  ├── severity = "page"   → pager  (PagerDuty)   continue→
                  │                                              ↓
                  └── severity = "ticket" → tickets (Slack)
```

`continue: true` on the page route also forwards to the ticket
receiver, so a fired page lands in Slack as well — useful for
team-wide visibility while the on-call is engaged. Drop the
`continue` line if you don't want the duplication.

## Inhibit rules

Two are wired:

1. `FormlyProcessDown` suppresses every other alert from the same
   `(job, instance)`. A dead worker generates "queue drained",
   "exemplars stop", "build_info missing" — all derivative noise
   that resolves when the process resumes. The page on
   `FormlyProcessDown` is what the on-call needs to act on.

2. A `severity=page` alert suppresses any `severity=ticket` alert
   with the same `alertname`. Today only the SLO read/write split
   is paired this way (`FormlyTenantWriteSLOFastBurn` page
   inhibits `FormlyTenantReadSLOFastBurn` ticket if both fire on
   the same tier). Prevents two notifications for one issue.

## Live state in the API dashboard

`/settings/admin/observability` already pulls the current alert
state from Prometheus's `/api/v1/alerts` (which is the same
source Alertmanager reads). Once Alertmanager is running and a
real receiver is wired, the dashboard's "Active alerts" panel
matches what the on-call is seeing in PagerDuty/Slack — useful
for debugging "is the route working?" without leaving the app.

The Alertmanager UI itself (silences, group view, inhibitor
diagnostics) lives at `http://localhost:9093` and intentionally
isn't proxied through the app — Alertmanager has its own auth
story for prod, and rebuilding its UI inside our dashboard is
not a useful project.
