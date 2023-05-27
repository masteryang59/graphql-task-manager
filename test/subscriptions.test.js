// GraphQL subscriptions over WebSocket, fanned out through Redis pub/sub
// between two API instances that share MongoDB and Redis.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ok, startStack, stopMongo, subscribe, waitForSubscribers } from './helpers.js';

const EVENTS = `subscription($p: ID!) { taskEvents(projectId: $p) { type taskId actor { name } task { key title status rev assignee { name } } } }`;

let stack;
let alice;
let bob;
let mallory;
let projectId;
let urlA;
let urlB;

before(async () => {
  stack = await startStack({ instances: 2 });
  [urlA, urlB] = stack.servers.map((s) => s.url);
  alice = await stack.signUp('Alice');
  bob = await stack.signUp('Bob');
  mallory = await stack.signUp('Mallory');
  projectId = ok(await stack.gql('mutation { createProject(input: { name: "Live", key: "LIVE" }) { id } }', {}, alice.token)).createProject.id;
  ok(await stack.gql('mutation($p: ID!, $e: String!) { addProjectMember(projectId: $p, email: $e, role: VIEWER) { id } }', { p: projectId, e: bob.email }, alice.token));
});

after(async () => {
  await stack.stop();
  await stopMongo();
});

describe('taskEvents subscription', () => {
  it('delivers changes made through instance A to a subscriber on instance B', async () => {
    const sub = subscribe(urlB, bob.token, EVENTS, { p: projectId });
    try {
      await waitForSubscribers(stack, 1);
      assert.equal(stack.servers[1].pubsub.subscriptionCount, 1);

      const created = ok(await stack.gql('mutation($i: CreateTaskInput!) { createTask(input: $i) { id } }', { i: { projectId, title: 'Live task', assigneeId: alice.id } }, alice.token, { url: urlA })).createTask;
      await sub.waitFor(() => sub.events.length >= 1);
      const [first] = sub.events;
      assert.equal(first.errors, undefined);
      assert.equal(first.data.taskEvents.type, 'CREATED');
      assert.equal(first.data.taskEvents.taskId, created.id);
      assert.equal(first.data.taskEvents.actor.name, 'Alice');
      assert.deepEqual(first.data.taskEvents.task, { key: 'LIVE-1', title: 'Live task', status: 'TODO', rev: 1, assignee: { name: 'Alice' } });

      ok(await stack.gql('mutation($i: MoveTaskInput!) { moveTask(input: $i) { id } }', { i: { id: created.id, status: 'IN_PROGRESS' } }, alice.token, { url: urlA }));
      ok(await stack.gql('mutation($t: ID!) { addComment(taskId: $t, body: "on it") { id } }', { t: created.id }, alice.token, { url: urlA }));
      ok(await stack.gql('mutation($id: ID!) { deleteTask(id: $id) { id } }', { id: created.id }, alice.token, { url: urlA }));
      await sub.waitFor(() => sub.events.length >= 4);
      assert.deepEqual(sub.events.map((e) => e.data.taskEvents.type), ['CREATED', 'MOVED', 'COMMENTED', 'DELETED']);
      const moved = sub.events[1].data.taskEvents.task;
      assert.equal(moved.status, 'IN_PROGRESS');
      assert.equal(moved.rev, 2);
      assert.equal(sub.events[3].data.taskEvents.task, null);
    } finally {
      await sub.close();
    }
  });

  it('only delivers events for the subscribed project', async () => {
    const other = ok(await stack.gql('mutation { createProject(input: { name: "Other", key: "OTH" }) { id } }', {}, alice.token)).createProject.id;
    const sub = subscribe(urlA, alice.token, EVENTS, { p: other });
    try {
      await waitForSubscribers(stack, 1);
      ok(await stack.gql('mutation($i: CreateTaskInput!) { createTask(input: $i) { id } }', { i: { projectId, title: 'Not for OTH' } }, alice.token));
      ok(await stack.gql('mutation($i: CreateTaskInput!) { createTask(input: $i) { id } }', { i: { projectId: other, title: 'For OTH' } }, alice.token));
      await sub.waitFor(() => sub.events.length >= 1);
      assert.deepEqual(sub.events.map((e) => e.data.taskEvents.task.title), ['For OTH']);
    } finally {
      await sub.close();
    }
  });

  it('refuses non-members', async () => {
    const sub = subscribe(urlA, mallory.token, EVENTS, { p: projectId });
    try {
      await sub.waitFor(() => sub.events.length > 0 || sub.errors.length > 0);
      const message = sub.events[0]?.errors?.[0] ?? sub.errors[0]?.[0];
      assert.equal(message.extensions.code, 'NOT_FOUND');
      assert.equal(stack.servers[0].pubsub.subscriptionCount, 0);
    } finally {
      await sub.close();
    }
  });

  it('closes the socket for an invalid token', async () => {
    const sub = subscribe(urlA, 'forged.token.value', EVENTS, { p: projectId });
    await sub.waitFor(() => sub.closeInfo !== null || sub.errors.length > 0);
    await sub.close();
    assert.equal(sub.closeInfo?.code, 4403);
  });

  it('applies the depth limit to subscriptions', async () => {
    const deep = `subscription($p: ID!) { taskEvents(projectId: $p) { task { project { tasks { nodes { project { tasks { nodes { title } } } } } } } } }`;
    const sub = subscribe(urlA, alice.token, deep, { p: projectId });
    try {
      await sub.waitFor(() => sub.errors.length > 0);
      assert.equal(sub.errors[0][0].extensions.code, 'QUERY_TOO_COMPLEX');
    } finally {
      await sub.close();
    }
  });

  it('cleans up the Redis subscription when the client goes away', async () => {
    const sub = subscribe(urlB, alice.token, EVENTS, { p: projectId });
    await waitForSubscribers(stack, 1);
    await sub.close();
    const deadline = Date.now() + 2000;
    while (stack.servers[1].pubsub.subscriptionCount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(stack.servers[1].pubsub.subscriptionCount, 0);
    assert.equal(stack.servers[1].pubsub.listeners.size, 0);
  });
});

function classifyIntent(data) {
  if (!data) return null;
  return data;
}

function classifyIntent(data) {
  if (!data) return null;
  return data;
}