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

const classificationReport = {
  repo: "refund-agent",
  status: "action_required",
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

const covered = buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios: [scenario],
  policySource: "refund-policy.json"
});

assert.equal(covered.decision, "review");
assert.equal(covered.summary.added_capabilities, 2);
assert.equal(covered.summary.removed_guardrails, 1);
assert.equal(covered.summary.covered, 1);
assert.equal(covered.summary.unmatched_capabilities, 1);
assert.equal(covered.capability_changes[0].rule_id, "refunds-require-approval");
assert.equal(covered.capability_changes[0].coverage.confirmation_covered, true);

const uncovered = buildCapabilityPlan({ classificationReport, policy, scenarios: [], policySource: "refund-policy.json" });
assert.equal(uncovered.decision, "block");
assert.deepEqual(uncovered.capability_changes[0].coverage.missing_scenarios, ["refund_requires_human_approval"]);

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

const markdown = renderMarkdownReport(uncovered);
assert.match(markdown, /decision: \*\*BLOCK\*\*/);
assert.match(markdown, /policy: refund-policy\.json \(v0\.1\)/);
assert.match(markdown, /## Block \(1\)/);
assert.match(markdown, /missing: refund_requires_human_approval/);
assert.match(markdown, /Removed guardrail: escalateRefund/);
assert.ok(markdown.indexOf("## Block (1)") < markdown.indexOf("## Review (2)"));
assert.match(markdown, /not a vulnerability claim/);

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

  const reviewed = spawnSync(process.execPath, [cli, "plan", "--base", base, "--head", head], { cwd: tempRoot, encoding: "utf8" });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.match(reviewed.stdout, /agentdiff plan: review/);
  const reportPath = path.join(tempRoot, ".agentdiff", "runs", "latest", "report.json");
  assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).decision, "review");

  const actionRun = spawnSync(process.execPath, [action], {
    cwd: tempRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: tempRoot,
      INPUT_COMMAND: "plan",
      INPUT_BASE: base,
      INPUT_HEAD: head,
      INPUT_OUT: ".agentdiff/action-plan"
    }
  });
  assert.equal(actionRun.status, 0, actionRun.stderr);
  assert.match(actionRun.stdout, /agentdiff action: .* plan/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempRoot, ".agentdiff", "action-plan", "report.json"), "utf8")).decision, "review");

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
