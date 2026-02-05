# Mission Control – Operations Limits (MVP)

Goal: allow agents to delegate work to helper agents without overwhelming the gateway or burning tokens.

## Default delegation policy

- Per top-level task: **max 2 helper sub-agents concurrently**.
- Per specialist heartbeat: **spawn at most 1 new helper**.
- Cooldown: **10 minutes** before spawning more helpers for the same task (unless blocked).
- Prefer **message/reuse** existing helpers over spawning new.
- If the system shows instability (errors, latency, rate limits, memory pressure): **stop spawning**, downgrade to cheaper models, and post a status update.

## Concurrency caps (system)

Gateway already enforces:
- `agents.defaults.maxConcurrent`
- `agents.defaults.subagents.maxConcurrent`

We treat the delegation policy as an additional “soft cap” to avoid hitting those hard limits.

## Future improvements

- Track helper-spawn counts per task in SQLite.
- Track per-provider token burn (if telemetry available) to implement true budgets.
- Add a UI panel showing: active sessions, active helpers, queue depth.
