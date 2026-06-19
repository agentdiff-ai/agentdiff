import assert from "node:assert/strict";
import { buildAgentMap, buildClassificationReport } from "../packages/core/src/index.js";

const files = [
  {
    filePath: "src/supportAgent.js",
    content: `
import React from "react";
import { issueRefund } from "./tools/refund";
import "./side-effect";
export { sendInvoice } from "./tools";
const closeTicket = require("./tools/closeTicket");
export async function runSupportAgent() {
  await issueRefund();
  await closeTicket();
}
`
  },
  {
    filePath: "src/side-effect.ts",
    content: `export const sideEffect = true;`
  },
  {
    filePath: "src/tools/refund.ts",
    content: `
import { auditRefund } from "../audit";
export function issueRefund(customerId, amountUsd) {
  auditRefund(customerId);
  return amountUsd;
}
`
  },
  {
    filePath: "src/audit/index.ts",
    content: `export function auditRefund(customerId) { return customerId; }`
  },
  {
    filePath: "src/tools/index.ts",
    content: `export { sendInvoice } from "./sendInvoice";`
  },
  {
    filePath: "src/tools/sendInvoice.ts",
    content: `export function sendInvoice(recipientEmail, amountUsd, customerId) { return { recipientEmail, amountUsd, customerId }; }`
  },
  {
    filePath: "src/tools/closeTicket.js",
    content: `module.exports = function closeTicket() { return true; };`
  },
  {
    filePath: "docs/agent-refund.md",
    content: `This document mentions refund, close, update, and send behavior.`
  }
];

const map = buildAgentMap({
  repo: "fixture",
  entrypointGlobs: ["src/supportAgent.js"],
  files
});

assert.deepEqual(map.import_graph.entrypoints, ["src/supportAgent.js"]);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/supportAgent.js" && edge.to === "src/tools/refund.ts"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/tools/refund.ts" && edge.to === "src/audit/index.ts"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/supportAgent.js" && edge.to === "src/tools/index.ts"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/tools/index.ts" && edge.to === "src/tools/sendInvoice.ts"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/supportAgent.js" && edge.to === "src/tools/closeTicket.js"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.import_statement.includes("react")), false);

const sendInvoice = map.surfaces.find((surface) => surface.path === "src/tools/sendInvoice.ts");
assert.ok(sendInvoice);
assert.equal(sendInvoice.reachable_from_entrypoint, true);
assert.deepEqual(sendInvoice.reachable_entrypoints, ["src/supportAgent.js"]);
assert.equal(sendInvoice.imported_by.some((item) => item.path === "src/tools/index.ts"), true);
assert.ok(sendInvoice.confidence >= 0.86);

const docsSurface = map.surfaces.find((surface) => surface.path === "docs/agent-refund.md");
assert.ok(docsSurface);
assert.equal(docsSurface.reachable_from_entrypoint, false);
assert.ok(docsSurface.confidence <= 0.4);
assert.ok(docsSurface.evidence.some((item) => item.includes("not reachable")));

const report = buildClassificationReport({
  repo: "fixture",
  files: [
    {
      filePath: "docs/agent-refund.md",
      content: files.at(-1).content,
      agentMap: {
        surfaces: []
      }
    }
  ]
});

assert.equal(report.map_drift.length, 1);
assert.equal(report.map_drift[0].severity, "low");
assert.notEqual(report.status, "action_required");

console.log("import graph tests passed");
