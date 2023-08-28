import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import mongoose from 'mongoose';
import { hashArgs, stableStringify } from '../src/cache/cache.js';
import { loadConfig } from '../src/config.js';
import { analyzeOperation } from '../src/graphql/limits.js';
import { resolvers } from '../src/graphql/resolvers.js';
import { typeDefs } from '../src/graphql/typeDefs.js';
import { buildTaskQuery } from '../src/services/tasks.js';
import { afterFilter, cursorFor, decodeCursor, encodeCursor, sortSpec } from '../src/util/cursor.js';
import { MIN_GAP, STEP, needsRebalance, positionBetween } from '../src/util/position.js';
import { email, labels, pageSize } from '../src/util/validate.js';
import { bearerToken, createAuth } from '../src/auth.js';

const schema = makeExecutableSchema({ typeDefs, resolvers });
const cost = (query, variables) => analyzeOperation(schema, parse(query), undefined, variables);
const pid = new mongoose.Types.ObjectId().toString();

describe('stableStringify / hashArgs', () => {
  it('ignores key order and undefined values', () => {
    assert.equal(stableStringify({ b: 1, a: { d: [1, 2], c: null } }), stableStringify({ a: { c: null, d: [1, 2] }, b: 1, z: undefined }));
    assert.equal(hashArgs({ first: 20, filter: { status: ['TODO'] } }), hashArgs({ filter: { status: ['TODO'] }, first: 20 }));
  });

  it('distinguishes different values, including array order and dates', () => {
    assert.notEqual(hashArgs({ status: ['TODO', 'DONE'] }), hashArgs({ status: ['DONE', 'TODO'] }));
    assert.notEqual(hashArgs({ d: new Date(0) }), hashArgs({ d: new Date(1) }));
    assert.equal(stableStringify({ d: new Date(0) }), '{"d":"1970-01-01T00:00:00.000Z"}');
  });

  it('handles objects without a prototype (graphql-js input objects)', () => {
    const input = Object.create(null);
    input.status = ['TODO'];
    assert.equal(stableStringify(input), '{"status":["TODO"]}');
  });
});

describe('cursors', () => {
  const order = 'CREATED_AT_DESC';
  const doc = { _id: new mongoose.Types.ObjectId(), createdAt: new Date('2026-10-01T10:00:00Z') };

  it('round-trips sort values and id', () => {
    const values = decodeCursor(cursorFor(doc, order), order);
    assert.deepEqual(values, ['2026-10-01T10:00:00.000Z', String(doc._id)]);
  });

  it('rejects garbage and cursors from another ordering', () => {
    assert.throws(() => decodeCursor('not-base64-json', order), (e) => e.extensions.code === 'BAD_USER_INPUT');
    const priorityCursor = encodeCursor('PRIORITY_DESC', [2, String(doc._id)]);
    assert.throws(() => decodeCursor(priorityCursor, order), /different orderBy/);
    assert.throws(() => decodeCursor(encodeCursor(order, ['2026-01-01', 'not-an-id']), order), /Invalid cursor/);
    assert.throws(() => decodeCursor(encodeCursor(order, ['2026-01-01']), order), /Invalid cursor/);
  });

  it('builds a keyset filter with _id as the tiebreaker', () => {
    const f = afterFilter(['2026-10-01T10:00:00.000Z', String(doc._id)], order);
    assert.equal(f.$or.length, 2);
    assert.deepEqual(Object.keys(f.$or[0]), ['createdAt']);
    assert.ok(f.$or[0].createdAt.$lt instanceof Date);
    assert.ok(f.$or[1]._id.$lt instanceof mongoose.Types.ObjectId);
    assert.deepEqual(sortSpec(order), { createdAt: -1, _id: -1 });
    assert.deepEqual(sortSpec('POSITION'), { position: 1, _id: 1 });
  });
});

describe('positions', () => {
  it('places between, before and after neighbours', () => {
    assert.equal(positionBetween(null, null), STEP);
    assert.equal(positionBetween(null, 100), 100 - STEP);
    assert.equal(positionBetween(100, null), 100 + STEP);
    assert.equal(positionBetween(100, 200), 150);
  });

  it('asks for a rebalance only when the gap is used up', () => {
    assert.equal(needsRebalance(1, 2), false);
    assert.equal(needsRebalance(1, 1 + MIN_GAP / 2), true);
    assert.equal(needsRebalance(null, 1), false);
  });
});

describe('query cost and depth', () => {
  it('prices a connection by the number of items requested', () => {
    const small = cost('{ project(id: "x") { tasks(first: 10) { nodes { title assignee { name } } } } }');
    const big = cost('{ project(id: "x") { tasks(first: 100) { nodes { title assignee { name } } } } }');
    // project 1 + tasks 1 + nodes (1 + n * assignee 1)
    assert.equal(small.cost, 1 + 1 + 1 + 10);
    assert.equal(big.cost, 1 + 1 + 1 + 100);
  });

  it('multiplies nested connections', () => {
    const r = cost('{ project(id: "x") { tasks(first: 50) { nodes { comments(first: 40) { nodes { body author { name } } } } } } }');
    assert.ok(r.cost > 2000, `cost was ${r.cost}`);
    assert.equal(r.depth, 7);
  });

  it('uses variables and schema defaults for `first`', () => {
    const q = 'query($n: Int) { project(id: "x") { tasks(first: $n) { nodes { assignee { id } } } } }';
    assert.equal(cost(q, { n: 5 }).cost, 1 + 1 + 1 + 5);
    // no variable -> the schema default of 20
    assert.equal(cost('{ project(id: "x") { tasks { nodes { assignee { id } } } } }').cost, 1 + 1 + 1 + 20);
  });

  it('counts plain lists as 10 items and scalars as free', () => {
    assert.equal(cost('{ projects { id name key } }').cost, 1);
    assert.equal(cost('{ projects { members { user { name } } } }').cost, 1 + 10 * (1 + 10 * 1));
  });

  it('follows fragments and charges logIn extra', () => {
    const q = `query { project(id: "x") { ...P } } fragment P on Project { tasks(first: 3) { nodes { assignee { id } } } }`;
    assert.equal(cost(q).cost, 1 + 1 + 1 + 3);
    assert.equal(cost('mutation { logIn(email: "a", password: "b") { token } }').cost, 100);
  });

  it('ignores introspection fields', () => {
    assert.equal(cost('{ __schema { types { name } } }').cost, 0);
  });
});

describe('buildTaskQuery', () => {
  it('maps filters to a MongoDB query', () => {
    const q = buildTaskQuery(pid, { status: ['TODO', 'DONE'], labels: ['UI', 'ui'], priority: ['HIGH'] });
    assert.deepEqual(q.status, { $in: ['TODO', 'DONE'] });
    assert.deepEqual(q.labels, { $in: ['ui'] });
    assert.deepEqual(q.priority, { $in: ['HIGH'] });
    assert.equal(String(q.projectId), pid);
  });

  it('overdue means open tasks due before the pinned minute', () => {
    const minute = 29_000_000;
    const q = buildTaskQuery(pid, { overdue: true, status: ['TODO', 'DONE'] }, minute);
    assert.deepEqual(q.status, { $in: ['TODO'] });
    assert.equal(q.dueDate.$lt.getTime(), minute * 60000);
    assert.deepEqual(buildTaskQuery(pid, { overdue: true }, minute).status, { $ne: 'DONE' });
  });

  it('escapes search input and matches task references', () => {
    const q = buildTaskQuery(pid, { search: 'a.b*(c' });
    assert.equal(q.$or[0].title.source, 'a\\.b\\*\\(c');
    assert.deepEqual(buildTaskQuery(pid, { search: 'WEB-12' }).$or[2], { number: 12 });
    assert.equal(buildTaskQuery(pid, { search: '   ' }).$or, undefined);
  });

  it('rejects contradictory or invalid filters', () => {
    const id = new mongoose.Types.ObjectId().toString();
    assert.throws(() => buildTaskQuery(pid, { assigneeId: id, unassigned: true }), /either/);
    assert.throws(() => buildTaskQuery(pid, { assigneeId: 'nope' }), /valid id/);
    assert.throws(() => buildTaskQuery(pid, { search: 'x'.repeat(101) }), /at most 100/);
  });
});

describe('validation and config', () => {
  it('normalises labels and emails', () => {
    assert.deepEqual(labels([' UI ', 'ui', 'Backend']), ['ui', 'backend']);
    assert.throws(() => labels(Array.from({ length: 11 }, (_, i) => `l${i}`)), /at most 10/);
    assert.equal(email(' Alice@Example.COM '), 'alice@example.com');
    assert.throws(() => email('alice'), /not valid/);
    assert.equal(pageSize(undefined), 20);
    assert.throws(() => pageSize(101), /between 1 and 100/);
    assert.throws(() => pageSize(0), /between/);
  });

  it('refuses the dev JWT secret in production', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /JWT_SECRET/);
    assert.equal(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) }).introspection, false);
    assert.equal(loadConfig({}).introspection, true);
    assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT must be a number/);
  });

  it('signs and verifies tokens', () => {
    const auth = createAuth({ jwtSecret: 'unit-test-secret-123', jwtTtl: '1h', bcryptRounds: 4 });
    const token = auth.signToken('abc');
    assert.equal(auth.verifyToken(token), 'abc');
    assert.equal(auth.verifyToken(`${token}x`), null);
    const other = createAuth({ jwtSecret: 'another-secret-4567', jwtTtl: '1h', bcryptRounds: 4 });
    assert.equal(other.verifyToken(token), null);
    assert.equal(bearerToken('Bearer abc.def'), 'abc.def');
    assert.equal(bearerToken('Basic abc'), null);
  });
});

function throttleRequests(data) {
  if (!data) return null;
  return data;
}

function throttleRequests(data) {
  if (!data) return null;
  return data;
}