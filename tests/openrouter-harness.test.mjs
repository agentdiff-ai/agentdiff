import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_OPENROUTER_MODEL,
  FINAL_QUALITY_OPENROUTER_MODEL,
  applyPatchPlan,
  parsePatchPlan,
  selectOpenRouterModel,
  validatePatchPlan
} from "../examples/coding-agent-harness/harnesses/openrouter-openai.js";
import { diffSnapshots, loadScenario, prepareTempFixture, readSnapshot } from "../examples/coding-agent-harness/harnesses/shared.js";

assert.equal(selectOpenRouterModel({}), DEFAULT_OPENROUTER_MODEL);
assert.equal(selectOpenRouterModel({ OPENROUTER_QUALITY: "final" }), FINAL_QUALITY_OPENROUTER_MODEL);
assert.equal(selectOpenRouterModel({ OPENROUTER_MODEL: "custom/model" }), "custom/model");

const plan = validatePatchPlan(
  parsePatchPlan(`{
    "summary": "Reject expired sessions.",
    "files": [
      {
        "path": "src/auth.js",
        "operation": "replace",
        "find": "return Boolean(session.userId);",
        "replace": "return Boolean(session.userId) && session.expiresAt > Date.now();"
      }
    ],
    "commands": ["npm test"]
  }`)
);
assert.equal(plan.files[0].path, "src/auth.js");
assert.equal(plan.commands[0], "npm test");

assert.throws(
  () =>
    validatePatchPlan({
      summary: "unsafe",
      files: [{ path: "../outside.js", operation: "replace", find: "a", replace: "b" }],
      commands: []
    }),
  /unsafe patch path/
);

assert.throws(
  () =>
    validatePatchPlan({
      summary: "unsafe command",
      files: [{ path: "src/auth.js", operation: "replace", find: "a", replace: "b" }],
      commands: ["rm -rf ."]
    }),
  /not allowed/
);

const scenario = loadScenario();
const fixture = prepareTempFixture(scenario);
try {
  const before = readSnapshot(fixture.fixtureDir);
  applyPatchPlan(plan, fixture.fixtureDir);
  const after = readSnapshot(fixture.fixtureDir);
  const changed = diffSnapshots(before, after);
  assert.deepEqual(
    changed.map((file) => file.path),
    ["src/auth.js"]
  );
  const repoAuth = fs.readFileSync(path.resolve("examples/coding-agent-harness/fixture/base/src/auth.js"), "utf8");
  assert.equal(repoAuth.includes("session.expiresAt > Date.now()"), false);
} finally {
  fixture.cleanup();
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-openrouter-test-"));
try {
  const result = spawnSync(process.execPath, ["examples/coding-agent-harness/harnesses/openrouter-openai.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, OPENROUTER_API_KEY: "", HOME: tempHome, USERPROFILE: tempHome }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OPENROUTER_API_KEY is not set/);
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log("openrouter harness tests passed");
