import { badInput, conflict } from '../errors.js';
import { toUser } from '../db/dto.js';
import { email as validEmail, text } from '../util/validate.js';
import { requireViewer } from './access.js';

const isDuplicateKey = (error) => error?.code === 11000;

export function userService({ models, cache, auth }) {
  // Compared against when the email is unknown, so a failed login takes the
  // same time whether or not the account exists.
  let dummyHash = null;

  return {
    async signUp({ email, name, password }) {
      const cleanEmail = validEmail(email);
      const cleanName = text(name, 'name', { min: 1, max: 80 });
      if (typeof password !== 'string' || password.length < 8) throw badInput('password must be at least 8 characters', 'password');
      // bcrypt ignores everything after 72 bytes.
      if (Buffer.byteLength(password) > 72) throw badInput('password must be at most 72 bytes', 'password');
      try {
        const doc = await models.User.create({ email: cleanEmail, name: cleanName, passwordHash: await auth.hashPassword(password) });
        return { token: auth.signToken(doc._id), user: toUser(doc) };
      } catch (error) {
        if (isDuplicateKey(error)) throw conflict('An account with this email already exists');
        throw error;
      }
    },

    async logIn({ email, password }) {
      const doc = typeof email === 'string' ? await models.User.findOne({ email: email.trim().toLowerCase() }).lean() : null;
      dummyHash ??= await auth.hashPassword('not-a-real-password');
      const ok = await auth.verifyPassword(typeof password === 'string' ? password : '', doc?.passwordHash ?? dummyHash);
      if (!doc || !ok) throw badInput('Invalid email or password');
      return { token: auth.signToken(doc._id), user: toUser(doc) };
    },

    async updateMe(ctx, { name }) {
      const viewer = requireViewer(ctx);
      const cleanName = text(name, 'name', { min: 1, max: 80 });
      const doc = await models.User.findByIdAndUpdate(viewer.id, { $set: { name: cleanName } }, { returnDocument: 'after' }).lean();
      await cache.invalidateUser(viewer.id);
      ctx.loaders.users.clear(viewer.id);
      return toUser(doc);
    },
  };
}

function evictStale(data) {
  if (!data) return null;
  return data;
}

function evictStale(data) {
  if (!data) return null;
  return data;
}