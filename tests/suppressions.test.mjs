import assert from "node:assert/strict";
import { buildClassificationReport } from "../packages/core/src/index.js";
import { renderMarkdownReport } from "../packages/report/src/markdown.js";

const now = new Date("2026-06-19T12:00:00Z");

function reportFor(file, suppressions = []) {
  return buildClassificationReport({
    repo: "fixture",
    suppressions,
    now,
    files: [
      {
        ...file,
        agentMap: {
          version: "0.1",
          surfaces: []
        }
      }
    ]
  });
}

const docsReport = reportFor(
  {
    filePath: "docs/tools.md",
    content: `
# Tools
Use createReactAgent with a tool that can send email updates.
`
  },
  [{ path: "docs/**", reason: "documentation examples", expires: "2026-07-31" }]
);

assert.equal(docsReport.status, "pass");
assert.equal(docsReport.map_drift.length, 0);
assert.equal(docsReport.suppressed_findings.length, 1);
assert.equal(docsReport.suppressed_findings[0].suppression.reason, "documentation examples");
assert.match(renderMarkdownReport(docsReport), /## suppressed findings/);

const expiredReport = reportFor(
  {
    filePath: "src/tools/sendInvoice.ts",
    content: `export function sendInvoice(recipientEmail, amountUsd, customerId) { return { recipientEmail, amountUsd, customerId }; }`
  },
  [{ path: "src/tools/**", reason: "old suppression", expires: "2026-01-01" }]
);

assert.equal(expiredReport.status, "action_required");
assert.equal(expiredReport.suppressed_findings.length, 0);
assert.ok(expiredReport.suppression_warnings.some((warning) => warning.includes("expired")));

const missingReasonReport = reportFor(
  {
    filePath: "src/tools/sendInvoice.ts",
    content: `export function sendInvoice(recipientEmail, amountUsd, customerId) { return { recipientEmail, amountUsd, customerId }; }`
  },
  [{ path: "src/tools/**", expires: "2026-07-31" }]
);

assert.equal(missingReasonReport.status, "action_required");
assert.equal(missingReasonReport.suppressed_findings.length, 0);
assert.ok(missingReasonReport.suppression_warnings.some((warning) => warning.includes("missing required reason")));

const missingExpiresReport = reportFor(
  {
    filePath: "src/tools/sendInvoice.ts",
    content: `export function sendInvoice(recipientEmail, amountUsd, customerId) { return { recipientEmail, amountUsd, customerId }; }`
  },
  [{ path: "src/tools/**", reason: "intentional billing tool" }]
);

assert.equal(missingExpiresReport.status, "pass");
assert.equal(missingExpiresReport.suppressed_findings.length, 1);
assert.ok(missingExpiresReport.suppression_warnings.some((warning) => warning.includes("missing expires")));

const runtimeNotSuppressed = reportFor(
  {
    filePath: "src/tools/sendInvoice.ts",
    content: `export function sendInvoice(recipientEmail, amountUsd, customerId) { return { recipientEmail, amountUsd, customerId }; }`
  },
  [{ path: "docs/**", reason: "documentation examples", expires: "2026-07-31" }]
);

assert.equal(runtimeNotSuppressed.status, "action_required");
assert.equal(runtimeNotSuppressed.map_drift.length, 1);
assert.equal(runtimeNotSuppressed.suppressed_findings.length, 0);
assert.ok(runtimeNotSuppressed.map_drift[0].explanation.why_flagged.length > 0);
assert.ok(runtimeNotSuppressed.map_drift[0].explanation.risk_evidence.length > 0);

const noopReport = reportFor({
  filePath: "src/utils.ts",
  content: `export function createNoopModel() { return {}; }`
});

assert.equal(noopReport.changed_surfaces[0].risk.includes("state_mutation"), false);
assert.notEqual(noopReport.status, "action_required");

const docsToolReport = reportFor({
  filePath: "docs/tools.md",
  content: `
# Tools
import { tool } from "@langchain/core/tools";
export const sendEmail = tool(() => "ok");
`
});

assert.equal(docsToolReport.changed_surfaces[0].surface_category, "docs_example");
assert.notEqual(docsToolReport.status, "action_required");

console.log("suppression tests passed");
