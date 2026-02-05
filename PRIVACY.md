# Privacy & Data Handling

This repository is **public**.

Rules:
- **Never commit** real user task content, email content, or message logs.
- Never commit SQLite DB files (`mc.db`, `memory.db`, WAL/SHM).
- Never commit secrets/keys/credentials.
- Synthetic/demo data is allowed only if clearly labeled as synthetic.

Operational data lives on the host:
- Mission Control DB: `mc.db` (ignored)
- Memory Bank DB: `memory/memory.db` (ignored)
- State files: `*.state.json` (ignored)

If a privacy leak is detected, treat it as a security incident: remove from tracking immediately, rotate any exposed keys, and document the fix.
