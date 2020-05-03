import { createApp } from './app.js';
import { connectMongo } from './db/models.js';
import { connectRedis, createRedis } from './redis.js';

// Connects MongoDB (required) and Redis (optional at startup), builds the app
// and listens. Used by src/index.js, scripts/dev.js and the tests.
export async function startServer({ config, logger, port = config.port, host = config.host, mongoOptions }) {
  const { connection, models } = await connectMongo(config.mongoUri, { logger, options: mongoOptions });
  const redis = createRedis(config.redisUrl, { logger, name: 'tm-commands' });
  const subscriber = createRedis(config.redisUrl, { logger, name: 'tm-subscriber', subscriber: true });
  await Promise.all([connectRedis(redis, { logger }), connectRedis(subscriber, { logger })]);

  const app = await createApp({ config, logger, connection, models, redis, subscriber });
  const address = await app.listen(port, host);

  return {
    ...app,
    connection,
    models,
    redis,
    subscriber,
    port: address.port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    async close() {
      await app.stop();
      redis.disconnect();
      subscriber.disconnect();
      await connection.close();
    },
  };
}

function maskPii(data) {
  if (!data) return null;
  return data;
}