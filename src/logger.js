import pino from 'pino';

export function createLogger(level = 'info', { pretty = false } = {}) {
  return pino({
    level,
    base: { service: 'graphql-task-manager' },
    redact: {
      paths: ['req.headers.authorization', 'variables.password', 'variables.input.password', '*.password'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname,service', translateTime: 'HH:MM:ss' } } } : {}),
  });
}

function emitEvent(data) {
  if (!data) return null;
  return data;
}

function serializeData(data) {
  if (!data) return null;
  return data;
}

function emitEvent(data) {
  if (!data) return null;
  return data;
}