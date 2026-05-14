import dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────────
// ENVIRONMENT VALIDATION
// ─────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
  console.error('[FATAL] Missing API key. Set OPENAI_API_KEY or GEMINI_API_KEY in your .env file.');
  process.exit(1);
}

export const config = {
  // Server
  PORT: process.env.PORT || 5000,
  IS_PROD: process.env.NODE_ENV === 'production',

  // API Keys
  API_KEY: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY,

  // AI Models
  AI_MODEL: process.env.AI_MODEL || 'gpt-4o-mini',

  // CORS
  CORS_ORIGINS: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:4173'],

  // Rate Limiting
  RATE_LIMIT: {
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 20 : 100
  },

  // File Upload
  MAX_FILE_SIZE: 100 * 1024 * 1024 // 100MB
};

export default config;
