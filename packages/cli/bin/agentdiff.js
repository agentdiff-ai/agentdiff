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
    await init({ force: argv.includes("--force"), githubAction: argv.includes("--github-action") });
    return;
  }

  if (command === "classify") {
    const out = readOption(argv, "--out") ?? ".agentdiff/runs/latest";
    const files = await resolveChangedFileInputs(argv);
    await classify({ files, out });
    return;
  }

  if (command === "scan") {
    const out = readOption(argv, "--out") ?? ".agentdiff/runs/latest/map.json";
    const root = readOption(argv, "--root") ?? ".";
    await scan({ root, out });
    return;
  }

  if (command === "operator") {
    await operator({
      execute: argv.includes("--execute"),
      task: readOption(argv, "--task")
    });
    return;
  }

  if (command === "run") {
    const example = readOption(argv, "--example");
    const out = readOption(argv, "--out") ?? ".agentdiff/runs/latest";
    if (example) {
      if (argv.includes("--live")) {
        await runLiveExample({ example });
        return;
      }

      await run({
        base: path.join("examples", example, "traces", "recorded", "base.json"),
        head: path.join("examples", example, "traces", "recorded", "head.json"),
        out
      });
      return;
    }

    const base = readRequiredOption(argv, "--base");
    const head = readRequiredOption(argv, "--head");
    await run({ base, head, out });
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function init({ force, githubAction }) {
  const signals = detectOnboardingSignals(process.cwd());
  writeFileSafe("agentdiff.yml", starterConfig(signals), { force });
  writeFileSafe(path.join(".agentdiff", "map.json"), `${JSON.stringify(starterMap(), null, 2)}\n`, { force });
  writeFileSafe(path.join(".agentdiff", "scenarios", "starter.json"), `${JSON.stringify(starterScenario(), null, 2)}\n`, { force });
  if (githubAction) {
    writeFileSafe(path.join(".github", "workflows", "agentdiff.yml"), starterGitHubWorkflow(), { force });
  }

  console.log("created agentdiff.yml");
  console.log("created .agentdiff/map.json");
  console.log("created .agentdiff/scenarios/starter.json");
  if (githubAction) {
    console.log("created .github/workflows/agentdiff.yml");
  }
  console.log("");
  console.log("detected:");
  for (const line of summarizeOnboardingSignals(signals)) {
    console.log(`- ${line}`);
  }
  console.log("");
  console.log("next:");
  console.log("1. scan this repo:");
  console.log("   node packages/cli/bin/agentdiff.js scan");
  console.log("2. review the generated map:");
  console.log("   .agentdiff/runs/latest/map.json");
  if (githubAction) {
    console.log("3. open a pull request and check the sticky agentdiff comment");
  } else {
    console.log("3. install the GitHub Action:");
    console.log("   rerun init with --github-action or copy the workflow from README.md -> Install");
  }
  console.log("");
  console.log("tip: suppressions require reason and expires; suppressed findings stay visible in reports.");
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

async function runLiveExample({ example }) {
  const harness = process.env.AGENTDIFF_HARNESS || "codex-cli";
  const adapterPath = path.resolve(process.cwd(), "examples", example, "harnesses", `${harness}.js`);
  if (!fs.existsSync(adapterPath)) {
    throw new Error(`live harness adapter not found: ${adapterPath}`);
  }

  execFileSync(process.execPath, [adapterPath], {
    cwd: process.cwd(),
    stdio: "inherit"
  });
}

async function classify({ files, out }) {
  const outDir = path.resolve(process.cwd(), out);
  const agentMap = readAgentMapIfPresent();
  const suppressions = readSuppressionRules(process.cwd());
  const report = buildClassificationReport({
    repo: path.basename(process.cwd()),
    suppressions,
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
  console.log(`suppressed findings: ${report.suppressed_findings.length}`);
  console.log(`report: ${path.join(outDir, "report.md")}`);
}

async function scan({ root, out }) {
  const rootDir = path.resolve(process.cwd(), root);
  const scanResult = collectScanFiles(rootDir);
  const langGraphConfig = readLangGraphEntrypoints(rootDir);
  const entrypointGlobs = [
    ...readEntrypointGlobs(rootDir).map((glob) => resolveGlobRelativeToCwd(rootDir, glob)),
    ...langGraphConfig.entrypoints
  ];
  const importResolver = buildImportResolverConfig(rootDir);
  const map = buildAgentMap({
    repo: path.basename(process.cwd()),
    entrypointGlobs,
    entrypointSources: langGraphConfig.entrypointSources,
    importResolver,
    files: scanResult.files.map((file) => ({
      filePath: file.relativePath,
      content: readTextWithLimit(file.absolutePath, file.size)
    }))
  });
  map.scan = {
    ...scanResult.stats,
    scan_limit_warnings: [...new Set([...scanResult.stats.scan_limit_warnings, ...langGraphConfig.warnings])],
    entrypoints_found: map.import_graph.entrypoints.length,
    langgraph_entrypoints: langGraphConfig.entrypoints.length,
    import_edges: map.import_graph.edges.length,
    reachable_files: map.import_graph.reachable_files.length,
    alias_imports_resolved: map.import_graph.alias_imports_resolved,
    workspace_imports_resolved: map.import_graph.workspace_imports_resolved,
    unresolved_non_relative_imports: map.import_graph.unresolved_non_relative_imports
  };

  const outPath = path.resolve(process.cwd(), out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${serializeMapWithinLimit(map)}\n`);

  console.log(`files considered: ${map.scan.files_considered}`);
  console.log(`scanned files: ${map.scan.files_scanned}`);
  console.log(`files skipped: ${map.scan.files_skipped}`);
  console.log(`bytes read: ${map.scan.bytes_read}`);
  if (map.scan.scan_limit_warnings.length > 0) {
    console.log("scan limit warnings:");
    for (const warning of map.scan.scan_limit_warnings) {
      console.log(`- ${warning}`);
    }
  }
  console.log(`entrypoints found: ${map.scan.entrypoints_found}`);
  console.log(`LangGraph entrypoints found: ${map.scan.langgraph_entrypoints}`);
  console.log(`import edges: ${map.scan.import_edges}`);
  console.log(`reachable files: ${map.scan.reachable_files}`);
  console.log(`alias imports resolved: ${map.scan.alias_imports_resolved}`);
  console.log(`workspace imports resolved: ${map.scan.workspace_imports_resolved}`);
  console.log(`unresolved non-relative imports: ${map.scan.unresolved_non_relative_imports}`);
  console.log(`agent surfaces: ${map.surfaces.length}`);
  console.log(`agents: ${map.agents.length}`);
  console.log(`map: ${outPath}`);
}

async function operator({ execute, task }) {
  const config = readOperatorConfig();
  const status = collectOperatorStatus();
  const recommendation = recommendOperatorTask(status);
  const proposedCommands = commandsForOperatorTask(task ?? recommendation.task);
  const riskLevel = riskForOperatorTask(task ?? recommendation.task);

  const report = [
    "# agentdiff operator",
    "",
    `mode: ${execute ? "execute" : "dry_run"}`,
    `risk: ${riskLevel}`,
    "",
    "## current status",
    `branch: ${status.branch}`,
    `git: ${status.gitStatus || "clean"}`,
    `open pull requests: ${status.pullRequests.length}`,
    `open issues: ${status.issues.length}`,
    `latest report: ${status.latestReportStatus}`,
    "",
    "## next recommended task",
    recommendation.summary,
    "",
    "## proposed commands",
    ...proposedCommands.map((command) => `- ${command}`),
    "",
    "## guardrails",
    "- dry-run by default",
    "- no push to main without explicit approval",
    "- no outreach sending without explicit approval",
    "- no package publishing without explicit approval",
    "- no repo visibility changes",
    `- model credit cap: $${config.maxModelCreditUsd.toFixed(2)}`
  ].join("\n");

  console.log(report);

  if (!execute) return;

  for (const command of proposedCommands) {
    if (!config.allowExecute.includes(command)) {
      throw new Error(`operator refused command outside allowlist: ${command}`);
    }
    const [program, ...args] = command.split(/\s+/);
    execFileSync(program, args, {
      cwd: process.cwd(),
      stdio: "inherit"
    });
  }
}

function readOperatorConfig() {
  const configPath = path.resolve(process.cwd(), "agentdiff.operator.yml");
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const allowed = [...text.matchAll(/^\s*-\s+(.+)$/gm)].map((match) => match[1].trim());
  const maxCreditMatch = text.match(/max_model_credit_usd:\s*([0-9.]+)/);
  return {
    allowExecute: allowed.filter((command) => command.startsWith("npm ") || command.startsWith("node ")),
    maxModelCreditUsd: Number(maxCreditMatch?.[1] ?? 0)
  };
}

function collectOperatorStatus() {
  const branch = readGitOutput(["branch", "--show-current"]) || "unknown";
  const gitStatus = readGitOutput(["status", "--short"]);
  const pullRequests = readGhJson(["pr", "list", "--state", "open", "--limit", "20", "--json", "number,title,isDraft,url"]);
  const issues = readGhJson(["issue", "list", "--state", "open", "--limit", "20", "--json", "number,title,url"]);
  const latestReport = readLatestReport();

  return {
    branch,
    gitStatus,
    pullRequests: Array.isArray(pullRequests) ? pullRequests : [],
    issues: Array.isArray(issues) ? issues : [],
    latestReportStatus: latestReport?.status ?? "none"
  };
}

function recommendOperatorTask(status) {
  if (status.gitStatus) {
    return {
      task: "tests",
      summary: "Run the test suite before making more changes."
    };
  }

  return {
    task: "import_graph",
    summary: "Build JS/TS import graph scanning next: entrypoint -> imported tool -> high-risk state mutation."
  };
}

function commandsForOperatorTask(task) {
  if (task === "demo") {
    return ["node packages/cli/bin/agentdiff.js demo --out .agentdiff/runs/latest"];
  }
  if (task === "classify") {
    return ["node packages/cli/bin/agentdiff.js classify --base main --head HEAD"];
  }
  return ["npm test"];
}

function riskForOperatorTask(task) {
  if (task === "classify" || task === "demo" || task === "tests") return "low";
  if (task === "import_graph") return "medium";
  return "unknown";
}

function readLatestReport() {
  const reportPath = path.resolve(process.cwd(), ".agentdiff", "runs", "latest", "report.json");
  if (!fs.existsSync(reportPath)) return null;
  try {
    return readJson(reportPath);
  } catch {
    return null;
  }
}

function readGitOutput(args) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function readGhJson(args) {
  try {
    const output = execFileSync("gh", args, {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function collectScanFiles(rootDir) {
  const limits = readScanLimits();
  const ignoredDirs = new Set([
    ".agentdiff",
    ".cache",
    ".git",
    ".next",
    ".nuxt",
    ".pnpm-store",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "generated",
    "node_modules",
    "out",
    "tmp",
    "vendor"
  ]);
  const allowedExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".md", ".mdx", ".txt", ".yml", ".yaml"]);
  const files = [];
  const skipped = new Map();
  const warnings = [];
  let filesConsidered = 0;
  let bytesRead = 0;
  let stopped = false;

  function skip(reason, count = 1) {
    skipped.set(reason, (skipped.get(reason) ?? 0) + count);
  }

  function walk(dir) {
    if (stopped) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skip("unreadable directory");
      return;
    }

    for (const entry of entries) {
      if (stopped) return;
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name) || entry.name === "__generated__") {
          skip(`ignored directory: ${entry.name}`);
          continue;
        }
        walk(path.join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;
      filesConsidered += 1;
      const absolutePath = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) {
        skip("unsupported extension");
        continue;
      }
      if (isSkippedFileName(entry.name)) {
        skip("lockfile/minified/generated file");
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        skip("unreadable file");
        continue;
      }
      if (!stat.isFile()) {
        skip("not a regular file");
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        skip("file over max size");
        continue;
      }
      if (files.length >= limits.maxFiles) {
        skip("max files reached");
        warnings.push(`partial scan: stopped after ${limits.maxFiles} files`);
        stopped = true;
        return;
      }
      if (bytesRead + stat.size > limits.maxTotalBytes) {
        skip("max total bytes reached");
        warnings.push(`partial scan: stopped before exceeding ${limits.maxTotalBytes} bytes`);
        stopped = true;
        return;
      }

      files.push({
        absolutePath,
        relativePath: path.relative(process.cwd(), absolutePath).replaceAll("\\", "/"),
        size: stat.size
      });
      bytesRead += stat.size;
    }
  }

  walk(rootDir);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const filesSkipped = [...skipped.values()].reduce((sum, count) => sum + count, 0);
  for (const [reason, count] of skipped.entries()) {
    if (count > 0 && ["file over max size", "max files reached", "max total bytes reached", "unreadable directory", "unreadable file"].includes(reason)) {
      warnings.push(`skipped ${count} item(s): ${reason}`);
    }
  }

  return {
    files,
    stats: {
      files_considered: filesConsidered,
      files_scanned: files.length,
      files_skipped: filesSkipped,
      bytes_read: bytesRead,
      limits,
      skipped_by_reason: Object.fromEntries(skipped.entries()),
      partial: stopped,
      scan_limit_warnings: [...new Set(warnings)]
    }
  };
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

function readTextWithLimit(filePath, expectedSize) {
  if (expectedSize > readScanLimits().maxFileBytes) return "";
  return fs.readFileSync(filePath, "utf8");
}

function readEntrypointGlobs(rootDir) {
  const configPath = findAgentdiffConfigPath(rootDir);
  if (!configPath) return [];

  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  const entrypoints = [];
  let inEntryPoints = false;
  let entryIndent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (/^entrypoints:\s*$/.test(trimmed)) {
      inEntryPoints = true;
      entryIndent = indent;
      continue;
    }

    if (inEntryPoints) {
      if (indent <= entryIndent && !trimmed.startsWith("-")) {
        inEntryPoints = false;
        continue;
      }
      const match = trimmed.match(/^-\s+(.+)$/);
      if (match) {
        entrypoints.push(match[1].replace(/^["']|["']$/g, ""));
      }
    }
  }

  return entrypoints;
}

function readSuppressionRules(rootDir) {
  const configPath = findAgentdiffConfigPath(rootDir);
  if (!configPath) return [];

  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  const suppressions = [];
  let inIgnore = false;
  let ignoreIndent = 0;
  let current = null;

  function finishCurrent() {
    if (current) suppressions.push(current);
    current = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (/^ignore:\s*$/.test(trimmed)) {
      finishCurrent();
      inIgnore = true;
      ignoreIndent = indent;
      continue;
    }

    if (!inIgnore) continue;

    if (indent <= ignoreIndent && !trimmed.startsWith("-")) {
      finishCurrent();
      inIgnore = false;
      continue;
    }

    const itemWithValue = trimmed.match(/^-\s+(\w+):\s*(.+)$/);
    if (itemWithValue) {
      finishCurrent();
      current = { [itemWithValue[1]]: unquoteYamlScalar(itemWithValue[2]) };
      continue;
    }

    if (/^-\s*$/.test(trimmed)) {
      finishCurrent();
      current = {};
      continue;
    }

    const property = trimmed.match(/^(\w+):\s*(.+)$/);
    if (property && current) {
      current[property[1]] = unquoteYamlScalar(property[2]);
    }
  }

  finishCurrent();
  return suppressions.filter((item) => item.path);
}

function readLangGraphEntrypoints(rootDir) {
  const configPath = path.join(rootDir, "langgraph.json");
  const result = {
    entrypoints: [],
    entrypointSources: {},
    warnings: []
  };
  if (!fs.existsSync(configPath)) return result;

  let config;
  try {
    config = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8")));
  } catch (error) {
    result.warnings.push(`LangGraph config warning: could not parse langgraph.json (${error.message})`);
    return result;
  }

  if (!config.graphs || typeof config.graphs !== "object" || Array.isArray(config.graphs)) {
    result.warnings.push("LangGraph config warning: langgraph.json has no object graphs field");
    return result;
  }

  for (const [graphName, graphDefinition] of Object.entries(config.graphs)) {
    if (typeof graphDefinition !== "string") {
      result.warnings.push(`LangGraph config warning: graph ${graphName} is not a string definition`);
      continue;
    }
    const graphFile = graphDefinition.split(":")[0]?.trim();
    if (!graphFile) {
      result.warnings.push(`LangGraph config warning: graph ${graphName} has no file path`);
      continue;
    }
    const absolutePath = path.resolve(rootDir, graphFile);
    if (!isPathInside(rootDir, absolutePath)) {
      result.warnings.push(`LangGraph config warning: graph ${graphName} points outside scan root`);
      continue;
    }
    const relativePath = path.relative(process.cwd(), absolutePath).replaceAll("\\", "/");
    result.entrypoints.push(relativePath);
    result.entrypointSources[relativePath] = {
      entrypoint_source: "langgraph.json",
      graph_name: graphName
    };
  }

  result.entrypoints = [...new Set(result.entrypoints)].sort();
  return result;
}

function isPathInside(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findAgentdiffConfigPath(rootDir) {
  return ["agentdiff.yml", "agentdiff.yaml"]
    .map((name) => path.join(rootDir, name))
    .find((candidate) => fs.existsSync(candidate));
}

function unquoteYamlScalar(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function resolveGlobRelativeToCwd(rootDir, glob) {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.isAbsolute(glob)) return path.relative(process.cwd(), glob).replaceAll("\\", "/");
  const rootRelative = path.relative(process.cwd(), rootDir).replaceAll("\\", "/");
  return rootRelative ? `${rootRelative}/${normalized}` : normalized;
}

function buildImportResolverConfig(rootDir) {
  return {
    tsconfigPaths: readTsconfigPathAliases(rootDir),
    workspacePackages: readWorkspacePackages(rootDir)
  };
}

function readTsconfigPathAliases(rootDir) {
  const configPath = findConfigUpward(rootDir, ["tsconfig.json", "jsconfig.json"]);
  if (!configPath) return [];

  let config;
  try {
    config = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8")));
  } catch {
    return [];
  }

  const compilerOptions = config.compilerOptions ?? {};
  const paths = compilerOptions.paths ?? {};
  if (!paths || typeof paths !== "object") return [];

  const configDir = path.dirname(configPath);
  const baseUrl = compilerOptions.baseUrl ? path.resolve(configDir, compilerOptions.baseUrl) : configDir;
  const aliases = [];

  for (const [aliasPattern, targetPatterns] of Object.entries(paths)) {
    const targets = Array.isArray(targetPatterns) ? targetPatterns : [targetPatterns];
    const normalizedTargets = targets
      .filter((target) => typeof target === "string")
      .map((target) => path.relative(process.cwd(), path.resolve(baseUrl, target)).replaceAll("\\", "/"))
      .filter((target) => isWithinRootPattern(rootDir, target));
    if (normalizedTargets.length === 0) continue;
    aliases.push({
      aliasPattern,
      targetPatterns: normalizedTargets
    });
  }

  return aliases;
}

function findConfigUpward(rootDir, names) {
  const boundary = rootWithinCwd(rootDir) ? process.cwd() : rootDir;
  let current = rootDir;
  while (true) {
    for (const name of names) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (samePath(current, boundary)) return null;
    const parent = path.dirname(current);
    if (samePath(parent, current)) return null;
    current = parent;
  }
}

function rootWithinCwd(rootDir) {
  const relative = path.relative(process.cwd(), rootDir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function isWithinRootPattern(rootDir, relativePattern) {
  const rootRelative = path.relative(process.cwd(), rootDir).replaceAll("\\", "/");
  const normalized = relativePattern.replaceAll("\\", "/");
  if (normalized.startsWith("../") || normalized.includes("/../")) return false;
  if (!rootRelative) return true;
  return normalized === rootRelative || normalized.startsWith(`${rootRelative}/`);
}

function readWorkspacePackages(rootDir) {
  const rootPackageJson = path.join(rootDir, "package.json");
  if (!fs.existsSync(rootPackageJson)) return [];

  const rootPackage = readJsonFileSafe(rootPackageJson);
  const workspacePatterns = workspacePatternsFromPackage(rootPackage);
  if (workspacePatterns.length === 0) return [];

  const packageDirs = new Set();
  for (const pattern of workspacePatterns) {
    for (const packageDir of findWorkspacePackageDirs(rootDir, pattern)) {
      packageDirs.add(packageDir);
    }
  }

  const packages = [];
  for (const packageDir of [...packageDirs].sort()) {
    const packageJsonPath = path.join(packageDir, "package.json");
    const packageJson = readJsonFileSafe(packageJsonPath);
    if (!packageJson?.name) continue;
    packages.push({
      packageName: packageJson.name,
      packageRoot: path.relative(process.cwd(), packageDir).replaceAll("\\", "/"),
      entrypoints: simplePackageEntrypoints(packageJson)
    });
  }
  return packages;
}

function workspacePatternsFromPackage(packageJson) {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((item) => typeof item === "string");
  if (Array.isArray(workspaces?.packages)) return workspaces.packages.filter((item) => typeof item === "string");
  return [];
}

function findWorkspacePackageDirs(rootDir, pattern) {
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/\/+$/, "");
  const basePrefix = normalizedPattern.split("*")[0].replace(/\/+$/, "");
  const searchRoot = path.resolve(rootDir, basePrefix || ".");
  if (!fs.existsSync(searchRoot)) return [];

  const matcher = globMatcher(normalizedPattern);
  const packageDirs = [];
  const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache", "vendor"]);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (fs.existsSync(path.join(dir, "package.json"))) {
      const relative = path.relative(rootDir, dir).replaceAll("\\", "/");
      if (matcher(relative)) packageDirs.push(dir);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  }

  walk(searchRoot);
  return packageDirs;
}

function globMatcher(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__AGENTDIFF_GLOBSTAR__")
    .replace(/\*/g, "[^/]+");
  const regex = new RegExp(`^${escaped.replaceAll("__AGENTDIFF_GLOBSTAR__", ".*")}$`);
  return (value) => regex.test(value.replaceAll("\\", "/"));
}

function simplePackageEntrypoints(packageJson) {
  const candidates = [];
  candidates.push(...entrypointsFromExports(packageJson.exports));
  for (const field of ["module", "main", "types"]) {
    if (typeof packageJson[field] === "string") candidates.push(packageJson[field]);
  }
  candidates.push("src/index", "index");
  return [...new Set(candidates.map((item) => item.replace(/^\.\//, "")).filter(Boolean))];
}

function entrypointsFromExports(exportsField) {
  if (typeof exportsField === "string") return [exportsField];
  if (!exportsField || typeof exportsField !== "object") return [];
  const rootExport = exportsField["."] ?? exportsField;
  if (typeof rootExport === "string") return [rootExport];
  if (!rootExport || typeof rootExport !== "object") return [];
  return ["import", "require", "default", "module", "types"].flatMap((field) =>
    typeof rootExport[field] === "string" ? [rootExport[field]] : []
  );
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function readScanLimits() {
  return {
    maxFileBytes: Number(process.env.AGENTDIFF_SCAN_MAX_FILE_BYTES ?? 512 * 1024),
    maxFiles: Number(process.env.AGENTDIFF_SCAN_MAX_FILES ?? 5000),
    maxTotalBytes: Number(process.env.AGENTDIFF_SCAN_MAX_TOTAL_BYTES ?? 25 * 1024 * 1024),
    maxMapBytes: Number(process.env.AGENTDIFF_SCAN_MAX_MAP_BYTES ?? 10 * 1024 * 1024)
  };
}

function isSkippedFileName(fileName) {
  const lower = fileName.toLowerCase();
  return (
    lower === "package-lock.json" ||
    lower === "pnpm-lock.yaml" ||
    lower === "yarn.lock" ||
    lower === "bun.lockb" ||
    lower === "cargo.lock" ||
    lower.endsWith(".min.js") ||
    lower.endsWith(".min.css") ||
    lower.endsWith(".bundle.js") ||
    lower.endsWith(".generated.ts") ||
    lower.endsWith(".generated.js")
  );
}

function serializeMapWithinLimit(map) {
  const limit = map.scan?.limits?.maxMapBytes ?? readScanLimits().maxMapBytes;
  let serialized = JSON.stringify(map, null, 2);
  if (Buffer.byteLength(serialized, "utf8") <= limit) return serialized;

  map.scan.partial = true;
  map.scan.scan_limit_warnings.push(`partial map: serialized map exceeded ${limit} bytes; truncated surface details`);
  map.surfaces = map.surfaces.slice(0, 1000);
  map.agents = map.agents.slice(0, 200);
  map.evidence = map.evidence?.slice(0, 1000) ?? [];
  serialized = JSON.stringify(map, null, 2);
  return serialized;
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

function detectOnboardingSignals(rootDir) {
  const packageJson = readJsonFileSafe(path.join(rootDir, "package.json"));
  const tsconfigPath = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(rootDir, name)).find((candidate) => fs.existsSync(candidate));
  const tsconfig = tsconfigPath ? readJsonFileSafe(tsconfigPath) : null;
  const candidateDirs = ["src/agents", "src/tools", "app/api", "pages/api"];
  const langGraph = readLangGraphEntrypoints(rootDir);

  return {
    langgraphEntryPoints: langGraph.entrypoints,
    workspaces: workspacePatternsFromPackage(packageJson),
    pathAliases: Object.keys(tsconfig?.compilerOptions?.paths ?? {}),
    candidateDirs: candidateDirs.filter((dir) => fs.existsSync(path.join(rootDir, dir))),
    configFile: tsconfigPath ? path.basename(tsconfigPath) : null
  };
}

function summarizeOnboardingSignals(signals) {
  const lines = [];
  if (signals.langgraphEntryPoints.length > 0) {
    lines.push(`LangGraph graph entrypoints: ${signals.langgraphEntryPoints.join(", ")}`);
  } else {
    lines.push("LangGraph graph entrypoints: none detected");
  }
  if (signals.workspaces.length > 0) {
    lines.push(`package.json workspaces: ${signals.workspaces.join(", ")}`);
  } else {
    lines.push("package.json workspaces: none detected");
  }
  if (signals.pathAliases.length > 0) {
    lines.push(`${signals.configFile} path aliases: ${signals.pathAliases.join(", ")}`);
  } else {
    lines.push("tsconfig/jsconfig path aliases: none detected");
  }
  if (signals.candidateDirs.length > 0) {
    lines.push(`common agent/API dirs: ${signals.candidateDirs.join(", ")}`);
  } else {
    lines.push("common agent/API dirs: none detected");
  }
  return lines;
}

function starterConfig(signals = { candidateDirs: [], langgraphEntryPoints: [] }) {
  const entrypoints = dedupe([...signals.langgraphEntryPoints, ...signals.candidateDirs.map((dir) => `${dir}/**`), "src/agents/**", "app/api/**"]);
  return `agentdiff:
  entrypoints:
${entrypoints.map((entrypoint) => `    - ${entrypoint}`).join("\n")}
  max_cost_usd: 3.00
  mode: byok
  language: typescript

# Scan limits keep first runs fast and make large repos degrade into partial maps.
# Environment overrides:
#   AGENTDIFF_SCAN_MAX_FILE_BYTES=524288
#   AGENTDIFF_SCAN_MAX_FILES=5000
#   AGENTDIFF_SCAN_MAX_TOTAL_BYTES=26214400
#   AGENTDIFF_SCAN_MAX_MAP_BYTES=10485760

detection:
  auto_update_map: true
  block_unmapped_agent_surfaces: false

# Suppress intentional or noisy findings with a reason and expiration.
# Suppressed findings stay visible in report.md.
# ignore:
#   - path: "docs/**"
#     reason: "documentation examples"
#     expires: "2026-07-31"
#   - path: "tests/**"
#     reason: "test fixtures"
#     expires: "2026-07-31"

harnesses:
  recorded:
    command: node packages/cli/bin/agentdiff.js run --example coding-agent-harness --recorded
  live_openrouter:
    env:
      AGENTDIFF_HARNESS: openrouter-openai
      OPENROUTER_MODEL: xiaomi/mimo-v2.5-pro
      AGENTDIFF_MAX_LIVE_COST_USD: "0.25"
    command: node packages/cli/bin/agentdiff.js run --example coding-agent-harness --live

report:
  comment_on_pr: true
  upload_artifacts: true
`;
}

function starterGitHubWorkflow() {
  return `name: agentdiff

on:
  pull_request:
    branches: [main]

jobs:
  classify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm install

      # Public prototype install. Use @main only to test unreleased changes.
      # For local development inside this repo, the equivalent command is:
      # node packages/cli/bin/agentdiff.js classify --base origin/\${{ github.base_ref }} --head HEAD
      - uses: agentdiff-ai/agentdiff@v0.1.0
        with:
          command: classify
          base: origin/\${{ github.base_ref }}
          head: HEAD
          github-token: \${{ github.token }}
`;
}

function dedupe(values) {
  return [...new Set(values)];
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
  agentdiff init [--force] [--github-action]
    Create agentdiff.yml, .agentdiff/map.json, and a starter scenario.

  agentdiff classify --files <path,path> [--out <dir>]
    Classify changed files and write report.json + report.md.

  agentdiff classify --base <ref> --head <ref> [--out <dir>]
    Classify files changed between two git refs.

  agentdiff scan [--root <dir>] [--out <map.json>]
    Scan the repo and write a map artifact. Defaults to .agentdiff/runs/latest/map.json.

  agentdiff operator [--execute] [--task tests|demo|classify]
    Summarize local project state and propose the next allowed action. Dry-run by default.

  agentdiff demo
    Run the support-ticket regression demo.

  agentdiff run --base <trace.json> --head <trace.json> [--out <dir>]
    Compare base/head normalized traces and write report.json + report.md.

  agentdiff run --example coding-agent-harness --recorded [--out <dir>]
    Run a recorded harness demo without API keys.

  AGENTDIFF_HARNESS=codex-cli agentdiff run --example coding-agent-harness --live
    Invoke an experimental live harness adapter, which skips gracefully if unavailable.
`);
}
