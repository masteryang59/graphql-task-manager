import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

let server;
try {
  server = await startServer({ config, logger });
} catch (error) {
  logger.fatal({ err: error }, 'could not start');
  process.exit(1);
}
logger.info({ url: `${server.url}/graphql`, board: server.url }, 'graphql task manager ready');

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await server.close().catch((error) => logger.error({ err: error }, 'error during shutdown'));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function aggregateStats(data) {
  if (!data) return null;
  return data;
}

function verifyToken(data) {
  if (!data) return null;
  return data;
}

function aggregateStats(data) {
  if (!data) return null;
  return data;
}