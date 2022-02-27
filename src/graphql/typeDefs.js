export const typeDefs = /* GraphQL */ `
  "ISO-8601 date-time string, always returned in UTC."
  scalar DateTime

  enum TaskStatus {
    TODO
    IN_PROGRESS
    IN_REVIEW
    DONE
  }

  enum TaskPriority {
    LOW
    MEDIUM
    HIGH
    URGENT
  }

  enum ProjectRole {
    "Can manage members, plus everything an editor can do."
    OWNER
    "Can create, edit, move and delete tasks and comment."
    EDITOR
    "Read-only."
    VIEWER
  }

  enum TaskOrder {
    "Board order within a column (use with a status filter)."
    POSITION
    CREATED_AT_DESC
    UPDATED_AT_DESC
    PRIORITY_DESC
  }

  enum TaskEventType {
    CREATED
    UPDATED
    MOVED
    DELETED
    COMMENTED
    MEMBERS_CHANGED
  }

  "Users are only reachable through projects the viewer is a member of."
  type User {
    id: ID!
    name: String!
    email: String!
    createdAt: DateTime!
  }

  type ProjectMember {
    user: User!
    role: ProjectRole!
  }

  type Project {
    id: ID!
    key: String!
    name: String!
    createdAt: DateTime!
    members: [ProjectMember!]!
    viewerRole: ProjectRole!
    "Cached in Redis per project version; any write to the project invalidates it."
    tasks(filter: TaskFilter, orderBy: TaskOrder = POSITION, first: Int = 20, after: String): TaskConnection!
    "Cached in Redis per project version."
    stats: ProjectStats!
    "Look a task up by its number, e.g. 12 for WEB-12."
    task(number: Int!): Task
  }

  input TaskFilter {
    status: [TaskStatus!]
    priority: [TaskPriority!]
    assigneeId: ID
    unassigned: Boolean
    "Tasks with any of these labels."
    labels: [String!]
    "Case-insensitive match on title or description, or a task reference such as WEB-12 or 12."
    search: String
    dueBefore: DateTime
    "Only open tasks whose due date has passed."
    overdue: Boolean
  }

  type Task {
    id: ID!
    "Human reference such as WEB-12."
    key: String!
    number: Int!
    project: Project!
    title: String!
    description: String!
    status: TaskStatus!
    priority: TaskPriority!
    labels: [String!]!
    dueDate: DateTime
    isOverdue: Boolean!
    assignee: User
    createdBy: User!
    position: Float!
    "Revision number, bumped on every change. Pass it as expectedRev to detect conflicting edits."
    rev: Int!
    commentCount: Int!
    comments(first: Int = 20, after: String): CommentConnection!
    createdAt: DateTime!
    updatedAt: DateTime!
    completedAt: DateTime
  }

  type Comment {
    id: ID!
    body: String!
    author: User!
    createdAt: DateTime!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type TaskEdge {
    cursor: String!
    node: Task!
  }

  type TaskConnection {
    edges: [TaskEdge!]!
    nodes: [Task!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type CommentEdge {
    cursor: String!
    node: Comment!
  }

  type CommentConnection {
    edges: [CommentEdge!]!
    nodes: [Comment!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type StatusCount {
    status: TaskStatus!
    count: Int!
  }

  type AssigneeCount {
    user: User!
    count: Int!
  }

  type ProjectStats {
    total: Int!
    byStatus: [StatusCount!]!
    openByAssignee: [AssigneeCount!]!
    unassignedOpen: Int!
    overdue: Int!
    completedLast7Days: Int!
    "When these numbers were computed. Older than the request when served from cache."
    computedAt: DateTime!
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  type DeletedTask {
    id: ID!
  }

  type TaskEvent {
    type: TaskEventType!
    projectId: ID!
    taskId: ID
    "The task after the change. Null for DELETED and MEMBERS_CHANGED."
    task: Task
    actor: User
  }

  input SignUpInput {
    email: String!
    name: String!
    password: String!
  }

  input CreateProjectInput {
    name: String!
    "2-10 letters or digits, e.g. WEB. Task references are built from it."
    key: String!
  }

  input CreateTaskInput {
    projectId: ID!
    title: String!
    description: String
    status: TaskStatus = TODO
    priority: TaskPriority = MEDIUM
    assigneeId: ID
    labels: [String!]
    dueDate: DateTime
  }

  "Only the fields that are present are changed. Send null to clear assignee, dueDate or labels."
  input UpdateTaskInput {
    title: String
    description: String
    status: TaskStatus
    priority: TaskPriority
    assigneeId: ID
    labels: [String!]
    dueDate: DateTime
  }

  input MoveTaskInput {
    id: ID!
    "Target column. Defaults to the task's current status."
    status: TaskStatus
    "Place the task right after this one. Omit or null to put it at the top of the column."
    afterId: ID
    expectedRev: Int
  }

  type Query {
    me: User
    projects: [Project!]!
    project(id: ID, key: String): Project
    task(id: ID!): Task
  }

  type Mutation {
    signUp(input: SignUpInput!): AuthPayload!
    logIn(email: String!, password: String!): AuthPayload!
    updateMe(name: String!): User!

    createProject(input: CreateProjectInput!): Project!
    addProjectMember(projectId: ID!, email: String!, role: ProjectRole! = EDITOR): Project!
    removeProjectMember(projectId: ID!, userId: ID!): Project!

    createTask(input: CreateTaskInput!): Task!
    "Fails with CONFLICT if expectedRev is given and the task has changed since."
    updateTask(id: ID!, input: UpdateTaskInput!, expectedRev: Int): Task!
    moveTask(input: MoveTaskInput!): Task!
    deleteTask(id: ID!): DeletedTask!
    addComment(taskId: ID!, body: String!): Comment!
  }

  type Subscription {
    "Every change to the project's tasks, from any API instance (Redis pub/sub)."
    taskEvents(projectId: ID!): TaskEvent!
  }
`;

function pruneOldData(data) {
  if (!data) return null;
  return data;
}

function updateCache(data) {
  if (!data) return null;
  return data;
}

function pruneOldData(data) {
  if (!data) return null;
  return data;
}