import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const latestRoot = path.join(repoRoot, ".agentdiff", "real-repo-study", "latest");
const resultsPath = path.join(latestRoot, "results.json");
const reportPath = path.join(latestRoot, "action-required-audit.md");
const jsonPath = path.join(latestRoot, "action-required-audit.json");
const maxSampleSize = Number.parseInt(process.env.AGENTDIFF_ACTION_AUDIT_SAMPLE_SIZE ?? "80", 10);

if (!fs.existsSync(resultsPath)) {
  console.error(`Missing ${resultsPath}. Run npm run study:repos first.`);
  process.exit(1);
}

const results = readJson(resultsPath);
const runRoot = results.runRoot ?? "";
const actionRequiredSurfaces = collectActionRequiredSurfaces(results);
const sample = sampleFindings(actionRequiredSurfaces, maxSampleSize);
const entries = sample.map((item, index) => classifyAuditEntry(item, index + 1));
const classificationCounts = countBy(entries, "classification");
const falsePositivePatterns = countFalsePositivePatterns(entries);
const precision = entries.length > 0
  ? Number((((classificationCounts.true_positive_action_required ?? 0) / entries.length) * 100).toFixed(1))
  : 0;

const output = {
  generated_at: new Date().toISOString(),
  source_results: path.relative(repoRoot, resultsPath).replaceAll("\\", "/"),
  run_root: runRoot,
  caveats: [
    "heuristic audit, not a security audit",
    "does not claim external repos are unsafe",
    "does not open PRs, issues, comments, or run external code"
  ],
  total_action_required_surfaces: actionRequiredSurfaces.length,
  sample_size: entries.length,
  estimated_precision_percent: precision,
  classification_counts: classificationCounts,
  top_remaining_false_positive_patterns: Object.entries(falsePositivePatterns)
    .sort((left, right) => right[1] - left[1])
    .map(([pattern, count]) => ({ pattern, count })),
  examples_correctly_still_action_required: entries
    .filter((entry) => entry.classification === "true_positive_action_required")
    .slice(0, 10),
  examples_that_should_downgrade: entries
    .filter((entry) => entry.classification !== "true_positive_action_required")
    .slice(0, 10),
  entries
};

fs.mkdirSync(latestRoot, { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(reportPath, renderMarkdown(output));

console.log(`action-required audit report: ${reportPath}`);
console.log(`action_required surfaces: ${output.total_action_required_surfaces}`);
console.log(`sample size: ${output.sample_size}`);
console.log(`estimated precision: ${output.estimated_precision_percent}%`);
console.log(
  `true/review/context/noise/unclear: ${classificationCounts.true_positive_action_required ?? 0}/${classificationCounts.true_positive_but_review_recommended ?? 0}/${classificationCounts.context_only_should_downgrade ?? 0}/${classificationCounts.likely_noise_should_downgrade ?? 0}/${classificationCounts.unclear ?? 0}`
);

function collectActionRequiredSurfaces(studyResults) {
  const items = [];

  for (const repoResult of studyResults.repos ?? []) {
    if (repoResult.status !== "scanned") continue;
    const mapPath = resolveMapPath(repoResult);
    if (!mapPath || !fs.existsSync(mapPath)) continue;

    let map;
    try {
      map = readJson(mapPath);
    } catch {
      continue;
    }

    for (const surface of map.surfaces ?? []) {
      if (surface.actionability !== "action_required") continue;
      const relativePath = normalizePath(surface.path ?? "");
      const contentInfo = readClonedFile(repoResult.repo, relativePath);
      items.push({
        repo: repoResult.repo,
        path: relativePath,
        shape: shapeForPath(relativePath),
        surface,
        file_exists: contentInfo.exists,
        content_excerpt: excerpt(contentInfo.content),
        content: contentInfo.content,
        sort_key: stableHash(`${repoResult.repo}\0${relativePath}`)
      });
    }
  }

  return items;
}

function resolveMapPath(repoResult) {
  if (repoResult.mapCopyPath) return repoResult.mapCopyPath;
  return path.join(latestRoot, "maps", `${repoResult.repo.replaceAll("/", "__")}.map.json`);
}

function readClonedFile(repo, relativePath) {
  if (!runRoot) return { exists: false, content: "" };
  const filePath = path.join(runRoot, repo.replaceAll("/", "__"), relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { exists: false, content: "" };
  try {
    return { exists: true, content: fs.readFileSync(filePath, "utf8").slice(0, 16000) };
  } catch {
    return { exists: false, content: "" };
  }
}

function sampleFindings(items, limit) {
  const byRepo = new Map();
  for (const item of items) {
    if (!byRepo.has(item.repo)) byRepo.set(item.repo, []);
    byRepo.get(item.repo).push(item);
  }
  for (const repoItems of byRepo.values()) {
    repoItems.sort((left, right) => sortWeight(left) - sortWeight(right) || left.sort_key.localeCompare(right.sort_key));
  }

  const sample = [];
  const seen = new Set();
  for (const repo of [...byRepo.keys()].sort()) {
    const item = byRepo.get(repo)[0];
    addSample(item);
  }

  const priorityShapes = ["frontend/ui", "config/schema/types", "app/api", "server", "src/tools", "src/agents", "packages", "other"];
  while (sample.length < Math.min(limit, items.length)) {
    const shapeCounts = countBy(sample, "shape");
    let added = false;

    for (const shape of [...priorityShapes].sort((left, right) => (shapeCounts[left] ?? 0) - (shapeCounts[right] ?? 0))) {
      const candidates = items.filter((item) => item.shape === shape && !seen.has(sampleKey(item)));
      if (candidates.length === 0) continue;
      const repoCounts = countBy(sample, "repo");
      candidates.sort((left, right) => (repoCounts[left.repo] ?? 0) - (repoCounts[right.repo] ?? 0) || left.sort_key.localeCompare(right.sort_key));
      addSample(candidates[0]);
      added = true;
      break;
    }

    if (!added) break;
  }

  return sample.slice(0, limit);

  function addSample(item) {
    if (!item) return;
    const key = sampleKey(item);
    if (seen.has(key)) return;
    sample.push(item);
    seen.add(key);
  }
}

function classifyAuditEntry(item, index) {
  const normalizedPath = item.path.toLowerCase();
  const normalizedRepo = item.repo.toLowerCase();
  const content = item.content.toLowerCase();
  const surface = item.surface;
  const actionabilityReason = surface.actionability_reason ?? "";
  const result = classifyAuditFinding({ normalizedPath, normalizedRepo, content, surface, actionabilityReason });

  return {
    index,
    repo: item.repo,
    path: item.path,
    shape: item.shape,
    classification: result.classification,
    why: result.why,
    remaining_false_positive_pattern: result.pattern,
    actionability_reason: actionabilityReason,
    surface_label: surface.label,
    surface_category: surface.surface_category,
    reachability_provenance: surface.reachability_provenance,
    reachable_from_entrypoint: Boolean(surface.reachable_from_entrypoint),
    risk: surface.risk ?? [],
    evidence: (surface.evidence ?? []).slice(0, 8),
    content_excerpt: item.content_excerpt,
    file_exists: item.file_exists
  };
}

function classifyAuditFinding({ normalizedPath, normalizedRepo, content, surface, actionabilityReason }) {
  if (isFrontendUiPath(normalizedPath)) {
    return downgrade("context_only_should_downgrade", "frontend/UI context still reached action_required", "frontend_ui_context");
  }

  if (isGeneratedDocsPath(normalizedPath)) {
    return downgrade("likely_noise_should_downgrade", "generated/docs/config data still reached action_required", "generated_docs_context");
  }

  if (isExampleTemplateContext(normalizedPath, normalizedRepo)) {
    return downgrade("true_positive_but_review_recommended", "example/template/course context should usually stay review_recommended", "example_template_context");
  }

  if (isPureTypeOrSchemaPath(normalizedPath) && !hasExecutableToolSyntax(content)) {
    return downgrade("context_only_should_downgrade", "pure type/schema surface lacks executable tool boundary", "config_helper_context");
  }

  if (isGenericServerCrudPath(normalizedPath)) {
    return downgrade("context_only_should_downgrade", "generic server/API route still reached action_required", "generic_server_crud_context");
  }

  if (isSdkConfigHelperPath(normalizedPath) && !hasExecutableToolSyntax(content)) {
    return downgrade("true_positive_but_review_recommended", "SDK/config/helper surface is probably review_recommended, not action_required", "config_helper_context");
  }

  if (actionabilityReason.includes("runtime_tool_execution_context")) {
    return {
      classification: "true_positive_action_required",
      why: "scanner reports runtime tool execution plus side-effect evidence",
      pattern: null
    };
  }

  if (hasRuntimeToolPath(normalizedPath) && hasRuntimeToolContent(content)) {
    return {
      classification: "true_positive_action_required",
      why: "runtime agent/tool path has executable behavior and side-effect signals",
      pattern: null
    };
  }

  if ((surface.risk ?? []).includes("external_side_effect") && hasRuntimeToolPath(normalizedPath)) {
    return {
      classification: "true_positive_action_required",
      why: "runtime tool-like path carries external side-effect risk",
      pattern: null
    };
  }

  return downgrade("unclear", "needs manual follow-up; sampled evidence was not decisive", "unclear_action_required_context");
}

function downgrade(classification, why, pattern) {
  return { classification, why, pattern };
}

function renderMarkdown(output) {
  const counts = output.classification_counts;
  const lines = [
    "# Action Required Audit",
    "",
    "This report samples the latest real-repo study `action_required` bucket to estimate whether the highest-severity findings are still worth treating as urgent.",
    "",
    "Caveats: this is a heuristic audit, not a security audit, not a benchmark, and not a claim that external repos are unsafe. It reads only local study outputs and cloned files from the latest read-only study run.",
    "",
    "## Summary",
    "",
    `- Source: \`${output.source_results}\``,
    `- Action-required surfaces: ${output.total_action_required_surfaces}`,
    `- Sample size: ${output.sample_size}`,
    `- Estimated precision: ${output.estimated_precision_percent}%`,
    `- true_positive_action_required: ${counts.true_positive_action_required ?? 0}`,
    `- true_positive_but_review_recommended: ${counts.true_positive_but_review_recommended ?? 0}`,
    `- context_only_should_downgrade: ${counts.context_only_should_downgrade ?? 0}`,
    `- likely_noise_should_downgrade: ${counts.likely_noise_should_downgrade ?? 0}`,
    `- unclear: ${counts.unclear ?? 0}`,
    "",
    "## Top Remaining False-Positive Patterns",
    ""
  ];

  if (output.top_remaining_false_positive_patterns.length === 0) {
    lines.push("- None found in this sample.");
  } else {
    for (const item of output.top_remaining_false_positive_patterns.slice(0, 8)) {
      lines.push(`- ${item.pattern}: ${item.count}`);
    }
  }

  lines.push("", "## Examples Correctly Still Action Required", "");
  for (const entry of output.examples_correctly_still_action_required.slice(0, 10)) {
    lines.push(`- ${entry.repo} \`${entry.path}\`: ${entry.why}`);
  }
  if (output.examples_correctly_still_action_required.length === 0) lines.push("- None in this sample.");

  lines.push("", "## Examples That Should Downgrade", "");
  for (const entry of output.examples_that_should_downgrade.slice(0, 10)) {
    lines.push(`- ${entry.repo} \`${entry.path}\`: ${entry.classification}; ${entry.why}`);
  }
  if (output.examples_that_should_downgrade.length === 0) lines.push("- None in this sample.");

  lines.push("", "## Sampled Findings", "");
  lines.push("| # | repo | path | classification | why | actionability reason |");
  lines.push("| ---: | --- | --- | --- | --- | --- |");
  for (const entry of output.entries) {
    lines.push(`| ${entry.index} | ${escapeCell(entry.repo)} | \`${escapeCell(entry.path)}\` | ${escapeCell(entry.classification)} | ${escapeCell(entry.why)} | ${escapeCell(entry.actionability_reason)} |`);
  }

  lines.push("", "## Representative Evidence", "");
  for (const entry of output.entries) {
    lines.push(`### ${entry.index}. ${entry.repo} / \`${entry.path}\``);
    lines.push("");
    lines.push(`- Classification: \`${entry.classification}\``);
    lines.push(`- Surface: \`${entry.surface_label}\` / \`${entry.surface_category}\``);
    lines.push(`- Provenance: \`${entry.reachability_provenance}\`; reachable from entrypoint: \`${entry.reachable_from_entrypoint}\``);
    lines.push(`- Risk tags: \`${entry.risk.join(", ")}\``);
    lines.push(`- Actionability reason: ${entry.actionability_reason || "none"}`);
    lines.push(`- Why: ${entry.why}`);
    if (entry.evidence.length > 0) lines.push(`- Scanner evidence: ${escapeCell(entry.evidence.slice(0, 5).join("; "))}`);
    if (entry.content_excerpt) lines.push(`- Content excerpt: \`${escapeCell(entry.content_excerpt.slice(0, 350))}\``);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function shapeForPath(filePath) {
  const normalized = filePath.toLowerCase();
  if (normalized.includes("app/api") || normalized.includes("/api/")) return "app/api";
  if (normalized.startsWith("server/") || normalized.includes("/server/") || normalized.includes("/routes/")) return "server";
  if (normalized.startsWith("src/tools/") || normalized.includes("/tools/") || normalized.endsWith("tools.ts") || normalized.endsWith("tools.js")) return "src/tools";
  if (normalized.startsWith("src/agents/") || normalized.includes("/agents/") || normalized.includes("/agent/") || normalized.split("/").pop()?.includes("agent")) return "src/agents";
  if (normalized.startsWith("packages/") || normalized.includes("/packages/") || normalized.startsWith("libs/") || normalized.includes("/libs/")) return "packages";
  if (isFrontendUiPath(normalized)) return "frontend/ui";
  if (isPureTypeOrSchemaPath(normalized) || normalized.includes("/config/")) return "config/schema/types";
  return "other";
}

function sortWeight(item) {
  const weights = {
    "app/api": 0,
    server: 1,
    "src/tools": 2,
    "src/agents": 3,
    "frontend/ui": 4,
    "config/schema/types": 5,
    packages: 6,
    other: 7
  };
  return weights[item.shape] ?? 99;
}

function isFrontendUiPath(filePath) {
  if (filePath.includes("/app/api/") || filePath.startsWith("app/api/") || filePath.includes("/tools/") || filePath.includes("/mcp")) return false;
  return ["frontend/", "ui/", "renderer/", "components/", "web/src/", "/frontend/", "/ui/", "/renderer/", "/components/", "/web/src/"].some((item) => filePath.includes(item));
}

function isGeneratedDocsPath(filePath) {
  const basename = filePath.split("/").pop() ?? filePath;
  return (
    filePath.includes("/.agentdiff/") ||
    filePath.startsWith(".agentdiff/") ||
    filePath.includes("/.agents/") ||
    filePath.startsWith(".agents/") ||
    basename === "search-index.json" ||
    filePath.includes("/search-index.") ||
    filePath.includes("/web/src/data/") ||
    filePath.includes("/docs/data/") ||
    filePath.includes("/docs-data/") ||
    ((basename.endsWith(".json") || basename.endsWith(".yaml") || basename.endsWith(".yml")) && basename !== "langgraph.json")
  );
}

function isExampleTemplateContext(filePath, repo) {
  return /(^|[/_-])(example|examples|template|starter|workshop|course|demo)([/_-]|$)/.test(filePath) ||
    /(^|[/_-])(example|examples|template|starter|workshop|course|demo)([/_-]|$)/.test(repo);
}

function isPureTypeOrSchemaPath(filePath) {
  return filePath.endsWith("types.ts") || filePath.endsWith("types.js") || filePath.endsWith("schema.ts") || filePath.endsWith("schema.js") || filePath.endsWith(".d.ts") || filePath.includes("/types/") || filePath.includes("/schemas/");
}

function isGenericServerCrudPath(filePath) {
  if (!(filePath.includes("/app/api/") || filePath.startsWith("app/api/") || filePath.includes("/server/") || filePath.startsWith("server/") || filePath.includes("/routes/"))) return false;
  return !["agent", "tool", "workflow", "mastra", "langgraph", "mcp", "github", "gitlab"].some((item) => filePath.includes(item));
}

function isSdkConfigHelperPath(filePath) {
  const basename = filePath.split("/").pop() ?? filePath;
  return ["config", "schema", "types", "session", "constants", "provider", "adapter", "selector", "matcher"].some((item) => basename.includes(item) || filePath.includes(`/${item}s/`) || filePath.includes(`/${item}/`));
}

function hasExecutableToolSyntax(content) {
  return /\b(execute|createTool|defineTool|tool\s*\(|input_schema|type\s*:\s*["']function|function\s*:\s*\{|StateGraph|new Agent|workflow)\b/i.test(content);
}

function hasRuntimeToolPath(filePath) {
  return ["/tools/", "/tool/", "/agents/", "/agent/", "/workflows/", "/workflow/", "mastra", "langgraph", "mcp", "github", "gitlab"].some((item) => filePath.includes(item));
}

function hasRuntimeToolContent(content) {
  return /\b(execute|createTool|defineTool|tool\s*\(|StateGraph|new Agent|workflow|fetch\s*\(|delete|send|charge|refund|close|publish|github|gitlab)\b/i.test(content);
}

function countFalsePositivePatterns(entries) {
  const counts = {};
  for (const entry of entries) {
    if (entry.classification === "true_positive_action_required") continue;
    const pattern = entry.remaining_false_positive_pattern ?? "unknown";
    counts[pattern] = (counts[pattern] ?? 0) + 1;
  }
  return counts;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function stableHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sampleKey(item) {
  return `${item.repo}\0${item.path}`;
}

function excerpt(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .slice(0, 14)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}
