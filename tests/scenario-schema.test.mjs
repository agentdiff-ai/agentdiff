import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SCENARIO_SCHEMA_VERSION,
  SUPPORTED_EXPECTATION_TYPES,
  ScenarioValidationError,
  loadScenarioFile,
  normalizeScenario
} from "../packages/core/src/scenario.js";

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");

const supportScenario = loadScenarioFile(path.join(repoRoot, "examples", "support-ticket-agent", "scenario.json"));
assert.equal(supportScenario.schema_version, SCENARIO_SCHEMA_VERSION);
assert.equal(supportScenario.title, "Refund request requires human approval");
assert.equal(supportScenario.expectations.length, 3);

const codingScenario = loadScenarioFile(path.join(repoRoot, "examples", "coding-agent-harness", "scenarios", "fix-auth-bug.json"));
assert.equal(codingScenario.title, "Fix expired session auth bug");
assert.deepEqual(
  codingScenario.expectations.map((expectation) => expectation.type),
  ["must_change_file", "must_not_change_file", "tests_must_pass"]
);

assert.deepEqual(SUPPORTED_EXPECTATION_TYPES, [
  "must_call",
  "must_not_call",
  "requires_confirmation",
  "state_field_must_equal",
  "must_change_file",
  "must_not_change_file",
  "tests_must_pass"
]);

assert.throws(
  () =>
    normalizeScenario({
      id: "Bad ID",
      title: "Broken scenario",
      input: "do something",
      fixture: {},
      expectations: [{ type: "must_not_call" }]
    }),
  (error) =>
    error instanceof ScenarioValidationError &&
    error.message.includes("id must use lowercase") &&
    error.message.includes("expectations[0].tool")
);

assert.throws(
  () =>
    normalizeScenario({
      id: "unsupported_expectation",
      title: "Unsupported expectation",
      input: "do something",
      fixture: {},
      expectations: [{ type: "probably_safe" }]
    }),
  /unsupported; expected one of/
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-scenario-test-"));
try {
  const init = spawnSync(process.execPath, [cli, "init"], { cwd: tempRoot, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);

  const starterPath = path.join(tempRoot, ".agentdiff", "scenarios", "starter.json");
  const starter = loadScenarioFile(starterPath);
  assert.equal(starter.schema_version, SCENARIO_SCHEMA_VERSION);
  assert.equal(starter.expectations[0].type, "must_not_call");

  const validate = spawnSync(process.execPath, [cli, "scenario", "validate", starterPath], {
    cwd: tempRoot,
    encoding: "utf8"
  });
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /valid scenario: starter_scenario/);
  assert.match(validate.stdout, /schema version: 0\.1/);
  assert.match(validate.stdout, /expectations: 2/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("scenario schema tests passed");
