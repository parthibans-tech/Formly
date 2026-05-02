# FormlyAPIKeyAbuseProbe

## TL;DR

Invalid + revoked API key attempts spiking with **zero** successful
attempts in the same window. Canonical signature of a leaked key
being scanned by an attacker (or an integration script gone
wild).

## Verify

```promql
formly_apikey_abuse:rate5m
sum(rate(formly_auth_apikey_attempts_total{result="ok"}[5m]))
```

The first should be >0.1; the second should be 0.

```sql
-- Top source IPs for invalid attempts in the last hour.
SELECT remote_ip, count(*)
FROM audit_log
WHERE action = 'auth.apikey.failed'
  AND created_at > now() - interval '1 hour'
GROUP BY remote_ip
ORDER BY 2 DESC
LIMIT 20;
```

## Diagnose

1. **Single source IP** — almost always a leaked key being
   scanned. Block the IP at the edge.
2. **Distributed across many IPs** — rotated through a botnet.
   Block the whole `/24` if it's concentrated, or rate-limit
   harder.
3. **One specific key prefix** — find the key family and rotate
   it. Customer comms required if it's a paying customer's key.

## Mitigate

- Add the source IP(s) to the edge denylist:
  ```bash
  curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
    http://localhost:8080/v1/admin/security/denylist \
    -d '{"cidr":"<ip>/32","reason":"apikey_probe"}'
  ```
- Rotate the suspected key family if you can identify it from
  the audit log prefix.
- Tighten the rate limit on the `auth` bucket if the wave is
  too distributed to IP-block individually.

## Escalate

This is a security event. Notify the security on-call within
15 minutes regardless of whether you've successfully mitigated.
The investigation continues even after the alert clears.
