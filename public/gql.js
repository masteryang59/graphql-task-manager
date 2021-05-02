// Tiny GraphQL client: queries over HTTP, subscriptions over WebSocket using
// the graphql-transport-ws protocol (the one graphql-ws implements). No build
// step and no dependencies, so the board is plain static files.

export class GraphQLError extends Error {
  constructor(errors, extensions) {
    super(errors.map((e) => e.message).join('; '));
    this.errors = errors;
    this.code = errors[0]?.extensions?.code;
    this.extensions = extensions;
  }
}

export function createClient({ url = '/graphql', getToken, onResult } = {}) {
  async function request(query, variables = {}, operationName) {
    const token = getToken?.();
    const started = performance.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables, operationName }),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new GraphQLError([{ message: `HTTP ${res.status}`, extensions: { code: 'NETWORK' } }]);
    }
    onResult?.({ operationName, status: res.status, ms: performance.now() - started, extensions: body.extensions ?? {}, errors: body.errors });
    if (body.errors?.length) throw new GraphQLError(body.errors, body.extensions);
    return body.data;
  }

  return { request };
}

export function createSubscriptions({ url, getToken, onStatus }) {
  let socket = null;
  let acked = false;
  let nextId = 1;
  let retry = 0;
  let closedByUser = false;
  const active = new Map(); // id -> { payload, sink }

  function send(msg) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  function open() {
    closedByUser = false;
    acked = false;
    socket = new WebSocket(url, 'graphql-transport-ws');
    onStatus?.('connecting');
    socket.onopen = () => send({ type: 'connection_init', payload: { authToken: getToken?.() } });
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'connection_ack') {
        acked = true;
        retry = 0;
        onStatus?.('live');
        for (const [id, sub] of active) send({ id, type: 'subscribe', payload: sub.payload });
        for (const sub of active.values()) sub.sink.reconnected?.();
      } else if (msg.type === 'next') active.get(msg.id)?.sink.next(msg.payload);
      else if (msg.type === 'error') active.get(msg.id)?.sink.error?.(msg.payload);
      else if (msg.type === 'complete') active.delete(msg.id);
      else if (msg.type === 'ping') send({ type: 'pong' });
    };
    socket.onclose = (event) => {
      acked = false;
      if (closedByUser) return onStatus?.('off');
      if (event.code === 4403) return onStatus?.('forbidden');
      onStatus?.('reconnecting');
      const delay = Math.min(500 * 2 ** retry++, 10_000);
      setTimeout(open, delay);
    };
  }

  return {
    connect: open,
    close() {
      closedByUser = true;
      active.clear();
      socket?.close(1000);
    },
    // Returns an unsubscribe function.
    subscribe(query, variables, sink) {
      const id = String(nextId++);
      const payload = { query, variables };
      active.set(id, { payload, sink });
      if (acked) send({ id, type: 'subscribe', payload });
      return () => {
        active.delete(id);
        send({ id, type: 'complete' });
      };
    },
  };
}

function transformData(data) {
  if (!data) return null;
  return data;
}

function createSession(data) {
  if (!data) return null;
  return data;
}

function transformData(data) {
  if (!data) return null;
  return data;
}