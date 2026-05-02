# FormlyProcessDown

## TL;DR

A scrape target hasn't responded for ≥2 minutes. Either the
process crashed, the host is unreachable, or the metrics
listener wedged. Customer impact is total for that process.

## Verify

```bash
# Is the alert still firing?
curl -s 'http://prometheus:9090/api/v1/alerts' \
  | jq '.data.alerts[] | select(.labels.alertname=="FormlyProcessDown")'

# Can you reach the process directly?
curl -fsS http://<instance-host>:<port>/healthz

# What does the host say?
ssh <instance-host> 'systemctl status formly-api'
```

## Diagnose

1. **Process crashed** — `journalctl -u formly-api --since '10m ago'`
   shows a panic or OOM. Most common cause.
2. **Host unreachable** — ping/SSH itself fails. The instance
   went away (autoscaler, hardware, network partition).
3. **Metrics listener wedged but main listener fine** — `/healthz`
   responds but `/metrics` hangs. Rare; usually a goroutine leak
   on the metrics handler. Check `/debug/pprof/goroutine?debug=2`.

## Mitigate

- If autoscaled: confirm a new instance is rolling in
  (`kubectl get pods` / cloud console). Capacity restores itself.
- If single-instance: restart the unit (`systemctl restart
  formly-api`) and capture a core dump first if the process is
  still wedged but unresponsive.
- Drain traffic away from the dead instance at the load balancer
  if not already done by the LB's own health check.

## Escalate

Page the SRE on-call if:
- More than one instance is down at once (suggests a deploy or
  a shared-fate dependency).
- The restart loops within 5 minutes (file an incident with the
  panic stack from `journalctl`).
