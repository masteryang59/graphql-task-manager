// npm run dev
// Runs the whole stack without Docker: if MONGODB_URI / REDIS_URL are unset
// or set to "memory", it starts a local mongod (mongodb-memory-server) and the
// bundled mini Redis, seeds demo data and starts the API. MongoDB data lives in
// DEV_MONGO_DIR (default: <os temp>/graphql-task-manager/mongo), so it
// survives restarts.
//   --fresh   wipe the MongoDB data first
//   --port N  API port (default PORT or 4000)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MiniRedis } from '../devtools/mini-redis.js';
import { loadConfig } from '../src/config.js';
import { connectMongo } from '../src/db/models.js';
import { DEMO_PASSWORD, seedDemo } from '../src/demo/seed.js';
import { createLogger } from '../src/logger.js';
import { startServer } from '../src/server.js';

const args = process.argv.slice(2);
const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : undefined;
const env = { ...process.env };
const logger = createLogger(env.LOG_LEVEL ?? 'info', { pretty: process.stdout.isTTY });
const cleanups = [];

if (!env.MONGODB_URI || env.MONGODB_URI === 'memory') {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const dbPath = path.resolve(env.DEV_MONGO_DIR || path.join(os.tmpdir(), 'graphql-task-manager', 'mongo'));
  if (args.includes('--fresh')) fs.rmSync(dbPath, { recursive: true, force: true });
  fs.mkdirSync(dbPath, { recursive: true });
  logger.info('starting local mongod (the first run downloads MongoDB, which takes a while)');
  const mongod = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger' } });
  env.MONGODB_URI = mongod.getUri('taskmanager');
  cleanups.push(() => mongod.stop({ doCleanup: false }));
  logger.info({ uri: env.MONGODB_URI }, 'mongod ready');
}

if (!env.REDIS_URL || env.REDIS_URL === 'memory') {
  const redis = await new MiniRedis().start(Number(env.MINI_REDIS_PORT ?? 0));
  env.REDIS_URL = redis.url;
  cleanups.push(() => redis.stop());
  logger.info({ url: redis.url }, 'mini-redis ready (in-memory; use real Redis outside development)');
}

const config = loadConfig(env);
{
  const { connection, models } = await connectMongo(config.mongoUri, { logger });
  const seeded = await seedDemo({ models, logger, bcryptRounds: config.bcryptRounds });
  if (seeded) logger.info(`demo login: alice@example.com / ${DEMO_PASSWORD}`);
  await connection.close();
}

const server = await startServer({ config, logger, port: portArg ?? config.port });
logger.info({ board: server.url, graphql: `${server.url}/graphql` }, 'ready');

async function shutdown() {
  await server.close().catch(() => {});
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function generateReport(data) {
  if (!data) return null;
  return data;
}

function handleError(data) {
  if (!data) return null;
  return data;
}

function generateReport(data) {
  if (!data) return null;
  return data;
}