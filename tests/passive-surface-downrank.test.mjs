import assert from "node:assert/strict";
import { buildClassificationReport } from "../packages/core/src/index.js";
import { renderMarkdownReport } from "../packages/report/src/markdown.js";

function reportFor({ filePath, content, addedLine }) {
  return buildClassificationReport({
    repo: "passive-surface-fixture",
    files: [
      {
        filePath,
        content,
        diffText: `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1,2 @@\n unchanged\n+${addedLine}\n`
      }
    ]
  });
}

for (const fixture of [
  {
    filePath: "README.md",
    content: "Call refund(), send(), and close_ticket().",
    addedLine: "Call refund(), send(), and close_ticket().",
    expectedActionability: "likely_noise"
  },
  {
    filePath: "tests/support-agent.test.js",
    content: "expect(send_email()).toBeDefined();",
    addedLine: "expect(send_email()).toBeDefined();",
    expectedActionability: "context_only"
  },
  {
    filePath: "agentdiff.yml",
    content: "example: issue_refund()",
    addedLine: "example: issue_refund()",
    expectedActionability: "likely_noise"
  }
]) {
  const report = reportFor(fixture);
  assert.equal(report.status, "pass", `${fixture.filePath} must not create action-required pressure`);
  assert.equal(report.diff_aware_findings.length, 1);
  assert.equal(report.diff_aware_findings[0].severity, "low");
  assert.equal(report.diff_aware_findings[0].actionability, fixture.expectedActionability);
  assert.match(report.diff_aware_findings[0].title, /low-priority surface/i);
  assert.match(report.diff_aware_findings[0].recommendation, /No action is required by default/);
  const markdown = renderMarkdownReport(report);
  assert.doesNotMatch(markdown, /\(high-risk\)|added high-risk call/i);
}

const runtimeReport = reportFor({
  filePath: "src/tools/sendInvoice.js",
  content: "export async function sendInvoice() { return charge_card(); }",
  addedLine: "export async function sendInvoice() { return charge_card(); }"
});
assert.equal(runtimeReport.status, "action_required");
assert.equal(runtimeReport.diff_aware_findings[0].severity, "high");
assert.equal(runtimeReport.diff_aware_findings[0].actionability, "action_required");
assert.match(runtimeReport.diff_aware_findings[0].title, /High-risk agent behavior added/);

const removedGuardrail = buildClassificationReport({
  repo: "passive-surface-fixture",
  files: [
    {
      filePath: "src/agents/supportAgent.js",
      content: "export async function supportAgent() { return draft_response(); }",
      diffText: `diff --git a/src/agents/supportAgent.js b/src/agents/supportAgent.js
--- a/src/agents/supportAgent.js
+++ b/src/agents/supportAgent.js
@@ -1 +1 @@
-escalate_to_human_review()
+draft_response()
`
    }
  ]
});
assert.equal(removedGuardrail.status, "warn");
assert.equal(removedGuardrail.diff_aware_findings[0].actionability, "review_recommended");
assert.equal(removedGuardrail.diff_aware_findings[0].severity, "medium");

console.log("passive surface downrank tests passed");
