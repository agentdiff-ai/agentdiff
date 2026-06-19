import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-scan-limits-"));

try {
  fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "generated"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "node_modules", "ignored"), { recursive: true });

  fs.writeFileSync(
    path.join(tempRoot, "src", "supportAgent.js"),
    "import OpenAI from 'openai';\nexport async function supportAgent() { return OpenAI; }\n"
  );
  fs.writeFileSync(path.join(tempRoot, "src", "hugeTool.js"), `export const huge = "${"x".repeat(2048)}";\n`);
  fs.writeFileSync(path.join(tempRoot, "generated", "generatedAgent.js"), "export function generatedAgent() { return 'skip'; }\n");
  fs.writeFileSync(path.join(tempRoot, "node_modules", "ignored", "tool.js"), "export function deleteEverything() {}\n");
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(tempRoot, "src", `tool${index}.js`), `export function sendEmail${index}(recipientEmail) { return recipientEmail; }\n`);
  }

  const outPath = path.join(tempRoot, ".agentdiff", "runs", "latest", "map.json");
  const result = spawnSync(process.execPath, [cli, "scan", "--root", tempRoot, "--out", outPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTDIFF_SCAN_MAX_FILE_BYTES: "1024",
      AGENTDIFF_SCAN_MAX_FILES: "4",
      AGENTDIFF_SCAN_MAX_TOTAL_BYTES: "10000"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scan limit warnings:/);
  assert.ok(fs.existsSync(outPath), "partial scan should still write a map");

  const map = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(map.scan.files_scanned, 4);
  assert.equal(map.scan.partial, true);
  assert.ok(map.scan.files_skipped > 0);
  assert.ok(map.scan.scan_limit_warnings.some((warning) => warning.includes("partial scan")));
  assert.ok(map.scan.scan_limit_warnings.some((warning) => warning.includes("file over max size")));
  assert.ok(map.scan.skipped_by_reason["ignored directory: generated"] >= 1);
  assert.ok(map.scan.skipped_by_reason["ignored directory: node_modules"] >= 1);
  assert.ok(map.surfaces.every((surface) => !surface.path.includes("generated") && !surface.path.includes("node_modules")));

  const tinyMapOutPath = path.join(tempRoot, ".agentdiff", "runs", "tiny-map", "map.json");
  const tinyMapResult = spawnSync(process.execPath, [cli, "scan", "--root", tempRoot, "--out", tinyMapOutPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTDIFF_SCAN_MAX_FILE_BYTES: "4096",
      AGENTDIFF_SCAN_MAX_FILES: "20",
      AGENTDIFF_SCAN_MAX_TOTAL_BYTES: "100000",
      AGENTDIFF_SCAN_MAX_MAP_BYTES: "1200"
    }
  });

  assert.equal(tinyMapResult.status, 0, tinyMapResult.stderr);
  const tinyMap = JSON.parse(fs.readFileSync(tinyMapOutPath, "utf8"));
  assert.equal(tinyMap.scan.partial, true);
  assert.ok(tinyMap.scan.scan_limit_warnings.some((warning) => warning.includes("partial map")));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("scan limit tests passed");
