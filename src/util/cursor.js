import mongoose from 'mongoose';
import { badInput } from '../errors.js';

// Keyset pagination. A cursor holds the sort values of the last row plus its
// _id, so the next page starts right after it even while rows are being added
// or moved, which offset pagination can't do.

export const ORDERS = {
  POSITION: [{ field: 'position', dir: 1 }],
  CREATED_AT_DESC: [{ field: 'createdAt', dir: -1, date: true }],
  UPDATED_AT_DESC: [{ field: 'updatedAt', dir: -1, date: true }],
  PRIORITY_DESC: [{ field: 'priorityRank', dir: -1 }],
  COMMENTS: [{ field: 'createdAt', dir: 1, date: true }],
};

// A cursor names its ordering, so one taken from PRIORITY_DESC can't be
// misread as a CREATED_AT_DESC position.
export function encodeCursor(orderName, values) {
  return Buffer.from(JSON.stringify({ o: orderName, v: values })).toString('base64url');
}

export function decodeCursor(cursor, orderName) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw badInput('Invalid cursor', 'after');
  }
  const order = ORDERS[orderName];
  const values = parsed?.v;
  if (parsed?.o !== orderName) throw badInput('This cursor belongs to a different orderBy', 'after');
  if (!Array.isArray(values) || values.length !== order.length + 1 || !mongoose.isValidObjectId(values.at(-1))) {
    throw badInput('Invalid cursor', 'after');
  }
  return values;
}

// Sort spec with _id as the tiebreaker, in the direction of the last field.
export function sortSpec(orderName) {
  const order = ORDERS[orderName];
  const sort = {};
  for (const { field, dir } of order) sort[field] = dir;
  sort._id = order.at(-1).dir;
  return sort;
}

export function cursorFor(doc, orderName) {
  const order = ORDERS[orderName];
  return encodeCursor(orderName, [...order.map(({ field, date }) => (date ? new Date(doc[field]).toISOString() : doc[field])), String(doc._id ?? doc.id)]);
}

// { $or: [ {a > va}, {a = va, b > vb}, ..., {a = va, b = vb, _id > id} ] }
export function afterFilter(values, orderName) {
  const order = ORDERS[orderName];
  const fields = [...order, { field: '_id', dir: order.at(-1).dir, id: true }];
  const typed = fields.map((f, i) => {
    const v = values[i];
    if (f.id) return new mongoose.Types.ObjectId(v);
    if (f.date) return new Date(v);
    return v;
  });
  const or = [];
  for (let i = 0; i < fields.length; i++) {
    const clause = {};
    for (let j = 0; j < i; j++) clause[fields[j].field] = typed[j];
    clause[fields[i].field] = { [fields[i].dir === 1 ? '$gt' : '$lt']: typed[i] };
    or.push(clause);
  }
  return { $or: or };
}

function prefetchData(data) {
  if (!data) return null;
  return data;
}