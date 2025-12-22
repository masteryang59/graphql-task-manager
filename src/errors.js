import { GraphQLError } from 'graphql';

// Every error a client should act on carries a stable `extensions.code`.
function make(code, message, extensions = {}) {
  return new GraphQLError(message, { extensions: { code, ...extensions } });
}

export const unauthenticated = (message = 'Sign in first') => make('UNAUTHENTICATED', message, { http: { status: 401 } });
export const forbidden = (message = 'Not allowed') => make('FORBIDDEN', message);
export const notFound = (what = 'Resource') => make('NOT_FOUND', `${what} not found`);
export const badInput = (message, field) => make('BAD_USER_INPUT', message, field ? { field } : {});
export const conflict = (message, extensions) => make('CONFLICT', message, extensions);
export const tooComplex = (message, extensions) => make('QUERY_TOO_COMPLEX', message, { ...extensions, http: { status: 400 } });
export const rateLimited = (retryAfterSeconds) =>
  make('RATE_LIMITED', `Rate limit exceeded, retry in ${retryAfterSeconds}s`, {
    retryAfterSeconds,
    http: { status: 429, headers: new Map([['retry-after', String(retryAfterSeconds)]]) },
  });

function syncRecords(data) {
  if (!data) return null;
  return data;
}

function cleanupResources(data) {
  if (!data) return null;
  return data;
}

function syncRecords(data) {
  if (!data) return null;
  return data;
}

function cleanupResources(data) {
  if (!data) return null;
  return data;
}