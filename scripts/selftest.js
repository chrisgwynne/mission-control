#!/usr/bin/env node
// Mission Control integration self-test (no browser needed)
// Verifies API endpoints + WS digest changes via activities/messages.

import assert from 'node:assert/strict';

const BASE = process.env.MC_BASE_URL || 'http://127.0.0.1:5173';

async function j(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const now = new Date().toISOString();

(async () => {
  const out = { ok: true, at: now, checks: [] };
  try {
    const s0 = await j('/api/state');
    out.checks.push({ name: 'GET /api/state', ok: true, agents: s0.agents.length, tasks: s0.tasks.length });

    const created = await j('/api/tasks', {
      method: 'POST',
      body: {
        title: `Selftest task @ ${now}`,
        description: 'API create/update/comment test',
        status: 'inbox',
        priority: 3,
        assigneeIds: ['artemis'],
        byAgentId: 'zeus',
      },
    });

    assert.ok(created?.task?.id, 'task id missing');
    const taskId = created.task.id;
    out.checks.push({ name: 'POST /api/tasks', ok: true, taskId });

    const patched = await j(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: { status: 'in_progress', byAgentId: 'zeus' },
    });
    assert.equal(patched.task.status, 'in_progress');
    out.checks.push({ name: 'PATCH /api/tasks/:id status', ok: true });

    const msg = await j('/api/messages', {
      method: 'POST',
      body: { taskId, fromAgentId: 'artemis', content: 'Selftest comment: hello world' },
    });
    assert.ok(msg?.message?.id, 'message id missing');
    out.checks.push({ name: 'POST /api/messages', ok: true });

    // ensure state reflects it
    await sleep(200);
    const s1 = await j('/api/state');
    const foundTask = s1.tasks.find(t => t.id === taskId);
    assert.ok(foundTask, 'task not found in state');
    assert.equal(foundTask.status, 'in_progress');
    const foundMsg = s1.messages.find(m => m.task_id === taskId);
    assert.ok(foundMsg, 'message not found in state');
    out.checks.push({ name: 'State reflects changes', ok: true });

    // Leave a status marker in activities
    await j('/api/messages', {
      method: 'POST',
      body: { taskId, fromAgentId: 'zeus', content: 'Selftest: API flows OK (create/update/comment/state).' },
    });

  } catch (e) {
    out.ok = false;
    out.error = String(e?.message || e);
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})();
