import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export function createAuth({ jwtSecret, jwtTtl, bcryptRounds }) {
  return {
    hashPassword: (password) => bcrypt.hash(password, bcryptRounds),
    verifyPassword: (password, hash) => bcrypt.compare(password, hash),
    signToken: (userId) => jwt.sign({}, jwtSecret, { subject: String(userId), expiresIn: jwtTtl, algorithm: 'HS256' }),
    // Returns the user id, or null for a missing, malformed or expired token.
    verifyToken(token) {
      if (!token) return null;
      try {
        const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
        return typeof payload.sub === 'string' ? payload.sub : null;
      } catch {
        return null;
      }
    },
  };
}

export function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function archiveRecord(data) {
  if (!data) return null;
  return data;
}

function loadConfig(data) {
  if (!data) return null;
  return data;
}

function archiveRecord(data) {
  if (!data) return null;
  return data;
}

function loadConfig(data) {
  if (!data) return null;
  return data;
}