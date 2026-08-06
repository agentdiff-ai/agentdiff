import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAgentMap, buildScenarioSuggestions, normalizeScenario } from "../packages/core/src/index.js";

const files = [
  {
    filePath: "src/agents/billingAgent.ts",
    content: `
import { sendInvoice } from "../tools/sendInvoice";
import { deleteAccountSchema } from "../tools/deleteAccountSchema";
export async function billingAgent() { return [sendInvoice, deleteAccountSchema]; }
`
  },
  {
    filePath: "src/tools/sendInvoice.ts",
    content: `
export const sendInvoice = tool({
  description: "Send an invoice to a customer",
  parameters: z.object({ recipientEmail: z.string(), amountUsd: z.number() }),
  execute: async ({ recipientEmail, amountUsd }) => billing.send({ recipientEmail, amountUsd })
});
`
  },
  {
    filePath: "src/tools/deleteAccountSchema.ts",
    content: `
export const deleteAccountSchema = {
  type: "function",
  function: { name: "delete_account", parameters: { type: "object" } }
};
`
  },
  {
    filePath: "src/tools/createLogger.ts",
    content: "export function createLogger() { return console; }"
  },
  {
    filePath: "src/tools/createWorkflow.ts",
    content: "export async function createWorkflow() { return workflowStore.create(); }"
  },
  {
    filePath: "docs/send-tools.md",
    content: "Call sendEmail() to send an external message."
  }
];

const map = buildAgentMap({
  repo: "scenario-suggestion-fixture",
  entrypointGlobs: ["src/agents/billingAgent.ts"],
  files
});
const suggestions = buildScenarioSuggestions(map);

assert.deepEqual(suggestions.map((item) => item.capability).sort(), ["delete_account", "sendInvoice"]);
assert.equal(suggestions.some((item) => item.capability === "createLogger"), false);
assert.equal(suggestions.some((item) => item.capability === "createWorkflow"), false, "unreachable tools must not produce suggestions");
for (const suggestion of suggestions) {
  assert.equal(suggestion.reachable_entrypoints[0], "src/agents/billingAgent.ts");
  assert.deepEqual(normalizeScenario(suggestion.scenario), suggestion.scenario);
  assert.deepEqual(suggestion.scenario.expectations.map((item) => item.type), ["must_not_call", "requires_confirmation"]);
}
assert.equal(buildScenarioSuggestions(map, { limit: 1 }).length, 1);
assert.equal(buildScenarioSuggestions(map, { limit: 0 }).length, 0);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-scenario-suggestions-"));
try {
  for (const file of files) {
    const target = path.join(tempRoot, file.filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  fs.writeFileSync(tempRoot + path.sep + "agentdiff.yml", "agentdiff:\n  entrypoints:\n    - src/agents/billingAgent.ts\n");
  const cli = path.resolve("packages/cli/bin/agentdiff.js");
  const scan = spawnSync(process.execPath, [cli, "scan", "--root", ".", "--out", ".agentdiff/runs/latest/map.json"], {
    cwd: tempRoot,
    encoding: "utf8"
  });
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stdout, /scenario suggestions: 2/);
  const mapOutput = JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "runs", "latest", "map.json"), "utf8"));
  const suggestionsOutput = JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "runs", "latest", "scenario-suggestions.json"), "utf8"));
  assert.equal(mapOutput.scan.scenario_suggestions, 2);
  assert.equal(mapOutput.scenario_suggestions.length, 2);
  assert.deepEqual(suggestionsOutput.suggestions, mapOutput.scenario_suggestions);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("scenario suggestion tests passed");
