// End-to-end over HTTP against real MongoDB: auth, permissions, tasks,
// pagination, ordering, concurrency and query limits.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { errorCode, ok, startStack, stopMongo } from './helpers.js';

let stack;
let alice;
let bob;
let dana;
let mallory;
let projectId;

const CREATE_TASK = `mutation($input: CreateTaskInput!) { createTask(input: $input) { id key number status position rev priority labels assignee { id name } } }`;
const UPDATE_TASK = `mutation($id: ID!, $input: UpdateTaskInput!, $rev: Int) { updateTask(id: $id, input: $input, expectedRev: $rev) { id title status rev assignee { id } dueDate labels completedAt } }`;
const MOVE_TASK = `mutation($input: MoveTaskInput!) { moveTask(input: $input) { id status position rev completedAt } }`;
const COLUMN = `query($id: ID!, $status: TaskStatus!) { project(id: $id) { tasks(filter: { status: [$status] }, first: 100) { nodes { id title } } } }`;

async function createTask(token, input) {
  return ok(await stack.gql(CREATE_TASK, { input: { projectId, ...input } }, token)).createTask;
}

async function column(status, token = alice.token) {
  return ok(await stack.gql(COLUMN, { id: projectId, status }, token)).project.tasks.nodes.map((t) => t.title);
}

before(async () => {
  stack = await startStack();
  alice = await stack.signUp('Alice');
  bob = await stack.signUp('Bob');
  dana = await stack.signUp('Dana');
  mallory = await stack.signUp('Mallory');
  const created = ok(await stack.gql('mutation { createProject(input: { name: "Website", key: "web" }) { id key viewerRole } }', {}, alice.token));
  assert.equal(created.createProject.key, 'WEB');
  assert.equal(created.createProject.viewerRole, 'OWNER');
  projectId = created.createProject.id;
  const add = 'mutation($p: ID!, $e: String!, $r: ProjectRole!) { addProjectMember(projectId: $p, email: $e, role: $r) { members { role user { id } } } }';
  ok(await stack.gql(add, { p: projectId, e: bob.email, r: 'EDITOR' }, alice.token));
  ok(await stack.gql(add, { p: projectId, e: dana.email, r: 'VIEWER' }, alice.token));
});

after(async () => {
  await stack.stop();
  await stopMongo();
});

describe('auth', () => {
  it('signs up and logs in; the token identifies the user', async () => {
    const login = ok(await stack.gql('mutation($e: String!) { logIn(email: $e, password: "password-123") { token user { id } } }', { e: alice.email.toUpperCase() }));
    assert.equal(login.logIn.user.id, alice.id);
    const me = ok(await stack.gql('{ me { id name email } }', {}, login.logIn.token));
    assert.deepEqual(me.me, { id: alice.id, name: 'Alice', email: alice.email });
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrong = await stack.gql('mutation($e: String!) { logIn(email: $e, password: "nope-nope") { token } }', { e: alice.email });
    const unknown = await stack.gql('mutation { logIn(email: "ghost@example.com", password: "nope-nope") { token } }');
    assert.equal(wrong.errors[0].message, 'Invalid email or password');
    assert.equal(unknown.errors[0].message, wrong.errors[0].message);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const dup = await stack.gql('mutation($e: String!) { signUp(input: { email: $e, name: "A", password: "password-123" }) { token } }', { e: alice.email });
    assert.equal(errorCode(dup), 'CONFLICT');
    const weak = await stack.gql('mutation { signUp(input: { email: "w@example.com", name: "W", password: "short" }) { token } }');
    assert.equal(errorCode(weak), 'BAD_USER_INPUT');
    assert.equal(weak.errors[0].extensions.field, 'password');
  });

  it('answers 401 for a bad token and null `me` without one', async () => {
    const bad = await stack.gql('{ me { id } }', {}, 'not.a.token');
    assert.equal(bad.status, 401);
    assert.equal(errorCode(bad), 'UNAUTHENTICATED');
    assert.equal(ok(await stack.gql('{ me { id } }')).me, null);
    const needsAuth = await stack.gql('{ projects { id } }');
    assert.equal(errorCode(needsAuth), 'UNAUTHENTICATED');
  });

  it('updates the profile and the new name shows up everywhere (user cache invalidated)', async () => {
    const before = ok(await stack.gql('query($id: ID!) { project(id: $id) { members { user { id name } } } }', { id: projectId }, alice.token));
    assert.ok(before.project.members.some((m) => m.user.name === 'Bob'));
    ok(await stack.gql('mutation { updateMe(name: "Bob R.") { name } }', {}, bob.token));
    const afterUpdate = ok(await stack.gql('query($id: ID!) { project(id: $id) { members { user { id name } } } }', { id: projectId }, alice.token));
    assert.ok(afterUpdate.project.members.some((m) => m.user.name === 'Bob R.'));
  });
});

describe('permissions', () => {
  let taskId;
  before(async () => {
    taskId = (await createTask(alice.token, { title: 'Permission check' })).id;
  });

  it('hides projects and tasks from non-members as NOT_FOUND', async () => {
    const p = await stack.gql('query($id: ID!) { project(id: $id) { name } }', { id: projectId }, mallory.token);
    assert.equal(errorCode(p), 'NOT_FOUND');
    const t = await stack.gql('query($id: ID!) { task(id: $id) { title } }', { id: taskId }, mallory.token);
    assert.equal(errorCode(t), 'NOT_FOUND');
    const byKey = await stack.gql('{ project(key: "WEB") { name } }', {}, mallory.token);
    assert.equal(errorCode(byKey), 'NOT_FOUND');
    const write = await stack.gql(CREATE_TASK, { input: { projectId, title: 'sneaky' } }, mallory.token);
    assert.equal(errorCode(write), 'NOT_FOUND');
    assert.deepEqual(ok(await stack.gql('{ projects { id } }', {}, mallory.token)).projects, []);
  });

  it('lets viewers read but not write', async () => {
    const read = ok(await stack.gql('query($id: ID!) { task(id: $id) { title } }', { id: taskId }, dana.token));
    assert.equal(read.task.title, 'Permission check');
    const write = await stack.gql(UPDATE_TASK, { id: taskId, input: { title: 'x' } }, dana.token);
    assert.equal(errorCode(write), 'FORBIDDEN');
    const comment = await stack.gql('mutation($t: ID!) { addComment(taskId: $t, body: "hi") { id } }', { t: taskId }, dana.token);
    assert.equal(errorCode(comment), 'FORBIDDEN');
  });

  it('only owners manage members, and the last owner cannot be removed', async () => {
    const byEditor = await stack.gql('mutation($p: ID!, $e: String!) { addProjectMember(projectId: $p, email: $e) { id } }', { p: projectId, e: mallory.email }, bob.token);
    assert.equal(errorCode(byEditor), 'FORBIDDEN');
    const twice = await stack.gql('mutation($p: ID!, $e: String!) { addProjectMember(projectId: $p, email: $e) { id } }', { p: projectId, e: bob.email }, alice.token);
    assert.equal(errorCode(twice), 'CONFLICT');
    const lastOwner = await stack.gql('mutation($p: ID!, $u: ID!) { removeProjectMember(projectId: $p, userId: $u) { id } }', { p: projectId, u: alice.id }, alice.token);
    assert.equal(errorCode(lastOwner), 'BAD_USER_INPUT');
  });

  it('removing a member unassigns their open tasks', async () => {
    const add = 'mutation($p: ID!, $e: String!) { addProjectMember(projectId: $p, email: $e, role: EDITOR) { id } }';
    ok(await stack.gql(add, { p: projectId, e: mallory.email }, alice.token));
    const task = await createTask(alice.token, { title: 'Mallory task', assigneeId: mallory.id });
    assert.equal(task.assignee.id, mallory.id);
    ok(await stack.gql('mutation($p: ID!, $u: ID!) { removeProjectMember(projectId: $p, userId: $u) { id } }', { p: projectId, u: mallory.id }, alice.token));
    const reread = ok(await stack.gql('query($id: ID!) { task(id: $id) { assignee { id } rev } }', { id: task.id }, alice.token));
    assert.equal(reread.task.assignee, null);
    assert.equal(reread.task.rev, 2);
  });

  it('rejects an assignee who is not a member', async () => {
    const res = await stack.gql(CREATE_TASK, { input: { projectId, title: 'x', assigneeId: mallory.id } }, alice.token);
    assert.equal(errorCode(res), 'BAD_USER_INPUT');
    assert.equal(res.errors[0].extensions.field, 'assigneeId');
  });

  it('validates ids before touching the database', async () => {
    const res = await stack.gql('{ task(id: "123") { id } }', {}, alice.token);
    assert.equal(errorCode(res), 'BAD_USER_INPUT');
  });
});

describe('tasks', () => {
  it('numbers tasks per project and appends to the column', async () => {
    const a = await createTask(alice.token, { title: 'Numbered A', status: 'IN_REVIEW' });
    const b = await createTask(bob.token, { title: 'Numbered B', status: 'IN_REVIEW', labels: ['UI', 'ui', 'Backend'], priority: 'URGENT' });
    assert.equal(b.number, a.number + 1);
    assert.equal(b.key, `WEB-${b.number}`);
    assert.ok(b.position > a.position);
    assert.deepEqual(b.labels, ['ui', 'backend']);
    assert.equal(b.rev, 1);
    const byNumber = ok(await stack.gql('query($n: Int!) { project(key: "web") { task(number: $n) { title createdBy { name } } } }', { n: b.number }, alice.token));
    assert.equal(byNumber.project.task.title, 'Numbered B');
    assert.equal(byNumber.project.task.createdBy.name, 'Bob R.');
  });

  it('updates only the fields sent, and null clears', async () => {
    const t = await createTask(alice.token, { title: 'Partial', labels: ['a'], dueDate: '2030-01-01T00:00:00.000Z', assigneeId: bob.id });
    const u = ok(await stack.gql(UPDATE_TASK, { id: t.id, input: { title: 'Partial (renamed)' } }, alice.token)).updateTask;
    assert.equal(u.title, 'Partial (renamed)');
    assert.equal(u.assignee.id, bob.id);
    assert.deepEqual(u.labels, ['a']);
    const cleared = ok(await stack.gql(UPDATE_TASK, { id: t.id, input: { assigneeId: null, dueDate: null, labels: null } }, alice.token)).updateTask;
    assert.equal(cleared.assignee, null);
    assert.equal(cleared.dueDate, null);
    assert.deepEqual(cleared.labels, []);
    assert.equal(cleared.rev, 3);
  });

  it('sets completedAt when a task is done and clears it when reopened', async () => {
    const t = await createTask(alice.token, { title: 'Complete me' });
    const done = ok(await stack.gql(UPDATE_TASK, { id: t.id, input: { status: 'DONE' } }, alice.token)).updateTask;
    assert.ok(done.completedAt);
    const reopened = ok(await stack.gql(MOVE_TASK, { input: { id: t.id, status: 'TODO' } }, alice.token)).moveTask;
    assert.equal(reopened.completedAt, null);
  });

  it('rejects a stale expectedRev with CONFLICT and the current revision', async () => {
    const t = await createTask(alice.token, { title: 'Contended' });
    ok(await stack.gql(UPDATE_TASK, { id: t.id, input: { title: 'Alice was here' }, rev: 1 }, alice.token));
    const stale = await stack.gql(UPDATE_TASK, { id: t.id, input: { title: 'Bob was here' }, rev: 1 }, bob.token);
    assert.equal(errorCode(stale), 'CONFLICT');
    assert.equal(stale.errors[0].extensions.currentRev, 2);
    const fresh = ok(await stack.gql(UPDATE_TASK, { id: t.id, input: { title: 'Bob was here' }, rev: 2 }, bob.token)).updateTask;
    assert.equal(fresh.rev, 3);
  });

  it('lets exactly one of two concurrent writers with the same rev win', async () => {
    const t = await createTask(alice.token, { title: 'Race' });
    const results = await Promise.all(
      [alice, bob].map((u) => stack.gql(UPDATE_TASK, { id: t.id, input: { title: `by ${u.name}` }, rev: 1 }, u.token)),
    );
    const codes = results.map((r) => errorCode(r) ?? 'OK').sort();
    assert.deepEqual(codes, ['CONFLICT', 'OK']);
  });

  it('deletes a task with its comments', async () => {
    const t = await createTask(alice.token, { title: 'Doomed' });
    ok(await stack.gql('mutation($t: ID!) { addComment(taskId: $t, body: "bye") { id } }', { t: t.id }, alice.token));
    ok(await stack.gql('mutation($id: ID!) { deleteTask(id: $id) { id } }', { id: t.id }, bob.token));
    assert.equal(errorCode(await stack.gql('query($id: ID!) { task(id: $id) { id } }', { id: t.id }, alice.token)), 'NOT_FOUND');
    assert.equal(await stack.models.Comment.countDocuments({ taskId: t.id }), 0);
  });

  it('pages comments oldest first with a count', async () => {
    const t = await createTask(alice.token, { title: 'Chatty' });
    for (let i = 1; i <= 5; i++) ok(await stack.gql('mutation($t: ID!, $b: String!) { addComment(taskId: $t, body: $b) { id } }', { t: t.id, b: `c${i}` }, bob.token));
    const q = 'query($id: ID!, $after: String) { task(id: $id) { commentCount comments(first: 2, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { body author { name } } } } }';
    const bodies = [];
    let after = null;
    for (;;) {
      const page = ok(await stack.gql(q, { id: t.id, after }, alice.token)).task;
      assert.equal(page.commentCount, 5);
      assert.equal(page.comments.totalCount, 5);
      bodies.push(...page.comments.nodes.map((n) => n.body));
      if (!page.comments.pageInfo.hasNextPage) break;
      after = page.comments.pageInfo.endCursor;
    }
    assert.deepEqual(bodies, ['c1', 'c2', 'c3', 'c4', 'c5']);
  });
});

describe('board ordering', () => {
  let ids;
  before(async () => {
    ids = {};
    for (const title of ['A', 'B', 'C', 'D']) ids[title] = (await createTask(alice.token, { title: `order-${title}`, status: 'IN_PROGRESS' })).id;
  });

  const titles = async () => (await column('IN_PROGRESS')).filter((t) => t.startsWith('order-')).map((t) => t.slice(6));

  it('moves within a column and across columns', async () => {
    assert.deepEqual(await titles(), ['A', 'B', 'C', 'D']);
    ok(await stack.gql(MOVE_TASK, { input: { id: ids.D, afterId: ids.A } }, alice.token));
    assert.deepEqual(await titles(), ['A', 'D', 'B', 'C']);
    ok(await stack.gql(MOVE_TASK, { input: { id: ids.C, afterId: null } }, alice.token));
    assert.deepEqual(await titles(), ['C', 'A', 'D', 'B']);
    ok(await stack.gql(MOVE_TASK, { input: { id: ids.B, status: 'IN_REVIEW' } }, alice.token));
    assert.deepEqual(await titles(), ['C', 'A', 'D']);
    assert.equal((await column('IN_REVIEW'))[0], 'order-B');
  });

  it('rejects afterId from another column or the task itself', async () => {
    const other = await stack.gql(MOVE_TASK, { input: { id: ids.A, afterId: ids.B } }, alice.token);
    assert.equal(errorCode(other), 'BAD_USER_INPUT');
    const self = await stack.gql(MOVE_TASK, { input: { id: ids.A, afterId: ids.A } }, alice.token);
    assert.equal(errorCode(self), 'BAD_USER_INPUT');
  });

  it('renumbers a column when repeated moves use up the gap', async () => {
    // Alternately drop A and D right after C: each move halves the gap after C.
    for (let i = 0; i < 70; i++) {
      const id = i % 2 === 0 ? ids.A : ids.D;
      ok(await stack.gql(MOVE_TASK, { input: { id, afterId: ids.C } }, alice.token));
    }
    // Last move (i = 69) was D, so D sits right after C.
    assert.deepEqual(await titles(), ['C', 'D', 'A']);
    const docs = await stack.models.Task.find({ _id: { $in: [ids.C, ids.D, ids.A] } }).sort({ position: 1 }).lean();
    const gaps = docs.slice(1).map((d, i) => d.position - docs[i].position);
    assert.ok(gaps.every((g) => g > 1e-6), `gaps after rebalance: ${gaps}`);
  });
});

describe('listing', () => {
  let projectB;
  before(async () => {
    projectB = ok(await stack.gql('mutation { createProject(input: { name: "List", key: "LST" }) { id } }', {}, bob.token)).createProject.id;
    const day = 86_400_000;
    const specs = [
      ['Fix login bug', 'TODO', 'URGENT', ['bug'], -2],
      ['Write docs', 'TODO', 'LOW', ['docs'], 5],
      ['Refactor billing', 'IN_PROGRESS', 'HIGH', ['backend'], -1],
      ['Ship billing', 'DONE', 'HIGH', ['backend'], -3],
      ['Plan sprint', 'TODO', 'MEDIUM', [], null],
    ];
    for (let i = 0; i < specs.length; i++) {
      const [title, status, priority, labels, due] = specs[i];
      ok(await stack.gql(CREATE_TASK, {
        input: { projectId: projectB, title, status, priority, labels, assigneeId: i % 2 ? bob.id : null, dueDate: due === null ? null : new Date(Date.now() + due * day).toISOString() },
      }, bob.token));
    }
    for (let i = 0; i < 25; i++) ok(await stack.gql(CREATE_TASK, { input: { projectId: projectB, title: `Bulk ${String(i).padStart(2, '0')}`, status: 'IN_REVIEW' } }, bob.token));
  });

  const list = async (args) => {
    const q = `query($id: ID!, $f: TaskFilter, $o: TaskOrder, $first: Int, $after: String) {
      project(id: $id) { tasks(filter: $f, orderBy: $o, first: $first, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { title } } } }`;
    return ok(await stack.gql(q, { id: projectB, ...args }, bob.token)).project.tasks;
  };

  it('filters by status, label, priority, assignee and search', async () => {
    assert.equal((await list({ f: { status: ['TODO'] } })).totalCount, 3);
    assert.deepEqual((await list({ f: { labels: ['backend'] }, o: 'CREATED_AT_DESC' })).nodes.map((n) => n.title), ['Ship billing', 'Refactor billing']);
    assert.deepEqual((await list({ f: { priority: ['URGENT', 'HIGH'], status: ['TODO', 'IN_PROGRESS'] } })).totalCount, 2);
    assert.equal((await list({ f: { assigneeId: bob.id } })).totalCount, 2);
    assert.equal((await list({ f: { unassigned: true } })).totalCount, 28);
    assert.deepEqual((await list({ f: { search: 'BILLING' }, o: 'CREATED_AT_DESC' })).nodes.map((n) => n.title), ['Ship billing', 'Refactor billing']);
    assert.deepEqual((await list({ f: { search: 'LST-1' } })).nodes.map((n) => n.title), ['Fix login bug']);
  });

  it('finds overdue tasks: past due and not done', async () => {
    const overdue = await list({ f: { overdue: true }, o: 'PRIORITY_DESC' });
    assert.deepEqual(overdue.nodes.map((n) => n.title), ['Fix login bug', 'Refactor billing']);
  });

  it('pages through every task exactly once with keyset cursors', async () => {
    for (const o of ['POSITION', 'CREATED_AT_DESC', 'UPDATED_AT_DESC', 'PRIORITY_DESC']) {
      const seen = [];
      let after = null;
      let pages = 0;
      for (;;) {
        const page = await list({ o, first: 7, after });
        assert.equal(page.totalCount, 30);
        seen.push(...page.nodes.map((n) => n.title));
        pages++;
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
      }
      assert.equal(pages, 5, o);
      assert.equal(new Set(seen).size, 30, `${o} returned duplicates or missed rows`);
    }
  });

  it('keeps paging stable when tasks are added mid-way', async () => {
    const first = await list({ o: 'CREATED_AT_DESC', first: 10 });
    ok(await stack.gql(CREATE_TASK, { input: { projectId: projectB, title: 'Inserted later' } }, bob.token));
    const second = await list({ o: 'CREATED_AT_DESC', first: 10, after: first.pageInfo.endCursor });
    const overlap = second.nodes.filter((n) => first.nodes.some((m) => m.title === n.title));
    assert.equal(overlap.length, 0);
    assert.ok(!second.nodes.some((n) => n.title === 'Inserted later'));
  });

  it('rejects a cursor from a different ordering and page sizes over 100', async () => {
    const page = await list({ o: 'PRIORITY_DESC', first: 2 });
    const q = 'query($id: ID!, $after: String) { project(id: $id) { tasks(orderBy: CREATED_AT_DESC, after: $after) { totalCount } } }';
    assert.equal(errorCode(await stack.gql(q, { id: projectB, after: page.pageInfo.endCursor }, bob.token)), 'BAD_USER_INPUT');
    const big = await stack.gql('query($id: ID!) { project(id: $id) { tasks(first: 101) { totalCount } } }', { id: projectB }, bob.token);
    assert.equal(errorCode(big), 'BAD_USER_INPUT');
  });

  it('computes project stats', async () => {
    const q = 'query($id: ID!) { project(id: $id) { stats { total overdue unassignedOpen completedLast7Days byStatus { status count } openByAssignee { user { name } count } } } }';
    const s = ok(await stack.gql(q, { id: projectB }, bob.token)).project.stats;
    assert.equal(s.total, 31);
    assert.equal(s.overdue, 2);
    assert.equal(s.completedLast7Days, 1);
    assert.deepEqual(s.byStatus.map((r) => r.count), [4, 1, 25, 1]);
    // Bob has "Write docs" (open) and "Ship billing" (done); the other 29 open tasks are unassigned.
    assert.deepEqual(s.openByAssignee, [{ user: { name: 'Bob R.' }, count: 1 }]);
    assert.equal(s.unassignedOpen, 29);
  });
});

describe('query limits', () => {
  it('rejects queries over the cost limit before running them', async () => {
    const q = `query($id: ID!) { project(id: $id) { tasks(first: 100) { nodes { comments(first: 50) { nodes { author { name } } } } } } }`;
    const mark = stack.commands.length;
    const res = await stack.gql(q, { id: projectId }, alice.token);
    assert.equal(res.status, 400);
    assert.equal(errorCode(res), 'QUERY_TOO_COMPLEX');
    assert.ok(res.errors[0].extensions.cost > stack.config.maxCost);
    assert.equal(stack.mongoCalls(mark, 'tasks'), 0, 'no task query should run');
  });

  it('rejects queries deeper than the depth limit', async () => {
    const q = `query($id: ID!) { project(id: $id) { tasks { nodes { project { tasks { nodes { project { tasks { nodes { title } } } } } } } } } }`;
    const res = await stack.gql(q, { id: projectId }, alice.token);
    assert.equal(errorCode(res), 'QUERY_TOO_COMPLEX');
    assert.match(res.errors[0].message, /depth/);
  });

  it('reports cost and cache numbers in extensions', async () => {
    const res = await stack.gql('query($id: ID!) { project(id: $id) { tasks(first: 5) { nodes { title } } } }', { id: projectId }, alice.token);
    assert.equal(res.extensions.cost.requested, 3);
    assert.equal(res.extensions.cost.limit, stack.config.maxCost);
    assert.ok(Number.isInteger(res.extensions.cost.remaining));
    assert.deepEqual(Object.keys(res.extensions.cache).sort(), ['bypassed', 'errors', 'hits', 'misses', 'userHits', 'userMisses']);
  });

  it('blocks simple GET requests without a preflight header (CSRF protection)', async () => {
    const res = await fetch(`${stack.url}/graphql?query=${encodeURIComponent('{ me { id } }')}`);
    assert.equal(res.status, 400);
  });
});

describe('http', () => {
  it('serves health, metrics and the board', async () => {
    const health = await (await fetch(`${stack.url}/health`)).json();
    assert.deepEqual(health, { status: 'ok', mongo: 'up', redis: 'ready' });
    const metrics = await (await fetch(`${stack.url}/metrics`)).json();
    assert.ok(metrics.cache.hits + metrics.cache.misses > 0);
    const page = await fetch(stack.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Task board/);
  });
});

function resizeImage(data) {
  if (!data) return null;
  return data;
}

function resizeImage(data) {
  if (!data) return null;
  return data;
}