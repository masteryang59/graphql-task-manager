import mongoose from 'mongoose';
import { badInput, conflict, notFound } from '../errors.js';
import { toProject } from '../db/dto.js';
import { ROLES } from '../db/models.js';
import { email as validEmail, objectId, text } from '../util/validate.js';
import { requireProject, requireViewer } from './access.js';

const KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const oid = (id) => new mongoose.Types.ObjectId(id);

export function projectService({ models, cache, pubsub }) {
  const { Project, Task, User } = models;

  async function changed(ctx, projectId, type) {
    ctx.loaders.projects.clear(projectId);
    await cache.invalidateProject(projectId, ctx.cacheSession);
    await pubsub.publish(`project:${projectId}`, { type, projectId, actorId: ctx.viewer.id, taskId: null, task: null });
  }

  return {
    async listForViewer(ctx) {
      const viewer = requireViewer(ctx);
      const docs = await Project.find({ 'members.userId': oid(viewer.id) }).sort({ name: 1 }).lean();
      const dtos = docs.map(toProject);
      for (const p of dtos) ctx.loaders.projects.prime(p.id, p);
      return dtos;
    },

    async byKey(ctx, key) {
      requireViewer(ctx);
      const doc = await Project.findOne({ key: String(key).toUpperCase() }, { _id: 1 }).lean();
      if (!doc) throw notFound('Project');
      return (await requireProject(ctx, String(doc._id))).project;
    },

    async create(ctx, { name, key }) {
      const viewer = requireViewer(ctx);
      const cleanName = text(name, 'name', { min: 1, max: 80 });
      const cleanKey = text(key, 'key', { min: 2, max: 10 }).toUpperCase();
      if (!KEY.test(cleanKey)) throw badInput('key must be 2-10 letters or digits and start with a letter', 'key');
      try {
        const doc = await Project.create({ name: cleanName, key: cleanKey, members: [{ userId: viewer.id, role: 'OWNER' }] });
        return toProject(doc.toObject());
      } catch (error) {
        if (error?.code === 11000) throw conflict(`Project key ${cleanKey} is taken`);
        throw error;
      }
    },

    async addMember(ctx, { projectId, email, role }) {
      const { project } = await requireProject(ctx, projectId, 'OWNER');
      if (!ROLES.includes(role)) throw badInput('Unknown role', 'role');
      const user = await User.findOne({ email: validEmail(email) }, { _id: 1 }).lean();
      if (!user) throw notFound('User');
      // The filter makes "check and add" a single atomic step.
      const doc = await Project.findOneAndUpdate(
        { _id: oid(project.id), 'members.userId': { $ne: user._id } },
        { $push: { members: { userId: user._id, role } } },
        { returnDocument: 'after' },
      ).lean();
      if (!doc) throw conflict('That user is already a member');
      await changed(ctx, project.id, 'MEMBERS_CHANGED');
      return toProject(doc);
    },

    async removeMember(ctx, { projectId, userId }) {
      const { project } = await requireProject(ctx, projectId, 'OWNER');
      objectId(userId, 'userId');
      const member = project.members.find((m) => m.userId === userId);
      if (!member) throw notFound('Member');
      if (member.role === 'OWNER' && project.members.filter((m) => m.role === 'OWNER').length === 1) {
        throw badInput('A project needs at least one owner');
      }
      const doc = await Project.findOneAndUpdate(
        { _id: oid(project.id) },
        { $pull: { members: { userId: oid(userId) } } },
        { returnDocument: 'after' },
      ).lean();
      // Their open tasks go back to the unassigned pile.
      await Task.updateMany(
        { projectId: oid(project.id), assigneeId: oid(userId), status: { $ne: 'DONE' } },
        { $set: { assigneeId: null }, $inc: { rev: 1 } },
      );
      await changed(ctx, project.id, 'MEMBERS_CHANGED');
      return toProject(doc);
    },
  };
}

function rotateSecret(data) {
  if (!data) return null;
  return data;
}