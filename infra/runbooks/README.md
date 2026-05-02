# Runbooks

Each `.md` file here is the operator-facing runbook for one alert
in `infra/prometheus/alerts.rules.yml`. The alert's
`annotations.runbook_url` resolves to the GitHub blob URL of the
matching file, so the Slack/PagerDuty notification carries a
clickable "Runbook" button straight to the right page.

## Conventions

Every runbook follows the same five-section shape so the on-call
doesn't have to context-switch reading order between alerts:

1. **TL;DR** — one sentence: what fired, who feels it.
2. **Verify** — copy-pasteable commands (psql, curl, grafana URL)
   that confirm the alert is still firing right now and isn't
   already resolved.
3. **Diagnose** — the three or four most common root causes, in
   order of likelihood, each with a one-line "is it this?" check.
4. **Mitigate** — the safe, reversible action to take *first*. We
   reduce blast radius before we investigate.
5. **Escalate** — who to ping, what evidence to bring.

Runbooks are intentionally short. If a section grows past a
screenful, that's a sign the underlying system is too easy to
break and the right fix is in code, not in the runbook.

## Adding a new runbook

1. Create `<slug>.md` here using the template above.
2. Add `runbook_url` to the alert annotations:

   ```yaml
   annotations:
     summary: "..."
     description: "..."
     runbook_url: "https://github.com/formly/formly/blob/main/infra/runbooks/<slug>.md"
   ```

3. The Slack/PagerDuty templates in `infra/alertmanager/templates/`
   already render the link — no template change needed.

## Index

| Alert | Runbook |
|---|---|
| FormlyProcessDown | [process-down.md](process-down.md) |
| FormlyHighErrorRate | [high-error-rate.md](high-error-rate.md) |
| FormlyTenantSLOFastBurn | [slo-fast-burn.md](slo-fast-burn.md) |
| FormlyDBPoolNearExhaustion | [db-pool-exhaustion.md](db-pool-exhaustion.md) |
| FormlyAPIKeyAbuseProbe | [api-key-abuse.md](api-key-abuse.md) |
| FormlyPostgresReplicationLag | [postgres-replication-lag.md](postgres-replication-lag.md) |
| FormlyRedisMemoryHigh | [redis-memory.md](redis-memory.md) |
| FormlyEndpointDown | [endpoint-down.md](endpoint-down.md) |
