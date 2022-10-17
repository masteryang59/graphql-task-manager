import mongoose from 'mongoose';
import { badInput, conflict, notFound } from '../errors.js';
import { toComment, toTask } from '../db/dto.js';
import { PRIORITIES, STATUSES } from '../db/models.js';
import { afterFilter, cursorFor, decodeCursor, sortSpec } from '../util/cursor.js';
import { STEP, needsRebalance, positionBetween } from '../util/position.js';
import { escapeRegExp, labels as validLabels, objectId, pageSize, text } from '../util/validate.js';
import { requireProject, requireTask } from './access.js';

const oid = (id) => new mongoose.Types.ObjectId(id);
const PRIORITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };
const TASK_ORDERS = ['POSITION', 'CREATED_AT_DESC', 'UPDATED_AT_DESC', 'PRIORITY_DESC'];
const DAY = 24 * 60 * 60 * 1000;

// Queries that depend on the clock (overdue) are cached per minute.
const minuteNow = () => Math.floor(Date.now() / 60000);

function toDate(value, field) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw badInput(`${field} is not a valid date`, field);
  return d;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw badInput(`${field} must be one of ${allowed.join(', ')}`, field);
  return value;
}

// GraphQL TaskFilter -> MongoDB query. `minute` pins "now" for overdue.
export function buildTaskQuery(projectId, filter = {}, minute = minuteNow()) {
  const q = { projectId: oid(projectId) };
  if (filter.status?.length) q.status = { $in: filter.status.map((s) => oneOf(s, STATUSES, 'status')) };
  if (filter.assigneeId && filter.unassigned) throw badInput('Use either assigneeId or unassigned, not both', 'filter');
  if (filter.assigneeId) q.assigneeId = oid(objectId(filter.assigneeId, 'assigneeId'));
  if (filter.unassigned) q.assigneeId = null;
  if (filter.labels?.length) q.labels = { $in: validLabels(filter.labels) };
  if (filter.priority?.length) q.priority = { $in: filter.priority.map((p) => oneOf(p, PRIORITIES, 'priority')) };
  if (filter.dueBefore) q.dueDate = { $lt: toDate(filter.dueBefore, 'dueBefore') };
  if (filter.overdue) {
    const now = new Date(minute * 60000);
    q.dueDate = { $lt: q.dueDate ? new Date(Math.min(q.dueDate.$lt, now)) : now };
    q.status = q.status ? { $in: q.status.$in.filter((s) => s !== 'DONE') } : { $ne: 'DONE' };
  }
  if (filter.search != null) {
    const s = text(filter.search, 'search', { max: 100 });
    if (s) {
      const re = new RegExp(escapeRegExp(s), 'i');
      const ref = /^(?:[A-Z][A-Z0-9]*-)?(\d{1,9})$/i.exec(s);
      q.$or = [{ title: re }, { description: re }, ...(ref ? [{ number: Number(ref[1]) }] : [])];
    }
  }
  return q;
}

function validateFields(input, project, { partial }) {
  const set = {};
  if (!partial || input.title !== undefined) set.title = text(input.title ?? '', 'title', { min: 1, max: 200 });
  if (input.description !== undefined) set.description = input.description === null ? '' : text(input.description, 'description', { max: 10000, trim: false });
  if (input.priority != null) {
    set.priority = oneOf(input.priority, PRIORITIES, 'priority');
    set.priorityRank = PRIORITY_RANK[set.priority];
  }
  if (input.labels !== undefined) set.labels = input.labels === null ? [] : validLabels(input.labels);
  if (input.dueDate !== undefined) set.dueDate = toDate(input.dueDate, 'dueDate');
  if (input.assigneeId !== undefined) {
    if (input.assigneeId === null) set.assigneeId = null;
    else {
      objectId(input.assigneeId, 'assigneeId');
      if (!project.members.some((m) => m.userId === input.assigneeId)) throw badInput('The assignee must be a member of the project', 'assigneeId');
      set.assigneeId = oid(input.assigneeId);
    }
  }
  return set;
}

export function taskService({ models, cache, pubsub, logger }) {
  const { Task, Comment, Project } = models;

  async function lastPosition(projectId, status, excludeId) {
    const filter = { projectId: oid(projectId), status };
    if (excludeId) filter._id = { $ne: oid(excludeId) };
    const last = await Task.findOne(filter, { position: 1 }).sort({ position: -1, _id: -1 }).lean();
    return last?.position ?? null;
  }

  // Invalidate cached reads, then tell subscribers. Order matters: a client
  // that refetches on the event must not get the pre-write cache entry.
  async function afterWrite(ctx, type, { projectId, taskId, task = null }) {
    ctx.loaders.tasks.clear(taskId);
    if (task) ctx.loaders.tasks.prime(task.id, task);
    if (type !== 'COMMENTED') await cache.invalidateProject(projectId, ctx.cacheSession);
    await pubsub.publish(`project:${projectId}`, { type, projectId, taskId, actorId: ctx.viewer.id, task });
  }

  async function writeWithRev(ctx, task, expectedRev, update) {
    const filter = { _id: oid(task.id) };
    if (expectedRev != null) filter.rev = expectedRev;
    const doc = await Task.findOneAndUpdate(filter, { ...update, $inc: { rev: 1 } }, { returnDocument: 'after', runValidators: true }).lean();
    if (doc) return toTask(doc);
    const current = await Task.findById(task.id, { rev: 1 }).lean();
    if (!current) throw notFound('Task');
    throw conflict('The task was changed by someone else. Reload it and try again.', { currentRev: current.rev, expectedRev });
  }

  // Renumber a column with even gaps. Only runs when repeated moves into the
  // same spot have used up the float precision between two neighbours.
  async function rebalance(projectId, status, excludeId) {
    const docs = await Task.find({ projectId: oid(projectId), status, _id: { $ne: oid(excludeId) } }, { _id: 1 })
      .sort({ position: 1, _id: 1 })
      .lean();
    if (docs.length === 0) return;
    await Task.bulkWrite(docs.map((d, i) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { position: (i + 1) * STEP } } } })));
    logger?.info({ projectId, status, tasks: docs.length }, 'rebalanced column positions');
  }

  async function neighbours(projectId, status, taskId, afterId) {
    let anchor = null;
    if (afterId) {
      objectId(afterId, 'afterId');
      if (afterId === taskId) throw badInput('afterId cannot be the task itself', 'afterId');
      anchor = await Task.findOne({ _id: oid(afterId), projectId: oid(projectId), status }, { position: 1 }).lean();
      if (!anchor) throw badInput('afterId must be a task in the target column', 'afterId');
    }
    const filter = { projectId: oid(projectId), status, _id: { $ne: oid(taskId) } };
    if (anchor) {
      filter.$or = [{ position: { $gt: anchor.position } }, { position: anchor.position, _id: { $gt: anchor._id } }];
    }
    const next = await Task.findOne(filter, { position: 1 }).sort({ position: 1, _id: 1 }).lean();
    return { before: anchor?.position ?? null, after: next?.position ?? null };
  }

  return {
    async list(ctx, project, { filter, orderBy = 'POSITION', first, after } = {}) {
      if (!TASK_ORDERS.includes(orderBy)) throw badInput('Unknown orderBy', 'orderBy');
      const limit = pageSize(first);
      const cursorValues = after ? decodeCursor(after, orderBy) : null;
      const minute = filter?.overdue ? minuteNow() : undefined;
      const base = buildTaskQuery(project.id, filter ?? {}, minute);
      return cache.project(
        project.id,
        'tasks',
        { filter: filter ?? null, orderBy, first: limit, after: after ?? null, minute },
        async () => {
          const query = cursorValues ? { $and: [base, afterFilter(cursorValues, orderBy)] } : base;
          const [docs, totalCount] = await Promise.all([
            Task.find(query).sort(sortSpec(orderBy)).limit(limit + 1).lean(),
            Task.countDocuments(base),
          ]);
          const page = docs.slice(0, limit);
          return {
            edges: page.map((d) => ({ cursor: cursorFor(d, orderBy), node: toTask(d) })),
            pageInfo: { hasNextPage: docs.length > limit, endCursor: page.length ? cursorFor(page.at(-1), orderBy) : null },
            totalCount,
          };
        },
        { session: ctx.cacheSession, stats: ctx.cacheStats },
      );
    },

    async stats(ctx, project) {
      const minute = minuteNow();
      return cache.project(
        project.id,
        'stats',
        { minute },
        async () => {
          const now = new Date(minute * 60000);
          const [facet] = await Task.aggregate([
            { $match: { projectId: oid(project.id) } },
            {
              $facet: {
                byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
                openByAssignee: [{ $match: { status: { $ne: 'DONE' } } }, { $group: { _id: '$assigneeId', count: { $sum: 1 } } }],
                overdue: [{ $match: { status: { $ne: 'DONE' }, dueDate: { $lt: now } } }, { $count: 'n' }],
                completedLast7Days: [{ $match: { completedAt: { $gte: new Date(now - 7 * DAY) } } }, { $count: 'n' }],
              },
            },
          ]);
          const counts = new Map(facet.byStatus.map((r) => [r._id, r.count]));
          const assigned = facet.openByAssignee.filter((r) => r._id !== null);
          return {
            total: facet.byStatus.reduce((n, r) => n + r.count, 0),
            byStatus: STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 })),
            openByAssignee: assigned
              .map((r) => ({ assigneeId: String(r._id), count: r.count }))
              .sort((a, b) => b.count - a.count || a.assigneeId.localeCompare(b.assigneeId)),
            unassignedOpen: facet.openByAssignee.find((r) => r._id === null)?.count ?? 0,
            overdue: facet.overdue[0]?.n ?? 0,
            completedLast7Days: facet.completedLast7Days[0]?.n ?? 0,
            computedAt: new Date().toISOString(),
          };
        },
        { session: ctx.cacheSession, stats: ctx.cacheStats },
      );
    },

    async byNumber(ctx, project, number) {
      const doc = await Task.findOne({ projectId: oid(project.id), number }).lean();
      return toTask(doc);
    },

    async get(ctx, id) {
      return (await requireTask(ctx, id)).task;
    },

    async create(ctx, input) {
      const { project } = await requireProject(ctx, input.projectId, 'EDITOR');
      const fields = validateFields(input, project, { partial: false });
      const status = input.status ? oneOf(input.status, STATUSES, 'status') : 'TODO';
      fields.priority ??= 'MEDIUM';
      fields.priorityRank ??= PRIORITY_RANK[fields.priority];
      const seq = await Project.findByIdAndUpdate(project.id, { $inc: { taskSeq: 1 } }, { returnDocument: 'after', projection: { taskSeq: 1 } }).lean();
      const last = await lastPosition(project.id, status);
      const doc = await Task.create({
        ...fields,
        projectId: project.id,
        number: seq.taskSeq,
        status,
        position: positionBetween(last, null),
        createdBy: ctx.viewer.id,
        completedAt: status === 'DONE' ? new Date() : null,
      });
      const task = toTask(doc.toObject());
      await afterWrite(ctx, 'CREATED', { projectId: task.projectId, taskId: task.id, task });
      return task;
    },

    async update(ctx, { id, input, expectedRev }) {
      const { task, project } = await requireTask(ctx, id, 'EDITOR');
      const set = validateFields(input, project, { partial: true });
      if (input.status != null && input.status !== task.status) {
        set.status = oneOf(input.status, STATUSES, 'status');
        set.position = positionBetween(await lastPosition(project.id, set.status, task.id), null);
        set.completedAt = set.status === 'DONE' ? new Date() : null;
      }
      if (Object.keys(set).length === 0) return task;
      const updated = await writeWithRev(ctx, task, expectedRev, { $set: set });
      await afterWrite(ctx, 'UPDATED', { projectId: updated.projectId, taskId: updated.id, task: updated });
      return updated;
    },

    async move(ctx, { id, status, afterId, expectedRev }) {
      const { task, project } = await requireTask(ctx, id, 'EDITOR');
      const target = status ? oneOf(status, STATUSES, 'status') : task.status;
      let { before, after } = await neighbours(project.id, target, task.id, afterId);
      if (needsRebalance(before, after)) {
        await rebalance(project.id, target, task.id);
        ({ before, after } = await neighbours(project.id, target, task.id, afterId));
      }
      const set = { status: target, position: positionBetween(before, after) };
      if (target !== task.status) set.completedAt = target === 'DONE' ? new Date() : null;
      const moved = await writeWithRev(ctx, task, expectedRev, { $set: set });
      await afterWrite(ctx, 'MOVED', { projectId: moved.projectId, taskId: moved.id, task: moved });
      return moved;
    },

    async remove(ctx, { id }) {
      const { task } = await requireTask(ctx, id, 'EDITOR');
      const { deletedCount } = await Task.deleteOne({ _id: oid(task.id) });
      if (!deletedCount) throw notFound('Task');
      await Comment.deleteMany({ taskId: oid(task.id) });
      await afterWrite(ctx, 'DELETED', { projectId: task.projectId, taskId: task.id });
      return { id: task.id, projectId: task.projectId };
    },

    async addComment(ctx, { taskId, body }) {
      const { task } = await requireTask(ctx, taskId, 'EDITOR');
      const doc = await Comment.create({ taskId: task.id, projectId: task.projectId, authorId: ctx.viewer.id, body: text(body, 'body', { min: 1, max: 5000 }) });
      ctx.loaders.commentCounts.clear(task.id);
      await afterWrite(ctx, 'COMMENTED', { projectId: task.projectId, taskId: task.id, task });
      return toComment(doc.toObject());
    },

    async comments(ctx, task, { first, after }) {
      const limit = pageSize(first, { fallback: 20, max: 50 });
      const base = { taskId: oid(task.id) };
      const query = after ? { $and: [base, afterFilter(decodeCursor(after, 'COMMENTS'), 'COMMENTS')] } : base;
      const docs = await Comment.find(query).sort(sortSpec('COMMENTS')).limit(limit + 1).lean();
      const page = docs.slice(0, limit);
      return {
        edges: page.map((d) => ({ cursor: cursorFor(d, 'COMMENTS'), node: toComment(d) })),
        pageInfo: { hasNextPage: docs.length > limit, endCursor: page.length ? cursorFor(page.at(-1), 'COMMENTS') : null },
        totalCount: () => ctx.loaders.commentCounts.load(task.id),
      };
    },
  };
}

function warmCache(data) {
  if (!data) return null;
  return data;
}

function warmCache(data) {
  if (!data) return null;
  return data;
}