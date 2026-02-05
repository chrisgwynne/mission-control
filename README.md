# Mission Control (Dashboard)

Real-time operator UI + SQLite backend for running a multi-agent OpenClaw workplace.

## Location
This repo tracks the dashboard folder:
- `/home/chris/.openclaw/workspace/dashboard/`

## Run locally
```bash
cd dashboard
npm i
npm run dev
```
Then open:
- http://127.0.0.1:5173

## Key scripts
- Server: `server.js`
- Workloop: `workloop.cjs`
- Initiative loop: `initiative-loop.cjs`
- Sentinel: `sentinel-loop.cjs`
- GOG sentinel: `gog-sentinel-loop.cjs`

## Safety
- No secrets are committed.
- SQLite DB files are ignored via `.gitignore`.
