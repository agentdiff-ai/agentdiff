#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { analyzeTracePair, buildAgentMap, buildClassificationReport, readJson } from "../../core/src/index.js";
import { renderMarkdownReport } from "../../report/src/markdown.js";

main(process.argv.slice(2)).catch((error) => {
  console.error(`agentdiff: ${error.message}`);
  process.exit(1);
});

async function main(argv) {
  const command = argv[0] ?? "--help";

  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "demo") {
    const out = readOption(argv, "--out") ?? ".agentdiff/runs/latest";
    await run({
      base: "examples/support-ticket-agent/traces/base.json",
      head: "examples/support-ticket-agent/traces/head.json",
      out
    });
    return;
  }

  if (command === "init") {
    await init({ force: argv.includes("--force") });
    return;
  }

  if (command === "classify") {
    const out = readOption(argv, "--out") ?? ".agentdiff/runs/latest";
    const files = await resolveChangedFileInputs(argv);
    await classify({ files, out });
    return;
  }

  if (command === "scan") {
    const out = readOption(argv, "--out") ?? ".agentdiff/map.json";
    const root = readOption(argv, "--root") ?? ".";
    await scan({ root, out });
    return;
  }

  if (command === "run") {
    const base = readRequiredOption(argv, "--base");
    const head = readRequiredOption(argv, "--head");
    const out = readOption(argv, "--out") ?? ".agentdiff/runs/latest";
    await run({ base, head, out });
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function init({ force }) {
  writeFileSafe("agentdiff.yml", starterConfig(), { force });
  writeFileSafe(path.join(".agentdiff", "map.json"), `${JSON.stringify(starterMap(), null, 2)}\n`, { force });
  writeFileSafe(path.join(".agentdiff", "scenarios", "starter.json"), `${JSON.stringify(starterScenario(), null, 2)}\n`, { force });

  console.log("created agentdiff.yml");
  console.log("created .agentdiff/map.json");
  console.log("created .agentdiff/scenarios/starter.json");
}

async function run({ base, head, out }) {
  const basePath = path.resolve(process.cwd(), base);
  const headPath = path.resolve(process.cwd(), head);
  const outDir = path.resolve(process.cwd(), out);

  const baseTrace = readJson(basePath);
  const headTrace = readJson(headPath);
  const report = analyzeTracePair({ baseTrace, headTrace });
  const markdown = renderMarkdownReport(report);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "report.md"), `${markdown}\n`);

  console.log(`agentdiff status: ${report.status}`);
  console.log(`findings: ${report.behavior_findings.length}`);
  console.log(`report: ${path.join(outDir, "report.md")}`);
}

async function classify({ files, out }) {
  if (files.length === 0) {
    throw new Error("no changed files provided; use --files or --base/--head");
  }

  const outDir = path.resolve(process.cwd(), out);
  const agentMap = readAgentMapIfPresent();
  const report = buildClassificationReport({
    repo: path.basename(process.cwd()),
    files: files.map((file) => ({
      filePath: file.filePath,
      content: readTextIfPresent(path.resolve(process.cwd(), file.filePath)),
      diffText: file.diffText,
      agentMap
    }))
  });
  const markdown = renderMarkdownReport(report);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "report.md"), `${markdown}\n`);

  console.log(`agentdiff status: ${report.status}`);
  console.log(`changed surfaces: ${report.changed_surfaces.length}`);
  console.log(`map drift findings: ${report.map_drift.length}`);
  console.log(`report: ${path.join(outDir, "report.md")}`);
}

async function scan({ root, out }) {
  const rootDir = path.resolve(process.cwd(), root);
  const filePaths = listScanFiles(rootDir).map((absolutePath) => path.relative(process.cwd(), absolutePath).replaceAll("\\", "/"));
  const map = buildAgentMap({
    repo: path.basename(process.cwd()),
    files: filePaths.map((filePath) => ({
      filePath,
      content: readTextIfPresent(path.resolve(process.cwd(), filePath))
    }))
  });

  const outPath = path.resolve(process.cwd(), out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(map, null, 2)}\n`);

  console.log(`scanned files: ${filePaths.length}`);
  console.log(`agent surfaces: ${map.surfaces.length}`);
  console.log(`agents: ${map.agents.length}`);
  console.log(`map: ${outPath}`);
}

function listScanFiles(rootDir) {
  const ignoredDirs = new Set([".git", "node_modules", "dist", "coverage"]);
  const allowedExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".txt", ".yml", ".yaml"]);
  const results = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        if (entry.name === ".agentdiff") continue;
        if (entry.name === "traces") continue;
        if (entry.name === "runs" && dir.endsWith(".agentdiff")) continue;
        walk(path.join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;
      const absolutePath = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
      if (fs.statSync(absolutePath).size > 200_000) continue;
      results.push(absolutePath);
    }
  }

  walk(rootDir);
  return results.sort();
}

async function resolveChangedFileInputs(argv) {
  const explicit = readOption(argv, "--files");
  if (explicit) {
    return explicit
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((filePath) => ({
        filePath,
        diffText: readWorkingTreeDiff(filePath)
      }));
  }

  const base = readOption(argv, "--base");
  const head = readOption(argv, "--head");
  if (!base || !head) {
    return [];
  }

  const output = execFileSync("git", ["diff", "--name-only", base, head], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  return output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((filePath) => ({
      filePath,
      diffText: readGitDiffForFile({ base, head, filePath })
    }));
}

function readGitDiffForFile({ base, head, filePath }) {
  return execFileSync("git", ["diff", "--unified=80", base, head, "--", filePath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function readWorkingTreeDiff(filePath) {
  try {
    return execFileSync("git", ["diff", "--unified=80", "--", filePath], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
  } catch {
    return "";
  }
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function readRequiredOption(argv, name) {
  const value = readOption(argv, name);
  if (!value) throw new Error(`missing required option ${name}`);
  return value;
}

function readTextIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 200_000) return "";
  return fs.readFileSync(filePath, "utf8");
}

function readAgentMapIfPresent() {
  const mapPath = path.resolve(process.cwd(), ".agentdiff", "map.json");
  if (!fs.existsSync(mapPath)) return null;
  return readJson(mapPath);
}

function writeFileSafe(filePath, content, { force }) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (fs.existsSync(absolutePath) && !force) {
    throw new Error(`${filePath} already exists; rerun with --force to overwrite`);
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function starterConfig() {
  return `agentdiff:
  entrypoints:
    - src/agents/**
  max_cost_usd: 3.00
  mode: byok
  language: typescript

detection:
  auto_update_map: true
  block_unmapped_agent_surfaces: false

report:
  comment_on_pr: true
  upload_artifacts: true
`;
}

function starterMap() {
  return {
    version: "0.1",
    generated_at: new Date().toISOString(),
    agents: [],
    evidence: []
  };
}

function starterScenario() {
  return {
    id: "starter_scenario",
    input: "Describe one user workflow your agent should handle safely.",
    fixture: {},
    expectations: []
  };
}

function printHelp() {
  console.log(`agentdiff

CI for agent behavior changes.

Commands:
  agentdiff init [--force]
    Create agentdiff.yml, .agentdiff/map.json, and a starter scenario.

  agentdiff classify --files <path,path> [--out <dir>]
    Classify changed files and write report.json + report.md.

  agentdiff classify --base <ref> --head <ref> [--out <dir>]
    Classify files changed between two git refs.

  agentdiff scan [--root <dir>] [--out <map.json>]
    Scan the repo and write a starter .agentdiff/map.json.

  agentdiff demo
    Run the support-ticket regression demo.

  agentdiff run --base <trace.json> --head <trace.json> [--out <dir>]
    Compare base/head normalized traces and write report.json + report.md.
`);
}
