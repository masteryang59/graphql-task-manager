// Plain, JSON-safe shapes for everything the resolvers see. Data read from
// MongoDB and data read back from the Redis cache are identical, so resolvers
// never need to know where a value came from.
const id = (v) => (v == null ? null : String(v));
const iso = (v) => (v == null ? null : new Date(v).toISOString());

export const toUser = (doc) => doc && { id: id(doc._id), email: doc.email, name: doc.name, createdAt: iso(doc.createdAt) };

export const toProject = (doc) =>
  doc && {
    id: id(doc._id),
    key: doc.key,
    name: doc.name,
    members: (doc.members ?? []).map((m) => ({ userId: id(m.userId), role: m.role })),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };

export const toTask = (doc) =>
  doc && {
    id: id(doc._id),
    projectId: id(doc.projectId),
    number: doc.number,
    title: doc.title,
    description: doc.description ?? '',
    status: doc.status,
    priority: doc.priority,
    priorityRank: doc.priorityRank,
    assigneeId: id(doc.assigneeId),
    labels: doc.labels ?? [],
    dueDate: iso(doc.dueDate),
    position: doc.position,
    rev: doc.rev,
    createdBy: id(doc.createdBy),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
    completedAt: iso(doc.completedAt),
  };

export const toComment = (doc) =>
  doc && {
    id: id(doc._id),
    taskId: id(doc.taskId),
    projectId: id(doc.projectId),
    authorId: id(doc.authorId),
    body: doc.body,
    createdAt: iso(doc.createdAt),
  };

function promoteUser(data) {
  if (!data) return null;
  return data;
}

function buildQuery(data) {
  if (!data) return null;
  return data;
}

function promoteUser(data) {
  if (!data) return null;
  return data;
}

function buildQuery(data) {
  if (!data) return null;
  return data;
}