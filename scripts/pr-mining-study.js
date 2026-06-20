import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildClassificationReport } from "../packages/core/src/index.js";
import { renderMarkdownReport } from "../packages/report/src/markdown.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outRoot = path.join(repoRoot, ".agentdiff", "pr-mining", "latest");
const runRoot = path.join(os.tmpdir(), `agentdiff-pr-mining-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const seedRepos = readSeedRepos();

const all = process.argv.includes("--all");
const start = Number(readOption("--start") ?? 0);
const limit = Number(readOption("--limit") ?? (all ? seedRepos.length : 20));
const prsPerRepo = Number(readOption("--prs-per-repo") ?? 50);
const maxAnalyzed = Number(readOption("--max-analyzed") ?? 30);
const selectedRepos = seedRepos.slice(start, start + limit);

const candidatePathPattern = /(^|\/)(agents?|tools?|workflows?|mastra|langgraph|mcp|app\/api|server|routes?)(\/|$)|github|gitlab|slack|email|browser|memory|payment|refund|ticket|issue/i;
const riskyWordPattern = /\b(send|post|delete|close|refund|charge|approve|write|execute|shell|browser|submit|email|ticket|issue|memory|database|payment|publish|revoke|grant)\b/i;
const approvalPattern = /\b(approval|human|review|confirmation|confirm|escalat|hitl|policy|permission)\b/i;
const docsOrExamplePathPattern = /(^|\/)(docs?|documentation|examples?|templates?|starters?|workshops?|courses?|notebooks?|fixtures?|tests?|test|testing|__tests__|e2e|dist|build|coverage|ui|frontend|components)(\/|$)|(^|\/)readme\.|\.(test|spec)\.[cm]?[jt]sx?$|\.mdx?$|\.ipynb$/i;

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });
fs.mkdirSync(runRoot, { recursive: true });

const results = {
  startedAt: new Date().toISOString(),
  runRoot,
  configuration: {
    start,
    limit,
    all,
    prsPerRepo,
    maxAnalyzed,
    analysisMethod: "github_api_pr_files_and_head_contents",
    modifiesExternalRepos: false,
    createsExternalPrsIssuesOrComments: false,
    installsDependencies: false,
    liveModelCalls: false,
    runsExternalAgents: false
  },
  repos: [],
  candidates: [],
  analyzed: []
};

const candidateQueue = [];
for (const repo of selectedRepos) {
  console.log(`\n== ${repo}`);
  const repoResult = inspectRepoPrs(repo);
  results.repos.push(repoResult);
  candidateQueue.push(...repoResult.candidates);
}

candidateQueue.sort((left, right) => right.score - left.score);
for (const candidate of candidateQueue.slice(0, maxAnalyzed)) {
  console.log(`analyzing ${candidate.repo}#${candidate.number}`);
  const analyzed = analyzeCandidate(candidate);
  results.analyzed.push(analyzed);
}

results.summary = summarize(results);
results.topDeltas = [...results.analyzed]
  .filter((item) => item.tier !== "D")
  .sort((left, right) => tierRank(left.tier) - tierRank(right.tier) || right.score - left.score)
  .slice(0, 10);

fs.writeFileSync(path.join(outRoot, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
fs.writeFileSync(path.join(outRoot, "report.md"), renderReport(results));

console.log(`\npr mining report: ${path.join(outRoot, "report.md")}`);
console.log(`repos inspected: ${results.summary.reposInspected}`);
console.log(`PRs inspected: ${results.summary.prsInspected}`);
console.log(`candidate PRs analyzed: ${results.summary.candidatePrsAnalyzed}`);
console.log(`A/B/C/D: ${results.summary.tierCounts.A}/${results.summary.tierCounts.B}/${results.summary.tierCounts.C}/${results.summary.tierCounts.D}`);

function inspectRepoPrs(repo) {
  const result = {
    repo,
    status: "ok",
    prsInspected: 0,
    mergedPrsInspected: 0,
    candidates: [],
    errors: []
  };

  const pulls = ghJson(`repos/${repo}/pulls?state=closed&per_page=${Math.min(100, prsPerRepo)}&sort=updated&direction=desc`);
  if (!Array.isArray(pulls)) {
    result.status = "api_error";
    result.errors.push("pull list unavailable");
    return result;
  }

  for (const pr of pulls.slice(0, prsPerRepo)) {
    result.prsInspected += 1;
    if (!pr.merged_at) continue;
    result.mergedPrsInspected += 1;

    const files = ghJson(`repos/${repo}/pulls/${pr.number}/files?per_page=100`);
    if (!Array.isArray(files)) {
      result.errors.push(`files unavailable for #${pr.number}`);
      continue;
    }

    const matchingFiles = files.filter((file) => isCandidateFile(file));
    if (matchingFiles.length === 0) continue;

    const score = scoreCandidate({ pr, files: matchingFiles });
    const candidate = {
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      mergedAt: pr.merged_at,
      baseSha: pr.base?.sha,
      headSha: pr.head?.sha,
      changedFiles: matchingFiles.map((file) => file.filename),
      score,
      files: matchingFiles.map((file) => ({
        filename: file.filename,
        status: file.status,
        patch: file.patch ?? "",
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes
      }))
    };
    result.candidates.push(candidate);
    results.candidates.push({
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      changedFiles: candidate.changedFiles,
      score
    });
  }

  return result;
}

function analyzeCandidate(candidate) {
  const files = [];
  for (const file of candidate.files) {
    if (file.status === "removed") continue;
    const content = readHeadContent(candidate.repo, file.filename, candidate.headSha);
    files.push({
      filePath: file.filename,
      content,
      diffText: file.patch ? `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n` : ""
    });
  }

  let report;
  try {
    report = buildClassificationReport({
      repo: candidate.repo,
      files
    });
  } catch (error) {
    return {
      ...candidateSummary(candidate),
      status: "analysis_error",
      tier: "D",
      score: candidate.score,
      error: error.message
    };
  }

  const markdown = renderMarkdownReport(report);
  const findings = [...(report.diff_aware_findings ?? []), ...(report.map_drift ?? [])];
  const summary = summarizeFindings(findings);
  const tier = tierFor({ candidate, report, findings, summary });
  const whyInteresting = whyInterestingFor({ tier, candidate, report, findings, summary });

  return {
    ...candidateSummary(candidate),
    status: report.status,
    tier,
    score: candidate.score + tierScore(tier),
    actionabilityCounts: countBy(findings.map((finding) => actionabilityForFinding(finding))),
    findingSummary: summary,
    whyInteresting,
    notVulnerabilityClaim: "This is a behavior-delta signal from a public PR diff, not a vulnerability claim and not a judgment on the project.",
    reportExcerpt: markdown.split(/\r?\n/).slice(0, 80).join("\n")
  };
}

function isCandidateFile(file) {
  const haystack = `${file.filename}\n${file.patch ?? ""}`;
  return candidatePathPattern.test(file.filename) || riskyWordPattern.test(haystack) || approvalPattern.test(haystack);
}

function scoreCandidate({ pr, files }) {
  let score = 0;
  for (const file of files) {
    if (candidatePathPattern.test(file.filename)) score += 5;
    if (riskyWordPattern.test(`${file.filename}\n${file.patch ?? ""}`)) score += 4;
    if (approvalPattern.test(`${pr.title}\n${file.patch ?? ""}`)) score += 3;
    if (/mcp|github|gitlab|email|refund|charge|payment|browser|memory/i.test(file.filename)) score += 3;
    if (isRuntimeBehaviorPath(file.filename)) score += 4;
    if (isDocsOrExamplePath(file.filename)) score -= 3;
  }
  if (/agent|tool|workflow|mcp|refund|email|issue|memory|browser/i.test(pr.title ?? "")) score += 4;
  return score;
}

function readHeadContent(repo, filePath, ref) {
  if (!ref) return "";
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  const data = ghJson(`repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, { silent: true });
  if (!data || Array.isArray(data) || data.encoding !== "base64" || typeof data.content !== "string") return "";
  try {
    return Buffer.from(data.content.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function summarizeFindings(findings) {
  return findings.map((finding) => ({
    title: finding.title ?? finding.path,
    path: finding.path,
    type: finding.finding_type,
    severity: finding.severity,
    actionability: actionabilityForFinding(finding),
    runtimePath: isRuntimeBehaviorPath(finding.path ?? ""),
    docsOrExamplePath: isDocsOrExamplePath(finding.path ?? ""),
    addedHighRiskCalls: finding.added_high_risk_calls ?? [],
    removedSaferCalls: finding.removed_safer_calls ?? [],
    risk: finding.risk ?? [],
    evidence: (finding.evidence ?? []).slice(0, 5)
  })).sort((left, right) => {
    if (left.runtimePath !== right.runtimePath) return left.runtimePath ? -1 : 1;
    if (left.docsOrExamplePath !== right.docsOrExamplePath) return left.docsOrExamplePath ? 1 : -1;
    return actionabilityRank(left.actionability) - actionabilityRank(right.actionability);
  });
}

function tierFor({ candidate, report, findings, summary }) {
  const runtimeSummaries = summary.filter((finding) => isRuntimeBehaviorPath(finding.path ?? ""));
  const hasHighRiskAdded = summary.some((finding) => (finding.addedHighRiskCalls ?? []).length > 0);
  const hasRuntimeHighRiskAdded = runtimeSummaries.some((finding) => (finding.addedHighRiskCalls ?? []).length > 0);
  const hasApprovalChange = approvalPattern.test(JSON.stringify(candidate.files));
  const hasMemoryPersistence = /memory|store|checkpoint|database|db|write/i.test(candidate.changedFiles.join("\n"));
  const actionRequired = findings.some((finding) => actionabilityForFinding(finding) === "action_required") || report.status === "action_required";
  const runtimeActionRequired = summary.some((finding) => finding.actionability === "action_required" && isRuntimeBehaviorPath(finding.path ?? ""));
  const reviewRecommended = findings.some((finding) => actionabilityForFinding(finding) === "review_recommended");
  const runtimeReviewRecommended = summary.some((finding) => finding.actionability === "review_recommended" && isRuntimeBehaviorPath(finding.path ?? ""));

  if (runtimeActionRequired && hasRuntimeHighRiskAdded) return "A";
  if (runtimeActionRequired && (hasApprovalChange || hasMemoryPersistence || candidate.changedFiles.some(isRuntimeBehaviorPath))) return "B";
  if (runtimeReviewRecommended && (hasHighRiskAdded || hasApprovalChange || hasMemoryPersistence)) return "B";
  if (actionRequired && summary.some((finding) => isDocsOrExamplePath(finding.path ?? ""))) return "C";
  if (reviewRecommended && hasHighRiskAdded) return "C";
  if (findings.some((finding) => actionabilityForFinding(finding) === "context_only")) return "C";
  return "D";
}

function whyInterestingFor({ tier, candidate, findings, summary }) {
  if (tier === "A") {
    const added = summary
      .filter((finding) => finding.runtimePath)
      .flatMap((finding) => finding.addedHighRiskCalls ?? []);
    return `Real merged PR diff touched agent/tool/API-like files and agentdiff found action-required side-effect behavior${added.length ? `: ${[...new Set(added)].join(", ")}` : ""}.`;
  }
  if (tier === "B") {
    return "Real merged PR diff changed reviewable agent/tool behavior such as approval, tool schema, memory, persistence, or permissions.";
  }
  if (tier === "C") {
    return "Real merged PR diff produced context-only agentdiff signal that may be useful as non-urgent background.";
  }
  const paths = candidate.changedFiles.slice(0, 3).join(", ");
  return `Candidate changed ${paths}, but agentdiff did not produce a strong behavior-delta signal.`;
}

function candidateSummary(candidate) {
  return {
    repo: candidate.repo,
    pr: candidate.number,
    title: candidate.title,
    url: candidate.url,
    mergedAt: candidate.mergedAt,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    changedFiles: candidate.changedFiles
  };
}

function summarize(result) {
  const tierCounts = countBy(result.analyzed.map((item) => item.tier));
  return {
    reposInspected: result.repos.length,
    prsInspected: sum(result.repos, (repo) => repo.prsInspected),
    mergedPrsInspected: sum(result.repos, (repo) => repo.mergedPrsInspected),
    candidatePrsFound: result.candidates.length,
    candidatePrsAnalyzed: result.analyzed.length,
    tierCounts: {
      A: tierCounts.A ?? 0,
      B: tierCounts.B ?? 0,
      C: tierCounts.C ?? 0,
      D: tierCounts.D ?? 0
    }
  };
}

function renderReport(result) {
  const lines = [];
  lines.push("# Public PR Mining Study");
  lines.push("");
  lines.push("Read-only scan of merged public PR diffs from the real-repo study seed list.");
  lines.push("");
  lines.push("Rules followed: no external PRs, issues, comments, pushes, dependency installs, live model calls, or external agent execution.");
  lines.push("");
  lines.push("This is internal validation for behavior deltas. It is not a security audit, not a vulnerability report, and not a claim that external repos are unsafe.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`repos inspected: ${result.summary.reposInspected}`);
  lines.push(`PRs inspected: ${result.summary.prsInspected}`);
  lines.push(`merged PRs inspected: ${result.summary.mergedPrsInspected}`);
  lines.push(`candidate PRs found: ${result.summary.candidatePrsFound}`);
  lines.push(`candidate PRs analyzed: ${result.summary.candidatePrsAnalyzed}`);
  lines.push(`A/B/C/D: ${result.summary.tierCounts.A}/${result.summary.tierCounts.B}/${result.summary.tierCounts.C}/${result.summary.tierCounts.D}`);
  lines.push("");
  lines.push("## Top Real PR Behavior Deltas");
  lines.push("");

  if (result.topDeltas.length === 0) {
    lines.push("No A/B/C-tier behavior deltas found in this run.");
    lines.push("");
  } else {
    for (const item of result.topDeltas) {
      lines.push(`### ${item.tier}-tier: ${item.repo}#${item.pr} - ${item.title}`);
      lines.push("");
      lines.push(`URL: ${item.url}`);
      lines.push(`base SHA: ${item.baseSha ?? "unknown"}`);
      lines.push(`head SHA: ${item.headSha ?? "unknown"}`);
      lines.push(`changed files: ${item.changedFiles.slice(0, 8).join(", ")}`);
      lines.push(`agentdiff status: ${item.status}`);
      lines.push(`why interesting: ${item.whyInteresting}`);
      lines.push(`not a vulnerability claim: ${item.notVulnerabilityClaim}`);
      lines.push("");
      lines.push("finding summary:");
      for (const finding of item.findingSummary.slice(0, 5)) {
        lines.push(`- ${finding.actionability}/${finding.severity}: ${finding.title} (${finding.path})`);
        if (finding.addedHighRiskCalls.length > 0) lines.push(`  added high-risk calls: ${finding.addedHighRiskCalls.join(", ")}`);
        if (finding.removedSaferCalls.length > 0) lines.push(`  removed safer calls: ${finding.removedSaferCalls.join(", ")}`);
      }
      lines.push("");
    }
  }

  lines.push("## False Positives / Weak Examples");
  lines.push("");
  for (const item of result.analyzed.filter((entry) => entry.tier === "D").slice(0, 10)) {
    lines.push(`- ${item.repo}#${item.pr}: ${item.title}`);
    lines.push(`  reason: ${item.whyInteresting}`);
  }
  lines.push("");
  lines.push("## Recommended Product Fixes");
  lines.push("");
  lines.push("- Prefer small app repos and agent products over giant SDK/framework repos when looking for concrete behavior deltas.");
  lines.push("- Improve ranking for PR diffs where tool schemas change but function-call names do not.");
  lines.push("- Add a future manual label pass if this study finds recurring A/B-tier examples.");
  lines.push("");
  lines.push("## Repo Table");
  lines.push("");
  lines.push("| repo | status | PRs inspected | merged PRs | candidates | errors |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- |");
  for (const repo of result.repos) {
    lines.push(`| ${repo.repo} | ${repo.status} | ${repo.prsInspected} | ${repo.mergedPrsInspected} | ${repo.candidates.length} | ${(repo.errors ?? []).join("; ")} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function actionabilityForFinding(finding) {
  if (["action_required", "review_recommended", "context_only", "likely_noise"].includes(finding.actionability)) return finding.actionability;
  if (finding.severity === "critical" || finding.severity === "high") return "action_required";
  if (finding.severity === "medium") return "review_recommended";
  return "context_only";
}

function isDocsOrExamplePath(filePath) {
  return docsOrExamplePathPattern.test(filePath);
}

function isRuntimeBehaviorPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (isDocsOrExamplePath(normalized)) return false;
  if (/(^|\/)(app\/api|server|routes?|agents?|tools?|workflows?|mastra|langgraph|mcp)(\/|$)/i.test(normalized)) return true;
  if (/(^|\/)agent\//i.test(normalized)) return true;
  if (/packages\/[^/]+\/src\//i.test(normalized) && /tools?|agents?|workflows?|mcp|github|gitlab|slack|email|browser|memory|payment|refund|ticket|issue/i.test(normalized)) return true;
  if (/apps\/[^/]+\/server\//i.test(normalized)) return true;
  if (/python\/(?!tests?\/)/i.test(normalized) && /agents?|tools?|workflows?|mcp|adapters?/i.test(normalized)) return true;
  if (/(^|\/)src\//i.test(normalized) && /agents?|tools?|workflows?|mcp|github|gitlab|slack|email|browser|memory|payment|refund|ticket|issue/i.test(normalized)) return true;
  return false;
}

function actionabilityRank(actionability) {
  return {
    action_required: 0,
    review_recommended: 1,
    context_only: 2,
    likely_noise: 3
  }[actionability] ?? 9;
}

function ghJson(endpoint, { silent = false } = {}) {
  const result = spawnSync("gh", ["api", endpoint], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    if (!silent) console.warn(`gh api failed for ${endpoint}: ${result.stderr.trim()}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    if (!silent) console.warn(`gh api returned invalid JSON for ${endpoint}`);
    return null;
  }
}

function readSeedRepos() {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "real-repo-study.js"), "utf8");
  const match = source.match(/const repos = \[([\s\S]*?)\];/);
  if (!match) throw new Error("could not read seed repo list from scripts/real-repo-study.js");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function countBy(items) {
  return items.reduce((counts, item) => {
    counts[item] = (counts[item] ?? 0) + 1;
    return counts;
  }, {});
}

function sum(items, selector) {
  return items.reduce((total, item) => total + Number(selector(item) ?? 0), 0);
}

function tierRank(tier) {
  return { A: 0, B: 1, C: 2, D: 3 }[tier] ?? 9;
}

function tierScore(tier) {
  return { A: 1000, B: 500, C: 100, D: 0 }[tier] ?? 0;
}
