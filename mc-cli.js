#!/usr/bin/env node
import process from 'node:process';

const BASE = process.env.MC_BASE_URL || 'http://127.0.0.1:5173';

function usage() {
  console.log(`
Mission Control CLI (MVP)

Usage:
  node mc-cli.js state
  node mc-cli.js task:create --title "..." [--desc "..."] [--status inbox|assigned|in_progress|review|done|blocked] [--priority 1|2|3|4] [--assignee apollo] [--by zeus]
  node mc-cli.js task:update --id <taskId> [--status ...] [--assignees apollo,artemis] [--title "..."] [--desc "..."] [--by zeus]
  node mc-cli.js msg --task <taskId> --from zeus --text "..."
  node mc-cli.js agent:update --id apollo --status idle|active|working|blocked
  node mc-cli.js activity --type doc_note|decision_added --by jarvis --text "..." [--task <taskId>]
  node mc-cli.js doc --by jarvis --title "..." --text "..."
  node mc-cli.js decision --by jarvis --title "..." --text "..."
  node mc-cli.js room:post --room breakroom --from hermes --text "..."

Env:
  MC_BASE_URL=http://127.0.0.1:5173
`);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function has(name) {
  return process.argv.includes(name);
}

async function req(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function touchAgent(agentId, status = 'active') {
  if (!agentId) return;
  try {
    await req(`/api/agents/${agentId}`, { method: 'PATCH', body: { status, lastSeenAt: Date.now(), byAgentId: agentId } });
  } catch {
    // best-effort; don't break the caller
  }
}

const cmd = process.argv[2];
if (!cmd) { usage(); process.exit(1); }

try {
  if (cmd === 'state') {
    const s = await req('/api/state');
    console.log(JSON.stringify({
      agents: s.agents?.map(a => ({ id: a.id, status: a.status, role: a.role })) ?? [],
      tasks: s.tasks?.map(t => ({ id: t.id, status: t.status, title: t.title, assignees: t.assigneeIds })) ?? [],
      activities: s.activities?.slice(0, 5) ?? [],
    }, null, 2));
  } else if (cmd === 'task:create') {
    const title = arg('--title');
    if (!title) throw new Error('--title required');
    const description = arg('--desc') || '';
    const status = arg('--status') || 'inbox';
    const priority = Number(arg('--priority') || 2);
    const assignee = arg('--assignee');
    const assigneeIds = assignee ? [assignee] : [];
    const byAgentId = arg('--by') || 'zeus';
    const out = await req('/api/tasks', { method: 'POST', body: { title, description, status, priority, assigneeIds, byAgentId } });
    await touchAgent(byAgentId, 'active');
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'task:update') {
    const id = arg('--id');
    if (!id) throw new Error('--id required');
    const status = arg('--status');
    const title = arg('--title');
    const description = arg('--desc');
    const assignees = arg('--assignees');
    const assigneeIds = assignees ? assignees.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const byAgentId = arg('--by') || 'zeus';
    const out = await req(`/api/tasks/${id}`, { method: 'PATCH', body: { status: status ?? undefined, title: title ?? undefined, description: description ?? undefined, assigneeIds, byAgentId } });
    await touchAgent(byAgentId, 'active');
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'msg') {
    const taskId = arg('--task');
    const fromAgentId = arg('--from') || null;
    const content = arg('--text');
    if (!taskId || !content) throw new Error('--task and --text required');
    const out = await req('/api/messages', { method: 'POST', body: { taskId, fromAgentId, content } });
    await touchAgent(fromAgentId || 'zeus', 'active');
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'agent:update') {
    const id = arg('--id');
    const status = arg('--status');
    if (!id || !status) throw new Error('--id and --status required');
    const out = await req(`/api/agents/${id}`, { method: 'PATCH', body: { status, lastSeenAt: Date.now(), byAgentId: id } });
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'activity') {
    const type = arg('--type');
    const agentId = (arg('--by') || 'jarvis').toLowerCase();
    const text = arg('--text');
    const taskId = arg('--task') || null;
    if (!type || !text) throw new Error('--type and --text required');
    const out = await req('/api/activities', { method: 'POST', body: { type, agentId, taskId, message: text } });
    await touchAgent(agentId, 'active');
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'doc') {
    const agentId = (arg('--by') || 'jarvis').toLowerCase();
    const title = arg('--title') || '';
    const text = arg('--text');
    if (!text) throw new Error('--text required');
    const msg = title ? `${title} — ${text}` : text;
    const out = await req('/api/activities', { method: 'POST', body: { type: 'doc_note', agentId, taskId: null, message: msg } });
    await touchAgent(agentId, 'active');
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'room:post') {
    const roomId = arg('--room') || 'breakroom';
    const fromAgentId = (arg('--from') || 'hermes').toLowerCase();
    const content = arg('--text');
    if (!content) throw new Error('--text required');
    const out = await req(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: 'POST', body: { fromAgentId, content } });
    await touchAgent(fromAgentId, 'active');
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'decision') { 
    const agentId = (arg('--by') || 'jarvis').toLowerCase();
    const title = arg('--title') || '';
    const text = arg('--text');
    if (!text) throw new Error('--text required');
    const msg = title ? `${title} — ${text}` : text;
    const out = await req('/api/activities', { method: 'POST', body: { type: 'decision_added', agentId, taskId: null, message: msg } });
    await touchAgent(agentId, 'active');
    console.log(JSON.stringify(out, null, 2));
  } else {
    usage();
    process.exit(1);
  }
} catch (e) {
  console.error(String(e?.message || e));
  process.exit(1);
}
