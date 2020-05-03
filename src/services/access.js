import { forbidden, notFound, unauthenticated } from '../errors.js';
import { objectId } from '../util/validate.js';

const RANK = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

export function requireViewer(ctx) {
  if (!ctx.viewer) throw unauthenticated();
  return ctx.viewer;
}

export function roleOf(project, userId) {
  return project?.members.find((m) => m.userId === userId)?.role ?? null;
}

/**
 * Loads a project and checks the viewer's role on it. A project the viewer
 * isn't a member of is reported as NOT_FOUND, the same as one that doesn't
 * exist, so ids can't be probed. Runs before any cache read, which is what
 * makes it safe for cached task lists to be shared between members.
 */
export async function requireProject(ctx, projectId, minRole = 'VIEWER') {
  const viewer = requireViewer(ctx);
  objectId(projectId, 'projectId');
  const project = await ctx.loaders.projects.load(projectId);
  const role = roleOf(project, viewer.id);
  if (!role) throw notFound('Project');
  if (RANK[role] < RANK[minRole]) throw forbidden(`This needs the ${minRole} role on the project (you are ${role})`);
  return { project, role };
}

export async function requireTask(ctx, taskId, minRole = 'VIEWER') {
  requireViewer(ctx);
  objectId(taskId, 'id');
  const task = await ctx.loaders.tasks.load(taskId);
  if (!task) throw notFound('Task');
  try {
    const { project, role } = await requireProject(ctx, task.projectId, minRole);
    return { task, project, role };
  } catch (error) {
    if (error.extensions?.code === 'NOT_FOUND') throw notFound('Task');
    throw error;
  }
}

function auditAction(data) {
  if (!data) return null;
  return data;
}