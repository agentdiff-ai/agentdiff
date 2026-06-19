import assert from "node:assert/strict";
import { buildClassificationReport } from "../packages/core/src/index.js";

const report = buildClassificationReport({
  repo: "agentdiff",
  files: [
    {
      filePath: "examples/demo-support-agent/src/tools/sendInvoice.js",
      content: `// External side effect: sends an invoice email.
export function sendInvoice({ recipientEmail, amountUsd, customerId }) {
  return { invoiceId: "inv_123" };
}
`,
      agentMap: {
        version: "0.1",
        agents: [
          {
            id: "supportagent",
            entrypoints: ["examples/demo-support-agent/src/supportAgent.js"],
            tools: []
          }
        ],
        surfaces: [
          {
            path: "examples/demo-support-agent/src/supportAgent.js",
            label: "agent_entrypoint"
          }
        ]
      }
    }
  ]
});

assert.equal(report.status, "action_required");
assert.equal(report.map_drift.length, 1);
assert.equal(report.map_drift[0].finding_type, "new_unmapped_agent_surface");
assert.equal(report.map_drift[0].label, "tool_implementation");
assert.deepEqual(report.map_drift[0].risk, ["state_mutation", "external_side_effect"]);
assert.match(report.map_drift[0].title, /New unmapped high-risk tool/);
assert.ok(report.map_drift[0].evidence.some((item) => item.includes("sendInvoice")));
assert.ok(report.map_drift[0].evidence.some((item) => item.includes("recipientEmail")));

console.log("map drift tests passed");
