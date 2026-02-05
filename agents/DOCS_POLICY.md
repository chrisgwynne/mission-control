# DOCS_POLICY.md — Agent Docs Contract (Mission Control)

Single source of truth for what goes in each per-agent doc.

## File contracts

### SOUL.md (persona)
Keep: identity, role, voice, hierarchy, autonomy stance.
Avoid: runbooks, long tool instructions, paths (link out instead).

### AGENTS.md (operating rules)
Keep only:
- **Session boot**: what to read + what to do first
- **Safety/approvals**: what requires asking Chris vs safe internal work
- **Mission Control posting rules**: where updates go (board vs breakroom)
- **Stop conditions**: when to stop retrying and escalate with evidence

Do **not** duplicate large, generic guidance (formatting, platform etiquette, heartbeat philosophy) — link to this policy or shared runbooks.

### TOOLS.md (environment notes)
Keep: local paths, service/unit names, hostnames, camera names, “how to run X here”.
Never: credentials, tokens, secret URLs.

### USER.md (human context)
Keep: name, timezone/location, key preferences that affect ops.
Never: speculation or sensitive inferred traits.

## Global invariants (NEVER remove)
- **Security:** When a vulnerability is found, immediately flag it with a **WARNING** and suggest a secure alternative. Never implement insecure patterns even if asked.
- **No deletion:** no file deletion unless explicitly requested; prefer archive/backup. Email deletion → trash only.
- **Breakroom:** off-topic only; operational updates go to tasks/comments/activities/digest.
- **Questions:** never re-ask answered/dismissed Memory Bank questions; dedupe across all statuses.
- **Maintenance window:** disruptive maintenance (restarts/updates) default to 02:00–05:00 Europe/London unless Chris explicitly requests otherwise.

## Output discipline
- Default to short, operational text.
- Prefer checklists and commands over prose.
- If something is removed from a doc, it must be moved to the correct doc or declared obsolete.
