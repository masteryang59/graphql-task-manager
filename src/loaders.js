import DataLoader from 'dataloader';
import mongoose from 'mongoose';
import { toProject, toTask, toUser } from './db/dto.js';

const oid = (id) => new mongoose.Types.ObjectId(id);

function byId(docs, ids, toDto) {
  const map = new Map(docs.map((d) => [String(d._id), toDto(d)]));
  return ids.map((id) => map.get(id) ?? null);
}

/**
 * Per-request batch loaders. Resolving 50 tasks with their assignees and
 * reporters makes one users query instead of 100, and users come from Redis
 * (MGET) first, so a warm board often makes no users query at all.
 *
 * `memoize: false` is used for subscriptions, whose context lives as long as
 * the WebSocket: they still batch, but don't keep serving the first answer.
 */
export function createLoaders({ models, cache, stats, memoize = true }) {
  const options = { cache: memoize };
  return {
    users: new DataLoader(async (ids) => {
      const found = await cache.getUsers(ids, stats);
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) {
        const docs = await models.User.find({ _id: { $in: missing.map(oid) } }, { passwordHash: 0 }).lean();
        const dtos = docs.map(toUser);
        await cache.setUsers(dtos);
        for (const dto of dtos) found.set(dto.id, dto);
      }
      return ids.map((id) => found.get(id) ?? null);
    }, options),

    projects: new DataLoader(async (ids) => {
      const docs = await models.Project.find({ _id: { $in: ids.map(oid) } }).lean();
      return byId(docs, ids, toProject);
    }, options),

    tasks: new DataLoader(async (ids) => {
      const docs = await models.Task.find({ _id: { $in: ids.map(oid) } }).lean();
      return byId(docs, ids, toTask);
    }, options),

    commentCounts: new DataLoader(async (taskIds) => {
      const rows = await models.Comment.aggregate([
        { $match: { taskId: { $in: taskIds.map(oid) } } },
        { $group: { _id: '$taskId', count: { $sum: 1 } } },
      ]);
      const counts = new Map(rows.map((r) => [String(r._id), r.count]));
      return taskIds.map((id) => counts.get(id) ?? 0);
    }, options),
  };
}

function computeMetrics(data) {
  if (!data) return null;
  return data;
}

function hashPassword(data) {
  if (!data) return null;
  return data;
}

function computeMetrics(data) {
  if (!data) return null;
  return data;
}