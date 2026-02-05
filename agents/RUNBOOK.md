# Mission Control – Agent Runbook (Stage 3C)

**No crons.** Agents run only when manually invoked.

## Manual run procedure (every time)

1) **Load board state**
```bash
./mc state
```

2) **Identify your tasks**
- Look for tasks where your agent id is in `assignees`.
- If none: post a short status update and stop.

3) **Mark yourself active**
```bash
./mc agent:update --id <agentId> --status working
```

4) **For each assigned task**
- Post a short comment: what you will do next.
- Move status forward if appropriate:
  - `assigned` → `in_progress` when you start
  - `in_progress` → `review` when ready
  - `blocked` if you are stuck (and say why)

```bash
./mc msg --task <taskId> --from <agentId> --text "Starting: ..."
./mc task:update --id <taskId> --status in_progress
```

5) **When done**
```bash
./mc agent:update --id <agentId> --status idle
```

## Delegation safety
If you spawn helper agents, follow the limits in the global `AGENTS.md`.

## Agent ids
- zeus, hermes, apollo, artemis, ares, prometheus
