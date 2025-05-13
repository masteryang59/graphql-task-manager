import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { expressMiddleware } from '@as-integrations/express5';
import { makeExecutableSchema } from '@graphql-tools/schema';
import express from 'express';
import { parse, validate } from 'graphql';
import { useServer } from 'graphql-ws/use/ws';
import mongoose from 'mongoose';
import { WebSocketServer } from 'ws';
import { createAuth, bearerToken } from './auth.js';
import { Cache, emptyStats } from './cache/cache.js';
import { rateLimited, tooComplex, unauthenticated } from './errors.js';
import { analyzeOperation } from './graphql/limits.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/typeDefs.js';
import { createLoaders } from './loaders.js';
import { RedisPubSub } from './pubsub.js';
import { RateLimiter } from './ratelimit.js';
import { isReady } from './redis.js';
import { projectService } from './services/projects.js';
import { taskService } from './services/tasks.js';
import { userService } from './services/users.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function checkLimits(config, analysis) {
  if (analysis.depth > config.maxDepth) {
    throw tooComplex(`Query depth ${analysis.depth} is over the limit of ${config.maxDepth}`, { depth: analysis.depth, maxDepth: config.maxDepth });
  }
  if (analysis.cost > config.maxCost) {
    throw tooComplex(`Query cost ${analysis.cost} is over the limit of ${config.maxCost}. Ask for fewer items with "first".`, {
      cost: analysis.cost,
      maxCost: config.maxCost,
    });
  }
}

// Rejects queries that are too deep or too expensive before they run, charges
// their cost to the client's rate-limit budget, and reports cache and cost
// numbers in the response's `extensions`.
function limitsPlugin({ config, rateLimiter, logger }) {
  return {
    async requestDidStart({ contextValue }) {
      const started = performance.now();
      return {
        async didResolveOperation({ request, document, schema }) {
          const analysis = analyzeOperation(schema, document, request.operationName, request.variables);
          contextValue.cost = analysis.cost;
          checkLimits(config, analysis);
          const result = await rateLimiter.consume(contextValue.clientKey, analysis.cost);
          contextValue.rateLimit = result;
          if (!result.allowed) throw rateLimited(result.retryAfterSeconds);
        },
        async willSendResponse({ response, operationName, errors }) {
          const durationMs = Math.round((performance.now() - started) * 10) / 10;
          if (response.body.kind === 'single') {
            const extensions = (response.body.singleResult.extensions ??= {});
            extensions.cost = { requested: contextValue.cost ?? null, limit: config.maxCost, remaining: contextValue.rateLimit?.remaining ?? null };
            extensions.cache = contextValue.cacheStats;
            extensions.durationMs = durationMs;
          }
          logger.debug(
            { operationName, durationMs, cost: contextValue.cost, cache: contextValue.cacheStats, errors: errors?.map((e) => e.extensions?.code ?? e.message) },
            'graphql request',
          );
        },
      };
    },
  };
}

export async function createApp({ config, logger, connection, models, redis, subscriber }) {
  const auth = createAuth(config);
  const cache = new Cache({
    redis,
    prefix: config.redisPrefix,
    ttlSeconds: config.cacheTtlSeconds,
    userTtlSeconds: config.userCacheTtlSeconds,
    enabled: config.cacheEnabled,
    logger,
  });
  const pubsub = new RedisPubSub({ publisher: redis, subscriber, prefix: config.redisPrefix, logger });
  const rateLimiter = new RateLimiter({
    redis,
    prefix: config.redisPrefix,
    points: config.rateLimitPoints,
    windowSeconds: config.rateLimitWindowSeconds,
    logger,
  });
  const deps = { models, cache, pubsub, auth, logger };
  const services = { users: userService(deps), projects: projectService(deps), tasks: taskService(deps) };
  const schema = makeExecutableSchema({ typeDefs, resolvers });

  async function buildContext({ token, ip, memoize = true }) {
    const cacheStats = emptyStats();
    const ctx = {
      viewer: null,
      clientKey: `ip:${ip ?? 'unknown'}`,
      cacheStats,
      cacheSession: cache.session(),
      loaders: createLoaders({ models, cache, stats: cacheStats, memoize }),
      services,
      pubsub,
    };
    if (token) {
      const userId = auth.verifyToken(token);
      const user = userId && mongoose.isValidObjectId(userId) ? await ctx.loaders.users.load(userId) : null;
      if (!user) throw unauthenticated('Invalid or expired token');
      ctx.viewer = user;
      ctx.clientKey = `user:${user.id}`;
    }
    return ctx;
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);
  const httpServer = http.createServer(app);

  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });
  const wsHandle = useServer(
    {
      schema,
      // A bad token closes the socket with 4403 Forbidden instead of opening a session.
      onConnect: async (ctx) => {
        const token = ctx.connectionParams?.authToken ?? null;
        try {
          ctx.extra.context = await buildContext({ token, ip: ctx.extra.request.socket.remoteAddress, memoize: false });
          return true;
        } catch {
          return false;
        }
      },
      // Same validation and cost/depth limits as HTTP, before anything runs.
      onSubscribe: (ctx, id, payload) => {
        let document;
        try {
          document = parse(payload.query);
        } catch (error) {
          return [error];
        }
        const errors = validate(schema, document);
        if (errors.length) return errors;
        try {
          checkLimits(config, analyzeOperation(schema, document, payload.operationName, payload.variables ?? {}));
        } catch (error) {
          return [error];
        }
        return { schema, document, operationName: payload.operationName, variableValues: payload.variables, contextValue: ctx.extra.context };
      },
    },
    wsServer,
  );

  const apollo = new ApolloServer({
    schema,
    introspection: config.introspection,
    includeStacktraceInErrorResponses: !config.production,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      { async serverWillStart() { return { async drainServer() { await wsHandle.dispose(); } }; } },
      limitsPlugin({ config, rateLimiter, logger }),
      ...(config.introspection ? [] : [ApolloServerPluginLandingPageDisabled()]),
    ],
    formatError(formatted, error) {
      const code = formatted.extensions?.code;
      if (code === 'INTERNAL_SERVER_ERROR') {
        logger.error({ err: error }, 'unhandled resolver error');
        if (config.production) return { message: 'Internal server error', extensions: { code }, path: formatted.path };
      }
      return formatted;
    },
  });
  await apollo.start();

  if (config.corsOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && config.corsOrigins.includes(origin)) {
        res.set('access-control-allow-origin', origin);
        res.set('vary', 'origin');
        res.set('access-control-allow-headers', 'authorization, content-type, apollo-require-preflight');
        res.set('access-control-allow-methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.get('/health', (req, res) => {
    const mongo = connection.readyState === 1;
    res.status(mongo ? 200 : 503).json({
      status: mongo ? (isReady(redis) ? 'ok' : 'degraded') : 'down',
      mongo: mongo ? 'up' : 'down',
      redis: redis.status,
    });
  });

  app.get('/metrics', (req, res) => {
    const { hits, misses } = cache.totals;
    res.json({
      cache: { ...cache.totals, hitRate: hits + misses ? Math.round((hits / (hits + misses)) * 1000) / 1000 : null },
      rateLimit: { rejected: rateLimiter.rejected, pointsPerWindow: config.rateLimitPoints, windowSeconds: config.rateLimitWindowSeconds },
      pubsub: { published: pubsub.published, delivered: pubsub.delivered, activeSubscriptions: pubsub.subscriptionCount },
      redis: redis.status,
    });
  });

  app.use(
    '/graphql',
    express.json({ limit: '100kb' }),
    expressMiddleware(apollo, {
      context: ({ req }) => buildContext({ token: bearerToken(req.headers.authorization), ip: req.ip }),
    }),
  );

  app.use(express.static(publicDir, { index: 'index.html', maxAge: config.production ? '1h' : 0 }));

  let stopped = false;
  return {
    app,
    httpServer,
    services,
    cache,
    pubsub,
    rateLimiter,
    schema,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve(httpServer.address());
        });
      });
    },
    // Stops accepting work and waits for in-flight requests, then closes
    // WebSockets. Database connections belong to the caller.
    async stop() {
      if (stopped) return;
      stopped = true;
      await apollo.stop();
      wsServer.close();
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function cancelJob(data) {
  if (!data) return null;
  return data;
}

function checkStatus(data) {
  if (!data) return null;
  return data;
}

function cancelJob(data) {
  if (!data) return null;
  return data;
}

function checkStatus(data) {
  if (!data) return null;
  return data;
}