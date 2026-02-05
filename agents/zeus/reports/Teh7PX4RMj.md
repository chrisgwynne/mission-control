# Mission Control Report Viewer — Demo

**Task:** `Teh7PX4RMj`  **Generated:** 2026-02-05 11:56:42 GMT

## What this demonstrates
- A task can have an attached Markdown report
- Mission Control shows a **📄 Report** chip on the card
- Task drawer shows **View Report**
- Report renders *in-dashboard* (tables/headings/code)

## Quick table

| Check | Result |
|---|---|
| Report file exists | ✅ |
| API fetch works | ✅ |
| Markdown renders | ✅ |

## Notes
This is a synthetic report created to prove the end-to-end loop.

```bash
curl http://127.0.0.1:5173/api/reports/<reportId>
```
