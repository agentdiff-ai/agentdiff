import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixtureRoot = path.join(here, "fixtures", "behavior-regressions");
const cliPath = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");
const runRoot = path.join(os.tmpdir(), `agentdiff-behavior-regressions-${Date.now()}`);

fs.mkdirSync(runRoot, { recursive: true });

const scenarios = fs
  .readdirSync(fixtureRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

assert.deepEqual(scenarios, [
  "delegated-cli-runner",
  "discord-send-tools",
  "email-send-tool",
  "mcp-agent-management-tools",
  "note-trash-restore-tools",
  "payment-refund-tools",
  "persistent-browser-output",
  "sheets-write-tools",
  "workflow-scheduling-tools"
]);

const failures = [];

for (const scenario of scenarios) {
  const scenarioDir = path.join(fixtureRoot, scenario);
  const expected = JSON.parse(fs.readFileSync(path.join(scenarioDir, "expected.json"), "utf8"));
  const tempRepo = path.join(runRoot, scenario);
  fs.mkdirSync(tempRepo, { recursive: true });

  copyTree(path.join(scenarioDir, "base"), tempRepo);
  run("git", ["init"], tempRepo);
  run("git", ["config", "user.email", "behavior-regressions@example.invalid"], tempRepo);
  run("git", ["config", "user.name", "agentdiff behavior regression"], tempRepo);
  run("git", ["add", "."], tempRepo);
  run("git", ["commit", "-m", "base"], tempRepo);
  const baseRef = output("git", ["rev-parse", "HEAD"], tempRepo).trim();

  copyTree(path.join(scenarioDir, "head"), tempRepo);
  run("git", ["add", "."], tempRepo);
  run("git", ["commit", "-m", "head"], tempRepo);
  const headRef = output("git", ["rev-parse", "HEAD"], tempRepo).trim();

  run(process.execPath, [cliPath, "classify", "--base", baseRef, "--head", headRef, "--out", ".agentdiff/report"], tempRepo);
  const report = JSON.parse(fs.readFileSync(path.join(tempRepo, ".agentdiff", "report", "report.json"), "utf8"));
  const diffFindings = report.diff_aware_findings ?? [];

  try {
    assert.equal(report.status, expected.expected_status, `${scenario}: report status`);
    assert.ok(diffFindings.length > 0, `${scenario}: expected diff-aware findings`);
    const finding = diffFindings.find((item) => item.path === expected.expected_finding.path);
    assert.ok(finding, `${scenario}: missing finding for ${expected.expected_finding.path}`);
    assert.equal(finding.finding_type, "behavior_surface_change", `${scenario}: finding type`);
    assert.equal(finding.severity, "high", `${scenario}: severity`);
    assertIncludesAll(finding.added_high_risk_calls ?? [], expected.expected_finding.added_high_risk_calls, `${scenario}: added high-risk calls`);
    assertIncludesAll(finding.removed_safer_calls ?? [], expected.expected_finding.removed_safer_calls, `${scenario}: removed safer calls`);

    assert.ok(
      ["approval", "autonomy", "state_mutation", "external_message", "memory", "browser_submit", "tool_reachability"].includes(
        expected.expected_finding.changed_boundary
      ),
      `${scenario}: fixture should declare a known changed boundary`
    );

    const evidenceText = [
      finding.reason,
      finding.recommendation,
      ...(finding.evidence ?? []),
      ...(finding.explanation?.risk_evidence ?? []),
      expected.expected_finding.before_behavior,
      expected.expected_finding.after_behavior,
      expected.expected_finding.why_normal_ci_misses_it
    ].join("\n");

    assert.ok(expected.expected_finding.risk_evidence.every((token) => evidenceText.toLowerCase().includes(token.toLowerCase())), `${scenario}: risk evidence`);
  } catch (error) {
    failures.push(error.message);
  }
}

if (failures.length > 0) {
  assert.fail(`behavior regression fixture failures:\n${failures.join("\n")}`);
}

console.log(`behavior regression fixtures passed (${scenarios.length} scenarios)`);

function copyTree(from, to) {
  if (fs.existsSync(to)) {
    for (const entry of fs.readdirSync(to)) {
      if (entry === ".git") continue;
      fs.rmSync(path.join(to, entry), { recursive: true, force: true });
    }
  }
  fs.cpSync(from, to, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
  }
}

function output(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function assertIncludesAll(actual, expected, message) {
  const missing = expected.filter((item) => !actual.includes(item));
  assert.deepEqual(missing, [], `${message}: missing ${missing.join(", ")}`);
}
