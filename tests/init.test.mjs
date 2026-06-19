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
  assert.match(first.stdout, /\.github\/workflows\/agentdiff\.yml/);

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

console.log("init tests passed");
