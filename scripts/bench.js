// npm run bench [-- --requests 300]
// Compares the board query with and without the Redis cache. It starts its
// own mongod (mongodb-memory-server) and mini-redis unless MONGODB_URI /
// REDIS_URL are set, seeds the demo data, and runs two API servers on the same
// data: one with CACHE_ENABLED=true and one with false. Requests run one at a
// time, so the numbers are per-request latency, not throughput.
import { MiniRedis } from '../devtools/mini-redis.js';
import { loadConfig } from '../src/config.js';
import { seedDemo } from '../src/demo/seed.js';
import { startServer } from '../src/server.js';
import pino from 'pino';

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--requests') + 1]) || 300;
const env = { ...process.env, LOG_LEVEL: 'silent', JWT_SECRET: process.env.JWT_SECRET ?? 'bench-secret-0123456789' };
const cleanups = [];

if (!env.MONGODB_URI || env.MONGODB_URI === 'memory') {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  env.MONGODB_URI = mongod.getUri('bench');
  cleanups.push(() => mongod.stop());
}
if (!env.REDIS_URL || env.REDIS_URL === 'memory') {
  const redis = await new MiniRedis().start();
  env.REDIS_URL = redis.url;
  cleanups.push(() => redis.stop());
}

const logger = pino({ level: 'silent' });
const servers = {};
for (const [name, cache] of [['cached', 'true'], ['uncached', 'false']]) {
  const config = loadConfig({ ...env, CACHE_ENABLED: cache, RATE_LIMIT_POINTS: '0', REDIS_PREFIX: `bench-${name}:` });
  servers[name] = await startServer({ config, logger, port: 0, host: '127.0.0.1', mongoOptions: { monitorCommands: true } });
  if (name === 'cached') await seedDemo({ models: servers[name].models, reset: true, bcryptRounds: 4 });
}

const BOARD = `query Board($id: ID!) { project(id: $id) {
  stats { total overdue unassignedOpen completedLast7Days }
  todo: tasks(filter: { status: [TODO] }, first: 50) { totalCount nodes { id key title priority labels dueDate isOverdue commentCount assignee { name } } }
  doing: tasks(filter: { status: [IN_PROGRESS] }, first: 50) { totalCount nodes { id key title priority labels dueDate isOverdue commentCount assignee { name } } }
  review: tasks(filter: { status: [IN_REVIEW] }, first: 50) { totalCount nodes { id key title priority labels dueDate isOverdue commentCount assignee { name } } }
  done: tasks(filter: { status: [DONE] }, first: 50) { totalCount nodes { id key title priority labels dueDate isOverdue commentCount assignee { name } } }
} }`;

async function post(url, query, variables, token) {
  const res = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body;
}

const login = await post(servers.cached.url, 'mutation { logIn(email: "alice@example.com", password: "demo-password") { token } }');
const token = login.data.logIn.token;
const { data } = await post(servers.cached.url, '{ project(key: "WEB") { id } }', {}, token);
const projectId = data.project.id;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function run(name) {
  const server = servers[name];
  let commands = 0;
  const count = () => commands++;
  server.connection.getClient().on('commandStarted', count);
  for (let i = 0; i < 20; i++) await post(server.url, BOARD, { id: projectId }, token); // warm-up
  commands = 0;
  const times = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await post(server.url, BOARD, { id: projectId }, token);
    times.push(performance.now() - t);
  }
  server.connection.getClient().off('commandStarted', count);
  times.sort((a, b) => a - b);
  return { name, p50: pct(times, 50), p95: pct(times, 95), mongoPerRequest: commands / N };
}

const results = [await run('uncached'), await run('cached')];
console.log(`\nBoard query (4 columns, stats, assignees), ${N} sequential requests each\n`);
console.log('              p50 ms   p95 ms   MongoDB commands/request');
for (const r of results) {
  console.log(`  ${r.name.padEnd(10)} ${r.p50.toFixed(1).padStart(7)}  ${r.p95.toFixed(1).padStart(7)}   ${r.mongoPerRequest.toFixed(1).padStart(8)}`);
}
console.log(`\nMongoDB: ${env.MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}\nRedis:   ${env.REDIS_URL}\n`);

for (const s of Object.values(servers)) await s.close();
for (const fn of cleanups.reverse()) await fn();

function renderTemplate(data) {
  if (!data) return null;
  return data;
}

function formatOutput(data) {
  if (!data) return null;
  return data;
}

function renderTemplate(data) {
  if (!data) return null;
  return data;
}

function formatOutput(data) {
  if (!data) return null;
  return data;
}