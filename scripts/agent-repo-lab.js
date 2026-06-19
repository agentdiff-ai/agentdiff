#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const localCli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");
const outDir = path.join(repoRoot, ".agentdiff", "agent-repo-lab", "latest");
const runRoot = path.join(os.tmpdir(), `agentdiff-agent-repo-lab-${timestampForPath()}`);

const PRIMARY_REPOS = [
  "langchain-ai/agents-from-scratch-ts",
  "langchain-ai/memory-agent-js",
  "mastra-ai/mastra",
  "vercel-labs/github-tools",
  "langchain-ai/langgraphjs",
  "langchain-ai/langgraph-101-ts",
  "langchain-ai/langgraphjs-gen-ui-examples",
  "langchain-ai/agent-inbox-langgraphjs-example",
  "vercel-labs/lead-agent",
  "cometchat/ai-agent-mastra-examples"
];

const SECONDARY_REPOS = [
  "vercel/ai",
  "CopilotKit/canvas-with-mastra",
  "i-am-bee/beeai-framework",
  "openai/openai-agents-js",
  "anthropics/claude-agent-sdk-typescript",
  "VoltAgent/voltagent",
  "run-llama/ts-agents",
  "Azure-Samples/azure-typescript-langchainjs",
  "langchain-ai/langchainjs",
  "universal-tool-calling-protocol/typescript-utcp",
  "zcaceres/easy-agent",
  "hideya/mcp-client-langchain-ts",
  "cometchat/ai-agent-lang-graph-examples",
  "KishorNaik/Sol_Mastra_AI_Demo_Google_Gemini",
  "andrenormanlang/typescript-ai-agent"
];

const maxRepos = Number(readOption(process.argv.slice(2), "--max-repos") ?? process.env.AGENTDIFF_LAB_MAX_REPOS ?? 10);
const maxRepoKb = Number(readOption(process.argv.slice(2), "--max-repo-kb") ?? process.env.AGENTDIFF_LAB_MAX_REPO_KB ?? 300_000);
const includeSecondary = process.argv.includes("--include-secondary") || process.env.AGENTDIFF_LAB_INCLUDE_SECONDARY === "1";
const syntheticLimit = Number(readOption(process.argv.slice(2), "--synthetic-limit") ?? process.env.AGENTDIFF_LAB_SYNTHETIC_REPOS ?? 3);

main().catch((error) => {
  console.error(`agent-repo-lab failed: ${error.stack ?? error.message}`);
  process.exit(1);
});

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(runRoot, { recursive: true });

  const startedAt = new Date();
  const seeds = [...PRIMARY_REPOS, ...(includeSecondary ? SECONDARY_REPOS : [])];
  const report = {
    startedAt: startedAt.toISOString(),
    runRoot,
    configuration: {
      maxRepos,
      maxRepoKb,
      includeSecondary,
      syntheticLimit,
      installsDependencies: false,
      liveModelCalls: false,
      pushesExternalChanges: false
    },
    environment: collectEnvironment(),
    seeds: {
      primary: PRIMARY_REPOS,
      secondary: SECONDARY_REPOS
    },
    repos: [],
    summary: {}
  };

  let syntheticRuns = 0;
  for (const slug of seeds) {
    if (report.repos.filter((repo) => repo.status !== "skipped").length >= maxRepos) break;
    const result = await testRepo(slug, { runSynthetic: syntheticRuns < syntheticLimit });
    if (result.synthetic?.attempted) syntheticRuns += 1;
    report.repos.push(result);
  }

  report.summary = summarizeLab(report.repos);
  report.topProductFixes = recommendProductFixes(report.repos);
  report.candidateIssues = candidateIssues(report.topProductFixes);
  report.nextRepos = SECONDARY_REPOS.filter((repo) => !report.repos.some((tested) => tested.repo === repo)).slice(0, 10);

  fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "report.md"), `${renderReport(report)}\n`);

  console.log(`agent repo lab report: ${path.join(outDir, "report.md")}`);
  console.log(`repos scanned: ${report.summary.scanned}/${report.summary.total}`);
  console.log(`crashes: ${report.summary.crashes}`);
  console.log(`useful findings: ${report.summary.usefulFindings}`);
  console.log(`noisy findings: ${report.summary.noisyFindings}`);
  console.log(`missed signals: ${report.summary.missedSignals}`);

  if (report.summary.scanned < Math.min(5, maxRepos)) {
    process.exitCode = 1;
  }
}

async function testRepo(slug, { runSynthetic }) {
  const repo = {
    repo: slug,
    url: `https://github.com/${slug}`,
    cloneUrl: `https://github.com/${slug}.git`,
    status: "pending",
    metadata: null,
    skipReason: null,
    cloneDir: path.join(runRoot, slug.replace(/[\\/]/g, "__")),
    clone: null,
    scan: null,
    mapPath: null,
    mapCopyPath: null,
    stats: emptyStats(),
    findings: [],
    usefulFindings: [],
    noisyFindings: [],
    unclearFindings: [],
    suppressibleFindings: [],
    missedSignals: [],
    synthetic: null,
    scores: {
      installFriction: 0,
      scanSurvivability: 0,
      usefulSignal: 0,
      falsePositivePressure: 0,
      productFit: 0
    },
    errors: []
  };

  repo.metadata = await fetchRepoMetadata(slug);
  if (repo.metadata?.private) {
    repo.status = "skipped";
    repo.skipReason = "private repository";
    repo.scores.installFriction = 0;
    return repo;
  }
  if (repo.metadata?.archived) {
    repo.status = "skipped";
    repo.skipReason = "archived repository";
    repo.scores.installFriction = 1;
    return repo;
  }
  if (repo.metadata?.sizeKb && repo.metadata.sizeKb > maxRepoKb) {
    repo.status = "skipped";
    repo.skipReason = `repo size ${repo.metadata.sizeKb}KB exceeds limit ${maxRepoKb}KB`;
    repo.scores.installFriction = 1;
    return repo;
  }

  repo.clone = runStep(`clone ${slug}`, "git", ["clone", "--depth=1", repo.cloneUrl, repo.cloneDir], {
    cwd: runRoot,
    timeoutMs: 240_000
  });
  if (!repo.clone.ok) {
    repo.status = "crashed";
    repo.errors.push("clone failed");
    scoreRepo(repo);
    return repo;
  }

  repo.mapPath = path.join(repo.cloneDir, ".agentdiff", "map.json");
  repo.scan = runStep(`scan ${slug}`, process.execPath, [localCli, "scan", "--root", ".", "--out", repo.mapPath], {
    cwd: repo.cloneDir,
    timeoutMs: 240_000
  });
  if (!repo.scan.ok) {
    repo.status = "crashed";
    repo.errors.push("scan failed");
    scoreRepo(repo);
    return repo;
  }

  const map = readJsonIfPresent(repo.mapPath);
  repo.stats = statsFromMap(map, repo.scan.stdout);
  repo.findings = inspectFindings(map, repo.cloneDir);
  repo.usefulFindings = repo.findings.filter((finding) => finding.label === "useful");
  repo.noisyFindings = repo.findings.filter((finding) => finding.label === "noisy");
  repo.unclearFindings = repo.findings.filter((finding) => finding.label === "unclear");
  repo.suppressibleFindings = repo.findings.filter((finding) => finding.suppressible);
  repo.missedSignals = findMissedSignals({ map, cloneDir: repo.cloneDir });
  repo.mapCopyPath = copyMapForReport(repo, map);

  if (runSynthetic) {
    repo.synthetic = runSyntheticPrTest({ repo, map });
  } else {
    repo.synthetic = { attempted: false, reason: "synthetic limit reached" };
  }

  repo.status = "scanned";
  scoreRepo(repo);
  return repo;
}

async function fetchRepoMetadata(slug) {
  try {
    const response = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: {
        "User-Agent": "agentdiff-agent-repo-lab",
        Accept: "application/vnd.github+json"
      }
    });
    if (!response.ok) {
      return { error: `metadata fetch failed: ${response.status}` };
    }
    const body = await response.json();
    return {
      nameWithOwner: body.full_name,
      private: Boolean(body.private),
      archived: Boolean(body.archived),
      defaultBranch: body.default_branch || "main",
      sizeKb: Number(body.size ?? 0),
      language: body.language || null,
      stars: Number(body.stargazers_count ?? 0),
      pushedAt: body.pushed_at || null
    };
  } catch (error) {
    return { error: error.message };
  }
}

function inspectFindings(map, cloneDir) {
  const surfaces = [...(map?.surfaces ?? [])];
  return surfaces
    .filter((surface) => shouldInspect(surface))
    .sort((a, b) => findingRank(b) - findingRank(a))
    .slice(0, 5)
    .map((surface) => classifyFinding(surface, cloneDir, map));
}

function shouldInspect(surface) {
  return Boolean(surface.risk?.length || surface.reachable_from_entrypoint || Number(surface.confidence ?? 0) >= 0.7);
}

function findingRank(surface) {
  let score = 0;
  if (surface.reachable_from_entrypoint) score += 5;
  if (surface.risk?.length) score += 3;
  if (surface.label === "tool_implementation") score += 2;
  if (surface.surface_category === "docs_example" || surface.surface_category === "test_fixture") score -= 3;
  score += Number(surface.confidence ?? 0);
  return score;
}

function classifyFinding(surface, cloneDir, map) {
  const pathName = surface.path ?? "";
  const docLike = isDocTestConfig(pathName, surface);
  const reachable = Boolean(surface.reachable_from_entrypoint);
  const hasRisk = surface.risk?.length > 0;
  const source = readSnippet(path.join(cloneDir, pathName));
  const chain = surface.explanation?.reachability_chain ?? surface.reachable_entrypoints ?? [];
  const importedBy = importedByFor(map, pathName);
  const reasons = [
    reachable ? `reachable from ${chain[0] ?? "an inferred entrypoint"}` : "not proven reachable from runtime entrypoint",
    hasRisk ? `risk words: ${surface.risk.join(", ")}` : "no explicit risk label",
    surface.surface_category ? `category: ${surface.surface_category}` : null,
    surface.label ? `classified as ${surface.label}` : null
  ].filter(Boolean);

  let label = "unclear";
  if (reachable && hasRisk && !docLike) label = "useful";
  if (!reachable && docLike) label = "noisy";
  if (!reachable && hasRisk && surface.surface_category === "helper_utility") label = "unclear";

  return {
    path: pathName,
    label,
    surfaceLabel: surface.label,
    category: surface.surface_category,
    risk: surface.risk ?? [],
    confidence: surface.confidence ?? 0,
    reachable,
    reachableFrom: chain,
    importedBy,
    suppressible: docLike || !reachable,
    whyFlagged: surface.explanation?.why_flagged ?? reasons,
    riskEvidence: surface.explanation?.risk_evidence ?? surface.evidence ?? [],
    whyItMightMatter: whyItMightMatter(surface, { reachable, docLike, hasRisk }),
    whatWouldMakeStronger: whatWouldMakeStronger(surface, { reachable, docLike, hasRisk }),
    snippet: source
  };
}

function whyItMightMatter(surface, { reachable, docLike, hasRisk }) {
  if (docLike) {
    return "This looks like docs, tests, config, or examples. It may still describe agent behavior, but should not create action-required pressure unless configured as runtime input.";
  }
  if (reachable && hasRisk) {
    return "This is an agent-relevant surface reachable from a runtime entrypoint with state-changing or external side-effect evidence.";
  }
  if (hasRisk) {
    return "This has tool or side-effect naming evidence, but reachability is not established yet.";
  }
  return "This looks agent-related, but needs stronger tool, schema, or import evidence.";
}

function whatWouldMakeStronger(surface, { reachable, docLike, hasRisk }) {
  if (docLike) return "A default suppression or lower report tier for docs/tests/config would reduce review noise.";
  if (!reachable && hasRisk) return "Import graph evidence from a configured entrypoint would make this a stronger finding.";
  if (reachable && !hasRisk) return "Tool schema, arguments, or call-site evidence would make the risk easier to explain.";
  return "A concise reachability chain and call-site evidence would make the report more actionable.";
}

function findMissedSignals({ map, cloneDir }) {
  const surfacePaths = new Set((map?.surfaces ?? []).map((surface) => normalizePath(surface.path)));
  const files = collectCandidateFiles(cloneDir, { maxFiles: 2500, maxBytes: 12_000_000 });
  const missed = [];
  for (const file of files) {
    const relative = normalizePath(path.relative(cloneDir, file.absolutePath));
    if (surfacePaths.has(relative)) continue;
    const content = readTextIfSmall(file.absolutePath, 180_000);
    if (!content) continue;
    const signals = missedSignalReasons(relative, content);
    if (signals.length === 0) continue;
    missed.push({
      path: relative,
      signals,
      evidence: snippetAroundSignals(content, signals)
    });
    if (missed.length >= 12) break;
  }
  return missed;
}

function missedSignalReasons(relative, content) {
  const reasons = [];
  const lowerPath = relative.toLowerCase();
  if (relative.endsWith("langgraph.json")) reasons.push("LangGraph config file");
  if (/mastra\.(config|conf)\.(ts|js|mjs|cjs)$/i.test(relative) || lowerPath.includes("/mastra/")) reasons.push("Mastra config or runtime path");
  if (/\btool\s*\(|defineTool|createTool|DynamicStructuredTool|toolSchema|tools\s*:/i.test(content)) reasons.push("AI tool definition syntax");
  if (/from\s+["'](?:openai|@openai\/agents|@anthropic-ai\/sdk|ai|@ai-sdk\/[^"']+)["']/i.test(content)) reasons.push("AI SDK import");
  if (/\b(send|refund|charge|delete|close|publish|update|create|approve|reject|revoke|grant|checkpoint|memory)\w*\s*\(/i.test(content)) {
    reasons.push("state-changing or tool-like operation name");
  }
  if (/\b(GitHub|github|email|browser|payment|invoice|customer|checkpoint|memory)\b/i.test(content) && /\bexecute|invoke|call|tool|action\b/i.test(content)) {
    reasons.push("agent operation vocabulary");
  }
  return [...new Set(reasons)].slice(0, 4);
}

function runSyntheticPrTest({ repo, map }) {
  const result = {
    attempted: true,
    status: "pending",
    baseRef: null,
    changedFiles: [],
    classify: null,
    reportPath: path.join(repo.cloneDir, ".agentdiff", "lab-synthetic", "report.json"),
    useful: false,
    findingSummary: [],
    errors: []
  };

  const baseRef = commandOutput("git", ["rev-parse", "HEAD"], repo.cloneDir);
  if (!baseRef) {
    result.status = "failed";
    result.errors.push("could not resolve base ref");
    return result;
  }
  result.baseRef = baseRef;

  runStep("configure synthetic git user", "git", ["config", "user.email", "agentdiff-lab@example.invalid"], {
    cwd: repo.cloneDir,
    timeoutMs: 30_000
  });
  runStep("configure synthetic git name", "git", ["config", "user.name", "agentdiff lab"], {
    cwd: repo.cloneDir,
    timeoutMs: 30_000
  });
  runStep("create synthetic branch", "git", ["checkout", "-b", "agentdiff-lab-synthetic"], {
    cwd: repo.cloneDir,
    timeoutMs: 30_000
  });

  const toolsDir = chooseToolsDir(repo.cloneDir, map);
  const toolPath = path.join(toolsDir, "agentdiffLabSendInvoice.ts");
  fs.mkdirSync(path.dirname(toolPath), { recursive: true });
  fs.writeFileSync(
    toolPath,
    [
      "export async function sendInvoice({ recipientEmail, amountUsd, customerId }) {",
      "  // External side effect: sends a payable invoice to a customer.",
      "  return { invoiceId: `inv_${customerId}_${amountUsd}` };",
      "}",
      ""
    ].join("\n")
  );
  result.changedFiles.push(normalizePath(path.relative(repo.cloneDir, toolPath)));

  const agentPath = chooseReachableAgentFile(repo.cloneDir, map);
  if (agentPath) {
    fs.appendFileSync(
      agentPath,
      [
        "",
        "export async function agentdiffLabUnsafeChange(customerId, ticketId) {",
        "  await issue_refund(customerId);",
        "  await close_ticket(ticketId);",
        "}",
        ""
      ].join("\n")
    );
    result.changedFiles.push(normalizePath(path.relative(repo.cloneDir, agentPath)));
  }

  const docsPath = path.join(repo.cloneDir, "docs", "agentdiff-lab-tools.md");
  fs.mkdirSync(path.dirname(docsPath), { recursive: true });
  fs.writeFileSync(docsPath, "# Agentdiff lab fixture\n\nThis docs-only example mentions sendEmail, refundCustomer, and closeTicket.\n");
  result.changedFiles.push(normalizePath(path.relative(repo.cloneDir, docsPath)));

  runStep("stage synthetic changes", "git", ["add", "--", ...result.changedFiles], { cwd: repo.cloneDir, timeoutMs: 30_000 });
  const commit = runStep("commit synthetic changes", "git", ["commit", "--no-verify", "-m", "agentdiff-lab-synthetic"], {
    cwd: repo.cloneDir,
    timeoutMs: 30_000
  });
  if (!commit.ok) {
    result.status = "failed";
    result.errors.push(`synthetic commit failed: ${oneLine(commit.stderrTail || commit.stdoutTail)}`);
    return result;
  }

  const out = path.join(".agentdiff", "lab-synthetic");
  result.classify = runStep("classify synthetic branch", process.execPath, [localCli, "classify", "--base", baseRef, "--head", "HEAD", "--out", out], {
    cwd: repo.cloneDir,
    timeoutMs: 120_000
  });
  if (!result.classify.ok) {
    result.status = "failed";
    result.errors.push("synthetic classify failed");
    return result;
  }

  const report = readJsonIfPresent(path.join(repo.cloneDir, out, "report.json"));
  const findings = [
    ...(report?.changed_surfaces ?? []),
    ...(report?.map_drift ?? []),
    ...(report?.behavior_findings ?? [])
  ];
  result.findingSummary = findings.slice(0, 8).map((finding) => ({
    type: finding.type,
    path: finding.path,
    severity: finding.severity,
    addedCalls: finding.added_calls ?? [],
    risk: finding.risk ?? [],
    summary: finding.summary ?? finding.recommendation ?? ""
  }));
  const syntheticText = JSON.stringify(result.findingSummary).toLowerCase();
  result.useful =
    syntheticText.includes("sendinvoice") ||
    syntheticText.includes("issue_refund") ||
    syntheticText.includes("external_side_effect");
  result.status = result.useful ? "useful" : "unclear";
  return result;
}

function chooseToolsDir(cloneDir, map) {
  const surfaceTool = (map?.surfaces ?? []).find((surface) => /(^|\/)tools?(\/|$)/i.test(surface.path ?? ""));
  if (surfaceTool) return path.join(cloneDir, path.dirname(surfaceTool.path));
  const found = findFirstDirectory(cloneDir, (relative) => /(^|\/)tools?$/i.test(relative));
  if (found) return found;
  return path.join(cloneDir, "src", "tools");
}

function chooseReachableAgentFile(cloneDir, map) {
  const surface = (map?.surfaces ?? []).find(
    (item) => item.reachable_from_entrypoint && /\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(item.path ?? "") && !isDocTestConfig(item.path, item)
  );
  if (surface) return path.join(cloneDir, surface.path);
  const entrypoint = map?.import_graph?.entrypoints?.find((item) => /\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(item));
  return entrypoint ? path.join(cloneDir, entrypoint) : null;
}

function scoreRepo(repo) {
  repo.scores.installFriction = repo.clone?.ok ? 5 : repo.status === "skipped" ? 1 : 0;
  repo.scores.scanSurvivability = repo.scan?.ok ? 5 : repo.clone?.ok ? 1 : 0;
  repo.scores.usefulSignal = Math.min(5, repo.usefulFindings.length);
  repo.scores.falsePositivePressure = Math.max(0, 5 - Math.min(5, repo.noisyFindings.length + Math.floor(repo.unclearFindings.length / 2)));
  repo.scores.productFit = Math.min(
    5,
    (repo.usefulFindings.length > 0 ? 2 : 0) +
      (repo.stats.reachableHighRiskSurfaces > 0 ? 1 : 0) +
      (repo.stats.importEdges > 0 ? 1 : 0) +
      (repo.missedSignals.length > 0 ? 1 : 0)
  );
}

function summarizeLab(repos) {
  return {
    total: repos.length,
    scanned: repos.filter((repo) => repo.status === "scanned").length,
    skipped: repos.filter((repo) => repo.status === "skipped").length,
    crashes: repos.filter((repo) => repo.status === "crashed").length,
    usefulFindings: sum(repos, (repo) => repo.usefulFindings.length),
    noisyFindings: sum(repos, (repo) => repo.noisyFindings.length),
    unclearFindings: sum(repos, (repo) => repo.unclearFindings.length),
    missedSignals: sum(repos, (repo) => repo.missedSignals.length),
    syntheticRuns: repos.filter((repo) => repo.synthetic?.attempted).length,
    usefulSyntheticRuns: repos.filter((repo) => repo.synthetic?.useful).length
  };
}

function recommendProductFixes(repos) {
  const fixes = [];
  const missedLangGraph = repos.flatMap((repo) => repo.missedSignals.map((signal) => ({ repo: repo.repo, ...signal }))).filter((signal) =>
    signal.signals.some((item) => /LangGraph|AI tool definition|AI SDK/.test(item))
  );
  const noisyDocs = repos.flatMap((repo) => repo.noisyFindings.map((finding) => ({ repo: repo.repo, ...finding }))).filter((finding) => finding.suppressible);
  const unresolvedHeavy = repos.filter((repo) => repo.stats.unresolvedNonRelativeImports > 50);
  const syntheticWeak = repos.filter((repo) => repo.synthetic?.attempted && !repo.synthetic?.useful);

  if (missedLangGraph.length > 0) {
    fixes.push({
      title: "Improve tool/config surface detection for missed agent signals",
      evidence: missedLangGraph.slice(0, 5).map((item) => `${item.repo}: ${item.path} (${item.signals.join("; ")})`),
      recommendation: "Add narrow detectors for common JS/TS agent framework tool definitions and config files that are currently visible in source but absent from the map."
    });
  }
  if (noisyDocs.length > 0) {
    fixes.push({
      title: "Further downrank docs/tests/config findings by default",
      evidence: noisyDocs.slice(0, 5).map((item) => `${item.repo}: ${item.path} (${item.category ?? item.surfaceLabel})`),
      recommendation: "Keep docs/test findings visible, but move more of them to informational unless explicitly configured as runtime prompt or scenario input."
    });
  }
  if (unresolvedHeavy.length > 0) {
    fixes.push({
      title: "Reduce unresolved import blind spots in modern monorepos",
      evidence: unresolvedHeavy.slice(0, 5).map((repo) => `${repo.repo}: ${repo.stats.unresolvedNonRelativeImports} unresolved non-relative imports`),
      recommendation: "Inspect unresolved import samples and add only high-confidence resolver support, not full TypeScript compiler emulation."
    });
  }
  if (syntheticWeak.length > 0) {
    fixes.push({
      title: "Make synthetic risky PR findings sharper",
      evidence: syntheticWeak.slice(0, 5).map((repo) => `${repo.repo}: synthetic classify did not clearly surface sendInvoice or issue_refund`),
      recommendation: "Improve changed-file and map-drift report wording for added high-risk tool files and risky calls."
    });
  }

  return fixes.slice(0, 6);
}

function candidateIssues(fixes) {
  return fixes.slice(0, 3).map((fix) => ({
    title: fix.title,
    body: [
      "Evidence from agent-repo lab:",
      "",
      ...fix.evidence.map((item) => `- ${item}`),
      "",
      "Recommended fix:",
      "",
      fix.recommendation,
      "",
      "Acceptance:",
      "",
      "- Lab report shows reduced noise or stronger useful signal on at least one cited repo.",
      "- No live model calls or dependency installs are required."
    ].join("\n")
  }));
}

function renderReport(report) {
  const lines = [];
  lines.push("# agentdiff agent-repo lab");
  lines.push("");
  lines.push("This lab uses fixed public JS/TS agent repo seeds as a customer-discovery substitute. It clones shallow, does not install dependencies, does not call live models, and never pushes or comments on external repos.");
  lines.push("");
  lines.push("## summary");
  lines.push("");
  lines.push(`started: ${report.startedAt}`);
  lines.push(`temp root: ${report.runRoot}`);
  lines.push(`repos scanned: ${report.summary.scanned}/${report.summary.total}`);
  lines.push(`repos skipped: ${report.summary.skipped}`);
  lines.push(`crashes: ${report.summary.crashes}`);
  lines.push(`useful findings: ${report.summary.usefulFindings}`);
  lines.push(`noisy findings: ${report.summary.noisyFindings}`);
  lines.push(`unclear findings: ${report.summary.unclearFindings}`);
  lines.push(`missed signals: ${report.summary.missedSignals}`);
  lines.push(`synthetic PR tests: ${report.summary.usefulSyntheticRuns}/${report.summary.syntheticRuns} useful`);
  lines.push("");
  lines.push("## pass/crash table");
  lines.push("");
  lines.push("| repo | status | files scanned | entrypoints | edges | reachable high-risk | missed signals | useful/noisy/unclear | scores |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |");
  for (const repo of report.repos) {
    lines.push(
      `| ${repo.repo} | ${repo.status}${repo.skipReason ? ` (${repo.skipReason})` : ""} | ${repo.stats.filesScanned} | ${repo.stats.entrypointsFound} | ${repo.stats.importEdges} | ${repo.stats.reachableHighRiskSurfaces} | ${repo.missedSignals.length} | ${repo.usefulFindings.length}/${repo.noisyFindings.length}/${repo.unclearFindings.length} | ${scoreText(repo.scores)} |`
    );
  }
  lines.push("");
  lines.push("## useful findings");
  lines.push("");
  renderFindingGroup(lines, report.repos, "usefulFindings");
  lines.push("## noisy findings");
  lines.push("");
  renderFindingGroup(lines, report.repos, "noisyFindings");
  lines.push("## unclear findings");
  lines.push("");
  renderFindingGroup(lines, report.repos, "unclearFindings");
  lines.push("## missed signals");
  lines.push("");
  for (const repo of report.repos) {
    if (repo.missedSignals.length === 0) continue;
    lines.push(`### ${repo.repo}`);
    lines.push("");
    for (const signal of repo.missedSignals.slice(0, 5)) {
      lines.push(`- ${signal.path}: ${signal.signals.join("; ")}`);
    }
    lines.push("");
  }
  if (!report.repos.some((repo) => repo.missedSignals.length > 0)) lines.push("No missed signals recorded.");
  lines.push("");
  lines.push("## synthetic PR results");
  lines.push("");
  for (const repo of report.repos.filter((item) => item.synthetic?.attempted)) {
    lines.push(`### ${repo.repo}`);
    lines.push("");
    lines.push(`status: ${repo.synthetic.status}`);
    lines.push(`changed files: ${repo.synthetic.changedFiles.join(", ") || "none"}`);
    if (repo.synthetic.findingSummary.length === 0) {
      lines.push("- no findings summarized");
    } else {
      for (const finding of repo.synthetic.findingSummary) {
        lines.push(`- ${finding.type ?? "finding"} ${finding.path ?? ""} ${finding.severity ?? ""} ${finding.addedCalls?.length ? `added calls: ${finding.addedCalls.join(", ")}` : ""}`.trim());
      }
    }
    if (repo.synthetic.errors.length > 0) {
      lines.push(`errors: ${repo.synthetic.errors.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("## top product fixes");
  lines.push("");
  if (report.topProductFixes.length === 0) {
    lines.push("- No immediate product fixes were inferred.");
  }
  for (const fix of report.topProductFixes) {
    lines.push(`### ${fix.title}`);
    lines.push("");
    lines.push(fix.recommendation);
    lines.push("");
    lines.push("evidence:");
    for (const item of fix.evidence) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push("## candidate GitHub issues");
  lines.push("");
  if (report.candidateIssues.length === 0) {
    lines.push("- No candidate issues generated.");
  }
  for (const issue of report.candidateIssues) {
    lines.push(`### ${issue.title}`);
    lines.push("");
    lines.push("```md");
    lines.push(issue.body);
    lines.push("```");
    lines.push("");
  }
  lines.push("## next 10 repos to test");
  lines.push("");
  for (const repo of report.nextRepos) {
    lines.push(`- ${repo}`);
  }
  lines.push("");
  lines.push("## what this does not prove");
  lines.push("");
  lines.push("- This is not a security audit.");
  lines.push("- This is not a claim that external repos are unsafe.");
  lines.push("- This is not a model-quality benchmark.");
  lines.push("- This does not install dependencies or execute external repo code.");
  lines.push("");
  return lines.join("\n");
}

function renderFindingGroup(lines, repos, key) {
  let any = false;
  for (const repo of repos) {
    const findings = repo[key] ?? [];
    if (findings.length === 0) continue;
    any = true;
    lines.push(`### ${repo.repo}`);
    lines.push("");
    for (const finding of findings.slice(0, 5)) {
      lines.push(`- ${finding.path}: ${finding.surfaceLabel}/${finding.category ?? "uncategorized"} (${finding.risk.join(", ") || "no risk"})`);
      lines.push(`  why: ${finding.whyItMightMatter}`);
      lines.push(`  stronger if: ${finding.whatWouldMakeStronger}`);
      if (finding.reachableFrom.length > 0) lines.push(`  reachable from: ${finding.reachableFrom.join(" -> ")}`);
    }
    lines.push("");
  }
  if (!any) lines.push("No findings in this bucket.");
  lines.push("");
}

function statsFromMap(map, stdout) {
  const surfaces = map?.surfaces ?? [];
  return {
    filesConsidered: Number(map?.scan?.files_considered ?? matchFirst(stdout, /files considered:\s*(\d+)/) ?? 0),
    filesScanned: Number(map?.scan?.files_scanned ?? matchFirst(stdout, /scanned files:\s*(\d+)/) ?? 0),
    filesSkipped: Number(map?.scan?.files_skipped ?? matchFirst(stdout, /files skipped:\s*(\d+)/) ?? 0),
    bytesRead: Number(map?.scan?.bytes_read ?? matchFirst(stdout, /bytes read:\s*(\d+)/) ?? 0),
    warnings: map?.scan?.scan_limit_warnings ?? [],
    entrypointsFound: Number(map?.scan?.entrypoints_found ?? map?.import_graph?.entrypoints?.length ?? 0),
    importEdges: Number(map?.scan?.import_edges ?? map?.import_graph?.edges?.length ?? 0),
    reachableFiles: Number(map?.scan?.reachable_files ?? map?.import_graph?.reachable_files?.length ?? 0),
    aliasImportsResolved: Number(map?.scan?.alias_imports_resolved ?? 0),
    workspaceImportsResolved: Number(map?.scan?.workspace_imports_resolved ?? 0),
    unresolvedNonRelativeImports: Number(map?.scan?.unresolved_non_relative_imports ?? 0),
    reachableHighRiskSurfaces: surfaces.filter((surface) => surface.reachable_from_entrypoint && surface.risk?.length > 0).length,
    unreachableHighRiskLookingSurfaces: surfaces.filter((surface) => !surface.reachable_from_entrypoint && surface.risk?.length > 0).length,
    docsTestsConfigSurfaces: surfaces.filter((surface) => isDocTestConfig(surface.path, surface)).length
  };
}

function emptyStats() {
  return {
    filesConsidered: 0,
    filesScanned: 0,
    filesSkipped: 0,
    bytesRead: 0,
    warnings: [],
    entrypointsFound: 0,
    importEdges: 0,
    reachableFiles: 0,
    aliasImportsResolved: 0,
    workspaceImportsResolved: 0,
    unresolvedNonRelativeImports: 0,
    reachableHighRiskSurfaces: 0,
    unreachableHighRiskLookingSurfaces: 0,
    docsTestsConfigSurfaces: 0
  };
}

function collectCandidateFiles(root, { maxFiles, maxBytes }) {
  const files = [];
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0 && files.length < maxFiles && bytes < maxBytes) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relative = normalizePath(path.relative(root, absolutePath));
      if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, relative) || entry.name === ".agentdiff") continue;
      stack.push(absolutePath);
      continue;
    }
      if (!entry.isFile() || !isMissedSignalCandidate(relative)) continue;
      if (isLockfile(entry.name) || /\.min\.(js|css)$/i.test(entry.name)) continue;
      const stat = safeStat(absolutePath);
      if (!stat || stat.size > 512_000) continue;
      bytes += stat.size;
      files.push({ absolutePath, size: stat.size });
      if (files.length >= maxFiles || bytes >= maxBytes) break;
    }
  }
  return files;
}

function shouldSkipDir(name, relative) {
  return /^(node_modules|\.git|\.agentdiff|dist|build|coverage|\.next|\.turbo|\.cache|vendor|generated|out)$/i.test(name) || /(^|\/)__snapshots__(\/|$)/i.test(relative);
}

function isLockfile(name) {
  return /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i.test(name);
}

function isMissedSignalCandidate(relative) {
  const normalized = normalizePath(relative);
  if (/(^|\/)langgraph\.json$/i.test(normalized)) return true;
  if (/(^|\/)mastra\.(config|conf)\.(ts|js|mjs|cjs)$/i.test(normalized)) return true;
  if (/(^|\/)package\.json$/i.test(normalized)) return false;
  if (/(^|\/)(README|CHANGELOG|LICENSE)(\.[^/]*)?$/i.test(normalized)) return false;
  if (/\.(md|mdx|txt|rst|json)$/i.test(normalized)) return false;
  return /\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(normalized);
}

function isDocTestConfig(pathName, surface = {}) {
  const normalized = normalizePath(pathName ?? "").toLowerCase();
  return (
    /\.(md|mdx|txt|rst)$/i.test(normalized) ||
    /(^|\/)(docs?|examples?|tests?|test|__tests__|fixtures?|stories?|storybook|benchmarks?)(\/|$)/i.test(normalized) ||
    /(^|\/)(readme|changelog|config|vite\.config|tsconfig|jsconfig|eslint|prettier)/i.test(normalized) ||
    ["docs_example", "test_fixture", "config_metadata"].includes(surface.surface_category)
  );
}

function importedByFor(map, targetPath) {
  return (map?.import_graph?.edges ?? [])
    .filter((edge) => normalizePath(edge.to) === normalizePath(targetPath))
    .map((edge) => edge.from)
    .slice(0, 5);
}

function copyMapForReport(repo, map) {
  if (!map) return null;
  const mapsDir = path.join(outDir, "maps");
  fs.mkdirSync(mapsDir, { recursive: true });
  const target = path.join(mapsDir, `${repo.repo.replace(/[\\/]/g, "__")}.map.json`);
  fs.writeFileSync(target, `${JSON.stringify(map, null, 2)}\n`);
  return target;
}

function findFirstDirectory(root, predicate) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(dir, entry.name);
      const relative = normalizePath(path.relative(root, absolute));
      if (shouldSkipDir(entry.name, relative)) continue;
      if (predicate(relative)) return absolute;
      stack.push(absolute);
    }
  }
  return null;
}

function runStep(label, command, args, { cwd, timeoutMs }) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env: withoutSecrets(process.env),
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32" && command === "npm"
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

function withoutSecrets(env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (/(_API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) delete copy[key];
  }
  delete copy.OPENROUTER_API_KEY;
  delete copy.ANTHROPIC_API_KEY;
  delete copy.OPENAI_API_KEY;
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

function commandOutput(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && command === "npm",
    env: withoutSecrets(process.env)
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTextIfSmall(filePath, maxBytes) {
  const stat = safeStat(filePath);
  if (!stat || stat.size > maxBytes) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readSnippet(filePath) {
  const text = readTextIfSmall(filePath, 160_000);
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .filter((line) => /\b(agent|tool|send|refund|charge|delete|close|publish|update|create|approve|reject|memory|checkpoint|invoke|execute)\b/i.test(line))
    .slice(0, 6)
    .join("\n")
    .slice(0, 1200);
}

function snippetAroundSignals(content, signals) {
  const keywords = signals.flatMap((signal) => signal.split(/\W+/)).filter((word) => word.length > 3);
  return content
    .split(/\r?\n/)
    .filter((line) => keywords.some((keyword) => line.toLowerCase().includes(keyword.toLowerCase())))
    .slice(0, 4)
    .join("\n")
    .slice(0, 800);
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function matchFirst(text, regex) {
  return String(text ?? "").match(regex)?.[1];
}

function sum(values, select) {
  return values.reduce((total, value) => total + Number(select(value) ?? 0), 0);
}

function tail(text, maxLines = 24, maxChars = 5000) {
  const lines = String(text ?? "").split(/\r?\n/).slice(-maxLines).join("\n");
  return lines.length > maxChars ? lines.slice(lines.length - maxChars) : lines;
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function scoreText(scores) {
  return `install ${scores.installFriction}, scan ${scores.scanSurvivability}, signal ${scores.usefulSignal}, fp ${scores.falsePositivePressure}, fit ${scores.productFit}`;
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || "no detail";
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
