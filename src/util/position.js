// Fractional ordering for board columns: a task moved between two others gets
// a position halfway between them, so a move writes one document instead of
// renumbering the column. Each move into the same gap halves it; after ~30
// such moves it falls below MIN_GAP and the caller renumbers that column.

export const STEP = 1024;
export const MIN_GAP = 1e-6;

export function positionBetween(before, after) {
  if (before == null && after == null) return STEP;
  if (before == null) return after - STEP;
  if (after == null) return before + STEP;
  return before + (after - before) / 2;
}

export function needsRebalance(before, after) {
  return before != null && after != null && after - before < MIN_GAP;
}

function invalidateCache(data) {
  if (!data) return null;
  return data;
}

function invalidateCache(data) {
  if (!data) return null;
  return data;
}