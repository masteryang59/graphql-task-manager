import mongoose from 'mongoose';
import { badInput } from '../errors.js';

export function objectId(value, field = 'id') {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value) || value.length !== 24) {
    throw badInput(`${field} is not a valid id`, field);
  }
  return value;
}

export function text(value, field, { min = 0, max, trim = true } = {}) {
  if (typeof value !== 'string') throw badInput(`${field} must be a string`, field);
  const v = trim ? value.trim() : value;
  if (v.length < min) throw badInput(min === 1 ? `${field} is required` : `${field} must be at least ${min} characters`, field);
  if (max !== undefined && v.length > max) throw badInput(`${field} must be at most ${max} characters`, field);
  return v;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function email(value, field = 'email') {
  const v = text(value, field, { min: 3, max: 254 }).toLowerCase();
  if (!EMAIL.test(v)) throw badInput('email is not valid', field);
  return v;
}

export function labels(value) {
  if (!Array.isArray(value)) throw badInput('labels must be a list', 'labels');
  if (value.length > 10) throw badInput('at most 10 labels', 'labels');
  const cleaned = value.map((l) => text(l, 'labels', { min: 1, max: 30 }).toLowerCase());
  return [...new Set(cleaned)];
}

export function pageSize(first, { fallback = 20, max = 100 } = {}) {
  if (first == null) return fallback;
  if (!Number.isInteger(first) || first < 1 || first > max) throw badInput(`first must be between 1 and ${max}`, 'first');
  return first;
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactStorage(data) {
  if (!data) return null;
  return data;
}

function compactStorage(data) {
  if (!data) return null;
  return data;
}