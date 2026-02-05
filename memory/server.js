import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import Database from 'better-sqlite3';
import { openDb } from './db.js';

const app = express();

// CORS for cross-port fetches from Mission Control (:5173 → :3000)
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.MEMORY_PORT || 3000);

const db = openDb();

// Optional: scan Mission Control DB to generate draft memories automatically
const MC_DB_PATH = process.env.MC_DB_PATH || '/home/chris/.openclaw/workspace/dashboard/mc.db';
let mcdb = null;
try {
  if (fs.existsSync(MC_DB_PATH)) mcdb = new Database(MC_DB_PATH, { readonly: true, fileMustExist: true });
} catch {}

const CANONICAL_MEMORY_MD = process.env.CANONICAL_MEMORY_MD || '/home/chris/.openclaw/workspace/MEMORY.md';
const EXPORT_START = '<!-- MEMORY_BANK_START -->';
const EXPORT_END = '<!-- MEMORY_BANK_END -->';

function nowMs() { return Date.now(); }

function exportApprovedToMarkdown() {
  const approved = db.prepare(`
    SELECT id, title, statement, category, confidence, approved_at, approved_by, source_type, source_ref, source_agent_id
    FROM memory_items
    WHERE bank='approved' AND status='approved'
    ORDER BY approved_at DESC
  `).all();

  const lines = [];
  lines.push('## Dual-bank memory — Approved (canonical)');
  lines.push('');
  lines.push(`_Auto-generated from SQLite. Last export: ${new Date().toISOString()}_`);
  lines.push('');

  if (!approved.length) {
    lines.push('- (No approved memories yet)');
  } else {
    for (const m of approved) {
      const title = m.title ? `**${m.title}** — ` : '';
      const cat = m.category ? ` _(cat: ${m.category})_` : '';
      const conf = (Number(m.confidence) || 0).toFixed(2);
      const prov = [
        m.approved_by ? `approved_by=${m.approved_by}` : null,
        m.source_agent_id ? `src_agent=${m.source_agent_id}` : null,
        m.source_type ? `src=${m.source_type}` : null,
        m.source_ref ? `ref=${m.source_ref}` : null,
        `conf=${conf}`
      ].filter(Boolean).join(' · ');
      lines.push(`- ${title}${m.statement}${cat}`);
      lines.push(`  - id: ${m.id} · ${prov}`);
    }
  }

  const block = [EXPORT_START, ...lines, EXPORT_END].join('\n');

  let existing = '';
  try { existing = fs.readFileSync(CANONICAL_MEMORY_MD, 'utf8'); }
  catch (e) { existing = '# MEMORY.md — Long-term memory (curated)\n'; }

  if (existing.includes(EXPORT_START) && existing.includes(EXPORT_END)) {
    const before = existing.split(EXPORT_START)[0].trimEnd();
    const after = existing.split(EXPORT_END)[1].trimStart();
    const next = (before + '\n\n' + block + '\n\n' + after).replace(/\n{3,}/g,'\n\n');
    fs.writeFileSync(CANONICAL_MEMORY_MD, next, 'utf8');
  } else {
    const next = (existing.trimEnd() + '\n\n' + block + '\n').replace(/\n{3,}/g,'\n\n');
    fs.writeFileSync(CANONICAL_MEMORY_MD, next, 'utf8');
  }

  return { ok: true, exported: approved.length, path: CANONICAL_MEMORY_MD };
}

function normalizeItem(row) {
  if (!row) return null;
  return {
    ...row,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    approved_at: row.approved_at ? new Date(row.approved_at).toISOString() : null,
  };
}

const DRAFT_TTL_DAYS = Number(process.env.DRAFT_TTL_DAYS || 14);
const APPROVED_TTL_DAYS = Number(process.env.APPROVED_TTL_DAYS || 90);

function msDays(d) { return d * 24 * 60 * 60 * 1000; }

function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
}

function polarity(s) {
  const t = String(s || '').toLowerCase();
  const neg = /\b(no|not|never|don't|do not|cant|can't|won't|shouldn't|avoid)\b/.test(t);
  return neg ? 'neg' : 'pos';
}

function likelyConflict(aStatement, bStatement) {
  // simple heuristic: same topic tokens overlap + opposite polarity
  const pa = polarity(aStatement);
  const pb = polarity(bStatement);
  if (pa === pb) return false;
  const ta = new Set(tokenize(aStatement).slice(0, 18));
  const tb = new Set(tokenize(bStatement).slice(0, 18));
  let overlap = 0;
  for (const x of ta) if (tb.has(x)) overlap++;
  return overlap >= 4;
}

function markConflicts() {
  const approved = db.prepare(`
    SELECT id, statement, category
    FROM memory_items
    WHERE bank='approved' AND status='approved'
  `).all();

  const drafts = db.prepare(`
    SELECT id, statement, category, approval_notes
    FROM memory_items
    WHERE bank='draft' AND status='pending'
    LIMIT 1000
  `).all();

  let conflicts = 0;
  const ts = nowMs();
  for (const d of drafts) {
    let conflictWith = null;
    for (const a of approved) {
      if (d.category && a.category && d.category !== a.category) continue;
      if (likelyConflict(d.statement, a.statement)) { conflictWith = a.id; break; }
    }
    const tag = conflictWith ? `CONFLICTS_WITH:${conflictWith}` : null;
    const hasTag = d.approval_notes && d.approval_notes.includes('CONFLICTS_WITH:');

    if (tag && !hasTag) {
      db.prepare(`UPDATE memory_items SET approval_notes=@n, updated_at=@ts WHERE id=@id`).run({
        id: d.id,
        ts,
        n: (d.approval_notes ? (d.approval_notes + ' | ') : '') + tag,
      });
      conflicts++;
    }
    if (!tag && hasTag) {
      // clear stale conflict tags (best-effort)
      const cleaned = String(d.approval_notes || '').split('|').map(s=>s.trim()).filter(s=>!s.startsWith('CONFLICTS_WITH:')).join(' | ') || null;
      db.prepare(`UPDATE memory_items SET approval_notes=@n, updated_at=@ts WHERE id=@id`).run({ id: d.id, ts, n: cleaned });
    }
  }
  return conflicts;
}

function inferCategory(text) {
  const t = String(text || '').toLowerCase();
  if (/(notify|notification|alerts?)/.test(t)) return 'preference/ops';
  if (/(dark mode|theme|font|spacing|layout|ui|ux|button|dashboard)/.test(t)) return 'preference/ui';
  if (/(maintenance window|maintenance|restart|update window)/.test(t)) return 'ops/maintenance';
  if (/(delete|deletion|rm\b|trash|archive|backup)/.test(t)) return 'ops/safety';
  if (/(model|tokens?|provider)/.test(t)) return 'ops/models';
  if (/(obsidian|vault|\/mnt\/homes\/chris\/obsidian)/.test(t)) return 'system/paths';
  if (/(qmd|search|index)/.test(t)) return 'system/search';
  if (/(should|must|needs to|definition of done|verify|verification)/.test(t)) return 'ops/process';
  return 'preference/general';
}

let lastSweepStats = null;

function generateDraftsFromMissionControl() {
  if (!mcdb) return { inserted: 0, considered: 0, filtered: 0, dupSkipped: 0 };

  // Keep a steady stream of drafts without overwhelming the UI.
  const TARGET_PENDING = Number(process.env.DRAFT_TARGET_PENDING || 18);
  const MAX_PENDING = Number(process.env.DRAFT_MAX_PENDING || 40);

  const pendingNow = db.prepare(`
    SELECT COUNT(*) AS n FROM memory_items WHERE bank='draft' AND status='pending'
  `).get()?.n || 0;

  if (pendingNow >= MAX_PENDING) return { inserted: 0, considered: 0, filtered: 0, dupSkipped: 0 };

  const ts = nowMs();
  const sinceDays = Number(process.env.DRAFT_SOURCE_LOOKBACK_DAYS || 7);
  const since = ts - msDays(sinceDays);

  // pull recent human+agent text; we only use it to create *draft* suggestions.
  const roomRows = mcdb.prepare(`
    SELECT created_at, from_agent_id, content
    FROM room_messages
    WHERE created_at >= @since
    ORDER BY created_at DESC
    LIMIT 250
  `).all({ since });

  const msgRows = mcdb.prepare(`
    SELECT created_at, from_agent_id, content
    FROM messages
    WHERE created_at >= @since
    ORDER BY created_at DESC
    LIMIT 350
  `).all({ since });

  const taskRows = mcdb.prepare(`
    SELECT updated_at AS created_at, NULL AS from_agent_id,
           (title || '\n' || description) AS content
    FROM tasks
    WHERE updated_at >= @since
    ORDER BY updated_at DESC
    LIMIT 120
  `).all({ since });

  const rows = [...roomRows.map(r=>({ ...r, source:'mc_room_messages' })),
                ...msgRows.map(r=>({ ...r, source:'mc_task_messages' })),
                ...taskRows.map(r=>({ ...r, source:'mc_tasks' }))];

  const candidates = [];
  for (const r of rows) {
    const text = String(r.content || '').trim();
    if (!text) continue;

    // Very simple inference rules (safe + low confidence)
    const pref = text.match(/\b(prefer|prefers|i want|i need|i like|i don't like|i hate)\b[^.\n]{0,160}/i);
    if (pref) {
      let st = pref[0].trim();
      st = st.replace(/^i\s+/i, 'Chris ');

      const allowTopic = /(memory bank|memory|dashboard|theme|dark mode|colou?rs?|layout|spacing|fonts?|ux|ui|notifications|maintenance window|tokens?|model|blocked column|delete|trash|archive|obsidian|qmd|search)/i.test(st);
      const looksLikeCode = /(implement|refactor|endpoint|api\b|sql\b|ws\b|websocket|express|node\b|better-sqlite|sqlite|schema|migration|commit|pr\b|gh\b|curl\b|http\b|json\b|regex|tailwind\b|css\b|flex\b|grid\b|px\b|padding|margin)/i.test(st);
      const looksLikePureTaskScope = /(for this task|that task|in this task|in that task|for this|for that)/i.test(st);

      // Only keep if it's likely to be an enduring preference/constraint.
      if (allowTopic && !looksLikeCode && !looksLikePureTaskScope && st.length >= 18 && st.length <= 180 && !/[`*_]{2,}|https?:\/\//.test(st)) {
        candidates.push({
          statement: st,
          category: inferCategory(st),
          confidence: 0.74,
          source: r.source,
          notes: 'auto-inferred from Mission Control'
        });
      }
    }

    // Rules/process extraction tends to be noisy in task threads; keep it ultra-conservative.
    const rule = text.match(/\b(should|must|needs to|never|avoid|do not|don't)\b[^.\n]{0,200}/i);
    if (rule) {
      const st = rule[0].trim();

      const allowTopic = /(memory bank|memory|preferences?|retention|ttl|maintenance window|tokens?|model rotation|notifications|no file deletion|trash|archive|blocked column|obsidian|qmd|search defaults|mission control contained)/i.test(text);
      const looksLikeCode = /(endpoint|api\b|sql\b|ws\b|websocket|express|node\b|sqlite|schema|migration|commit|pr\b|curl\b|http\b|json\b|regex)/i.test(text);

      // Only keep if it's clearly an enduring ops/preference rule AND not code/implementation chatter.
      if (allowTopic && !looksLikeCode && st.length >= 28 && st.length <= 220 && !/[`*_]{2,}|https?:\/\//.test(st)) {
        candidates.push({
          statement: st,
          category: inferCategory(st),
          confidence: 0.72,
          source: r.source,
          notes: 'auto-inferred from Mission Control'
        });
      }
    }
  }

  let inserted = 0;
  let considered = 0;
  let dupSkipped = 0;
  const ins = db.prepare(`
    INSERT INTO memory_items (
      id, created_at, updated_at, bank, title, statement, category,
      confidence, status,
      source_type, source_ref, source_agent_id, source_notes,
      approved_at, approved_by, approval_notes,
      expires_at, reaffirmed_at
    ) VALUES (
      @id, @created_at, @updated_at, 'draft', NULL, @statement, @category,
      @confidence, 'pending',
      'inferred', @source_ref, @source_agent_id, @source_notes,
      NULL, NULL, NULL,
      @expires_at, NULL
    )
  `);

  const need = Math.max(0, TARGET_PENDING - pendingNow);
  const allowance = Math.min(80, Math.max(10, need));

  const slice = candidates.slice(0, allowance);
  for (const c of slice) {
    considered++;
    const exists = db.prepare(`SELECT 1 FROM memory_items WHERE statement=? LIMIT 1`).get(c.statement);
    if (exists) { dupSkipped++; continue; }
    const id = 'mem_' + nanoid(10);
    ins.run({
      id,
      created_at: ts,
      updated_at: ts,
      statement: c.statement,
      category: c.category,
      confidence: c.confidence,
      source_ref: c.source,
      source_agent_id: 'system',
      source_notes: c.notes,
      expires_at: ts + msDays(DRAFT_TTL_DAYS)
    });
    inserted++;
  }

  const filtered = Math.max(0, rows.length - inserted); // rough signal for "we read a lot, kept little"
  return { inserted, considered, filtered, dupSkipped };
}

function upsertQuestion({ question, reason = null, related_memory_id = null, confidence = null }) {
  const ts = nowMs();
  const q = String(question || '').trim();
  if (!q) return false;

  // Dedupe by exact question text (across ALL statuses).
  // If you already answered or dismissed it once, we should not re-ask.
  const existingAny = db.prepare(`SELECT id, status FROM memory_questions WHERE question=? ORDER BY updated_at DESC LIMIT 1`).get(q);
  if (existingAny) {
    // Keep the most recent record; do not revive dismissed/answered questions.
    if (existingAny.status === 'open') {
      db.prepare(`UPDATE memory_questions SET updated_at=@ts WHERE id=@id`).run({ ts, id: existingAny.id });
    }
    return false;
  }

  db.prepare(`
    INSERT INTO memory_questions (id, created_at, updated_at, status, question, reason, related_memory_id, confidence)
    VALUES (@id, @ts, @ts, 'open', @q, @reason, @rid, @conf)
  `).run({
    id: 'q_' + nanoid(10),
    ts,
    q,
    reason,
    rid: related_memory_id,
    conf: (confidence != null ? Number(confidence) : null)
  });

  return true;
}

function generateReflectionQuestions() {
  // Always show questions while the system is learning Chris.
  // But do NOT ask questions already answered by approved canonical memories.

  const MIN_OPEN_QUESTIONS = Number(process.env.MEMORY_MIN_OPEN_QUESTIONS || 3);
  const MAX_OPEN_QUESTIONS = Number(process.env.MEMORY_MAX_OPEN_QUESTIONS || 12);

  const openCount = db.prepare(`SELECT COUNT(*) AS n FROM memory_questions WHERE status='open'`).get()?.n || 0;
  if (openCount >= MAX_OPEN_QUESTIONS) return 0;

  const approved = db.prepare(`
    SELECT id, category, statement
    FROM memory_items
    WHERE bank='approved' AND status='approved'
  `).all();

  const hasCat = (prefix) => approved.some(m => String(m.category||'').startsWith(prefix));
  const hasStmt = (re) => approved.some(m => re.test(String(m.statement||'')));

  const starterPredicates = [
    {
      q: 'What are the 3 things you care most about me optimizing day-to-day? (Speed, calm UI, fewer pings, reliability, etc.)',
      reason: 'calibrate priorities',
      satisfied: () => hasCat('preference') || hasStmt(/results now|minimal notifications|don[’']t repeat/i),
    },
    {
      q: 'When I’m unsure, do you prefer I: (A) decide and ship, or (B) ask a quick question first?',
      reason: 'decision style',
      satisfied: () => hasCat('ops/process') || hasStmt(/plan first|verification is part of done|two approaches fail/i),
    },
    {
      q: 'How do you want me to handle sensitive personal topics (politics/family): only when you explicitly tell me, or can I suggest drafts for you to approve?',
      reason: 'personal memory boundaries',
      satisfied: () => hasStmt(/sensitive personal|politics|health|explicit/i),
    },
  ];

  // Auto-dismiss any open starter questions that are now satisfied by canon.
  for (const s of starterPredicates) {
    if (!s.satisfied()) continue;
    try {
      db.prepare(`UPDATE memory_questions SET status='dismissed', updated_at=@ts WHERE status='open' AND question=@q`).run({ ts: nowMs(), q: s.q });
    } catch {}
  }

  const drafted = db.prepare(`
    SELECT id, statement, category, confidence, source_type
    FROM memory_items
    WHERE bank='draft' AND status='pending'
    ORDER BY updated_at DESC
    LIMIT 50
  `).all();

  let made = 0;

  // Starter set (only if not already answered)
  for (const s of starterPredicates) {
    if (openCount + made >= MAX_OPEN_QUESTIONS) break;
    if (s.satisfied()) continue;
    if (upsertQuestion({ question: s.q, reason: s.reason })) made++;
  }

  // Deepeners: if starters are satisfied, ask sharper follow-ups instead of going silent.
  const deepeners = [
    {
      q: 'Rank these (most→least): speed of shipping, calm UI, fewer notifications, autonomy, verification/traceability.',
      reason: 'priority ordering',
      enabled: () => hasCat('preference') || hasCat('ops/process') || hasStmt(/results now|minimal notifications|verification|plan first/i),
    },
    {
      q: 'For “minimal notifications”, what counts as acceptable by default: (A) only errors/urgent, (B) daily digest, (C) whenever a task hits Review/Done?',
      reason: 'notification thresholds',
      enabled: () => hasStmt(/minimal notifications/i),
    },
    {
      q: 'When I auto-create tasks (initiative loop), what’s the right “noise budget”: 5/day, 15/day, or 50/day?',
      reason: 'autonomy tuning',
      enabled: () => true,
    },
  ];

  // Maintain a minimum open-question inventory.
  // Only add questions we have never asked before.
  if ((openCount + made) < MIN_OPEN_QUESTIONS) {
    for (const d of deepeners) {
      if (openCount + made >= MIN_OPEN_QUESTIONS) break;
      if (!d.enabled()) continue;
      if (upsertQuestion({ question: d.q, reason: d.reason })) made++;
    }
  }

  // Ask clarifiers for vague draft memories
  for (const d of drafted) {
    if (openCount + made >= MAX_OPEN_QUESTIONS) break;
    const cat = String(d.category || '');
    const conf = Number(d.confidence || 0);
    if (conf >= 0.85) continue;
    if (cat.startsWith('preference/') || cat.startsWith('profile/') || cat.startsWith('values/')) {
      const q = `Confirm this about you: “${String(d.statement).slice(0, 120)}” — true, false, or needs tweaking?`;
      if (upsertQuestion({ question: q, reason: 'draft confirmation', related_memory_id: d.id, confidence: conf })) made++;
    }
  }

  return made;
}

function runRetentionSweep() {
  const ts = nowMs();

  // 0) Generate new draft suggestions
  const gen = generateDraftsFromMissionControl();
  const generated = gen.inserted;

  // 0.25) Reflection questions (always visible)
  const questionsMade = generateReflectionQuestions();

  // 0.5) Mark conflicts (do this before auto-approve)
  const newlyFlaggedConflicts = markConflicts();

  // 1) Auto-approve very high confidence drafts (autonomous operation)
  // Keep this conservative to avoid writing bad canon.
  const auto = db.prepare(`
    SELECT id FROM memory_items
    WHERE bank='draft' AND status='pending'
      AND confidence >= 0.93
      AND (approval_notes IS NULL OR approval_notes NOT LIKE '%CONFLICTS_WITH:%')
      AND (category LIKE 'preference/%' OR category LIKE 'ops/%' OR category LIKE 'system/%')
    ORDER BY updated_at ASC
    LIMIT 200
  `).all();

  for (const r of auto) {
    db.prepare(`
      UPDATE memory_items
      SET bank='approved', status='approved', approved_at=@ts, approved_by='system', approval_notes='auto-approved',
          reaffirmed_at=@ts, expires_at=NULL, updated_at=@ts
      WHERE id=@id
    `).run({ id: r.id, ts });

    db.prepare(`
      INSERT INTO memory_events (id, created_at, type, memory_id, actor, detail_json)
      VALUES (@id, @created_at, @type, @memory_id, @actor, @detail_json)
    `).run({
      id: 'evt_' + nanoid(10),
      created_at: ts,
      type: 'auto_approved',
      memory_id: r.id,
      actor: 'system',
      detail_json: JSON.stringify({ threshold: 0.93 }),
    });
  }

  // 2) Auto-reject low-quality drafts (noise control)
  const lowq = db.prepare(`
    SELECT id, statement
    FROM memory_items
    WHERE bank='draft' AND status='pending'
    LIMIT 800
  `).all();

  let lowqRejected = 0;
  for (const r of lowq) {
    const s = String(r.statement || '').trim();
    const bad = (
      s.length < 18 ||
      s.length > 260 ||
      /\*\*|```|\[\[|\]\]|<\/|<br\s*\/>/i.test(s) ||
      /^should\s*\+\s*\+/.test(s) ||
      /^should\s+i\b/i.test(s)
    );
    if (bad) {
      db.prepare(`UPDATE memory_items SET status='rejected', approval_notes='auto-rejected: low quality', updated_at=@ts WHERE id=@id`).run({ id: r.id, ts });
      lowqRejected++;
    }
  }

  // 3) Expire old drafts
  const draftExpired = db.prepare(`
    SELECT id FROM memory_items
    WHERE bank='draft' AND status='pending' AND expires_at IS NOT NULL AND expires_at <= @ts
    ORDER BY expires_at ASC
    LIMIT 500
  `).all({ ts });

  for (const r of draftExpired) {
    db.prepare(`UPDATE memory_items SET status='rejected', updated_at=@ts WHERE id=@id`).run({ id: r.id, ts });
    db.prepare(`
      INSERT INTO memory_events (id, created_at, type, memory_id, actor, detail_json)
      VALUES (@id, @created_at, @type, @memory_id, @actor, @detail_json)
    `).run({
      id: 'evt_' + nanoid(10),
      created_at: ts,
      type: 'expired_draft',
      memory_id: r.id,
      actor: 'system',
      detail_json: JSON.stringify({ ttlDays: DRAFT_TTL_DAYS }),
    });
  }

  const approvedStale = db.prepare(`
    SELECT id, COALESCE(reaffirmed_at, approved_at, created_at) AS age_from
    FROM memory_items
    WHERE bank='approved' AND status='approved'
      AND COALESCE(reaffirmed_at, approved_at, created_at) <= @cut
    ORDER BY age_from ASC
    LIMIT 500
  `).all({ cut: ts - msDays(APPROVED_TTL_DAYS) });

  for (const r of approvedStale) {
    db.prepare(`
      UPDATE memory_items
      SET bank='draft', status='pending', updated_at=@ts,
          expires_at=@exp,
          approval_notes=COALESCE(approval_notes,'') || CASE WHEN approval_notes IS NULL OR approval_notes='' THEN '' ELSE ' | ' END || 'auto-downgraded (stale)'
      WHERE id=@id
    `).run({ id: r.id, ts, exp: ts + msDays(DRAFT_TTL_DAYS) });

    db.prepare(`
      INSERT INTO memory_events (id, created_at, type, memory_id, actor, detail_json)
      VALUES (@id, @created_at, @type, @memory_id, @actor, @detail_json)
    `).run({
      id: 'evt_' + nanoid(10),
      created_at: ts,
      type: 'auto_downgraded',
      memory_id: r.id,
      actor: 'system',
      detail_json: JSON.stringify({ approvedTtlDays: APPROVED_TTL_DAYS, draftTtlDays: DRAFT_TTL_DAYS }),
    });
  }

  // Keep MEMORY.md in sync if we changed approved set
  if (approvedStale.length || auto.length) {
    try { exportApprovedToMarkdown(); } catch {}
  }

  lastSweepStats = {
    at: new Date(ts).toISOString(),
    generatedDrafts: generated,
    genConsidered: gen.considered,
    genDupSkipped: gen.dupSkipped,
    questionsMade,
    conflictsFlagged: newlyFlaggedConflicts,
    autoApproved: auto.length,
    lowqRejected,
    draftExpired: draftExpired.length,
    approvedDowngraded: approvedStale.length
  };

  return lastSweepStats;
}

// run retention sweep periodically
setInterval(() => {
  try { runRetentionSweep(); } catch (e) { console.error('[memory-retention] sweep error', e); }
}, 10 * 60 * 1000);

// run once on startup
try { runRetentionSweep(); } catch (e) { console.error('[memory-retention] initial sweep error', e); }

app.get('/api/health', (req, res) => {
  const counts = db.prepare(`
    SELECT bank, status, COUNT(*) AS n
    FROM memory_items
    GROUP BY bank, status
  `).all();

  const ts = nowMs();
  const expSoon = db.prepare(`
    SELECT COUNT(*) AS n
    FROM memory_items
    WHERE bank='draft' AND status='pending' AND expires_at IS NOT NULL AND expires_at <= @soon
  `).get({ soon: ts + msDays(2) })?.n || 0;

  const staleApproved = db.prepare(`
    SELECT COUNT(*) AS n
    FROM memory_items
    WHERE bank='approved' AND status='approved'
      AND COALESCE(reaffirmed_at, approved_at, created_at) <= @cut
  `).get({ cut: ts - msDays(APPROVED_TTL_DAYS) })?.n || 0;

  res.json({
    ok: true,
    counts,
    expiringDraftsSoon: Number(expSoon),
    staleApproved: Number(staleApproved),
    lastSweep: lastSweepStats,
    ts: new Date().toISOString()
  });
});

app.get('/api/memories', (req, res) => {
  const bank = req.query.bank;
  const status = req.query.status;
  const q = (req.query.q || '').toString().trim();
  const conflictsOnly = (req.query.conflicts || '').toString() === '1';

  const where = [];
  const params = {};

  if (bank) { where.push('bank = @bank'); params.bank = bank; }
  if (status) { where.push('status = @status'); params.status = status; }
  if (q) {
    where.push('(statement LIKE @q OR title LIKE @q OR category LIKE @q)');
    params.q = `%${q}%`;
  }
  if (conflictsOnly) {
    where.push("approval_notes LIKE '%CONFLICTS_WITH:%'");
  }

  const sql = `
    SELECT * FROM memory_items
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY updated_at DESC
    LIMIT 500
  `;

  const rows = db.prepare(sql).all(params).map(normalizeItem);
  res.json({ ok: true, rows });
});

app.post('/api/memories', (req, res) => {
  const body = req.body || {};
  const id = 'mem_' + nanoid(10);
  const ts = nowMs();

  const bank = body.bank || 'draft';
  const status = body.status || 'pending';
  const expiresAt = (bank === 'draft' && status === 'pending') ? (ts + msDays(DRAFT_TTL_DAYS)) : null;

  const item = {
    id,
    created_at: ts,
    updated_at: ts,
    bank,
    title: body.title || null,
    statement: body.statement,
    category: body.category || null,
    confidence: Number.isFinite(body.confidence) ? body.confidence : 0.6,
    status,
    source_type: body.source_type || 'manual',
    source_ref: body.source_ref || null,
    source_agent_id: body.source_agent_id || null,
    source_notes: body.source_notes || null,
    approved_at: null,
    approved_by: null,
    approval_notes: null,
    expires_at: expiresAt,
    reaffirmed_at: null,
  };

  if (!item.statement || typeof item.statement !== 'string' || !item.statement.trim()) {
    return res.status(400).json({ ok: false, error: 'statement is required' });
  }

  db.prepare(`
    INSERT INTO memory_items (
      id, created_at, updated_at, bank, title, statement, category,
      confidence, status,
      source_type, source_ref, source_agent_id, source_notes,
      approved_at, approved_by, approval_notes,
      expires_at, reaffirmed_at
    ) VALUES (
      @id, @created_at, @updated_at, @bank, @title, @statement, @category,
      @confidence, @status,
      @source_type, @source_ref, @source_agent_id, @source_notes,
      @approved_at, @approved_by, @approval_notes,
      @expires_at, @reaffirmed_at
    )
  `).run(item);

  db.prepare(`
    INSERT INTO memory_events (id, created_at, type, memory_id, actor, detail_json)
    VALUES (@id, @created_at, @type, @memory_id, @actor, @detail_json)
  `).run({
    id: 'evt_' + nanoid(10),
    created_at: ts,
    type: 'created',
    memory_id: id,
    actor: body.actor || 'user',
    detail_json: JSON.stringify({}),
  });

  res.json({ ok: true, item: normalizeItem(db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)) });
});

app.post('/api/memories/:id/approve', (req, res) => {
  const id = req.params.id;
  const ts = nowMs();
  const actor = (req.body?.actor || 'zeus').toString();
  const notes = req.body?.notes || null;

  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });

  db.prepare(`
    UPDATE memory_items
    SET bank='approved', status='approved', approved_at=@ts, approved_by=@actor, approval_notes=@notes,
        reaffirmed_at=@ts, expires_at=NULL, updated_at=@ts
    WHERE id=@id
  `).run({ id, ts, actor, notes });

  db.prepare(`
    INSERT INTO memory_events (id, created_at, type, memory_id, actor, detail_json)
    VALUES (@id, @created_at, @type, @memory_id, @actor, @detail_json)
  `).run({
    id: 'evt_' + nanoid(10),
    created_at: ts,
    type: 'approved',
    memory_id: id,
    actor,
    detail_json: JSON.stringify({ notes }),
  });

  // Keep canonical MEMORY.md in sync (idempotent block replacement)
  let exportResult = null;
  try { exportResult = exportApprovedToMarkdown(); }
  catch (e) { exportResult = { ok: false, error: String(e) }; }

  res.json({ ok: true, item: normalizeItem(db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)), export: exportResult });
});

app.post('/api/memories/:id/reaffirm', (req, res) => {
  const id = req.params.id;
  const ts = nowMs();
  const actor = (req.body?.actor || 'zeus').toString();

  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  if (row.bank !== 'approved' || row.status !== 'approved') {
    return res.status(400).json({ ok: false, error: 'can only reaffirm approved memories' });
  }

  db.prepare(`UPDATE memory_items SET reaffirmed_at=@ts, updated_at=@ts WHERE id=@id`).run({ id, ts });
  db.prepare(`
    INSERT INTO memory_events (id, created_at, type, memory_id, actor, detail_json)
    VALUES (@id, @created_at, @type, @memory_id, @actor, @detail_json)
  `).run({
    id: 'evt_' + nanoid(10),
    created_at: ts,
    type: 'reaffirmed',
    memory_id: id,
    actor,
    detail_json: JSON.stringify({}),
  });

  res.json({ ok: true });
});

app.post('/api/memories/:id/reject', (req, res) => {
  const id = req.params.id;
  const ts = nowMs();
  const actor = (req.body?.actor || 'hermes').toString();
  const notes = req.body?.notes || null;

  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });

  // If rejecting an approved memory, remove it from canonical by downgrading back to draft+rejected
  if (row.bank === 'approved' && row.status === 'approved') {
    db.prepare(`
      UPDATE memory_items
      SET bank='draft', status='rejected', updated_at=@ts, expires_at=NULL
      WHERE id=@id
    `).run({ id, ts });
  } else {
    db.prepare(`
      UPDATE memory_items
      SET status='rejected', updated_at=@ts
      WHERE id=@id
    `).run({ id, ts });
  }

  db.prepare(`
    INSERT INTO memory_events (id, created_at, type, memory_id, actor, detail_json)
    VALUES (@id, @created_at, @type, @memory_id, @actor, @detail_json)
  `).run({
    id: 'evt_' + nanoid(10),
    created_at: ts,
    type: 'rejected',
    memory_id: id,
    actor,
    detail_json: JSON.stringify({ notes }),
  });

  // Keep canonical MEMORY.md in sync if we changed approved set
  if (row.bank === 'approved' && row.status === 'approved') {
    try { exportApprovedToMarkdown(); } catch {}
  }

  res.json({ ok: true });
});

app.post('/api/export/memory-md', (req, res) => {
  try {
    const out = exportApprovedToMarkdown();
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/questions', (req, res) => {
  const status = (req.query.status || 'open').toString();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const rows = db.prepare(`
    SELECT * FROM memory_questions
    WHERE status = @status
    ORDER BY updated_at DESC
    LIMIT @limit
  `).all({ status, limit });
  res.json({ ok: true, rows });
});

app.post('/api/questions/:id/answer', (req, res) => {
  const id = req.params.id;
  const ts = nowMs();
  const answer = String(req.body?.answer || '').trim();
  if (!answer) return res.status(400).json({ ok: false, error: 'answer required' });

  const q = db.prepare('SELECT * FROM memory_questions WHERE id=?').get(id);
  if (!q) return res.status(404).json({ ok: false, error: 'not found' });

  db.prepare(`UPDATE memory_questions SET status='answered', updated_at=@ts WHERE id=@id`).run({ ts, id });

  // Also create a draft memory capturing the answer
  const memId = 'mem_' + nanoid(10);
  db.prepare(`
    INSERT INTO memory_items (
      id, created_at, updated_at, bank, title, statement, category,
      confidence, status,
      source_type, source_ref, source_agent_id, source_notes,
      approved_at, approved_by, approval_notes,
      expires_at, reaffirmed_at
    ) VALUES (
      @id, @ts, @ts, 'draft', NULL, @statement, @category,
      @confidence, 'pending',
      'user_explicit', @source_ref, 'jarvis', @source_notes,
      NULL, NULL, NULL,
      @expires_at, NULL
    )
  `).run({
    id: memId,
    ts,
    statement: answer,
    category: 'profile/about',
    confidence: 0.92,
    source_ref: `question:${id}`,
    source_notes: `Answer to: ${q.question}`,
    expires_at: ts + msDays(DRAFT_TTL_DAYS)
  });

  res.json({ ok: true, createdDraft: memId });
});

app.post('/api/questions/:id/dismiss', (req, res) => {
  const id = req.params.id;
  const ts = nowMs();
  db.prepare(`UPDATE memory_questions SET status='dismissed', updated_at=@ts WHERE id=@id`).run({ ts, id });
  res.json({ ok: true });
});

app.post('/api/sweep', (req, res) => {
  try {
    const out = runRetentionSweep();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/debug-paths', (req, res) => {
  const p = path.join(__dirname, 'ui.html');
  res.json({
    __dirname,
    uiPath: p,
    uiExists: fs.existsSync(p),
    cwd: process.cwd(),
  });
});

app.get('/', (req, res) => {
  const p = path.join(__dirname, 'ui.html');
  const html = fs.readFileSync(p, 'utf8');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(html);
});

app.use('/assets', express.static(path.join(__dirname, 'assets')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dual-bank memory dashboard running: http://0.0.0.0:${PORT}`);
});

server.on('error', (err) => {
  console.error('[memory-server] listen error:', err);
  process.exitCode = 1;
});

// NOTE: In this OpenClaw runtime, processes sometimes exit immediately after listen.
// Keep an explicit timer to ensure the event loop stays alive.
setInterval(() => {}, 60 * 60 * 1000);
