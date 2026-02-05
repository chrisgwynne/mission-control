# Dual-Bank Memory System: Research & Design Plan

**Researcher:** Prometheus 📚  
**Date:** 2026-02-05  
**Task:** jQdBj5hYMt

---

## Executive Summary

Propose a **dual-bank memory architecture** that separates:
- **Working Bank (Draft):** Raw extractions, low confidence, requires approval
- **Curated Bank (Canonical):** Confirmed memories, high confidence, provenance tracked

This integrates with existing OpenClaw infrastructure: MEMORY.md, daily logs, memory_search, and qmd.

---

## Current State Analysis

### Existing Memory Infrastructure
| Component | Purpose | Location |
|-----------|---------|----------|
| `MEMORY.md` | Curated long-term memory | Agent workspace |
| `memory/YYYY-MM-DD.md` | Raw daily logs | Daily timestamped |
| `memory_search` | Semantic search over agent memory | OpenClaw tool |
| `qmd` | BM25/vector search over markdown | Local index |
| `model-usage.jsonl` | Structured event log | Pattern exists |

### Gaps Identified
1. **No confidence scoring** - All memories treated equally
2. **No provenance** - Can't trace "who said what when"
3. **No approval flow** - Everything auto-commits
4. **No linking** - Related memories isolated
5. **No decay/retirement** - MEMORY.md grows indefinitely

---

## Proposed Architecture: Dual-Bank System

```
┌─────────────────────────────────────────────────────────────┐
│                    EXTRACTION PIPELINE                      │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────┐  │
│  │ Sources  │───▶│ Extract  │───▶│ Confidence Scoring   │  │
│  │ - Chat   │    │ - LLM    │    │ - Source reliability │  │
│  │ - Tasks  │    │ - Rules  │    │ - Self-consistency   │  │
│  │ - Docs   │    │ - Hybrid │    │ - Recency decay      │  │
│  └──────────┘    └──────────┘    └──────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    DUAL BANK STORAGE                        │
│                                                             │
│  ┌────────────────────────┐  ┌──────────────────────────┐  │
│  │    WORKING BANK        │  │     CURATED BANK         │  │
│  │   (Draft/Memories)     │  │    (Canonical/Memory)    │  │
│  │                        │  │                          │  │
│  │  memory/_draft/        │  │  MEMORY.md               │  │
│  │    ├── extractions/    │  │  memory/_approved/       │  │
│  │    ├── pending.jsonl   │  │    ├── facts/            │  │
│  │    └── rejected/       │  │    └── links.jsonl       │  │
│  │                        │  │                          │  │
│  │  Confidence: 0.0-0.7   │  │  Confidence: 0.7-1.0     │  │
│  │  Requires approval     │  │  Provenance tracked      │  │
│  │  TTL: 30 days          │  │  Permanent               │  │
│  └────────────────────────┘  └──────────────────────────┘  │
│              │                            ▲                │
│              │     APPROVAL FLOW          │                │
│              └────────────────────────────┘                │
│                                                            │
│         ┌──────────────────────────────────────┐          │
│         │       Approvals Dashboard            │          │
│         │   (Mission Control extension)        │          │
│         └──────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Schema Design

### 1. Working Bank Schema (Draft Memories)

**File:** `memory/_draft/pending.jsonl`

```json
{
  "id": "mem_abc123",
  "created_at": "2026-02-05T01:08:00Z",
  "source": {
    "type": "conversation",
    "session_id": "sess_xyz789",
    "agent_id": "prometheus",
    "user_id": "chris",
    "message_ids": ["msg_001", "msg_002"],
    "context_range": [120, 245]
  },
  "extraction": {
    "fact": "User prefers dark mode in all applications",
    "category": "preference/ui",
    "confidence": 0.65,
    "extractor": "gpt-5.2",
    "extraction_method": "llm_extraction"
  },
  "validation": {
    "self_consistency": 0.8,
    "source_reliability": 0.7,
    "recency_boost": 1.0,
    "conflicts_with": []
  },
  "status": "pending",
  "ttl_expires_at": "2026-03-07T01:08:00Z",
  "graph_links": {
    "related_to": ["mem_def456"],
    "contradicts": [],
    "supersedes": []
  }
}
```

### 2. Curated Bank Schema (Approved Memories)

**File:** `memory/_approved/facts/<category>/<id>.json`

```json
{
  "id": "mem_abc123",
  "created_at": "2026-02-05T01:08:00Z",
  "approved_at": "2026-02-05T09:15:00Z",
  "approved_by": "zeus",
  "approval_method": "auto_confirmed", // or "manual_review"
  "source": {
    "original_extraction": "mem_abc123",
    "provenance_chain": [
      {"step": "extraction", "agent": "prometheus", "ts": "2026-02-05T01:08:00Z"},
      {"step": "validation", "agent": "hermes", "ts": "2026-02-05T01:09:00Z"},
      {"step": "approval", "agent": "zeus", "ts": "2026-02-05T09:15:00Z"}
    ]
  },
  "fact": {
    "statement": "User prefers dark mode in all applications",
    "category": "preference/ui",
    "confidence": 0.92,
    "verification_count": 3
  },
  "graph": {
    "related": ["mem_def456", "mem_ghi789"],
    "contradicts": [],
    "supersedes": [],
    "superseded_by": null
  }
}
```

### 3. Graph Link Schema

**File:** `memory/_approved/links.jsonl`

```json
{
  "id": "link_001",
  "from_mem": "mem_abc123",
  "to_mem": "mem_def456",
  "link_type": "related", // related | contradicts | supersedes | implies
  "strength": 0.85,
  "created_at": "2026-02-05T01:08:00Z",
  "verified": true
}
```

---

## Confidence Scoring Algorithm

```
confidence = base_confidence × source_weight × consistency_score × recency_boost

Where:
- base_confidence: LLM extraction confidence (0.0-1.0)
- source_weight: 
  - user_explicit_statement: 1.0
  - user_implicit: 0.8
  - agent_inference: 0.6
  - external_doc: 0.9
- consistency_score: Cross-reference with existing memories
- recency_boost: 1.0 for <7d, 0.9 for <30d, 0.8 for older

Thresholds:
- ≥0.85: Auto-approve (with provenance)
- 0.70-0.85: Pending review (dashboard)
- 0.50-0.70: Low confidence (notify, don't store)
- <0.50: Discard
```

---

## Extraction Pipeline

### Stage 1: Source Capture
**Trigger:** End of conversation, task completion, explicit "remember this"

**Captures:**
- Conversation transcript (last N messages)
- Task context (if in task scope)
- Agent's own reasoning (if self-reflection)

### Stage 2: Fact Extraction
**Methods:**
1. **LLM Extraction:** Dedicated extraction prompt
2. **Structured Logging:** Explicit memory calls from agents
3. **Diff Analysis:** Changes to SOUL.md, USER.md, TOOLS.md

**Extraction Categories:**
- `preference/*` - User preferences
- `fact/person/*` - Personal facts
- `fact/project/*` - Project context
- `decision/*` - Recorded decisions
- `lesson/*` - Learned lessons
- `relationship/*` - Social graph

### Stage 3: Confidence Scoring
- Run scoring algorithm
- Check for conflicts with existing memories
- Generate graph link candidates

### Stage 4: Routing
- ≥0.85: Auto-curate
- 0.70-0.85: Working bank → dashboard
- <0.70: Reject or manual flag

---

## Approvals Dashboard (Mission Control Extension)

### New Tables

```sql
-- Memory extractions pending approval
CREATE TABLE memory_extractions (
  id TEXT PRIMARY KEY,
  fact_statement TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_session TEXT,
  source_agent TEXT,
  extracted_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  ttl_expires_at INTEGER,
  payload TEXT -- full JSON
);

-- Approved memories
CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  approved_at INTEGER NOT NULL,
  approved_by TEXT,
  extraction_id TEXT,
  graph_links TEXT -- JSON array
);

-- Memory links (graph)
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  from_mem_id TEXT NOT NULL,
  to_mem_id TEXT NOT NULL,
  link_type TEXT NOT NULL, -- related | contradicts | supersedes
  strength REAL NOT NULL,
  created_at INTEGER NOT NULL
);
```

### UI Components
1. **Pending Memories Panel:** List extractions with confidence, source, action buttons
2. **Memory Graph View:** Visual graph of linked memories
3. **Search & Discovery:** Full-text + semantic search across banks
4. **Conflict Resolver:** Side-by-side when contradictions detected

### API Endpoints
```
GET  /api/memories/pending
POST /api/memories/:id/approve
POST /api/memories/:id/reject
GET  /api/memories/graph/:id
GET  /api/memories/search?q=...
```

---

## Integration with Existing Tools

### memory_search (OpenClaw)
**Enhancement:** Add `bank` parameter
- `memory_search --bank curated` (default, high confidence)
- `memory_search --bank working` (include pending)
- `memory_search --bank all` (unified search)

**Implementation:** Index both banks in SQLite FTS5

### qmd Integration
**New Collection:** `openclaw-memory`
```bash
qmd collection add /home/chris/.openclaw/workspace/memory/_approved/facts \
  --name openclaw-memory \
  --mask "**/*.json"
```

**Custom extractor** for JSON fact files to index `statement` field.

### MEMORY.md Sync
**Bidirectional sync:**
- Curated memories → MEMORY.md (human-readable summary)
- MEMORY.md edits → Back to curated bank (with provenance)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| False positives pollute curated bank | High | High auto-approve threshold (0.85), manual review gate |
| Storage explosion from working bank | Medium | 30-day TTL, aggressive cleanup of <0.5 confidence |
| Graph becomes unwieldy | Medium | Link strength decay, unused link pruning |
| User privacy leakage | High | Working bank never leaves local, sensitive categories encrypted |
| Agent over-confidence | Medium | Multi-agent validation for >0.90 confidence |
| Conflict resolution complexity | Medium | Simplistic "newest wins" default, escalate contradictions |

---

## Staged Rollout

### Phase 1: Foundation (Week 1-2)
- [ ] Create directory structure (`memory/_draft/`, `memory/_approved/`)
- [ ] Implement extraction pipeline (basic)
- [ ] Add confidence scoring (simple heuristic)
- [ ] Manual MEMORY.md sync script

### Phase 2: Working Bank (Week 3-4)
- [ ] Persist extractions to `pending.jsonl`
- [ ] TTL-based cleanup
- [ ] Agent integration (opt-in extraction)
- [ ] Basic CLI for reviewing pending memories

### Phase 3: Curated Bank (Week 5-6)
- [ ] Approval workflow
- [ ] Auto-promote ≥0.85 confidence
- [ ] Provenance tracking
- [ ] MEMORY.md sync automation

### Phase 4: Graph & Dashboard (Week 7-8)
- [ ] Memory links schema
- [ ] Graph query API
- [ ] Mission Control UI extension
- [ ] Conflict detection

### Phase 5: Polish (Week 9-10)
- [ ] memory_search integration
- [ ] qmd indexing
- [ ] Performance optimization
- [ ] Documentation & agent training

---

## Quick Start Implementation

### 1. Directory Structure
```bash
mkdir -p memory/{_draft/extractions,_draft/rejected,_approved/facts,_approved/conflicts}
touch memory/_draft/pending.jsonl
```

### 2. Simple Extraction Script
```javascript
// memory/scripts/extract.js
// Run at end of session to extract candidate memories
```

### 3. Confidence Scoring Function
```javascript
// memory/lib/confidence.js
// Calculate confidence from source, consistency, recency
```

### 4. CLI Tool
```bash
./mc memory:pending    # List pending memories
./mc memory:approve <id>
./mc memory:reject <id>
./mc memory:graph <id> # Show linked memories
```

---

## Open Questions

1. **Should rejected memories be kept?** (For learning)
2. **How to handle memory updates?** (Edit vs. supersede)
3. **Multi-agent consensus?** (Require 2+ agents for high-confidence)
4. **Sensitive data detection?** (PII, credentials auto-reject)
5. **Memory decay?** (Should old preferences fade?)

---

## Conclusion

The dual-bank system provides:
- **Safety:** Working bank prevents pollution of canonical memory
- **Transparency:** Provenance shows memory lineage
- **Control:** Dashboard enables human oversight
- **Connectivity:** Graph links enable discovery

This design is compatible with existing OpenClaw patterns and can be implemented incrementally without disrupting current workflows.

**Next Step:** Begin Phase 1 implementation if approved.

---

*Prometheus 📚 — Research complete*
