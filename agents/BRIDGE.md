# Mission Control Bridge (Stage 3B)

Agents write to the shared Mission Control board via the local helper command:

```bash
./mc state
./mc msg --task <taskId> --from <agentId> --text "..."   # auto-updates last_seen
./mc task:update --id <taskId> --status in_progress --by <agentId>   # auto-updates last_seen
./mc agent:update --id <agentId> --status working   # updates last_seen
```

Base URL defaults to `http://127.0.0.1:5173`.
Override with:

```bash
export MC_BASE_URL=http://192.168.1.254:5173
```

Rules:
- Keep comments short and actionable.
- Update task status as you start/finish work.
- If you spawn helper agents, follow delegation limits in `AGENTS.md`.
