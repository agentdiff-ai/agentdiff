#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const zooRoot = path.join(repoRoot, "examples", "agent-zoo");
const outDir = path.join(repoRoot, ".agentdiff", "agent-zoo", "latest");
const runRoot = path.join(os.tmpdir(), `agentdiff-agent-zoo-${timestampForPath()}`);
const cliPath = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");
const updateMode = process.argv.includes("--update");

main().catch((error) => {
  console.error(`agent zoo failed: ${error.stack ?? error.message}`);
  process.exit(1);
});

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(runRoot, { recursive: true });

  const scenarios = listScenarios();
  const results = scenarios.map(runScenario);
  const summary = {
    total: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    expectedFindingsFound: sum(results, (result) => result.expectedFindingsFound),
    missingExpectedFindings: sum(results, (result) => result.missingExpectedFindings.length),
    unexpectedHighFindings: sum(results, (result) => result.unexpectedHighFindings.length),
    noisyDocsConfigFindings: sum(results, (result) => result.noisyDocsConfigFindings.length)
  };
  const report = {
    startedAt: new Date().toISOString(),
    runRoot,
    updateMode,
    summary,
    scenarios: results
  };

  fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "report.md"), `${renderReport(report)}\n`);

  console.log(`agent zoo report: ${path.join(outDir, "report.md")}`);
  console.log(`scenarios: ${summary.passed}/${summary.total} passed`);
  console.log(`expected findings found: ${summary.expectedFindingsFound}`);
  console.log(`missing expected findings: ${summary.missingExpectedFindings}`);
  console.log(`unexpected high findings: ${summary.unexpectedHighFindings}`);
  console.log(`noisy docs/config findings: ${summary.noisyDocsConfigFindings}`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

function listScenarios() {
  return fs
    .readdirSync(zooRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(zooRoot, entry.name))
    .filter((scenarioDir) => fs.existsSync(path.join(scenarioDir, "expected.json")))
    .sort();
}

function runScenario(scenarioDir) {
  const id = path.basename(scenarioDir);
  const expectedPath = path.join(scenarioDir, "expected.json");
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const tempRepo = path.join(runRoot, id);
  fs.mkdirSync(tempRepo, { recursive: true });

  const setup = [];
  copyTree(path.join(scenarioDir, "base"), tempRepo);
  setup.push(runStep("git init", "git", ["init"], tempRepo));
  setup.push(runStep("git config user.email", "git", ["config", "user.email", "zoo@example.invalid"], tempRepo));
  setup.push(runStep("git config user.name", "git", ["config", "user.name", "agentdiff zoo"], tempRepo));
  setup.push(runStep("git add base", "git", ["add", "."], tempRepo));
  setup.push(runStep("git commit base", "git", ["commit", "-m", "base"], tempRepo));
  const baseRef = runOutput("git", ["rev-parse", "HEAD"], tempRepo).trim();

  copyTree(path.join(scenarioDir, "head"), tempRepo);
  setup.push(runStep("git add head", "git", ["add", "."], tempRepo));
  setup.push(runStep("git commit head", "git", ["commit", "-m", "head"], tempRepo));
  const headRef = runOutput("git", ["rev-parse", "HEAD"], tempRepo).trim();

  const classifyOut = path.join(".agentdiff", "zoo-report");
  const classify = runStep("agentdiff classify", process.execPath, [cliPath, "classify", "--base", baseRef, "--head", headRef, "--out", classifyOut], tempRepo);
  const reportPath = path.join(tempRepo, classifyOut, "report.json");
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  const evaluation = evaluateScenario({ expected, report });

  if (updateMode && report) {
    const updated = {
      ...expected,
      last_actual: {
        status: report.status,
        diff_aware_findings: report.diff_aware_findings.map((finding) => ({
          path: finding.path,
          added_high_risk_calls: finding.added_high_risk_calls,
          removed_safer_calls: finding.removed_safer_calls,
          severity: finding.severity
        }))
      }
    };
    fs.writeFileSync(expectedPath, `${JSON.stringify(updated, null, 2)}\n`);
  }

  const status = setup.every((step) => step.ok) && classify.ok && evaluation.passed ? "passed" : "failed";
  return {
    id,
    title: expected.title ?? id,
    status,
    tempRepo,
    baseRef,
    headRef,
    expectedStatus: expected.expected_status,
    actualStatus: report?.status ?? "missing_report",
    expectedFindingsFound: evaluation.expectedFindingsFound,
    missingExpectedFindings: evaluation.missingExpectedFindings,
    unexpectedHighFindings: evaluation.unexpectedHighFindings,
    noisyDocsConfigFindings: evaluation.noisyDocsConfigFindings,
    changedSurfaces: report?.changed_surfaces?.map((surface) => ({
      path: surface.path,
      label: surface.label,
      surface_category: surface.surface_category,
      risk: surface.risk,
      confidence: surface.confidence
    })) ?? [],
    setup,
    classify: {
      ok: classify.ok,
      stdout: classify.stdout,
      stderr: classify.stderr
    }
  };
}

function evaluateScenario({ expected, report }) {
  if (!report) {
    return {
      passed: false,
      expectedFindingsFound: 0,
      missingExpectedFindings: ["report.json was not written"],
      unexpectedHighFindings: [],
      noisyDocsConfigFindings: []
    };
  }

  const missingExpectedFindings = [];
  let expectedFindingsFound = 0;
  if (expected.expected_status && report.status !== expected.expected_status) {
    missingExpectedFindings.push(`expected status ${expected.expected_status}, got ${report.status}`);
  }

  for (const expectedFinding of expected.expected_findings ?? []) {
    const actual = (report.diff_aware_findings ?? []).find((finding) => finding.path === expectedFinding.path);
    if (!actual) {
      missingExpectedFindings.push(`${expectedFinding.path}: missing diff-aware finding`);
      continue;
    }

    const missingAdded = (expectedFinding.added_high_risk_calls ?? []).filter((call) => !(actual.added_high_risk_calls ?? []).includes(call));
    const missingRemoved = (expectedFinding.removed_safer_calls ?? []).filter((call) => !(actual.removed_safer_calls ?? []).includes(call));
    if (missingAdded.length > 0 || missingRemoved.length > 0) {
      missingExpectedFindings.push(
        `${expectedFinding.path}: missing added calls [${missingAdded.join(", ")}], missing removed calls [${missingRemoved.join(", ")}]`
      );
      continue;
    }

    expectedFindingsFound += 1;
  }

  const expectedPaths = new Set((expected.expected_findings ?? []).map((finding) => finding.path));
  const highFindings = [...(report.diff_aware_findings ?? []), ...(report.map_drift ?? [])].filter((finding) =>
    ["high", "critical"].includes(finding.severity)
  );
  const unexpectedHighFindings = highFindings
    .filter((finding) => !expectedPaths.has(finding.path))
    .map((finding) => ({
      path: finding.path,
      type: finding.finding_type,
      severity: finding.severity,
      title: finding.title
    }));
  const noisyDocsConfigFindings = (report.map_drift ?? [])
    .filter((finding) => ["docs_example", "config_metadata", "test_fixture"].includes(finding.surface_category ?? finding.label))
    .map((finding) => ({
      path: finding.path,
      severity: finding.severity,
      category: finding.surface_category ?? finding.label
    }));

  return {
    passed: missingExpectedFindings.length === 0,
    expectedFindingsFound,
    missingExpectedFindings,
    unexpectedHighFindings,
    noisyDocsConfigFindings
  };
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true, force: true });
}

function runStep(label, command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000
  });
  return {
    label,
    ok: result.status === 0,
    status: result.status,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr)
  };
}

function runOutput(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function trimOutput(value = "") {
  return value.length > 4000 ? `${value.slice(0, 4000)}\n... truncated ...` : value;
}

function renderReport(report) {
  const lines = [];
  lines.push("# agentdiff agent zoo");
  lines.push("");
  lines.push("This deterministic suite creates temp git repos from safe/risky fixture pairs and checks whether agentdiff catches the expected behavior-risk changes.");
  lines.push("");
  lines.push("It does not install dependencies, use API keys, call live models, touch external repos, or replace the public agent-repo lab.");
  lines.push("");
  lines.push("## summary");
  lines.push("");
  lines.push(`started: ${report.startedAt}`);
  lines.push(`temp root: ${report.runRoot}`);
  lines.push(`scenarios: ${report.summary.passed}/${report.summary.total} passed`);
  lines.push(`expected findings found: ${report.summary.expectedFindingsFound}`);
  lines.push(`missing expected findings: ${report.summary.missingExpectedFindings}`);
  lines.push(`unexpected high findings: ${report.summary.unexpectedHighFindings}`);
  lines.push(`noisy docs/config findings: ${report.summary.noisyDocsConfigFindings}`);
  lines.push("");
  lines.push("## scenarios");
  lines.push("");
  lines.push("| scenario | status | actual status | expected found | missing | unexpected high | noisy docs/config |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: |");
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.id} | ${scenario.status} | ${scenario.actualStatus} | ${scenario.expectedFindingsFound} | ${scenario.missingExpectedFindings.length} | ${scenario.unexpectedHighFindings.length} | ${scenario.noisyDocsConfigFindings.length} |`
    );
  }
  lines.push("");

  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.id}`);
    lines.push("");
    lines.push(`title: ${scenario.title}`);
    lines.push(`status: ${scenario.status}`);
    if (scenario.missingExpectedFindings.length > 0) {
      lines.push("");
      lines.push("missing expected findings:");
      for (const item of scenario.missingExpectedFindings) lines.push(`- ${item}`);
    }
    if (scenario.unexpectedHighFindings.length > 0) {
      lines.push("");
      lines.push("unexpected high findings:");
      for (const finding of scenario.unexpectedHighFindings) lines.push(`- ${finding.path}: ${finding.title}`);
    }
    if (scenario.noisyDocsConfigFindings.length > 0) {
      lines.push("");
      lines.push("noisy docs/config findings:");
      for (const finding of scenario.noisyDocsConfigFindings) lines.push(`- ${finding.path}: ${finding.category}/${finding.severity}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
