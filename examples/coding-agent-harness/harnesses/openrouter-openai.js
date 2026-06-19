#!/usr/bin/env node
if (!process.env.OPENROUTER_API_KEY) {
  console.log("openrouter-openai harness skipped: OPENROUTER_API_KEY is not set.");
  process.exit(0);
}

const baseURL = "https://openrouter.ai/api/v1";
console.log(`openrouter-openai harness stub: would use OpenAI-compatible baseURL ${baseURL}.`);
process.exit(0);
