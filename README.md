# Mission Control (Dashboard)

Mission Control is a real-time operator UI + Node/SQLite backend for running a multi-agent OpenClaw workplace.

**Repo status:** Public. See `PRIVACY.md` — we never commit real task/email content or databases.

## What it does
- Kanban-style task board: Inbox → Assigned → In Progress → Review → Done/Archived
- Real-time updates via WebSockets
- Agent “workplace” model (Jarvis/Zeus/Hermes + specialists)
- Autonomous loops:
  - **workloop**: scans state and spawns agents when needed
  - **initiative loop**: keeps backlog non-empty (within noise budget)
  - **sentinel loop**: monitors signals and produces tasks/digests
  - **gog sentinel**: Gmail/Calendar → tasks/drafts
- Memory Bank (dual-bank): Draft → Approved memories + Questions

## Architecture (high level)
- Frontend:
  - `index.html`
  - `app.js`
- Backend:
  - `server.js` (Express + WS)
  - SQLite DB: `mc.db` (ignored by git)
- Autonomy/ops:
  - `workloop.cjs`
  - `initiative-loop.cjs`
  - `sentinel-loop.cjs`
  - `gog-sentinel-loop.cjs`
- Memory Bank:
  - `memory/server.js`
  - `memory/memory.db` (ignored by git)

## Run locally (dev)
```bash
cd dashboard
npm i
npm run dev
```
Open:
- http://127.0.0.1:5173

## Tests / CI
```bash
npm test
```
CI runs the syntax checks on push/PR.

## Local data (not in git)
- `mc.db`, `mc.db-wal`, `mc.db-shm`
- `memory/memory.db`, WAL/SHM
- `*.state.json`

## Systemd services (this host)
These are user services on Chris’s machine (not portable as-is):
- `mission-control.service` (dashboard)
- `mission-control-workloop.service`
- `mission-control-initiative.service`
- `mission-control-sentinel.service`
- `mission-control-gog-sentinel.service`
- `mission-control-breakroom.service`
- `memory-bank.service`

## Contributing / workflow
- Keep changes reversible.
- Prefer small commits with clear messages.
- Never add secrets/keys.
- Never commit real task/email content.

## Roadmap (near-term)
- Wire the Telegram evening digest generator (replace template)
- Improve ordering per-column (new→old)
- Tighten email triage safelist for important notifications
- Goals/workstreams layer (priorities drive initiative)
