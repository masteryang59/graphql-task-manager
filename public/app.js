import { createClient, createSubscriptions } from './gql.js';

const STATUSES = [
  ['TODO', 'To do'],
  ['IN_PROGRESS', 'In progress'],
  ['IN_REVIEW', 'In review'],
  ['DONE', 'Done'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const PAGE = 50;

const $ = (sel) => document.querySelector(sel);
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode: the session just won't survive a reload */
    }
  },
};

const state = {
  token: storage.get('tm.token'),
  me: null,
  projects: [],
  projectId: null, // selected project; `project` is the last one loaded
  project: null,
  columns: {},
  filters: { search: '', assigneeId: '', overdue: false },
  openTask: null,
};

const client = createClient({ getToken: () => state.token, onResult: logRequest });
const subs = createSubscriptions({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/graphql`,
  getToken: () => state.token,
  onStatus: setLive,
});
let unsubscribe = null;

// ---------- GraphQL documents ----------

const TASK_FIELDS = 'id key number title status priority labels dueDate isOverdue rev commentCount assignee { id name }';

const BOARD = `query Board($id: ID!, $first: Int!, $todo: TaskFilter, $doing: TaskFilter, $review: TaskFilter, $done: TaskFilter) {
  project(id: $id) {
    id key name viewerRole
    members { role user { id name } }
    stats { total overdue unassignedOpen completedLast7Days computedAt }
    TODO: tasks(filter: $todo, first: $first) { ...Column }
    IN_PROGRESS: tasks(filter: $doing, first: $first) { ...Column }
    IN_REVIEW: tasks(filter: $review, first: $first) { ...Column }
    DONE: tasks(filter: $done, first: $first) { ...Column }
  }
}
fragment Column on TaskConnection { totalCount pageInfo { hasNextPage endCursor } nodes { ${TASK_FIELDS} } }`;

const TASK_DETAIL = `query TaskDetail($id: ID!) {
  task(id: $id) {
    ${TASK_FIELDS} description createdAt updatedAt createdBy { name }
    comments(first: 50) { nodes { id body createdAt author { id name } } }
  }
}`;

const EVENTS = `subscription TaskEvents($projectId: ID!) {
  taskEvents(projectId: $projectId) { type taskId actor { id name } task { id key title status } }
}`;

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function initials(name) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

const AVATAR_COLORS = ['#7c3aed', '#0e7490', '#c2410c', '#15803d', '#be185d', '#4338ca'];
function avatarColor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function formatDue(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function setLive(status) {
  const el = $('#live');
  el.textContent = { live: 'live', connecting: 'connecting', reconnecting: 'reconnecting', forbidden: 'not authorised', off: 'offline' }[status] ?? status;
  el.className = `live ${status === 'live' ? 'on' : status === 'off' ? '' : 'wait'}`;
}

function logRequest({ operationName, ms, extensions, errors }) {
  const list = $('#requests');
  const li = document.createElement('li');
  const cache = extensions.cache;
  const cost = extensions.cost;
  const code = errors?.[0]?.extensions?.code;
  li.innerHTML = `
    <div class="op"><span>${escapeHtml(operationName ?? 'anonymous')}</span><span>${Math.round(ms)} ms</span></div>
    <div class="nums">
      ${cost?.requested != null ? `<span>cost ${cost.requested}</span>` : ''}
      ${cache ? `<span class="pill hit">${cache.hits} hit</span><span class="pill miss">${cache.misses} miss</span>` : ''}
      ${cache?.bypassed ? `<span>${cache.bypassed} bypassed</span>` : ''}
      ${extensions.durationMs != null ? `<span>server ${extensions.durationMs} ms</span>` : ''}
      ${code ? `<span class="pill err">${escapeHtml(code)}</span>` : ''}
    </div>`;
  list.prepend(li);
  while (list.children.length > 12) list.lastChild.remove();
}

function logEvent(html) {
  const list = $('#events');
  const li = document.createElement('li');
  li.innerHTML = `${html} <span class="small">${new Date().toLocaleTimeString()}</span>`;
  list.prepend(li);
  while (list.children.length > 10) list.lastChild.remove();
}

const canEdit = () => state.project && state.project.viewerRole !== 'VIEWER';

async function run(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.code === 'UNAUTHENTICATED') return signOut();
    toast(error.message);
    throw error;
  }
}

// ---------- session ----------

async function signIn(email, password) {
  const data = await client.request(
    'mutation LogIn($email: String!, $password: String!) { logIn(email: $email, password: $password) { token user { id name email } } }',
    { email, password },
    'LogIn',
  );
  state.token = data.logIn.token;
  storage.set('tm.token', state.token);
  await start();
}

function signOut() {
  state.token = null;
  state.me = null;
  storage.set('tm.token', null);
  unsubscribe?.();
  subs.close();
  $('#app').hidden = true;
  $('#login').hidden = false;
}

async function start() {
  let data;
  try {
    data = await client.request('query Start { me { id name email } projects { id key name viewerRole } }', {}, 'Start');
  } catch {
    return signOut();
  }
  if (!data.me) return signOut();
  state.me = data.me;
  state.projects = data.projects;
  $('#me').textContent = state.me.name;
  $('#login').hidden = true;
  $('#app').hidden = false;
  const select = $('#project-select');
  select.innerHTML = state.projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${p.key})</option>`).join('');
  const remembered = storage.get('tm.project');
  const initial = state.projects.find((p) => p.id === remembered) ?? state.projects[0];
  subs.close();
  subs.connect();
  if (initial) {
    select.value = initial.id;
    await openProject(initial.id);
  }
}

// ---------- board ----------

function columnFilter(status) {
  const f = { status: [status] };
  if (state.filters.search) f.search = state.filters.search;
  if (state.filters.assigneeId === 'none') f.unassigned = true;
  else if (state.filters.assigneeId) f.assigneeId = state.filters.assigneeId;
  if (state.filters.overdue) f.overdue = true;
  return f;
}

async function openProject(id) {
  state.projectId = id;
  storage.set('tm.project', id);
  state.filters.assigneeId = '';
  unsubscribe?.();
  unsubscribe = subs.subscribe(EVENTS, { projectId: id }, {
    next: ({ data, errors }) => (errors ? toast(errors[0].message) : onEvent(data.taskEvents)),
    reconnected: () => scheduleReload(),
  });
  await loadBoard();
}

let loading = null;
async function loadBoard() {
  const id = state.projectId;
  if (!id) return;
  const variables = {
    id,
    first: PAGE,
    todo: columnFilter('TODO'),
    doing: columnFilter('IN_PROGRESS'),
    review: columnFilter('IN_REVIEW'),
    done: columnFilter('DONE'),
  };
  const request = run(() => client.request(BOARD, variables, 'Board'));
  loading = request;
  const data = await request;
  if (loading !== request || data.project?.id !== state.projectId) return; // superseded by a newer load
  state.project = data.project;
  for (const [status] of STATUSES) state.columns[status] = data.project[status];
  renderAll();
}

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadBoard(), 120);
}

function onEvent(event) {
  const who = event.actor?.name ?? 'Someone';
  const what = event.task ? `${event.task.key} ${event.task.title}` : '';
  const verb = {
    CREATED: 'created',
    UPDATED: 'updated',
    MOVED: event.task ? `moved to ${STATUS_LABEL[event.task.status]}:` : 'moved',
    DELETED: 'deleted a task',
    COMMENTED: 'commented on',
    MEMBERS_CHANGED: 'changed the members',
  }[event.type];
  logEvent(`<b>${escapeHtml(who)}</b> ${escapeHtml(verb)} ${escapeHtml(what)}`);
  if (event.actor?.id === state.me?.id) return; // our own change; we already reloaded
  toast(`${who} ${verb} ${what}`.trim());
  if (state.openTask?.id === event.taskId && event.type !== 'COMMENTED') {
    $('#task-error').textContent = `${who} just changed this task. Saving now will be rejected; reopen it to see their version.`;
  }
  if (event.taskId) flashAfterReload.add(event.taskId);
  scheduleReload();
}
const flashAfterReload = new Set();

function renderAll() {
  const p = state.project;
  $('#role-badge').textContent = p.viewerRole;
  renderStats(p.stats);
  renderAssigneeFilter(p.members);
  const board = $('#board');
  board.innerHTML = '';
  for (const [status, label] of STATUSES) board.append(renderColumn(status, label, state.columns[status]));
  for (const id of flashAfterReload) document.querySelector(`.card[data-id="${id}"]`)?.classList.add('flash');
  flashAfterReload.clear();
}

function renderStats(stats) {
  const age = (Date.now() - new Date(stats.computedAt)) / 1000;
  $('#stats').innerHTML = `
    <div class="stat"><b>${stats.total}</b><span>tasks</span></div>
    <div class="stat ${stats.overdue ? 'bad' : ''}"><b>${stats.overdue}</b><span>overdue</span></div>
    <div class="stat"><b>${stats.unassignedOpen}</b><span>open, unassigned</span></div>
    <div class="stat"><b>${stats.completedLast7Days}</b><span>done in 7 days</span></div>
    <div class="stat when small muted">stats computed ${new Date(stats.computedAt).toLocaleTimeString()}${age > 1.5 ? ` · served from Redis (${Math.round(age)}s old)` : ' · fresh from MongoDB'}</div>`;
}

function renderAssigneeFilter(members) {
  const select = $('#assignee-filter');
  const current = state.filters.assigneeId;
  select.innerHTML =
    `<option value="">Everyone</option><option value="none">Unassigned</option>` +
    members.map((m) => `<option value="${m.user.id}">${escapeHtml(m.user.name)}</option>`).join('');
  select.value = current;
}

function renderColumn(status, label, conn) {
  const col = document.createElement('section');
  col.className = 'column';
  col.dataset.status = status;
  col.innerHTML = `<header><h2>${label}</h2><span class="count">${conn.totalCount}</span></header>`;
  if (status === 'TODO' && canEdit()) {
    const form = document.createElement('form');
    form.className = 'add-task';
    form.innerHTML = '<input name="title" placeholder="Add a task…" maxlength="200" aria-label="New task title"><button>Add</button>';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = form.title.value.trim();
      if (title) createTask(title).then(() => (form.title.value = ''));
    });
    col.append(form);
  }
  for (const task of conn.nodes) col.append(renderCard(task));
  if (conn.pageInfo.hasNextPage) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `+${conn.totalCount - conn.nodes.length} more`;
    col.append(more);
  }
  if (canEdit()) wireDrop(col);
  return col;
}

function renderCard(task) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = task.id;
  card.dataset.rev = task.rev;
  card.dataset.priority = task.priority;
  card.draggable = canEdit();
  card.innerHTML = `
    <div class="title">${escapeHtml(task.title)}</div>
    <div class="meta">
      <span class="key">${escapeHtml(task.key)}</span>
      ${task.labels.map((l) => `<span class="label">${escapeHtml(l)}</span>`).join('')}
      ${task.dueDate ? `<span class="due ${task.isOverdue ? 'overdue' : ''}">${task.isOverdue ? 'overdue ' : 'due '}${formatDue(task.dueDate)}</span>` : ''}
      ${task.commentCount ? `<span title="comments">💬 ${task.commentCount}</span>` : ''}
      ${task.assignee ? `<span class="avatar" style="--avatar:${avatarColor(task.assignee.id)}" title="${escapeHtml(task.assignee.name)}">${initials(task.assignee.name)}</span>` : ''}
    </div>`;
  card.addEventListener('click', () => openTask(task.id));
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}

function wireDrop(col) {
  col.addEventListener('dragover', (e) => {
    e.preventDefault();
    col.classList.add('drop');
  });
  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove('drop');
  });
  col.addEventListener('drop', (e) => {
    e.preventDefault();
    col.classList.remove('drop');
    const id = e.dataTransfer.getData('text/plain');
    const dragged = document.querySelector(`.card[data-id="${id}"]`);
    if (!dragged) return;
    // The card to drop after: the last one whose middle is above the pointer.
    const cards = [...col.querySelectorAll('.card')].filter((c) => c !== dragged);
    let after = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (r.top + r.height / 2 < e.clientY) after = c;
    }
    if (after) after.after(dragged);
    else (col.querySelector('.add-task') ?? col.querySelector('header')).after(dragged);
    moveTask(id, col.dataset.status, after?.dataset.id ?? null, Number(dragged.dataset.rev));
  });
}

// ---------- mutations ----------

async function createTask(title) {
  await run(() =>
    client.request(
      'mutation CreateTask($input: CreateTaskInput!) { createTask(input: $input) { id key } }',
      { input: { projectId: state.project.id, title } },
      'CreateTask',
    ),
  );
  await loadBoard();
}

async function moveTask(id, status, afterId, expectedRev) {
  try {
    await client.request(
      'mutation MoveTask($input: MoveTaskInput!) { moveTask(input: $input) { id status position rev } }',
      { input: { id, status, afterId, expectedRev } },
      'MoveTask',
    );
  } catch (error) {
    toast(error.code === 'CONFLICT' ? 'Someone changed that task first. The board was reloaded.' : error.message);
  }
  await loadBoard();
}

// ---------- task dialog ----------

const dialog = $('#task-dialog');
const form = $('#task-form');

function fillSelect(select, options, value) {
  select.innerHTML = options.map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join('');
  select.value = value ?? '';
}

async function openTask(id) {
  const data = await run(() => client.request(TASK_DETAIL, { id }, 'TaskDetail'));
  const t = data.task;
  state.openTask = t;
  $('#task-key').textContent = t.key;
  $('#task-rev').textContent = `rev ${t.rev} · created by ${t.createdBy.name}`;
  $('#task-error').textContent = '';
  form.title.value = t.title;
  form.description.value = t.description;
  form.labels.value = t.labels.join(', ');
  form.dueDate.value = t.dueDate ? t.dueDate.slice(0, 10) : '';
  fillSelect(form.status, STATUSES, t.status);
  fillSelect(form.priority, PRIORITIES.map((p) => [p, p[0] + p.slice(1).toLowerCase()]), t.priority);
  fillSelect(form.assigneeId, [['', 'Unassigned'], ...state.project.members.map((m) => [m.user.id, m.user.name])], t.assignee?.id ?? '');
  const readOnly = !canEdit();
  for (const el of form.elements) if (el.name) el.disabled = readOnly;
  $('#save-task').hidden = readOnly;
  $('#delete-task').hidden = readOnly;
  $('#comment-input').disabled = readOnly;
  $('#comment-send').disabled = readOnly;
  renderComments(t.comments.nodes);
  if (!dialog.open) dialog.showModal();
}

function renderComments(comments) {
  $('#comment-list').innerHTML =
    comments
      .map((c) => `<li><div class="who">${escapeHtml(c.author.name)} · ${new Date(c.createdAt).toLocaleString()}</div>${escapeHtml(c.body)}</li>`)
      .join('') || '<li class="muted small">No comments yet.</li>';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = state.openTask;
  const input = {};
  const title = form.title.value.trim();
  if (title !== t.title) input.title = title;
  if (form.description.value !== t.description) input.description = form.description.value;
  if (form.status.value !== t.status) input.status = form.status.value;
  if (form.priority.value !== t.priority) input.priority = form.priority.value;
  if ((form.assigneeId.value || null) !== (t.assignee?.id ?? null)) input.assigneeId = form.assigneeId.value || null;
  const labels = form.labels.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (labels.join() !== t.labels.join()) input.labels = labels;
  const due = form.dueDate.value ? new Date(`${form.dueDate.value}T23:59:59`).toISOString() : null;
  if ((t.dueDate?.slice(0, 10) ?? '') !== form.dueDate.value) input.dueDate = due;
  if (Object.keys(input).length === 0) return dialog.close();
  try {
    await client.request(
      'mutation UpdateTask($id: ID!, $input: UpdateTaskInput!, $rev: Int) { updateTask(id: $id, input: $input, expectedRev: $rev) { id rev } }',
      { id: t.id, input, rev: t.rev },
      'UpdateTask',
    );
    dialog.close();
    await loadBoard();
  } catch (error) {
    $('#task-error').textContent =
      error.code === 'CONFLICT' ? `Someone else saved this task first (now rev ${error.errors[0].extensions.currentRev}). Reopen it to see their changes.` : error.message;
  }
});

$('#delete-task').addEventListener('click', async () => {
  if (!confirm(`Delete ${state.openTask.key}?`)) return;
  await run(() => client.request('mutation DeleteTask($id: ID!) { deleteTask(id: $id) { id } }', { id: state.openTask.id }, 'DeleteTask'));
  dialog.close();
  await loadBoard();
});

async function sendComment() {
  const input = $('#comment-input');
  const body = input.value.trim();
  if (!body) return;
  await run(() =>
    client.request('mutation AddComment($taskId: ID!, $body: String!) { addComment(taskId: $taskId, body: $body) { id } }', { taskId: state.openTask.id, body }, 'AddComment'),
  );
  input.value = '';
  await openTask(state.openTask.id);
  await loadBoard();
}
$('#comment-send').addEventListener('click', sendComment);
$('#comment-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendComment();
  }
});
dialog.addEventListener('close', () => (state.openTask = null));
dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

// ---------- wiring ----------

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#login-error').textContent = '';
  try {
    await signIn(f.email.value, f.password.value);
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});
$('#logout').addEventListener('click', signOut);
$('#project-select').addEventListener('change', (e) => openProject(e.target.value));
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.search = e.target.value.trim();
    loadBoard();
  }, 250);
});
$('#assignee-filter').addEventListener('change', (e) => {
  state.filters.assigneeId = e.target.value;
  loadBoard();
});
$('#overdue-filter').addEventListener('change', (e) => {
  state.filters.overdue = e.target.checked;
  loadBoard();
});

if (state.token) start();
else signOut();

function decodePayload(data) {
  if (!data) return null;
  return data;
}

function reportError(data) {
  if (!data) return null;
  return data;
}

function decodePayload(data) {
  if (!data) return null;
  return data;
}