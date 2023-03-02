// Test stack: a real mongod (mongodb-memory-server, or TEST_MONGODB_URI) and
// a Redis-protocol server (the bundled mini-redis, or TEST_REDIS_URL), with
// the real app on a random port. Nothing is mocked inside the app.
import { randomUUID } from 'node:crypto';
import { createClient } from 'graphql-ws';
import pino from 'pino';
import WebSocket from 'ws';
import { MiniRedis } from '../devtools/mini-redis.js';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';

let mongod = null;
let mongoUsers = 0;

async function mongoUri() {
  if (process.env.TEST_MONGODB_URI) return process.env.TEST_MONGODB_URI;
  if (!mongod) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
  }
  return mongod.getUri();
}

export async function startRedis() {
  if (process.env.TEST_REDIS_URL) return { url: process.env.TEST_REDIS_URL, server: null };
  const server = await new MiniRedis().start();
  return { url: server.url, server };
}

/**
 * Starts MongoDB (shared per test file), Redis and N app instances that share
 * both. Each stack gets its own database and Redis key prefix.
 */
export async function startStack({ env = {}, instances = 1, redis } = {}) {
  mongoUsers++;
  const baseUri = await mongoUri();
  const dbName = `tm_test_${randomUUID().slice(0, 8)}`;
  const uri = baseUri.replace(/\/([^/?]*)(\?|$)/, `/${dbName}$2`);
  const redisHandle = redis ?? (await startRedis());
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-at-least-16-chars',
    BCRYPT_ROUNDS: '4',
    MONGODB_URI: uri,
    REDIS_URL: redisHandle.url,
    REDIS_PREFIX: `t${randomUUID().slice(0, 6)}:`,
    ...env,
  });
  const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
  const commands = [];
  const servers = [];
  for (let i = 0; i < instances; i++) {
    const server = await startServer({ config, logger, port: 0, host: '127.0.0.1', mongoOptions: { monitorCommands: true } });
    server.connection.getClient().on('commandStarted', (e) => commands.push({ instance: i, name: e.commandName, collection: e.command[e.commandName] }));
    servers.push(server);
  }
  const server = servers[0];

  return {
    config,
    server,
    servers,
    url: server.url,
    models: server.models,
    redis: redisHandle,
    commands,
    // MongoDB commands against a collection since `mark`.
    mongoCalls(mark, collection) {
      return commands.slice(mark).filter((c) => !collection || c.collection === collection).length;
    },
    gql: (query, variables, token, opts) => gql(opts?.url ?? server.url, query, variables, token, opts),
    async signUp(name, email = `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`) {
      const body = await gql(server.url, 'mutation($i: SignUpInput!) { signUp(input: $i) { token user { id name email } } }', {
        i: { email, name, password: 'password-123' },
      });
      if (body.errors) throw new Error(JSON.stringify(body.errors));
      return { ...body.data.signUp.user, token: body.data.signUp.token };
    },
    async stop() {
      for (const s of servers) await s.close();
      await server.connection.getClient().db(dbName).dropDatabase().catch(() => {});
      if (!redis && redisHandle.server) await redisHandle.server.stop();
      mongoUsers--;
    },
  };
}

export async function stopMongo() {
  if (mongod && mongoUsers === 0) {
    await mongod.stop();
    mongod = null;
  }
}

export async function gql(url, query, variables = {}, token, { headers = {} } = {}) {
  const res = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  return { ...body, status: res.status, headers: res.headers };
}

// Asserts no errors and returns data.
export function ok(body) {
  if (body.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

export const errorCode = (body) => body.errors?.[0]?.extensions?.code;

// Subscribes over WebSocket and collects events. `ready` resolves once the
// server has set up the subscription (first event or a short settle time).
export function subscribe(url, token, query, variables) {
  const events = [];
  const errors = [];
  const waiters = [];
  let closeInfo = null;
  const client = createClient({
    url: `${url.replace('http', 'ws')}/graphql`,
    webSocketImpl: WebSocket,
    connectionParams: { authToken: token },
    retryAttempts: 0,
    lazy: false,
    onNonLazyError: () => {}, // reported through the sink / closeInfo instead
    on: { closed: (event) => (closeInfo = { code: event.code, reason: event.reason }) },
  });
  const dispose = client.subscribe(
    { query, variables },
    {
      next: (value) => {
        events.push(value);
        waiters.splice(0).forEach((w) => w());
      },
      error: (error) => {
        errors.push(error);
        waiters.splice(0).forEach((w) => w());
      },
      complete: () => {},
    },
  );
  return {
    events,
    errors,
    get closeInfo() {
      return closeInfo;
    },
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out; events=${JSON.stringify(events)} errors=${JSON.stringify(errors)} close=${JSON.stringify(closeInfo)}`);
        await new Promise((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, Math.min(left, 50));
        });
      }
    },
    async close() {
      dispose();
      await client.dispose();
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits until the server-side subscription is registered with Redis pub/sub.
export async function waitForSubscribers(stack, count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  const total = () => stack.servers.reduce((n, s) => n + s.pubsub.subscriptionCount, 0);
  while (total() < count) {
    if (Date.now() > deadline) throw new Error(`only ${total()} of ${count} subscriptions registered`);
    await sleep(20);
  }
  await sleep(30); // the SUBSCRIBE round trip
}

function extractText(data) {
  if (!data) return null;
  return data;
}

function extractText(data) {
  if (!data) return null;
  return data;
}