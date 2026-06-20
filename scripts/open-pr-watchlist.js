import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildClassificationReport } from "../packages/core/src/index.js";
import { renderMarkdownReport } from "../packages/report/src/markdown.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outRoot = path.join(repoRoot, ".agentdiff", "open-pr-watchlist", "latest");
const runRoot = path.join(os.tmpdir(), `agentdiff-open-pr-watchlist-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const seedRepos = readSeedRepos();

const all = process.argv.includes("--all");
const start = Number(readOption("--start") ?? 0);
const limit = Number(readOption("--limit") ?? (all ? seedRepos.length : 20));
const prsPerRepo = Number(readOption("--prs-per-repo") ?? 50);
const maxAnalyzed = Number(readOption("--max-analyzed") ?? 40);
const selectedRepos = seedRepos.slice(start, start + limit);

const candidatePathPattern = /(^|\/)(agents?|tools?|workflows?|mastra|langgraph|mcp|app\/api|server|routes?)(\/|$)|github|gitlab|slack|email|browser|memory|payment|refund|ticket|issue/i;
const candidateTextPattern = /\b(agent|agents|tool|tools|workflow|workflows|mastra|langgraph|mcp|github|gitlab|slack|email|browser|memory|payment|refund|ticket|issue|approval|human-in-the-loop|hitl)\b|app\/api|server|routes?/i;
const riskyWordPattern = /\b(send|post|delete|close|refund|charge|approve|write|execute|shell|browser|submit|email|ticket|issue|memory|database|payment|publish|revoke|grant|trigger|cancel|rerun|create|update)\b/i;
const approvalPattern = /\b(approval|human|review|confirmation|confirm|escalat|hitl|policy|permission|guardrail|manual)\b|human-in-the-loop/i;
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
    analysisMethod: "github_api_open_pr_files_and_head_contents",
    modifiesExternalRepos: false,
    createsExternalPrsIssuesOrComments: false,
    contactsMaintainers: false,
    installsDependencies: false,
    liveModelCalls: false,
    runsExternalAgents: false,
    automaticCommenting: false
  },
  repos: [],
  candidates: [],
  analyzed: []
};

const candidateQueue = [];
for (const repo of selectedRepos) {
  console.log(`\n== ${repo}`);
  const repoResult = inspectRepoOpenPrs(repo);
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
results.topCandidates = [...results.analyzed]
  .filter((item) => item.tier !== "D")
  .sort((left, right) => tierRank(left.tier) - tierRank(right.tier) || commentRank(left.whetherToComment) - commentRank(right.whetherToComment) || right.score - left.score)
  .slice(0, 15);

fs.writeFileSync(path.join(outRoot, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
fs.writeFileSync(path.join(outRoot, "report.md"), renderReport(results));

console.log(`\nopen PR watchlist report: ${path.join(outRoot, "report.md")}`);
console.log(`repos inspected: ${results.summary.reposInspected}`);
console.log(`open PRs inspected: ${results.summary.openPrsInspected}`);
console.log(`candidate PRs analyzed: ${results.summary.candidatePrsAnalyzed}`);
console.log(`A/B/C/D: ${results.summary.tierCounts.A}/${results.summary.tierCounts.B}/${results.summary.tierCounts.C}/${results.summary.tierCounts.D}`);
console.log(`comment yes/maybe/no: ${results.summary.commentCounts.yes}/${results.summary.commentCounts.maybe}/${results.summary.commentCounts.no}`);

function inspectRepoOpenPrs(repo) {
  const result = {
    repo,
    status: "ok",
    openPrsInspected: 0,
    candidates: [],
    errors: []
  };

  const pulls = ghJson(`repos/${repo}/pulls?state=open&per_page=${Math.min(100, prsPerRepo)}&sort=updated&direction=desc`);
  if (!Array.isArray(pulls)) {
    result.status = "api_error";
    result.errors.push("open pull list unavailable");
    return result;
  }

  for (const pr of pulls.slice(0, prsPerRepo)) {
    result.openPrsInspected += 1;

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
      body: pr.body ?? "",
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
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
      confidence: "low",
      whetherToComment: "no",
      behaviorDeltaSummary: "Agentdiff analysis failed for this open PR candidate.",
      suggestedHumanComment: "",
      whyBehaviorDeltaOnly: "No manual comment should be drafted from a failed analysis.",
      error: error.message
    };
  }

  const markdown = renderMarkdownReport(report);
  const findings = [...(report.diff_aware_findings ?? []), ...(report.map_drift ?? [])];
  const summary = summarizeFindings(findings);
  const tier = tierFor({ candidate, report, findings, summary });
  const behaviorDeltaSummary = behaviorSummaryFor({ tier, candidate, summary });
  const confidence = confidenceFor({ tier, summary });
  const whetherToComment = whetherToCommentFor({ tier, confidence, summary, candidate });
  const suggestedHumanComment = draftCommentFor({ candidate, summary, tier, whetherToComment });

  return {
    ...candidateSummary(candidate),
    status: report.status,
    tier,
    score: candidate.score + tierScore(tier),
    confidence,
    whetherToComment,
    actionabilityCounts: countBy(findings.map((finding) => actionabilityForFinding(finding))),
    findingSummary: summary,
    behaviorDeltaSummary,
    whyBehaviorDeltaOnly: "This is only a manual behavior-delta note for review. It does not judge whether the PR is correct or should merge.",
    suggestedHumanComment,
    reportExcerpt: markdown.split(/\r?\n/).slice(0, 80).join("\n")
  };
}

function isCandidateFile(file) {
  const haystack = `${file.filename}\n${file.patch ?? ""}`;
  return candidatePathPattern.test(file.filename) || candidateTextPattern.test(haystack) || riskyWordPattern.test(haystack) || approvalPattern.test(haystack);
}

function scoreCandidate({ pr, files }) {
  let score = 0;
  for (const file of files) {
    const haystack = `${file.filename}\n${file.patch ?? ""}`;
    if (candidatePathPattern.test(file.filename)) score += 5;
    if (candidateTextPattern.test(haystack)) score += 3;
    if (riskyWordPattern.test(haystack)) score += 4;
    if (approvalPattern.test(`${pr.title}\n${haystack}`)) score += 3;
    if (/mcp|github|gitlab|slack|email|refund|charge|payment|browser|memory|ticket|issue/i.test(file.filename)) score += 3;
    if (isRuntimeBehaviorPath(file.filename)) score += 4;
    if (isDocsOrExamplePath(file.filename)) score -= 3;
  }
  if (/agent|tool|workflow|mcp|refund|email|issue|memory|browser|approval|hitl/i.test(pr.title ?? "")) score += 4;
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

function behaviorSummaryFor({ tier, candidate, summary }) {
  const runtimeFindings = summary.filter((finding) => finding.runtimePath);
  const allAdded = unique(runtimeFindings.flatMap((finding) => finding.addedHighRiskCalls ?? []));
  const added = specificCapabilityCalls(runtimeFindings);
  const removed = unique(runtimeFindings.flatMap((finding) => finding.removedSaferCalls ?? []));
  const paths = unique(runtimeFindings.map((finding) => finding.path).filter(Boolean));

  if (tier === "A") {
    const parts = [];
    if (added.length > 0) parts.push(`added/changed ${added.slice(0, 6).join(", ")}`);
    else if (allAdded.length > 0) parts.push(`generic state/action calls ${allAdded.slice(0, 4).join(", ")}`);
    if (removed.length > 0) parts.push(`removed/changed ${removed.slice(0, 4).join(", ")}`);
    if (paths.length > 0) parts.push(`in ${paths.slice(0, 3).join(", ")}`);
    return `Concrete runtime agent/tool/API behavior delta${parts.length ? `: ${parts.join("; ")}` : ""}.`;
  }
  if (tier === "B") {
    return "Likely meaningful agent/tool/schema/approval/memory behavior change worth manual inspection.";
  }
  if (tier === "C") {
    return "Context-only signal in docs, examples, tests, or supporting files; inspect only if it is already relevant.";
  }
  return `Weak candidate from ${candidate.changedFiles.slice(0, 3).join(", ")}; no strong behavior-delta signal.`;
}

function confidenceFor({ tier, summary }) {
  if (tier === "A" && specificCapabilityCalls(summary.filter((finding) => finding.runtimePath)).length > 0) return "high";
  if (tier === "A" || tier === "B") return "medium";
  return "low";
}

function whetherToCommentFor({ tier, confidence, summary, candidate }) {
  const hasSpecificCapability = specificCapabilityCalls(summary.filter((finding) => finding.runtimePath)).length > 0;
  const isDraftLike = /\b(wip|draft)\b|\[wip\]|\(wip\)/i.test(candidate.title ?? "");
  if (tier === "A" && confidence === "high" && hasSpecificCapability && !isDraftLike) return "yes";
  if (tier === "A" || tier === "B") return "maybe";
  return "no";
}

function draftCommentFor({ candidate, summary, tier, whetherToComment }) {
  if (whetherToComment === "no") return "";
  const runtimeFindings = summary.filter((finding) => finding.runtimePath);
  const specificAdded = specificCapabilityCalls(runtimeFindings).slice(0, 4);
  const added = specificAdded.length > 0 ? specificAdded : unique(runtimeFindings.flatMap((finding) => finding.addedHighRiskCalls ?? [])).slice(0, 4);
  const removed = unique(runtimeFindings.flatMap((finding) => finding.removedSaferCalls ?? [])).slice(0, 3);
  const capabilities = [];
  if (added.length > 0) capabilities.push(...added.map((item) => `added/changed \`${item}\``));
  if (removed.length > 0) capabilities.push(...removed.map((item) => `removed/changed \`${item}\``));
  for (const path of unique(runtimeFindings.map((finding) => finding.path).filter(Boolean)).slice(0, 3)) {
    if (capabilities.length >= 4) break;
    capabilities.push(`runtime surface \`${path}\``);
  }
  if (capabilities.length === 0) capabilities.push(...candidate.changedFiles.slice(0, 3).map((file) => `changed \`${file}\``));

  const bullets = capabilities.slice(0, 4).map((item) => `* ${item}`).join("\n");
  const lead = tier === "A" ? "one behavior delta I noticed while reading this PR" : "one possible behavior delta I noticed while reading this PR";
  return `Hey - ${lead}:\n\n\`${behaviorSummaryFor({ tier, candidate, summary }).replace(/`/g, "'")}\`\n\nFor example, this appears to add/change:\n\n${bullets}\n\nThis may be fully intentional. I am not flagging it as a bug. It just seems like the kind of agent capability change that is worth making explicit in review, because normal CI will mostly tell you whether the code still runs, not what the agent can now do.\n\nI am building a small open-source CI check for this kind of agent behavior diff, so I am trying it manually on public PRs before automating anything.`;
}

function candidateSummary(candidate) {
  return {
    repo: candidate.repo,
    pr: candidate.number,
    title: candidate.title,
    url: candidate.url,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    changedFiles: candidate.changedFiles
  };
}

function summarize(result) {
  const tierCounts = countBy(result.analyzed.map((item) => item.tier));
  const commentCounts = countBy(result.analyzed.map((item) => item.whetherToComment));
  return {
    reposInspected: result.repos.length,
    openPrsInspected: sum(result.repos, (repo) => repo.openPrsInspected),
    candidatePrsFound: result.candidates.length,
    candidatePrsAnalyzed: result.analyzed.length,
    tierCounts: {
      A: tierCounts.A ?? 0,
      B: tierCounts.B ?? 0,
      C: tierCounts.C ?? 0,
      D: tierCounts.D ?? 0
    },
    commentCounts: {
      yes: commentCounts.yes ?? 0,
      maybe: commentCounts.maybe ?? 0,
      no: commentCounts.no ?? 0
    }
  };
}

function renderReport(result) {
  const lines = [];
  lines.push("# Open PR Behavior Delta Watchlist");
  lines.push("");
  lines.push("Read-only queue of currently open public PRs that may contain concrete agent behavior or capability changes worth manual review.");
  lines.push("");
  lines.push("Rules followed: no external PRs, issues, comments, pushes, dependency installs, live model calls, external agent execution, or automated commenting.");
  lines.push("");
  lines.push("This is a manual review queue only. It does not judge whether a PR is correct or should merge.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`repos inspected: ${result.summary.reposInspected}`);
  lines.push(`open PRs inspected: ${result.summary.openPrsInspected}`);
  lines.push(`candidate PRs found: ${result.summary.candidatePrsFound}`);
  lines.push(`candidate PRs analyzed: ${result.summary.candidatePrsAnalyzed}`);
  lines.push(`A/B/C/D: ${result.summary.tierCounts.A}/${result.summary.tierCounts.B}/${result.summary.tierCounts.C}/${result.summary.tierCounts.D}`);
  lines.push(`comment yes/maybe/no: ${result.summary.commentCounts.yes}/${result.summary.commentCounts.maybe}/${result.summary.commentCounts.no}`);
  lines.push("");
  lines.push("## Top Manual Review Candidates");
  lines.push("");

  if (result.topCandidates.length === 0) {
    lines.push("No A/B/C-tier open PR candidates found in this run.");
    lines.push("");
  } else {
    for (const item of result.topCandidates) {
      lines.push(`### ${item.tier}-tier: ${item.repo}#${item.pr} - ${item.title}`);
      lines.push("");
      lines.push(`URL: ${item.url}`);
      lines.push(`created: ${item.createdAt ?? "unknown"}`);
      lines.push(`updated: ${item.updatedAt ?? "unknown"}`);
      lines.push(`base SHA: ${item.baseSha ?? "unknown"}`);
      lines.push(`head SHA: ${item.headSha ?? "unknown"}`);
      lines.push(`changed files: ${item.changedFiles.slice(0, 8).join(", ")}`);
      lines.push(`agentdiff status: ${item.status}`);
      lines.push(`behavior delta summary: ${item.behaviorDeltaSummary}`);
      lines.push(`confidence: ${item.confidence}`);
      lines.push(`whether to comment: ${item.whetherToComment}`);
      lines.push(`why this is only a behavior-delta note: ${item.whyBehaviorDeltaOnly}`);
      lines.push("");
      lines.push("finding summary:");
      for (const finding of item.findingSummary.slice(0, 5)) {
        lines.push(`- ${finding.actionability}/${finding.severity}: ${finding.title} (${finding.path})`);
        if (finding.addedHighRiskCalls.length > 0) lines.push(`  added high-risk calls: ${finding.addedHighRiskCalls.join(", ")}`);
        if (finding.removedSaferCalls.length > 0) lines.push(`  removed safer calls: ${finding.removedSaferCalls.join(", ")}`);
      }
      if (item.suggestedHumanComment) {
        lines.push("");
        lines.push("suggested human comment draft:");
        lines.push("");
        lines.push("```txt");
        lines.push(item.suggestedHumanComment);
        lines.push("```");
      }
      lines.push("");
    }
  }

  lines.push("## Weak / No-Comment Candidates");
  lines.push("");
  for (const item of result.analyzed.filter((entry) => entry.whetherToComment === "no").slice(0, 10)) {
    lines.push(`- ${item.repo}#${item.pr}: ${item.title}`);
    lines.push(`  reason: ${item.behaviorDeltaSummary}`);
  }
  lines.push("");
  lines.push("## Repo Table");
  lines.push("");
  lines.push("| repo | status | open PRs inspected | candidates | errors |");
  lines.push("| --- | --- | ---: | ---: | --- |");
  for (const repo of result.repos) {
    lines.push(`| ${repo.repo} | ${repo.status} | ${repo.openPrsInspected} | ${repo.candidates.length} | ${(repo.errors ?? []).join("; ")} |`);
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

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function specificCapabilityCalls(findings) {
  return unique(findings.flatMap((finding) => finding.addedHighRiskCalls ?? []).filter(isSpecificCapabilityCall));
}

function isSpecificCapabilityCall(callName) {
  const normalized = String(callName ?? "");
  if (!normalized) return false;
  if (/^(update|delete|close|send|reject|approve|create|publish|write|post|submit|trigger|cancel|rerun|grant|revoke|set|get|map)$/i.test(normalized)) return false;
  return /refund|charge|invoice|payment|email|slack|github|gitlab|gist|issue|ticket|workflow|memory|heartbeat|schedule|rate|tool|approval|approve|label|review|comment|file|pull|branch|run|thread|session|browser|form|submit|close[A-Z]|delete[A-Z]|update[A-Z]|send[A-Z]|create[A-Z]|trigger[A-Z]|cancel[A-Z]|rerun[A-Z]/.test(normalized);
}
function tierRank(tier) {
  return { A: 0, B: 1, C: 2, D: 3 }[tier] ?? 9;
}

function tierScore(tier) {
  return { A: 1000, B: 500, C: 100, D: 0 }[tier] ?? 0;
}

function commentRank(value) {
  return { yes: 0, maybe: 1, no: 2 }[value] ?? 9;
}
