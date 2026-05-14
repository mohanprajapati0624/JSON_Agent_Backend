import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { formatSourcesForAI } from './sourceManager.js';

// ─────────────────────────────────────────────
// AI PLANNER
// Handles communication with AI for plan generation
// ─────────────────────────────────────────────

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: config.API_KEY
});

// Load the unified prompt
let UNIFIED_PROMPT = '';

export const loadPrompt = async () => {
  try {
    UNIFIED_PROMPT = await fs.readFile(
      path.join(process.cwd(), 'prompts', 'unified.txt'),
      'utf-8'
    );
    console.log(`[AI] Loaded unified prompt (${UNIFIED_PROMPT.length} chars)`);
  } catch (e) {
    console.error('[AI] Failed to load unified prompt:', e.message);
    // Fallback minimal prompt
    UNIFIED_PROMPT = `You are a JSON Architect AI. Return a valid JSON plan based on the user's request.
Plan types: extract, query, merge, join, pipeline.
See user prompt and data sources to understand what to do.`;
  }
};

/**
 * Generate an execution plan using AI
 * @param {string} prompt - User's instruction
 * @param {Object} sources - Source data map
 * @param {Object} sourceNames - Source name map
 * @returns {Object} - Parsed plan object
 */
export const generatePlan = async (prompt, sources, sourceNames) => {
  // Format sources for AI (compressed schema)
  const sourcesText = formatSourcesForAI(sources, sourceNames);

  const userMessage = `## USER PROMPT
${prompt}

## DATA SOURCES (Schema - keys preserved, values replaced with type placeholders)
${sourcesText}`;

  console.log(`[AI] Generating plan for: "${prompt.substring(0, 100)}..."`);

  const completion = await openai.chat.completions.create({
    model: config.AI_MODEL,
    messages: [
      { role: 'system', content: UNIFIED_PROMPT },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 3000
  });

  const responseText = completion.choices[0].message.content.trim();
  console.log(`[AI] Plan generated:\n${responseText.substring(0, 500)}...`);

  // Parse and validate
  let plan;
  try {
    plan = JSON.parse(responseText);
  } catch (e) {
    throw new Error(`AI returned invalid JSON: ${e.message}`);
  }

  // Write debug file in dev mode
  if (!config.IS_PROD) {
    await fs.writeFile(
      path.join(process.cwd(), 'debug_plan.json'),
      JSON.stringify(plan, null, 2)
    ).catch(() => {});
  }

  return plan;
};

/**
 * Check if a prompt is a simple extraction that doesn't need AI
 * Returns the extraction details or null if AI is needed
 */
export const trySimpleExtraction = (prompt, sources, sourceNames) => {
  const p = prompt.trim().toLowerCase();

  // Pattern: "what is in @Source 2", "show @Source1", "get source 3"
  const showSourceMatch = prompt.match(
    /(?:what(?:'s| is)?(?: in)?|show(?: me)?|get|display|extract|return|give(?: me)?)\s*@?source\s*(\d+)/i
  );
  if (showSourceMatch) {
    const sourceId = `SOURCE_${showSourceMatch[1]}`;
    if (sources[sourceId]) {
      return { type: 'extract', sourceId, index: null, path: null };
    }
  }

  // Pattern: "@Source 1" or "source 2" alone
  const bareSourceMatch = prompt.match(/^@?source\s*(\d+)\s*$/i);
  if (bareSourceMatch) {
    const sourceId = `SOURCE_${bareSourceMatch[1]}`;
    if (sources[sourceId]) {
      return { type: 'extract', sourceId, index: null, path: null };
    }
  }

  // Pattern: "@Source 1's first object", "first element from @Source 2"
  const elementPatterns = [
    // @Source 1's first/second/last/[N]
    /@?source\s*(\d+)(?:'s)?\s*(?:\[(\d+)\]|(first|1st|second|2nd|third|3rd|last|(\d+)(?:st|nd|rd|th)?))/i,
    // first/last element from @Source N
    /(first|1st|second|2nd|third|3rd|last|(\d+)(?:st|nd|rd|th)?)\s*(?:object|element|item|entry)?\s*(?:from|of|in)\s*@?source\s*(\d+)/i
  ];

  for (const pattern of elementPatterns) {
    const match = prompt.match(pattern);
    if (match) {
      let sourceNum, index;

      // First pattern: @Source N's X
      if (match[1] && !match[3]?.match(/source/i)) {
        sourceNum = Number(match[1]);
        if (match[2] !== undefined) {
          index = Number(match[2]); // [0], [1], etc.
        } else {
          index = parseOrdinal(match[3] || p);
        }
      }
      // Second pattern: X from @Source N
      else if (match[3]) {
        sourceNum = Number(match[3]);
        index = parseOrdinal(match[1] || p);
      }

      if (sourceNum) {
        const sourceId = `SOURCE_${sourceNum}`;
        if (sources[sourceId]) {
          return { type: 'extract', sourceId, index, path: null };
        }
      }
    }
  }

  return null;
};

/**
 * Parse ordinal text to index
 */
const parseOrdinal = (text) => {
  const lower = String(text).toLowerCase();
  if (lower.includes('first') || lower.includes('1st')) return 0;
  if (lower.includes('second') || lower.includes('2nd')) return 1;
  if (lower.includes('third') || lower.includes('3rd')) return 2;
  if (lower.includes('fourth') || lower.includes('4th')) return 3;
  if (lower.includes('fifth') || lower.includes('5th')) return 4;
  if (lower.includes('last')) return -1;

  const numMatch = lower.match(/(\d+)(?:st|nd|rd|th)?/);
  if (numMatch) return Number(numMatch[1]) - 1;

  return 0;
};

export default {
  loadPrompt,
  generatePlan,
  trySimpleExtraction
};
