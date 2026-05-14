import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

dotenv.config();

// ─────────────────────────────────────────────
// ENV VALIDATION
// ─────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
  console.error('[FATAL] Missing API key. Set OPENAI_API_KEY or GEMINI_API_KEY in your .env file.');
  process.exit(1);
}

const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
const PORT = process.env.PORT || 5000;

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.txt') return cb(new Error('Only .txt files are allowed'), false);
    cb(null, true);
  }
});

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:4173'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limit: 20 requests per minute per IP (relaxed in dev for testing)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: IS_PROD ? 20 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});
app.use('/api/', apiLimiter);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY
});

// ─────────────────────────────────────────────
// AI CONFIG
// ─────────────────────────────────────────────
const AI_MODEL_LIGHT = process.env.AI_MODEL_LIGHT || 'gpt-4o-mini';  // cheap: standardize
const AI_MODEL_MERGE = process.env.AI_MODEL_MERGE || 'gpt-4o-mini';  // precise: merge planning

const MERGE_INSTRUCTIONS = await fs.readFile(
  path.join(process.cwd(), 'instructions.txt'), 'utf-8'
).catch(() => {
  console.error('[WARN] instructions.txt not found, merge mode disabled');
  return '';
});

const STANDARDIZE_PROMPT = await fs.readFile(
  path.join(process.cwd(), 'standardize_prompt.txt'), 'utf-8'
).catch(() => {
  console.error('[WARN] standardize_prompt.txt not found, standardization disabled');
  return '';
});

const JOIN_INSTRUCTIONS = await fs.readFile(
  path.join(process.cwd(), 'join_instructions.txt'), 'utf-8'
).catch(() => {
  console.error('[WARN] join_instructions.txt not found, join mode disabled');
  return '';
});

const PIPELINE_INSTRUCTIONS = await fs.readFile(
  path.join(process.cwd(), 'pipeline_instructions.txt'), 'utf-8'
).catch(() => {
  console.error('[WARN] pipeline_instructions.txt not found, unified pipeline disabled');
  return '';
});

console.log(`[CONFIG] light=${AI_MODEL_LIGHT}, merge=${AI_MODEL_MERGE}, instructions=${MERGE_INSTRUCTIONS.length} chars, standardize=${STANDARDIZE_PROMPT.length} chars, join=${JOIN_INSTRUCTIONS.length} chars, pipeline=${PIPELINE_INSTRUCTIONS.length} chars`);

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────

const isPlainObject = (val) =>
  typeof val === 'object' && val !== null && !Array.isArray(val);

const isStringArray = (arr) =>
  Array.isArray(arr) && arr.every(v => typeof v === 'string');

const deepDeduplicate = (data) => {
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

const deepMerge = (target, source) => {
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

const getAtPath = (obj, pathArr) => {
  if (!Array.isArray(pathArr) || pathArr.length === 0)
    throw new Error('anchor_path must be a non-empty array');
  let cur = obj;
  for (const seg of pathArr) {
    if (cur === null || cur === undefined)
      throw new Error(`anchor_path not found (stopped at ${JSON.stringify(seg)})`);
    cur = cur[seg];
  }
  return cur;
};

const setAtPath = (obj, pathArr, value) => {
  if (!Array.isArray(pathArr) || pathArr.length === 0)
    throw new Error('setAtPath requires non-empty path');
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const seg = pathArr[i];
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  cur[pathArr[pathArr.length - 1]] = value;
};

const traverse = (node, visitor, pathArr = []) => {
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
 * Find the FULL path to a key in a nested object.
 * This fixes LLM-generated paths that may be incomplete.
 * @param {object} obj - The object to search
 * @param {string} targetKey - The key to find
 * @returns {string[]|null} - Full path array or null if not found
 */
const findFullPathToKey = (obj, targetKey) => {
  const targetLower = targetKey.toLowerCase();
  let foundPath = null;
  
  traverse(obj, (node, pathArr) => {
    if (foundPath) return; // Already found
    if (!isPlainObject(node)) return;
    const key = Object.keys(node).find(k => k.toLowerCase() === targetLower);
    if (key) {
      foundPath = [...pathArr, key];
    }
  });
  
  return foundPath;
};

/**
 * Validate and correct an anchor_path by checking it exists in the object.
 * If the path doesn't exist, try to find the target key and return the correct path.
 */
const correctAnchorPath = (obj, proposedPath) => {
  if (!Array.isArray(proposedPath) || proposedPath.length === 0) return proposedPath;
  
  // Check if proposed path exists
  let cur = obj;
  for (const seg of proposedPath) {
    if (cur === null || cur === undefined) break;
    if (isPlainObject(cur)) {
      const actualKey = Object.keys(cur).find(k => k.toLowerCase() === seg.toLowerCase());
      if (actualKey) {
        cur = cur[actualKey];
      } else {
        cur = undefined;
        break;
      }
    } else {
      cur = undefined;
      break;
    }
  }
  
  // If path exists, return it with correct casing
  if (cur !== undefined) {
    // Rebuild path with correct key casing
    const correctedPath = [];
    let current = obj;
    for (const seg of proposedPath) {
      const actualKey = Object.keys(current).find(k => k.toLowerCase() === seg.toLowerCase());
      if (actualKey) {
        correctedPath.push(actualKey);
        current = current[actualKey];
      } else {
        break;
      }
    }
    return correctedPath;
  }
  
  // Path doesn't exist - try to find the target key
  const targetKey = proposedPath[proposedPath.length - 1];
  const foundPath = findFullPathToKey(obj, targetKey);
  if (foundPath) {
    console.log(`[PATH FIX] Corrected "${proposedPath.join('.')}" → "${foundPath.join('.')}"`);
    return foundPath;
  }
  
  // Couldn't find - return original (will be auto-created)
  return proposedPath;
};

// ─────────────────────────────────────────────
// SMART STANDARDIZATION
// 1. Try local regex first (zero AI calls)
// 2. Fall back to gpt-4o-mini if needed
// ─────────────────────────────────────────────

// tryLocalFirst REMOVED - all parsing now goes through LLM
// This ensures consistent behavior and no static keyword matching

const compressJson = (obj, depth = 0, maxDepth = 20) => {
  if (depth > maxDepth) return '…';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return '<str>';
  if (typeof obj === 'number') return 0;
  if (typeof obj === 'boolean') return true;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [];
    // Keep one representative item so AI sees the structure of array elements
    return [compressJson(obj[0], depth + 1, maxDepth)];
  }
  if (isPlainObject(obj)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = compressJson(v, depth + 1, maxDepth);
    return out;
  }
  return obj;
};

const standardizePrompt = async (rawPrompt) => {
  // Always use LLM for standardization - no static parsing
  try {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL_LIGHT,
      messages: [
        { role: 'system', content: STANDARDIZE_PROMPT },
        { role: 'user', content: rawPrompt }
      ],
      temperature: 0,
      max_tokens: 300
    });
    const result = completion.choices[0].message.content.trim();
    console.log(`[STANDARDIZE] "${rawPrompt}" → ${result}`);
    return result;
  } catch (e) {
    console.error('[STANDARDIZE ERROR]', e.message);
    return rawPrompt;
  }
};

// ─────────────────────────────────────────────
// STATIC MODE DETECTION - DEPRECATED
// All mode decisions now handled by LLM understanding prompt
// These functions kept for backward compatibility but will be phased out
// ─────────────────────────────────────────────

// DEPRECATED: LLM now decides if join is needed via action plan
const isJoinPrompt = (rawPrompt) => false;

// DEPRECATED: LLM classifies operations directly
const classifyOperations = (standardizedQueries, rawPrompt = '') => {
  // Return empty ops - LLM handles classification
  return { merge: [], join: [], query: standardizedQueries };
};

// DEPRECATED: LLM decides mode via action field
const detectMode = (standardizedQueries, rawPrompt = '') => {
  return 'query'; // Default to query, but LLM plan takes precedence
};

// DEPRECATED: LLM handles pipeline decisions
const needsPipeline = (ops) => false;

// ─────────────────────────────────────────────
// FIX ② — SOURCE ID EXTRACTION
// Old regex only matched "@source 1" (with space).
// New one matches @Source1, @doc2.txt, @source_3, etc.
// ─────────────────────────────────────────────

const extractMentionedSourceIds = (promptText) => {
  const ids = new Set();
  // Match @source<digits> with optional space or underscore
  const re1 = /@source[\s_]?(\d+)/ig;
  let m;
  while ((m = re1.exec(promptText)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) ids.add(`SOURCE_${n}`);
  }
  // Match @Source1, @SOURCE2, etc. (no separator)
  const re2 = /@[Ss]ource(\d+)/g;
  while ((m = re2.exec(promptText)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) ids.add(`SOURCE_${n}`);
  }
  return [...ids];
};

// ─────────────────────────────────────────────
// FIX ③ — FULL OPERATION PARSERS
// extractDynamicQuery now returns ALL operation
// types: filter, group, sort, select, count, unique
// ─────────────────────────────────────────────

const extractDynamicQuery = (promptText) => {
  const text = String(promptText || '').trim();
  const lower = text.toLowerCase();

  // Shared: exclusion fields
  const excludeMatch = text.match(
    /without\s+([a-zA-Z0-9_.,\s-]+?)(?:\s+then\s+lookup|$)/i
  );
  const excludeFields = excludeMatch
    ? excludeMatch[1].split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
    : [];

  // Shared: lookup clause
  const lookupMatch = text.match(
    /then\s+lookup\s+([a-zA-Z0-9_.-]+)\s+using\s+([a-zA-Z0-9_.-]+)/i
  );
  const lookup = lookupMatch
    ? { collection: lookupMatch[1], field: lookupMatch[2] }
    : null;

  // ── GROUP ────────────────────────────────────
  const groupMatch =
    text.match(/group\s+([a-zA-Z0-9_.-]+)\s+by\s+([a-zA-Z0-9_.-]+)/i) ||
    text.match(/([a-zA-Z0-9_.-]+)\s+group\s+by\s+([a-zA-Z0-9_.-]+)/i);
  if (groupMatch)
    return { operation: 'group', collection: groupMatch[1], field: groupMatch[2], excludeFields, lookup };

  // ── FILTER ───────────────────────────────────
  const filterMatch =
    text.match(/(?:filter\s+)?([a-zA-Z0-9_.-]+)\s+(?:with|where)\s+([a-zA-Z0-9_.-]+)\s+(?:is\s+)?(.+?)(?:\s+without\s+|\s+then\s+|$)/i) ||
    text.match(/([a-zA-Z0-9_.-]+)\s+([a-zA-Z0-9_.-]+)\s+(?:vala|with|where)\s+(.+?)(?:\s+without\s+|\s+then\s+|$)/i);
  if (filterMatch)
    return { operation: 'filter', collection: filterMatch[1], field: filterMatch[2], value: filterMatch[3].trim(), excludeFields, lookup };

  // ── SORT ─────────────────────────────────────
  const sortMatch = text.match(
    /sort\s+([a-zA-Z0-9_.-]+)\s+by\s+([a-zA-Z0-9_.-]+)\s+(ascending|descending)/i
  );
  if (sortMatch)
    return { operation: 'sort', collection: sortMatch[1], field: sortMatch[2], order: sortMatch[3].toLowerCase(), excludeFields };

  // ── SELECT ───────────────────────────────────
  const selectMatch = text.match(
    /select\s+(.+?)\s+from\s+([a-zA-Z0-9_.-]+)/i
  );
  if (selectMatch) {
    const fields = selectMatch[1].split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    return { operation: 'select', fields, collection: selectMatch[2], excludeFields };
  }

  // ── COUNT ────────────────────────────────────
  const countMatch = text.match(
    /count\s+([a-zA-Z0-9_.-]+)\s+by\s+([a-zA-Z0-9_.-]+)/i
  );
  if (countMatch)
    return { operation: 'count', collection: countMatch[1], field: countMatch[2] };

  // ── UNIQUE ───────────────────────────────────
  const uniqueMatch = text.match(
    /unique\s+([a-zA-Z0-9_.-]+)\s+from\s+([a-zA-Z0-9_.-]+)/i
  );
  if (uniqueMatch)
    return { operation: 'unique', field: uniqueMatch[1], collection: uniqueMatch[2] };

  return null;
};

// ─────────────────────────────────────────────
// COLLECTION HELPERS
// ─────────────────────────────────────────────

/**
 * Find collection items by name, supporting dotted paths like "ecommerce.categories.products"
 * Also propagates parent properties (like brandName from brands to products)
 */
const findCollectionItems = (scope, collectionName) => {
  const items = [];
  const collLower = String(collectionName).toLowerCase();
  
  // Check if it's a dotted path like "ecommerce.categories.products"
  const pathSegments = collLower.split('.');
  const targetCollection = pathSegments[pathSegments.length - 1];
  
  for (const obj of Object.values(scope)) {
    // Track parent context for property propagation
    const traverseWithContext = (node, pathArr, parentContext = {}) => {
      if (Array.isArray(node)) {
        // Check if this array matches our target
        const pathStr = pathArr.join('.').toLowerCase();
        const arrayName = pathArr[pathArr.length - 1]?.toLowerCase() || '';
        
        // Match if: exact path, ends with collection name, or dotted path matches
        let matches = pathStr === collLower || arrayName === targetCollection;
        
        // For dotted paths like "ecommerce.categories.products", check if path contains all segments in order
        if (!matches && pathSegments.length > 1) {
          const pathLower = pathStr.toLowerCase();
          matches = pathSegments.every((seg, i) => {
            if (i === 0) return pathLower.includes(seg);
            const prevIdx = pathLower.indexOf(pathSegments[i - 1]);
            const curIdx = pathLower.indexOf(seg);
            return curIdx > prevIdx;
          });
        }
        
        if (matches) {
          // Add items with parent context properties propagated
          for (const item of node) {
            if (isPlainObject(item)) {
              items.push({ ...parentContext, ...item });
            } else {
              items.push(item);
            }
          }
        }
        
        // Continue traversing array items
        for (let i = 0; i < node.length; i++) {
          traverseWithContext(node[i], [...pathArr, String(i)], parentContext);
        }
        return;
      }
      
      if (isPlainObject(node)) {
        // Build context from this object (non-array, non-object scalar values)
        const newContext = { ...parentContext };
        for (const [k, v] of Object.entries(node)) {
          if (!isPlainObject(v) && !Array.isArray(v)) {
            newContext[k] = v;
          }
        }
        
        for (const [k, v] of Object.entries(node)) {
          traverseWithContext(v, [...pathArr, k], newContext);
        }
      }
    };
    
    traverseWithContext(obj, []);
  }
  return items;
};

const matchesCollection = (pathStr, collLower) =>
  pathStr === collLower || pathStr.endsWith('.' + collLower);

const applyLookup = (item, lookupData, lookupField) => {
  if (!lookupData || !lookupField) return item;
  const lfLower = lookupField.toLowerCase();
  const itemValKey = Object.keys(item).find(k => k.toLowerCase() === lfLower);
  const val = itemValKey ? item[itemValKey] : undefined;
  if (val === undefined) return item;
  const matches = lookupData.filter(li => {
    const liKey = Object.keys(li).find(k => k.toLowerCase() === lfLower);
    return liKey && String(li[liKey]) === String(val);
  });
  if (matches.length === 0) return item;
  if (matches.length === 1) {
    const merged = { ...item };
    for (const [mk, mv] of Object.entries(matches[0]))
      if (!(mk in merged)) merged[mk] = mv;
    return merged;
  }
  return { ...item, _lookup_results: matches };
};

/**
 * Get a nested field value from an object using a dotted path
 * e.g., getNestedValue(item, "profile.stats.rank.tier") -> item.profile.stats.rank.tier
 */
const getNestedValue = (obj, fieldPath) => {
  if (!obj || !fieldPath) return undefined;
  const pathLower = String(fieldPath).toLowerCase();
  const segments = pathLower.split('.');
  
  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (!isPlainObject(current)) return undefined;
    
    // Case-insensitive key lookup
    const actualKey = Object.keys(current).find(k => k.toLowerCase() === seg);
    if (!actualKey) return undefined;
    current = current[actualKey];
  }
  return current;
};

/**
 * Delete a nested field from an object using a dotted path
 * e.g., deleteNestedField(item, "contact.phone") removes item.contact.phone
 */
const deleteNestedField = (obj, fieldPath) => {
  if (!obj || !fieldPath) return obj;
  const result = structuredClone(obj);
  const pathLower = String(fieldPath).toLowerCase();
  const segments = pathLower.split('.');
  
  if (segments.length === 1) {
    // Simple field - delete directly
    const key = Object.keys(result).find(k => k.toLowerCase() === segments[0]);
    if (key) delete result[key];
    return result;
  }
  
  // Navigate to parent of target field
  let current = result;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current === null || current === undefined || !isPlainObject(current)) return result;
    const actualKey = Object.keys(current).find(k => k.toLowerCase() === segments[i]);
    if (!actualKey) return result;
    current = current[actualKey];
  }
  
  // Delete the target field
  if (isPlainObject(current)) {
    const targetSeg = segments[segments.length - 1];
    const actualKey = Object.keys(current).find(k => k.toLowerCase() === targetSeg);
    if (actualKey) delete current[actualKey];
  }
  
  return result;
};

const applyExclusions = (item, excludeFields) => {
  if (!excludeFields || excludeFields.length === 0) return item;
  let out = structuredClone(item);
  for (const f of excludeFields) {
    out = deleteNestedField(out, f);
  }
  return out;
};

// ─────────────────────────────────────────────
// OPERATION EXECUTORS
// ─────────────────────────────────────────────

const execFilter = (root, { collection, field, value, excludeFields, lookup }) => {
  const results = [];
  const collLower = collection.toLowerCase();
  const fieldLower = field.toLowerCase();
  const lookupData = lookup ? findCollectionItems({ _: root }, lookup.collection) : null;

  traverse(root, (node, pathArr) => {
    if (!Array.isArray(node)) return;
    const pathStr = pathArr.join('.').toLowerCase();
    if (!matchesCollection(pathStr, collLower)) return;

    for (let i = 0; i < node.length; i++) {
      let item = node[i];
      if (!isPlainObject(item)) continue;
      const actualKey = Object.keys(item).find(k => k.toLowerCase() === fieldLower);
      if (!actualKey) continue;
      if (String(item[actualKey]).toLowerCase() !== String(value).toLowerCase()) continue;
      item = applyLookup(item, lookupData, lookup?.field);
      item = applyExclusions(item, excludeFields);
      results.push({ path: [...pathArr, String(i)].join('.'), data: item });
    }
  });

  return { operation: 'filter', collection, filter: { field, value }, count: results.length, results };
};

const execGroup = (root, { collection, field, excludeFields, lookup, nestedGroup, sortBy, sortOrder }) => {
  const grouped = {};
  const lookupData = lookup ? findCollectionItems({ _: root }, lookup.collection) : null;

  // Use enhanced findCollectionItems which propagates parent properties
  const items = findCollectionItems({ _: root }, collection);
  
  for (let item of items) {
    if (!isPlainObject(item)) continue;
    
    // Support nested field paths like "profile.stats.rank.tier"
    const groupValue = getNestedValue(item, field);
    if (groupValue === undefined) continue;
    
    const key = String(groupValue);
    if (!grouped[key]) grouped[key] = [];
    item = applyLookup(item, lookupData, lookup?.field);
    item = applyExclusions(item, excludeFields);
    grouped[key].push(item);
  }

  // Apply nested grouping if specified (group by X, then inside each group, group by Y)
  if (nestedGroup && nestedGroup.field) {
    for (const groupKey of Object.keys(grouped)) {
      const nestedGrouped = {};
      for (let item of grouped[groupKey]) {
        const nestedValue = getNestedValue(item, nestedGroup.field);
        if (nestedValue === undefined) continue;
        const nestedKey = String(nestedValue);
        if (!nestedGrouped[nestedKey]) nestedGrouped[nestedKey] = [];
        
        // Apply nested exclusions if any
        if (nestedGroup.excludeFields) {
          item = applyExclusions(item, nestedGroup.excludeFields);
        }
        nestedGrouped[nestedKey].push(item);
      }
      grouped[groupKey] = nestedGrouped;
    }
  }

  // Apply sorting within groups if specified
  if (sortBy) {
    const order = sortOrder === 'desc' || sortOrder === 'descending' ? -1 : 1;
    for (const groupKey of Object.keys(grouped)) {
      if (Array.isArray(grouped[groupKey])) {
        grouped[groupKey].sort((a, b) => {
          const av = getNestedValue(a, sortBy);
          const bv = getNestedValue(b, sortBy);
          const cmp = String(av || '').localeCompare(String(bv || ''), undefined, { numeric: true, sensitivity: 'base' });
          return cmp * order;
        });
      }
    }
  }

  return { operation: 'group', collection, groupBy: field, groups: grouped };
};

const execSort = (root, { collection, field, order }) => {
  const items = findCollectionItems({ _: root }, collection);
  const fieldLower = field.toLowerCase();
  const sorted = [...items].sort((a, b) => {
    const ak = Object.keys(a).find(k => k.toLowerCase() === fieldLower);
    const bk = Object.keys(b).find(k => k.toLowerCase() === fieldLower);
    const av = ak ? a[ak] : '';
    const bv = bk ? b[bk] : '';
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return order === 'descending' ? -cmp : cmp;
  });
  return { operation: 'sort', collection, field, order, count: sorted.length, results: sorted };
};

const execSelect = (root, { collection, fields }) => {
  const items = findCollectionItems({ _: root }, collection);
  const fieldsLower = fields.map(f => f.toLowerCase());
  const projected = items.map(item => {
    const out = {};
    for (const f of fieldsLower) {
      const key = Object.keys(item).find(k => k.toLowerCase() === f);
      if (key) out[key] = item[key];
    }
    return out;
  });
  return { operation: 'select', collection, fields, count: projected.length, results: projected };
};

const execCount = (root, { collection, field }) => {
  const items = findCollectionItems({ _: root }, collection);
  const fieldLower = field.toLowerCase();
  const counts = {};
  for (const item of items) {
    const key = Object.keys(item).find(k => k.toLowerCase() === fieldLower);
    if (!key) continue;
    const val = String(item[key]);
    counts[val] = (counts[val] || 0) + 1;
  }
  return { operation: 'count', collection, field, counts };
};

const execUnique = (root, { collection, field }) => {
  const items = findCollectionItems({ _: root }, collection);
  const fieldLower = field.toLowerCase();
  const seen = new Set();
  for (const item of items) {
    const key = Object.keys(item).find(k => k.toLowerCase() === fieldLower);
    if (key) seen.add(item[key]);
  }
  return { operation: 'unique', collection, field, count: seen.size, values: [...seen] };
};

/**
 * Sum numeric values of a field in a collection
 */
const execSum = (root, { collection, field }) => {
  const items = findCollectionItems({ _: root }, collection);
  let sum = 0;
  let count = 0;
  for (const item of items) {
    const val = getNestedValue(item, field);
    if (val !== undefined && !isNaN(Number(val))) {
      sum += Number(val);
      count++;
    }
  }
  return { operation: 'sum', collection, field, sum, count };
};

/**
 * Calculate average of numeric values
 */
const execAvg = (root, { collection, field }) => {
  const items = findCollectionItems({ _: root }, collection);
  let sum = 0;
  let count = 0;
  for (const item of items) {
    const val = getNestedValue(item, field);
    if (val !== undefined && !isNaN(Number(val))) {
      sum += Number(val);
      count++;
    }
  }
  const avg = count > 0 ? sum / count : 0;
  return { operation: 'avg', collection, field, average: avg, sum, count };
};

/**
 * Limit results to N items
 */
const execLimit = (root, { collection, count: limitCount, field, order }) => {
  let items = findCollectionItems({ _: root }, collection);
  
  // Optional sorting before limiting
  if (field) {
    const multiplier = order === 'desc' || order === 'descending' ? -1 : 1;
    items = [...items].sort((a, b) => {
      const av = getNestedValue(a, field) || '';
      const bv = getNestedValue(b, field) || '';
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return cmp * multiplier;
    });
  }
  
  const limited = items.slice(0, limitCount || 10);
  return { operation: 'limit', collection, requestedLimit: limitCount, count: limited.length, results: limited };
};

/**
 * FIX ④ — Execute ALL operations in order, not just the first.
 * Each result is keyed by its index so the client can correlate.
 */
const executeAllOps = (queries, scope) => {
  const allResults = [];

  for (const q of queries) {
    const op = q.operation;
    const perSource = [];

    for (const [sourceId, obj] of Object.entries(scope)) {
      let result;
      try {
        if (op === 'filter') result = execFilter(obj, q);
        else if (op === 'group') result = execGroup(obj, q);
        else if (op === 'sort') result = execSort(obj, q);
        else if (op === 'select') result = execSelect(obj, q);
        else if (op === 'count') result = execCount(obj, q);
        else if (op === 'unique') result = execUnique(obj, q);
        else if (op === 'sum') result = execSum(obj, q);
        else if (op === 'avg') result = execAvg(obj, q);
        else if (op === 'limit') result = execLimit(obj, q);
        else result = { error: `Unknown operation: ${op}` };
      } catch (e) {
        result = { error: e.message };
      }

      const hasData = result && !result.error &&
        (result.count > 0 || result.results?.length > 0 ||
          (result.groups && Object.keys(result.groups).length > 0) ||
          (result.counts && Object.keys(result.counts).length > 0) ||
          (result.values?.length > 0) ||
          result.sum !== undefined || result.average !== undefined);

      if (hasData) perSource.push({ source_id: sourceId, ...result });
    }

    allResults.push({ query: q, results: perSource });
  }

  return allResults;
};

// ─────────────────────────────────────────────
// FREE-TEXT SEARCH (fallback)
// ─────────────────────────────────────────────

const extractFreeTextQuery = (promptText) => {
  const s = String(promptText || '').trim();
  const q1 = s.match(/(?:q|query|name|value)\s*[:=]\s*["']?([^"'\n]+)["']?/i);
  if (q1?.[1]) return q1[1].trim();

  const q2 = s.match(/(?:search|find|lookup|filter)\s+(.+?)(?:\s+in\s+@source\s*\d+)?$/i);
  if (q2?.[1]) return q2[1].trim();

  const quoted = [...s.matchAll(/"([^"]{3,})"/g)].map(m => m[1]);
  if (quoted.length > 0) return [...quoted].sort((a, b) => b.length - a.length)[0].trim();

  const q3 = s.match(/\b([A-Za-z0-9._-]{3,})\b\s*(?:apo|aapo|get|aap)\b/i);
  if (q3?.[1]) return q3[1].trim();

  return null;
};

const searchJson = (root, query, { maxResults = 200 } = {}) => {
  const q = String(query || '').toLowerCase();
  const results = [];
  traverse(root, (node, pathArr) => {
    if (results.length >= maxResults) return;
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (node.toLowerCase().includes(q))
        results.push({ path: pathArr.join('.'), type: 'string', value: node });
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      if (String(node).includes(q))
        results.push({ path: pathArr.join('.'), type: typeof node, value: node });
      return;
    }
    if (isPlainObject(node)) {
      for (const k of Object.keys(node)) {
        if (results.length >= maxResults) break;
        if (k.toLowerCase().includes(q))
          results.push({ path: [...pathArr, k].join('.'), type: 'key', value: k });
      }
    }
  });
  return { query, count: results.length, truncated: results.length >= maxResults, results };
};

// ─────────────────────────────────────────────
// MERGE PLAN (unchanged structure, but now runs
// on a standardized prompt — FIX ⑥)
// ─────────────────────────────────────────────

const validatePlan = (plan, sourceIds) => {
  if (!isPlainObject(plan)) throw new Error('Plan must be a JSON object');
  if (plan.error) return;
  if (plan.plan_version !== 1) throw new Error('Unsupported plan_version');
  if (typeof plan.root_source_id !== 'string') throw new Error('root_source_id missing');
  if (!sourceIds.includes(plan.root_source_id))
    throw new Error(`root_source_id not found: ${plan.root_source_id}`);
  if (!Array.isArray(plan.steps)) throw new Error('steps must be an array');
  for (const step of plan.steps) {
    if (!isPlainObject(step)) throw new Error('Each step must be an object');
    if (step.action !== 'embed') throw new Error('Only action=embed is supported');
    if (!sourceIds.includes(step.parent_source_id))
      throw new Error(`parent_source_id not found: ${step.parent_source_id}`);
    if (!sourceIds.includes(step.child_source_id))
      throw new Error(`child_source_id not found: ${step.child_source_id}`);
    if (step.embed_mode !== 'merge_keys') throw new Error('Only embed_mode=merge_keys is supported');
    if (!Array.isArray(step.anchor_path) || step.anchor_path.length === 0)
      throw new Error('anchor_path must be a non-empty array');
  }
};

const executeMergePlan = async (plan, sources, prompt) => {
  const sourceIds = Object.keys(sources);
  validatePlan(plan, sourceIds);

  if (plan.error) return { error: 'Planner could not create a reliable plan', plan };

  const live = {};
  for (const [id, obj] of Object.entries(sources)) live[id] = structuredClone(obj);

  for (const step of plan.steps) {
    const parent = live[step.parent_source_id];
    const child = live[step.child_source_id];

    // CORRECT the anchor_path by finding the actual path in the parent object
    const correctedPath = correctAnchorPath(parent, step.anchor_path);
    if (correctedPath.join('.') !== step.anchor_path.join('.')) {
      step.anchor_path = correctedPath;
    }

    // Resolve anchor_path — auto-create missing or non-object segments
    let anchor;
    try {
      anchor = getAtPath(parent, step.anchor_path);
    } catch (pathErr) {
      // Path doesn't exist at all — auto-create it as an empty object
      anchor = null;
    }

    if (anchor === null || anchor === undefined || !isPlainObject(anchor)) {
      // anchor is either missing or a primitive (e.g. tracking number string).
      // Auto-create an object at that path so the child can be embedded there.
      const existingValue = anchor; // preserve original value if it was a primitive
      setAtPath(parent, step.anchor_path, {});
      anchor = getAtPath(parent, step.anchor_path);
      if (existingValue !== null && existingValue !== undefined && !isPlainObject(existingValue) && !Array.isArray(existingValue)) {
        // Keep the original primitive under a "_value" key so no data is lost
        anchor._value = existingValue;
      } else if (Array.isArray(existingValue)) {
        anchor._items = existingValue;
      }
      console.log(`[MERGE] Step ${step.step}: anchor_path auto-created at ${JSON.stringify(step.anchor_path)} in ${step.parent_source_id}`);
    }

    for (const [k, v] of Object.entries(child)) {
      anchor[k] = k in anchor ? deepMerge(anchor[k], v) : v;
    }
  }

  const mergedRoot = live[plan.root_source_id];
  return deepDeduplicate(mergedRoot);
};

// ─────────────────────────────────────────────
// JOIN PLAN EXECUTOR
// Connects collections across sources by matching field values
// ─────────────────────────────────────────────

const collectArrayByName = (data, arrayName) => {
  const items = [];
  const target = arrayName.toLowerCase();
  traverse(data, (node, pathArr) => {
    if (!Array.isArray(node)) return;
    const key = pathArr[pathArr.length - 1];
    if (key && key.toLowerCase() === target) {
      items.push(...node.filter(isPlainObject));
    }
  });
  return items;
};

const executeJoinPlan = (plan, sources) => {
  if (!plan || plan.mode !== 'join') throw new Error('Invalid join plan');
  if (!sources[plan.root_source_id]) throw new Error(`root_source_id ${plan.root_source_id} not found`);
  if (!Array.isArray(plan.joins) || plan.joins.length === 0) throw new Error('No joins defined');

  const result = structuredClone(sources[plan.root_source_id]);

  for (const join of plan.joins) {
    // Get child items from original source
    const childData = sources[join.child_source_id];
    if (!childData) throw new Error(`Step ${join.step}: child_source_id ${join.child_source_id} not found`);
    const childItems = collectArrayByName(childData, join.child_array);

    if (childItems.length === 0) {
      console.warn(`[JOIN] Step ${join.step}: No items found for "${join.child_array}" in ${join.child_source_id}`);
      continue;
    }

    // Find all parent arrays in the RESULT tree (includes previously joined data)
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
          // Handle array-of-IDs matching (e.g. projectIds: ["PROJ_1", "PROJ_2"])
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

    console.log(`[JOIN] Step ${join.step}: ${join.parent_array}.${join.parent_field} -> ${join.child_array}.${join.child_field} | ${matched} matched`);
  }

  return result;
};

// ─────────────────────────────────────────────
// POST-MERGE TRANSFORMS (unchanged)
// ─────────────────────────────────────────────

const alphaIndexStrings = (items, order = 'asc') => {
  const sorted = [...items].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
  if (order === 'desc') sorted.reverse();
  const index = {};
  for (const item of sorted) {
    const letter = (item?.[0] || '#').toUpperCase();
    if (!index[letter]) index[letter] = [];
    index[letter].push(item);
  }
  return { order, sorted, index };
};

const applyPromptTransforms = (root, promptText) => {
  const p = (promptText || '').toLowerCase();
  const order = p.includes('descending') ? 'desc' : 'asc';

  if (p.includes('grouped analytics')) {
    const out = [];
    traverse(root, (node, pathArr) => {
      const last = pathArr[pathArr.length - 1];
      if (last === 'analytics' && isPlainObject(node))
        out.push({ path: pathArr.join('.'), value: node });
    });
    root.__grouped_analytics = { count: out.length, analytics: out };
  }

  if (p.includes('categories') && p.includes('alphabetically')) {
    const indexed = [];
    traverse(root, (node, pathArr) => {
      if (!isPlainObject(node) || !isStringArray(node.categories)) return;
      indexed.push({ path: [...pathArr, 'categories'].join('.'), index: alphaIndexStrings(node.categories, order) });
    });
    root.__categories_indexed = { order, items: indexed };
  }

  return root;
};

// ─────────────────────────────────────────────
// UNIFIED AI PIPELINE EXECUTOR
// LLM generates complete execution plan from prompt
// ─────────────────────────────────────────────

/**
 * Execute a single transform operation on the result
 * @param {object} result - The merged/transformed result
 * @param {object} op - The operation to execute
 * @param {object} allSources - All original sources (for finding collections not in result)
 */
const executeTransformOp = (result, op, allSources = {}) => {
  const opType = op.op?.toLowerCase();

  // Helper to find collection items - search in result first, then in all sources
  const findItems = (collection) => {
    // Try to find in result first
    let items = findCollectionItems({ _: result }, collection);
    if (items.length > 0) return items;

    // If not found, search in all sources
    for (const [sourceId, sourceObj] of Object.entries(allSources)) {
      items = findCollectionItems({ _: sourceObj }, collection);
      if (items.length > 0) {
        console.log(`[TRANSFORM] Found "${collection}" in ${sourceId} with ${items.length} items`);
        return items;
      }
    }
    return [];
  };

  switch (opType) {
    case 'sort': {
      const items = findItems(op.collection);
      if (items.length === 0) return { op: opType, status: 'no_items', collection: op.collection };

      // Apply filter_where first if present
      let filtered = items;
      if (op.filter_where) {
        const fw = op.filter_where;
        filtered = items.filter(item => {
          // Support nested paths in filter_where
          const val = getNestedValue(item, fw.field);
          return val !== undefined && String(val).toLowerCase() === String(fw.value).toLowerCase();
        });
      }

      // Support nested field paths for sorting
      const sortField = op.field || '';
      const sorted = [...filtered].sort((a, b) => {
        const av = getNestedValue(a, sortField) || '';
        const bv = getNestedValue(b, sortField) || '';
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
        return op.order === 'desc' ? -cmp : cmp;
      });
      return { op: opType, collection: op.collection, count: sorted.length, results: sorted };
    }

    case 'filter': {
      const items = findItems(op.collection);
      const filterField = op.field || '';
      const excludeFields = op.exclude_fields || op.excludeFields || [];
      
      let filtered = items.filter(item => {
        // Support nested paths in filter field
        const val = getNestedValue(item, filterField);
        if (val === undefined) return false;
        if (typeof op.value === 'boolean') return val === op.value;
        return String(val).toLowerCase() === String(op.value).toLowerCase();
      });
      
      // Apply field exclusions
      if (excludeFields.length > 0) {
        filtered = filtered.map(item => applyExclusions(item, excludeFields));
      }
      
      return { op: opType, collection: op.collection, count: filtered.length, results: filtered };
    }

    case 'group': {
      const items = findItems(op.collection);
      const byField = op.by || '';
      const excludeFields = op.exclude_fields || op.excludeFields || [];
      let groups = {};
      
      for (let item of items) {
        // Support nested field paths like "profile.stats.rank.tier"
        const groupValue = getNestedValue(item, byField);
        if (groupValue === undefined) continue;
        
        const groupKey = String(groupValue);
        if (!groups[groupKey]) groups[groupKey] = [];
        
        // Apply field exclusions
        if (excludeFields.length > 0) {
          item = applyExclusions(item, excludeFields);
        }
        groups[groupKey].push(item);
      }
      
      // Apply nested grouping if specified (group by X, then inside each group, group by Y)
      if (op.nested_group || op.nestedGroup) {
        const nested = op.nested_group || op.nestedGroup;
        for (const groupKey of Object.keys(groups)) {
          const nestedGroups = {};
          for (let item of groups[groupKey]) {
            const nestedValue = getNestedValue(item, nested.by || nested.field);
            if (nestedValue === undefined) continue;
            const nestedKey = String(nestedValue);
            if (!nestedGroups[nestedKey]) nestedGroups[nestedKey] = [];
            
            // Apply nested exclusions
            if (nested.exclude_fields) {
              item = applyExclusions(item, nested.exclude_fields);
            }
            nestedGroups[nestedKey].push(item);
          }
          groups[groupKey] = nestedGroups;
        }
      }
      
      // Apply sorting within groups if specified
      if (op.sort_by || op.sortBy) {
        const sortField = op.sort_by || op.sortBy;
        const order = (op.sort_order || op.sortOrder || 'asc').toLowerCase();
        const multiplier = order === 'desc' || order === 'descending' ? -1 : 1;
        
        for (const groupKey of Object.keys(groups)) {
          if (Array.isArray(groups[groupKey])) {
            groups[groupKey].sort((a, b) => {
              const av = getNestedValue(a, sortField);
              const bv = getNestedValue(b, sortField);
              const cmp = String(av || '').localeCompare(String(bv || ''), undefined, { numeric: true, sensitivity: 'base' });
              return cmp * multiplier;
            });
          }
        }
      }
      
      return { op: opType, collection: op.collection, by: byField, groups };
    }

    case 'unique': {
      const items = findItems(op.collection);
      const fieldLower = (op.field || '').toLowerCase();
      const seen = new Set();
      for (const item of items) {
        const key = Object.keys(item).find(k => k.toLowerCase() === fieldLower);
        if (key) seen.add(item[key]);
      }
      return { op: opType, collection: op.collection, field: op.field, values: [...seen] };
    }

    case 'count': {
      const items = findItems(op.collection);
      const fieldLower = (op.by || '').toLowerCase();
      const counts = {};
      for (const item of items) {
        const key = Object.keys(item).find(k => k.toLowerCase() === fieldLower);
        if (!key) continue;
        const val = String(item[key]);
        counts[val] = (counts[val] || 0) + 1;
      }
      return { op: opType, collection: op.collection, by: op.by, counts };
    }

    case 'select': {
      const items = findItems(op.collection);
      const fieldsLower = (op.fields || []).map(f => f.toLowerCase());
      const projected = items.map(item => {
        const out = {};
        for (const f of fieldsLower) {
          const key = Object.keys(item).find(k => k.toLowerCase() === f);
          if (key) out[key] = item[key];
        }
        return out;
      });
      return { op: opType, collection: op.collection, count: projected.length, results: projected };
    }

    case 'deduplicate': {
      const items = findItems(op.collection);
      const keyField = (op.by || 'id').toLowerCase();
      const seen = new Set();
      const deduped = items.filter(item => {
        const key = Object.keys(item).find(k => k.toLowerCase() === keyField);
        if (!key) return true;
        const val = String(item[key]);
        if (seen.has(val)) return false;
        seen.add(val);
        return true;
      });
      return { op: opType, collection: op.collection, original: items.length, deduplicated: deduped.length, results: deduped };
    }

    case 'sum': {
      const items = findItems(op.collection);
      const field = op.field || '';
      let sum = 0;
      let count = 0;
      for (const item of items) {
        const val = getNestedValue(item, field);
        if (val !== undefined && !isNaN(Number(val))) {
          sum += Number(val);
          count++;
        }
      }
      return { op: opType, collection: op.collection, field, sum, count };
    }

    case 'avg': {
      const items = findItems(op.collection);
      const field = op.field || '';
      let sum = 0;
      let count = 0;
      for (const item of items) {
        const val = getNestedValue(item, field);
        if (val !== undefined && !isNaN(Number(val))) {
          sum += Number(val);
          count++;
        }
      }
      const avg = count > 0 ? sum / count : 0;
      return { op: opType, collection: op.collection, field, average: avg, sum, count };
    }

    case 'limit': {
      let items = findItems(op.collection);
      const limitCount = op.count || 10;
      
      // Optional sorting before limiting
      if (op.field) {
        const multiplier = (op.order === 'desc' || op.order === 'descending') ? -1 : 1;
        items = [...items].sort((a, b) => {
          const av = getNestedValue(a, op.field) || '';
          const bv = getNestedValue(b, op.field) || '';
          const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
          return cmp * multiplier;
        });
      }
      
      const limited = items.slice(0, limitCount);
      return { op: opType, collection: op.collection, requestedLimit: limitCount, count: limited.length, results: limited };
    }

    case 'min': {
      const items = findItems(op.collection);
      const field = op.field || '';
      let min = null;
      let minItem = null;
      for (const item of items) {
        const val = getNestedValue(item, field);
        if (val !== undefined && !isNaN(Number(val))) {
          const numVal = Number(val);
          if (min === null || numVal < min) {
            min = numVal;
            minItem = item;
          }
        }
      }
      return { op: opType, collection: op.collection, field, min, item: minItem };
    }

    case 'max': {
      const items = findItems(op.collection);
      const field = op.field || '';
      let max = null;
      let maxItem = null;
      for (const item of items) {
        const val = getNestedValue(item, field);
        if (val !== undefined && !isNaN(Number(val))) {
          const numVal = Number(val);
          if (max === null || numVal > max) {
            max = numVal;
            maxItem = item;
          }
        }
      }
      return { op: opType, collection: op.collection, field, max, item: maxItem };
    }

    case 'flatten': {
      // Flatten nested object at a path into top level
      const pathArr = (op.path || '').split('.');
      let target = result;
      for (const seg of pathArr) {
        if (!target || typeof target !== 'object') break;
        target = target[seg];
      }
      if (isPlainObject(target)) {
        const flatKey = op.target || '__flattened';
        result[flatKey] = target;
        return { op: opType, path: op.path, target: flatKey, keys: Object.keys(target) };
      }
      return { op: opType, path: op.path, status: 'path_not_found' };
    }

    case 'depth_count': {
      // Calculate maximum nesting depth recursively
      const calcDepth = (obj, depth = 0) => {
        if (!isPlainObject(obj) && !Array.isArray(obj)) return depth;
        let maxDepth = depth;
        const items = Array.isArray(obj) ? obj : Object.values(obj);
        for (const item of items) {
          maxDepth = Math.max(maxDepth, calcDepth(item, depth + 1));
        }
        return maxDepth;
      };
      const depth = calcDepth(result);
      result.__depth_count = depth;
      return { op: opType, maxDepth: depth };
    }

    case 'aggregate': {
      // Create a summary object
      const summary = {
        name: op.name || 'analytics',
        timestamp: new Date().toISOString(),
        include: op.include || []
      };
      // Collect referenced data
      for (const key of (op.include || [])) {
        if (result[key] !== undefined) summary[key] = result[key];
        if (result[`__${key}`] !== undefined) summary[key] = result[`__${key}`];
      }
      result[`__${op.name || 'aggregate'}`] = summary;
      return { op: opType, name: op.name, keys: Object.keys(summary) };
    }

    case 'custom': {
      // Log custom operations for manual review
      return { op: 'custom', description: op.description, status: 'logged_for_review' };
    }

    default:
      return { op: opType, status: 'unknown_operation' };
  }
};

/**
 * Execute the unified AI-generated pipeline plan
 */
const executeUnifiedPipeline = async (plan, sources, sourceNames) => {
  let result = null;
  const pipelineLog = [];
  
  // Keep track of live sources that get modified during pipeline
  const liveSources = {};
  for (const [id, obj] of Object.entries(sources)) {
    liveSources[id] = structuredClone(obj);
  }

  // Collect ALL merge steps from ALL merge stages into one plan
  // This ensures cascading embeds work correctly (each embed sees previous changes)
  const allMergeSteps = [];
  const otherStages = [];
  
  for (const stage of (plan.stages || [])) {
    if (stage.type === 'merge' && Array.isArray(stage.steps)) {
      allMergeSteps.push(...stage.steps);
      pipelineLog.push({ stage: stage.stage, type: 'merge', steps: stage.steps.length, status: 'collected' });
    } else {
      otherStages.push(stage);
    }
  }

  // Execute all merge steps together so the live object accumulates all changes
  // IMPORTANT: Reverse the steps for cascading embeds to work correctly
  // When A embeds B, B embeds C, C embeds D: we must embed D→C→B→A so each parent gets the full child
  if (allMergeSteps.length > 0) {
    // Reverse the steps so inner embeds happen first
    const reversedSteps = [...allMergeSteps].reverse();
    console.log(`[PIPELINE] Executing ${reversedSteps.length} merge steps (reversed for cascading)`);
    
    const consolidatedPlan = {
      plan_version: 1,
      root_source_id: plan.root_source_id,
      steps: reversedSteps.map((s, i) => ({
        step: i + 1,
        action: s.action || 'embed',
        parent_source_id: s.parent_source_id,
        child_source_id: s.child_source_id,
        anchor_path: s.anchor_path,
        embed_mode: s.embed_mode || 'merge_keys'
      }))
    };

    try {
      result = await executeMergePlan(consolidatedPlan, liveSources, '');
      liveSources[plan.root_source_id] = result;
      pipelineLog.push({ stage: 'merge_consolidated', type: 'merge', steps: allMergeSteps.length, status: 'success' });
    } catch (e) {
      console.error('[PIPELINE] Merge failed:', e.message);
      pipelineLog.push({ stage: 'merge_consolidated', type: 'merge', error: e.message });
      result = liveSources[plan.root_source_id];
    }
  }

  // Execute remaining stages (join, transform)
  for (const stage of otherStages) {
    console.log(`[PIPELINE] Executing stage ${stage.stage}: ${stage.type} - ${stage.description || ''}`);

    if (stage.type === 'join' && Array.isArray(stage.joins)) {
      // Execute join steps - use result or liveSources
      const joinSources = result ? { RESULT: result, ...liveSources } : liveSources;

      const joinPlan = {
        mode: 'join',
        root_source_id: result ? 'RESULT' : plan.root_source_id,
        joins: stage.joins.map((j, i) => ({
          step: i + 1,
          parent_array: j.parent_array,
          child_source_id: j.child_source_id,
          child_array: j.child_array,
          parent_field: j.parent_field,
          child_field: j.child_field,
          embed_as: j.embed_as,
          embed_type: j.embed_type || 'array'
        }))
      };

      try {
        result = executeJoinPlan(joinPlan, joinSources);
        pipelineLog.push({ stage: stage.stage, type: 'join', joins: stage.joins.length, status: 'success' });
      } catch (e) {
        pipelineLog.push({ stage: stage.stage, type: 'join', error: e.message });
      }
    }

    if (stage.type === 'transform' && Array.isArray(stage.operations)) {
      // Execute transform operations
      if (!result) result = liveSources[plan.root_source_id];
      if (!result) continue;

      const transformResults = [];
      for (const op of stage.operations) {
        try {
          const opResult = executeTransformOp(result, op, liveSources);
          transformResults.push(opResult);
        } catch (e) {
          transformResults.push({ op: op.op, error: e.message });
        }
      }

      result.__transforms = transformResults;
      pipelineLog.push({ stage: stage.stage, type: 'transform', operations: stage.operations.length, status: 'success' });
    }
  }

  // If no stages produced a result, use root source
  if (!result) {
    result = liveSources[plan.root_source_id] || Object.values(liveSources)[0];
  }

  return { result, pipelineLog };
};

/**
 * Generate and execute a unified pipeline using AI
 */
const runUnifiedPipeline = async (prompt, sources, sourceNames, openai) => {
  // Compress sources for AI
  const compressedInput = Object.entries(sources).map(([id, obj]) => {
    const name = sourceNames[id] || id;
    return `### DATA SOURCE: ${name} (ID: ${id})\n${JSON.stringify(compressJson(obj), null, 2)}`;
  }).join('\n\n');

  // Call AI to generate complete pipeline plan
  const completion = await openai.chat.completions.create({
    model: AI_MODEL_MERGE,
    messages: [
      { role: 'system', content: PIPELINE_INSTRUCTIONS },
      {
        role: 'user',
        content: `## USER PROMPT\n${prompt}\n\n## DATA SOURCES (schema only - keys preserved, values replaced with type placeholders)\n${compressedInput}`
      }
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 3000
  });

  const planText = completion.choices[0].message.content.trim();
  console.log('\n--- [UNIFIED PIPELINE PLAN] ---\n', planText, '\n--------------------\n');

  let plan;
  try {
    plan = JSON.parse(planText);
  } catch (e) {
    throw new Error(`AI returned invalid pipeline plan: ${e.message}`);
  }

  if (plan.error) {
    throw new Error(`AI could not create plan: ${plan.error}`);
  }

  // Execute the AI-generated plan
  const { result, pipelineLog } = await executeUnifiedPipeline(plan, sources, sourceNames);

  // Write debug files in dev mode
  if (!IS_PROD) {
    await fs.writeFile(path.join(process.cwd(), 'debug_pipeline_plan.json'), planText).catch(() => {});
    await fs.writeFile(path.join(process.cwd(), 'debug_pipeline_result.json'), JSON.stringify(result, null, 2)).catch(() => {});
  }

  return {
    mode: 'unified_pipeline',
    plan: plan,
    pipelineLog,
    data: result
  };
};

// Legacy pipeline executor (for backward compatibility with simple prompts)
const applyQueryOpsToResult = (result, queryOps) => {
  if (!queryOps || queryOps.length === 0) return result;

  const transforms = [];

  for (const qStr of queryOps) {
    const parsed = extractDynamicQuery(qStr);
    if (!parsed) continue;

    const op = parsed.operation;
    let opResult;

    try {
      if (op === 'filter') opResult = execFilter(result, parsed);
      else if (op === 'group') opResult = execGroup(result, parsed);
      else if (op === 'sort') opResult = execSort(result, parsed);
      else if (op === 'select') opResult = execSelect(result, parsed);
      else if (op === 'count') opResult = execCount(result, parsed);
      else if (op === 'unique') opResult = execUnique(result, parsed);
      else continue;

      transforms.push({ operation: op, query: qStr, result: opResult });
    } catch (e) {
      transforms.push({ operation: op, query: qStr, error: e.message });
    }
  }

  if (transforms.length > 0) {
    result.__transforms = transforms;
  }

  return result;
};

const executePipeline = async (ops, sources, sourceNames, prompt, openai) => {
  // For complex prompts, use unified AI pipeline
  const totalOps = ops.merge.length + ops.join.length + ops.query.length;
  const isComplex = totalOps >= 3 || prompt.toLowerCase().includes('then:') || prompt.includes('\n-');

  if (isComplex && PIPELINE_INSTRUCTIONS) {
    console.log('[PIPELINE] Using unified AI planner for complex prompt');
    return runUnifiedPipeline(prompt, sources, sourceNames, openai);
  }

  // Simple pipeline: execute stages in order
  let result = null;
  const pipelineLog = [];

  // ── STAGE 1: MERGE ──────────────────────────
  if (ops.merge.length > 0) {
    const mergePrompt = ops.merge.join('\n');
    const compressedInput = Object.entries(sources).map(([id, obj]) => {
      const name = sourceNames[id] || id;
      return `### DATA SOURCE: ${name} (ID: ${id})\n${JSON.stringify(compressJson(obj), null, 2)}`;
    }).join('\n\n');

    const completion = await openai.chat.completions.create({
      model: AI_MODEL_MERGE,
      messages: [
        { role: 'system', content: MERGE_INSTRUCTIONS },
        { role: 'user', content: `## USER PROMPT\n${mergePrompt}\n\n## DATA SOURCES\n${compressedInput}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2000
    });

    const plan = JSON.parse(completion.choices[0].message.content.trim());
    console.log('\n--- [PIPELINE:MERGE] ---\n', JSON.stringify(plan, null, 2), '\n--------------------\n');
    
    if (plan.mode === 'extract') {
      result = plan.data;
    } else {
      result = await executeMergePlan(plan, sources, prompt);
    }
    pipelineLog.push({ stage: 'merge', steps: plan.steps?.length || 0 });
  }

  // ── STAGE 2: JOIN ───────────────────────────
  if (ops.join.length > 0) {
    const joinSources = result ? { MERGED: result, ...sources } : sources;
    const joinSourceNames = result ? { MERGED: 'Merged Result', ...sourceNames } : sourceNames;

    const compressedInput = Object.entries(joinSources).map(([id, obj]) => {
      const name = joinSourceNames[id] || id;
      return `### DATA SOURCE: ${name} (ID: ${id})\n${JSON.stringify(compressJson(obj), null, 2)}`;
    }).join('\n\n');

    const joinCompletion = await openai.chat.completions.create({
      model: AI_MODEL_MERGE,
      messages: [
        { role: 'system', content: JOIN_INSTRUCTIONS },
        { role: 'user', content: `## USER PROMPT\n${ops.join.join('\n')}\n\n## DATA SOURCES\n${compressedInput}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2000
    });

    const joinPlan = JSON.parse(joinCompletion.choices[0].message.content.trim());
    console.log('\n--- [PIPELINE:JOIN] ---\n', JSON.stringify(joinPlan, null, 2), '\n--------------------\n');

    if (joinPlan.mode === 'join' && Array.isArray(joinPlan.joins)) {
      result = executeJoinPlan(joinPlan, joinSources);
      pipelineLog.push({ stage: 'join', steps: joinPlan.joins.length });
    }
  }

  // ── STAGE 3: QUERY TRANSFORMS ───────────────
  if (ops.query.length > 0 && result) {
    result = applyQueryOpsToResult(result, ops.query);
    pipelineLog.push({ stage: 'query', operations: ops.query.length });
  }

  if (!result && ops.query.length > 0) {
    const dynamicQueries = [];
    for (const s of ops.query) {
      const parsed = extractDynamicQuery(s);
      if (parsed) { parsed.raw = s; dynamicQueries.push(parsed); }
    }
    if (dynamicQueries.length > 0) {
      const allResults = executeAllOps(dynamicQueries, sources);
      return { mode: 'query', pipeline: pipelineLog, operations: allResults };
    }
  }

  if (!result) {
    throw new Error('Pipeline produced no result. Check your prompt structure.');
  }

  applyPromptTransforms(result, prompt);

  return { mode: 'pipeline', pipeline: pipelineLog, data: result };
};

// ─────────────────────────────────────────────
// MAIN ROUTE
// ─────────────────────────────────────────────

app.post('/api/convert', upload.array('files'), async (req, res) => {
  let { jsonInputs, prompt } = req.body;

  console.log('\n--- [RECEIVED] ---');
  console.log('Prompt:', prompt);
  console.log('------------------\n');

  let parsedInputs = [];
  try {
    parsedInputs = JSON.parse(jsonInputs || '[]');
  } catch (e) {
    console.error('JSON parse error', e);
  }

  if (!Array.isArray(parsedInputs) || parsedInputs.length === 0)
    return res.status(400).json({ error: 'No input sources provided' });
  if (!prompt?.trim())
    return res.status(400).json({ error: 'Prompt is required' });

  // Build source registry
  const sources = {};
  const sourceNames = {};
  const optimizedBlocks = [];

  for (let i = 0; i < parsedInputs.length; i++) {
    const input = parsedInputs[i] || {};
    let content = (input.content || '').trim();
    const name = input.name || `Source ${i + 1}`;

    if (!content && req.files?.length > 0) {
      const file = req.files.find(f => f.originalname === name);
      if (file) content = file.buffer.toString('utf-8').trim();
    }

    if (!content) return res.status(400).json({ error: `Missing content for ${name}` });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return res.status(400).json({ error: `Invalid JSON in ${name}`, details: e.message });
    }

    const sourceId = `SOURCE_${i + 1}`;
    sources[sourceId] = parsed;
    sourceNames[sourceId] = name;
    const clean = JSON.stringify(parsed, null, 2);
    console.log(`[SOURCE] ${sourceId} = ${name} (${clean.length} chars)`);
    optimizedBlocks.push(`### DATA SOURCE: ${name} (ID: ${sourceId})\n${clean}`);
  }

  const optimizedInput = optimizedBlocks.join('\n\n');

  try {
    // ─────────────────────────────────────────
    // BARE SOURCE REQUEST — only "@Source 1" or "source 2" alone
    // These are so simple they don't need LLM
    // ─────────────────────────────────────────

    const bareSourceMatch = prompt.trim().match(/^@?source\s*(\d+)\s*$/i);
    if (bareSourceMatch) {
      const sourceNum = Number(bareSourceMatch[1]);
      const sourceId = `SOURCE_${sourceNum}`;
      if (sources[sourceId]) {
        console.log(`[BARE SOURCE] Returning ${sourceId} directly`);
        return res.json(sources[sourceId]);
      }
    }

    // ─────────────────────────────────────────
    // LLM-POWERED PROMPT UNDERSTANDING
    // All other prompts go through LLM for understanding
    // ─────────────────────────────────────────

    console.log(`[LLM] Enhancing prompt: "${prompt}"`);
    
    // Build compressed schema for LLM
    const compressedSources = Object.entries(sources).map(([id, obj]) => {
      const name = sourceNames[id] || id;
      return `### ${name} (ID: ${id})\n${JSON.stringify(compressJson(obj), null, 2)}`;
    }).join('\n\n');

    // Ask LLM to understand the prompt and return a structured plan
    const understandingPrompt = `You are a JSON data assistant. Analyze what the user wants and return a JSON execution plan.

USER REQUEST: ${prompt}

AVAILABLE DATA SOURCES:
${compressedSources}

ACTIONS YOU CAN RETURN:

1. EXTRACT - Get data from a specific path in a source
{ "action": "extract", "source_id": "SOURCE_N", "path": ["key1", "key2", ...], "description": "..." }
- Use empty path [] to get entire source
- Use "index": N to get Nth element from array

2. COLLECT - Gather all arrays with a specific name into one flat array  
{ "action": "collect", "source_id": "SOURCE_N", "array_name": "arrayName", "description": "..." }

3. COMPOSE - Build a NEW custom object with user-defined keys
{ "action": "compose", "parts": [
  { "key": "userDefinedKey", "source_id": "SOURCE_N", "type": "collect|path|entire", "array_name": "...", "path": [...] }
], "description": "..." }
- type "collect": gather all arrays named array_name
- type "path": extract from specific path  
- type "entire": include entire source

4. QUERY - Filter/sort/group/count/unique/select/aggregate operations
{ "action": "query", "operations": [
  { "op": "group", "collection": "tasks", "by": "status" },
  { "op": "group", "collection": "products", "by": "pricing.currency", "exclude_fields": ["reserved"] },
  { "op": "group", "collection": "players", "by": "profile.stats.rank.tier", "sort_by": "score", "sort_order": "desc" },
  { "op": "group", "collection": "tasks", "by": "status", "nested_group": { "by": "employee.role" } },
  { "op": "filter", "collection": "departments", "field": "name", "value": "Engineering" },
  { "op": "sort", "collection": "items", "field": "price", "order": "desc" },
  { "op": "count", "collection": "tasks", "by": "status" },
  { "op": "unique", "collection": "tasks", "field": "status" },
  { "op": "select", "collection": "users", "fields": ["name", "email"] },
  { "op": "sum", "collection": "orders", "field": "amount" },
  { "op": "avg", "collection": "products", "field": "price" },
  { "op": "limit", "collection": "results", "count": 10 }
] }

OPERATION TYPES:
- "group": Group items by field. Supports nested paths, sorting within groups, field exclusions.
- "filter": Keep items matching condition. field + value required.
- "sort": Sort collection by field. order = "asc" or "desc".
- "count": Count items per unique value of a field. Returns { counts: { value1: N, value2: M } }.
- "unique": Get distinct values of a field. Returns { values: [...] }.
- "select": Project only specific fields from items.
- "sum": Sum numeric values of a field.
- "avg": Calculate average of numeric field.
- "limit": Limit results to N items.

GROUP OPERATION SYNTAX:
- "by": Field to group by. Supports nested paths like "profile.stats.rank.tier"
- "exclude_fields": Fields to remove. Supports nested paths like ["contact.phone"]
- "sort_by" + "sort_order": Sort items within each group
- "nested_group": { "by": "field" } - Group again inside each group

COLLECTION PATH PATTERNS:
- "Group company.departments.projects.modules.tasks by status" → collection = "tasks", by = "status"
- "Group products by pricing.currency" → collection = "products", by = "pricing.currency"
- "without medications" → exclude_fields = ["medications"]
- "Count tasks by status" → op = "count", collection = "tasks", by = "status"
- "Get unique status from tasks" → op = "unique", collection = "tasks", field = "status"

5. MERGE - Combine entire source structures into one tree
{ "action": "merge", "description": "..." }

6. ERROR - When request is unclear or field doesn't exist
{ "action": "error", "message": "..." }

DECISION LOGIC:
- "count X by Y" or "how many X per Y" → QUERY with op="count"
- "unique/distinct values of X" → QUERY with op="unique"
- "sum/total of X" → QUERY with op="sum"
- "average of X" → QUERY with op="avg"
- "first N" or "limit N" → QUERY with op="limit"
- User wants to GROUP/FILTER/SORT data → QUERY
- User wants to BUILD/CREATE a new object with specific keys → COMPOSE
- User wants to get/access specific data from one source → EXTRACT  
- User wants all instances of X combined into one array → COLLECT
- User wants to EMBED/ADD sources into each other at specific paths → MERGE
- User mentions multiple sources with hierarchical embedding instructions → MERGE
- User specifies a "main object" or "root" with other sources to be added → MERGE
- Look at the DATA SOURCES schema to find correct paths
- @Source 1, @Source1, Source 1 = SOURCE_1
- Be flexible with key names - find closest match in schema
- If a field doesn't exist, still try the operation - let the executor handle gracefully

Return ONLY valid JSON.`;

    const understandingResponse = await openai.chat.completions.create({
      model: AI_MODEL_LIGHT,
      messages: [
        { role: 'user', content: understandingPrompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 800
    });

    const planText = understandingResponse.choices[0].message.content.trim();
    console.log(`[LLM PLAN] ${planText}`);

    let plan;
    try {
      plan = JSON.parse(planText);
    } catch (e) {
      console.error('[LLM] Failed to parse plan:', planText);
      // Fall through to legacy processing
      plan = null;
    }

    // ─────────────────────────────────────────
    // EXECUTE LLM-GENERATED PLAN
    // ─────────────────────────────────────────

    if (plan && plan.action) {
      // EXTRACT action
      if (plan.action === 'extract') {
        const sourceId = plan.source_id;
        if (!sources[sourceId]) {
          return res.status(400).json({
            error: `Source ${sourceId} not found`,
            available: Object.keys(sources).map(id => id.replace('SOURCE_', 'Source '))
          });
        }

        const data = sources[sourceId];

        // Extract by index
        if (plan.index !== undefined && plan.index !== null) {
          const idx = plan.index;
          if (Array.isArray(data)) {
            const actualIdx = idx === -1 ? data.length - 1 : idx;
            if (actualIdx >= 0 && actualIdx < data.length) {
              return res.json(data[actualIdx]);
            }
          } else if (isPlainObject(data)) {
            const keys = Object.keys(data);
            const actualIdx = idx === -1 ? keys.length - 1 : idx;
            if (actualIdx >= 0 && actualIdx < keys.length) {
              return res.json({ [keys[actualIdx]]: data[keys[actualIdx]] });
            }
          }
          return res.status(400).json({ error: `Index ${idx} out of bounds` });
        }

        // Extract by path
        if (plan.path && Array.isArray(plan.path) && plan.path.length > 0) {
          let result = data;
          for (const key of plan.path) {
            if (result === null || result === undefined) {
              return res.status(400).json({ error: `Path not found: ${plan.path.join('.')}` });
            }
            // Case-insensitive key matching
            if (isPlainObject(result)) {
              const actualKey = Object.keys(result).find(k => k.toLowerCase() === key.toLowerCase());
              result = actualKey ? result[actualKey] : result[key];
            } else if (Array.isArray(result) && !isNaN(Number(key))) {
              result = result[Number(key)];
            } else {
              result = result[key];
            }
          }
          if (result !== undefined) {
            // Return with the key name for context
            const lastKey = plan.path[plan.path.length - 1];
            if (isPlainObject(data)) {
              const actualKey = Object.keys(data).find(k => k.toLowerCase() === lastKey.toLowerCase()) || lastKey;
              return res.json({ [actualKey]: result });
            }
            return res.json(result);
          }
          return res.status(400).json({ error: `Path not found: ${plan.path.join('.')}` });
        }

        // Extract entire source
        return res.json(data);
      }

      // COLLECT action - gather all items from nested arrays into single array
      if (plan.action === 'collect') {
        const sourceId = plan.source_id;
        if (!sources[sourceId]) {
          return res.status(400).json({
            error: `Source ${sourceId} not found`,
            available: Object.keys(sources).map(id => id.replace('SOURCE_', 'Source '))
          });
        }

        const data = sources[sourceId];
        const arrayName = (plan.array_name || '').toLowerCase();
        const collected = [];

        // Traverse the entire source and collect all arrays matching the name
        traverse(data, (node, pathArr) => {
          if (!Array.isArray(node)) return;
          const key = pathArr[pathArr.length - 1];
          if (key && key.toLowerCase() === arrayName) {
            // Add all items from this array
            collected.push(...node.filter(item => item !== null && item !== undefined));
          }
        });

        console.log(`[COLLECT] Found ${collected.length} items from "${plan.array_name}" arrays in ${sourceId}`);
        return res.json(collected);
      }

      // COMPOSE action - build custom object from parts of multiple sources
      if (plan.action === 'compose' && Array.isArray(plan.parts)) {
        const result = {};

        for (const part of plan.parts) {
          const sourceId = part.source_id;
          if (!sources[sourceId]) {
            return res.status(400).json({
              error: `Source ${sourceId} not found for key "${part.key}"`,
              available: Object.keys(sources).map(id => id.replace('SOURCE_', 'Source '))
            });
          }

          const data = sources[sourceId];

          if (part.type === 'collect') {
            // Collect all arrays matching the name
            const arrayName = (part.array_name || '').toLowerCase();
            const collected = [];
            traverse(data, (node, pathArr) => {
              if (!Array.isArray(node)) return;
              const key = pathArr[pathArr.length - 1];
              if (key && key.toLowerCase() === arrayName) {
                collected.push(...node.filter(item => item !== null && item !== undefined));
              }
            });
            result[part.key] = collected;
            console.log(`[COMPOSE] ${part.key}: collected ${collected.length} items from "${part.array_name}"`);

          } else if (part.type === 'path' && Array.isArray(part.path)) {
            // Extract from specific path
            let value = data;
            for (const seg of part.path) {
              if (value === null || value === undefined) break;
              if (isPlainObject(value)) {
                const actualKey = Object.keys(value).find(k => k.toLowerCase() === seg.toLowerCase());
                value = actualKey ? value[actualKey] : value[seg];
              } else if (Array.isArray(value) && !isNaN(Number(seg))) {
                value = value[Number(seg)];
              } else {
                value = value[seg];
              }
            }
            result[part.key] = value !== undefined ? value : null;
            console.log(`[COMPOSE] ${part.key}: extracted from path ${part.path.join('.')}`);

          } else if (part.type === 'entire') {
            // Include entire source
            result[part.key] = data;
            console.log(`[COMPOSE] ${part.key}: entire source ${sourceId}`);

          } else {
            result[part.key] = null;
            console.log(`[COMPOSE] ${part.key}: unknown type "${part.type}"`);
          }
        }

        return res.json(result);
      }

      // QUERY action - convert to legacy format and continue
      if (plan.action === 'query' && Array.isArray(plan.operations)) {
        // For complex operations (nested grouping, sorting within groups), use pipeline
        const hasComplexOps = plan.operations.some(op => 
          op.nested_group || op.nestedGroup || op.sort_by || op.sortBy || 
          (op.by && op.by.includes('.')) || (op.field && op.field.includes('.'))
        );
        
        if (hasComplexOps) {
          console.log('[LLM] Complex query operations detected, using unified pipeline');
          const pipelineResult = await runUnifiedPipeline(prompt, sources, sourceNames, openai);
          if (!IS_PROD) {
            await fs.writeFile(path.join(process.cwd(), 'debug_pipeline.json'), JSON.stringify(pipelineResult, null, 2)).catch(() => {});
          }
          return res.json(pipelineResult.data || pipelineResult);
        }
        
        const dynamicQueries = plan.operations.map(op => ({
          operation: op.op,
          collection: op.collection,
          field: op.field || op.by,
          value: op.value,
          order: op.order,
          fields: op.fields,
          excludeFields: op.exclude_fields || op.excludeFields || [],
          nestedGroup: op.nested_group || op.nestedGroup,
          sortBy: op.sort_by || op.sortBy,
          sortOrder: op.sort_order || op.sortOrder,
          raw: JSON.stringify(op)
        }));

        if (dynamicQueries.length > 0) {
          const allResults = executeAllOps(dynamicQueries, sources);
          if (allResults.length === 1) {
            const r = allResults[0];
            return res.json({
              mode: `dynamic_${r.query.operation}`,
              query: r.query,
              results: r.results
            });
          }
          return res.json({ mode: 'multi_operation', operations: allResults });
        }
      }

      // ERROR action
      if (plan.action === 'error') {
        return res.status(400).json({
          error: 'Could not understand request',
          details: plan.message,
          suggestion: 'Try: "filter employees where role is Manager" or "get regions from @Source 1"'
        });
      }

      // MERGE action - LLM decided this is a merge operation
      if (plan.action === 'merge') {
        console.log('[LLM] Merge action detected, proceeding to merge planner');
        
        // Go directly to merge processing via unified pipeline
        const pipelineResult = await runUnifiedPipeline(prompt, sources, sourceNames, openai);
        if (!IS_PROD) {
          await fs.writeFile(path.join(process.cwd(), 'debug_pipeline.json'), JSON.stringify(pipelineResult, null, 2)).catch(() => {});
        }
        return res.json(pipelineResult.result || pipelineResult);
      }
      
      // JOIN action - LLM decided this is a join operation
      if (plan.action === 'join') {
        console.log('[LLM] Join action detected, proceeding to join planner');
        
        const compressedInput = Object.entries(sources).map(([id, obj]) => {
          const name = sourceNames[id] || id;
          return `### DATA SOURCE: ${name} (ID: ${id})\n${JSON.stringify(compressJson(obj), null, 2)}`;
        }).join('\n\n');

        const joinCompletion = await openai.chat.completions.create({
          model: AI_MODEL_MERGE,
          messages: [
            { role: 'system', content: JOIN_INSTRUCTIONS },
            {
              role: 'user',
              content: `## USER PROMPT\n${prompt}\n\n## DATA SOURCES (schema)\n${compressedInput}`
            }
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 2000
        });

        const joinText = joinCompletion.choices[0].message.content.trim();
        console.log('\n--- [JOIN PLAN] ---\n', joinText, '\n--------------------\n');

        let joinPlan;
        try {
          joinPlan = JSON.parse(joinText);
        } catch (e) {
          return res.status(500).json({ error: 'AI returned invalid join plan', details: joinText });
        }

        if (joinPlan.error) {
          return res.status(400).json({ error: 'Join planning failed', details: joinPlan.error });
        }

        try {
          const joinResult = executeJoinPlan(joinPlan, sources);
          if (!IS_PROD) await fs.writeFile(path.join(process.cwd(), 'debug_plan.json'), JSON.stringify(joinPlan, null, 2)).catch(() => {});
          return res.json(joinResult);
        } catch (execErr) {
          return res.status(500).json({ error: 'Join execution failed', details: execErr.message });
        }
      }
    }

    // ─────────────────────────────────────────
    // FALLBACK: LLM plan failed or action not recognized
    // Use unified pipeline for all complex operations
    // ─────────────────────────────────────────

    console.log('[LLM] No valid action plan, using unified pipeline');
    
    try {
      const pipelineResult = await runUnifiedPipeline(prompt, sources, sourceNames, openai);
      if (!IS_PROD) {
        await fs.writeFile(path.join(process.cwd(), 'debug_pipeline.json'), JSON.stringify(pipelineResult, null, 2)).catch(() => {});
      }
      return res.json(pipelineResult.result || pipelineResult);
    } catch (pipeErr) {
      console.error('[UNIFIED PIPELINE ERROR]', pipeErr.message);
      return res.status(500).json({ error: 'Pipeline execution failed', details: pipeErr.message });
    }

  } catch (error) {
    console.error('[CRITICAL ERROR]', error);
    res.status(error.status || 500).json({
      error: 'Conversion Failed',
      details: error.message,
      suggestion: 'Verify your OPENAI_API_KEY and input format.'
    });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));