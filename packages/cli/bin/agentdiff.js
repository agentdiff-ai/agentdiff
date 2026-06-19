#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { analyzeTracePair, buildClassificationReport, readJson } from "../../core/src/index.js";
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
    const files = await resolveChangedFiles(argv);
    await classify({ files, out });
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
  const report = buildClassificationReport({
    repo: path.basename(process.cwd()),
    files: files.map((filePath) => ({
      filePath,
      content: readTextIfPresent(path.resolve(process.cwd(), filePath))
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

async function resolveChangedFiles(argv) {
  const explicit = readOption(argv, "--files");
  if (explicit) {
    return explicit.split(",").map((item) => item.trim()).filter(Boolean);
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

  return output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
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

  agentdiff demo
    Run the support-ticket regression demo.

  agentdiff run --base <trace.json> --head <trace.json> [--out <dir>]
    Compare base/head normalized traces and write report.json + report.md.
`);
}
