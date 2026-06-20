import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const scriptRepoRoot = path.resolve(here, "..");
const resolvedRepoRoot = fs.existsSync(path.join(repoRoot, "packages")) ? repoRoot : scriptRepoRoot;
const cli = path.join(resolvedRepoRoot, "packages", "cli", "bin", "agentdiff.js");
const outRoot = path.join(resolvedRepoRoot, ".agentdiff", "real-repo-study", "latest");
const mapsRoot = path.join(outRoot, "maps");
const runRoot = path.join(os.tmpdir(), `agentdiff-real-repo-study-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const repos = [
  "langchain-ai/agents-from-scratch-ts",
  "langchain-ai/langgraphjs",
  "langchain-ai/langgraph-101-ts",
  "langchain-ai/agent-inbox-langgraphjs-example",
  "langchain-ai/deepagentsjs",
  "langchain-ai/langchainjs",
  "langchain-ai/open-swe",
  "mastra-ai/mastra",
  "vercel/ai",
  "vercel-labs/github-tools",
  "vercel-labs/lead-agent",
  "cometchat/ai-agent-mastra-examples",
  "openai/openai-agents-js",
  "anthropics/claude-agent-sdk-typescript",
  "VoltAgent/voltagent",
  "i-am-bee/beeai-framework",
  "run-llama/ts-agents",
  "Azure-Samples/azure-typescript-langchainjs",
  "TanStack/ai",
  "inngest/agent-kit",
  "framerslab/agentos",
  "Kong/volcano-agent-sdk",
  "ComposioHQ/composio",
  "mcp-use/mcp-use-ts",
  "twinklejoshi/ai-agent-playwright-typescript-template",
  "agentailor/fullstack-langgraph-nextjs-agent",
  "apify/actor-mastra-mcp-agent",
  "mastra-ai/mastra-agent-course",
  "mastra-ai/template-coding-agent",
  "mastra-ai/template-browsing-agent",
  "wasp-lang/recipe-agent-saas-with-mastra",
  "ataschz/tanstack-start-mastra-example",
  "Strift/nuxt-mastra-starter-kit",
  "Array-Ventures/coworker",
  "tlolkema/ai-mastra-agent-workshop",
  "andrenormanlang/typescript-ai-agent",
  "mayooear/ai-pdf-chatbot-langchain",
  "realyinchen/AgentHub",
  "cacheplane/dawnai",
  "ac12644/langgraph-starter-kit",
  "yu-iskw/llmops-demo-ts",
  "hminle/langserve-assistant-ui",
  "maunappl8/recursive-langgraph-agent",
  "yoda-digital/mcp-gitlab-server",
  "ausboss/mcp-ollama-agent",
  "fkesheh/mcp-ai-agent",
  "corespeed-io/zypher-agent",
  "sudocode-ai/sudocode",
  "decocms/studio",
  "chatbotkit/node-sdk"
];

const all = process.argv.includes("--all");
const start = Number(readOption("--start") ?? 0);
const limit = Number(readOption("--limit") ?? (all ? repos.length : 20));
const maxRepoKb = Number(readOption("--max-repo-kb") ?? 500_000);
const selected = repos.slice(start, start + limit);

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(mapsRoot, { recursive: true });
fs.mkdirSync(runRoot, { recursive: true });

const results = [];
for (const slug of selected) {
  console.log(`\n== ${slug}`);
  results.push(await inspectRepo(slug));
}

const report = {
  startedAt: new Date().toISOString(),
  runRoot,
  configuration: {
    start,
    limit,
    all,
    maxRepoKb,
    installsDependencies: false,
    liveModelCalls: false,
    pushesExternalChanges: false,
    createsExternalPrsIssuesOrComments: false
  },
  repos: results,
  summary: summarize(results),
  topProductFixes: topProductFixes(results)
};

fs.writeFileSync(path.join(outRoot, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(outRoot, "report.md"), `${renderReport(report)}\n`);
console.log(`\nreal repo study report: ${path.join(outRoot, "report.md")}`);
console.log(`scanned/skipped/crashed: ${report.summary.scanned}/${report.summary.skipped}/${report.summary.crashed}`);
console.log(`useful/noisy/missed: ${report.summary.usefulFindings}/${report.summary.noisyFindings}/${report.summary.missedSignals}`);

async function inspectRepo(slug) {
  const result = {
    repo: slug,
    url: `https://github.com/${slug}`,
    status: "pending",
    skipReason: null,
    metadata: await metadata(slug),
    clone: null,
    scan: null,
    stats: {},
    usefulFindings: [],
    noisyFindings: [],
    unclearFindings: [],
    missedSignals: [],
    examples: {
      helped: [],
      uselessOrNoisy: []
    },
    errors: []
  };

  if (result.metadata?.private) return skip(result, "private repository");
  if (result.metadata?.archived) return skip(result, "archived repository");
  if (result.metadata?.error) {
    result.metadataUnavailable = result.metadata.error;
  }
  if (result.metadata?.sizeKb && result.metadata.sizeKb > maxRepoKb) {
    return skip(result, `repo size ${result.metadata.sizeKb}KB exceeds ${maxRepoKb}KB guardrail`);
  }

  const cloneDir = path.join(runRoot, slug.replace(/[\\/]/g, "__"));
  const clone = run("git", ["clone", "--depth=1", `https://github.com/${slug}.git`, cloneDir], runRoot, 240_000);
  result.clone = summarizeStep(clone);
  if (!clone.ok) {
    result.status = "crashed";
    result.errors.push(`clone failed: ${clone.stderrTail || clone.stdoutTail}`);
    return result;
  }

  const mapPath = path.join(cloneDir, ".agentdiff", "map.json");
  const scan = run(process.execPath, [cli, "scan", "--root", ".", "--out", mapPath], cloneDir, 240_000);
  result.scan = summarizeStep(scan);
  if (!scan.ok) {
    result.status = "crashed";
    result.errors.push(`scan failed: ${scan.stderrTail || scan.stdoutTail}`);
    return result;
  }

  const map = readJson(mapPath);
  result.stats = statsFromMapAndOutput(map, scan.stdout);
  const inspected = classifyFindings(map, cloneDir);
  result.usefulFindings = inspected.filter((item) => item.label === "useful");
  result.noisyFindings = inspected.filter((item) => item.label === "noisy");
  result.unclearFindings = inspected.filter((item) => item.label === "unclear");
  result.missedSignals = findMissedSignals(map, cloneDir);
  result.examples.helped = result.usefulFindings.slice(0, 3).map((item) => `${item.path}: ${item.why}`);
  result.examples.uselessOrNoisy = result.noisyFindings.slice(0, 3).map((item) => `${item.path}: ${item.why}`);
  result.mapCopyPath = copyMap(slug, map);
  result.status = "scanned";
  return result;
}

function skip(result, reason) {
  result.status = "skipped";
  result.skipReason = reason;
  return result;
}

async function metadata(slug) {
  try {
    const response = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: { "User-Agent": "agentdiff-real-repo-study", Accept: "application/vnd.github+json" }
    });
    if (!response.ok) return { error: `metadata fetch failed: ${response.status}` };
    const body = await response.json();
    return {
      nameWithOwner: body.full_name,
      cloneUrl: body.clone_url ?? `https://github.com/${slug}.git`,
      defaultBranch: body.default_branch ?? null,
      private: Boolean(body.private),
      archived: Boolean(body.archived),
      sizeKb: Number(body.size ?? 0),
      language: body.language ?? null,
      stars: Number(body.stargazers_count ?? 0),
      pushedAt: body.pushed_at ?? null
    };
  } catch (error) {
    return { error: error.message };
  }
}

function classifyFindings(map, cloneDir) {
  return (map?.surfaces ?? [])
    .filter((surface) => surface.risk?.length || surface.reachable_from_entrypoint || Number(surface.confidence ?? 0) >= 0.7)
    .sort((a, b) => rankSurface(b) - rankSurface(a))
    .slice(0, 8)
    .map((surface) => classifySurface(surface, map, cloneDir));
}

function rankSurface(surface) {
  let score = Number(surface.confidence ?? 0);
  if (surface.reachable_from_entrypoint) score += 5;
  if (surface.risk?.length) score += 3;
  if (surface.label === "tool_implementation") score += 2;
  if (isDocTestConfig(surface.path, surface)) score -= 3;
  return score;
}

function classifySurface(surface, map, cloneDir) {
  const docLike = isDocTestConfig(surface.path, surface);
  const reachable = Boolean(surface.reachable_from_entrypoint);
  const hasRisk = Boolean(surface.risk?.length);
  let label = "unclear";
  if (reachable && hasRisk && !docLike) label = "useful";
  if (!reachable && docLike) label = "noisy";
  const importedBy = importedByFor(map, surface.path);
  const reach = surface.explanation?.reachability_chain ?? surface.reachable_entrypoints ?? [];
  return {
    path: surface.path,
    label,
    category: surface.surface_category,
    surfaceLabel: surface.label,
    risk: surface.risk ?? [],
    confidence: surface.confidence ?? 0,
    reachable,
    reachableFrom: reach,
    importedBy,
    why: whySurfaceMatters({ surface, reachable, docLike, hasRisk }),
    evidence: [
      ...(surface.explanation?.why_flagged ?? []),
      ...(surface.explanation?.risk_evidence ?? surface.evidence ?? [])
    ].slice(0, 8),
    snippet: readSnippet(path.join(cloneDir, surface.path))
  };
}

function whySurfaceMatters({ surface, reachable, docLike, hasRisk }) {
  if (docLike) return "docs/tests/config-like surface; useful as context but likely noisy for action-required reporting";
  if (reachable && hasRisk) return "reachable runtime surface with state mutation or external side-effect evidence";
  if (hasRisk) return "risk evidence exists but reachability is not established";
  return `agent-relevant category ${surface.surface_category ?? surface.label ?? "unknown"} needs stronger call-site evidence`;
}

function findMissedSignals(map, cloneDir) {
  const known = new Set((map?.surfaces ?? []).map((surface) => slash(surface.path)));
  const candidates = collectFiles(cloneDir, 1800, 9_000_000);
  const missed = [];
  for (const file of candidates) {
    const relative = slash(path.relative(cloneDir, file));
    if (known.has(relative)) continue;
    const content = readSmall(file, 160_000);
    if (!content) continue;
    const signals = signalReasons(relative, content);
    if (signals.length === 0) continue;
    missed.push({ path: relative, signals, evidence: snippetForSignals(content, signals) });
    if (missed.length >= 10) break;
  }
  return missed;
}

function signalReasons(relative, content) {
  const reasons = [];
  const lower = relative.toLowerCase();
  if (relative.endsWith("langgraph.json")) reasons.push("LangGraph config");
  if (/mastra\.(config|conf)\.(ts|js|mjs|cjs)$/i.test(relative) || lower.includes("/mastra/")) reasons.push("Mastra config/runtime path");
  if (/\b(tool|createTool|defineTool)\s*\(|\btools\s*:|\bparameters\s*:|\bexecute\s*:/i.test(content)) reasons.push("tool definition syntax");
  if (/type\s*:\s*["']function["']|input_schema\s*:/i.test(content)) reasons.push("OpenAI/Anthropic-style tool schema");
  if (/from\s+["'](?:openai|@openai\/agents|@anthropic-ai\/sdk|ai|@ai-sdk\/[^"']+)["']/i.test(content)) reasons.push("AI SDK import");
  if (/\b(send|refund|charge|delete|close|publish|update|create|approve|reject|revoke|grant|checkpoint|memory)\w*\s*\(/i.test(content)) reasons.push("state-changing/tool-like operation name");
  if (/\b(GitHub|github|email|browser|payment|invoice|customer|checkpoint|memory)\b/i.test(content) && /\bexecute|invoke|call|tool|action\b/i.test(content)) reasons.push("agent operation vocabulary");
  return [...new Set(reasons)].slice(0, 4);
}

function collectFiles(root, maxFiles, maxBytes) {
  const skipDirs = new Set([".git", ".agentdiff", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache", "vendor", "generated"]);
  const exts = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", ".md"]);
  const files = [];
  let bytes = 0;
  const stack = [root];
  while (stack.length && files.length < maxFiles && bytes < maxBytes) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || !exts.has(path.extname(entry.name))) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > 300_000) continue;
      bytes += stat.size;
      files.push(full);
      if (files.length >= maxFiles || bytes >= maxBytes) break;
    }
  }
  return files;
}

function statsFromMapAndOutput(map, stdout) {
  const stats = {
    filesConsidered: numberFromOutput(stdout, "files considered"),
    filesScanned: numberFromOutput(stdout, "scanned files"),
    filesSkipped: numberFromOutput(stdout, "files skipped"),
    bytesRead: numberFromOutput(stdout, "bytes read"),
    entrypointsFound: numberFromOutput(stdout, "entrypoints found"),
    importEdges: numberFromOutput(stdout, "import edges"),
    reachableFiles: numberFromOutput(stdout, "reachable files"),
    aliasImportsResolved: numberFromOutput(stdout, "alias imports resolved"),
    workspaceImportsResolved: numberFromOutput(stdout, "workspace imports resolved"),
    unresolvedNonRelativeImports: numberFromOutput(stdout, "unresolved non-relative imports"),
    unresolvedBuckets: unresolvedBucketsFromMap(map, stdout),
    surfaces: map?.surfaces?.length ?? 0,
    agents: map?.agents?.length ?? 0,
    reachableHighRiskSurfaces: (map?.surfaces ?? []).filter((surface) => surface.reachable_from_entrypoint && surface.risk?.length).length
  };
  return stats;
}

function unresolvedBucketsFromMap(map, stdout = "") {
  const graph = map?.import_graph ?? {};
  const rawBuckets = graph.unresolved_import_buckets ?? {};
  const buckets = {
    external_dependency_like: Number(rawBuckets.external_dependency_like?.count ?? rawBuckets.external_dependency_like ?? numberFromOutput(stdout, "unresolved external_dependency_like")),
    workspace_package_like: Number(rawBuckets.workspace_package_like?.count ?? rawBuckets.workspace_package_like ?? numberFromOutput(stdout, "unresolved workspace_package_like")),
    alias_like: Number(rawBuckets.alias_like?.count ?? rawBuckets.alias_like ?? numberFromOutput(stdout, "unresolved alias_like")),
    unknown: Number(rawBuckets.unknown?.count ?? rawBuckets.unknown ?? numberFromOutput(stdout, "unresolved unknown")),
    samples: []
  };
  const samples = [
    ...Object.values(rawBuckets).flatMap((bucket) => bucket?.samples ?? [])
  ]
    .map(normalizeImportSample)
    .filter(Boolean);
  for (const edge of samples) {
    const bucket = edge.bucket ?? edge.reason_bucket ?? classifyImportSpecifier(edge.specifier ?? "");
    if (!(bucket in buckets)) buckets.unknown += 1;
    if (buckets.samples.length < 8) {
      buckets.samples.push({
        bucket,
        specifier: edge.specifier,
        importing_file: edge.importing_file ?? edge.importingFile ?? edge.from ?? null,
        reason: edge.reason ?? null
      });
    }
  }
  return buckets;
}

function normalizeImportSample(sample) {
  if (!sample) return null;
  if (typeof sample === "string") return { specifier: sample };
  if (!sample.specifier) return null;
  return sample;
}

function classifyImportSpecifier(specifier) {
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) return "alias_like";
  if (/^@[^/]+\/[^/]+/.test(specifier)) return "workspace_package_like";
  if (/^[a-z@]/i.test(specifier)) return "external_dependency_like";
  return "unknown";
}

function summarize(repos) {
  return {
    total: repos.length,
    scanned: repos.filter((repo) => repo.status === "scanned").length,
    skipped: repos.filter((repo) => repo.status === "skipped").length,
    crashed: repos.filter((repo) => repo.status === "crashed").length,
    usefulFindings: sum(repos, (repo) => repo.usefulFindings?.length ?? 0),
    noisyFindings: sum(repos, (repo) => repo.noisyFindings?.length ?? 0),
    unclearFindings: sum(repos, (repo) => repo.unclearFindings?.length ?? 0),
    missedSignals: sum(repos, (repo) => repo.missedSignals?.length ?? 0),
    unresolvedAliasLike: sum(repos, (repo) => repo.stats?.unresolvedBuckets?.alias_like ?? 0),
    unresolvedWorkspaceLike: sum(repos, (repo) => repo.stats?.unresolvedBuckets?.workspace_package_like ?? 0),
    unresolvedExternalLike: sum(repos, (repo) => repo.stats?.unresolvedBuckets?.external_dependency_like ?? 0)
  };
}

function topProductFixes(repos) {
  const fixes = [];
  const aliasRepos = repos.filter((repo) => (repo.stats?.unresolvedBuckets?.alias_like ?? 0) > 0).sort((a, b) => b.stats.unresolvedBuckets.alias_like - a.stats.unresolvedBuckets.alias_like);
  if (aliasRepos.length) fixes.push(`Inspect alias-like unresolved imports in ${aliasRepos.slice(0, 3).map((repo) => `${repo.repo} (${repo.stats.unresolvedBuckets.alias_like})`).join(", ")}.`);
  const missedToolRepos = repos.filter((repo) => repo.missedSignals?.some((signal) => signal.signals.includes("tool definition syntax")));
  if (missedToolRepos.length) fixes.push(`Improve narrow tool-definition detection for missed files in ${missedToolRepos.slice(0, 3).map((repo) => repo.repo).join(", ")}.`);
  const noisyRepos = repos.filter((repo) => repo.noisyFindings?.length);
  if (noisyRepos.length) fixes.push(`Further downrank docs/tests/config findings seen in ${noisyRepos.slice(0, 3).map((repo) => repo.repo).join(", ")}.`);
  const crashed = repos.filter((repo) => repo.status === "crashed");
  if (crashed.length) fixes.push(`Harden clone/scan handling for crashed repos: ${crashed.map((repo) => repo.repo).join(", ")}.`);
  const skippedLarge = repos.filter((repo) => repo.skipReason?.includes("size"));
  if (skippedLarge.length) fixes.push(`Decide whether large repo guardrail should sample instead of skip: ${skippedLarge.slice(0, 3).map((repo) => repo.repo).join(", ")}.`);
  fixes.push("Use real-repo examples to improve explanation wording for reachable high-risk tools.");
  return fixes.slice(0, 5);
}

function renderReport(report) {
  const lines = [];
  lines.push("# Real Repo Study");
  lines.push("");
  lines.push("Read-only static agentdiff study against public agent/tool repos.");
  lines.push("");
  lines.push("Rules followed: no PRs, no issues, no comments, no pushes, no dependency installs, no external agents, no live model/API calls.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`started: ${report.startedAt}`);
  lines.push(`repos: ${report.summary.total}`);
  lines.push(`scanned/skipped/crashed: ${report.summary.scanned}/${report.summary.skipped}/${report.summary.crashed}`);
  lines.push(`useful/noisy/unclear findings: ${report.summary.usefulFindings}/${report.summary.noisyFindings}/${report.summary.unclearFindings}`);
  lines.push(`missed signals: ${report.summary.missedSignals}`);
  lines.push(`unresolved imports alias/workspace/external: ${report.summary.unresolvedAliasLike}/${report.summary.unresolvedWorkspaceLike}/${report.summary.unresolvedExternalLike}`);
  lines.push("");
  lines.push("## Repo Table");
  lines.push("");
  lines.push("| repo | status | default branch | clone URL | size KB | surfaces | reachable high-risk | useful | noisy | missed | unresolved alias/workspace/external | note |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const repo of report.repos) {
    const note = repo.skipReason ?? (repo.metadataUnavailable ? "metadata unavailable" : repo.errors?.[0] ?? "");
    lines.push(
      `| ${repo.repo} | ${repo.status} | ${repo.metadata?.defaultBranch ?? ""} | ${repo.metadata?.cloneUrl ?? repo.url} | ${repo.metadata?.sizeKb ?? ""} | ${repo.stats?.surfaces ?? ""} | ${repo.stats?.reachableHighRiskSurfaces ?? ""} | ${repo.usefulFindings?.length ?? 0} | ${repo.noisyFindings?.length ?? 0} | ${repo.missedSignals?.length ?? 0} | ${(repo.stats?.unresolvedBuckets?.alias_like ?? 0)}/${(repo.stats?.unresolvedBuckets?.workspace_package_like ?? 0)}/${(repo.stats?.unresolvedBuckets?.external_dependency_like ?? 0)} | ${note} |`
    );
  }
  lines.push("");
  lines.push("## Useful Findings");
  lines.push("");
  for (const repo of report.repos.filter((item) => item.usefulFindings?.length)) {
    lines.push(`### ${repo.repo}`);
    for (const finding of repo.usefulFindings.slice(0, 5)) {
      lines.push(`- ${finding.path}: ${finding.why}`);
      if (finding.risk?.length) lines.push(`  risk: ${finding.risk.join(", ")}`);
      if (finding.reachableFrom?.length) lines.push(`  reachable from: ${finding.reachableFrom.slice(0, 3).join(" -> ")}`);
    }
    lines.push("");
  }
  lines.push("## Noisy / Useless Findings");
  lines.push("");
  for (const repo of report.repos.filter((item) => item.noisyFindings?.length)) {
    lines.push(`### ${repo.repo}`);
    for (const finding of repo.noisyFindings.slice(0, 5)) lines.push(`- ${finding.path}: ${finding.why}`);
    lines.push("");
  }
  lines.push("## Missed Signals");
  lines.push("");
  for (const repo of report.repos.filter((item) => item.missedSignals?.length)) {
    lines.push(`### ${repo.repo}`);
    for (const signal of repo.missedSignals.slice(0, 5)) lines.push(`- ${signal.path}: ${signal.signals.join(", ")}`);
    lines.push("");
  }
  lines.push("## Unresolved Import Issues");
  lines.push("");
  for (const repo of report.repos.filter((item) => (item.stats?.unresolvedNonRelativeImports ?? 0) > 0)) {
    const buckets = repo.stats.unresolvedBuckets;
    lines.push(`### ${repo.repo}`);
    lines.push(`alias/workspace/external/unknown: ${buckets.alias_like}/${buckets.workspace_package_like}/${buckets.external_dependency_like}/${buckets.unknown}`);
    for (const sample of buckets.samples.slice(0, 5)) {
      const from = sample.importing_file ? ` from ${sample.importing_file}` : "";
      lines.push(`- ${sample.bucket}: ${sample.specifier}${from}`);
    }
    lines.push("");
  }
  lines.push("## Where Agentdiff Helped");
  lines.push("");
  for (const repo of report.repos.filter((item) => item.examples?.helped?.length)) {
    lines.push(`- ${repo.repo}: ${repo.examples.helped[0]}`);
  }
  lines.push("");
  lines.push("## Where Agentdiff Was Noisy Or Weak");
  lines.push("");
  for (const repo of report.repos.filter((item) => item.status !== "scanned" || item.examples?.uselessOrNoisy?.length || item.missedSignals?.length)) {
    const note = repo.status !== "scanned" ? repo.skipReason ?? (repo.metadataUnavailable ? "metadata unavailable" : repo.errors?.[0]) : repo.examples.uselessOrNoisy?.[0] ?? `${repo.missedSignals.length} missed signal samples`;
    lines.push(`- ${repo.repo}: ${note}`);
  }
  lines.push("");
  lines.push("## Top Product Fixes Suggested");
  lines.push("");
  for (const fix of report.topProductFixes) lines.push(`- ${fix}`);
  lines.push("");
  lines.push("## What This Does Not Prove");
  lines.push("");
  lines.push("- It is not a security audit.");
  lines.push("- It is not a benchmark of model quality.");
  lines.push("- It does not claim external repositories are unsafe.");
  lines.push("- It does not run the target repos, install their dependencies, or execute agents.");
  lines.push("- Useful/noisy labels are heuristic product triage, not maintainer-facing findings.");
  lines.push("");
  return lines.join("\n");
}

function copyMap(slug, map) {
  const target = path.join(mapsRoot, `${slug.replace(/[\\/]/g, "__")}.map.json`);
  fs.writeFileSync(target, `${JSON.stringify(map, null, 2)}\n`);
  return target;
}

function isDocTestConfig(pathName = "", surface = {}) {
  const lowered = slash(pathName).toLowerCase();
  return (
    lowered.endsWith(".md") ||
    lowered.includes("/docs/") ||
    lowered.includes("/test/") ||
    lowered.includes("/tests/") ||
    lowered.includes("/examples/") ||
    lowered.includes("/fixtures/") ||
    lowered.includes(".config.") ||
    surface.surface_category === "docs_example" ||
    surface.surface_category === "test_fixture" ||
    surface.surface_category === "config_metadata"
  );
}

function importedByFor(map, pathName) {
  return (map?.import_graph?.edges ?? []).filter((edge) => edge.to === pathName).map((edge) => edge.from).slice(0, 5);
}

function numberFromOutput(stdout, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stdout.match(new RegExp(`${escaped}:\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

function run(command, args, cwd, timeoutMs) {
  const started = Date.now();
  const child = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024 });
  return {
    command: `${command} ${args.join(" ")}`,
    cwd,
    exitCode: child.status,
    ok: child.status === 0,
    durationMs: Date.now() - started,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    stdoutTail: tail(child.stdout ?? ""),
    stderrTail: tail(child.stderr ?? "")
  };
}

function summarizeStep(step) {
  return {
    command: step.command,
    exitCode: step.exitCode,
    ok: step.ok,
    durationMs: step.durationMs,
    stdoutTail: step.stdoutTail,
    stderrTail: step.stderrTail
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readSmall(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readSnippet(file) {
  const text = readSmall(file, 80_000);
  if (!text) return "";
  return text.split(/\r?\n/).slice(0, 12).join("\n").slice(0, 1200);
}

function snippetForSignals(content, signals) {
  const index = signals.map((signal) => content.toLowerCase().indexOf(signal.split(" ")[0].toLowerCase())).find((item) => item >= 0) ?? 0;
  return content.slice(Math.max(0, index - 200), Math.min(content.length, index + 500));
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function slash(value = "") {
  return value.replace(/\\/g, "/");
}

function tail(value) {
  return String(value).split(/\r?\n/).slice(-20).join("\n").slice(0, 4000);
}

function sum(items, fn) {
  return items.reduce((total, item) => total + fn(item), 0);
}
