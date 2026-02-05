// Mission Control UI wiring (MVP)

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  agents: [],
  tasks: [],
  messages: [],
  activities: [],
};

// Health modal state
let healthTimer = null;

const STATUS_LABELS = {
  inbox: 'Inbox',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
};

// Per-agent avatar/emoji (UI-only). Keep this simple and explicit.
const AGENT_EMOJI = {
  zeus: '⚡️',
  hermes: '🛰️',
  jarvis: '🦝',
  apollo: '🧠',
  artemis: '🏹',
  ares: '⚔️',
  prometheus: '🔥',
  health: '🩺',
};

function agentEmoji(agentIdOrName) {
  const key = String(agentIdOrName || '').toLowerCase();
  return AGENT_EMOJI[key] || '👤';
}

function normalizeTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return Date.now();
  // if seconds, convert to ms
  return n < 1e12 ? n * 1000 : n;
}

function timeAgo(ts) {
  const t = normalizeTs(ts);
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 8) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 24) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Format content: unescape literal newlines, then apply basic formatting
function formatContent(s) {
  let text = String(s);
  // Convert literal \n to actual newlines
  text = text.replace(/\\n/g, '\n');
  // Convert literal \t to actual tabs
  text = text.replace(/\\t/g, '\t');
  return text;
}

// Render content with formatting: handles newlines, code blocks, bold, italic
function renderContent(s) {
  let text = formatContent(s);
  
  // Escape HTML first
  text = esc(text);
  
  // Format code blocks ```code```
  text = text.replace(/```([^`]+)```/g, '<pre class="bg-paper-100 border border-line rounded-lg p-3 text-xs overflow-x-auto my-2"><code>$1</code></pre>');
  
  // Format inline code `code`
  text = text.replace(/`([^`]+)`/g, '<code class="bg-paper-100 border border-line rounded px-1.5 py-0.5 text-xs font-mono">$1</code>');
  
  // Format bold **text** or __text__
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  
  // Format italic *text* or _text_
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/_([^_]+)_/g, '<em>$1</em>');
  
  // Convert newlines to <br> for HTML rendering (when not in pre blocks)
  // Split by pre blocks, process only non-pre parts
  const parts = text.split(/(<pre[^>]*>.*?<\/pre>)/s);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('<pre')) {
      parts[i] = parts[i].replace(/\n/g, '<br>');
    }
  }
  text = parts.join('');
  
  return text;
}

// Comment read tracking
const READ_STORAGE_KEY = 'mc_task_read_times';

function getLastReadTime(taskId) {
  try {
    const data = JSON.parse(localStorage.getItem(READ_STORAGE_KEY) || '{}');
    return data[taskId] || 0;
  } catch {
    return 0;
  }
}

function markTaskAsRead(taskId) {
  try {
    const data = JSON.parse(localStorage.getItem(READ_STORAGE_KEY) || '{}');
    data[taskId] = Date.now();
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore storage errors
  }
}

function getUnreadCommentCount(taskId) {
  const lastRead = getLastReadTime(taskId);
  const comments = (state.messages || []).filter(m => m.task_id === taskId);
  return comments.filter(c => Number(c.created_at || 0) > lastRead).length;
}

function renderAgents() {
  const wrap = $('#agentsList');
  if (!wrap) return;

  wrap.innerHTML = state.agents.map(a => {
    const id = String(a.id || '').toLowerCase();
    const isJarvis = id === 'jarvis' || String(a.name || '').toLowerCase() === 'jarvis';

    // Check last_seen_at for recent activity
    const lastSeen = a.last_seen_at ? normalizeTs(Number(a.last_seen_at)) : 0;
    const minsSinceActive = lastSeen ? Math.floor((Date.now() - lastSeen) / (60 * 1000)) : Infinity;
    const isRecentlyActive = minsSinceActive < 5; // Active if seen in last 5 min

    // Normalize status
    let status = (a.status || 'idle').toLowerCase();
    if (isJarvis) status = 'active';
    else if (isRecentlyActive) status = 'active';

    // Show "X min ago" if recently active, otherwise "Idle"
    let label;
    if (isJarvis) label = 'Active';
    else if (isRecentlyActive) label = `${minsSinceActive}m ago`;
    else label = 'Idle';

    const dot = isRecentlyActive || isJarvis ? 'bg-[#32a852]' : 'bg-[#c8b69c]';
    const pillBg = isRecentlyActive || isJarvis
      ? 'bg-[#eef7f1] border-[#cfe7d8]'
      : 'bg-chip-bg border-chip-line';

    // Last active chip for idle agents with refined color coding
    let lastActiveChip = '';
    if (!isRecentlyActive && !isJarvis && lastSeen) {
      const minsSince = Math.floor((Date.now() - lastSeen) / (60 * 1000));
      const hrsSince = Math.floor(minsSince / 60);
      const chipColor = minsSince < 60 ? 'bg-[#fff7ed] border-[#fed7aa] text-[#9a3412]' : 'bg-paper-100 border-line text-ink-600';
      const exactTime = new Date(lastSeen).toLocaleString();
      lastActiveChip = `<span class="text-[10px] ${chipColor} border rounded-full px-2 py-1" title="Last active: ${exactTime}">${timeAgo(lastSeen)}</span>`;
    }

    return `
      <div class="rounded-xl border border-line bg-white shadow-sm px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:shadow-soft" data-agent-id="${esc(a.id)}">
        <div class="h-10 w-10 rounded-xl bg-paper-100 border border-line grid place-items-center text-lg">
          ${esc(agentEmoji(a.id || a.name))}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold truncate">${esc(a.name)}</div>
          </div>
          <div class="text-xs text-ink-600 truncate">${esc(a.role || '')}</div>
        </div>
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full ${dot}"></span>
          <span class="text-[10px] tracking-[0.18em] uppercase text-ink-700 ${pillBg} rounded-full px-2 py-1">${esc(label)}</span>
          ${lastActiveChip}
        </div>
      </div>
    `;
  }).join('');

  $('#agentsCount')?.replaceChildren(document.createTextNode(String(state.agents.length)));
}

function tasksByStatus() {
  const groups = {};
  for (const t of state.tasks) {
    const s = t.status || 'inbox';
    groups[s] ||= [];
    groups[s].push(t);
  }
  return groups;
}

function boardFilterFn(t) {
  if (String(t.status) === 'archived') return false;
  if (boardFilter === 'all') return true;
  const di = dueInfo(t);
  if (boardFilter === 'overdue') return di.overdue;
  if (boardFilter === 'dueSoon') return !di.overdue && di.remaining <= (60 * 60 * 1000);
  return true;
}

function displayAgentName(agentId) {
  const a = state.agents.find(x => String(x.id) === String(agentId));
  if (a?.name) return a.name;
  const s = String(agentId || '');
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Checklist removed (unused)

function renderKanban() {
  const columns = ['inbox', 'assigned', 'in_progress', 'review', 'done'];

  const visibleTasks = (state.tasks || []).filter(boardFilterFn);
  const compactMode = visibleTasks.length > 15;

  // Rebuild groups from visible tasks
  const groups = {};
  for (const t of visibleTasks) {
    const s = t.status || 'inbox';
    groups[s] ||= [];
    groups[s].push(t);
  }

  for (const key of columns) {
    const col = $(`#col-${key}`);
    const count = $(`#count-${key}`);
    if (!col) continue;

    const items = (groups[key] || []).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    if (count) count.textContent = String(items.length);

    col.innerHTML = items.map(t => {
      // Check for unread comments on this task (for both compact and full modes)
      const unreadCount = getUnreadCommentCount(t.id);
      const commentBadge = unreadCount > 0
        ? `<span class="absolute top-2 right-2 h-4 w-4 rounded-full bg-[#b45309] text-white text-[8px] font-semibold grid place-items-center shadow-sm" title="${unreadCount} new comment${unreadCount === 1 ? '' : 's'}"></span>`
        : '';

      if (compactMode) {
        return `
          <article draggable="true" class="task-card relative bg-white border border-line rounded-xl2 shadow-card px-4 py-3 cursor-pointer hover:shadow-soft" data-task-id="${esc(t.id)}">
            ${commentBadge}
            <div class="text-sm font-semibold truncate">${esc(t.title)}</div>
          </article>
        `;
      }

      const assignees = (t.assigneeIds || []).slice(0, 3);
      const pm = priorityMeta(t.priority);
      const chips = [
        pm.label,
        STATUS_LABELS[t.status] || t.status,
      ];

      const assigneeNames = assignees.map(displayAgentName);
      const primary = assignees[0] || '';

      // Full-size badge with unread count
      const fullCommentBadge = unreadCount > 0
        ? `<span class="absolute top-3 right-3 h-5 w-5 rounded-full bg-[#b45309] text-white text-[10px] font-semibold grid place-items-center shadow-sm" title="${unreadCount} new comment${unreadCount === 1 ? '' : 's'}">${unreadCount > 9 ? '9+' : unreadCount}</span>`
        : '';

      const di = dueInfo(t);
      const needsApproval = Number(t.needs_approval) === 1;
      const launchGate = String(t.launch_gate || (needsApproval ? 'review' : 'auto'));
      const criticalClass = Number(t.priority) === 4 ? 'mc-critical' : '';
      const approvalChip = needsApproval ? `<span class="text-[10px] uppercase tracking-[0.14em] rounded-full px-2 py-1 border bg-[#fdecec] border-[#f5caca] text-[#7a1c14]">Approval</span>` : '';
      const gateChip = launchGate === 'review'
        ? `<span class="text-[10px] uppercase tracking-[0.14em] rounded-full px-2 py-1 border bg-[#eef2ff] border-[#c7d2fe] text-[#1e3a8a]">Review</span>`
        : `<span class="text-[10px] uppercase tracking-[0.14em] rounded-full px-2 py-1 border bg-[#f3f4f6] border-[#e5e7eb] text-ink-700">Auto</span>`;
      const dueChip = '';

      const reportChip = t.latestReport && t.latestReport.id
        ? `<span class="text-[10px] uppercase tracking-[0.14em] rounded-full px-2 py-1 border bg-[#eef7f1] border-[#cfe7d8] text-ink-700">📄 Report</span>`
        : '';

      const reportQuick = t.latestReport && t.latestReport.id
        ? `<button class="reportQuickBtn hidden group-hover:block absolute top-3 right-10 h-7 w-7 rounded-full bg-white border border-line grid place-items-center hover:bg-paper-200" title="View report" data-report-id="${esc(t.latestReport.id)}">📄</button>`
        : '';

      // Severity color: always show by priority. Overdue overrides to red.
      const pr = Number(t.priority) || 1;
      let stripeColor = (
        pr === 4 ? '#b42318' :        // CRITICAL (red)
        pr === 3 ? '#b45309' :        // HIGH (amber)
        pr === 2 ? '#1d4ed8' :        // MEDIUM (blue)
        '#6b7280'                     // LOW (gray)
      );
      if (di.overdue) stripeColor = '#b42318';

      // Use inline style so Firefox + Tailwind CDN can't miss dynamic classes.
      const stripeStyle = `border-left: 4px solid ${stripeColor};`;
      const stripeBorder = '';

      return `
        <article draggable="true" style="${stripeStyle}" class="task-card group relative bg-white border border-line rounded-xl2 shadow-card p-4 cursor-pointer hover:shadow-soft ${criticalClass}" data-task-id="${esc(t.id)}">
          ${fullCommentBadge}
          ${reportQuick}
          <div class="text-sm font-semibold">${esc(t.title)}</div>
          <p class="mt-2 text-xs text-ink-600 leading-relaxed line-clamp-3">${renderContent(t.description || '')}</p>
          <div class="mt-3 flex flex-wrap gap-1.5">
            ${reportChip}
            ${gateChip}
            ${approvalChip}
            ${dueChip}
          </div>
          <div class="mt-4 flex items-center justify-between text-[11px] text-ink-600">
            <span class="inline-flex items-center gap-2">
              <span class="h-6 w-6 rounded-full border border-line bg-paper-100 grid place-items-center">${esc(agentEmoji(primary))}</span>
              <span>${esc(assigneeNames.join(', ') || 'Unassigned')}</span>
            </span>
            <span>${esc(timeAgo(t.updated_at))}</span>
          </div>
        </article>
      `;
    }).join('');
  }

  // top tabs counts
  const tabMap = {
    inbox: '#tabCount-inbox',
    assigned: '#tabCount-assigned',
    in_progress: '#tabCount-in_progress',
    review: '#tabCount-review',
    done: '#tabCount-done',
  };
  for (const [status, sel] of Object.entries(tabMap)) {
    const el = $(sel);
    if (el) el.textContent = String((groups[status] || []).length);
  }

  // Setup drag and drop after rendering
  setupDragAndDrop(columns);
}

function setupDragAndDrop(columnKeys) {
  // Track dragged task
  let draggedTaskId = null;

  // Setup task cards (drag sources)
  document.querySelectorAll('.task-card').forEach(card => {
    // Remove any existing listeners to avoid duplicates on re-render
    card.removeEventListener('dragstart', card._dragStartHandler);
    card.removeEventListener('dragend', card._dragEndHandler);

    card._dragStartHandler = (e) => {
      draggedTaskId = card.dataset.taskId;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedTaskId);
    };

    card._dragEndHandler = () => {
      card.classList.remove('dragging');
      draggedTaskId = null;
      // Remove drag-over from all columns
      document.querySelectorAll('.col-drop-zone').forEach(col => {
        col.classList.remove('drag-over');
      });
    };

    card.addEventListener('dragstart', card._dragStartHandler);
    card.addEventListener('dragend', card._dragEndHandler);
  });

  // Setup columns (drop targets)
  columnKeys.forEach(key => {
    const col = $(`#col-${key}`);
    if (!col) {
      console.warn('Column not found:', key);
      return;
    }

    col.classList.add('col-drop-zone');
    col.dataset.status = key;

    // Remove old listeners to prevent duplicates on re-render
    col.removeEventListener('dragover', col._dragOverHandler);
    col.removeEventListener('dragleave', col._dragLeaveHandler);
    col.removeEventListener('drop', col._dropHandler);

    col._dragOverHandler = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    };

    col._dragLeaveHandler = () => {
      col.classList.remove('drag-over');
    };

    col._dropHandler = async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');

      const taskId = e.dataTransfer.getData('text/plain');
      const newStatus = col.dataset.status;

      console.log('Drop:', { taskId, newStatus, colId: col.id });

      if (!taskId || !newStatus) {
        console.warn('Missing taskId or newStatus');
        return;
      }

      // Find task and update if status changed
      const task = state.tasks.find(t => t.id === taskId);
      if (task && task.status !== newStatus) {
        try {
          await apiPatch(`/api/tasks/${taskId}`, { status: newStatus });
          // Optimistically update local state
          task.status = newStatus;
          task.updated_at = Date.now();
          // Re-render board
          renderBoard();
          // Broadcast update
          broadcast({ type: 'task_updated', taskId, status: newStatus });
        } catch (err) {
          console.error('Failed to move task:', err);
        }
      }
    };

    col.addEventListener('dragover', col._dragOverHandler);
    col.addEventListener('dragleave', col._dragLeaveHandler);
    col.addEventListener('drop', col._dropHandler);
  });
}

function activityKind(a) {
  const t = String(a?.type || '');
  if (t === 'task_created' || t === 'task_updated' || t === 'task_deleted' || t === 'task_archived' || t === 'task_linked') return 'tasks';
  if (t === 'approval_toggled' || t === 'checklist_updated') return 'status';
  if (t === 'message_sent' || t === 'comment_added') return 'comments';
  if (t.startsWith('doc_') || t === 'doc_note') return 'docs';
  if (t.startsWith('decision_') || t === 'decision_added') return 'decisions';
  if (t === 'agent_updated' || t === 'agent_ping') return 'status';
  if (t === 'room_message') return 'chat';
  return 'all';
}

function feedEmoji(a) {
  const t = String(a?.type || '');
  switch (t) {
    case 'task_created': return '🆕';
    case 'task_updated': return '🛠️';
    case 'task_deleted': return '🗑️';
    case 'task_archived': return '📦';
    case 'task_linked': return '🔗';
    case 'message_sent':
    case 'comment_added': return '💬';
    case 'agent_updated': return '🟢';
    case 'agent_ping': return '📣';
    case 'approval_toggled': return '✅';
    case 'checklist_updated': return '☑️';
    case 'doc_note': return '📄';
    case 'decision_added': return '🧠';
    case 'room_message': return '💬';
    default:
      if (t.startsWith('doc_')) return '📄';
      if (t.startsWith('decision_')) return '🧠';
      return '📌';
  }
}

function agentDisplay(agentId) {
  const a = state.agents.find(x => String(x.id) === String(agentId));
  const name = (a?.name || agentId || 'System');
  return String(name);
}

function feedTitle(a) {
  const who = agentDisplay(a.agent_id);
  const t = String(a?.type || '');
  const task = a.task_id ? state.tasks.find(x => x.id === a.task_id) : null;
  const taskTitle = task?.title ? `“${task.title}”` : null;

  if (t === 'task_created') return `${who} created a task${taskTitle ? `: ${taskTitle}` : ''}`;
  if (t === 'task_updated') return `${who} updated a task${taskTitle ? `: ${taskTitle}` : ''}`;
  if (t === 'task_deleted') return `${who} deleted a task${taskTitle ? `: ${taskTitle}` : ''}`;
  if (t === 'task_archived') return `${who} archived a task${taskTitle ? `: ${taskTitle}` : ''}`;
  if (t === 'task_linked') return `${who} linked tasks`;
  if (t === 'message_sent' || t === 'comment_added') return `${who} commented${taskTitle ? ` on ${taskTitle}` : ''}`;
  if (t === 'agent_updated') return `${who} updated status`;
  if (t === 'agent_ping') return `${who} received a message`;
  if (t === 'approval_toggled') return `${who} updated approval`;
  if (t === 'checklist_updated') return `${who} updated checklist`;
  if (t === 'doc_note' || t.startsWith('doc_')) return `${who} added a doc note`;
  if (t === 'decision_added' || t.startsWith('decision_')) return `${who} recorded a decision`;
  if (t === 'room_message') return `${who} posted in break room`;
  return `${who} activity`;
}

function renderFeed() {
  const wrap = $('#feedList');
  if (!wrap) return;

  let items = (state.activities || []).slice();

  // kind filter
  if (feedKind && feedKind !== 'all') {
    items = items.filter(a => activityKind(a) === feedKind);
  }

  // agent filter
  if (feedAgentId) {
    items = items.filter(a => String(a.agent_id || '') === String(feedAgentId));
  }

  items = items.slice(0, 12);

  const hint = $('#feedAgentHint');
  if (hint) {
    if (feedAgentId) {
      const ag = state.agents.find(x => x.id === feedAgentId);
      hint.classList.remove('hidden');
      hint.textContent = `Filtering to agent: ${(ag?.name || feedAgentId).toUpperCase()} (click “All” to reset)`;
    } else {
      hint.classList.add('hidden');
      hint.textContent = '';
    }
  }

  if (items.length === 0) {
    wrap.innerHTML = `<div class="text-sm text-ink-600">No items for this filter yet.</div>`;
    return;
  }

  wrap.innerHTML = items.map(a => {
    const whoLabel = agentDisplay(a.agent_id);
    const icon = feedEmoji(a);
    const title = feedTitle(a);
    const detail = a.message || '';

    const inferTaskId = (act) => {
      if (act.task_id) return act.task_id;
      const type = String(act.type || '');
      const msg = String(act.message || '');

      // Try to recover task title from the message patterns we emit
      // - "Task created: <title>"
      // - "New comment on: <title>"
      // - "Task deleted: <title>"
      let title = null;
      const m1 = msg.match(/Task created:\s*(.+)$/i);
      const m2 = msg.match(/New comment on:\s*(.+)$/i);
      const m3 = msg.match(/Task deleted:\s*(.+)$/i);
      const m4 = msg.match(/Task updated:\s*(.+)$/i);
      title = (m1?.[1] || m2?.[1] || m3?.[1] || m4?.[1] || '').trim();
      if (!title) return null;

      const t = (state.tasks || []).find(tt => String(tt.title) === title);
      return t?.id || null;
    };

    const taskId = inferTaskId(a);

    // For task-related items, clicking should open the task drawer. Avoid also tagging agent_id.
    const taskAttr = taskId ? ` data-task-id="${esc(taskId)}"` : '';
    const agentAttr = (!taskId && a.agent_id) ? ` data-agent-id="${esc(a.agent_id)}"` : '';

    const clickCls = (taskId || (!taskId && a.agent_id)) ? 'cursor-pointer hover:shadow-soft' : '';

    return `
      <div class="feedItem bg-white border border-line rounded-xl2 shadow-card p-3 mb-3 ${clickCls}"${taskAttr}${agentAttr}>
        <div class="flex items-start gap-3">
          <div class="h-8 w-8 rounded-xl bg-paper-100 border border-line grid place-items-center text-sm">${icon}</div>
          <div class="min-w-0">
            <div class="text-xs font-semibold">${esc(title)}</div>
            <div class="mt-1 text-[11px] text-ink-600">${esc(detail)}</div>
            <div class="mt-2 flex items-center gap-2 text-[10px] text-ink-600">
              <span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-[#c8b69c]"></span>${esc(whoLabel)}</span>
              <span>•</span>
              <span>${esc(timeAgo(a.created_at))}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderHeader() {
  const totalAgents = state.agents.length;
  // "Working" means: recently seen + not idle.
  // Special-case Jarvis: treat as working if there's recent UI/chat activity.
  const WORKING_WINDOW_MS = 10 * 60 * 1000;
  const now = Date.now();

  // If the dashboard is open and being interacted with, Jarvis is effectively "working".
  // Track local UI interaction timestamps (client-side), fallback to DB activities/messages.
  const jarvisRecent = () => {
    const local = Number(window.__mcLastInteractionAt || 0);
    if (local && (now - local) <= WORKING_WINDOW_MS) return true;

    const recentAct = (state.activities || []).some(a => {
      const who = String(a.agent_id || '').toLowerCase();
      if (who !== 'jarvis') return false;
      const t = Number(a.created_at || 0);
      return t && (now - t) <= WORKING_WINDOW_MS;
    });
    const recentMsg = (state.messages || []).some(m => {
      const who = String(m.from_agent_id || '').toLowerCase();
      if (who !== 'jarvis') return false;
      const t = Number(m.created_at || 0);
      return t && (now - t) <= WORKING_WINDOW_MS;
    });
    return recentAct || recentMsg;
  };

  const isWorking = (a) => {
    const id = String(a.id || '').toLowerCase();
    const status = (a.status || 'idle').toLowerCase();

    if (id === 'jarvis') {
      // If Jarvis is actively interacting (chatting/creating), count him as working.
      return jarvisRecent();
    }

    const seen = Number(a.last_seen_at || 0);
    const recent = seen && (now - seen) <= WORKING_WINDOW_MS;
    return recent && (status === 'working' || status === 'active');
  };

  const workingAgents = state.agents.filter(isWorking).length;
  const activeAgents = workingAgents;

  const activeTasks = state.tasks.filter(t => String(t.status) !== 'done' && String(t.status) !== 'archived').length;

  // Header count shows WORKING agents (not total agents)
  $('#hdrAgentsActive')?.replaceChildren(document.createTextNode(String(workingAgents)));
  $('#hdrTasksInQueue')?.replaceChildren(document.createTextNode(String(activeTasks)));

  // All Agents summary card (left sidebar)
  $('#allAgentsTotal')?.replaceChildren(document.createTextNode(String(totalAgents)));
  $('#allAgentsActive')?.replaceChildren(document.createTextNode(String(activeAgents)));
  $('#allAgentsWorking')?.replaceChildren(document.createTextNode(String(workingAgents)));

  // Mission Queue header
  $('#mqActive') && ($('#mqActive').textContent = `${activeTasks} active`);

  // rightAgentsCount removed

  const agentSelect = $('#feedAgentSelect');
  if (agentSelect) {
    const currentVal = agentSelect.value;
    agentSelect.innerHTML = '<option value="">All agents</option>' + state.agents.map(a => {
      const name = a.name || a.id;
      const emoji = agentEmoji(a.id || a.name);
      const selected = String(feedAgentId || '') === String(a.id) ? ' selected' : '';
      return `<option value="${esc(a.id)}"${selected}>${esc(emoji)} ${esc(name)}</option>`;
    }).join('');
    // Restore selection if still valid
    if (currentVal) agentSelect.value = currentVal;
  }
}

const AGENT_ABOUT = {
  zeus: 'Orchestrator and delegator. Breaks problems into tasks, assigns work, and keeps the board moving.',
  hermes: 'Ops / janitor. Keeps services running, fixes config, and removes friction.',
  apollo: 'Backend engineer. Builds APIs, data models, and server-side integrations.',
  artemis: 'Frontend engineer. UI/UX implementation, interaction polish, and layout consistency.',
  ares: 'Bug hunter / skills. Finds issues, patches them, and packages repeatable workflows.',
  prometheus: 'Researcher. Digs up context, options, tradeoffs, and summarizes findings.',
  jarvis: 'Your assistant (you-only). Oversees the system and helps you drive it.'
};

function agentLevelLabel(level) {
  const l = String(level || 'spc').toLowerCase();
  if (l === 'lead') return 'Lead';
  if (l === 'boss') return 'Boss';
  return 'Specialist';
}

function findMentionsForAgent(agent) {
  const id = String(agent.id || '').toLowerCase();
  const name = String(agent.name || '').toLowerCase();
  const rx = new RegExp(`(?:^|\\s)@(${id}|${name.replace(/[-/\\^$*+?.()|[\\]{}]/g,'\\\\$&')})(?:\\b|$)`, 'i');

  const hits = [];
  for (const a of (state.activities || [])) {
    if (rx.test(a.message || '')) hits.push({ kind: 'activity', row: a });
  }
  for (const m of (state.messages || [])) {
    if (rx.test(m.content || '')) hits.push({ kind: 'comment', row: m });
  }
  // Break room mentions are persisted; we will fetch them separately for unread tracking.
  return hits.slice(0, 20);
}

function renderAgentModal() {
  const agent = state.agents.find(a => a.id === currentAgentId);
  if (!agent) return;

  $('#agentModalAvatar').textContent = agentEmoji(agent.id);
  $('#agentModalName').textContent = agent.name;
  $('#agentModalRole').textContent = agent.role || '—';
  $('#agentModalLevel').textContent = agentLevelLabel(agent.level);

  const idLower = String(agent.id || '').toLowerCase();
  const isJarvis = idLower === 'jarvis' || String(agent.name || '').toLowerCase() === 'jarvis';

  const status = (agent.status || 'idle').toLowerCase();
  const recentSeen = agent.last_seen_at && (state.serverTime - agent.last_seen_at) < (5 * 60 * 1000);
  const isWorking = isJarvis || recentSeen || status === 'working' || status === 'active';

  const statusPill = $('#agentModalStatusPill');
  if (statusPill) {
    statusPill.className = `inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] rounded-full px-4 py-2 ${isWorking ? 'bg-[#e6f4ec] border border-[#cfe7d8] text-ink-800' : 'bg-white border border-line text-ink-700'}`;
    statusPill.innerHTML = `<span class="h-2 w-2 rounded-full ${isWorking ? 'bg-[#32a852]' : 'bg-[#c8b69c]'}"></span><span>${isWorking ? 'WORKING' : 'IDLE'}</span>`;
  }

  // Last active chip - shows when agent was last seen (only when idle)
  const lastActiveChip = $('#agentModalLastActive');
  const lastActiveTime = $('#agentModalLastActiveTime');
  if (lastActiveChip && lastActiveTime) {
    if (!isWorking && agent.last_seen_at) {
      const lastSeen = normalizeTs(agent.last_seen_at);
      const minsSince = Math.floor((Date.now() - lastSeen) / (60 * 1000));
      const chipColor = minsSince < 60 ? 'bg-[#fff7ed] border-[#fed7aa] text-[#9a3412]' : 'bg-paper-100 border-line text-ink-600';
      lastActiveChip.classList.remove('hidden');
      lastActiveChip.className = `inline-flex items-center text-[11px] border rounded-full px-3 py-1.5 ${chipColor}`;
      lastActiveTime.textContent = timeAgo(lastSeen);
      lastActiveChip.title = `Last active: ${new Date(lastSeen).toLocaleString()}`;
    } else {
      lastActiveChip.classList.add('hidden');
    }
  }

  // Best-effort status reason: last activity by this agent
  const last = (state.activities || []).find(a => a.agent_id === agent.id);
  $('#agentModalStatusReason').textContent = last ? last.message : 'No recent activity logged.';
  $('#agentModalSince').textContent = last ? `Since ${timeAgo(last.created_at)}` : '';

  // Currently working on: tasks assigned to agent that are in_progress/review/assigned
  const assigned = (state.tasks || []).filter(t => (t.assigneeIds || []).includes(agent.id));
  const working = assigned.filter(t => ['in_progress', 'review', 'assigned'].includes(String(t.status)));
  const cw = $('#agentModalCurrentWork');
  if (cw) {
    if (working.length === 0) cw.textContent = '—';
    else cw.innerHTML = working.slice(0, 3).map(t => `<div class="truncate">• ${esc(t.title)} <span class="text-xs text-ink-500">(${esc(STATUS_LABELS[t.status] || t.status)})</span></div>`).join('');
  }

  // Last task worked on: most recent activity by this agent with a task_id
  const lastWithTask = (state.activities || []).find(a => a.agent_id === agent.id && a.task_id);
  const lt = $('#agentModalLastTask');
  if (lt) {
    const t = lastWithTask ? (state.tasks || []).find(tt => tt.id === lastWithTask.task_id) : null;
    lt.textContent = t ? `${t.title}` : (lastWithTask ? `Task ${lastWithTask.task_id}` : '—');
  }

  $('#agentModalAbout').textContent = AGENT_ABOUT[String(agent.id).toLowerCase()] || '—';

  // Stats
  const agentId = String(agent.id || '');
  const assignedAll = (state.tasks || []).filter(t => (t.assigneeIds || []).map(String).includes(agentId));
  const doneCount = assignedAll.filter(t => ['done', 'archived'].includes(String(t.status))).length;
  const active = assignedAll.filter(t => ['assigned', 'in_progress', 'review', 'blocked', 'inbox'].includes(String(t.status)));
  const activeCount = active.length;
  const dueSoonCount = active.filter(t => {
    const di = dueInfo(t);
    return !di.overdue && di.remaining <= (60 * 60 * 1000);
  }).length;
  const overdueCount = active.filter(t => dueInfo(t).overdue).length;

  const commentsCount = Number(agent.commentCount ?? (state.messages || []).filter(m => String(m.from_agent_id || '') === agentId).length);

  $('#agentStatDone') && ($('#agentStatDone').textContent = String(doneCount));
  $('#agentStatActive') && ($('#agentStatActive').textContent = String(activeCount));
  $('#agentStatDueSoon') && ($('#agentStatDueSoon').textContent = String(dueSoonCount));
  $('#agentStatOverdue') && ($('#agentStatOverdue').textContent = String(overdueCount));
  $('#agentStatComments') && ($('#agentStatComments').textContent = String(commentsCount));

  const lastSeen = agent.last_seen_at ? timeAgo(agent.last_seen_at) : null;
  $('#agentStatLastSeen') && ($('#agentStatLastSeen').textContent = lastSeen ? lastSeen : (isJarvis ? 'Now' : '—'));

  const mentions = findMentionsForAgent(agent);
  const mentionsList = $('#agentMentionsList');

  // Include persisted break room mentions (unread-aware)
  let roomMentions = [];
  try {
    // async fetch in background
    apiMentions(agent.id, 50).then(out => {
      roomMentions = (out.mentions || []).filter(x => !x.read_at);
      const total = mentions.length + roomMentions.length;
      $('#agentTabAttentionCount').textContent = String(total);

      if (mentionsList) {
        const rows = [];

        // Break room mentions first
        for (const rm of roomMentions.slice(0, 10)) {
          rows.push({
            who: displayAgentName(rm.from_agent_id || 'system'),
            when: timeAgo(rm.message_created_at || rm.created_at),
            text: rm.content,
            kind: 'breakroom'
          });
        }

        for (const h of mentions.slice(0, 10)) {
          rows.push({
            who: h.kind === 'comment' ? displayAgentName(h.row.from_agent_id || 'system') : displayAgentName(h.row.agent_id || 'system'),
            when: timeAgo(h.row.created_at),
            text: h.kind === 'comment' ? h.row.content : h.row.message,
            kind: h.kind
          });
        }

        mentionsList.innerHTML = rows.map(r => `
          <div class="bg-paper-50 border border-line rounded-xl px-3 py-2">
            <div class="flex items-center justify-between text-[11px] text-ink-600">
              <div>${esc(r.who)}${r.kind==='breakroom' ? ' • Break room' : ''}</div><div>${esc(r.when)}</div>
            </div>
            <div class="mt-1 text-sm text-ink-800">${renderContent(r.text)}</div>
          </div>
        `).join('') || `<div class="text-sm text-ink-600">No recent @mentions.</div>`;
      }

      // Mark break room mentions as read when viewing attention
      if (roomMentions.length) {
        apiMentionsRead(agent.id, 'breakroom').catch(() => {});
      }

    }).catch(() => {
      $('#agentTabAttentionCount').textContent = String(mentions.length);
    });
  } catch {
    // ignore
  }

  // Done tab: show completed tasks with outcomes/completion summaries
  const doneTasks = assignedAll
    .filter(t => ['done', 'archived'].includes(String(t.status)))
    .sort((a, b) => Number(b.updated_at || b.created_at) - Number(a.updated_at || a.created_at));
  
  // Find completion summaries for done tasks
  const doneTasksWithOutcomes = doneTasks.map(t => {
    const taskMessages = (state.messages || []).filter(m => m.task_id === t.id);
    const completionMsg = taskMessages.find(m => 
      m.content && (
        m.content.includes('✅ Completed') || 
        m.content.includes('Completion summary') ||
        m.content.includes('OUTCOME') ||
        m.content.includes('What I did:')
      )
    );
    return { task: t, outcome: completionMsg?.content || null };
  }).filter(item => item.outcome); // Only keep tasks with outcomes

  $('#agentTabAttentionCount').textContent = String(doneTasksWithOutcomes.length);

  if (mentionsList) {
    mentionsList.innerHTML = doneTasksWithOutcomes.map(({ task, outcome }) => {
      const when = timeAgo(task.updated_at || task.created_at);
      return `<div class="bg-paper-50 border border-line rounded-xl px-3 py-2 cursor-pointer hover:shadow-soft" data-task-id="${esc(task.id)}">
        <div class="flex items-center justify-between text-[11px] text-ink-600">
          <div class="font-medium">${esc(task.title)}</div>
          <div>${esc(when)}</div>
        </div>
        <div class="mt-2 text-sm text-ink-800">${renderContent(outcome)}</div>
      </div>`;
    }).join('') || `<div class="text-sm text-ink-600">No completed tasks with outcomes yet.</div>`;
  }

  const timeline = $('#agentTimelineList');
  if (timeline) {
    const rows = (state.activities || []).filter(a => a.agent_id === agent.id).slice(0, 25);
    timeline.innerHTML = rows.map(a => {
      const title = feedTitle(a);
      const icon = feedEmoji(a);
      const taskId = a.task_id || null;
      const taskAttr = taskId ? ` data-task-id="${esc(taskId)}"` : '';
      const clickCls = taskId ? 'cursor-pointer hover:shadow-soft' : '';
      return `<div class="bg-white border border-line rounded-xl2 p-4 ${clickCls}"${taskAttr}>
        <div class="flex items-center justify-between">
          <div class="text-xs font-semibold">${esc(icon)} ${esc(title)}</div>
          <div class="text-[11px] text-ink-600">${esc(timeAgo(a.created_at))}</div>
        </div>
        <div class="mt-2 text-sm text-ink-800">${renderContent(a.message)}</div>
      </div>`;
    }).join('') || `<div class="text-sm text-ink-600">No timeline entries yet.</div>`;
  }
}

function renderArchived() {
  const list = $('#archivedList');
  const count = $('#archivedCount');
  if (!list) return;

  const q = (archivedQuery || '').trim().toLowerCase();
  const archived = (state.tasks || []).filter(t => String(t.status) === 'archived')
    .filter(t => {
      if (!q) return true;
      return String(t.title || '').toLowerCase().includes(q) || String(t.description || '').toLowerCase().includes(q);
    })
    .slice(0, 50);

  if (count) count.textContent = `${archived.length} archived`;

  list.innerHTML = archived.map(t => {
    const pm = priorityMeta(t.priority);
    const assignees = (t.assigneeIds || []).map(displayAgentName).join(', ') || 'Unassigned';
    const when = timeAgo(t.updated_at || t.created_at);
    return `
      <div class="bg-white border border-line rounded-xl2 shadow-card p-4 cursor-pointer hover:shadow-soft archivedItem" data-task-id="${esc(t.id)}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-semibold truncate">${esc(t.title)}</div>
            <div class="mt-1 text-xs text-ink-600 truncate">${esc(assignees)} • archived ${esc(when)}</div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] uppercase tracking-[0.14em] rounded-full px-2 py-1 border ${pm.cls}">${esc(pm.label)}</span>
            <button class="archivedRestore text-xs font-semibold bg-white border border-line rounded-full px-3 py-1.5 hover:bg-paper-200" data-task-id="${esc(t.id)}">Restore</button>
            <button class="archivedDup text-xs font-semibold bg-chip-bg border border-chip-line rounded-full px-3 py-1.5 hover:bg-paper-200" data-task-id="${esc(t.id)}">Duplicate</button>
          </div>
        </div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-ink-600">No archived tasks found.</div>`;
}

function renderBreakroom() {
  const wrap = $('#breakroomList');
  if (!wrap) return;
  wrap.innerHTML = (breakroomMessages || []).slice().reverse().map(m => {
    const who = m.from_agent_id ? displayAgentName(m.from_agent_id) : 'System';
    return `
      <div class="bg-white border border-line rounded-xl2 shadow-card p-4">
        <div class="flex items-center justify-between">
          <div class="text-xs font-semibold">${esc(who)}</div>
          <div class="text-[11px] text-ink-600">${esc(timeAgo(m.created_at))}</div>
        </div>
        <div class="mt-2 text-sm text-ink-800">${renderContent(m.content)}</div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-ink-600">No messages yet.</div>`;
}

function renderAll() {
  renderHeader();
  renderAgents();
  renderKanban();
  renderFeed();
  if (currentTaskId) renderTaskModal();
  if (currentAgentId) renderAgentModal();
  if (archivedOpen) renderArchived();
  if (breakroomOpen) renderBreakroom();
}

function showBanner(text) {
  const b = $('#statusBanner');
  if (!b) return;
  b.classList.remove('hidden');
  if (text) {
    const first = b.querySelector('div > div');
    if (first) first.innerHTML = `<b>Server issue:</b> ${esc(text)}`;
  }
}

function hideBanner() {
  $('#statusBanner')?.classList.add('hidden');
}

let memoryStatsTimer = null;

async function loadMemoryStats() {
  try {
    const host = window.location.hostname;
    const url = `http://${host}:3000/api/health`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();

    // Questions (separate endpoint)
    let qOpen = 0;
    try {
      const qRes = await fetch(`http://${host}:3000/api/questions?status=open&limit=200`, { cache: 'no-store' });
      if (qRes.ok) {
        const qData = await qRes.json();
        qOpen = Array.isArray(qData.rows) ? qData.rows.length : 0;
      }
    } catch (e) {
      // ignore
    }

    const counts = Array.isArray(data.counts) ? data.counts : [];
    const getCount = (bank, status) => {
      const row = counts.find(c => c.bank === bank && c.status === status);
      return row ? Number(row.n || 0) : 0;
    };

    const draftPending = getCount('draft','pending');
    const approved = getCount('approved','approved');

    document.getElementById('memDraftCount')?.replaceChildren(document.createTextNode(String(draftPending)));
    const box = document.getElementById('memDraftBox');
    if (box) box.classList.toggle('draft-pulse', draftPending > 0);

    document.getElementById('memQCount')?.replaceChildren(document.createTextNode(String(qOpen)));
    const qbox = document.getElementById('memQBox');
    if (qbox) qbox.classList.toggle('draft-pulse', qOpen > 0);

    document.getElementById('memApprovedCount')?.replaceChildren(document.createTextNode(String(approved)));
    document.getElementById('hdrMemDraft')?.replaceChildren(document.createTextNode(String(draftPending)));
    document.getElementById('hdrMemApproved')?.replaceChildren(document.createTextNode(String(approved)));
    document.getElementById('hdrMemQ')?.replaceChildren(document.createTextNode(String(qOpen)));

    const memLink = document.getElementById('rightMemoryLink');
    if (memLink) memLink.href = `http://${host}:3000`;

    const tsMs = Date.parse(data.ts || '') || Date.now();
    document.getElementById('memLastSync')?.replaceChildren(document.createTextNode(''));
  } catch (e) {
    document.getElementById('memLastSync')?.replaceChildren(document.createTextNode('Memory dashboard offline/unreachable.'));
  }
}

async function loadState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.agents = data.agents || [];
    state.tasks = data.tasks || [];
    state.messages = data.messages || [];
    state.activities = data.activities || [];
    state.serverTime = data.serverTime || Date.now();
    hideBanner();
    renderAll();
  } catch (e) {
    showBanner('Could not load /api/state.');
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state' && msg.state) {
        state.agents = msg.state.agents || [];
        state.tasks = msg.state.tasks || [];
        state.messages = msg.state.messages || [];
        state.activities = msg.state.activities || [];
        state.serverTime = msg.state.serverTime || Date.now();
        hideBanner();
        renderAll();
      }
    } catch (e) {
      // ignore
    }
  });

  ws.addEventListener('close', () => {
    // reconnect
    setTimeout(connectWs, 1000);
  });
}

let currentTaskId = null;
let currentAgentId = null;

let feedKind = 'all';
let feedAgentId = null;

let docOpen = false;
let decisionOpen = false;

let pendingDoneTaskId = null;
let archivedOpen = false;
let archivedQuery = '';

let reportOpen = false;
let currentReportId = null;

let boardFilter = 'all'; // all|dueSoon|overdue
let quietMode = (localStorage.getItem('mc.quietMode') || '0') === '1';

let breakroomOpen = false;
let breakroomMessages = [];

function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }

function slideIn(panelId) {
  const panel = $(panelId);
  if (!panel) return;
  panel.classList.add('translate-x-full');
  panel.classList.remove('translate-x-0');
  requestAnimationFrame(() => {
    panel.classList.remove('translate-x-full');
    panel.classList.add('translate-x-0');
  });
}

function openModal(which) {
  show($('#modalBackdrop'));
  show($(which));

  if (which === '#taskModal') slideIn('#taskModalPanel');
  if (which === '#newTaskModal') slideIn('#newTaskPanel');
  if (which === '#agentModal') slideIn('#agentModalPanel');
  if (which === '#docModal') slideIn('#docModalPanel');
  if (which === '#decisionModal') slideIn('#decisionModalPanel');
  if (which === '#archivedModal') slideIn('#archivedModalPanel');
  if (which === '#breakroomModal') slideIn('#breakroomModalPanel');
  if (which === '#reportModal') slideIn('#reportModalPanel');
}

function closeAllModals() {
  const taskPanel = $('#taskModalPanel');
  const newPanel = $('#newTaskPanel');
  const agentPanel = $('#agentModalPanel');
  const docPanel = $('#docModalPanel');
  const decisionPanel = $('#decisionModalPanel');
  const archivedPanel = $('#archivedModalPanel');
  const breakroomPanel = $('#breakroomModalPanel');
  const reportPanel = $('#reportModalPanel');

  const taskOpen = !$('#taskModal')?.classList.contains('hidden');
  const newOpen = !$('#newTaskModal')?.classList.contains('hidden');
  const agentOpen = !$('#agentModal')?.classList.contains('hidden');
  const docIsOpen = !$('#docModal')?.classList.contains('hidden');
  const decisionIsOpen = !$('#decisionModal')?.classList.contains('hidden');
  const archivedIsOpen = !$('#archivedModal')?.classList.contains('hidden');
  const breakroomIsOpen = !$('#breakroomModal')?.classList.contains('hidden');
  const reportIsOpen = !$('#reportModal')?.classList.contains('hidden');

  if (taskOpen && taskPanel) {
    taskPanel.classList.remove('translate-x-0');
    taskPanel.classList.add('translate-x-full');
  }
  if (newOpen && newPanel) {
    newPanel.classList.remove('translate-x-0');
    newPanel.classList.add('translate-x-full');
  }
  if (agentOpen && agentPanel) {
    agentPanel.classList.remove('translate-x-0');
    agentPanel.classList.add('translate-x-full');
  }
  if (docIsOpen && docPanel) {
    docPanel.classList.remove('translate-x-0');
    docPanel.classList.add('translate-x-full');
  }
  if (decisionIsOpen && decisionPanel) {
    decisionPanel.classList.remove('translate-x-0');
    decisionPanel.classList.add('translate-x-full');
  }
  if (archivedIsOpen && archivedPanel) {
    archivedPanel.classList.remove('translate-x-0');
    archivedPanel.classList.add('translate-x-full');
  }
  if (breakroomIsOpen && breakroomPanel) {
    breakroomPanel.classList.remove('translate-x-0');
    breakroomPanel.classList.add('translate-x-full');
  }
  if (reportIsOpen && reportPanel) {
    reportPanel.classList.remove('translate-x-0');
    reportPanel.classList.add('translate-x-full');
  }

  const addAgentIsOpen = !$('#addAgentModal')?.classList.contains('hidden');
  const broadcastIsOpen = !$('#broadcastModal')?.classList.contains('hidden');
  const healthIsOpen = !$('#healthModal')?.classList.contains('hidden');

  if (taskOpen || newOpen || agentOpen || docIsOpen || decisionIsOpen || archivedIsOpen || breakroomIsOpen || reportIsOpen || addAgentIsOpen || broadcastIsOpen || healthIsOpen) {
    setTimeout(() => {
      hide($('#modalBackdrop'));
      hide($('#taskModal'));
      hide($('#newTaskModal'));
      hide($('#agentModal'));
      hide($('#docModal'));
      hide($('#decisionModal'));
      hide($('#archivedModal'));
      hide($('#breakroomModal'));
      hide($('#reportModal'));
      hide($('#addAgentModal'));
      hide($('#broadcastModal'));
      closeHealthModal();
      currentTaskId = null;
      currentAgentId = null;
      docOpen = false;
      decisionOpen = false;
      archivedOpen = false;
      archivedQuery = '';
      breakroomOpen = false;
      reportOpen = false;
      currentReportId = null;
    }, 250);
    return;
  }

  hide($('#modalBackdrop'));
  hide($('#taskModal'));
  hide($('#newTaskModal'));
  hide($('#agentModal'));
  hide($('#docModal'));
  hide($('#decisionModal'));
  hide($('#archivedModal'));
  hide($('#breakroomModal'));
  hide($('#reportModal'));
  hide($('#addAgentModal'));
  hide($('#broadcastModal'));
  closeHealthModal();
  currentTaskId = null;
  currentAgentId = null;
  docOpen = false;
  decisionOpen = false;
  archivedOpen = false;
  archivedQuery = '';
  breakroomOpen = false;
  reportOpen = false;
  currentReportId = null;
}

function priorityLabel(p) {
  const n = Number(p);
  if (n === 4) return 'CRITICAL';
  if (n === 3) return 'HIGH';
  if (n === 2) return 'MEDIUM';
  return 'LOW';
}

const PRIORITY_SLA_HOURS = { 1: 12, 2: 6, 3: 3, 4: 1 };

function priorityMeta(p) {
  const n = Number(p);
  if (n === 4) return { label: 'Critical', cls: 'bg-[#fdecec] border-[#f5caca] text-[#7a1c14]' };
  if (n === 3) return { label: 'High', cls: 'bg-[#fff7ed] border-[#fed7aa] text-[#9a3412]' };
  if (n === 2) return { label: 'Medium', cls: 'bg-[#f3efe9] border-[#e6ded3] text-ink-700' };
  return { label: 'Low', cls: 'bg-white border-line text-ink-700' };
}

function dueInfo(task) {
  const hours = PRIORITY_SLA_HOURS[Number(task.priority)] ?? 12;
  const dueAt = Number(task.created_at || task.updated_at || Date.now()) + hours * 60 * 60 * 1000;
  const remaining = dueAt - (state.serverTime || Date.now());
  return { hours, dueAt, remaining, overdue: remaining < 0 };
}

function statusPillClasses(status) {
  const s = String(status || 'inbox');
  // Screenshot-like: green filled for in progress, neutral outline otherwise
  if (s === 'in_progress') return 'bg-[#2f7d59] text-white';
  if (s === 'done') return 'bg-[#2f7d59] text-white';
  if (s === 'blocked') return 'bg-[#b42318] text-white';
  return 'bg-white border border-line text-ink-700';
}

function priorityPillClasses(priority) {
  // Reuse the same palette as cards
  return priorityMeta(priority).cls.replace('border-line', 'border');
}

async function openReportViewer(reportId) {
  try {
    const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'failed');

    const meta = data.report;
    const agent = meta.agent_id ? displayAgentName(meta.agent_id) : 'Unknown';
    const when = timeAgo(meta.created_at);
    $('#reportMeta').innerHTML = `${esc(agent)} • ${esc(when)} • <code>${esc(meta.rel_path)}</code>`;

    const md = String(data.content || '');
    const html = (window.marked ? window.marked.parse(md) : `<pre>${esc(md)}</pre>`);
    $('#reportBody').innerHTML = html;

    reportOpen = true;
    currentReportId = reportId;
    openModal('#reportModal');
  } catch (e) {
    alert('Could not load report.');
  }
}

function renderTaskModal() {
  const task = state.tasks.find(t => t.id === currentTaskId);
  if (!task) return;

  $('#taskModalTitle').textContent = task.title;
  $('#taskModalDesc').innerHTML = renderContent(task.description || '');
  $('#taskModalStatus').value = task.status || 'inbox';

  // Due info removed (unused)
  const di = dueInfo(task);

  // Ensure guardrail is only visible when pending for this task
  const guard = $('#doneGuardrail');
  if (guard) {
    const show = pendingDoneTaskId && pendingDoneTaskId === currentTaskId;
    guard.classList.toggle('hidden', !show);
  }

  // Status pill (left)
  const statusPill = $('#taskModalStatusPill');
  if (statusPill) {
    statusPill.className = `text-[10px] uppercase tracking-[0.14em] rounded-full px-2 py-1 ${statusPillClasses(task.status)}`;
    statusPill.textContent = String(STATUS_LABELS[task.status] || task.status).toUpperCase();
  }

  // Needs approval removed (unused)

  // Priority pill
  const priPill = $('#taskModalPriorityPill');
  if (priPill) {
    const pm = priorityMeta(task.priority);
    priPill.className = `text-[10px] uppercase tracking-[0.14em] rounded-full px-2 py-1 border ${pm.cls}`;
    priPill.textContent = pm.label.toUpperCase();
  }

  // Tags (not in schema yet)
  const tagsWrap = $('#taskModalTags');
  if (tagsWrap) tagsWrap.innerHTML = '';

  // Assignee card (first assignee)
  const first = (task.assigneeIds || [])[0] || '';
  const agent = state.agents.find(a => String(a.id) === String(first)) || null;
  const assigneeName = $('#taskModalAssigneeName');
  const assigneeRole = $('#taskModalAssigneeRole');
  if (assigneeName) assigneeName.textContent = agent ? agent.name : (first ? first : 'Unassigned');
  if (assigneeRole) assigneeRole.textContent = agent ? (agent.role || '—') : '—';
  const iconEl = $('#taskModalAssigneeCard')?.querySelector?.('div');
  if (iconEl) iconEl.textContent = agentEmoji(agent?.id || first || '');

  // Report
  const hasReport = task.latestReport && task.latestReport.id;
  let reportBtn = document.getElementById('taskViewReportBtn');
  if (!reportBtn) {
    // inject next to Archive button in header
    const header = document.querySelector('#taskModalPanel .px-6.py-5.border-b');
    const actionWrap = header?.querySelector('div.flex.items-center.gap-2');
    if (actionWrap) {
      const btn = document.createElement('button');
      btn.id = 'taskViewReportBtn';
      btn.className = 'text-xs font-semibold bg-chip-bg border border-chip-line rounded-full px-3 py-2 hover:bg-paper-200';
      btn.textContent = 'View Report';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rid = task.latestReport?.id;
        if (rid) openReportViewer(rid);
      });
      actionWrap.insertBefore(btn, actionWrap.firstChild);
      reportBtn = btn;
    }
  }
  if (reportBtn) {
    reportBtn.classList.toggle('hidden', !hasReport);
  }

  // Comments - sort by newest first (created_at descending)
  const comments = state.messages
    .filter(m => m.task_id === currentTaskId)
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
  const list = $('#taskModalComments');
  if (list) {
    list.innerHTML = comments.map(m => {
      const whoId = m.from_agent_id || 'system';
      const whoName = whoId === 'system' ? 'System' : displayAgentName(whoId);
      const agentAttr = whoId && whoId !== 'system' ? ` data-agent-id="${esc(whoId)}"` : '';
      return `
        <div class="taskComment bg-white border border-line rounded-xl2 shadow-card p-4"${agentAttr}>
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold">${esc(whoName)}</div>
            <div class="text-[11px] text-ink-600">${esc(timeAgo(m.created_at))}</div>
          </div>
          <div class="mt-2 text-sm text-ink-700">${renderContent(m.content)}</div>
        </div>
      `;
    }).join('') || `<div class="text-sm text-ink-600">No comments yet.</div>`;

    // Click latest agent comment to auto-mention
    const latestAgentComment = list.querySelector('.taskComment[data-agent-id]');
    const commentInput = $('#taskModalComment');
    if (latestAgentComment && commentInput) {
      latestAgentComment.classList.add('cursor-pointer');
      latestAgentComment.title = 'Click to @mention this agent';
      latestAgentComment.onclick = () => {
        const agentId = latestAgentComment.getAttribute('data-agent-id');
        if (!agentId) return;
        const mention = `@${agentId} `;
        if (!commentInput.value.includes(mention)) {
          commentInput.value = `${mention}${commentInput.value}`.trimStart();
        }
        commentInput.focus();
      };
    }
  }
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiCreateActivity({ type, agentId, taskId, message }) {
  return await apiPost('/api/activities', { type, agentId, taskId, message });
}

async function apiRoomMessages(roomId, limit = 50) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiPostRoom(roomId, { fromAgentId = 'jarvis', content }) {
  return await apiPost(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { fromAgentId, content });
}

async function apiMentions(agentId, limit = 50) {
  const res = await fetch(`/api/mentions/${encodeURIComponent(agentId)}?limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiMentionsRead(agentId, roomId = null) {
  return await apiPost(`/api/mentions/${encodeURIComponent(agentId)}/read`, { roomId });
}

async function apiPatch(url, body) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiDelete(url, body) {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

// ===== Search =====
async function apiSearch(query, limit = 20) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

let searchDebounceTimer = null;
let searchFilter = 'all'; // all | tasks | messages | activities
let searchSelectedIndex = -1;

function highlightText(text, query) {
  if (!text || !query) return esc(text);
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((part, i) => 
    part.toLowerCase() === query.toLowerCase() 
      ? `<mark class="bg-yellow-200 text-ink-800 px-0.5 rounded">${esc(part)}</mark>`
      : esc(part)
  ).join('');
}

function renderSearchResults(data, query = '') {
  const wrap = $('#searchResults');
  if (!wrap) return;

  let { tasks = [], messages = [], activities = [] } = data.results || {};
  
  // Apply filter
  if (searchFilter !== 'all') {
    if (searchFilter === 'tasks') { messages = []; activities = []; }
    else if (searchFilter === 'messages') { tasks = []; activities = []; }
    else if (searchFilter === 'activities') { tasks = []; messages = []; }
  }
  
  const total = tasks.length + messages.length + activities.length;

  if (total === 0) {
    wrap.innerHTML = `
      <div class="px-3 py-4 text-center">
        <div class="text-xs text-ink-500">No results found</div>
        <div class="text-[10px] text-ink-400 mt-1">Try a different search term or filter</div>
      </div>`;
    wrap.classList.remove('hidden');
    return;
  }

  // Filter tabs
  const filterTabs = `
    <div class="flex gap-1 px-3 py-2 border-b border-line">
      <button class="searchFilterBtn text-[10px] px-2 py-1 rounded-full ${searchFilter === 'all' ? 'bg-ink-700 text-white' : 'bg-chip-bg text-ink-600'}" data-filter="all">All</button>
      <button class="searchFilterBtn text-[10px] px-2 py-1 rounded-full ${searchFilter === 'tasks' ? 'bg-ink-700 text-white' : 'bg-chip-bg text-ink-600'}" data-filter="tasks">Tasks</button>
      <button class="searchFilterBtn text-[10px] px-2 py-1 rounded-full ${searchFilter === 'messages' ? 'bg-ink-700 text-white' : 'bg-chip-bg text-ink-600'}" data-filter="messages">Comments</button>
      <button class="searchFilterBtn text-[10px] px-2 py-1 rounded-full ${searchFilter === 'activities' ? 'bg-ink-700 text-white' : 'bg-chip-bg text-ink-600'}" data-filter="activities">Activity</button>
    </div>
  `;

  const items = [
    ...tasks.map(r => ({ ...r, kind: 'task', title: r.title || 'Untitled task' })),
    ...messages.map(r => ({ ...r, kind: 'message', title: 'Comment', snippet: r.snippet || r.content?.slice(0, 100) })),
    ...activities.map(r => ({ ...r, kind: 'activity', title: r.type || 'Activity', snippet: r.snippet || r.message?.slice(0, 100) })),
  ].sort((a, b) => (a.relevance || 0) - (b.relevance || 0)).slice(0, 20);

  const resultsHtml = items.map((item, idx) => {
    const kindLabel = item.kind === 'task' ? 'Task' : item.kind === 'message' ? 'Comment' : 'Activity';
    const kindEmoji = item.kind === 'task' ? '📋' : item.kind === 'message' ? '💬' : '🔔';
    const taskId = item.task_id || item.id;
    const isSelected = idx === searchSelectedIndex;
    const title = highlightText(item.title, query);
    const snippet = item.snippet ? highlightText(item.snippet.replace(/<mark>|<\/mark>/g, ''), query) : '';
    
    return `
      <div class="searchResult ${isSelected ? 'bg-paper-100 border-ink-400' : 'bg-white border-line'} border rounded-lg px-3 py-2 cursor-pointer hover:shadow-soft transition-all" 
           data-task-id="${esc(taskId)}" data-kind="${esc(item.kind)}" data-index="${idx}">
        <div class="flex items-center justify-between">
          <div class="text-[10px] uppercase tracking-[0.16em] text-ink-500 flex items-center gap-1">
            <span>${kindEmoji}</span>
            <span>${esc(kindLabel)}</span>
          </div>
          <div class="text-[10px] text-ink-400">${esc(timeAgo(item.created_at))}</div>
        </div>
        <div class="text-sm font-medium truncate mt-0.5">${title}</div>
        ${snippet ? `<div class="text-xs text-ink-500 truncate mt-0.5">${snippet}</div>` : ''}
      </div>
    `;
  }).join('');

  const keyboardHint = `
    <div class="px-3 py-1.5 border-t border-line bg-paper-50">
      <div class="text-[10px] text-ink-400 flex items-center justify-between">
        <span>↑↓ navigate • Enter open • Esc close</span>
        <span>${total} result${total !== 1 ? 's' : ''}</span>
      </div>
    </div>
  `;

  wrap.innerHTML = filterTabs + `<div class="max-h-[50vh] overflow-auto p-2 space-y-1">${resultsHtml}</div>` + keyboardHint;
  wrap.classList.remove('hidden');

  // Filter button handlers
  wrap.querySelectorAll('.searchFilterBtn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      searchFilter = btn.getAttribute('data-filter');
      renderSearchResults(data, query);
    });
  });

  // Click handlers
  wrap.querySelectorAll('.searchResult').forEach(el => {
    el.addEventListener('click', () => {
      const taskId = el.getAttribute('data-task-id');
      if (taskId) openTaskFromSearch(taskId);
    });
  });
}

function openTaskFromSearch(taskId) {
  currentTaskId = taskId;
  currentAgentId = null;
  renderTaskModal();
  openModal('#taskModal');
  // Clear search
  $('#globalSearch').value = '';
  $('#searchResults')?.classList.add('hidden');
  searchSelectedIndex = -1;
}

function setupSearch() {
  const input = $('#globalSearch');
  const results = $('#searchResults');
  if (!input) return;

  // Keyboard shortcut: Cmd/Ctrl+K to focus search
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
    
    // Escape to close search results
    if (e.key === 'Escape') {
      results?.classList.add('hidden');
      searchSelectedIndex = -1;
    }
  });

  input.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    if (!q || q.length < 2) {
      results?.classList.add('hidden');
      searchSelectedIndex = -1;
      return;
    }

    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(async () => {
      try {
        const data = await apiSearch(q, 20);
        searchSelectedIndex = -1;
        renderSearchResults(data, q);
      } catch (err) {
        console.error('Search failed:', err);
      }
    }, 200); // Faster debounce (was 300)
  });

  // Arrow key navigation
  input.addEventListener('keydown', (e) => {
    const resultItems = results?.querySelectorAll('.searchResult');
    if (!resultItems?.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchSelectedIndex = Math.min(searchSelectedIndex + 1, resultItems.length - 1);
      updateSearchSelection(resultItems);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchSelectedIndex = Math.max(searchSelectedIndex - 1, 0);
      updateSearchSelection(resultItems);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchSelectedIndex >= 0) {
        resultItems[searchSelectedIndex].click();
      } else if (resultItems[0]) {
        resultItems[0].click();
      }
    }
  });

  // Hide results on click outside
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !results?.contains(e.target)) {
      results?.classList.add('hidden');
      searchSelectedIndex = -1;
    }
  });
}

function updateSearchSelection(items) {
  items.forEach((el, idx) => {
    if (idx === searchSelectedIndex) {
      el.classList.add('bg-paper-100', 'border-ink-400');
      el.classList.remove('bg-white', 'border-line');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      el.classList.remove('bg-paper-100', 'border-ink-400');
      el.classList.add('bg-white', 'border-line');
    }
  });
}

// ===== Health modal =====
async function apiHealth() {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

function openHealthModal() {
  const m = $('#healthModal');
  if (!m) return;
  m.classList.remove('hidden');
  refreshHealth();
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(refreshHealth, 5000);
}

function closeHealthModal() {
  const m = $('#healthModal');
  if (!m) return;
  m.classList.add('hidden');
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

function fmtPairs(obj) {
  if (!obj) return '';
  return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(' • ');
}

async function refreshHealth() {
  try {
    const h = await apiHealth();
    const wl = h.workloopState || {};

    const workloopLines = [
      `tick: ${wl.tickCount ?? '—'}`,
      `runsThisHour: ${wl.agentRunsThisHour ?? '—'}`,
      `hourStartedAt: ${wl.hourStartedAt ? timeAgo(wl.hourStartedAt) : '—'}`,
      `lastAgentRunAt: ${wl.lastAgentRunAt ? timeAgo(wl.lastAgentRunAt) : '—'}`,
    ];

    const byStatus = (h.mentionQueue?.byStatus || []).reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {});
    const queueLines = [
      `mention_queue: ${fmtPairs(byStatus) || '—'}`,
      `unread task mentions: ${h.unread?.taskMentions ?? '—'}`,
      `unread room mentions: ${h.unread?.roomMentions ?? '—'}`,
    ];

    const oldest = (h.mentionQueue?.oldest || []).map(x => {
      const t = x.processing_started_at || x.created_at;
      const age = t ? timeAgo(t) : '—';
      return `• ${x.status} ${x.agent_id} ${x.kind} (${age}) tries=${x.tries}`;
    });

    const errLines = [];
    if (oldest.length) errLines.push(`<div class="text-[11px] text-ink-600">Oldest queue items</div><div class="mt-1 whitespace-pre-wrap">${esc(oldest.join('\n'))}</div>`);
    const gw = (h.gatewayErrors || []).slice(-10);
    if (gw.length) errLines.push(`<div class="text-[11px] text-ink-600">Gateway</div><div class="mt-1 whitespace-pre-wrap">${esc(gw.join('\n'))}</div>`);
    if (!errLines.length) errLines.push('<div class="text-xs text-ink-600">No recent errors detected.</div>');

    $('#healthWorkloop').innerHTML = workloopLines.map(l => `<div>${esc(l)}</div>`).join('');
    $('#healthQueues').innerHTML = queueLines.map(l => `<div>${esc(l)}</div>`).join('') + (oldest.length ? `<div class="mt-2 text-[11px] text-ink-600">${esc(oldest.length)} tracked oldest items</div>` : '');
    $('#healthErrors').innerHTML = errLines.join('');
    $('#healthRaw').textContent = JSON.stringify(h, null, 2);
  } catch (e) {
    $('#healthWorkloop').innerHTML = `<div class="text-xs text-[#7a1c14]">${esc(e.message || String(e))}</div>`;
  }
}

function wireUi() {
  // Modal close
  // Click anywhere outside an open drawer to close
  $('#modalBackdrop')?.addEventListener('click', closeAllModals);
  document.addEventListener('click', (e) => {
    const taskOpen = !$('#taskModal')?.classList.contains('hidden');
    const newOpen = !$('#newTaskModal')?.classList.contains('hidden');
    const agentOpen = !$('#agentModal')?.classList.contains('hidden');
    const docIsOpen = !$('#docModal')?.classList.contains('hidden');
    const decisionIsOpen = !$('#decisionModal')?.classList.contains('hidden');
    const archivedIsOpen = !$('#archivedModal')?.classList.contains('hidden');
    const breakroomIsOpen = !$('#breakroomModal')?.classList.contains('hidden');
    const reportIsOpen = !$('#reportModal')?.classList.contains('hidden');
    const addAgentIsOpen = !$('#addAgentModal')?.classList.contains('hidden');
    const broadcastIsOpen = !$('#broadcastModal')?.classList.contains('hidden');
    const healthIsOpen = !$('#healthModal')?.classList.contains('hidden');

    if (!taskOpen && !newOpen && !agentOpen && !docIsOpen && !decisionIsOpen && !archivedIsOpen && !breakroomIsOpen && !reportIsOpen && !addAgentIsOpen && !broadcastIsOpen && !healthIsOpen) return;

    let panel = null;
    if (taskOpen) panel = $('#taskModalPanel');
    else if (newOpen) panel = $('#newTaskPanel');
    else if (agentOpen) panel = $('#agentModalPanel');
    else if (docIsOpen) panel = $('#docModalPanel');
    else if (decisionIsOpen) panel = $('#decisionModalPanel');
    else if (archivedIsOpen) panel = $('#archivedModalPanel');
    else if (breakroomIsOpen) panel = $('#breakroomModalPanel');
    else if (reportIsOpen) panel = $('#reportModalPanel');
    else if (addAgentIsOpen) panel = $('#addAgentModalPanel');
    else if (broadcastIsOpen) panel = $('#broadcastModalPanel');
    else if (healthIsOpen) panel = $('#healthModalPanel');

    if (!panel) return;
    if (panel.contains(e.target)) return;
    closeAllModals();
  });
  $('#taskModalClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#newTaskClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#agentModalClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#docModalClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#decisionModalClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#archivedModalClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#breakroomModalClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#reportModalClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#addAgentClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });

  // Pause automation
  async function refreshPauseBtn() {
    const btn = $('#pauseBtn');
    if (!btn) return;
    try {
      const r = await fetch('/api/workloop/quiet');
      const d = await r.json();
      const on = !!d.quiet;
      btn.textContent = on ? '⏸ Paused' : '⏸ Pause';
      btn.className = `hidden sm:block text-xs font-semibold rounded-full px-3 py-1.5 hover:bg-paper-200 ${on ? 'bg-white border border-line' : 'bg-chip-bg border border-chip-line'}`;
    } catch {}
  }

  $('#pauseBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const r = await fetch('/api/workloop/quiet');
      const d = await r.json();
      const next = !d.quiet;
      await fetch('/api/workloop/quiet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quiet: next })
      });
      await refreshPauseBtn();
    } catch {
      alert('Could not toggle pause.');
    }
  });

  // Broadcast
  $('#broadcastBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('#broadcastHint') && ($('#broadcastHint').textContent = '');
    openModal('#broadcastModal');
    setTimeout(() => $('#broadcastText')?.focus?.(), 0);
  });
  $('#broadcastClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });
  $('#broadcastForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = ($('#broadcastText')?.value || '').trim();
    if (!text) return;
    const hint = $('#broadcastHint');
    if (hint) hint.textContent = 'Sending…';
    try {
      await apiPostRoom('breakroom', { fromAgentId: 'jarvis', content: `📣 Broadcast\n\n${text}` });
      if (hint) hint.textContent = 'Sent.';
      try { $('#broadcastText').value = ''; } catch {}
      closeAllModals();
    } catch {
      if (hint) hint.textContent = 'Could not send.';
    }
  });

  // Docs button opens Doc modal
  // Docs removed (unused)

  // initialize pause button state
  refreshPauseBtn();

  // Live feed filters
  document.querySelectorAll('.feedKindBtn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      feedKind = btn.getAttribute('data-kind') || 'all';
      // "All" also resets agent filter
      if (feedKind === 'all') feedAgentId = null;

      // highlight
      document.querySelectorAll('.feedKindBtn').forEach(b => {
        const active = (b.getAttribute('data-kind') || 'all') === feedKind;
        b.className = `feedKindBtn text-[10px] tracking-[0.16em] uppercase rounded-full px-3 py-1.5 ${active ? 'bg-white border border-line' : 'bg-chip-bg border border-chip-line'}`;
      });

      renderHeader();
      renderFeed();
    });
  });

  // Agent filter dropdown
  $('#feedAgentSelect')?.addEventListener('change', (e) => {
    feedAgentId = e.target.value || null;
    renderHeader();
    renderFeed();
  });

  // New Decision / Doc Note
  // removed: newDecisionBtn/newDocBtn (unused)

  const DOC_TEMPLATES = {
    blank: { title: '', body: '' },
    runbook: {
      title: 'Runbook — <thing>',
      body: [
        'Goal:',
        '- ',
        '',
        'Steps:',
        '1) ',
        '2) ',
        '3) ',
        '',
        'Checks:',
        '- ',
        '',
        'Rollback:',
        '- ',
      ].join('\n')
    },
    howitworks: {
      title: 'How it works — <system>',
      body: [
        'Summary:',
        '- ',
        '',
        'Key components:',
        '- ',
        '',
        'Data flow:',
        '- ',
        '',
        'Gotchas:',
        '- ',
      ].join('\n')
    },
    policy: {
      title: 'Policy — <topic>',
      body: [
        'Rule:',
        '- ',
        '',
        'Why:',
        '- ',
        '',
        'Examples:',
        '- ',
      ].join('\n')
    }
  };

  const DECISION_TEMPLATES = {
    blank: { title: '', body: '' },
    standard: {
      title: 'Decision — <topic>',
      body: [
        'Decision:',
        '- ',
        '',
        'Why:',
        '- ',
        '',
        'Tradeoffs:',
        '- ',
        '',
        'Revisit when:',
        '- ',
      ].join('\n')
    },
    reversible: {
      title: 'Reversible decision — <topic>',
      body: [
        'Decision (reversible):',
        '- ',
        '',
        'Why now:',
        '- ',
        '',
        'How to rollback:',
        '- ',
      ].join('\n')
    },
    architecture: {
      title: 'ADR — <topic>',
      body: [
        'Context:',
        '- ',
        '',
        'Decision:',
        '- ',
        '',
        'Consequences:',
        '- ',
      ].join('\n')
    }
  };

  const applyTemplate = (kind) => {
    if (kind === 'doc') {
      const key = $('#docTemplate')?.value || 'blank';
      const t = DOC_TEMPLATES[key] || DOC_TEMPLATES.blank;
      if ($('#docTitle').value.trim() === '' && t.title) $('#docTitle').value = t.title;
      if ($('#docBody').value.trim() === '' && t.body) $('#docBody').value = t.body;
    }
    if (kind === 'decision') {
      const key = $('#decisionTemplate')?.value || 'blank';
      const t = DECISION_TEMPLATES[key] || DECISION_TEMPLATES.blank;
      if ($('#decisionTitle').value.trim() === '' && t.title) $('#decisionTitle').value = t.title;
      if ($('#decisionBody').value.trim() === '' && t.body) $('#decisionBody').value = t.body;
    }
  };

  $('#docTemplate')?.addEventListener('change', (e) => { e.stopPropagation(); applyTemplate('doc'); });
  $('#decisionTemplate')?.addEventListener('change', (e) => { e.stopPropagation(); applyTemplate('decision'); });

  $('#docForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const title = $('#docTitle').value.trim();
    const body = $('#docBody').value.trim();
    const by = ($('#docBy').value || 'jarvis').toLowerCase();
    if (!body) return;

    const msg = title ? `${title} — ${body}` : body;
    await apiCreateActivity({ type: 'doc_note', agentId: by, message: msg });

    $('#docTitle').value = '';
    $('#docBody').value = '';
    closeAllModals();
  });

  $('#decisionForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const title = $('#decisionTitle').value.trim();
    const body = $('#decisionBody').value.trim();
    const by = ($('#decisionBy').value || 'jarvis').toLowerCase();
    if (!body) return;

    const msg = title ? `${title} — ${body}` : body;
    await apiCreateActivity({ type: 'decision_added', agentId: by, message: msg });

    $('#decisionTitle').value = '';
    $('#decisionBody').value = '';
    closeAllModals();
  });

  // Banner
  $('#bannerDismiss')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideBanner();
  });

  // Board filters
  const setBoardFilter = (val) => {
    boardFilter = val;
    const all = $('#boardAllBtn');
    const ds = $('#boardDueSoonBtn');
    const od = $('#boardOverdueBtn');
    if (all) all.className = `text-[10px] tracking-[0.16em] uppercase rounded-full px-3 py-1.5 hover:bg-paper-200 ${boardFilter==='all'?'bg-white border border-line':'bg-chip-bg border border-chip-line'}`;
    if (ds) ds.className = `text-[10px] tracking-[0.16em] uppercase rounded-full px-3 py-1.5 hover:bg-paper-200 ${boardFilter==='dueSoon'?'bg-white border border-line':'bg-chip-bg border border-chip-line'}`;
    if (od) od.className = `text-[10px] tracking-[0.16em] uppercase rounded-full px-3 py-1.5 hover:bg-paper-200 ${boardFilter==='overdue'?'bg-white border border-line':'bg-chip-bg border border-chip-line'}`;

    const lbl = $('#boardFilterLabel');
    if (lbl) {
      lbl.textContent = boardFilter === 'all' ? '' : (boardFilter === 'dueSoon' ? 'DUE SOON' : 'OVERDUE');
    }

    renderAll();
  };
  $('#boardAllBtn')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setBoardFilter('all'); });
  $('#boardDueSoonBtn')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setBoardFilter('dueSoon'); });
  $('#boardOverdueBtn')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setBoardFilter('overdue'); });

  const refreshQuietBtn = () => {
    const b = $('#quietModeBtn');
    if (!b) return;
    b.className = `text-[10px] tracking-[0.16em] uppercase rounded-full px-3 py-1.5 hover:bg-paper-200 ${quietMode ? 'bg-white border border-line' : 'bg-chip-bg border border-chip-line'}`;
    b.textContent = quietMode ? 'Quiet: ON' : 'Quiet';
  };
  refreshQuietBtn();
  $('#quietModeBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    quietMode = !quietMode;
    localStorage.setItem('mc.quietMode', quietMode ? '1' : '0');
    refreshQuietBtn();
  });

  // Break room
  $('#breakroomBtn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    currentTaskId = null;
    currentAgentId = null;
    breakroomOpen = true;
    openModal('#breakroomModal');

    try {
      const out = await apiRoomMessages('breakroom', 50);
      breakroomMessages = out.messages || [];
      renderBreakroom();
    } catch {
      breakroomMessages = [];
      renderBreakroom();
    }

    setTimeout(() => $('#breakroomText')?.focus?.(), 0);
  });

  // Header Chat button (same as breakroom button)
  $('#headerChatBtn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    currentTaskId = null;
    currentAgentId = null;
    breakroomOpen = true;
    openModal('#breakroomModal');

    try {
      const out = await apiRoomMessages('breakroom', 50);
      breakroomMessages = out.messages || [];
      renderBreakroom();
    } catch {
      breakroomMessages = [];
      renderBreakroom();
    }

    setTimeout(() => $('#breakroomText')?.focus?.(), 0);
  });

  // Health modal
  $('#healthBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openHealthModal();
  });
  $('#healthRefreshBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    refreshHealth();
  });
  $$('[data-close="health"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeHealthModal();
    });
  });

  $('#breakroomForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const box = $('#breakroomText');
    const content = box?.value?.trim?.();
    if (!content) return;

    try {
      await apiPostRoom('breakroom', { fromAgentId: 'jarvis', content });
      const out = await apiRoomMessages('breakroom', 50);
      breakroomMessages = out.messages || [];
      renderBreakroom();
      if (box) box.value = '';
    } catch (err) {
      alert('Could not send (rate limit?).');
    }
  });

  // Archived drawer
  const openArchived = (e) => {
    e?.stopPropagation?.();
    currentTaskId = null;
    currentAgentId = null;
    archivedOpen = true;
    archivedQuery = '';
    const s = $('#archivedSearch');
    if (s) s.value = '';
    openModal('#archivedModal');
    renderArchived();
    setTimeout(() => $('#archivedSearch')?.focus?.(), 0);
  };
  $('#archivedBtn')?.addEventListener('click', openArchived);
  $('#archivedPillBtn')?.addEventListener('click', openArchived);

  $('#archivedClear')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    archivedQuery = '';
    const s = $('#archivedSearch');
    if (s) s.value = '';
    renderArchived();
  });

  $('#archivedSearch')?.addEventListener('input', (e) => {
    archivedQuery = e.target.value;
    renderArchived();
  });

  document.body.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('.archivedRestore');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const taskId = btn.getAttribute('data-task-id');
    await apiPatch(`/api/tasks/${taskId}`, { status: 'inbox', byAgentId: 'zeus' });
    // Log restore
    const t = state.tasks.find(x => x.id === taskId);
    await apiCreateActivity({ type: 'doc_note', agentId: 'jarvis', taskId, message: `Restored archived task: ${t?.title || taskId}` });
    renderArchived();
  });

  document.body.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('.archivedDup');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const taskId = btn.getAttribute('data-task-id');
    const t = state.tasks.find(x => x.id === taskId);
    if (!t) return;
    const desc = `${t.description || ''}\n\n(Duplicated from archived task ${t.id}: ${t.title})`.trim();
    const created = await apiPost('/api/tasks', { title: t.title, description: desc, status: 'inbox', priority: t.priority, assigneeIds: t.assigneeIds || [], byAgentId: 'zeus' });
    await apiCreateActivity({ type: 'doc_note', agentId: 'jarvis', taskId: created?.task?.id || null, message: `Duplicated from archived task ${t.id}: ${t.title}` });
    renderArchived();
  });

  document.body.addEventListener('click', (e) => {
    const row = e.target?.closest?.('.archivedItem');
    if (!row) return;
    // ignore if click was on buttons
    if (e.target?.closest?.('.archivedRestore') || e.target?.closest?.('.archivedDup')) return;
    e.preventDefault();
    e.stopPropagation();
    const taskId = row.getAttribute('data-task-id');
    currentAgentId = null;
    currentTaskId = taskId;
    try {
      markTaskAsRead(currentTaskId);
    } catch (err) {
      console.error('Error marking task as read:', err);
    }
    renderTaskModal();
    openModal('#taskModal');
  });

  // New task
  const openNewTask = (e) => {
    e?.stopPropagation?.();
    currentTaskId = null;
    currentAgentId = null;
    openModal('#newTaskModal');
  };
  $('#newTaskBtn')?.addEventListener('click', openNewTask);
  $('#sideAddTaskBtn')?.addEventListener('click', openNewTask);
  let newTaskLinkToId = null;

  function similarTasks(q) {
    const query = String(q || '').toLowerCase().trim();
    if (query.length < 4) return [];
    const qTokens = query.split(/\s+/).filter(w => w.length >= 3);

    const candidates = (state.tasks || []).filter(t => String(t.status) !== 'done');
    const scored = candidates.map(t => {
      const text = `${t.title || ''} ${t.description || ''}`.toLowerCase();
      const tokens = new Set(text.split(/\s+/).filter(w => w.length >= 3));
      const matched = qTokens.filter(tok => tokens.has(tok));
      return { t, score: matched.length, matched: matched.slice(0, 5) };
    }).filter(x => x.score > 0)
      .sort((a,b) => b.score - a.score)
      .slice(0, 3);

    return scored;
  }

  const updateSimilar = () => {
    const q = $('#newTaskTitle')?.value || '';
    const wrap = $('#newTaskSimilar');
    if (!wrap) return;
    const sims = similarTasks(q);
    if (sims.length === 0) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }

    const linkTask = newTaskLinkToId ? state.tasks.find(t => t.id === newTaskLinkToId) : null;

    wrap.classList.remove('hidden');
    wrap.innerHTML = `
      <div class="bg-white border border-line rounded-xl2 p-3">
        <div class="text-[11px] tracking-[0.22em] uppercase text-ink-500">Similar tasks (active + archived)</div>
        <div class="mt-2 space-y-3">
          ${sims.map(({t, matched}) => {
            const isArchived = String(t.status) === 'archived';
            const meta = isArchived ? `Archived ${esc(timeAgo(t.updated_at || t.created_at))}` : `${esc(STATUS_LABELS[t.status] || t.status)} • updated ${esc(timeAgo(t.updated_at))}`;
            const why = matched.length
              ? matched.map(w => `<span class=\"text-[10px] uppercase tracking-[0.14em] bg-chip-bg border border-chip-line rounded-full px-2 py-0.5\">${esc(w)}</span>`).join(' ')
              : '';
            return `
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm font-semibold truncate">${esc(t.title)}</div>
                  <div class="mt-1 text-xs text-ink-600 truncate">${meta}</div>
                  ${why ? `<div class=\"mt-2 flex flex-wrap gap-1\">${why}</div>` : ''}
                </div>
                <div class="flex items-center gap-2">
                  <button class="simOpen text-xs font-semibold bg-chip-bg border border-chip-line rounded-full px-3 py-1.5 hover:bg-paper-200" data-task-id="${esc(t.id)}">Open</button>
                  ${isArchived ? `<button class=\"simRestore text-xs font-semibold bg-white border border-line rounded-full px-3 py-1.5 hover:bg-paper-200\" data-task-id=\"${esc(t.id)}\">Restore</button>` : ''}
                  <button class="simLink text-xs font-semibold bg-white border border-line rounded-full px-3 py-1.5 hover:bg-paper-200" data-task-id="${esc(t.id)}">Link</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
        ${linkTask ? `<div class="mt-3 text-xs text-ink-700">Will link new task to: <b>${esc(linkTask.title)}</b> <button class="simClearLink text-xs font-semibold bg-chip-bg border border-chip-line rounded-full px-3 py-1.5 hover:bg-paper-200">Clear</button></div>` : ''}
      </div>
    `;
  };

  $('#newTaskTitle')?.addEventListener('input', updateSimilar);

  document.body.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('.simOpen');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.getAttribute('data-task-id');
    currentTaskId = id;
    currentAgentId = null;
    renderTaskModal();
    openModal('#taskModal');
  });

  document.body.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('.simRestore');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.getAttribute('data-task-id');
    await apiPatch(`/api/tasks/${id}`, { status: 'inbox', byAgentId: 'zeus' });
    updateSimilar();
  });

  document.body.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.simLink');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    newTaskLinkToId = btn.getAttribute('data-task-id');
    updateSimilar();
  });

  document.body.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.simClearLink');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    newTaskLinkToId = null;
    updateSimilar();
  });

  $('#newTaskForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#newTaskTitle').value.trim();
    const description = $('#newTaskDesc').value.trim();
    const status = $('#newTaskStatus').value;
    const priority = Number($('#newTaskPriority').value);
    const assignee = $('#newTaskAssignee').value;
    const assigneeIds = assignee ? [assignee] : [];

    const created = await apiPost('/api/tasks', { title, description, status, priority, assigneeIds, byAgentId: 'zeus' });

    if (newTaskLinkToId && created?.task?.id) {
      const other = state.tasks.find(t => t.id === newTaskLinkToId);
      await apiCreateActivity({
        type: 'task_linked',
        agentId: 'jarvis',
        taskId: created.task.id,
        message: `Linked task ${created.task.id} (${title}) to ${newTaskLinkToId}${other ? ` (${other.title})` : ''}`
      });
    }

    $('#newTaskTitle').value = '';
    $('#newTaskDesc').value = '';
    newTaskLinkToId = null;
    const wrap = $('#newTaskSimilar');
    if (wrap) { wrap.classList.add('hidden'); wrap.innerHTML = ''; }
    closeAllModals();
  });

  // Quick report icon on cards
  document.body.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.reportQuickBtn');
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const rid = btn.getAttribute('data-report-id');
    if (rid) openReportViewer(rid);
  });

  // Click task card -> open detail drawer
  document.body.addEventListener('click', (e) => {
    // Let feedItem handler own clicks inside the live feed
    if (e.target?.closest?.('.feedItem')) return;

    const card = e.target?.closest?.('[data-task-id]');
    if (!card) return;
    // Ignore clicks on quick action buttons
    if (e.target?.closest?.('.reportQuickBtn')) return;

    e.stopPropagation();
    currentAgentId = null;
    currentTaskId = card.getAttribute('data-task-id');
    try {
      markTaskAsRead(currentTaskId);
    } catch (err) {
      console.error('Error marking task as read:', err);
    }
    renderTaskModal();
    openModal('#taskModal');
  });

  // Add agent (full provisioner)
  $('#addAgentBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('#addAgentHint') && ($('#addAgentHint').textContent = '');
    openModal('#addAgentModal');
    setTimeout(() => $('#addAgentId')?.focus?.(), 0);
  });

  $('#addAgentClose')?.addEventListener('click', (e) => { e.stopPropagation(); closeAllModals(); });

  $('#addAgentForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const id = ($('#addAgentId')?.value || '').trim().toLowerCase();
    const name = ($('#addAgentName')?.value || '').trim();
    const role = ($('#addAgentRole')?.value || '').trim();
    const reportsTo = ($('#addAgentReportsTo')?.value || 'zeus').trim().toLowerCase();
    const worksWith = ($('#addAgentWorksWith')?.value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    const hint = $('#addAgentHint');
    if (hint) hint.textContent = 'Creating agent…';

    try {
      const res = await fetch('/api/agents/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name, role, reportsTo, worksWith })
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed');

      if (hint) hint.textContent = `Created. Agent is provisioned on disk; OpenClaw will load it after the next gateway restart/reload.`;
      await loadState();

      // Show a top banner reminder
      showBanner('New agent created. It will not be runnable until the OpenClaw gateway reloads/restarts (maintenance window 02:00–05:00).');
      setTimeout(() => closeAllModals(), 700);
    } catch (err) {
      if (hint) hint.textContent = 'Could not create agent. Check id/name/role and try again.';
    }
  });

  // Click agent -> open agent profile drawer
  document.body.addEventListener('click', (e) => {
    if (e.target?.closest?.('.feedItem')) return;

    const card = e.target?.closest?.('[data-agent-id]');
    if (!card) return;
    e.stopPropagation();
    currentTaskId = null;
    currentAgentId = card.getAttribute('data-agent-id');
    renderAgentModal();
    openModal('#agentModal');
  });

  // Click feed item:
  // - if task_id exists, open task drawer
  // - else if agent_id exists, open agent drawer
  document.body.addEventListener('click', (e) => {
    const item = e.target?.closest?.('.feedItem');
    if (!item) return;
    // IMPORTANT: multiple click handlers are attached to document.body; use stopImmediatePropagation
    // so the generic agent/task handlers don't also fire.
    e.stopImmediatePropagation();

    const taskId = item.getAttribute('data-task-id');
    const agentId = item.getAttribute('data-agent-id');

    if (taskId) {
      currentAgentId = null;
      currentTaskId = taskId;
      renderTaskModal();
      openModal('#taskModal');
      return;
    }

    if (agentId) {
      currentTaskId = null;
      currentAgentId = agentId;
      renderAgentModal();
      openModal('#agentModal');
    }
  });

  // Change status in modal
  $('#taskModalStatus')?.addEventListener('change', async (e) => {
    if (!currentTaskId) return;

    const next = e.target.value;
    if (next === 'done') {
      // Guardrail: require completion summary (and block if approval required)
      const task = state.tasks.find(t => t.id === currentTaskId);
      if (Number(task?.needs_approval) === 1) {
        alert('This task needs approval before it can be marked Done.');
        e.target.value = task?.status || 'inbox';
        return;
      }

      e.target.value = task?.status || 'inbox';

      pendingDoneTaskId = currentTaskId;
      const guard = $('#doneGuardrail');
      guard?.classList.remove('hidden');

      // Pre-fill template if empty
      const box = $('#doneSummary');
      if (box && box.value.trim() === '') {
        box.value = [
          '✅ Completed',
          '- What I did:',
          '- Output/links:',
          '- Notes/follow-ups:',
          '- Confidence:',
        ].join('\n');
      }

      // Make sure it's visible
      setTimeout(() => {
        guard?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        box?.focus?.();
      }, 0);

      return;
    }

    $('#doneGuardrail')?.classList.add('hidden');
    pendingDoneTaskId = null;

    await apiPatch(`/api/tasks/${currentTaskId}`, { status: next, byAgentId: 'zeus' });
  });

  $('#doneCancel')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pendingDoneTaskId = null;
    $('#doneGuardrail')?.classList.add('hidden');
  });

  $('#doneConfirm')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pendingDoneTaskId) return;

    const summary = $('#doneSummary')?.value?.trim?.() || '';
    if (!summary) {
      alert('Please add a completion summary.');
      return;
    }

    // Post summary comment as Jarvis
    await apiPost('/api/messages', { taskId: pendingDoneTaskId, fromAgentId: 'jarvis', content: summary });

    // Also write a Doc Note entry into the feed for auditability
    const task = state.tasks.find(t => t.id === pendingDoneTaskId);
    const taskTitle = task?.title ? `“${task.title}”` : pendingDoneTaskId;
    await apiCreateActivity({ type: 'doc_note', agentId: 'jarvis', taskId: pendingDoneTaskId, message: `Completion summary for ${taskTitle}:\n${summary}` });

    // Mark done
    await apiPatch(`/api/tasks/${pendingDoneTaskId}`, { status: 'done', byAgentId: 'zeus' });

    $('#doneSummary').value = '';
    $('#doneGuardrail')?.classList.add('hidden');
    pendingDoneTaskId = null;
  });

  // Delete task
  $('#taskDeleteBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentTaskId) return;
    const task = state.tasks.find(t => t.id === currentTaskId);
    const title = task?.title || currentTaskId;
    if (!confirm(`Archive task: "${title}"?`)) return;
    await apiDelete(`/api/tasks/${currentTaskId}`, { byAgentId: 'zeus' });
    closeAllModals();
  });

  // Task approval controls removed (unused)

  // Checklist removed (unused)

  // Comment form
  $('#taskModalCommentForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentTaskId) return;

    // Comments from you always come through Jarvis
    const fromAgentId = 'jarvis';
    const content = $('#taskModalComment').value.trim();
    if (!content) return;

    await apiPost('/api/messages', { taskId: currentTaskId, fromAgentId, content });

    // If you @mention an agent, also ping them (creates a Status feed item)
    const mentions = Array.from(content.matchAll(/@([a-zA-Z0-9_-]+)/g)).map(m => m[1].toLowerCase());
    const unique = Array.from(new Set(mentions));
    for (const m of unique) {
      const agent = state.agents.find(a => String(a.id).toLowerCase() === m || String(a.name).toLowerCase() === m);
      if (agent) {
        const task = state.tasks.find(t => t.id === currentTaskId);
        const taskLabel = task?.title ? `“${task.title}”` : currentTaskId;
        await apiPost(`/api/agents/${agent.id}/ping`, { fromAgentId: 'jarvis', content: `Mentioned on task ${taskLabel}: ${content}` });
      }
    }

    $('#taskModalComment').value = '';
  });

  // Quick assign buttons
  const assign = (agentId) => async (e) => {
    e?.stopPropagation?.();
    if (!currentTaskId) return;
    const task = state.tasks.find(t => t.id === currentTaskId);
    const next = new Set(task?.assigneeIds || []);
    next.add(agentId);
    await apiPatch(`/api/tasks/${currentTaskId}`, { assigneeIds: Array.from(next), byAgentId: 'zeus' });
  };
  $('#assignApollo')?.addEventListener('click', assign('apollo'));
  $('#assignArtemis')?.addEventListener('click', assign('artemis'));
  $('#assignAres')?.addEventListener('click', assign('ares'));
  $('#assignPrometheus')?.addEventListener('click', assign('prometheus'));

  // Agent "next recommended" (simple triage)
  $('#agentNextBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentAgentId) return;

    // Token control: cap in-progress tasks per agent
    const inProg = (state.tasks || []).filter(t => (t.assigneeIds || []).includes(currentAgentId) && String(t.status) === 'in_progress');
    if (inProg.length >= 1) {
      alert('This agent already has an in-progress task.');
      return;
    }

    const candidates = (state.tasks || [])
      .filter(t => String(t.status) !== 'done' && String(t.status) !== 'archived')
      .filter(t => Number(t.needs_approval) !== 1)
      .filter(t => (t.assigneeIds || []).includes(currentAgentId) || (t.assigneeIds || []).length === 0)
      .map(t => ({ t, di: dueInfo(t) }))
      .sort((a,b) => {
        if (a.di.overdue !== b.di.overdue) return a.di.overdue ? -1 : 1;
        const pa = Number(a.t.priority), pb = Number(b.t.priority);
        if (pa !== pb) return pb - pa;
        return a.di.remaining - b.di.remaining;
      });

    const pick = candidates[0]?.t;
    if (!pick) {
      alert('No suitable tasks found.');
      return;
    }

    // Quiet mode: only allow Critical or overdue High/Critical
    if (quietMode) {
      const di = dueInfo(pick);
      const pr = Number(pick.priority);
      const allowed = (pr === 4) || (di.overdue && pr >= 3);
      if (!allowed) {
        alert('Quiet mode is ON: only Critical or overdue High/Critical tasks will auto-start.');
        return;
      }
    }

    // assign if unassigned
    if ((pick.assigneeIds || []).length === 0) {
      await apiPatch(`/api/tasks/${pick.id}`, { assigneeIds: [currentAgentId], byAgentId: 'zeus' });
    }

    // move to in_progress
    await apiPatch(`/api/tasks/${pick.id}`, { status: 'in_progress', byAgentId: 'zeus' });

    // leave a small activity breadcrumb
    await apiCreateActivity({ type: 'agent_updated', agentId: currentAgentId, taskId: pick.id, message: `Auto-picked next task: ${pick.title}` });

    // open the task
    currentTaskId = pick.id;
    currentAgentId = null;
    renderTaskModal();
    openModal('#taskModal');
  });

  // Agent profile tabs
  document.querySelectorAll('.agentTab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tab = btn.getAttribute('data-tab');
      const att = $('#agentPanelAttention');
      const tl = $('#agentPanelTimeline');
      const msg = $('#agentPanelMessages');
      att?.classList.toggle('hidden', tab !== 'attention');
      tl?.classList.toggle('hidden', tab !== 'timeline');
      msg?.classList.toggle('hidden', tab !== 'messages');

      document.querySelectorAll('.agentTab').forEach(b => {
        const active = b.getAttribute('data-tab') === tab;
        b.className = active
          ? 'agentTab px-3 py-2 rounded-t-lg bg-white border border-line border-b-0 text-xs'
          : 'agentTab px-3 py-2 rounded-t-lg text-ink-600 text-xs';
      });
    });
  });

  // Message agent (stored as an activity for now)
  $('#agentMessageForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentAgentId) return;
    const content = $('#agentMessageText').value.trim();
    if (!content) return;
    await apiPost(`/api/agents/${currentAgentId}/ping`, { fromAgentId: 'jarvis', content });
    $('#agentMessageText').value = '';
  });

  // Initialize search
  setupSearch();
}


function startClock() {
  const el = $('#hdrClock');
  if (!el) return;
  const tick = () => {
    const now = new Date();
    const s = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = s;
  };
  tick();
  setInterval(tick, 1000);
}

// Dark mode toggle
function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved === 'dark' || (!saved && prefersDark);
  
  if (isDark) {
    document.documentElement.classList.add('dark');
    $('#themeIcon').textContent = '☀️';
  } else {
    document.documentElement.classList.remove('dark');
    $('#themeIcon').textContent = '🌙';
  }
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  $('#themeIcon').textContent = isDark ? '☀️' : '🌙';
}

window.addEventListener('DOMContentLoaded', async () => {
  // Track local interaction to count Jarvis as working when you’re actively using the dashboard.
  const touch = () => { window.__mcLastInteractionAt = Date.now(); };
  touch();
  document.addEventListener('click', touch, { capture: true });
  document.addEventListener('keydown', touch, { capture: true });

  initTheme();
  startClock();
  await loadState();
  connectWs();
  wireUi();

  // Wire memory dashboard link + stats (runs on :3000 on the same host)
  const mem = document.getElementById('memoryBtn');
  if (mem) mem.href = `http://${window.location.hostname}:3000`;

  // Quick-add draft memory from Mission Control
  const addMemBtn = document.getElementById('addMemoryBtn');
  if (addMemBtn) {
    addMemBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const statement = prompt('Add a draft memory (one sentence):');
      if (!statement || !statement.trim()) return;
      const category = prompt('Category (optional, e.g. preference/ops):') || '';
      try {
        const host = window.location.hostname;
        const res = await fetch(`http://${host}:3000/api/memories`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bank: 'draft',
            status: 'pending',
            statement: statement.trim(),
            category: category.trim() || null,
            confidence: 0.7,
            source_type: 'manual',
            source_agent_id: 'jarvis',
            actor: 'user'
          })
        });
        if (!res.ok) throw new Error(await res.text());
        await loadMemoryStats();
        alert('Added to Draft.');
      } catch (err) {
        alert('Could not add memory (is :3000 up?).');
      }
    });
  }

  await loadMemoryStats();
  memoryStatsTimer = setInterval(loadMemoryStats, 10000);
  
  // Wire theme toggle
  $('#themeToggle')?.addEventListener('click', toggleTheme);
});
