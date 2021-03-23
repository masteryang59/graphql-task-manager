// A small Redis-compatible server for local development and tests on machines
// without Redis or Docker. It speaks RESP2 over TCP, so the app talks to it
// with the real ioredis client, exactly as it talks to Redis in production.
//
// It implements only the commands this project uses (strings, TTLs, counters,
// MULTI/EXEC, pub/sub) plus what ioredis sends on connect. It is single-process
// and in-memory. Use real Redis anywhere else: REDIS_URL=redis://host:6379.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OK = '+OK\r\n';
const NIL = '$-1\r\n';

function bulk(value) {
  if (value === null || value === undefined) return NIL;
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([Buffer.from(`$${buf.length}\r\n`), buf, Buffer.from('\r\n')]);
}
const int = (n) => `:${n}\r\n`;
const err = (msg) => `-${msg}\r\n`;
function array(items) {
  if (items === null) return '*-1\r\n';
  const parts = [Buffer.from(`*${items.length}\r\n`)];
  for (const item of items) {
    const encoded = typeof item === 'number' ? int(item) : bulk(item);
    parts.push(Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded));
  }
  return Buffer.concat(parts);
}

// Parses as many complete commands as the buffer holds. Returns
// { commands, rest }, where rest is the unconsumed tail.
export function parseCommands(buffer) {
  const commands = [];
  let pos = 0;
  while (pos < buffer.length) {
    if (buffer[pos] !== 0x2a /* '*' */) {
      // Inline command (what telnet or `redis-cli` in some modes sends).
      const end = buffer.indexOf('\r\n', pos);
      if (end === -1) break;
      const line = buffer.subarray(pos, end).toString().trim();
      pos = end + 2;
      if (line) commands.push(line.split(/\s+/).map((s) => Buffer.from(s)));
      continue;
    }
    const headerEnd = buffer.indexOf('\r\n', pos);
    if (headerEnd === -1) break;
    const count = Number(buffer.subarray(pos + 1, headerEnd).toString());
    let cursor = headerEnd + 2;
    const args = [];
    let complete = true;
    for (let i = 0; i < count; i++) {
      if (cursor >= buffer.length || buffer[cursor] !== 0x24 /* '$' */) { complete = false; break; }
      const lenEnd = buffer.indexOf('\r\n', cursor);
      if (lenEnd === -1) { complete = false; break; }
      const len = Number(buffer.subarray(cursor + 1, lenEnd).toString());
      const start = lenEnd + 2;
      if (start + len + 2 > buffer.length) { complete = false; break; }
      args.push(buffer.subarray(start, start + len));
      cursor = start + len + 2;
    }
    if (!complete) break;
    commands.push(args);
    pos = cursor;
  }
  return { commands, rest: buffer.subarray(pos) };
}

function globToRegExp(glob) {
  let source = '';
  for (const ch of glob) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export class MiniRedis {
  constructor() {
    this.data = new Map(); // key -> Buffer
    this.expires = new Map(); // key -> epoch ms
    this.channels = new Map(); // channel -> Set<Client>
    this.clients = new Set();
    this.server = null;
    this.commandCount = 0;
    this.sweeper = null;
  }

  async start(port = 0, host = '127.0.0.1') {
    this.server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this.host = host;
    this.sweeper = setInterval(() => this.#sweep(), 1000);
    this.sweeper.unref();
    return this;
  }

  get url() {
    return `redis://${this.host}:${this.port}`;
  }

  // Closes the listener and drops every connection, like a crashed server.
  async stop() {
    clearInterval(this.sweeper);
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    this.channels.clear();
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }

  flush() {
    this.data.clear();
    this.expires.clear();
  }

  #accept(socket) {
    socket.setNoDelay(true);
    const client = { socket, buffer: Buffer.alloc(0), subscriptions: new Set(), multi: null };
    this.clients.add(client);
    socket.on('data', (chunk) => {
      client.buffer = client.buffer.length ? Buffer.concat([client.buffer, chunk]) : chunk;
      const { commands, rest } = parseCommands(client.buffer);
      client.buffer = Buffer.from(rest);
      for (const args of commands) this.#dispatch(client, args);
    });
    const drop = () => {
      this.clients.delete(client);
      for (const channel of client.subscriptions) this.channels.get(channel)?.delete(client);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  #write(client, reply) {
    if (!client.socket.destroyed) client.socket.write(reply);
  }

  #dispatch(client, args) {
    if (args.length === 0) return;
    const name = args[0].toString().toUpperCase();
    this.commandCount++;

    if (client.subscriptions.size > 0 && !['SUBSCRIBE', 'UNSUBSCRIBE', 'PING', 'QUIT'].includes(name)) {
      this.#write(client, err(`ERR Can't execute '${name.toLowerCase()}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT are allowed in this context`));
      return;
    }

    if (client.multi && !['EXEC', 'DISCARD', 'MULTI'].includes(name)) {
      client.multi.push(args);
      this.#write(client, '+QUEUED\r\n');
      return;
    }

    switch (name) {
      case 'MULTI':
        if (client.multi) return this.#write(client, err('ERR MULTI calls can not be nested'));
        client.multi = [];
        return this.#write(client, OK);
      case 'DISCARD':
        if (!client.multi) return this.#write(client, err('ERR DISCARD without MULTI'));
        client.multi = null;
        return this.#write(client, OK);
      case 'EXEC': {
        if (!client.multi) return this.#write(client, err('ERR EXEC without MULTI'));
        const queued = client.multi;
        client.multi = null;
        const replies = queued.map((cmd) => this.#run(client, cmd[0].toString().toUpperCase(), cmd.slice(1)));
        const parts = [Buffer.from(`*${replies.length}\r\n`)];
        for (const r of replies) parts.push(Buffer.isBuffer(r) ? r : Buffer.from(r));
        return this.#write(client, Buffer.concat(parts));
      }
      case 'SUBSCRIBE':
        for (const raw of args.slice(1)) {
          const channel = raw.toString();
          client.subscriptions.add(channel);
          if (!this.channels.has(channel)) this.channels.set(channel, new Set());
          this.channels.get(channel).add(client);
          this.#write(client, array(['subscribe', channel, client.subscriptions.size]));
        }
        return;
      case 'UNSUBSCRIBE': {
        const targets = args.length > 1 ? args.slice(1).map(String) : [...client.subscriptions];
        if (targets.length === 0) return this.#write(client, array(['unsubscribe', null, 0]));
        for (const channel of targets) {
          client.subscriptions.delete(channel);
          this.channels.get(channel)?.delete(client);
          this.#write(client, array(['unsubscribe', channel, client.subscriptions.size]));
        }
        return;
      }
      case 'PING':
        if (client.subscriptions.size > 0) return this.#write(client, array(['pong', args[1] ?? '']));
        return this.#write(client, args[1] ? bulk(args[1]) : '+PONG\r\n');
      case 'QUIT':
        this.#write(client, OK);
        client.socket.end();
        return;
      default:
        return this.#write(client, this.#run(client, name, args.slice(1)));
    }
  }

  #alive(key) {
    const at = this.expires.get(key);
    if (at !== undefined && at <= Date.now()) {
      this.data.delete(key);
      this.expires.delete(key);
      return false;
    }
    return this.data.has(key);
  }

  #sweep() {
    const now = Date.now();
    for (const [key, at] of this.expires) {
      if (at <= now) {
        this.data.delete(key);
        this.expires.delete(key);
      }
    }
  }

  #get(key) {
    return this.#alive(key) ? this.data.get(key) : null;
  }

  #incrBy(key, by) {
    const current = this.#get(key);
    const n = current === null ? 0 : Number(current.toString());
    if (!Number.isInteger(n)) return err('ERR value is not an integer or out of range');
    const next = n + by;
    this.data.set(key, Buffer.from(String(next)));
    return int(next);
  }

  #expire(key, ms, flag) {
    if (!this.#alive(key)) return int(0);
    const has = this.expires.has(key);
    if (flag === 'NX' && has) return int(0);
    if (flag === 'XX' && !has) return int(0);
    this.expires.set(key, Date.now() + ms);
    return int(1);
  }

  #run(client, name, a) {
    const s = (i) => a[i]?.toString();
    switch (name) {
      case 'ECHO':
        return bulk(a[0]);
      case 'INFO':
        return bulk('# Server\r\nredis_version:7.4.0\r\nredis_mode:standalone\r\nmini_redis:1\r\n# Persistence\r\nloading:0\r\n');
      case 'CLIENT':
      case 'SELECT':
        return OK;
      case 'GET':
        return bulk(this.#get(s(0)));
      case 'MGET':
        return array(a.map((k) => this.#get(k.toString())));
      case 'SET': {
        const key = s(0);
        let ttl = null;
        let nx = false;
        let xx = false;
        let get = false;
        let keepTtl = false;
        for (let i = 2; i < a.length; i++) {
          const opt = s(i).toUpperCase();
          if (opt === 'EX') ttl = Number(s(++i)) * 1000;
          else if (opt === 'PX') ttl = Number(s(++i));
          else if (opt === 'NX') nx = true;
          else if (opt === 'XX') xx = true;
          else if (opt === 'GET') get = true;
          else if (opt === 'KEEPTTL') keepTtl = true;
          else return err('ERR syntax error');
        }
        if (ttl !== null && !(ttl > 0)) return err("ERR invalid expire time in 'set' command");
        const previous = this.#get(key);
        const exists = previous !== null;
        if ((nx && exists) || (xx && !exists)) return get ? bulk(previous) : NIL;
        this.data.set(key, Buffer.from(a[1]));
        if (ttl !== null) this.expires.set(key, Date.now() + ttl);
        else if (!keepTtl) this.expires.delete(key);
        return get ? bulk(previous) : OK;
      }
      case 'DEL': {
        let removed = 0;
        for (const k of a) {
          const key = k.toString();
          if (this.#alive(key)) removed++;
          this.data.delete(key);
          this.expires.delete(key);
        }
        return int(removed);
      }
      case 'EXISTS':
        return int(a.filter((k) => this.#alive(k.toString())).length);
      case 'INCR':
        return this.#incrBy(s(0), 1);
      case 'DECR':
        return this.#incrBy(s(0), -1);
      case 'INCRBY':
        return this.#incrBy(s(0), Number(s(1)));
      case 'EXPIRE':
        return this.#expire(s(0), Number(s(1)) * 1000, s(2)?.toUpperCase());
      case 'PEXPIRE':
        return this.#expire(s(0), Number(s(1)), s(2)?.toUpperCase());
      case 'TTL':
      case 'PTTL': {
        const key = s(0);
        if (!this.#alive(key)) return int(-2);
        const at = this.expires.get(key);
        if (at === undefined) return int(-1);
        const ms = at - Date.now();
        return int(name === 'TTL' ? Math.ceil(ms / 1000) : ms);
      }
      case 'KEYS': {
        const re = globToRegExp(s(0));
        return array([...this.data.keys()].filter((k) => this.#alive(k) && re.test(k)));
      }
      case 'DBSIZE':
        return int([...this.data.keys()].filter((k) => this.#alive(k)).length);
      case 'FLUSHALL':
      case 'FLUSHDB':
        this.flush();
        return OK;
      case 'PUBLISH': {
        const channel = s(0);
        const subscribers = this.channels.get(channel);
        if (!subscribers) return int(0);
        const message = array(['message', channel, a[1]]);
        for (const sub of subscribers) this.#write(sub, message);
        return int(subscribers.size);
      }
      default:
        return err(`ERR unknown command '${name.toLowerCase()}'`);
    }
  }
}

// `node devtools/mini-redis.js [port]` runs it standalone.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.MINI_REDIS_PORT ?? 6379);
  const server = await new MiniRedis().start(port);
  console.log(`mini-redis listening on ${server.url}`);
}

function encodeToken(data) {
  if (!data) return null;
  return data;
}

function measureLatency(data) {
  if (!data) return null;
  return data;
}

function encodeToken(data) {
  if (!data) return null;
  return data;
}