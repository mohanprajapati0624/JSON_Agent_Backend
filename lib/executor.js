import {
  isPlainObject,
  deepDeduplicate,
  deepMerge,
  getAtPath,
  setAtPath,
  traverse,
  findCollectionItems,
  applyExclusions
} from '../utils/helpers.js';

// ─────────────────────────────────────────────
// PLAN EXECUTOR
// Executes AI-generated plans on JSON data
// ─────────────────────────────────────────────

/**
 * Execute a plan based on its type
 * @param {Object} plan - The AI-generated plan
 * @param {Object} sources - Source data map
 * @returns {Object} - Execution result
 */
export const executePlan = async (plan, sources) => {
  const planType = plan.plan_type || plan.mode;

  switch (planType) {
    case 'extract':
      return executeExtract(plan, sources);
    case 'query':
      return executeQuery(plan, sources);
    case 'merge':
      return executeMerge(plan, sources);
    case 'join':
      return executeJoin(plan, sources);
    case 'pipeline':
      return executePipeline(plan, sources);
    case 'error':
      throw new Error(plan.message || 'Plan error');
    default:
      throw new Error(`Unknown plan type: ${planType}`);
  }
};

// ─────────────────────────────────────────────
// EXTRACT EXECUTOR
// ─────────────────────────────────────────────

const executeExtract = (plan, sources) => {
  const sourceId = plan.source_id;
  const data = sources[sourceId];

  if (!data) {
    throw new Error(`Source ${sourceId} not found`);
  }

  // If path is specified, extract at path
  if (plan.path && Array.isArray(plan.path) && plan.path.length > 0) {
    const extracted = getAtPath(data, plan.path);
    if (extracted === undefined) {
      throw new Error(`Path ${plan.path.join('.')} not found in ${sourceId}`);
    }
    return extracted;
  }

  // If index is specified, get element
  if (plan.index !== null && plan.index !== undefined) {
    const index = plan.index;

    if (Array.isArray(data)) {
      const actualIndex = index === -1 ? data.length - 1 : index;
      if (actualIndex < 0 || actualIndex >= data.length) {
        throw new Error(`Index ${index} out of bounds (length: ${data.length})`);
      }
      return data[actualIndex];
    }

    if (isPlainObject(data)) {
      const keys = Object.keys(data);
      const actualIndex = index === -1 ? keys.length - 1 : index;
      if (actualIndex < 0 || actualIndex >= keys.length) {
        throw new Error(`Index ${index} out of bounds (keys: ${keys.length})`);
      }
      const key = keys[actualIndex];
      return { [key]: data[key] };
    }
  }

  // Return whole source
  return data;
};

// ─────────────────────────────────────────────
// QUERY EXECUTOR
// ─────────────────────────────────────────────

const executeQuery = (plan, sources) => {
  // Determine scope
  const sourceIds = plan.source_ids || Object.keys(sources);
  const scope = Object.fromEntries(
    Object.entries(sources).filter(([id]) => sourceIds.includes(id))
  );

  const operations = plan.operations || [];
  if (operations.length === 0) {
    throw new Error('No operations specified in query plan');
  }

  const results = [];

  for (const op of operations) {
    const opResult = executeQueryOp(op, scope);
    results.push(opResult);
  }

  // Single operation → return directly
  if (results.length === 1) {
    return {
      mode: `dynamic_${operations[0].op}`,
      ...results[0]
    };
  }

  // Multiple operations → return array
  return {
    mode: 'multi_operation',
    operations: results
  };
};

const executeQueryOp = (op, scope) => {
  const opType = op.op?.toLowerCase();
  const collection = op.collection;
  const excludeFields = op.exclude_fields || [];

  // Collect items from all sources in scope
  let items = [];
  for (const [sourceId, data] of Object.entries(scope)) {
    const sourceItems = findCollectionItems(data, collection);
    items.push(...sourceItems);
  }

  switch (opType) {
    case 'filter': {
      const field = op.field?.toLowerCase();
      const value = op.value;
      const filtered = items.filter(item => {
        const key = Object.keys(item).find(k => k.toLowerCase() === field);
        if (!key) return false;
        const itemVal = item[key];
        if (typeof value === 'boolean') return itemVal === value;
        return String(itemVal).toLowerCase() === String(value).toLowerCase();
      }).map(item => applyExclusions(item, excludeFields));

      return {
        operation: 'filter',
        collection,
        filter: { field: op.field, value },
        count: filtered.length,
        results: filtered.map(item => ({ data: item }))
      };
    }

    case 'sort': {
      const field = op.field?.toLowerCase();
      const order = op.order || 'asc';
      const sorted = [...items].sort((a, b) => {
        const ak = Object.keys(a).find(k => k.toLowerCase() === field);
        const bk = Object.keys(b).find(k => k.toLowerCase() === field);
        const av = ak ? a[ak] : '';
        const bv = bk ? b[bk] : '';
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
        return order === 'desc' ? -cmp : cmp;
      });

      return {
        operation: 'sort',
        collection,
        field: op.field,
        order,
        count: sorted.length,
        results: sorted
      };
    }

    case 'group': {
      const field = op.by?.toLowerCase();
      const groups = {};
      for (const item of items) {
        const key = Object.keys(item).find(k => k.toLowerCase() === field);
        if (!key) continue;
        const groupKey = String(item[key]);
        if (!groups[groupKey]) groups[groupKey] = [];
        groups[groupKey].push(applyExclusions(item, excludeFields));
      }

      return {
        operation: 'group',
        collection,
        groupBy: op.by,
        groups
      };
    }

    case 'count': {
      const field = op.by?.toLowerCase();
      const counts = {};
      for (const item of items) {
        const key = Object.keys(item).find(k => k.toLowerCase() === field);
        if (!key) continue;
        const val = String(item[key]);
        counts[val] = (counts[val] || 0) + 1;
      }

      return {
        operation: 'count',
        collection,
        field: op.by,
        counts
      };
    }

    case 'unique': {
      const field = op.field?.toLowerCase();
      const seen = new Set();
      for (const item of items) {
        const key = Object.keys(item).find(k => k.toLowerCase() === field);
        if (key) seen.add(item[key]);
      }

      return {
        operation: 'unique',
        collection,
        field: op.field,
        count: seen.size,
        values: [...seen]
      };
    }

    case 'select': {
      const fields = (op.fields || []).map(f => f.toLowerCase());
      const projected = items.map(item => {
        const out = {};
        for (const f of fields) {
          const key = Object.keys(item).find(k => k.toLowerCase() === f);
          if (key) out[key] = item[key];
        }
        return out;
      });

      return {
        operation: 'select',
        collection,
        fields: op.fields,
        count: projected.length,
        results: projected
      };
    }

    default:
      return { operation: opType, error: `Unknown operation: ${opType}` };
  }
};

// ─────────────────────────────────────────────
// MERGE EXECUTOR
// ─────────────────────────────────────────────

const executeMerge = (plan, sources) => {
  const sourceIds = Object.keys(sources);

  // Validate plan
  if (!sourceIds.includes(plan.root_source_id)) {
    throw new Error(`Root source ${plan.root_source_id} not found`);
  }

  // Create working copies
  const live = {};
  for (const [id, obj] of Object.entries(sources)) {
    live[id] = structuredClone(obj);
  }

  // Execute each merge step
  for (const step of (plan.steps || [])) {
    const parent = live[step.parent_source_id];
    const child = live[step.child_source_id];

    if (!parent) throw new Error(`Parent source ${step.parent_source_id} not found`);
    if (!child) throw new Error(`Child source ${step.child_source_id} not found`);

    // Resolve anchor path
    let anchor;
    try {
      anchor = getAtPath(parent, step.anchor_path);
    } catch (e) {
      anchor = null;
    }

    // Auto-create path if needed
    if (anchor === null || anchor === undefined || !isPlainObject(anchor)) {
      const existingValue = anchor;
      setAtPath(parent, step.anchor_path, {});
      anchor = getAtPath(parent, step.anchor_path);
      
      // Preserve existing primitive value
      if (existingValue !== null && existingValue !== undefined && 
          !isPlainObject(existingValue) && !Array.isArray(existingValue)) {
        anchor._value = existingValue;
      } else if (Array.isArray(existingValue)) {
        anchor._items = existingValue;
      }
    }

    // Merge child into anchor
    const embedMode = step.embed_mode || 'merge_keys';
    if (embedMode === 'merge_keys') {
      for (const [k, v] of Object.entries(child)) {
        anchor[k] = k in anchor ? deepMerge(anchor[k], v) : v;
      }
    } else if (embedMode === 'as_array') {
      if (!Array.isArray(anchor._embedded)) anchor._embedded = [];
      anchor._embedded.push(child);
    }
  }

  return deepDeduplicate(live[plan.root_source_id]);
};

// ─────────────────────────────────────────────
// JOIN EXECUTOR
// ─────────────────────────────────────────────

const executeJoin = (plan, sources) => {
  if (!sources[plan.root_source_id]) {
    throw new Error(`Root source ${plan.root_source_id} not found`);
  }

  const result = structuredClone(sources[plan.root_source_id]);

  for (const join of (plan.joins || [])) {
    const childData = sources[join.child_source_id];
    if (!childData) {
      console.warn(`[JOIN] Child source ${join.child_source_id} not found`);
      continue;
    }

    const childItems = findCollectionItems(childData, join.child_array);
    if (childItems.length === 0) {
      console.warn(`[JOIN] No items found for "${join.child_array}"`);
      continue;
    }

    // Find parent arrays and embed matches
    let matched = 0;
    traverse(result, (node, pathArr) => {
      if (!Array.isArray(node)) return;
      const key = pathArr[pathArr.length - 1];
      if (!key || key.toLowerCase() !== join.parent_array.toLowerCase()) return;

      for (const parentItem of node) {
        if (!isPlainObject(parentItem)) continue;
        const parentVal = parentItem[join.parent_field];
        if (parentVal === undefined) continue;

        const matches = childItems.filter(child => {
          const childVal = child[join.child_field];
          if (childVal === undefined) return false;
          // Handle array-of-IDs matching
          if (Array.isArray(parentVal)) return parentVal.map(String).includes(String(childVal));
          if (Array.isArray(childVal)) return childVal.map(String).includes(String(parentVal));
          return String(parentVal) === String(childVal);
        });

        if (matches.length > 0) matched++;

        if (join.embed_type === 'object') {
          parentItem[join.embed_as] = matches.length > 0 ? structuredClone(matches[0]) : null;
        } else {
          parentItem[join.embed_as] = structuredClone(matches);
        }
      }
    });

    console.log(`[JOIN] ${join.parent_array}.${join.parent_field} → ${join.child_array}.${join.child_field} | ${matched} matched`);
  }

  return result;
};

// ─────────────────────────────────────────────
// PIPELINE EXECUTOR
// ─────────────────────────────────────────────

const executePipeline = async (plan, sources) => {
  let result = null;
  const log = [];

  for (const stage of (plan.stages || [])) {
    console.log(`[PIPELINE] Stage ${stage.stage}: ${stage.type}`);

    if (stage.type === 'merge' && Array.isArray(stage.steps)) {
      const mergePlan = {
        plan_type: 'merge',
        root_source_id: plan.root_source_id,
        steps: stage.steps
      };
      result = executeMerge(mergePlan, sources);
      log.push({ stage: stage.stage, type: 'merge', status: 'success' });
    }

    if (stage.type === 'join' && Array.isArray(stage.joins)) {
      const joinSources = result ? { RESULT: result, ...sources } : sources;
      const joinPlan = {
        plan_type: 'join',
        root_source_id: result ? 'RESULT' : plan.root_source_id,
        joins: stage.joins
      };
      result = executeJoin(joinPlan, joinSources);
      log.push({ stage: stage.stage, type: 'join', status: 'success' });
    }

    if (stage.type === 'transform' && Array.isArray(stage.operations)) {
      if (!result) result = sources[plan.root_source_id];
      
      const transformResults = [];
      for (const op of stage.operations) {
        // Execute on current result
        const items = findCollectionItems(result, op.collection);
        const opResult = executeQueryOp({ ...op, collection: op.collection }, { _: result });
        transformResults.push(opResult);
      }
      
      result.__transforms = transformResults;
      log.push({ stage: stage.stage, type: 'transform', status: 'success' });
    }
  }

  if (!result) {
    result = sources[plan.root_source_id] || Object.values(sources)[0];
  }

  return result;
};

export default {
  executePlan,
  executeExtract,
  executeQuery,
  executeMerge,
  executeJoin,
  executePipeline
};
