import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-npm-package-"));
const npm = "npm";
const npmSpawnOptions = process.platform === "win32" ? { shell: true } : {};

try {
  const packDir = path.join(tempRoot, "pack");
  const targetDir = path.join(tempRoot, "target");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const packed = spawnSync(npm, ["pack", "--json", "--pack-destination", packDir], {
    ...npmSpawnOptions,
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000
  });
  assert.equal(packed.status, 0, packed.stderr);
  const [manifest] = JSON.parse(packed.stdout);
  assert.equal(manifest.name, "agentdiff");
  assert.equal(manifest.version, "0.2.0");
  assert.ok(manifest.size < 1_000_000, `package tarball is too large: ${manifest.size}`);
  const packedPaths = manifest.files.map((file) => file.path.replaceAll("\\", "/"));
  assert.ok(packedPaths.includes("packages/cli/bin/agentdiff.js"));
  assert.ok(packedPaths.includes("packages/core/src/index.js"));
  assert.ok(packedPaths.includes("examples/support-ticket-agent/traces/base.json"));
  assert.equal(packedPaths.some((file) => file.startsWith("tests/") || file.startsWith("scripts/") || file.startsWith(".agentdiff/")), false);

  fs.writeFileSync(path.join(targetDir, "package.json"), '{"name":"package-smoke","private":true}\n');
  const tarball = path.join(packDir, manifest.filename);
  const installed = spawnSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    ...npmSpawnOptions,
    cwd: targetDir,
    encoding: "utf8",
    timeout: 60_000
  });
  assert.equal(installed.status, 0, installed.stderr);

  const installedBin = path.join(targetDir, "node_modules", ".bin", process.platform === "win32" ? "agentdiff.cmd" : "agentdiff");
  assert.ok(fs.existsSync(installedBin));
  const initialized = spawnSync(installedBin, ["init", "--github-action"], {
    ...(process.platform === "win32" ? { shell: true } : {}),
    cwd: targetDir,
    encoding: "utf8"
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /agentdiff scan/);
  assert.doesNotMatch(initialized.stdout, /node packages\/cli\/bin\/agentdiff\.js/);
  assert.ok(fs.existsSync(path.join(targetDir, ".github", "workflows", "agentdiff.yml")));
  const installedConfig = fs.readFileSync(path.join(targetDir, "agentdiff.yml"), "utf8");
  assert.doesNotMatch(installedConfig, /node packages\/cli\/bin\/agentdiff\.js/);
  const installedWorkflow = fs.readFileSync(path.join(targetDir, ".github", "workflows", "agentdiff.yml"), "utf8");
  assert.doesNotMatch(installedWorkflow, /node packages\/cli\/bin\/agentdiff\.js/);

  const demo = spawnSync(installedBin, ["demo", "--out", ".agentdiff/package-demo"], {
    ...(process.platform === "win32" ? { shell: true } : {}),
    cwd: targetDir,
    encoding: "utf8"
  });
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /agentdiff status: fail/);
  assert.ok(fs.existsSync(path.join(targetDir, ".agentdiff", "package-demo", "report.json")));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("npm package tests passed");
