import { compressJson } from '../utils/helpers.js';

// ─────────────────────────────────────────────
// SOURCE MANAGER
// Handles parsing, resolution, and formatting of JSON sources
// ─────────────────────────────────────────────

/**
 * Parse raw inputs into a source registry
 * @param {Array} inputs - Array of { type, content, name }
 * @param {Array} files - Optional array of file objects from multer
 * @returns {{ sources: Object, sourceNames: Object, errors: Array }}
 */
export const parseInputs = (inputs, files = []) => {
  const sources = {};
  const sourceNames = {};
  const errors = [];

  if (!Array.isArray(inputs)) {
    return { sources, sourceNames, errors: ['No input sources provided'] };
  }

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i] || {};
    let content = (input.content || '').trim();
    const name = input.name || `Source ${i + 1}`;
    const sourceId = `SOURCE_${i + 1}`;

    // If no content, try to get from uploaded files
    if (!content && files.length > 0) {
      const file = files.find(f => f.originalname === name);
      if (file) content = file.buffer.toString('utf-8').trim();
    }

    if (!content) {
      errors.push(`Missing content for ${name}`);
      continue;
    }

    // Parse JSON
    try {
      const parsed = JSON.parse(content);
      sources[sourceId] = parsed;
      sourceNames[sourceId] = name;
    } catch (e) {
      errors.push(`Invalid JSON in ${name}: ${e.message}`);
    }
  }

  return { sources, sourceNames, errors };
};

/**
 * Resolve a source reference from user text to SOURCE_N
 * Handles: @Source 1, @Source1, Source 1, @filename.txt, etc.
 * @param {string} reference - User's source reference
 * @param {Object} sourceNames - Map of SOURCE_N → name
 * @returns {string|null} - SOURCE_N or null if not found
 */
export const resolveSourceReference = (reference, sourceNames) => {
  const ref = String(reference).trim();
  const refLower = ref.toLowerCase().replace('@', '');

  // Direct match: "source 1", "source1", "SOURCE_1"
  const numMatch = refLower.match(/source[\s_]?(\d+)/);
  if (numMatch) {
    const sourceId = `SOURCE_${numMatch[1]}`;
    if (sourceNames[sourceId]) return sourceId;
  }

  // Match by name
  for (const [sourceId, name] of Object.entries(sourceNames)) {
    if (name.toLowerCase() === refLower) return sourceId;
    if (name.toLowerCase().includes(refLower)) return sourceId;
  }

  return null;
};

/**
 * Extract all source references from a prompt
 * @param {string} prompt - User's prompt text
 * @param {Object} sourceNames - Map of SOURCE_N → name
 * @returns {string[]} - Array of SOURCE_N ids
 */
export const extractSourceReferences = (prompt, sourceNames) => {
  const ids = new Set();
  const text = String(prompt || '');

  // Pattern 1: @source<N>, @Source 1, Source1, etc.
  const patterns = [
    /@?source[\s_]?(\d+)/gi,
    /@([^\s@]+)/g  // @filename references
  ];

  // Extract @sourceN references
  let match;
  while ((match = patterns[0].exec(text)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) {
      ids.add(`SOURCE_${n}`);
    }
  }

  // Extract @filename references
  const atRefs = text.match(/@([^\s@]+)/g) || [];
  for (const atRef of atRefs) {
    const ref = atRef.slice(1); // Remove @
    const resolved = resolveSourceReference(ref, sourceNames);
    if (resolved) ids.add(resolved);
  }

  return [...ids];
};

/**
 * Format sources for AI consumption (compressed schema)
 * @param {Object} sources - Source data map
 * @param {Object} sourceNames - Source name map
 * @returns {string} - Formatted string for AI prompt
 */
export const formatSourcesForAI = (sources, sourceNames) => {
  return Object.entries(sources).map(([id, data]) => {
    const name = sourceNames[id] || id;
    const compressed = compressJson(data);
    return `### ${name} (ID: ${id})\n${JSON.stringify(compressed, null, 2)}`;
  }).join('\n\n');
};

/**
 * Get sources by IDs, or all if empty
 * @param {Object} sources - All sources
 * @param {string[]} sourceIds - Array of source IDs to get
 * @returns {Object} - Filtered sources
 */
export const getScopeFromIds = (sources, sourceIds) => {
  if (!sourceIds || sourceIds.length === 0) return sources;
  return Object.fromEntries(
    Object.entries(sources).filter(([id]) => sourceIds.includes(id))
  );
};

export default {
  parseInputs,
  resolveSourceReference,
  extractSourceReferences,
  formatSourcesForAI,
  getScopeFromIds
};
