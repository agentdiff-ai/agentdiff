import assert from "node:assert/strict";
import { analyzeTracePair, buildStateMutationDiff } from "../packages/core/src/index.js";
import { renderMarkdownReport } from "../packages/report/src/markdown.js";

function trace({ branch, before = {}, after = {} }) {
  return {
    scenario_id: "state-boundary",
    branch,
    tool_calls: [],
    state_before: before,
    state_after: after
  };
}

const base = trace({
  branch: "base",
  before: { ticket: { status: "open", refund_status: "none", needs_human_review: false } },
  after: { ticket: { status: "open", refund_status: "none", needs_human_review: true } }
});
const head = trace({
  branch: "head",
  before: { ticket: { status: "open", refund_status: "none", needs_human_review: false } },
  after: { ticket: { status: "closed", refund_status: "issued", needs_human_review: false } }
});

const report = analyzeTracePair({ baseTrace: base, headTrace: head });
const finding = report.behavior_findings.find((item) => item.finding_type === "state_diff");
assert.equal(report.status, "action_required");
assert.equal(finding?.severity, "high");
assert.equal(report.state_diff.added_mutation_count, 2);
assert.equal(report.state_diff.removed_mutation_count, 1);
assert.equal(report.state_diff.consequential_mutation_count, 3);
assert.deepEqual(report.state_diff.added_mutations.map((item) => item.path).sort(), ["ticket.refund_status", "ticket.status"]);
assert.deepEqual(report.state_diff.removed_mutations.map((item) => item.path), ["ticket.needs_human_review"]);
assert.ok(finding.evidence.some((item) => item.includes("added head mutation ticket.status")));
assert.ok(finding.evidence.some((item) => item.includes("removed base mutation ticket.needs_human_review")));

const markdown = renderMarkdownReport(report);
assert.match(markdown, /## state mutation diff/);
assert.match(markdown, /new in head: 2/);
assert.match(markdown, /missing from head: 1/);
assert.match(markdown, /consequential changes: 3/);
assert.match(markdown, /added head mutation: ticket\.status/);

const genericReport = analyzeTracePair({
  baseTrace: trace({ branch: "base", before: { cache: { hits: 0 } }, after: { cache: { hits: 0 } } }),
  headTrace: trace({ branch: "head", before: { cache: { hits: 0 } }, after: { cache: { hits: 1 } } })
});
assert.equal(genericReport.status, "warn");
assert.equal(genericReport.behavior_findings[0].severity, "medium");

const camelCaseGuardrailReport = analyzeTracePair({
  baseTrace: trace({ branch: "base", before: { requiresHumanReview: false }, after: { requiresHumanReview: true } }),
  headTrace: trace({ branch: "head", before: { requiresHumanReview: false }, after: { requiresHumanReview: false } })
});
assert.equal(camelCaseGuardrailReport.status, "action_required");
assert.deepEqual(camelCaseGuardrailReport.state_diff.removed_mutations.map((item) => item.path), ["requiresHumanReview"]);

const equalReport = analyzeTracePair({
  baseTrace: trace({ branch: "base", before: { profile: { name: "Ada", flags: ["a", "b"] } }, after: { profile: { name: "Ada", flags: ["a", "b"] } } }),
  headTrace: trace({ branch: "head", before: { profile: { flags: ["a", "b"], name: "Ada" } }, after: { profile: { flags: ["a", "b"], name: "Ada" } } })
});
assert.equal(equalReport.status, "pass");
assert.equal(equalReport.state_diff.added_mutation_count, 0);

const capped = buildStateMutationDiff(
  trace({ branch: "base", before: {}, after: {} }),
  trace({ branch: "head", before: { a: 0, b: 0 }, after: { a: 1, b: 1 } }),
  { limit: 1 }
);
assert.equal(capped.added_mutation_count, 2);
assert.equal(capped.added_mutations.length, 1);
assert.equal(capped.top_changes.length, 1);
assert.equal(capped.truncated, true);

const zeroLimit = buildStateMutationDiff(base, head, { limit: 0 });
assert.equal(zeroLimit.added_mutation_count, 2);
assert.equal(zeroLimit.added_mutations.length, 0);
assert.equal(zeroLimit.consequential_mutation_count, 3);
assert.equal(zeroLimit.top_changes.length, 0);
assert.equal(zeroLimit.truncated, true);

console.log("state mutation diff tests passed");
