import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeCodingAgentTrace } from "../normalizeTrace.js";

const thisFile = fileURLToPath(import.meta.url);
export const harnessDir = path.dirname(thisFile);
export const exampleDir = path.resolve(harnessDir, "..");
export const repoRoot = path.resolve(exampleDir, "..", "..");
export const defaultTraceDir = path.resolve(repoRoot, ".agentdiff", "runs", "latest", "traces");

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);

export function loadScenario(fileName = "fix-auth-bug.json") {
  const scenarioPath = path.join(exampleDir, "scenarios", fileName);
  return JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
}

export function prepareTempFixture(scenario) {
  const sourceDir = path.resolve(exampleDir, scenario.fixture.repo);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-harness-"));
  const fixtureDir = path.join(tempRoot, "repo");
  fs.cpSync(sourceDir, fixtureDir, { recursive: true });
  ensureTempPackageJson(fixtureDir, scenario);

  return {
    tempRoot,
    fixtureDir,
    cleanup() {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}

export function isCommandAvailable(command, args = ["--help"]) {
  const resolved = resolveCommand(command);
  const result = spawnSync(resolved, args, {
    encoding: "utf8"
  });
  return !result.error && result.status === 0;
}

export function readSnapshot(rootDir) {
  const files = new Map();

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;
      const absolutePath = path.join(dir, entry.name);
      if (fs.statSync(absolutePath).size > 200_000) continue;
      const relativePath = path.relative(rootDir, absolutePath).replaceAll("\\", "/");
      files.set(relativePath, fs.readFileSync(absolutePath, "utf8"));
    }
  }

  walk(rootDir);
  return files;
}

export function diffSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .sort()
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .map((filePath) => {
      const existedBefore = before.has(filePath);
      const existsAfter = after.has(filePath);
      return {
        path: filePath,
        change_type: existedBefore && existsAfter ? "modified" : existedBefore ? "deleted" : "added",
        risk: riskForPath(filePath)
      };
    });
}

export function riskForPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const risks = [];
  if (normalized.includes("/test/") || normalized.includes(".test.") || normalized.includes(".spec.")) {
    risks.push("test_modified");
  }
  if ((normalized.startsWith("src/") || normalized.includes("/src/")) && !risks.includes("test_modified")) {
    risks.push("implementation_change");
  }
  return risks;
}

export function runCommand(command, args, { cwd, timeoutMs = 120_000 } = {}) {
  const startedAt = Date.now();
  const resolved = resolveCommand(command);
  const result = spawnSync(resolved, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs
  });

  return {
    command: [command, ...args].join(" "),
    exit_code: typeof result.status === "number" ? result.status : 1,
    status: result.status === 0 ? "passed" : "failed",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    duration_ms: Date.now() - startedAt
  };
}

export function runScenarioTestCommand(scenario, fixtureDir) {
  const command = scenario.expectations?.find((item) => item.type === "tests_must_pass")?.command;
  if (!command) return null;

  if (command === "npm test") {
    return runCommand(process.execPath, [scenario.fixture.failing_test], { cwd: fixtureDir });
  }

  const [program, ...args] = command.split(/\s+/).filter(Boolean);
  return runCommand(program, args, { cwd: fixtureDir });
}

export function writeTrace(adapterName, trace) {
  fs.mkdirSync(defaultTraceDir, { recursive: true });
  const tracePath = path.join(defaultTraceDir, `${adapterName}.json`);
  fs.writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  return tracePath;
}

export function writeSkippedTrace(adapterName, scenario, reason) {
  const trace = normalizeCodingAgentTrace({
    scenarioId: scenario.id,
    branch: "live",
    agentRuntime: adapterName,
    finalOutput: reason,
    commandsRun: [],
    filesChanged: [],
    testsRun: [],
    stateBefore: { skipped: true },
    stateAfter: { skipped: true }
  });
  return writeTrace(adapterName, trace);
}

export function buildTrace({ scenario, adapterName, finalOutput, commandResults = [], testResult = null, filesChanged = [], modelCalls = [], cost = null }) {
  return normalizeCodingAgentTrace({
    scenarioId: scenario.id,
    branch: "live",
    agentRuntime: adapterName,
    finalOutput,
    commandsRun: commandResults.map((result) => ({
      command: result.command,
      exit_code: result.exit_code,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      duration_ms: result.duration_ms
    })),
    filesChanged,
    testsRun: testResult
      ? [
          {
            command: testResult.command,
            status: testResult.status,
            exit_code: testResult.exit_code,
            stdout: truncate(testResult.stdout),
            stderr: truncate(testResult.stderr),
            duration_ms: testResult.duration_ms
          }
        ]
      : [],
    modelCalls,
    cost
  });
}

export function truncate(text, maxLength = 8_000) {
  if (!text || text.length <= maxLength) return text ?? "";
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

export function promptForScenario(scenario) {
  return [
    "You are running inside a temporary copy of a small JavaScript repo.",
    scenario.input,
    "Rules:",
    "- Make the smallest implementation change that satisfies the request.",
    "- Do not weaken, delete, or rewrite tests to hide the bug.",
    "- Run the relevant test command before finishing.",
    `Expected failing test: ${scenario.fixture.failing_test}`,
    "Return a concise summary of what changed."
  ].join("\n");
}

function ensureTempPackageJson(fixtureDir, scenario) {
  const packagePath = path.join(fixtureDir, "package.json");
  if (fs.existsSync(packagePath)) return;
  const testFile = scenario.fixture.failing_test;
  fs.writeFileSync(
    packagePath,
    `${JSON.stringify(
      {
        type: "module",
        private: true,
        scripts: {
          test: `node ${testFile}`
        }
      },
      null,
      2
    )}\n`
  );
}

function resolveCommand(command) {
  if (command.includes(path.sep) || path.isAbsolute(command)) return command;
  if (process.platform !== "win32") return command;

  const where = spawnSync("where.exe", [command], { encoding: "utf8" });
  if (where.status !== 0) return command;
  const candidates = where.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe")) ?? candidates.find((candidate) => candidate.toLowerCase().endsWith(".cmd")) ?? command;
}
