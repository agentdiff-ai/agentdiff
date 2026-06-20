import assert from "node:assert/strict";
import { renderMarkdownReport } from "../packages/report/src/markdown.js";

const report = {
  mode: "classify",
  status: "action_required",
  changed_surfaces: [
    { path: "src/tools/sendEmail.ts", actionability: "action_required" },
    { path: "examples/demo/tool.ts", actionability: "review_recommended" },
    { path: "frontend/src/Button.tsx", actionability: "context_only" },
    { path: "docs/tools.md", actionability: "likely_noise" }
  ],
  diff_aware_findings: [
    {
      title: "High-risk agent behavior added",
      path: "src/tools/sendEmail.ts",
      severity: "high",
      finding_type: "behavior_surface_change",
      added_calls: ["sendEmail"],
      added_high_risk_calls: ["sendEmail"],
      removed_calls: [],
      removed_safer_calls: [],
      reason: "The PR added a customer-visible send action.",
      evidence: ["added high-risk call: sendEmail"],
      recommendation: "Review before merge."
    }
  ],
  map_drift: [
    {
      title: "Example tool changed",
      path: "examples/demo/tool.ts",
      severity: "medium",
      finding_type: "changed_agent_surface",
      label: "tool_implementation",
      surface_category: "ai_sdk_tool",
      risk: ["external_side_effect"],
      actionability: "review_recommended",
      reachability_provenance: "example",
      reachable_from_entrypoint: false,
      evidence: ["example_template_context"],
      recommendation: "Review if this example matters."
    },
    {
      title: "UI state changed",
      path: "frontend/src/Button.tsx",
      severity: "low",
      finding_type: "changed_agent_surface",
      label: "not_agent_related",
      surface_category: "unclassified",
      risk: ["state_mutation"],
      actionability: "context_only",
      reachability_provenance: "runtime",
      reachable_from_entrypoint: false,
      evidence: ["frontend_ui_context"],
      recommendation: "Treat as context."
    },
    {
      title: "Docs mention tool",
      path: "docs/tools.md",
      severity: "low",
      finding_type: "changed_agent_surface",
      label: "tool_implementation",
      surface_category: "docs_example",
      risk: ["external_side_effect"],
      actionability: "likely_noise",
      reachability_provenance: "docs",
      reachable_from_entrypoint: false,
      evidence: ["docs_context"],
      recommendation: "Keep as context."
    }
  ],
  suppressed_findings: [],
  suppression_warnings: [],
  behavior_findings: [],
  cost: {
    estimated_cost_usd: 0,
    actual_cost_usd: 0
  }
};

const markdown = renderMarkdownReport(report);

assert.match(markdown, /action_required: 1/);
assert.match(markdown, /review_recommended: 1/);
assert.match(markdown, /context_only: 1/);
assert.match(markdown, /likely_noise: 1/);

const actionIndex = markdown.indexOf("## Action required (1)");
const reviewIndex = markdown.indexOf("## Review recommended (1)");
const contextIndex = markdown.indexOf("<summary>Context only (1)</summary>");
const noiseIndex = markdown.indexOf("<summary>Likely noise (1)</summary>");

assert.ok(actionIndex !== -1, "action_required group should render");
assert.ok(reviewIndex > actionIndex, "review_recommended should render after action_required");
assert.ok(contextIndex > reviewIndex, "context_only should render after review_recommended");
assert.ok(noiseIndex > contextIndex, "likely_noise should render after context_only");

assert.match(markdown, /Context-only findings are shown for traceability/);
assert.match(markdown, /do not mean this PR is unsafe/);
assert.match(markdown, /Likely-noise findings are low-priority/);
assert.match(markdown, /<details>/);

assert.equal(report.diff_aware_findings.length, 1, "JSON report object should keep diff-aware findings");
assert.equal(report.map_drift.length, 3, "JSON report object should keep all map drift findings");
assert.equal(report.changed_surfaces.length, 4, "JSON report object should keep all changed surfaces");

console.log("report actionability tests passed");
