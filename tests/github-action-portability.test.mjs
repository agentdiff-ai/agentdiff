import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-action-portability-"));

try {
  const actionRoot = path.join(tempRoot, "action");
  const targetRoot = path.join(tempRoot, "target-repo");
  fs.mkdirSync(actionRoot, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });

  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(actionRoot, "package.json"));
  for (const packageName of ["cli", "core", "github-action", "report"]) {
    fs.cpSync(path.join(repoRoot, "packages", packageName), path.join(actionRoot, "packages", packageName), { recursive: true });
  }
  assert.equal(fs.existsSync(path.join(actionRoot, "node_modules")), false);

  execFileSync("git", ["init"], { cwd: targetRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: targetRoot });
  execFileSync("git", ["config", "user.name", "Agentdiff Test"], { cwd: targetRoot });
  fs.mkdirSync(path.join(targetRoot, "src", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(targetRoot, "src", "agents", "supportAgent.js"),
    "export async function supportAgent(ticket) {\n  return escalateRefund(ticket);\n}\n"
  );
  execFileSync("git", ["add", "."], { cwd: targetRoot });
  execFileSync("git", ["commit", "-m", "base"], { cwd: targetRoot, stdio: "ignore" });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRoot, encoding: "utf8" }).trim();

  fs.writeFileSync(
    path.join(targetRoot, "src", "agents", "supportAgent.js"),
    "export async function supportAgent(ticket) {\n  await issueRefund(ticket);\n  return closeTicket(ticket);\n}\n"
  );
  execFileSync("git", ["add", "."], { cwd: targetRoot });
  execFileSync("git", ["commit", "-m", "head"], { cwd: targetRoot, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRoot, encoding: "utf8" }).trim();

  const action = spawnSync(process.execPath, [path.join(actionRoot, "packages", "github-action", "index.js")], {
    cwd: targetRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: targetRoot,
      INPUT_COMMAND: "plan",
      INPUT_BASE: base,
      INPUT_HEAD: head,
      INPUT_OUT: ".agentdiff/action-report"
    }
  });

  assert.equal(action.status, 0, action.stderr);
  assert.match(action.stdout, /agentdiff plan: review/);
  const reportPath = path.join(targetRoot, ".agentdiff", "action-report", "report.json");
  assert.ok(fs.existsSync(reportPath));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.decision, "review");
  assert.deepEqual(report.capability_changes.map((change) => change.capability), ["issueRefund", "closeTicket"]);
  assert.equal(fs.existsSync(path.join(targetRoot, "package.json")), false);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("github action portability tests passed");
