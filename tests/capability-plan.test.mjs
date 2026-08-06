import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  CapabilityPolicyValidationError,
  buildCapabilityPlan,
  loadScenarioFile,
  normalizeCapabilityPolicy
} from "../packages/core/src/index.js";
import { renderMarkdownReport } from "../packages/report/src/markdown.js";

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");
const action = path.join(repoRoot, "packages", "github-action", "index.js");
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "capability-plan");
const policy = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "refund-policy.json"), "utf8"));
const scenario = loadScenarioFile(path.join(fixtureRoot, "scenarios", "refund.json"));
const expectedRevision = "0123456789abcdef0123456789abcdef01234567";

function executionProvenance(overrides = {}) {
  return {
    schema_version: "0.1",
    git_revision: expectedRevision,
    worktree_dirty: false,
    harness_id: "test-harness",
    verified: true,
    verification_errors: [],
    ...overrides
  };
}

const classificationReport = {
  repo: "refund-agent",
  status: "action_required",
  changed_files: ["src/supportAgent.js"],
  changed_surfaces: [{ path: "src/supportAgent.js" }],
  diff_aware_findings: [
    {
      path: "src/supportAgent.js",
      severity: "high",
      added_high_risk_calls: ["issueRefund", "closeTicket"],
      removed_safer_calls: ["escalateRefund"],
      evidence: ["agent runtime path"]
    }
  ],
  map_drift: [],
  suppressed_findings: []
};

const passingRunReport = {
  mode: "base_head_light",
  execution_provenance: executionProvenance(),
  scenario_result: {
    scenario_id: "refund_requires_human_approval",
    status: "pass",
    expectations_total: 2,
    expectations_passed: 2,
    expectations_failed: 0,
    expectation_results: []
  }
};
const failingRunReport = {
  mode: "base_head_light",
  source_path: ".agentdiff/evidence/refund/report.json",
  execution_provenance: executionProvenance(),
  scenario_result: {
    scenario_id: "refund_requires_human_approval",
    status: "fail",
    expectations_total: 2,
    expectations_passed: 1,
    expectations_failed: 1,
    expectation_results: [
      {
        type: "requires_confirmation",
        status: "fail",
        reason: "issueRefund executed without confirmed=true",
        evidence: ["issueRefund: confirmed=no"]
      }
    ]
  }
};

const covered = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [passingRunReport],
  expectedRevision,
  policySource: "refund-policy.json"
});

assert.equal(covered.decision, "review");
assert.equal(covered.summary.added_capabilities, 2);
assert.equal(covered.summary.removed_guardrails, 1);
assert.equal(covered.summary.covered, 1);
assert.equal(covered.summary.declared_covered, 1);
assert.equal(covered.summary.unmatched_capabilities, 1);
assert.equal(covered.capability_changes[0].rule_id, "refunds-require-approval");
assert.equal(covered.capability_changes[0].coverage.confirmation_covered, true);
assert.equal(covered.capability_changes[0].coverage.execution_covered, true);
assert.deepEqual(covered.capability_changes[0].coverage.passing_scenarios, ["refund_requires_human_approval"]);

const uncovered = buildCapabilityPlan({ classificationReport, policy, scenarios: [], policySource: "refund-policy.json" });
assert.equal(uncovered.decision, "block");
assert.deepEqual(uncovered.capability_changes[0].coverage.missing_scenarios, ["refund_requires_human_approval"]);

const failingExecution = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [failingRunReport],
  expectedRevision,
  policySource: "refund-policy.json"
});
assert.equal(failingExecution.decision, "block");
assert.deepEqual(failingExecution.capability_changes[0].coverage.failing_scenarios, ["refund_requires_human_approval"]);
assert.equal(failingExecution.capability_changes[0].coverage.execution_evidence[0].failed_expectations[0].type, "requires_confirmation");

const failingMarkdown = renderMarkdownReport(failingExecution);
assert.match(failingMarkdown, /run evidence: refund_requires_human_approval=fail/);
assert.match(failingMarkdown, /FAIL requires_confirmation: issueRefund executed without confirmed=true/);

const conflictingExecution = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [passingRunReport, failingRunReport],
  expectedRevision
});
assert.equal(conflictingExecution.decision, "block");
assert.deepEqual(conflictingExecution.capability_changes[0].coverage.failing_scenarios, ["refund_requires_human_approval"]);

const malformedExecution = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [{
    execution_provenance: executionProvenance(),
    scenario_result: { scenario_id: "refund_requires_human_approval", status: "pass" }
  }],
  expectedRevision
});
assert.equal(malformedExecution.decision, "block");
assert.deepEqual(malformedExecution.capability_changes[0].coverage.invalid_execution_scenarios, ["refund_requires_human_approval"]);

const staleExecution = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [{ ...passingRunReport, execution_provenance: executionProvenance({ git_revision: "stale" }) }],
  expectedRevision
});
assert.equal(staleExecution.decision, "block");
assert.deepEqual(staleExecution.capability_changes[0].coverage.stale_execution_scenarios, ["refund_requires_human_approval"]);

const mismatchedBehaviorHead = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [{ ...passingRunReport, execution_provenance: executionProvenance({ head_revision: "different-head" }) }],
  expectedRevision
});
assert.equal(mismatchedBehaviorHead.decision, "block");
assert.deepEqual(mismatchedBehaviorHead.capability_changes[0].coverage.stale_execution_scenarios, ["refund_requires_human_approval"]);

const unapprovedHarness = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [{ ...passingRunReport, execution_provenance: executionProvenance({ harness_id: "unknown-harness" }) }],
  expectedRevision
});
assert.equal(unapprovedHarness.decision, "block");
assert.deepEqual(unapprovedHarness.capability_changes[0].coverage.unapproved_harness_scenarios, ["refund_requires_human_approval"]);

const dirtyWorktree = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [{ ...passingRunReport, execution_provenance: executionProvenance({ worktree_dirty: true }) }],
  expectedRevision
});
assert.equal(dirtyWorktree.decision, "block");
assert.deepEqual(dirtyWorktree.capability_changes[0].coverage.dirty_worktree_scenarios, ["refund_requires_human_approval"]);
assert.deepEqual(dirtyWorktree.capability_changes[0].coverage.execution_evidence[0].rejection_reasons, ["worktree_not_clean"]);

const unverifiedArtifacts = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  runReports: [{ ...passingRunReport, execution_provenance: executionProvenance({ verified: false }) }],
  expectedRevision
});
assert.equal(unverifiedArtifacts.decision, "block");
assert.deepEqual(unverifiedArtifacts.capability_changes[0].coverage.unverified_artifact_scenarios, ["refund_requires_human_approval"]);

const changedPolicyControl = buildCapabilityPlan({
  classificationReport: {
    ...classificationReport,
    changed_files: ["agentdiff.policy.json"],
    changed_surfaces: [{ path: "agentdiff.policy.json" }],
    diff_aware_findings: []
  },
  policy,
  scenarios: [scenario],
  policySource: "agentdiff.policy.json"
});
assert.equal(changedPolicyControl.decision, "block");
assert.equal(changedPolicyControl.summary.changed_review_controls, 1);
assert.equal(changedPolicyControl.summary.removed_guardrails, 0);
assert.equal(changedPolicyControl.control_changes[0].control, "policy");

const changedScenarioControl = buildCapabilityPlan({
  classificationReport: {
    ...classificationReport,
    changed_files: [scenario.source_path],
    changed_surfaces: [{ path: scenario.source_path }]
  },
  policy,
  scenarios: [scenario],
  runReports: [passingRunReport],
  expectedRevision,
  policySource: "refund-policy.json"
});
assert.equal(changedScenarioControl.decision, "block");
assert.equal(changedScenarioControl.summary.changed_review_controls, 1);
assert.equal(changedScenarioControl.summary.removed_guardrails, 1);
assert.equal(changedScenarioControl.control_changes.at(-1).control, "scenario");

const harnessRunReport = {
  ...passingRunReport,
  execution_provenance: executionProvenance({
    artifacts: {
      harness_module: {
        path: ".agentdiff/harness.js",
        repository_local: true,
        sha256: "fixture"
      }
    }
  })
};
const changedHarnessControl = buildCapabilityPlan({
  classificationReport: {
    ...classificationReport,
    changed_files: [".agentdiff/harness.js"],
    changed_surfaces: [{ path: ".agentdiff/harness.js" }],
    diff_aware_findings: []
  },
  policy,
  scenarios: [scenario],
  runReports: [harnessRunReport]
});
assert.equal(changedHarnessControl.decision, "block");
assert.equal(changedHarnessControl.control_changes[0].control, "harness");

const configuredControlPolicy = {
  ...policy,
  controls: {
    decision: "block",
    paths: [".github/workflows/agentdiff*.yml"]
  }
};
const changedConfiguredControl = buildCapabilityPlan({
  classificationReport: {
    ...classificationReport,
    changed_files: [".github/workflows/agentdiff.yml"],
    changed_surfaces: [{ path: ".github/workflows/agentdiff.yml" }],
    diff_aware_findings: []
  },
  policy: configuredControlPolicy,
  scenarios: []
});
assert.equal(changedConfiguredControl.decision, "block");
assert.equal(changedConfiguredControl.control_changes[0].control, "configured");

const unrelatedChange = buildCapabilityPlan({
  classificationReport: {
    ...classificationReport,
    changed_files: ["docs/architecture.md"],
    changed_surfaces: [{ path: "docs/architecture.md" }],
    diff_aware_findings: []
  },
  policy: configuredControlPolicy,
  scenarios: []
});
assert.equal(unrelatedChange.decision, "allow");
assert.equal(unrelatedChange.summary.changed_review_controls, 0);

const noChanges = buildCapabilityPlan({
  classificationReport: { ...classificationReport, diff_aware_findings: [] },
  policy,
  scenarios: [scenario]
});
assert.equal(noChanges.decision, "allow");

assert.throws(
  () => buildCapabilityPlan({ classificationReport, policy, scenarios: [scenario, scenario] }),
  /duplicate scenario id/
);

assert.throws(
  () => normalizeCapabilityPolicy({ version: "0.1", defaults: { unmatched: "ship" }, rules: [] }),
  CapabilityPolicyValidationError
);
assert.throws(
  () => normalizeCapabilityPolicy({
    version: "0.1",
    rules: [{ id: "bad-execution", capability: "issueRefund", reason: "needs run", require: { execution: true } }]
  }),
  /needs at least one required scenario/
);
assert.throws(
  () => normalizeCapabilityPolicy({ version: "0.1", controls: { decision: "review", paths: ["controls/**"] }, rules: [] }),
  /controls\.decision must be block/
);
assert.throws(
  () => normalizeCapabilityPolicy({ version: "0.1", controls: { decision: "block", paths: [""] }, rules: [] }),
  CapabilityPolicyValidationError
);

const markdown = renderMarkdownReport(uncovered);
assert.match(markdown, /decision: \*\*BLOCK\*\*/);
assert.match(markdown, /policy: refund-policy\.json \(v0\.1\)/);
assert.match(markdown, /## Block \(1\)/);
assert.match(markdown, /missing: refund_requires_human_approval/);
assert.match(markdown, /Removed guardrail: escalateRefund/);
assert.ok(markdown.indexOf("## Block (1)") < markdown.indexOf("## Review (2)"));
assert.match(markdown, /not a vulnerability claim/);
const controlMarkdown = renderMarkdownReport(changedScenarioControl);
assert.match(controlMarkdown, /changed review controls: 1/);
assert.match(controlMarkdown, /Changed review control:/);
assert.match(controlMarkdown, /control type: scenario/);

const missingDiffInput = spawnSync(process.execPath, [cli, "plan"], { encoding: "utf8" });
assert.equal(missingDiffInput.status, 1);
assert.match(missingDiffInput.stderr, /plan needs either --files or both --base and --head/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-plan-test-"));
try {
  execFileSync("git", ["init"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempRoot });
  execFileSync("git", ["config", "user.name", "Agentdiff Test"], { cwd: tempRoot });
  fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "src", "supportAgent.js"), "export async function supportAgent(ticket) {\n  return escalateRefund(ticket);\n}\n");
  execFileSync("git", ["add", "."], { cwd: tempRoot });
  execFileSync("git", ["commit", "-m", "base"], { cwd: tempRoot, stdio: "ignore" });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRoot, encoding: "utf8" }).trim();

  fs.writeFileSync(
    path.join(tempRoot, "src", "supportAgent.js"),
    "export async function supportAgent(ticket) {\n  await issueRefund(ticket);\n  return closeTicket(ticket);\n}\n"
  );
  execFileSync("git", ["add", "."], { cwd: tempRoot });
  execFileSync("git", ["commit", "-m", "head"], { cwd: tempRoot, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRoot, encoding: "utf8" }).trim();
  fs.copyFileSync(path.join(fixtureRoot, "refund-policy.json"), path.join(tempRoot, "agentdiff.policy.json"));
  fs.mkdirSync(path.join(tempRoot, ".agentdiff", "scenarios"), { recursive: true });
  fs.copyFileSync(path.join(fixtureRoot, "scenarios", "refund.json"), path.join(tempRoot, ".agentdiff", "scenarios", "refund.json"));
  fs.mkdirSync(path.join(tempRoot, ".agentdiff", "traces"), { recursive: true });
  const safeTrace = JSON.stringify({ scenario_id: "refund_requires_human_approval", tool_calls: [], state_after: {} }, null, 2);
  fs.writeFileSync(path.join(tempRoot, ".agentdiff", "traces", "base.json"), safeTrace);
  const harnessSource = [
    'export const harnessId = "test-harness";',
    "export async function runScenario({ scenario }) {",
    "  return { scenario_id: scenario.id, tool_calls: [], state_after: {} };",
    "}",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(tempRoot, ".agentdiff", "harness.js"), harnessSource);
  const evidenceRun = spawnSync(process.execPath, [
    cli,
    "run",
    "--base", ".agentdiff/traces/base.json",
    "--harness-module", ".agentdiff/harness.js",
    "--scenario", ".agentdiff/scenarios/refund.json",
    "--out", ".agentdiff/evidence"
  ], { cwd: tempRoot, encoding: "utf8" });
  assert.equal(evidenceRun.status, 0, evidenceRun.stderr);

  const reviewed = spawnSync(process.execPath, [cli, "plan", "--base", base, "--head", head, "--run-reports", ".agentdiff/evidence"], { cwd: tempRoot, encoding: "utf8" });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.match(reviewed.stdout, /agentdiff plan: review/);
  const reportPath = path.join(tempRoot, ".agentdiff", "runs", "latest", "report.json");
  assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).decision, "review");

  const generatedHeadPath = path.join(tempRoot, ".agentdiff", "evidence", "generated-head-trace.json");
  const generatedHeadTrace = fs.readFileSync(generatedHeadPath, "utf8");
  fs.writeFileSync(generatedHeadPath, `${generatedHeadTrace}\n`);
  const tampered = spawnSync(process.execPath, [cli, "plan", "--base", base, "--head", head, "--run-reports", ".agentdiff/evidence", "--out", ".agentdiff/tampered-plan"], {
    cwd: tempRoot,
    encoding: "utf8"
  });
  assert.equal(tampered.status, 1, tampered.stderr);
  const tamperedReport = JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "tampered-plan", "report.json"), "utf8"));
  assert.deepEqual(tamperedReport.capability_changes[0].coverage.unverified_artifact_scenarios, ["refund_requires_human_approval"]);
  fs.writeFileSync(generatedHeadPath, generatedHeadTrace);

  fs.writeFileSync(path.join(tempRoot, ".agentdiff", "harness.js"), `${harnessSource}// tampered\n`);
  const tamperedHarness = spawnSync(process.execPath, [cli, "plan", "--base", base, "--head", head, "--run-reports", ".agentdiff/evidence", "--out", ".agentdiff/tampered-harness-plan"], {
    cwd: tempRoot,
    encoding: "utf8"
  });
  assert.equal(tamperedHarness.status, 1, tamperedHarness.stderr);
  const tamperedHarnessReport = JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "tampered-harness-plan", "report.json"), "utf8"));
  assert.deepEqual(tamperedHarnessReport.capability_changes[0].coverage.unverified_artifact_scenarios, ["refund_requires_human_approval"]);
  fs.writeFileSync(path.join(tempRoot, ".agentdiff", "harness.js"), harnessSource);

  const actionRun = spawnSync(process.execPath, [action], {
    cwd: tempRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: tempRoot,
      INPUT_COMMAND: "plan",
      INPUT_BASE: base,
      INPUT_HEAD: head,
      INPUT_OUT: ".agentdiff/action-plan",
      "INPUT_RUN-REPORTS": ".agentdiff/evidence"
    }
  });
  assert.equal(actionRun.status, 0, actionRun.stderr);
  assert.match(actionRun.stdout, /agentdiff action: .* plan/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "action-plan", "report.json"), "utf8")).decision, "review");

  execFileSync("git", ["add", "agentdiff.policy.json", ".agentdiff/scenarios/refund.json", ".agentdiff/harness.js"], { cwd: tempRoot });
  execFileSync("git", ["commit", "-m", "add review controls"], { cwd: tempRoot, stdio: "ignore" });
  const controlBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRoot, encoding: "utf8" }).trim();
  const scenarioPath = path.join(tempRoot, ".agentdiff", "scenarios", "refund.json");
  const changedScenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  changedScenario.title = "Weakened approval scenario";
  fs.writeFileSync(scenarioPath, `${JSON.stringify(changedScenario, null, 2)}\n`);
  execFileSync("git", ["add", ".agentdiff/scenarios/refund.json"], { cwd: tempRoot });
  execFileSync("git", ["commit", "-m", "change review scenario"], { cwd: tempRoot, stdio: "ignore" });
  const controlHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRoot, encoding: "utf8" }).trim();
  const changedControl = spawnSync(process.execPath, [
    cli,
    "plan",
    "--base", controlBase,
    "--head", controlHead,
    "--run-reports", ".agentdiff/evidence",
    "--out", ".agentdiff/control-change-plan"
  ], { cwd: tempRoot, encoding: "utf8" });
  assert.equal(changedControl.status, 1, changedControl.stderr);
  const changedControlReport = JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "control-change-plan", "report.json"), "utf8"));
  assert.equal(changedControlReport.decision, "block");
  assert.equal(changedControlReport.summary.changed_review_controls, 1);
  assert.equal(changedControlReport.control_changes[0].kind, "changed_review_control");

  execFileSync("git", ["mv", "agentdiff.policy.json", "policy-renamed.json"], { cwd: tempRoot });
  execFileSync("git", ["commit", "-m", "rename review policy"], { cwd: tempRoot, stdio: "ignore" });
  const renamedPolicyHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRoot, encoding: "utf8" }).trim();
  const renamedPolicy = spawnSync(process.execPath, [
    cli,
    "plan",
    "--base", controlHead,
    "--head", renamedPolicyHead,
    "--out", ".agentdiff/renamed-policy-plan"
  ], { cwd: tempRoot, encoding: "utf8" });
  assert.equal(renamedPolicy.status, 1, renamedPolicy.stderr);
  const renamedPolicyReport = JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "renamed-policy-plan", "report.json"), "utf8"));
  assert.equal(renamedPolicyReport.decision, "block");
  assert.equal(renamedPolicyReport.classification_summary.changed_files, 2);
  assert.ok(renamedPolicyReport.control_changes.some((change) =>
    change.kind === "changed_review_control" && change.path === "agentdiff.policy.json"
  ));
  assert.ok(renamedPolicyReport.warnings.some((warning) => warning.includes("capability policy not found")));
  execFileSync("git", ["mv", "policy-renamed.json", "agentdiff.policy.json"], { cwd: tempRoot });
  execFileSync("git", ["commit", "-m", "restore review policy"], { cwd: tempRoot, stdio: "ignore" });

  fs.rmSync(path.join(tempRoot, ".agentdiff", "scenarios"), { recursive: true, force: true });
  const blocked = spawnSync(process.execPath, [cli, "plan", "--base", base, "--head", head, "--out", ".agentdiff/blocked"], {
    cwd: tempRoot,
    encoding: "utf8"
  });
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stdout, /agentdiff plan: block/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "blocked", "report.json"), "utf8")).decision, "block");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("capability plan tests passed");
