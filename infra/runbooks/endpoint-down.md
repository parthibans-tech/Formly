# FormlyEndpointDown

## TL;DR

A blackbox synthetic probe has been failing for ≥2 minutes. The
probe runs from outside the API process, so this catches network
path failures (DNS, load balancer, TLS, listener wedged) that
the in-process `/metrics` endpoint cannot.

## Verify

```bash
# Reproduce the probe by hand:
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' '<probed-url>'

# Inspect the probe series in Prometheus:
#   probe_success{instance="<probed-url>", probe="<probe-name>"}
```

## Diagnose

1. **DNS** — `dig <hostname>` from the same network as the
   probe runner. The `FormlyDNSFailing` alert may be firing too.
2. **Load balancer / proxy** — the LB's own health check is the
   first place to look. If the LB thinks the backend is healthy
   but the probe fails, suspect path-based routing.
3. **TLS** — `openssl s_client -connect host:443` returns the
   cert chain. Look for `Verify return code` ≠ 0. The
   `FormlyTLSCertExpiring` alert pre-emptively catches the
   expiry case but only 14d in advance.
4. **Process listener wedged** — `/metrics` is up but the public
   route returns 5xx or hangs. Check the
   `FormlyHighInFlight` and `FormlyHighGCPause` alerts.

## Mitigate

- If the listener is wedged: restart the process and capture a
  goroutine dump from `/debug/pprof/goroutine?debug=2` first.
- If the LB is the problem: drain the bad node out of rotation.
- If TLS: rotate the cert (the renewal pipeline should do this
  automatically — investigate why it didn't).

## Escalate

If the probe failure is paired with `FormlyProcessDown` on the
same instance, treat the process-down alert as the primary —
this one is just confirming the outage from outside.
