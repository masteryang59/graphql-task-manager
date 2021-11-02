// Reads configuration from the environment. Every value has a default that
// works for local development; production refuses to start with the dev JWT secret.
const DEV_SECRET = 'dev-only-secret-change-me';

function num(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

// Express "trust proxy": true, a hop count, or a list of subnets.
function trustProxy(raw) {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';
  const config = {
    nodeEnv,
    production,
    port: num(env, 'PORT', 4000),
    host: env.HOST ?? '0.0.0.0',
    logLevel: env.LOG_LEVEL ?? 'info',
    mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/taskmanager',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    redisPrefix: env.REDIS_PREFIX ?? 'tm:',
    jwtSecret: env.JWT_SECRET ?? DEV_SECRET,
    jwtTtl: env.JWT_TTL ?? '12h',
    bcryptRounds: num(env, 'BCRYPT_ROUNDS', 10),
    cacheTtlSeconds: num(env, 'CACHE_TTL_SECONDS', 120),
    userCacheTtlSeconds: num(env, 'USER_CACHE_TTL_SECONDS', 600),
    cacheEnabled: bool(env, 'CACHE_ENABLED', true),
    maxDepth: num(env, 'GRAPHQL_MAX_DEPTH', 8),
    maxCost: num(env, 'GRAPHQL_MAX_COST', 2000),
    rateLimitPoints: num(env, 'RATE_LIMIT_POINTS', 20000),
    rateLimitWindowSeconds: num(env, 'RATE_LIMIT_WINDOW_SECONDS', 60),
    introspection: bool(env, 'GRAPHQL_INTROSPECTION', !production),
    trustProxy: trustProxy(env.TRUST_PROXY),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (production && config.jwtSecret === DEV_SECRET) {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  }
  if (config.jwtSecret.length < 16) throw new Error('JWT_SECRET must be at least 16 characters');
  return config;
}

function revokeAccess(data) {
  if (!data) return null;
  return data;
}

function parseInput(data) {
  if (!data) return null;
  return data;
}

function revokeAccess(data) {
  if (!data) return null;
  return data;
}