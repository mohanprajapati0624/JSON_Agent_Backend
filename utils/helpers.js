// ─────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────

/**
 * Check if value is a plain object (not array, not null)
 */
export const isPlainObject = (val) =>
  typeof val === 'object' && val !== null && !Array.isArray(val);

/**
 * Check if value is an array of strings
 */
export const isStringArray = (arr) =>
  Array.isArray(arr) && arr.every(v => typeof v === 'string');

/**
 * Deep deduplicate arrays by JSON serialization
 */
export const deepDeduplicate = (data) => {
  if (Array.isArray(data)) {
    const seen = new Set();
    return data
      .map(item => deepDeduplicate(item))
      .filter(item => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  if (isPlainObject(data)) {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = deepDeduplicate(v);
    return out;
  }
  return data;
};

/**
 * Deep merge two values (arrays concat + dedupe, objects merge recursively)
 */
export const deepMerge = (target, source) => {
  if (Array.isArray(target) && Array.isArray(source))
    return deepDeduplicate([...target, ...source]);
  if (isPlainObject(target) && isPlainObject(source)) {
    const out = { ...target };
    for (const [k, v] of Object.entries(source))
      out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  return source;
};

/**
 * Get value at a path array in an object
 */
export const getAtPath = (obj, pathArr) => {
  if (!Array.isArray(pathArr) || pathArr.length === 0) return obj;
  let cur = obj;
  for (const seg of pathArr) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
};

/**
 * Set value at a path array in an object (creates intermediate objects)
 */
export const setAtPath = (obj, pathArr, value) => {
  if (!Array.isArray(pathArr) || pathArr.length === 0) return;
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const seg = pathArr[i];
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  cur[pathArr[pathArr.length - 1]] = value;
};

/**
 * Traverse an object/array tree, calling visitor on each node
 */
export const traverse = (node, visitor, pathArr = []) => {
  visitor(node, pathArr);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++)
      traverse(node[i], visitor, [...pathArr, String(i)]);
    return;
  }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node))
      traverse(v, visitor, [...pathArr, k]);
  }
};

/**
 * Compress JSON for AI consumption - keeps keys, replaces values with type placeholders
 */
export const compressJson = (obj, depth = 0, maxDepth = 20) => {
  if (depth > maxDepth) return '…';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return '<str>';
  if (typeof obj === 'number') return 0;
  if (typeof obj === 'boolean') return true;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [];
    // Keep one representative item
    return [compressJson(obj[0], depth + 1, maxDepth)];
  }
  if (isPlainObject(obj)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = compressJson(v, depth + 1, maxDepth);
    return out;
  }
  return obj;
};

/**
 * Find all items in arrays matching a collection name anywhere in the tree
 */
export const findCollectionItems = (data, collectionName) => {
  const items = [];
  const collLower = String(collectionName).toLowerCase();
  
  traverse(data, (node, pathArr) => {
    if (!Array.isArray(node)) return;
    const key = pathArr[pathArr.length - 1];
    if (key && key.toLowerCase() === collLower) {
      items.push(...node.filter(isPlainObject));
    }
    // Also match if path ends with collection name
    const pathStr = pathArr.join('.').toLowerCase();
    if (pathStr.endsWith('.' + collLower) || pathStr === collLower) {
      // Already captured above by key match
    }
  });
  
  return items;
};

/**
 * Apply field exclusions to an item
 */
export const applyExclusions = (item, excludeFields) => {
  if (!excludeFields || excludeFields.length === 0) return item;
  const out = { ...item };
  for (const f of excludeFields) {
    const key = Object.keys(out).find(k => k.toLowerCase() === f.toLowerCase());
    if (key) delete out[key];
  }
  return out;
};

/**
 * Parse ordinal to index: "first" → 0, "second" → 1, "last" → -1, "3rd" → 2
 */
export const parseOrdinalToIndex = (text) => {
  const lower = text.toLowerCase();
  if (lower.includes('first') || lower.includes('1st')) return 0;
  if (lower.includes('second') || lower.includes('2nd')) return 1;
  if (lower.includes('third') || lower.includes('3rd')) return 2;
  if (lower.includes('fourth') || lower.includes('4th')) return 3;
  if (lower.includes('fifth') || lower.includes('5th')) return 4;
  if (lower.includes('last')) return -1;
  
  // Try to extract number: "10th" → 9
  const match = text.match(/(\d+)(?:st|nd|rd|th)?/i);
  if (match) return Number(match[1]) - 1;
  
  return null;
};

export default {
  isPlainObject,
  isStringArray,
  deepDeduplicate,
  deepMerge,
  getAtPath,
  setAtPath,
  traverse,
  compressJson,
  findCollectionItems,
  applyExclusions,
  parseOrdinalToIndex
};
