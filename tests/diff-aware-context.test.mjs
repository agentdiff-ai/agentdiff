import assert from "node:assert/strict";
import { buildClassificationReport } from "../packages/core/src/index.js";

assert.deepEqual(highRiskCallsFor({
  filePath: "src/agents/sheetsAgent.js",
  addedLines: ["await createSheetTool(input);"]
}), ["createSheetTool"]);

assert.deepEqual(highRiskCallsFor({
  filePath: "src/mcp/tools/sheets.ts",
  addedLines: ["await appendSheetValues({ spreadsheetId, values });"]
}), ["appendSheetValues"]);

assert.deepEqual(highRiskCallsFor({
  filePath: "src/mcp/tools/agent-management.ts",
  addedLines: ["await createAgentTool(request);", "await deleteAgent(request.oldAgentId);"]
}), ["createAgentTool", "deleteAgent"]);

assert.deepEqual(highRiskCallsFor({
  filePath: "src/workflows/billingWorkflow.ts",
  addedLines: ["await createWorkflow(request);", "await scheduleWorkflow(request);"]
}), ["createWorkflow", "scheduleWorkflow"]);

assert.deepEqual(highRiskCallsFor({
  filePath: "src/agents/loggerAgent.js",
  addedLines: ["const logger = createLogger({ name: 'agent' });"]
}), []);

assert.deepEqual(highRiskCallsFor({
  filePath: "src/agents/githubAgent.js",
  addedLines: ["const octokit = createOctokit({ token });", "const client = createGeminiClient({ apiKey });"]
}), []);

assert.deepEqual(highRiskCallsFor({
  filePath: "packages/core/src/memory/test-utils.ts",
  addedLines: ["const message = createTestUIMessage(input);", "const agent = createMockAgent(input);"]
}), []);

assert.deepEqual(highRiskCallsFor({
  filePath: "src/agents/deployAgent.js",
  addedLines: ["const env = envWithoutDeploymentName(process.env);"]
}), []);

assert.deepEqual(highRiskCallsFor({
  filePath: "src/agents/browserAgent.js",
  addedLines: ["window.addEventListener('click', onClick);", "node.appendChild(child);"]
}), []);

assert.deepEqual(highRiskCallsFor({
  filePath: "frontend/src/components/Counter.tsx",
  addedLines: ["const store = createStore({ count: 0 });"]
}), []);

console.log("diff-aware context tests passed");

function highRiskCallsFor({ filePath, addedLines }) {
  const diffText = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1,1 +1,1 @@",
    ...addedLines.map((line) => `+${line}`)
  ].join("\n");

  const report = buildClassificationReport({
    repo: "agentdiff-test",
    files: [
      {
        filePath,
        content: addedLines.join("\n"),
        diffText
      }
    ]
  });

  return report.diff_aware_findings.flatMap((finding) => finding.added_high_risk_calls ?? []);
}
