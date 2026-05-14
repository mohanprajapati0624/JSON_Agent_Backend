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

// const allowedOrigins = process.env.CORS_ORIGIN
//   ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
//   : ['http://localhost:5173', 'http://localhost:4173'];

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true
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

const UNDERSTANDING_INSTRUCTIONS = await fs.readFile(
  path.join(process.cwd(), 'understanding_instructions.txt'), 'utf-8'
).catch(() => {
  console.error('[WARN] understanding_instructions.txt not found, using fallback');
  return '';
});

console.log(`[CONFIG] light=${AI_MODEL_LIGHT}, merge=${AI_MODEL_MERGE}, instructions=${MERGE_INSTRUCTIONS.length} chars, standardize=${STANDARDIZE_PROMPT.length} chars, join=${JOIN_INSTRUCTIONS.length} chars, pipeline=${PIPELINE_INSTRUCTIONS.length} chars, understanding=${UNDERSTANDING_INSTRUCTIONS.length} chars`);

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

const INTERNAL_OUTPUT_KEYS = new Set([
  '__depth_count',
  '__transforms',
  '__finalAnalytics',
  '__finalSummary'
]);

const stripInternalOutputFields = (data) => {
  if (Array.isArray(data)) return data.map(stripInternalOutputFields);
  if (isPlainObject(data)) {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      if (INTERNAL_OUTPUT_KEYS.has(key)) continue;
      out[key] = stripInternalOutputFields(value);
    }
    return out;
  }
  return data;
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

const buildSourceAliases = (sourceId, sourceName = '') => {
  const aliases = new Set([sourceId]);
  const sourceNumber = String(sourceId).match(/SOURCE_(\d+)/i)?.[1];

  if (sourceNumber) {
    aliases.add(`Source ${sourceNumber}`);
    aliases.add(`@Source ${sourceNumber}`);
    aliases.add(`Source${sourceNumber}`);
    aliases.add(`@Source${sourceNumber}`);
  }

  const trimmedName = String(sourceName || '').trim();
  if (trimmedName) {
    aliases.add(trimmedName);
    aliases.add(`@${trimmedName}`);

    const basename = trimmedName.replace(/\.[^.]+$/, '').trim();
    if (basename && basename !== trimmedName) {
      aliases.add(basename);
      aliases.add(`@${basename}`);
    }
  }

  return [...aliases];
};

const buildSourceReferenceGuide = (sourceNames) =>
  Object.entries(sourceNames)
    .map(([sourceId, sourceName]) =>
      `- ${sourceId}: display_name=${JSON.stringify(sourceName)}, aliases=${JSON.stringify(buildSourceAliases(sourceId, sourceName))}`
    )
    .join('\n');

const buildAiSourceContext = (sources, sourceNames) => ({
  sourceReferenceGuide: buildSourceReferenceGuide(sourceNames),
  compressedSources: Object.entries(sources)
    .map(([id, obj]) => {
      const name = sourceNames[id] || id;
      return `### ${name} (ID: ${id})\n${JSON.stringify(compressJson(obj), null, 2)}`;
    })
    .join('\n\n')
});

// ─────────────────────────────────────────────
// FIX ③ — FULL OPERATION PARSERS
// extractDynamicQuery now returns ALL operation
// types: filter, group, sort, select, count, unique
// ─────────────────────────────────────────────

const splitTopLevelComma = (text) => {
  const parts = [];
  let current = '';
  let quote = null;
  let bracketDepth = 0;

  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '[' || ch === '(' || ch === '{') bracketDepth++;
    if (ch === ']' || ch === ')' || ch === '}') bracketDepth--;

    // Split on comma OR newline at top level
    if ((ch === ',' || ch === '\n') && bracketDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }

    // Skip carriage return
    if (ch === '\r') continue;

    current += ch;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
};

const splitFirstColon = (text) => {
  let quote = null;
  let bracketDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '[' || ch === '(' || ch === '{') bracketDepth++;
    if (ch === ']' || ch === ')' || ch === '}') bracketDepth--;
    if (ch === ':' && bracketDepth === 0) return [text.slice(0, i), text.slice(i + 1)];
  }

  return null;
};

const normalizeComposeKey = (key) =>
  String(key || '').trim().replace(/^["']|["']$/g, '').trim();

const resolveSourceReference = (rawRef, sources, sourceNames) => {
  const ref = String(rawRef || '').trim().replace(/^@/, '');
  const sourceMatch = ref.match(/^source\s*[_-]?\s*(\d+)\b/i);
  if (sourceMatch) return `SOURCE_${sourceMatch[1]}`;

  for (const [sourceId, sourceName] of Object.entries(sourceNames)) {
    const aliases = buildSourceAliases(sourceId, sourceName).map(a =>
      String(a).replace(/^@/, '').toLowerCase()
    );
    if (aliases.includes(ref.toLowerCase())) return sourceId;
  }

  return sources[ref] ? ref : null;
};

const readCaseInsensitivePath = (data, pathArr) => {
  let value = data;
  for (const seg of pathArr) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) && !Number.isNaN(Number(seg))) {
      value = value[Number(seg)];
      continue;
    }
    if (isPlainObject(value)) {
      const actualKey = Object.keys(value).find(k => k.toLowerCase() === String(seg).toLowerCase());
      value = actualKey ? value[actualKey] : undefined;
      continue;
    }
    return undefined;
  }
  return value;
};

const normalizePathSegment = (seg) => String(seg).toLowerCase();

const pathEndsWith = (candidatePath, requestedPath) => {
  if (requestedPath.length > candidatePath.length) return false;
  const offset = candidatePath.length - requestedPath.length;
  return requestedPath.every((seg, i) =>
    normalizePathSegment(candidatePath[offset + i]) === normalizePathSegment(seg)
  );
};

const findPathBySuffix = (data, requestedPath) => {
  let found = null;
  traverse(data, (node, pathArr) => {
    if (found) return;
    if (pathEndsWith(pathArr, requestedPath)) found = pathArr;
  });
  return found;
};

const findFirstDescendantWithKey = (node, targetKey) => {
  const targetLower = normalizePathSegment(targetKey);
  let found = null;

  traverse(node, (child, pathArr) => {
    if (found || pathArr.length === 0) return;
    const last = pathArr[pathArr.length - 1];
    if (normalizePathSegment(last) === targetLower) found = { pathArr, value: child };
  });

  return found;
};

const readFlexiblePath = (data, pathArr) => {
  if (!Array.isArray(pathArr) || pathArr.length === 0) {
    return { value: data, resolvedPath: [] };
  }

  const directValue = readCaseInsensitivePath(data, pathArr);
  if (directValue !== undefined) return { value: directValue, resolvedPath: pathArr };

  const suffixPath = findPathBySuffix(data, pathArr);
  if (suffixPath) {
    return {
      value: readCaseInsensitivePath(data, suffixPath),
      resolvedPath: suffixPath
    };
  }

  let current = data;
  const resolvedPath = [];
  for (const seg of pathArr) {
    if (current === null || current === undefined) return { value: undefined, resolvedPath };

    if (Array.isArray(current) && !Number.isNaN(Number(seg))) {
      const idx = Number(seg);
      current = current[idx];
      resolvedPath.push(String(idx));
      continue;
    }

    if (isPlainObject(current)) {
      const actualKey = Object.keys(current).find(k => k.toLowerCase() === String(seg).toLowerCase());
      if (actualKey) {
        current = current[actualKey];
        resolvedPath.push(actualKey);
        continue;
      }
    }

    if (Number.isNaN(Number(seg))) {
      const descendant = findFirstDescendantWithKey(current, seg);
      if (!descendant) return { value: undefined, resolvedPath };
      current = descendant.value;
      resolvedPath.push(...descendant.pathArr);
      continue;
    }

    return { value: undefined, resolvedPath };
  }

  return { value: current, resolvedPath };
};

const setCaseInsensitivePath = (data, pathArr, value) => {
  if (!Array.isArray(pathArr) || pathArr.length === 0) return value;

  let current = data;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const seg = String(pathArr[i]);
    if (Array.isArray(current) && !Number.isNaN(Number(seg))) {
      const idx = Number(seg);
      if (!isPlainObject(current[idx]) && !Array.isArray(current[idx])) current[idx] = {};
      current = current[idx];
      continue;
    }

    if (!isPlainObject(current)) {
      throw new Error(`Cannot set path through non-object segment "${seg}"`);
    }

    const actualKey = Object.keys(current).find(k => k.toLowerCase() === seg.toLowerCase()) || seg;
    if (!isPlainObject(current[actualKey]) && !Array.isArray(current[actualKey])) current[actualKey] = {};
    current = current[actualKey];
  }

  const lastSeg = String(pathArr[pathArr.length - 1]);
  if (Array.isArray(current) && !Number.isNaN(Number(lastSeg))) {
    current[Number(lastSeg)] = value;
    return data;
  }

  if (!isPlainObject(current)) {
    throw new Error(`Cannot set final path on non-object segment "${lastSeg}"`);
  }

  const actualLastKey = Object.keys(current).find(k => k.toLowerCase() === lastSeg.toLowerCase()) || lastSeg;
  current[actualLastKey] = value;
  return data;
};

// ─────────────────────────────────────────
// ADVANCED PATH EVALUATION WITH ARRAY OPERATIONS
// Supports: filtering, sorting, slicing, mapping, first/last/count
// ─────────────────────────────────────────

const evaluateArrayOperation = (arr, operation) => {
  if (!Array.isArray(arr)) return arr;
  
  const op = String(operation || '').trim();
  
  // Sort operations: sort(asc:field) or sort(desc:field)
  const sortMatch = op.match(/^sort\s*\(\s*(asc|desc)\s*:\s*([^)]+)\s*\)$/i);
  if (sortMatch) {
    const direction = sortMatch[1].toLowerCase();
    const field = sortMatch[2].trim();
    const sorted = [...arr].sort((a, b) => {
      const valA = readCaseInsensitivePath(a, field.split('.'));
      const valB = readCaseInsensitivePath(b, field.split('.'));
      if (valA === valB) return 0;
      if (valA === undefined) return 1;
      if (valB === undefined) return -1;
      const cmp = valA < valB ? -1 : 1;
      return direction === 'asc' ? cmp : -cmp;
    });
    console.log(`[ARRAY OP] sort(${direction}:${field}) -> ${sorted.length} items`);
    return sorted;
  }
  
  // Filter operations: filter(field=value), filter(field>value), filter(field<value)
  const filterMatch = op.match(/^filter\s*\(\s*([^=<>!]+)\s*(=|!=|>|<|>=|<=)\s*([^)]+)\s*\)$/i);
  if (filterMatch) {
    const field = filterMatch[1].trim();
    const operator = filterMatch[2];
    let compareValue = filterMatch[3].trim();
    
    // Try to parse as number
    const numValue = Number(compareValue);
    if (!isNaN(numValue)) compareValue = numValue;
    // Remove quotes if string
    if (typeof compareValue === 'string' && /^["'].*["']$/.test(compareValue)) {
      compareValue = compareValue.slice(1, -1);
    }
    
    const filtered = arr.filter(item => {
      const val = readCaseInsensitivePath(item, field.split('.'));
      switch (operator) {
        case '=': return val == compareValue;
        case '!=': return val != compareValue;
        case '>': return val > compareValue;
        case '<': return val < compareValue;
        case '>=': return val >= compareValue;
        case '<=': return val <= compareValue;
        default: return true;
      }
    });
    console.log(`[ARRAY OP] filter(${field}${operator}${compareValue}) -> ${filtered.length} of ${arr.length}`);
    return filtered;
  }
  
  // Slice: slice(start, end) or slice(start)
  const sliceMatch = op.match(/^slice\s*\(\s*(-?\d+)\s*(?:,\s*(-?\d+))?\s*\)$/i);
  if (sliceMatch) {
    const start = parseInt(sliceMatch[1], 10);
    const end = sliceMatch[2] ? parseInt(sliceMatch[2], 10) : undefined;
    const sliced = end !== undefined ? arr.slice(start, end) : arr.slice(start);
    console.log(`[ARRAY OP] slice(${start}${end !== undefined ? ',' + end : ''}) -> ${sliced.length} items`);
    return sliced;
  }
  
  // First N: first(n) or first
  const firstMatch = op.match(/^first\s*(?:\(\s*(\d+)\s*\))?$/i);
  if (firstMatch) {
    const n = firstMatch[1] ? parseInt(firstMatch[1], 10) : 1;
    const result = n === 1 ? arr[0] : arr.slice(0, n);
    console.log(`[ARRAY OP] first(${n})`);
    return result;
  }
  
  // Last N: last(n) or last
  const lastMatch = op.match(/^last\s*(?:\(\s*(\d+)\s*\))?$/i);
  if (lastMatch) {
    const n = lastMatch[1] ? parseInt(lastMatch[1], 10) : 1;
    const result = n === 1 ? arr[arr.length - 1] : arr.slice(-n);
    console.log(`[ARRAY OP] last(${n})`);
    return result;
  }
  
  // Count/Length
  if (/^(count|length|size)$/i.test(op)) {
    console.log(`[ARRAY OP] ${op} -> ${arr.length}`);
    return arr.length;
  }
  
  // Reverse
  if (/^reverse$/i.test(op)) {
    console.log(`[ARRAY OP] reverse -> ${arr.length} items`);
    return [...arr].reverse();
  }
  
  // Unique (dedupe by JSON stringify)
  if (/^unique$/i.test(op)) {
    const seen = new Set();
    const unique = arr.filter(item => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`[ARRAY OP] unique -> ${unique.length} of ${arr.length}`);
    return unique;
  }
  
  // Flatten
  if (/^flatten$/i.test(op)) {
    const flattened = arr.flat(Infinity);
    console.log(`[ARRAY OP] flatten -> ${flattened.length} items`);
    return flattened;
  }
  
  return arr;
};

const evaluateAdvancedPath = (data, pathExpression) => {
  const expr = String(pathExpression || '').trim();
  if (!expr) return { value: data, resolvedPath: [] };
  
  // Tokenize the path expression
  // Supports: path.to.array.filter(x=y).sort(asc:field).first
  const tokens = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    
    if (ch === '(') parenDepth++;
    if (ch === ')') parenDepth--;
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth--;
    
    if (ch === '.' && parenDepth === 0 && bracketDepth === 0) {
      if (current.trim()) tokens.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(current.trim());
  
  let value = data;
  const resolvedPath = [];
  
  for (const token of tokens) {
    if (value === null || value === undefined) break;
    
    // Check if token is an array operation
    if (/^(sort|filter|slice|first|last|count|length|size|reverse|unique|flatten)\s*(\(|$)/i.test(token)) {
      value = evaluateArrayOperation(value, token);
      resolvedPath.push(token);
      continue;
    }
    
    // Check for array index: items[0] or items[-1]
    const indexMatch = token.match(/^([^\[]+)\[(-?\d+)\]$/);
    if (indexMatch) {
      const key = indexMatch[1];
      const idx = parseInt(indexMatch[2], 10);
      
      // First access the key
      if (key) {
        if (isPlainObject(value)) {
          const actualKey = Object.keys(value).find(k => k.toLowerCase() === key.toLowerCase());
          value = actualKey ? value[actualKey] : undefined;
          resolvedPath.push(actualKey || key);
        } else {
          value = undefined;
        }
      }
      
      // Then access the index
      if (Array.isArray(value)) {
        const actualIdx = idx < 0 ? value.length + idx : idx;
        value = value[actualIdx];
        resolvedPath.push(String(actualIdx));
      }
      continue;
    }
    
    // Check for array filter: items[field=value]
    const filterMatch = token.match(/^([^\[]*)\[([^\]]+)\]$/);
    if (filterMatch && !/^\d+$/.test(filterMatch[2])) {
      const key = filterMatch[1];
      const filterExpr = filterMatch[2];
      
      // First access the key if present
      if (key) {
        if (isPlainObject(value)) {
          const actualKey = Object.keys(value).find(k => k.toLowerCase() === key.toLowerCase());
          value = actualKey ? value[actualKey] : undefined;
          resolvedPath.push(actualKey || key);
        }
      }
      
      // Apply filter if array
      if (Array.isArray(value)) {
        // Check for comparison: field=value, field>value, etc.
        const compMatch = filterExpr.match(/^([^=<>!]+)(=|!=|>|<|>=|<=)(.+)$/);
        if (compMatch) {
          const field = compMatch[1].trim();
          const op = compMatch[2];
          let compareVal = compMatch[3].trim();
          
          // Parse value
          if (!isNaN(Number(compareVal))) compareVal = Number(compareVal);
          if (typeof compareVal === 'string' && /^["'].*["']$/.test(compareVal)) {
            compareVal = compareVal.slice(1, -1);
          }
          
          value = value.filter(item => {
            const itemVal = readCaseInsensitivePath(item, field.split('.'));
            switch (op) {
              case '=': return itemVal == compareVal;
              case '!=': return itemVal != compareVal;
              case '>': return itemVal > compareVal;
              case '<': return itemVal < compareVal;
              case '>=': return itemVal >= compareVal;
              case '<=': return itemVal <= compareVal;
              default: return true;
            }
          });
          console.log(`[PATH] filter ${key}[${filterExpr}] -> ${value.length} items`);
          resolvedPath.push(`[${filterExpr}]`);
        } else if (filterExpr === '*') {
          // Wildcard - keep all (used for mapping)
          resolvedPath.push('[*]');
        }
      }
      continue;
    }
    
    // Check for map operation: [*] followed by property
    if (Array.isArray(value) && resolvedPath[resolvedPath.length - 1] === '[*]') {
      // Map: extract property from each item
      value = value.map(item => readCaseInsensitivePath(item, [token])).filter(v => v !== undefined);
      resolvedPath.push(token);
      console.log(`[PATH] map [*].${token} -> ${value.length} values`);
      continue;
    }
    
    // Regular property access
    if (isPlainObject(value)) {
      const actualKey = Object.keys(value).find(k => k.toLowerCase() === token.toLowerCase());
      if (actualKey) {
        value = value[actualKey];
        resolvedPath.push(actualKey);
      } else {
        // Try flexible path (find key anywhere in descendants)
        const descendant = findFirstDescendantWithKey(value, token);
        if (descendant) {
          value = descendant.value;
          resolvedPath.push(...descendant.pathArr);
        } else {
          value = undefined;
        }
      }
    } else if (Array.isArray(value)) {
      // If accessing property on array, map it
      value = value.map(item => readCaseInsensitivePath(item, [token])).filter(v => v !== undefined);
      resolvedPath.push(token);
    } else {
      value = undefined;
    }
  }
  
  return { value, resolvedPath };
};

const parsePathExpression = (rawPath) => {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }

  return trimmed
    .replace(/^\./, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map(s => s.trim())
    .filter(Boolean);
};

const splitSourceValueExpression = (valueExpression, sourceNames) => {
  const expression = String(valueExpression || '').trim();
  const lowerExpression = expression.toLowerCase();
  const candidates = [];

  for (const [sourceId, sourceName] of Object.entries(sourceNames)) {
    for (const alias of buildSourceAliases(sourceId, sourceName)) {
      candidates.push({ sourceId, alias });
    }
  }

  candidates.sort((a, b) => b.alias.length - a.alias.length);

  for (const { sourceId, alias } of candidates) {
    const lowerAlias = alias.toLowerCase();
    if (
      lowerExpression === lowerAlias ||
      lowerExpression.startsWith(`${lowerAlias}.`) ||
      lowerExpression.startsWith(`${lowerAlias} `) ||
      lowerExpression.startsWith(`${lowerAlias}[`)
    ) {
      return {
        sourceId,
        pathExpression: expression.slice(alias.length).trim()
      };
    }
  }

  return null;
};

const tryObjectCompositionPrompt = (promptText, sources, sourceNames) => {
  const text = String(promptText || '').trim();
  const isWrappedObject = text.startsWith('{') && text.endsWith('}');
  const hasMappingSyntax = /(?:^|[,\r\n])\s*["']?[A-Za-z0-9_-]+["']?\s*:\s*@/i.test(text);
  if (!isWrappedObject && !hasMappingSyntax) return null;

  const body = isWrappedObject ? text.slice(1, -1).trim() : text;
  if (!body) return null;

  const result = {};
  const entries = splitTopLevelComma(body);
  if (entries.length === 0) return null;
  const baseAssignments = [];
  const pendingInjections = [];

  for (const entry of entries) {
    const pair = splitFirstColon(entry);
    if (!pair) return null;

    const key = normalizeComposeKey(pair[0]);
    if (!key) return null;

    const valueExpression = pair[1].trim();

    if (key.startsWith('@')) {
      pendingInjections.push({ targetExpression: key, valueExpression });
      continue;
    }

    const sourceExpression = splitSourceValueExpression(valueExpression, sourceNames);
    if (!sourceExpression) return null;
    const sourceId = resolveSourceReference(sourceExpression.sourceId, sources, sourceNames);
    if (!sourceId || !sources[sourceId]) return null;

    const pathExpr = sourceExpression.pathExpression;
    
    // Use advanced path evaluation for complex expressions with operations
    let value;
    if (pathExpr) {
      // Try advanced evaluation first (supports filter, sort, etc.)
      const advResult = evaluateAdvancedPath(sources[sourceId], pathExpr);
      if (advResult.value !== undefined) {
        value = advResult.value;
        console.log(`[COMPOSE] "${key}": advanced path ${pathExpr} -> ${advResult.resolvedPath.join('.')}`);
      } else {
        // Fallback to flexible path
        const pathArr = parsePathExpression(pathExpr);
        const flexResult = readFlexiblePath(sources[sourceId], pathArr);
        value = flexResult.value;
        if (value !== undefined) {
          console.log(`[COMPOSE] "${key}": resolved path ${pathArr.join('.')} -> ${flexResult.resolvedPath.join('.')}`);
        }
      }
    } else {
      value = sources[sourceId];
    }

    if (value === undefined) {
      throw new Error(`Path not found for "${key}": ${sourceExpression.pathExpression}. Check if the path exists in your data.`);
    }

    result[key] = structuredClone(value);
    baseAssignments.push({ key, sourceId, pathExpr, data: result[key] });
  }

  for (const injection of pendingInjections) {
    const target = splitSourceAndPathExpression(injection.targetExpression);
    if (!target) return null;

    const targetSourceId = resolveSourceReference(target.sourceId, sources, sourceNames);
    if (!targetSourceId) return null;

    const valueSourceExpression = splitSourceValueExpression(injection.valueExpression, sourceNames);
    if (!valueSourceExpression) return null;

    const valueSourceId = resolveSourceReference(valueSourceExpression.sourceId, sources, sourceNames);
    if (!valueSourceId || !sources[valueSourceId]) return null;

    const injectionPath = parsePathExpression(target.pathExpression);
    if (injectionPath.length === 0) {
      throw new Error(`Injection path is required: ${injection.targetExpression}`);
    }

    const valuePathExpr = valueSourceExpression.pathExpression;
    let injectionValue = sources[valueSourceId];
    if (valuePathExpr) {
      const resolved = evaluateAdvancedPath(sources[valueSourceId], valuePathExpr);
      injectionValue = resolved.value !== undefined
        ? resolved.value
        : readFlexiblePath(sources[valueSourceId], parsePathExpression(valuePathExpr)).value;
    }

    if (injectionValue === undefined) {
      throw new Error(`Injection value path not found: ${injection.valueExpression}`);
    }

    const targets = baseAssignments.filter(a => a.sourceId === targetSourceId && !a.pathExpr);
    if (targets.length === 0) {
      throw new Error(`No output key is using ${targetSourceId} as an entire source for injection`);
    }

    for (const assignment of targets) {
      setCaseInsensitivePath(assignment.data, injectionPath, structuredClone(injectionValue));
      console.log(`[COMPOSE] Injected ${valueSourceId} into "${assignment.key}".${injectionPath.join('.')}`);
    }
  }

  return result;
};

const trySourceArrayPrompt = (promptText, sources, sourceNames) => {
  const text = String(promptText || '').trim();
  const listMatch = text.match(/\[\s*@?source\s*[_-]?\s*\d+[\s\S]*?\]/i);
  const listText = listMatch?.[0] || text;
  if (!listText.startsWith('[') || !listText.endsWith(']')) return null;

  const body = listText.slice(1, -1).trim();
  if (!body) return [];

  const result = [];
  const entries = splitTopLevelComma(body);
  if (entries.length === 0) return null;

  for (const entry of entries) {
    const sourceExpression = splitSourceValueExpression(entry.trim(), sourceNames);
    if (!sourceExpression) return null;

    const sourceId = resolveSourceReference(sourceExpression.sourceId, sources, sourceNames);
    if (!sourceId || !sources[sourceId]) {
      throw new Error(`Source not found: ${entry.trim()}`);
    }

    const pathExpression = sourceExpression.pathExpression;
    if (pathExpression) {
      const resolved = evaluateAdvancedPath(sources[sourceId], pathExpression);
      if (resolved.value !== undefined) {
        result.push(resolved.value);
        continue;
      }

      const flexResult = readFlexiblePath(sources[sourceId], parsePathExpression(pathExpression));
      if (flexResult.value === undefined) {
        throw new Error(`Path not found: ${entry.trim()}`);
      }
      result.push(flexResult.value);
      continue;
    }

    result.push(sources[sourceId]);
  }

  return result;
};

const splitSourceAndPathExpression = (text) => {
  const match = String(text || '').trim().match(/@?source\s*[_-]?\s*(\d+)\b(.*)$/i);
  if (!match) return null;
  return {
    sourceId: `SOURCE_${match[1]}`,
    pathExpression: match[2].trim()
  };
};

const tryNaturalComposePrompt = (promptText, sources, sourceNames) => {
  const text = String(promptText || '').trim();
  // Check for any @ reference (could be @Source N or @filename.txt)
  if (!text || !/@/i.test(text)) return null;

  // Helper to resolve source reference (file name or Source N) to SOURCE_ID
  const resolveRef = (ref) => {
    const cleaned = String(ref || '').trim().replace(/^@/, '');
    // Check if it's "Source N" format
    const sourceMatch = cleaned.match(/^source\s*[_-]?\s*(\d+)\b/i);
    if (sourceMatch) return `SOURCE_${sourceMatch[1]}`;
    // Check by file name
    if (sourceNames) {
      for (const [sourceId, sourceName] of Object.entries(sourceNames)) {
        if (sourceName.toLowerCase() === cleaned.toLowerCase()) return sourceId;
        // Also try without extension
        const nameWithoutExt = sourceName.replace(/\.[^.]+$/, '');
        if (nameWithoutExt.toLowerCase() === cleaned.toLowerCase()) return sourceId;
      }
    }
    return null;
  };

  // ─────────────────────────────────────────
  // EARLY CHECK: Simple array of sources [@Source 1, @Source 2, ...]
  // ─────────────────────────────────────────
  if (/^\s*\[/.test(text) && /\]\s*$/.test(text)) {
    // Strip outer brackets and split by comma
    const innerText = text.replace(/^\s*\[\s*/, '').replace(/\s*\]\s*$/, '');
    const parts = innerText.split(',').map(p => p.trim());
    const simpleSourcePattern = /^@(source\s*\d+|[^\s]+)$/i;
    const simpleItems = [];
    let allMatch = true;
    
    for (const part of parts) {
      const match = part.match(simpleSourcePattern);
      if (match) {
        const sourceRef = match[1].trim();
        const sourceId = resolveRef(sourceRef);
        if (sourceId && sources[sourceId]) {
          simpleItems.push(structuredClone(sources[sourceId]));
          console.log(`[COMPOSE] Array item: ${sourceId} (entire)`);
        } else {
          allMatch = false;
          break;
        }
      } else {
        allMatch = false;
        break;
      }
    }
    
    if (allMatch && simpleItems.length > 0) {
      console.log(`[COMPOSE] Simple source array: ${simpleItems.length} items`);
      return simpleItems;
    }
  }

  // Detect if user wants array output: "array of objects", "list of objects", "[]", etc.
  const wantsArray = /\b(array|list)\s+(of\s+)?(objects?|items?)\b/i.test(text) || 
                     /^\s*\[/.test(text) || 
                     /create\s+\[/i.test(text);
  
  const items = [];  // For array format
  const result = {}; // For object format

  // Split text by commas (respecting brackets)
  const segments = [];
  let current = '';
  let bracketDepth = 0;
  for (const ch of text) {
    if (ch === '[' || ch === '{' || ch === '(') bracketDepth++;
    if (ch === ']' || ch === '}' || ch === ')') bracketDepth--;
    if (ch === ',' && bracketDepth === 0) {
      segments.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) segments.push(current.trim());

  // ─────────────────────────────────────────
  // PHASE 1: Identify base assignments ("key": @source)
  // These establish which sources are "active bases"
  // ─────────────────────────────────────────
  const baseAssignments = {};  // { outputKey: { sourceId, data } }
  const activeSourceIds = new Set();  // Track which sources are used as bases
  
  for (const segment of segments) {
    // Match: "key" : @source (optional complex path with operations)
    // Supports: @Source 1 user.profile.name.sort(asc:date).filter(active=true)
    const quotedKeyPattern = /^["']([^"']+)["']\s*:\s*@([^\s,\[]+)(?:\s+(.+))?$/i;
    const quotedMatch = segment.match(quotedKeyPattern);
    if (quotedMatch) {
      const key = quotedMatch[1].trim();
      const sourceRef = quotedMatch[2].trim();
      const pathStr = (quotedMatch[3] || '').trim();
      const sourceId = resolveRef(sourceRef);
      
      if (sourceId && sources[sourceId]) {
        let value;
        if (pathStr) {
          // Use advanced path evaluation for complex expressions
          const resolved = evaluateAdvancedPath(sources[sourceId], pathStr);
          if (resolved.value === undefined) {
            // Fallback to flexible path
            const pathArr = parsePathExpression(pathStr);
            const flexResult = readFlexiblePath(sources[sourceId], pathArr);
            if (flexResult.value === undefined) {
              throw new Error(`Path not found for "${key}": ${sourceId} ${pathStr}`);
            }
            value = structuredClone(flexResult.value);
            console.log(`[COMPOSE] Base: "${key}" -> ${sourceId}.${flexResult.resolvedPath.join('.')}`);
          } else {
            value = structuredClone(resolved.value);
            console.log(`[COMPOSE] Base: "${key}" -> ${sourceId}.${resolved.resolvedPath.join('.')}`);
          }
        } else {
          value = structuredClone(sources[sourceId]);
          console.log(`[COMPOSE] Base: "${key}" -> ${sourceId} (entire)`);
        }
        baseAssignments[key] = { sourceId, sourceRef, data: value };
        activeSourceIds.add(sourceId);
      }
    }
  }

  // ─────────────────────────────────────────
  // PHASE 2: Process injections (@source[path]: @value_source OR @source path.to[idx]: @value)
  // Only inject into sources that are active bases
  // ─────────────────────────────────────────
  for (const segment of segments) {
    // Pattern 1: @source[path] : @other_source (bracket immediately after source)
    const injectionPattern1 = /@([^\s\[]+)\s*\[([^\]]+)\]\s*:\s*@([^\s,]+)/i;
    // Pattern 2: @source path.to[idx] : @other_source (space-separated path with brackets)
    const injectionPattern2 = /@([^\s]+)\s+([^\s:]+(?:\[[^\]]+\])?[^\s:]*)\s*:\s*@([^\s,]+)/i;
    
    let targetSourceRef, injectPath, valueSourceRef;
    
    // Try pattern 1 first (bracket key)
    const injectionMatch1 = segment.match(injectionPattern1);
    if (injectionMatch1) {
      targetSourceRef = injectionMatch1[1].trim();
      injectPath = injectionMatch1[2].trim();
      valueSourceRef = injectionMatch1[3].trim();
    } else {
      // Try pattern 2 (space-separated path)
      const injectionMatch2 = segment.match(injectionPattern2);
      if (injectionMatch2) {
        // Check if this looks like an injection (has brackets or dots in path)
        const potentialPath = injectionMatch2[2].trim();
        // Only treat as injection if the path contains [] or looks like a path injection
        if (potentialPath.includes('[') || (potentialPath.includes('.') && !potentialPath.startsWith('"'))) {
          targetSourceRef = injectionMatch2[1].trim();
          injectPath = potentialPath;
          valueSourceRef = injectionMatch2[3].trim();
        }
      }
    }
    
    if (!targetSourceRef || !injectPath || !valueSourceRef) continue;
    
    const targetSourceId = resolveRef(targetSourceRef);
    const valueSourceId = resolveRef(valueSourceRef);
    
    // Only process if target source is an active base
    if (!activeSourceIds.has(targetSourceId)) {
      console.log(`[COMPOSE] Skipped injection: @${targetSourceRef} ${injectPath} (source not used as base)`);
      continue;
    }
    
    if (!valueSourceId || !sources[valueSourceId]) {
      console.log(`[COMPOSE] Skipped injection: value source @${valueSourceRef} not found`);
      continue;
    }
    
    // Find which base assignment uses this source and inject into it
    for (const [outputKey, assignment] of Object.entries(baseAssignments)) {
      if (assignment.sourceId === targetSourceId) {
        // Inject the value into the base data at the specified path
        const pathArr = parsePathExpression(injectPath);
        if (pathArr.length > 0) {
          setCaseInsensitivePath(assignment.data, pathArr, structuredClone(sources[valueSourceId]));
          console.log(`[COMPOSE] Injected: @${valueSourceRef} -> "${outputKey}".${pathArr.join('.')}`);
        }
      }
    }
  }

  // ─────────────────────────────────────────
  // PHASE 3: Build final result from base assignments
  // ─────────────────────────────────────────
  if (Object.keys(baseAssignments).length > 0) {
    for (const [key, assignment] of Object.entries(baseAssignments)) {
      if (wantsArray) {
        items.push({ [key]: assignment.data });
      } else {
        result[key] = assignment.data;
      }
    }
    
    if (wantsArray && items.length > 0) {
      console.log(`[COMPOSE] Natural array with injections: ${items.length} items`);
      return items;
    }
    if (Object.keys(result).length > 0) {
      console.log(`[COMPOSE] Natural object with injections`);
      return result;
    }
  }

  // ─────────────────────────────────────────
  // FALLBACK: Simple key-value pairs without injection logic
  // (for cases like "key": @Source 1, "key2": @Source 2)
  // ─────────────────────────────────────────
  for (const segment of segments) {
    // Skip injection patterns (already processed)
    if (/@[^\s\[]+\s*\[/.test(segment)) continue;
    
    // Try: "key" : @source (with optional complex path expression)
    const quotedKeyPattern = /["']([^"']+)["']\s*:\s*@([^\s,\[]+)(?:\s+(.+))?/i;
    const quotedMatch = segment.match(quotedKeyPattern);
    if (quotedMatch) {
      const key = quotedMatch[1].trim();
      const sourceRef = quotedMatch[2].trim();
      const pathStr = (quotedMatch[3] || '').trim();
      const sourceId = resolveRef(sourceRef);
      
      if (sourceId && sources[sourceId]) {
        let value;
        if (pathStr) {
          // Use advanced path evaluation for complex expressions
          const resolved = evaluateAdvancedPath(sources[sourceId], pathStr);
          if (resolved.value === undefined) {
            // Fallback to flexible path
            const pathArr = parsePathExpression(pathStr);
            const flexResult = readFlexiblePath(sources[sourceId], pathArr);
            if (flexResult.value === undefined) {
              throw new Error(`Path not found for "${key}": ${sourceId} ${pathStr}`);
            }
            value = flexResult.value;
            console.log(`[COMPOSE] Natural: "${key}" -> ${sourceId}.${flexResult.resolvedPath.join('.')}`);
          } else {
            value = resolved.value;
            console.log(`[COMPOSE] Natural: "${key}" -> ${sourceId}.${resolved.resolvedPath.join('.')}`);
          }
        } else {
          value = sources[sourceId];
          console.log(`[COMPOSE] Natural: "${key}" -> ${sourceId} (entire)`);
        }
        if (wantsArray) {
          items.push({ [key]: value });
        } else {
          result[key] = value;
        }
        continue;
      }
    }
    
    // Try: [key] : @source (with optional complex path)
    const simpleBracketPattern = /\[([^\]]+)\]\s*:\s*@([^\s,]+)(?:\s+(.+))?/i;
    const simpleBracketMatch = segment.match(simpleBracketPattern);
    if (simpleBracketMatch) {
      const key = simpleBracketMatch[1].trim();
      const sourceRef = simpleBracketMatch[2].trim();
      const pathStr = (simpleBracketMatch[3] || '').trim();
      const sourceId = resolveRef(sourceRef);
      
      if (sourceId && sources[sourceId]) {
        let value;
        if (pathStr) {
          // Use advanced path evaluation
          const resolved = evaluateAdvancedPath(sources[sourceId], pathStr);
          if (resolved.value === undefined) {
            const pathArr = parsePathExpression(pathStr);
            const flexResult = readFlexiblePath(sources[sourceId], pathArr);
            if (flexResult.value === undefined) continue;
            value = flexResult.value;
            console.log(`[COMPOSE] Natural: "${key}" -> ${sourceId}.${flexResult.resolvedPath.join('.')} (bracket key)`);
          } else {
            value = resolved.value;
            console.log(`[COMPOSE] Natural: "${key}" -> ${sourceId}.${resolved.resolvedPath.join('.')} (bracket key)`);
          }
        } else {
          value = sources[sourceId];
          console.log(`[COMPOSE] Natural: "${key}" -> ${sourceId} (entire, bracket key)`);
        }
        if (wantsArray) {
          items.push({ [key]: value });
        } else {
          result[key] = value;
        }
        continue;
      }
    }
  }
  
  // ─────────────────────────────────────────
  // SIMPLE ARRAY OF SOURCES: [@Source 1, @Source 2, ...]
  // No keys, just sources listed in array format
  // ─────────────────────────────────────────
  if (wantsArray && items.length === 0) {
    console.log(`[DEBUG] Checking simple array pattern. Segments:`, segments);
    // Pattern to match @Source N with optional brackets and spaces
    const simpleSourcePattern = /^\[?\s*@(source\s*\d+|[^\s,\]]+)\s*\]?$/i;
    for (const segment of segments) {
      const match = segment.match(simpleSourcePattern);
      console.log(`[DEBUG] Segment "${segment}" match:`, match);
      if (match) {
        const sourceRef = match[1].trim();
        const sourceId = resolveRef(sourceRef);
        console.log(`[DEBUG] sourceRef="${sourceRef}" -> sourceId="${sourceId}"`);
        if (sourceId && sources[sourceId]) {
          items.push(structuredClone(sources[sourceId]));
          console.log(`[COMPOSE] Array item: ${sourceId} (entire)`);
        }
      }
    }
    if (items.length > 0) {
      console.log(`[COMPOSE] Simple source array: ${items.length} items`);
      return items;
    }
  }

  if (wantsArray && items.length > 0) {
    console.log(`[COMPOSE] Natural array composition: ${items.length} items`);
    return items;
  }
  if (Object.keys(result).length > 0) {
    return result;
  }

  return null;
};

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
  const { sourceReferenceGuide, compressedSources } = buildAiSourceContext(sources, sourceNames);

  // Call AI to generate complete pipeline plan
  const completion = await openai.chat.completions.create({
    model: AI_MODEL_MERGE,
    messages: [
      { role: 'system', content: PIPELINE_INSTRUCTIONS },
      {
        role: 'user',
        content: `## USER PROMPT\n${prompt}\n\n## SOURCE REFERENCES\n${sourceReferenceGuide}\n\n## DATA SOURCES (schema only - keys preserved, values replaced with type placeholders)\n${compressedSources}`
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
    data: stripInternalOutputFields(result)
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
    const { sourceReferenceGuide, compressedSources } = buildAiSourceContext(sources, sourceNames);

    const completion = await openai.chat.completions.create({
      model: AI_MODEL_MERGE,
      messages: [
        { role: 'system', content: MERGE_INSTRUCTIONS },
        { role: 'user', content: `## USER PROMPT\n${mergePrompt}\n\n## SOURCE REFERENCES\n${sourceReferenceGuide}\n\n## DATA SOURCES\n${compressedSources}` }
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
    const { sourceReferenceGuide, compressedSources } = buildAiSourceContext(joinSources, joinSourceNames);

    const joinCompletion = await openai.chat.completions.create({
      model: AI_MODEL_MERGE,
      messages: [
        { role: 'system', content: JOIN_INSTRUCTIONS },
        { role: 'user', content: `## USER PROMPT\n${ops.join.join('\n')}\n\n## SOURCE REFERENCES\n${sourceReferenceGuide}\n\n## DATA SOURCES\n${compressedSources}` }
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

  return { mode: 'pipeline', pipeline: pipelineLog, data: stripInternalOutputFields(result) };
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
  }

  try {
    const sourceArray = trySourceArrayPrompt(prompt, sources, sourceNames);
    if (sourceArray) {
      console.log('[COMPOSE] Direct source array from prompt');
      return res.json(sourceArray);
    }
  } catch (sourceArrayErr) {
    console.error('[SOURCE ARRAY ERROR]', sourceArrayErr.message);
    return res.status(400).json({
      error: 'Source array composition failed',
      details: sourceArrayErr.message
    });
  }

  try {
    // ─────────────────────────────────────────
    // BARE SOURCE REQUEST — only "@Source 1" or "source 2" alone
    // These are so simple they don't need LLM
    // ─────────────────────────────────────────

    // ─────────────────────────────────────────
    // SIMPLE OBJECT FORMAT - { key: @source, key2: @source path }
    // Direct object construction without LLM
    // ─────────────────────────────────────────
    
    // ─────────────────────────────────────────
    try {
      const sourceArray = trySourceArrayPrompt(prompt, sources, sourceNames);
      if (sourceArray) {
        console.log('[COMPOSE] Direct source array from prompt');
        return res.json(sourceArray);
      }

      const composedObject = tryObjectCompositionPrompt(prompt, sources, sourceNames);
      if (composedObject) {
        console.log('[COMPOSE] Direct object composition from prompt');
        return res.json(composedObject);
      }
    } catch (composeErr) {
      if (/(?:^|[,\r\n])\s*["']?[A-Za-z0-9_-]+["']?\s*:\s*@/i.test(prompt)) {
        console.error('[COMPOSE ERROR]', composeErr.message);
        return res.status(400).json({
          error: 'Object composition failed',
          details: composeErr.message,
          hint: 'Check that the referenced source and path exist.'
        });
      }
      console.log('[COMPOSE] Direct composition failed, falling through:', composeErr.message);
    }

    try {
      const naturalComposedObject = tryNaturalComposePrompt(prompt, sources, sourceNames);
      if (naturalComposedObject) {
        console.log('[COMPOSE] Natural object composition from prompt');
        return res.json(naturalComposedObject);
      }
    } catch (naturalErr) {
      // Fall through to LLM instead of returning error
      console.log('[NATURAL COMPOSE] Failed, falling through:', naturalErr.message);
    }

    // LLM-POWERED PROMPT UNDERSTANDING
    // All other prompts go through LLM for understanding
    // Instructions loaded from external file for easy modification
    // ─────────────────────────────────────────

    console.log(`[LLM] Planning request from prompt: "${prompt}"`);
    const { sourceReferenceGuide, compressedSources } = buildAiSourceContext(sources, sourceNames);

    // Build understanding prompt dynamically from external instructions file
    const understandingPrompt = `${UNDERSTANDING_INSTRUCTIONS}

USER REQUEST: ${prompt}

SOURCE REFERENCE DIRECTORY:
${sourceReferenceGuide}

AVAILABLE DATA SOURCES:
${compressedSources}`;

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
            return res.json(stripInternalOutputFields(result));
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
        const composeSources = {};
        for (const [id, source] of Object.entries(sources)) {
          composeSources[id] = structuredClone(source);
        }

        if (Array.isArray(plan.mutations)) {
          for (const mutation of plan.mutations) {
            const targetSourceId = mutation.target_source_id || mutation.source_id;
            const valueSourceId = mutation.value_source_id;

            if (!composeSources[targetSourceId]) {
              return res.status(400).json({
                error: `Mutation target source ${targetSourceId} not found`,
                available: Object.keys(composeSources).map(id => id.replace('SOURCE_', 'Source '))
              });
            }

            if (!composeSources[valueSourceId]) {
              return res.status(400).json({
                error: `Mutation value source ${valueSourceId} not found`,
                available: Object.keys(composeSources).map(id => id.replace('SOURCE_', 'Source '))
              });
            }

            const mutationPath = mutation.path || mutation.target_path;
            if (!Array.isArray(mutationPath) || mutationPath.length === 0) {
              return res.status(400).json({ error: `Mutation path is required for ${targetSourceId}` });
            }

            const value = mutation.value_type === 'path' && Array.isArray(mutation.value_path)
              ? readFlexiblePath(composeSources[valueSourceId], mutation.value_path).value
              : composeSources[valueSourceId];

            if (value === undefined) {
              return res.status(400).json({
                error: `Mutation value path not found in ${valueSourceId}`,
                path: mutation.value_path
              });
            }

            setCaseInsensitivePath(composeSources[targetSourceId], mutationPath, structuredClone(value));
            console.log(`[COMPOSE] Mutated ${targetSourceId}.${mutationPath.join('.')} from ${valueSourceId}`);
          }
        }

        for (const part of plan.parts) {
          const sourceId = part.source_id;
          if (!composeSources[sourceId]) {
            return res.status(400).json({
              error: `Source ${sourceId} not found for key "${part.key}"`,
              available: Object.keys(composeSources).map(id => id.replace('SOURCE_', 'Source '))
            });
          }

          const data = composeSources[sourceId];

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
            const { value, resolvedPath } = readFlexiblePath(data, part.path);
            result[part.key] = value !== undefined ? value : null;
            console.log(`[COMPOSE] ${part.key}: extracted from path ${part.path.join('.')} resolved as ${resolvedPath.join('.')}`);

          } else if (part.type === 'entire') {
            // Include entire source
            result[part.key] = data;
            console.log(`[COMPOSE] ${part.key}: entire source ${sourceId}`);

          } else {
            result[part.key] = null;
            console.log(`[COMPOSE] ${part.key}: unknown type "${part.type}"`);
          }
        }

        return res.json(stripInternalOutputFields(result));
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
          return res.json(stripInternalOutputFields(pipelineResult.data || pipelineResult));
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
            if (r.results.length === 1) {
              const { source_id, ...payload } = r.results[0];
              return res.json(payload);
            }
            return res.json(r.results.map(({ source_id, ...payload }) => payload));
          }
          return res.json(allResults.map(r => ({
            operation: r.query.operation,
            results: r.results.map(({ source_id, ...payload }) => payload)
          })));
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
        return res.json(stripInternalOutputFields(pipelineResult.data || pipelineResult));
      }
      
      // JOIN action - LLM decided this is a join operation
      if (plan.action === 'join') {
        console.log('[LLM] Join action detected, proceeding to join planner');
        const { sourceReferenceGuide, compressedSources } = buildAiSourceContext(sources, sourceNames);

        const joinCompletion = await openai.chat.completions.create({
          model: AI_MODEL_MERGE,
          messages: [
            { role: 'system', content: JOIN_INSTRUCTIONS },
            {
              role: 'user',
              content: `## USER PROMPT\n${prompt}\n\n## SOURCE REFERENCES\n${sourceReferenceGuide}\n\n## DATA SOURCES (schema)\n${compressedSources}`
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
          return res.json(stripInternalOutputFields(joinResult));
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
      return res.json(stripInternalOutputFields(pipelineResult.data || pipelineResult));
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

// Serve syntax guide for frontend
app.get('/api/syntax-guide', async (req, res) => {
  try {
    const guidePath = path.join(process.cwd(), 'syntax_guide.json');
    const guideContent = await fs.readFile(guidePath, 'utf-8');
    res.json(JSON.parse(guideContent));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load syntax guide', details: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
