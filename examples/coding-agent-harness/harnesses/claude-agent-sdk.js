#!/usr/bin/env node
if (!process.env.ANTHROPIC_API_KEY) {
  console.log("claude-agent-sdk harness skipped: ANTHROPIC_API_KEY is not set.");
  process.exit(0);
}

console.log("claude-agent-sdk harness stub: install the Anthropic Agent SDK before live execution.");
process.exit(0);
