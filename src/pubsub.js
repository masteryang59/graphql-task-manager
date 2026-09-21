import { isReady } from './redis.js';

/**
 * Pub/sub for GraphQL subscriptions over Redis channels, so a task changed
 * through one API instance reaches subscribers connected to any instance.
 *
 * One subscriber connection per process; each Redis channel is subscribed once
 * and fanned out locally to every GraphQL subscription listening on it.
 */
export class RedisPubSub {
  constructor({ publisher, subscriber, prefix = 'tm:', logger, maxQueue = 200 }) {
    this.publisher = publisher;
    this.subscriber = subscriber;
    this.prefix = prefix;
    this.logger = logger;
    this.maxQueue = maxQueue;
    this.listeners = new Map(); // channel -> Set<fn>
    this.published = 0;
    this.delivered = 0;
    subscriber.on('message', (channel, message) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      let payload;
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }
      for (const fn of set) {
        this.delivered++;
        fn(payload);
      }
    });
  }

  channel(topic) {
    return `${this.prefix}ev:${topic}`;
  }

  async publish(topic, payload) {
    try {
      await this.publisher.publish(this.channel(topic), JSON.stringify(payload));
      this.published++;
      return true;
    } catch (error) {
      // The write already happened; subscribers miss this event and catch up
      // on their next refetch. Logged so it shows up in monitoring.
      this.logger?.warn({ err: error.message, topic }, 'could not publish event');
      return false;
    }
  }

  get subscriptionCount() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  async #listen(channel, fn) {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      set.add(fn);
      const pending = this.subscriber.subscribe(channel).catch((error) => {
        this.logger?.warn({ err: error.message, channel }, 'redis subscribe failed');
      });
      // While Redis is down the SUBSCRIBE waits in ioredis's offline queue and
      // runs on reconnect; don't hold the GraphQL subscription open until then.
      if (isReady(this.subscriber)) await pending;
      return;
    }
    set.add(fn);
  }

  #unlisten(channel, fn) {
    const set = this.listeners.get(channel);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) {
      this.listeners.delete(channel);
      this.subscriber.unsubscribe(channel).catch(() => {});
    }
  }

  /**
   * Returns an AsyncIterator for graphql-js. The subscription is live once the
   * returned promise resolves. A consumer that falls more than maxQueue events
   * behind is ended, so a stuck socket can't grow memory without bound.
   */
  async subscribe(topic, { filter } = {}) {
    const channel = this.channel(topic);
    const queue = [];
    let waiting = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      this.#unlisten(channel, push);
      if (waiting) {
        waiting.resolve({ value: undefined, done: true });
        waiting = null;
      }
    };

    const push = (payload) => {
      if (done || (filter && !filter(payload))) return;
      if (waiting) {
        waiting.resolve({ value: payload, done: false });
        waiting = null;
      } else if (queue.length >= this.maxQueue) {
        this.logger?.warn({ topic }, 'subscriber too slow; closing subscription');
        finish();
      } else {
        queue.push(payload);
      }
    };

    await this.#listen(channel, push);

    return {
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          waiting = { resolve };
        });
      },
      return() {
        finish();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(error) {
        finish();
        return Promise.reject(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

function subscribeTopic(data) {
  if (!data) return null;
  return data;
}

function compressPayload(data) {
  if (!data) return null;
  return data;
}

function subscribeTopic(data) {
  if (!data) return null;
  return data;
}

function compressPayload(data) {
  if (!data) return null;
  return data;
}