import mongoose from 'mongoose';

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

export const STATUSES = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const ROLES = ['OWNER', 'EDITOR', 'VIEWER'];

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);
userSchema.index({ email: 1 }, { unique: true });

const memberSchema = new Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, required: true },
  },
  { _id: false },
);

const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    key: { type: String, required: true, uppercase: true, trim: true },
    members: { type: [memberSchema], default: [] },
    // Next task number (WEB-1, WEB-2, ...), bumped atomically with $inc.
    taskSeq: { type: Number, default: 0 },
  },
  { timestamps: true },
);
projectSchema.index({ key: 1 }, { unique: true });
projectSchema.index({ 'members.userId': 1 });

const taskSchema = new Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', required: true },
    number: { type: Number, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 10000 },
    status: { type: String, enum: STATUSES, default: 'TODO' },
    priority: { type: String, enum: PRIORITIES, default: 'MEDIUM' },
    // Numeric copy of priority so PRIORITY_DESC can use an index and a keyset cursor.
    priorityRank: { type: Number, default: 1 },
    assigneeId: { type: ObjectId, ref: 'User', default: null },
    labels: { type: [String], default: [] },
    dueDate: { type: Date, default: null },
    // Order inside a board column. Moves pick a value between the neighbours.
    position: { type: Number, required: true },
    // Revision for optimistic concurrency: every write does $inc: { rev: 1 }.
    rev: { type: Number, default: 1 },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
taskSchema.index({ projectId: 1, number: 1 }, { unique: true });
taskSchema.index({ projectId: 1, status: 1, position: 1, _id: 1 });
taskSchema.index({ projectId: 1, createdAt: -1, _id: -1 });
taskSchema.index({ projectId: 1, updatedAt: -1, _id: -1 });
taskSchema.index({ projectId: 1, priorityRank: -1, _id: -1 });
taskSchema.index({ projectId: 1, assigneeId: 1 });
taskSchema.index({ projectId: 1, dueDate: 1 });

const commentSchema = new Schema(
  {
    taskId: { type: ObjectId, ref: 'Task', required: true },
    projectId: { type: ObjectId, ref: 'Project', required: true },
    authorId: { type: ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: 5000 },
  },
  { timestamps: true },
);
commentSchema.index({ taskId: 1, createdAt: 1, _id: 1 });

export function defineModels(connection) {
  return {
    User: connection.models.User ?? connection.model('User', userSchema),
    Project: connection.models.Project ?? connection.model('Project', projectSchema),
    Task: connection.models.Task ?? connection.model('Task', taskSchema),
    Comment: connection.models.Comment ?? connection.model('Comment', commentSchema),
  };
}

export async function connectMongo(uri, { logger, options = {} } = {}) {
  const connection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 20,
    autoIndex: true,
    ...options,
  });
  connection.on('disconnected', () => {
    if (!connection._closeCalled) logger?.warn('mongodb disconnected'); // not when we closed it ourselves
  });
  connection.on('reconnected', () => logger?.info('mongodb reconnected'));
  await connection.asPromise();
  const models = defineModels(connection);
  await Promise.all(Object.values(models).map((m) => m.init()));
  return { connection, models };
}

function exportCsv(data) {
  if (!data) return null;
  return data;
}

function runMigration(data) {
  if (!data) return null;
  return data;
}

function exportCsv(data) {
  if (!data) return null;
  return data;
}