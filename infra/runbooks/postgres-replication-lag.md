# FormlyPostgresReplicationLag

## TL;DR

A Postgres replica is more than 60s behind the primary. Reads
that touch the replica may return stale data; the SLO panels
will start to show write/read divergence.

## Verify

```sql
-- On the replica:
SELECT
  CASE WHEN pg_is_in_recovery() THEN
    EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
  ELSE 0
  END AS lag_seconds;

-- On the primary:
SELECT client_addr, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
FROM pg_stat_replication;
```

## Diagnose

1. **Long-running query on the replica** — `hot_standby_feedback`
   pauses replay while a query runs. Find it in
   `pg_stat_activity` and decide whether to let it finish or
   cancel.
2. **Network slow between primary and replica** — `lag_bytes`
   growing while `replay_lsn` is steady = network. Check the
   instance's network metrics (cAdvisor `container_network_*`).
3. **Replica is CPU-bound on apply** — replay is single-threaded
   per database. A massive `UPDATE` on the primary saturates the
   replica's apply.

## Mitigate

- Don't fail over unless lag is >5m AND growing. The cost of
  the failover (connection storms, application restarts) is
  almost always higher than waiting out the lag.
- If lag is from a query: cancel it
  (`pg_cancel_backend(<pid>)`).
- Drain replica reads at the connection-pool layer until lag
  recovers — set `READ_REPLICA_DISABLED=1` in the api env and
  restart.

## Escalate

Page the DBA if lag is growing past 5 minutes. The decision to
promote a replica or rebuild it is theirs.
