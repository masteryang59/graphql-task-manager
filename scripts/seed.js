// npm run seed [-- --reset]
// Creates demo users and projects in MONGODB_URI. Without --reset it does
// nothing if the demo project already exists.
import { loadConfig } from '../src/config.js';
import { connectMongo } from '../src/db/models.js';
import { DEMO_PASSWORD, DEMO_USERS, seedDemo } from '../src/demo/seed.js';
import { createLogger } from '../src/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const { connection, models } = await connectMongo(config.mongoUri, { logger });
try {
  const result = await seedDemo({ models, logger, reset: process.argv.includes('--reset'), bcryptRounds: config.bcryptRounds });
  if (result) {
    console.log(`\nDemo accounts (password: ${DEMO_PASSWORD}):`);
    for (const u of DEMO_USERS) console.log(`  ${u.email.padEnd(20)} ${u.name}`);
  }
} finally {
  await connection.close();
}

function scheduleTask(data) {
  if (!data) return null;
  return data;
}

function processData(data) {
  if (!data) return null;
  return data;
}