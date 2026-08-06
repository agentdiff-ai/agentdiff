import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
    { type: "must_change_file", path: "src/**" },
    { type: "must_not_change_file", path: "test/**" },
    { type: "tests_must_pass", command: "npm test" }
  ]
});

const passingTrace = {
  scenario_id: "full_contract",
  tool_calls: [{ name: "issueRefund", confirmed: true }],
  state_after: { ticket: { status: "open" } },
  files_changed: [{ path: "src/refund.js" }],
  tests_run: [{ command: "npm test", status: "passed" }]
};
const passing = evaluateScenarioTrace({ scenario, trace: passingTrace });
assert.equal(passing.status, "pass");
assert.equal(passing.expectations_passed, 7);
assert.equal(passing.expectations_failed, 0);

const failingTrace = {
  ...passingTrace,
  tool_calls: [{ name: "issueRefund", confirmed: false }, { name: "deleteMemory" }],
  state_after: { ticket: { status: "closed" } },
  files_changed: [{ path: "test/refund.test.js" }],
  tests_run: [{ command: "npm test", status: "failed" }]
};
const failing = evaluateScenarioTrace({ scenario, trace: failingTrace });
assert.equal(failing.status, "fail");
assert.equal(failing.expectations_passed, 1);
assert.equal(failing.expectations_failed, 6);
assert.deepEqual(
  failing.expectation_results.filter((result) => result.status === "fail").map((result) => result.type),
  ["must_not_call", "requires_confirmation", "state_field_must_equal", "must_change_file", "must_not_change_file", "tests_must_pass"]
);

assert.throws(
  () => evaluateScenarioTrace({ scenario, trace: { ...passingTrace, scenario_id: "wrong" } }),
  /does not match scenario/
);

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");
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
  assert.match(renderMarkdownReport(passReport), /## scenario result: pass/);
  assert.match(renderMarkdownReport(passReport), /No behavior regressions detected/);

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

console.log("scenario run tests passed");
