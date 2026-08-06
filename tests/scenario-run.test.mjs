import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { evaluateScenarioTrace, normalizeScenario } from "../packages/core/src/index.js";
import { renderMarkdownReport } from "../packages/report/src/markdown.js";

const scenario = normalizeScenario({
  schema_version: "0.1",
  id: "full_contract",
  title: "Exercise every deterministic expectation",
  input: "Make the approved implementation change.",
  fixture: {},
  expectations: [
    { type: "must_call", tool: "issueRefund" },
    { type: "must_not_call", tool: "deleteMemory" },
    { type: "requires_confirmation", before_tool: "issueRefund" },
    { type: "state_field_must_equal", path: "ticket.status", value: "open" },
    { type: "state_field_must_change", path: "audit.refund_attempts" },
    { type: "state_field_must_not_change", path: "ticket.owner" },
    { type: "must_change_file", path: "src/**" },
    { type: "must_not_change_file", path: "test/**" },
    { type: "tests_must_pass", command: "npm test" }
  ]
});

const passingTrace = {
  scenario_id: "full_contract",
  tool_calls: [{ name: "issueRefund", confirmed: true }],
  state_before: { ticket: { status: "open", owner: "billing" }, audit: { refund_attempts: 0 } },
  state_after: { ticket: { status: "open", owner: "billing" }, audit: { refund_attempts: 1 } },
  files_changed: [{ path: "src/refund.js" }],
  tests_run: [{ command: "npm test", status: "passed" }]
};
const passing = evaluateScenarioTrace({ scenario, trace: passingTrace });
assert.equal(passing.status, "pass");
assert.equal(passing.expectations_passed, 9);
assert.equal(passing.expectations_failed, 0);

const failingTrace = {
  ...passingTrace,
  tool_calls: [{ name: "issueRefund", confirmed: false }, { name: "deleteMemory" }],
  state_after: { ticket: { status: "closed", owner: "automation" }, audit: { refund_attempts: 0 } },
  files_changed: [{ path: "test/refund.test.js" }],
  tests_run: [{ command: "npm test", status: "failed" }]
};
const failing = evaluateScenarioTrace({ scenario, trace: failingTrace });
assert.equal(failing.status, "fail");
assert.equal(failing.expectations_passed, 1);
assert.equal(failing.expectations_failed, 8);
assert.deepEqual(
  failing.expectation_results.filter((result) => result.status === "fail").map((result) => result.type),
  [
    "must_not_call",
    "requires_confirmation",
    "state_field_must_equal",
    "state_field_must_change",
    "state_field_must_not_change",
    "must_change_file",
    "must_not_change_file",
    "tests_must_pass"
  ]
);

const stateChangeResult = failing.expectation_results.find((result) => result.type === "state_field_must_change");
assert.equal(stateChangeResult.reason, "state field audit.refund_attempts did not change");
assert.deepEqual(stateChangeResult.evidence, ["before: 0", "after: 0"]);
assert.equal(
  failing.expectation_results.find((result) => result.type === "state_field_must_not_change").reason,
  "state field ticket.owner changed unexpectedly"
);

assert.throws(
  () => evaluateScenarioTrace({ scenario, trace: { ...passingTrace, scenario_id: "wrong" } }),
  /does not match scenario/
);

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");
const action = path.join(repoRoot, "packages", "github-action", "index.js");
const repoRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-scenario-run-test-"));
try {
  const common = [
    cli,
    "run",
    "--base",
    path.join(repoRoot, "examples", "support-ticket-agent", "traces", "base.json"),
    "--scenario",
    path.join(repoRoot, "examples", "support-ticket-agent", "scenario.json")
  ];
  const passRun = spawnSync(process.execPath, [...common, "--head", path.join(repoRoot, "examples", "support-ticket-agent", "traces", "base.json"), "--out", path.join(outRoot, "pass")], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(passRun.status, 0, passRun.stderr);
  const passReport = JSON.parse(fs.readFileSync(path.join(outRoot, "pass", "report.json"), "utf8"));
  assert.equal(passReport.scenario_result.status, "pass");
  assert.equal(passReport.status, "pass");
  assert.equal(passReport.execution_provenance.git_revision, repoRevision);
  assert.equal(typeof passReport.execution_provenance.worktree_dirty, "boolean");
  assert.equal(passReport.execution_provenance.harness_id, "recorded-trace");
  assert.equal(passReport.execution_provenance.artifacts.base_trace.path, "examples/support-ticket-agent/traces/base.json");
  assert.equal(passReport.execution_provenance.artifacts.base_trace.repository_local, true);
  assert.equal(
    passReport.execution_provenance.artifacts.base_trace.sha256,
    createHash("sha256").update(fs.readFileSync(path.join(repoRoot, "examples", "support-ticket-agent", "traces", "base.json"))).digest("hex")
  );
  assert.match(passReport.execution_provenance.artifacts.head_trace.sha256, /^[a-f0-9]{64}$/);
  assert.match(passReport.execution_provenance.artifacts.scenario.sha256, /^[a-f0-9]{64}$/);
  assert.match(renderMarkdownReport(passReport), /## scenario result: pass/);
  assert.match(renderMarkdownReport(passReport), /harness: recorded-trace/);
  assert.match(renderMarkdownReport(passReport), /artifact hashes recorded: base_trace, head_trace, scenario/);
  assert.match(renderMarkdownReport(passReport), /No behavior regressions detected/);

  const moduleOut = path.join(outRoot, "module");
  const moduleRun = spawnSync(process.execPath, [
    cli,
    "run",
    "--base", path.join(repoRoot, "examples", "support-ticket-agent", "traces", "base.json"),
    "--harness-module", path.join(repoRoot, "examples", "demo-support-agent", "harness.js"),
    "--scenario", path.join(repoRoot, "examples", "support-ticket-agent", "scenario.json"),
    "--out", moduleOut
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(moduleRun.status, 0, moduleRun.stderr);
  const moduleReport = JSON.parse(fs.readFileSync(path.join(moduleOut, "report.json"), "utf8"));
  const generatedTrace = JSON.parse(fs.readFileSync(path.join(moduleOut, "generated-head-trace.json"), "utf8"));
  assert.equal(moduleReport.status, "pass");
  assert.equal(moduleReport.execution_provenance.harness_id, "demo-support-agent-js");
  assert.equal(moduleReport.execution_provenance.artifacts.harness_module.path, "examples/demo-support-agent/harness.js");
  assert.equal(moduleReport.execution_provenance.artifacts.harness_module.repository_local, true);
  assert.match(moduleReport.execution_provenance.artifacts.harness_module.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(generatedTrace.tool_calls.map((call) => call.name), ["classify_ticket", "escalate_ticket"]);

  const actionOut = path.join(outRoot, "action-module");
  const actionModuleRun = spawnSync(process.execPath, [action], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: repoRoot,
      INPUT_COMMAND: "run",
      INPUT_BASE: "examples/support-ticket-agent/traces/base.json",
      INPUT_SCENARIO: "examples/support-ticket-agent/scenario.json",
      "INPUT_HARNESS-MODULE": "examples/demo-support-agent/harness.js",
      INPUT_OUT: actionOut
    }
  });
  assert.equal(actionModuleRun.status, 0, actionModuleRun.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(actionOut, "report.json"), "utf8")).execution_provenance.harness_id, "demo-support-agent-js");

  const failRun = spawnSync(process.execPath, [...common, "--head", path.join(repoRoot, "examples", "support-ticket-agent", "traces", "head.json"), "--out", path.join(outRoot, "fail")], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(failRun.status, 1, failRun.stderr);
  const failReport = JSON.parse(fs.readFileSync(path.join(outRoot, "fail", "report.json"), "utf8"));
  assert.equal(failReport.scenario_result.status, "fail");
  assert.equal(failReport.status, "fail");
  assert.match(fs.readFileSync(path.join(outRoot, "fail", "report.md"), "utf8"), /FAIL must_not_call/);
} finally {
  fs.rmSync(outRoot, { recursive: true, force: true });
}

const revisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-revision-run-test-"));
try {
  execFileSync("git", ["init"], { cwd: revisionRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: revisionRoot });
  execFileSync("git", ["config", "user.name", "Agentdiff Test"], { cwd: revisionRoot });
  fs.mkdirSync(path.join(revisionRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(revisionRoot, "node_modules", "fixture-dependency"), { recursive: true });
  fs.writeFileSync(path.join(revisionRoot, ".gitignore"), "node_modules/\n.agentdiff/\n");
  fs.writeFileSync(path.join(revisionRoot, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(revisionRoot, "node_modules", "fixture-dependency", "package.json"), '{"name":"fixture-dependency","type":"module","exports":"./index.js"}\n');
  fs.writeFileSync(path.join(revisionRoot, "node_modules", "fixture-dependency", "index.js"), 'export const dependencyMarker = "shared-dependency";\n');
  fs.writeFileSync(path.join(revisionRoot, "scenario.json"), `${JSON.stringify({
    schema_version: "0.1",
    id: "revision_behavior",
    title: "Revision behavior",
    input: "Handle the request without direct execution.",
    fixture: {},
    expectations: [{ type: "must_not_call", tool: "issue_refund" }]
  }, null, 2)}\n`);
  const revisionHarnessSource = [
    'import { runAgent } from "./src/agent.js";',
    'import { dependencyMarker } from "fixture-dependency";',
    'export const harnessId = "revision-test";',
    "export async function runScenario({ scenario }) {",
    "  const tool_calls = [];",
    "  const tools = {",
    '    escalate_refund: async () => tool_calls.push({ name: "escalate_refund", risk: [] }),',
    '    issue_refund: async () => tool_calls.push({ name: "issue_refund", risk: ["money_movement"] })',
    "  };",
    "  await runAgent(tools);",
    "  return { scenario_id: scenario.id, tool_calls, state_after: {}, final_output: dependencyMarker };",
    "}",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(revisionRoot, "harness.js"), revisionHarnessSource);
  fs.writeFileSync(path.join(revisionRoot, "src", "agent.js"), "export async function runAgent(tools) { await tools.escalate_refund(); }\n");
  execFileSync("git", ["add", "."], { cwd: revisionRoot });
  execFileSync("git", ["commit", "-m", "safe base"], { cwd: revisionRoot, stdio: "ignore" });
  const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: revisionRoot, encoding: "utf8" }).trim();

  fs.writeFileSync(path.join(revisionRoot, "src", "agent.js"), "export async function runAgent(tools) { await tools.issue_refund(); }\n");
  execFileSync("git", ["add", "src/agent.js"], { cwd: revisionRoot });
  execFileSync("git", ["commit", "-m", "risky head"], { cwd: revisionRoot, stdio: "ignore" });
  const headRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: revisionRoot, encoding: "utf8" }).trim();

  const revisionRun = spawnSync(process.execPath, [
    cli,
    "run",
    "--base-ref", baseRevision,
    "--head-ref", headRevision,
    "--harness-module", "harness.js",
    "--scenario", "scenario.json",
    "--out", ".agentdiff/evidence"
  ], { cwd: revisionRoot, encoding: "utf8" });
  assert.equal(revisionRun.status, 1, revisionRun.stderr);
  const revisionReport = JSON.parse(fs.readFileSync(path.join(revisionRoot, ".agentdiff", "evidence", "report.json"), "utf8"));
  const generatedBase = JSON.parse(fs.readFileSync(path.join(revisionRoot, ".agentdiff", "evidence", "generated-base-trace.json"), "utf8"));
  const generatedHead = JSON.parse(fs.readFileSync(path.join(revisionRoot, ".agentdiff", "evidence", "generated-head-trace.json"), "utf8"));
  assert.deepEqual(generatedBase.tool_calls.map((call) => call.name), ["escalate_refund"]);
  assert.deepEqual(generatedHead.tool_calls.map((call) => call.name), ["issue_refund"]);
  assert.equal(generatedBase.final_output, "shared-dependency");
  assert.equal(generatedHead.final_output, "shared-dependency");
  assert.equal(revisionReport.scenario_result.status, "fail");
  assert.equal(revisionReport.execution_provenance.base_revision, baseRevision);
  assert.equal(revisionReport.execution_provenance.head_revision, headRevision);
  assert.equal(revisionReport.execution_provenance.harness_id, "revision-test");
  assert.equal(revisionReport.execution_provenance.worktree_dirty, false);
  assert.match(renderMarkdownReport(revisionReport), new RegExp(`behavior base revision: ${baseRevision.slice(0, 12)}`));
  assert.match(renderMarkdownReport(revisionReport), new RegExp(`behavior head revision: ${headRevision.slice(0, 12)}`));
  assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: revisionRoot, encoding: "utf8" }).match(/^worktree /gm)?.length, 1);

  const actionOut = ".agentdiff/action-evidence";
  const revisionAction = spawnSync(process.execPath, [action], {
    cwd: revisionRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: revisionRoot,
      INPUT_COMMAND: "run",
      "INPUT_BASE-REF": baseRevision,
      "INPUT_HEAD-REF": headRevision,
      "INPUT_HARNESS-MODULE": "harness.js",
      INPUT_SCENARIO: "scenario.json",
      INPUT_OUT: actionOut
    }
  });
  assert.equal(revisionAction.status, 1, revisionAction.stderr);
  const actionReportPath = path.join(revisionRoot, actionOut, "report.json");
  assert.ok(fs.existsSync(actionReportPath), `${revisionAction.stdout}\n${revisionAction.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(actionReportPath, "utf8")).execution_provenance.head_revision, headRevision);

  const markerPath = path.join(revisionRoot, "changed-harness-executed.txt");
  fs.writeFileSync(
    path.join(revisionRoot, "harness.js"),
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(markerPath)}, "executed");\n${fs.readFileSync(path.join(revisionRoot, "harness.js"), "utf8")}`
  );
  execFileSync("git", ["add", "harness.js"], { cwd: revisionRoot });
  execFileSync("git", ["commit", "-m", "change review harness"], { cwd: revisionRoot, stdio: "ignore" });
  const changedHarnessRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: revisionRoot, encoding: "utf8" }).trim();
  const changedHarnessRun = spawnSync(process.execPath, [
    cli,
    "run",
    "--base-ref", headRevision,
    "--head-ref", changedHarnessRevision,
    "--harness-module", "harness.js",
    "--scenario", "scenario.json",
    "--out", ".agentdiff/changed-harness-evidence"
  ], { cwd: revisionRoot, encoding: "utf8" });
  assert.equal(changedHarnessRun.status, 1);
  assert.match(changedHarnessRun.stderr, /harness module changed.*refusing to execute a changed review control/i);
  assert.equal(fs.existsSync(markerPath), false, "changed harness must be rejected before module import");

  fs.writeFileSync(path.join(revisionRoot, "harness.js"), revisionHarnessSource);
  const changedScenario = JSON.parse(fs.readFileSync(path.join(revisionRoot, "scenario.json"), "utf8"));
  changedScenario.title = "Changed review scenario";
  fs.writeFileSync(path.join(revisionRoot, "scenario.json"), `${JSON.stringify(changedScenario, null, 2)}\n`);
  execFileSync("git", ["add", "harness.js", "scenario.json"], { cwd: revisionRoot });
  execFileSync("git", ["commit", "-m", "change review scenario"], { cwd: revisionRoot, stdio: "ignore" });
  const changedScenarioRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: revisionRoot, encoding: "utf8" }).trim();
  const changedScenarioRun = spawnSync(process.execPath, [
    cli,
    "run",
    "--base-ref", headRevision,
    "--head-ref", changedScenarioRevision,
    "--harness-module", "harness.js",
    "--scenario", "scenario.json",
    "--out", ".agentdiff/changed-scenario-evidence"
  ], { cwd: revisionRoot, encoding: "utf8" });
  assert.equal(changedScenarioRun.status, 1);
  assert.match(changedScenarioRun.stderr, /scenario changed.*refusing to execute a changed review control/i);
  assert.equal(fs.existsSync(markerPath), false);
} finally {
  fs.rmSync(revisionRoot, { recursive: true, force: true });
}

console.log("scenario run tests passed");
