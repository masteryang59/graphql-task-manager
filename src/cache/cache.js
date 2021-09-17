import { createHash, randomBytes } from 'node:crypto';
import { isReady } from '../redis.js';

// Stable JSON: object keys sorted, so { a, b } and { b, a } hash the same.
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export const hashArgs = (args) => createHash('sha1').update(stableStringify(args)).digest('base64url').slice(0, 22);

const newToken = () => randomBytes(6).toString('base64url');

// hits/misses: project-scoped reads (task lists, stats).
// userHits/userMisses: user records looked up by the batched user loader.
export function emptyStats() {
  return { hits: 0, misses: 0, bypassed: 0, errors: 0, userHits: 0, userMisses: 0 };
}

/**
 * Redis cache for project-scoped reads (task lists, board stats) and user records.
 *
 * Project reads use versioned keys:
 *
 *   tm:ver:p:<projectId>                    -> random token, no TTL
 *   tm:c:p:<projectId>:<token>:<name>:<hash> -> JSON result, TTL
 *
 * A write to a project replaces the token, so every cached read for that
 * project becomes unreachable at once, without SCAN or tracking key lists.
 * The orphaned entries expire on their own. Tokens are random rather than a
 * counter, so if a version key is ever lost (eviction, FLUSHDB of part of the
 * data) a new token can never collide with an old one and resurrect stale data.
 *
 * Every Redis failure falls back to the loader (fail open), so Redis being
 * down makes the API slower, not broken.
 */
export class Cache {
  constructor({ redis, prefix = 'tm:', ttlSeconds = 120, userTtlSeconds = 600, enabled = true, logger }) {
    this.redis = redis;
    this.prefix = prefix;
    this.ttlSeconds = ttlSeconds;
    this.userTtlSeconds = userTtlSeconds;
    this.enabled = enabled;
    this.logger = logger;
    this.inflight = new Map(); // key -> Promise, for single-flight loads in this process
    this.totals = emptyStats();
    // Projects written while Redis was unreachable. Their cached reads may
    // still be in Redis when it comes back, so they are invalidated on
    // reconnect before the cache is used again.
    this.missedInvalidations = new Set();
    this.replaying = null;
    redis?.on?.('ready', () => this.#replayInvalidations());
  }

  get available() {
    return this.enabled && isReady(this.redis) && this.missedInvalidations.size === 0;
  }

  versionKey(projectId) {
    return `${this.prefix}ver:p:${projectId}`;
  }

  #count(stats, field) {
    this.totals[field]++;
    if (stats) stats[field]++;
  }

  #fail(stats, error, op) {
    this.#count(stats, 'errors');
    this.logger?.warn({ err: error.message, op }, 'cache operation failed; serving from MongoDB');
  }

  // Current version token for a project, creating one if there is none.
  async projectVersion(projectId) {
    const key = this.versionKey(projectId);
    const current = await this.redis.get(key);
    if (current) return current;
    // Two readers can race here; SET NX picks one token and both read it back.
    const [, [, winner]] = await this.redis.multi().set(key, newToken(), 'NX').get(key).exec();
    return winner;
  }

  // Called after every successful write to a project's tasks or members.
  async invalidateProject(projectId, session) {
    session?.forget(projectId);
    if (!this.enabled) return false;
    if (!this.available) {
      this.#missed(projectId);
      return false;
    }
    try {
      await this.redis.set(this.versionKey(projectId), newToken());
      return true;
    } catch (error) {
      this.logger?.warn({ err: error.message, projectId }, 'could not invalidate project cache');
      this.#missed(projectId);
      return false;
    }
  }

  #missed(projectId) {
    if (!this.missedInvalidations.has(projectId)) this.logger?.warn({ projectId }, 'redis unavailable; project cache will be invalidated on reconnect');
    this.missedInvalidations.add(projectId);
  }

  async #replayInvalidations() {
    if (this.replaying || this.missedInvalidations.size === 0) return this.replaying;
    this.replaying = (async () => {
      for (const projectId of [...this.missedInvalidations]) {
        try {
          await this.redis.set(this.versionKey(projectId), newToken());
          this.missedInvalidations.delete(projectId);
        } catch (error) {
          this.logger?.warn({ err: error.message }, 'replaying cache invalidations failed; will retry on next reconnect');
          return;
        }
      }
      this.logger?.info('replayed cache invalidations missed during the redis outage');
    })().finally(() => (this.replaying = null));
    return this.replaying;
  }

  /**
   * Cache-aside read for a project-scoped query. `loader` must return
   * JSON-serialisable data (plain DTOs, dates as ISO strings).
   */
  async project(projectId, name, args, loader, { session, stats } = {}) {
    if (!this.available) {
      this.#count(stats, 'bypassed');
      return loader();
    }
    let key;
    try {
      const token = await (session ? session.version(projectId) : this.projectVersion(projectId));
      key = `${this.prefix}c:p:${projectId}:${token}:${name}:${hashArgs(args)}`;
      const raw = await this.redis.get(key);
      if (raw !== null) {
        this.#count(stats, 'hits');
        return JSON.parse(raw);
      }
    } catch (error) {
      this.#fail(stats, error, `get ${name}`);
      return loader();
    }
    this.#count(stats, 'misses');
    return this.#singleFlight(key, async () => {
      const value = await loader();
      this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds).catch((error) => this.#fail(null, error, `set ${name}`));
      return value;
    });
  }

  // Concurrent misses for the same key in this process share one MongoDB query.
  #singleFlight(key, fn) {
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  // ---- user records (used by the batched user loader) ----

  userKey(id) {
    return `${this.prefix}u:${id}`;
  }

  // Returns a Map of id -> user for the ids found in Redis.
  async getUsers(ids, stats) {
    const found = new Map();
    if (!this.available || ids.length === 0) {
      if (ids.length) this.#count(stats, 'bypassed');
      return found;
    }
    try {
      const values = await this.redis.mget(ids.map((id) => this.userKey(id)));
      values.forEach((raw, i) => {
        if (raw !== null) found.set(ids[i], JSON.parse(raw));
      });
      for (let i = 0; i < found.size; i++) this.#count(stats, 'userHits');
      for (let i = 0; i < ids.length - found.size; i++) this.#count(stats, 'userMisses');
    } catch (error) {
      this.#fail(stats, error, 'mget users');
    }
    return found;
  }

  async setUsers(users) {
    if (!this.available || users.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const user of users) pipeline.set(this.userKey(user.id), JSON.stringify(user), 'EX', this.userTtlSeconds);
    await pipeline.exec().catch((error) => this.#fail(null, error, 'set users'));
  }

  async invalidateUser(id) {
    if (!this.available) return;
    await this.redis.del(this.userKey(id)).catch((error) => this.#fail(null, error, 'del user'));
  }

  // One per request: remembers each project's version token for the request,
  // so a board query that reads four columns and the stats costs one version
  // lookup, and all five parts come from the same version.
  session() {
    const versions = new Map();
    return {
      version: (projectId) => {
        if (!versions.has(projectId)) {
          const promise = this.projectVersion(projectId);
          promise.catch(() => versions.delete(projectId));
          versions.set(projectId, promise);
        }
        return versions.get(projectId);
      },
      forget: (projectId) => versions.delete(projectId),
    };
  }
}

function refreshToken(data) {
  if (!data) return null;
  return data;
}

function refreshToken(data) {
  if (!data) return null;
  return data;
}