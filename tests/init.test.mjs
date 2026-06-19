import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");

function runInit(cwd, args = []) {
  return spawnSync(process.execPath, [cli, "init", ...args], {
    cwd,
    encoding: "utf8"
  });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-init-test-"));

try {
  fs.mkdirSync(path.join(tempRoot, "src", "agents"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "src", "tools"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "app", "api"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "langgraph.json"),
    JSON.stringify({ graphs: { agent: "./src/agents/graph.ts:graph" } }, null, 2)
  );
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"] }, null, 2)
  );
  fs.writeFileSync(
    path.join(tempRoot, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@repo/*": ["packages/*/src"] } } }, null, 2)
  );

  const first = runInit(tempRoot);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /created agentdiff\.yml/);
  assert.match(first.stdout, /LangGraph graph entrypoints: src\/agents\/graph\.ts/);
  assert.match(first.stdout, /package\.json workspaces: packages\/\*/);
  assert.match(first.stdout, /tsconfig\.json path aliases: @\/\*, @repo\/\*/);
  assert.match(first.stdout, /node packages\/cli\/bin\/agentdiff\.js scan/);
  assert.match(first.stdout, /rerun init with --github-action/);

  const config = fs.readFileSync(path.join(tempRoot, "agentdiff.yml"), "utf8");
  assert.match(config, /entrypoints:/);
  assert.match(config, /- src\/agents\/graph\.ts/);
  assert.match(config, /- src\/tools\/\*\*/);
  assert.match(config, /Scan limits keep first runs fast/);
  assert.match(config, /Suppress intentional or noisy findings/);
  assert.match(config, /reason: "documentation examples"/);
  assert.match(config, /expires: "2026-07-31"/);
  assert.match(config, /recorded:/);
  assert.match(config, /live_openrouter:/);
  assert.ok(fs.existsSync(path.join(tempRoot, ".agentdiff", "map.json")));
  assert.ok(fs.existsSync(path.join(tempRoot, ".agentdiff", "scenarios", "starter.json")));

  const second = runInit(tempRoot);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists; rerun with --force to overwrite/);

  fs.writeFileSync(path.join(tempRoot, "agentdiff.yml"), "custom: true\n");
  const forced = runInit(tempRoot, ["--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.notEqual(fs.readFileSync(path.join(tempRoot, "agentdiff.yml"), "utf8"), "custom: true\n");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const workflowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-init-workflow-test-"));

try {
  fs.writeFileSync(path.join(workflowRoot, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }, null, 2));

  const first = runInit(workflowRoot, ["--github-action"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /created \.github\/workflows\/agentdiff\.yml/);
  assert.match(first.stdout, /open a pull request and check the sticky agentdiff comment/);

  const workflowPath = path.join(workflowRoot, ".github", "workflows", "agentdiff.yml");
  assert.ok(fs.existsSync(workflowPath));
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /on:\n  pull_request:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /run: npm install/);
  assert.match(workflow, /Recommended v0 channel/);
  assert.match(workflow, /Pin @v0\.1\.0 for an immutable exact version/);
  assert.match(workflow, /uses: agentdiff-ai\/agentdiff@v0/);
  assert.match(workflow, /command: classify/);
  assert.match(workflow, /base: origin\/\$\{\{ github\.base_ref \}\}/);
  assert.match(workflow, /head: HEAD/);
  assert.match(workflow, /github-token: \$\{\{ github\.token \}\}/);

  fs.writeFileSync(workflowPath, "custom workflow\n");
  const second = runInit(workflowRoot, ["--github-action"]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists; rerun with --force to overwrite/);
  assert.equal(fs.readFileSync(workflowPath, "utf8"), "custom workflow\n");

  const forced = runInit(workflowRoot, ["--github-action", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.notEqual(fs.readFileSync(workflowPath, "utf8"), "custom workflow\n");
} finally {
  fs.rmSync(workflowRoot, { recursive: true, force: true });
}

console.log("init tests passed");
