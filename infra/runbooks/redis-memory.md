# FormlyRedisMemoryHigh

## TL;DR

Redis is at >80% of its configured `maxmemory`. With our
`noeviction` policy, the next write returns OOM — asynq will
fail to enqueue, sessions can't be written, rate-limit keys can't
be set.

## Verify

```bash
redis-cli INFO memory | grep -E '(used_memory_human|maxmemory_human|maxmemory_policy)'
redis-cli --bigkeys
```

## Diagnose

1. **Asynq dead-letter pile-up** — `asynq:default:dead` size is
   huge. A handler is failing repeatedly and the retries land in
   the DLQ.
2. **Idle keys without TTL** — `redis-cli SCAN 0 MATCH '*' COUNT
   1000` and look at `TTL` on the largest keys. We should set a
   TTL on every key we write; finding one without is a code bug.
3. **Real growth** — the dataset is just bigger now. Decide
   whether to raise `maxmemory` or shed load.

## Mitigate

- **DLQ pile-up**: drain the dead-letter queue — `asynq.Inspector
  .ArchiveAllDeadTasks()`. Document which task type filled it.
- **Untagged keys**: identify the offending pattern with
  `bigkeys`, ship a fix that adds the TTL, and run `EXPIRE` on
  the existing keys as a one-off.
- **Real growth**: bump `maxmemory` on the next deploy. Don't
  hot-tune in prod — restart with the new config.

## Escalate

If memory hits 100% and writes start failing (async tasks
returning OOM), this is customer-impacting — page the SRE
on-call and consider degrading the API to read-only while
recovery happens.
