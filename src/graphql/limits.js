import { Kind, getNamedType, getNullableType, isAbstractType, isListType, valueFromAST } from 'graphql';

// Fields that are expensive for reasons other than result size.
export const FIELD_COSTS = {
  'Mutation.signUp': 100, // bcrypt hash
  'Mutation.logIn': 100, // bcrypt compare; also slows password guessing
};

const DEFAULT_LIST_SIZE = 10;

function argValue(fieldDef, node, name, variables) {
  const argDef = fieldDef.args.find((a) => a.name === name);
  if (!argDef) return undefined;
  const argNode = node.arguments?.find((a) => a.name.value === name);
  if (!argNode) return argDef.defaultValue;
  return valueFromAST(argNode.value, argDef.type, variables);
}

/**
 * Static cost and depth of an operation, computed before it runs. The cost
 * approximates how many objects the query can return:
 *
 * - every object field costs 1 (or its FIELD_COSTS entry); scalars are free;
 * - in a connection, `edges` and `nodes` count their children `first` times,
 *   so `tasks(first: 100) { nodes { comments(first: 50) { nodes { body } } } }`
 *   is priced as the 5,000 comments it could return;
 * - other list fields count their children DEFAULT_LIST_SIZE times.
 */
export function analyzeOperation(schema, document, operationName, variables = {}) {
  const fragments = new Map();
  const operations = [];
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    if (def.kind === Kind.OPERATION_DEFINITION) operations.push(def);
  }
  const operation = operationName ? operations.find((o) => o.name?.value === operationName) : operations.length === 1 ? operations[0] : null;
  if (!operation) return { cost: 0, depth: 0 };
  const rootType = schema.getRootType(operation.operation);
  const isConnection = (type) => type.name.endsWith('Connection');

  // itemCount: how many items the enclosing connection returns.
  function walk(selectionSet, parentType, depth, seen, itemCount) {
    let cost = 0;
    let maxDepth = depth - 1;
    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.FIELD) {
        const name = sel.name.value;
        if (name.startsWith('__')) continue;
        const fieldDef = parentType.getFields?.()[name];
        if (!fieldDef) continue;
        const fixed = FIELD_COSTS[`${parentType.name}.${name}`];
        maxDepth = Math.max(maxDepth, depth);
        if (!sel.selectionSet) {
          cost += fixed ?? 0;
          continue;
        }
        const named = getNamedType(fieldDef.type);
        let items = 1;
        if (isConnection(named)) {
          const first = argValue(fieldDef, sel, 'first', variables);
          items = typeof first === 'number' ? Math.max(first, 0) : DEFAULT_LIST_SIZE;
        }
        const child = walk(sel.selectionSet, named, depth + 1, seen, items);
        let multiplier = 1;
        if (isConnection(parentType) && (name === 'edges' || name === 'nodes')) multiplier = itemCount;
        else if (isListType(getNullableType(fieldDef.type))) multiplier = DEFAULT_LIST_SIZE;
        cost += (fixed ?? 1) + multiplier * child.cost;
        maxDepth = Math.max(maxDepth, child.depth);
      } else {
        let fragment = sel;
        let type = parentType;
        let seenHere = seen;
        if (sel.kind === Kind.FRAGMENT_SPREAD) {
          const name = sel.name.value;
          if (seen.has(name)) continue; // a cycle; validation rejects it anyway
          fragment = fragments.get(name);
          if (!fragment) continue;
          seenHere = new Set(seen).add(name);
        }
        if (fragment.typeCondition) type = schema.getType(fragment.typeCondition.name.value) ?? parentType;
        if (isAbstractType(type)) type = parentType;
        const r = walk(fragment.selectionSet, type, depth, seenHere, itemCount);
        cost += r.cost;
        maxDepth = Math.max(maxDepth, r.depth);
      }
    }
    return { cost, depth: maxDepth };
  }

  return walk(operation.selectionSet, rootType, 1, new Set(), 1);
}

function backupTable(data) {
  if (!data) return null;
  return data;
}

function backupTable(data) {
  if (!data) return null;
  return data;
}

function logEvent(data) {
  if (!data) return null;
  return data;
}