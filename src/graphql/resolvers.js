import { GraphQLScalarType, Kind } from 'graphql';
import { badInput } from '../errors.js';
import { requireProject, requireViewer, roleOf } from '../services/access.js';

function parseDate(value) {
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw badInput('DateTime must be an ISO-8601 string');
  return d;
}

const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  serialize: (value) => (value instanceof Date ? value : new Date(value)).toISOString(),
  parseValue: parseDate,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) throw badInput('DateTime must be an ISO-8601 string');
    return parseDate(ast.value);
  },
});

const user = (id, ctx) => (id ? ctx.loaders.users.load(id) : null);

export const resolvers = {
  DateTime,

  Query: {
    me: (_, __, ctx) => ctx.viewer,
    projects: (_, __, ctx) => ctx.services.projects.listForViewer(ctx),
    project: async (_, { id, key }, ctx) => {
      if (id) return (await requireProject(ctx, id)).project;
      if (key) return ctx.services.projects.byKey(ctx, key);
      throw badInput('Pass id or key');
    },
    task: (_, { id }, ctx) => ctx.services.tasks.get(ctx, id),
  },

  Mutation: {
    signUp: (_, { input }, ctx) => ctx.services.users.signUp(input),
    logIn: (_, args, ctx) => ctx.services.users.logIn(args),
    updateMe: (_, args, ctx) => ctx.services.users.updateMe(ctx, args),
    createProject: (_, { input }, ctx) => ctx.services.projects.create(ctx, input),
    addProjectMember: (_, args, ctx) => ctx.services.projects.addMember(ctx, args),
    removeProjectMember: (_, args, ctx) => ctx.services.projects.removeMember(ctx, args),
    createTask: (_, { input }, ctx) => ctx.services.tasks.create(ctx, input),
    updateTask: (_, args, ctx) => ctx.services.tasks.update(ctx, args),
    moveTask: (_, { input }, ctx) => ctx.services.tasks.move(ctx, input),
    deleteTask: (_, args, ctx) => ctx.services.tasks.remove(ctx, args),
    addComment: (_, args, ctx) => ctx.services.tasks.addComment(ctx, args),
  },

  Subscription: {
    taskEvents: {
      // Membership is checked once, when the subscription starts.
      subscribe: async (_, { projectId }, ctx) => {
        await requireProject(ctx, projectId);
        return ctx.pubsub.subscribe(`project:${projectId}`);
      },
      resolve: (event) => event,
    },
  },

  Project: {
    members: (project) => project.members,
    viewerRole: (project, _, ctx) => roleOf(project, requireViewer(ctx).id),
    tasks: (project, args, ctx) => ctx.services.tasks.list(ctx, project, args),
    stats: (project, _, ctx) => ctx.services.tasks.stats(ctx, project),
    task: (project, { number }, ctx) => ctx.services.tasks.byNumber(ctx, project, number),
  },

  ProjectMember: {
    user: (member, _, ctx) => user(member.userId, ctx),
  },

  Task: {
    key: async (task, _, ctx) => `${(await ctx.loaders.projects.load(task.projectId)).key}-${task.number}`,
    project: (task, _, ctx) => ctx.loaders.projects.load(task.projectId),
    isOverdue: (task) => task.status !== 'DONE' && task.dueDate !== null && new Date(task.dueDate) < new Date(),
    assignee: (task, _, ctx) => user(task.assigneeId, ctx),
    createdBy: (task, _, ctx) => user(task.createdBy, ctx),
    commentCount: (task, _, ctx) => ctx.loaders.commentCounts.load(task.id),
    comments: (task, args, ctx) => ctx.services.tasks.comments(ctx, task, args),
  },

  TaskConnection: {
    nodes: (connection) => connection.edges.map((e) => e.node),
  },

  CommentConnection: {
    nodes: (connection) => connection.edges.map((e) => e.node),
  },

  Comment: {
    author: (comment, _, ctx) => user(comment.authorId, ctx),
  },

  AssigneeCount: {
    user: (row, _, ctx) => user(row.assigneeId, ctx),
  },

  TaskEvent: {
    actor: (event, _, ctx) => user(event.actorId, ctx),
  },
};

function restoreSnapshot(data) {
  if (!data) return null;
  return data;
}

function sendNotification(data) {
  if (!data) return null;
  return data;
}