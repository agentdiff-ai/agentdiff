#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outDir = path.join(repoRoot, ".agentdiff", "stranger-tests", "latest");
const runRoot = path.join(os.tmpdir(), `agentdiff-stranger-${timestampForPath()}`);
const localCli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");

const BAKEOFF_REPOS = [
  "https://github.com/langchain-ai/memory-agent-js.git",
  "https://github.com/langchain-ai/agents-from-scratch-ts.git",
  "https://github.com/mastra-ai/mastra.git",
  "https://github.com/vercel-labs/github-tools.git",
  "https://github.com/langchain-ai/langgraphjs.git"
];

const mode = readOption(process.argv.slice(2), "--mode") ?? "all";

main().catch((error) => {
  console.error(`stranger-test failed: ${error.stack ?? error.message}`);
  process.exit(1);
});

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(runRoot, { recursive: true });

  const startedAt = new Date();
  const report = {
    startedAt: startedAt.toISOString(),
    runRoot,
    environment: collectEnvironment(),
    selfTest: null,
    bakeoff: [],
    docsFriction: [],
    topFailures: []
  };

  if (mode === "all" || mode === "self-test") {
    report.selfTest = runSelfTest();
  }

  if (mode === "all" || mode === "repo-bakeoff") {
    report.bakeoff = runRepoBakeoff();
  }

  report.topFailures = collectFailures(report);
  report.docsFriction = collectDocsFriction(report);

  const reportPath = path.join(outDir, "report.md");
  fs.writeFileSync(reportPath, renderReport(report));
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`stranger test report: ${reportPath}`);

  if (report.topFailures.some((failure) => failure.scope === "self-test")) {
    process.exitCode = 1;
  }
}

function runSelfTest() {
  const origin = readGitOutput(["remote", "get-url", "origin"]) || "https://github.com/EgemennSahin/agentdiff.git";
  const cloneDir = path.join(runRoot, "self", "agentdiff");
  const results = [];

  results.push(runStep("clone self", "git", ["clone", "--depth=1", origin, cloneDir], { cwd: runRoot, timeoutMs: 180_000 }));
  if (!results.at(-1).ok) {
    return { origin, cloneDir, results, generatedOutputsIgnored: false, readmeCommandsAccurate: false };
  }

  const commands = [
    ["npm install", "npm", ["install"]],
    ["npm test", "npm", ["test"]],
    ["README: demo", process.execPath, ["packages/cli/bin/agentdiff.js", "demo"]],
    ["README: recorded harness", process.execPath, ["packages/cli/bin/agentdiff.js", "run", "--example", "coding-agent-harness", "--recorded"]],
    ["README: classify current branch", process.execPath, ["packages/cli/bin/agentdiff.js", "classify", "--base", "main", "--head", "HEAD"]],
    ["scan default", process.execPath, ["packages/cli/bin/agentdiff.js", "scan"]]
  ];

  for (const [label, command, args] of commands) {
    results.push(runStep(label, command, args, { cwd: cloneDir, timeoutMs: label === "npm install" || label === "npm test" ? 180_000 : 60_000 }));
  }

  const ignoredCheck = runStep("check generated outputs ignored", "git", ["status", "--short", "--ignored", ".agentdiff"], {
    cwd: cloneDir,
    timeoutMs: 30_000
  });
  results.push(ignoredCheck);

  return {
    origin,
    cloneDir,
    results,
    generatedOutputsIgnored: ignoredCheck.stdout.includes("!! .agentdiff/runs/") || !ignoredCheck.stdout.includes(".agentdiff/runs"),
    readmeCommandsAccurate: results.filter((result) => result.label.startsWith("README:")).every((result) => result.ok)
  };
}

function runRepoBakeoff() {
  const results = [];
  const mapsDir = path.join(outDir, "maps");
  fs.mkdirSync(mapsDir, { recursive: true });

  for (const repoUrl of BAKEOFF_REPOS) {
    const slug = repoSlug(repoUrl);
    const cloneDir = path.join(runRoot, "bakeoff", slug.replace("/", "__"));
    const repoResult = {
      repo: slug,
      url: repoUrl,
      cloneDir,
      clone: null,
      scan: null,
      filesScanned: 0,
      agentSurfacesFound: 0,
      highRiskSurfaces: [],
      unmappedSurfaces: 0,
      falsePositiveCandidates: [],
      errors: []
    };

    repoResult.clone = runStep(`clone ${slug}`, "git", ["clone", "--depth=1", repoUrl, cloneDir], {
      cwd: runRoot,
      timeoutMs: 180_000
    });

    if (!repoResult.clone.ok) {
      repoResult.errors.push("clone failed");
      results.push(repoResult);
      continue;
    }

    const mapPath = path.join(mapsDir, `${slug.replace("/", "__")}.map.json`);
    repoResult.scan = runStep(`scan ${slug}`, process.execPath, [localCli, "scan", "--root", ".", "--out", mapPath], {
      cwd: cloneDir,
      timeoutMs: 180_000
    });

    if (!repoResult.scan.ok) {
      repoResult.errors.push("scan failed");
      results.push(repoResult);
      continue;
    }

    const map = readJsonIfPresent(mapPath);
    const surfaces = map?.surfaces ?? [];
    repoResult.filesScanned = Number(matchFirst(repoResult.scan.stdout, /scanned files:\s*(\d+)/) ?? 0);
    repoResult.agentSurfacesFound = surfaces.length;
    repoResult.highRiskSurfaces = surfaces
      .filter((surface) => surface.risk?.length > 0)
      .slice(0, 12)
      .map((surface) => ({
        path: surface.path,
        label: surface.label,
        risk: surface.risk,
        confidence: surface.confidence
      }));
    repoResult.unmappedSurfaces = surfaces.length;
    repoResult.falsePositiveCandidates = surfaces
      .filter((surface) => Number(surface.confidence ?? 0) < 0.7)
      .slice(0, 8)
      .map((surface) => ({
        path: surface.path,
        label: surface.label,
        confidence: surface.confidence,
        evidence: surface.evidence?.slice(0, 2) ?? []
      }));

    results.push(repoResult);
  }

  return results;
}

function runStep(label, command, args, { cwd, timeoutMs }) {
  const started = Date.now();
  const env = withoutApiKeys(process.env);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32" && (command === "npm" || command === "git")
  });

  return {
    label,
    command: [command, ...args].join(" "),
    cwd,
    exitCode: typeof result.status === "number" ? result.status : 1,
    ok: result.status === 0,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    stdoutTail: tail(result.stdout ?? ""),
    stderrTail: tail(result.stderr ?? result.error?.message ?? "")
  };
}

function withoutApiKeys(env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (/(_API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) {
      delete copy[key];
    }
  }
  delete copy.OPENROUTER_API_KEY;
  delete copy.ANTHROPIC_API_KEY;
  delete copy.AGENTDIFF_HARNESS;
  return copy;
}

function collectEnvironment() {
  return {
    platform: process.platform,
    node: process.version,
    npm: commandOutput("npm", ["--version"]),
    git: commandOutput("git", ["--version"]),
    repoRoot
  };
}

function collectFailures(report) {
  const failures = [];
  for (const result of report.selfTest?.results ?? []) {
    if (!result.ok) {
      failures.push({ scope: "self-test", name: result.label, detail: result.stderrTail || result.stdoutTail });
    }
  }
  for (const repo of report.bakeoff ?? []) {
    if (!repo.clone?.ok) failures.push({ scope: "repo-bakeoff", name: `${repo.repo} clone`, detail: repo.clone?.stderrTail });
    if (repo.clone?.ok && !repo.scan?.ok) failures.push({ scope: "repo-bakeoff", name: `${repo.repo} scan`, detail: repo.scan?.stderrTail });
  }
  return failures;
}

function collectDocsFriction(report) {
  const friction = [];
  if (report.selfTest && !report.selfTest.readmeCommandsAccurate) {
    friction.push("One or more README Agentdiff In 5 Minutes commands failed in a fresh clone.");
  }
  if (report.selfTest && !report.selfTest.generatedOutputsIgnored) {
    friction.push("Generated .agentdiff outputs appeared as unignored files in the fresh clone.");
  }
  for (const repo of report.bakeoff ?? []) {
    if (repo.falsePositiveCandidates.length > 0) {
      friction.push(`${repo.repo}: ${repo.falsePositiveCandidates.length} low-confidence surface(s) worth reviewing for false positives.`);
    }
  }
  return friction;
}

function renderReport(report) {
  const lines = [];
  lines.push("# agentdiff stranger-test report");
  lines.push("");
  lines.push("## summary");
  lines.push("");
  lines.push(`started: ${report.startedAt}`);
  lines.push(`temp root: ${report.runRoot}`);
  lines.push(`self-test: ${report.selfTest ? statusLabel(report.selfTest.results.every((result) => result.ok)) : "skipped"}`);
  lines.push(`repo bakeoff: ${report.bakeoff.length ? `${report.bakeoff.filter((repo) => repo.scan?.ok).length}/${report.bakeoff.length} scanned` : "skipped"}`);
  lines.push(`top failures: ${report.topFailures.length}`);
  lines.push("");
  lines.push("## environment");
  lines.push("");
  lines.push(`platform: ${report.environment.platform}`);
  lines.push(`node: ${report.environment.node}`);
  lines.push(`npm: ${report.environment.npm || "unknown"}`);
  lines.push(`git: ${report.environment.git || "unknown"}`);
  lines.push("");

  if (report.selfTest) {
    lines.push("## self-test results");
    lines.push("");
    lines.push(`origin: ${report.selfTest.origin}`);
    lines.push(`clone: ${report.selfTest.cloneDir}`);
    lines.push(`README commands accurate: ${report.selfTest.readmeCommandsAccurate ? "yes" : "no"}`);
    lines.push(`generated outputs ignored: ${report.selfTest.generatedOutputsIgnored ? "yes" : "no"}`);
    lines.push("");
    for (const result of report.selfTest.results) {
      lines.push(`### ${result.label}`);
      lines.push("");
      lines.push(`status: ${statusLabel(result.ok)}`);
      lines.push(`command: \`${result.command}\``);
      lines.push(`duration: ${result.durationMs}ms`);
      if (!result.ok || result.stdoutTail || result.stderrTail) {
        lines.push("");
        lines.push("stdout tail:");
        lines.push("```txt");
        lines.push(result.stdoutTail || "");
        lines.push("```");
        lines.push("");
        lines.push("stderr tail:");
        lines.push("```txt");
        lines.push(result.stderrTail || "");
        lines.push("```");
      }
      lines.push("");
    }
  }

  if (report.bakeoff.length > 0) {
    lines.push("## repo-bakeoff results");
    lines.push("");
    for (const repo of report.bakeoff) {
      lines.push(`### ${repo.repo}`);
      lines.push("");
      lines.push(`clone: ${statusLabel(repo.clone?.ok)}`);
      lines.push(`scan: ${statusLabel(repo.scan?.ok)}`);
      lines.push(`files scanned: ${repo.filesScanned}`);
      lines.push(`agent surfaces found: ${repo.agentSurfacesFound}`);
      lines.push(`unmapped surfaces: ${repo.unmappedSurfaces}`);
      lines.push("");
      lines.push("high-risk surfaces:");
      if (repo.highRiskSurfaces.length === 0) lines.push("- none");
      for (const surface of repo.highRiskSurfaces) {
        lines.push(`- ${surface.path}: ${surface.label} (${surface.risk.join(", ")})`);
      }
      lines.push("");
      lines.push("false-positive candidates:");
      if (repo.falsePositiveCandidates.length === 0) lines.push("- none");
      for (const surface of repo.falsePositiveCandidates) {
        lines.push(`- ${surface.path}: ${surface.label}, confidence ${surface.confidence}`);
      }
      if (repo.errors.length > 0) {
        lines.push("");
        lines.push(`errors: ${repo.errors.join(", ")}`);
      }
      lines.push("");
    }
  }

  lines.push("## top failures");
  lines.push("");
  if (report.topFailures.length === 0) lines.push("No command failures recorded.");
  for (const failure of report.topFailures) {
    lines.push(`- ${failure.scope}: ${failure.name} - ${oneLine(failure.detail)}`);
  }
  lines.push("");
  lines.push("## docs friction");
  lines.push("");
  if (report.docsFriction.length === 0) lines.push("No docs friction recorded.");
  for (const item of report.docsFriction) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("## recommended fixes");
  lines.push("");
  if (report.topFailures.length === 0 && report.docsFriction.length === 0) {
    lines.push("- No immediate clean-install fixes needed.");
  } else {
    if (report.topFailures.some((failure) => failure.scope === "self-test")) {
      lines.push("- Fix self-test failures before adding new product scope.");
    }
    if (report.topFailures.some((failure) => failure.scope === "repo-bakeoff")) {
      lines.push("- Inspect failed bakeoff scans and decide whether they represent real scanner limits.");
    }
    if (report.docsFriction.length > 0) {
      lines.push("- Review low-confidence bakeoff surfaces before import graph work.");
    }
  }
  lines.push("");

  return lines.join("\n");
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function readGitOutput(args) {
  return commandOutput("git", args, repoRoot);
}

function commandOutput(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && (command === "npm" || command === "git")
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function matchFirst(text, regex) {
  return text.match(regex)?.[1];
}

function tail(text, maxLines = 24, maxChars = 5000) {
  const lines = String(text ?? "").split(/\r?\n/).slice(-maxLines).join("\n");
  return lines.length > maxChars ? lines.slice(lines.length - maxChars) : lines;
}

function repoSlug(repoUrl) {
  return repoUrl.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function statusLabel(ok) {
  return ok ? "passed" : "failed";
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 220) || "no detail";
}
