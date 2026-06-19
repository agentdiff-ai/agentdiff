import assert from "node:assert/strict";
import { buildClassificationReport, classifyChangedFile } from "../packages/core/src/index.js";

// ---------------------------------------------------------------------------
// classifyChangedFile: doc/test/config files must not pick up content-based
// risk tags even when their prose mentions high-risk agent vocabulary.
// ---------------------------------------------------------------------------

const readmeSurface = classifyChangedFile({
  filePath: "README.md",
  content: `# Lead Agent

  This agent issues refunds, sends emails, closes tickets, and deletes records.
  It uses openai to generate responses and charges customers.

  ## Example

  \`\`\`js
  await refund({ customerId: "c_123", amountUsd: 49 });
  await send({ recipientEmail: "user@example.com" });
  \`\`\`
  `
});

assert.equal(readmeSurface.surface_category, "docs_example", "README.md must be classified as docs_example");
assert.ok(
  !readmeSurface.risk.includes("state_mutation"),
  "README.md must not receive state_mutation from content alone"
);
assert.ok(
  !readmeSurface.risk.includes("external_side_effect"),
  "README.md must not receive external_side_effect from content alone"
);

// Test files share the same rule.
const testFileSurface = classifyChangedFile({
  filePath: "tests/supportAgent.test.js",
  content: `test("refund", () => { refund({ customerId: "c_1", amountUsd: 10, recipientEmail: "a@b.com" }); });`
});

assert.equal(testFileSurface.surface_category, "test_fixture", "test file must be classified as test_fixture");
assert.ok(
  !testFileSurface.risk.includes("state_mutation"),
  "test file must not receive state_mutation from fixture content"
);
assert.ok(
  !testFileSurface.risk.includes("external_side_effect"),
  "test file must not receive external_side_effect from fixture content"
);

// Config files (yaml, package.json) share the same rule.
const configSurface = classifyChangedFile({
  filePath: "agentdiff.yml",
  content: "entrypoints:\n  - src/agent.js\n# sends refund and charge emails\n"
});

assert.equal(configSurface.surface_category, "config_metadata", "yml file must be classified as config_metadata");
assert.ok(
  !configSurface.risk.includes("state_mutation"),
  "config file must not receive state_mutation from content"
);

// ---------------------------------------------------------------------------
// Runtime JS agent files must still receive risk tags — the guard must not
// accidentally downrank actual tool implementations.
// ---------------------------------------------------------------------------

const runtimeToolSurface = classifyChangedFile({
  filePath: "src/tools/issueRefund.js",
  content: `export async function issueRefund({ customerId, amountUsd, recipientEmail }) {
  await stripe.refund({ customer: customerId, amount: amountUsd });
  await mailer.send({ to: recipientEmail });
}`
});

assert.ok(
  runtimeToolSurface.risk.includes("state_mutation"),
  "runtime tool JS must still receive state_mutation"
);
assert.ok(
  runtimeToolSurface.risk.includes("external_side_effect"),
  "runtime tool JS must still receive external_side_effect"
);

// ---------------------------------------------------------------------------
// buildClassificationReport: a README.md diff with agent vocabulary must not
// produce action_required or fail status.
// ---------------------------------------------------------------------------

const readmeDiff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Lead Agent

+This agent calls refund() and send() and close_ticket() to resolve billing issues.
+See the example: delete({ record_id: "r_1" });
`;

const docReport = buildClassificationReport({
  repo: "test-repo",
  files: [
    {
      filePath: "README.md",
      content: "# Lead Agent\n\nThis agent calls refund() and send() and close_ticket() to resolve billing issues.\n",
      diffText: readmeDiff
    }
  ]
});

assert.notEqual(docReport.status, "action_required", "README.md diff must not produce action_required status");
assert.notEqual(docReport.status, "fail", "README.md diff must not produce fail status");

// Diff-aware findings from the README must exist (visible) but be low severity.
const readmeDiffFindings = docReport.diff_aware_findings.filter((f) => f.path === "README.md");
for (const finding of readmeDiffFindings) {
  assert.equal(finding.severity, "low", "doc diff-aware finding must be low severity");
  assert.match(finding.title, /informational/i, "doc diff-aware finding title must use informational framing");
}

// The suppressed findings list must remain intact (nothing silently dropped).
assert.ok(
  Array.isArray(docReport.suppressed_findings),
  "suppressed_findings must be present even when there are no suppressions"
);

// ---------------------------------------------------------------------------
// buildClassificationReport: a genuine runtime tool diff must still produce
// the expected high-severity finding (no accidental downrank).
// ---------------------------------------------------------------------------

const toolDiff = `diff --git a/src/tools/sendInvoice.js b/src/tools/sendInvoice.js
--- /dev/null
+++ b/src/tools/sendInvoice.js
@@ -0,0 +1,5 @@
+export function sendInvoice({ recipientEmail, amountUsd, customerId }) {
+  return stripe.charge({ customer: customerId, amount: amountUsd });
+}
`;

const toolReport = buildClassificationReport({
  repo: "test-repo",
  files: [
    {
      filePath: "src/tools/sendInvoice.js",
      content: `export function sendInvoice({ recipientEmail, amountUsd, customerId }) {
  return stripe.charge({ customer: customerId, amount: amountUsd });
}`,
      diffText: toolDiff
    }
  ]
});

assert.ok(
  toolReport.status === "action_required" || toolReport.status === "fail",
  `runtime tool diff must produce action_required or fail, got: ${toolReport.status}`
);

const toolDiffFindings = toolReport.diff_aware_findings.filter((f) => f.path === "src/tools/sendInvoice.js");
assert.ok(toolDiffFindings.length > 0, "runtime tool diff must produce at least one diff-aware finding");
assert.equal(toolDiffFindings[0].severity, "high", "runtime tool diff-aware finding must be high severity");

console.log("doc downrank tests passed");
