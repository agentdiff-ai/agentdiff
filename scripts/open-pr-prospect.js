import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildClassificationReport } from "../packages/core/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outRoot = path.join(repoRoot, ".agentdiff", "open-pr-prospect", "latest");
const cacheRoot = path.join(repoRoot, ".agentdiff", "open-pr-prospect", "cache");
const runRoot = path.join(os.tmpdir(), `agentdiff-open-pr-prospect-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const started = Date.now();
const seedRepos = readSeedRepos();
const positionalNumbers = process.argv.slice(2).filter((arg) => /^-?\d+(\.\d+)?$/.test(arg));

const options = {
  targetReviewNow: readNumberOption("--target-review-now", 5, 0),
  maxRepos: readNumberOption("--max-repos", 50),
  prsPerRepo: readNumberOption("--prs-per-repo", 50),
  maxDeepAnalyzed: readNumberOption("--max-deep-analyzed", 60),
  maxRuntimeMinutes: readNumberOption("--max-runtime-minutes", 20, 1),
  resume: readFlag("--resume"),
  includeWatch: readFlag("--include-watch"),
  sinceDays: readNumberOption("--since-days", 45),
  start: readNumberOption("--start", 0)
};

const candidatePathPattern = /(^|\/)(agents?|tools?|workflows?|mastra|langgraph|mcp|app\/api|server|routes?)(\/|$)|github|gitlab|slack|email|browser|memory|payment|refund|ticket|issue/i;
const candidateTextPattern = /\b(agent|agents|tool|tools|workflow|workflows|mastra|langgraph|mcp|github|gitlab|slack|email|browser|memory|payment|refund|ticket|issue|approval|human-in-the-loop|hitl)\b|app\/api|server|routes?/i;
const riskyWordPattern = /\b(send|post|delete|close|refund|charge|approve|write|execute|shell|browser|submit|email|ticket|issue|memory|database|payment|publish|revoke|grant|trigger|cancel|rerun|create|update)\b/i;
const approvalPattern = /\b(approval|human|review|confirmation|confirm|escalat|hitl|policy|permission|guardrail|manual)\b|human-in-the-loop/i;
const docsOrExamplePathPattern = /(^|\/)(docs?|documentation|examples?|templates?|starters?|workshops?|courses?|notebooks?|fixtures?|tests?|test|testing|__tests__|e2e|dist|build|coverage|ui|frontend|components)(\/|$)|(^|\/)readme\.|\.(test|spec)\.[cm]?[jt]sx?$|\.mdx?$|\.ipynb$/i;
const genericCapabilityPattern = /^(update|delete|close|send|reject|approve|create|publish|write|post|submit|trigger|cancel|rerun|grant|revoke|set|get|map)$/i;

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });
fs.mkdirSync(cacheRoot, { recursive: true });
fs.mkdirSync(runRoot, { recursive: true });

const previous = options.resume ? readPreviousResults() : null;
const previouslyAnalyzed = new Map((previous?.analyzed ?? []).map((item) => [analysisKey(item), item]));
const manuallyReviewed = readManuallyReviewedPrs();
const selectedRepos = seedRepos.slice(options.start, options.start + options.maxRepos);

const results = {
  startedAt: new Date().toISOString(),
  runRoot,
  cacheRoot,
  configuration: {
    ...options,
    analysisMethod: "github_api_open_pr_prospecting_with_local_cache",
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
  analyzed: [],
  reusedAnalyzed: 0,
  stoppedBecause: null
};

const candidateQueue = [];
for (const repo of selectedRepos) {
  if (timeBudgetExceeded()) {
    results.stoppedBecause = "max_runtime_minutes";
    break;
  }
  console.log(`\n== ${repo}`);
  const repoResult = inspectRepoOpenPrs(repo);
  results.repos.push(repoResult);
  candidateQueue.push(...repoResult.candidates);
}

candidateQueue.sort((left, right) => right.score - left.score);

for (const candidate of candidateQueue) {
  if (results.analyzed.length >= options.maxDeepAnalyzed) {
    results.stoppedBecause ??= "max_deep_analyzed";
    break;
  }
  if (reviewNowCount(results.analyzed) >= options.targetReviewNow) {
    results.stoppedBecause ??= "target_review_now";
    break;
  }
  if (timeBudgetExceeded()) {
    results.stoppedBecause ??= "max_runtime_minutes";
    break;
  }

  const key = analysisKey(candidate);
  if (previouslyAnalyzed.has(key)) {
    results.analyzed.push({ ...previouslyAnalyzed.get(key), reusedFromPriorRun: true });
    results.reusedAnalyzed += 1;
    continue;
  }
  if (manuallyReviewed.has(`${candidate.repo}#${candidate.number}`)) {
    continue;
  }

  console.log(`analyzing ${candidate.repo}#${candidate.number}`);
  results.analyzed.push(analyzeCandidate(candidate));
}

results.summary = summarize(results);
results.topCandidates = ranked(results.analyzed).slice(0, 20);

writeOutputs(results);

console.log(`\nopen PR prospect report: ${path.join(outRoot, "ranked-candidates.md")}`);
console.log(`repos scanned: ${results.summary.reposScanned}`);
console.log(`open PRs inspected: ${results.summary.openPrsInspected}`);
console.log(`deep analyzed: ${results.summary.deepAnalyzed}`);
console.log(`review_now/watch/skip: ${results.summary.commentEligibilityCounts.review_now}/${results.summary.commentEligibilityCounts.watch}/${results.summary.commentEligibilityCounts.skip}`);
console.log(`stopped because: ${results.stoppedBecause ?? "completed"}`);

function inspectRepoOpenPrs(repo) {
  const result = {
    repo,
    status: "ok",
    openPrsInspected: 0,
    candidates: [],
    errors: []
  };

  const pulls = ghJsonCached(`repos/${repo}/pulls?state=open&per_page=${Math.min(100, options.prsPerRepo)}&sort=updated&direction=desc`, {
    namespace: "pulls",
    preferCache: false
  });
  if (!Array.isArray(pulls)) {
    result.status = "api_error";
    result.errors.push("open pull list unavailable");
    return result;
  }

  for (const pr of pulls.slice(0, options.prsPerRepo)) {
    result.openPrsInspected += 1;
    const updatedDaysAgo = daysAgo(pr.updated_at);
    if (updatedDaysAgo !== undefined && updatedDaysAgo > options.sinceDays && !options.includeWatch) continue;

    const files = ghJsonCached(`repos/${repo}/pulls/${pr.number}/files?per_page=100`, {
      namespace: "files",
      preferCache: options.resume
    });
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
      isDraft: Boolean(pr.draft),
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      updatedDaysAgo,
      baseSha: pr.base?.sha,
      headSha: pr.head?.sha,
      commentsCount: Number(pr.comments ?? 0),
      reviewCommentsCount: Number(pr.review_comments ?? 0),
      changedFilesCount: Number(pr.changed_files ?? matchingFiles.length),
      additions: Number(pr.additions ?? 0),
      deletions: Number(pr.deletions ?? 0),
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
    results.candidates.push(candidateSummary(candidate));
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
      behaviorDeltaTier: "D",
      tier: "D",
      confidence: "low",
      commentEligibility: "skip",
      comment_eligibility: "skip",
      commentBlockers: ["low_confidence_delta"],
      comment_blockers: ["low_confidence_delta"],
      positiveSignals: [],
      commentUsefulnessScore: 0,
      behaviorDeltaSummary: "Agentdiff analysis failed for this open PR candidate.",
      finalCommentDraft: "",
      suggestedHumanComment: "",
      error: error.message
    };
  }

  const findings = [...(report.diff_aware_findings ?? []), ...(report.map_drift ?? [])];
  const summary = summarizeFindings(findings);
  const behaviorDeltaTier = tierFor({ candidate, report, findings, summary });
  const behaviorDeltaSummary = behaviorSummaryFor({ tier: behaviorDeltaTier, candidate, summary });
  const confidence = confidenceFor({ tier: behaviorDeltaTier, summary });
  const positiveSignals = positiveSignalsFor({ candidate, summary });
  const blockers = commentBlockersFor({ candidate, summary, behaviorDeltaTier, confidence, positiveSignals, behaviorDeltaSummary });
  const commentUsefulnessScore = usefulnessScoreFor({ candidate, summary, behaviorDeltaTier, confidence, positiveSignals, blockers });
  const commentEligibility = commentEligibilityFor({ behaviorDeltaTier, confidence, positiveSignals, blockers, commentUsefulnessScore });
  const finalCommentDraft = draftCommentFor({ candidate, summary, behaviorDeltaTier, commentEligibility });

  return {
    ...candidateSummary(candidate),
    status: report.status,
    behaviorDeltaTier,
    tier: behaviorDeltaTier,
    confidence,
    commentEligibility,
    comment_eligibility: commentEligibility,
    commentBlockers: blockers,
    comment_blockers: blockers,
    positiveSignals,
    commentUsefulnessScore,
    behaviorDeltaSummary,
    actionabilityCounts: countBy(findings.map((finding) => actionabilityForFinding(finding))),
    findingSummary: summary.slice(0, 12),
    finalCommentDraft,
    suggestedHumanComment: finalCommentDraft
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
  if (pr.draft) score -= 25;
  if (isStackedOrDependentPr({ title: pr.title, body: pr.body ?? "" })) score -= 20;
  if (Number(pr.changed_files ?? 0) > 40) score -= 8;
  return score;
}

function readHeadContent(repo, filePath, ref) {
  if (!ref) return "";
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  const data = ghJsonCached(`repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
    namespace: "contents",
    preferCache: options.resume,
    silent: true
  });
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
  const runtimeSummaries = summary.filter((finding) => finding.runtimePath);
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
  if (tier === "B") return "Likely meaningful agent/tool/schema/approval/memory behavior change worth manual inspection.";
  if (tier === "C") return "Context-only signal in docs, examples, tests, or supporting files; inspect only if it is already relevant.";
  return `Weak candidate from ${candidate.changedFiles.slice(0, 3).join(", ")}; no strong behavior-delta signal.`;
}

function confidenceFor({ tier, summary }) {
  if (tier === "A" && specificCapabilityCalls(summary.filter((finding) => finding.runtimePath)).length > 0) return "high";
  if (tier === "A" || tier === "B") return "medium";
  return "low";
}

function positiveSignalsFor({ candidate, summary }) {
  const signals = [];
  const runtimeFindings = summary.filter((finding) => finding.runtimePath);
  const calls = specificCapabilityCalls(runtimeFindings);
  const text = `${candidate.title}\n${candidate.body}\n${candidate.changedFiles.join("\n")}\n${calls.join("\n")}`;

  if (calls.length > 0) signals.push("specific_capability_names");
  if (runtimeFindings.length > 0 || candidate.changedFiles.some(isRuntimeBehaviorPath)) signals.push("runtime_agent_path");
  if (/tools?|toolsets?|createTool|defineTool|tool catalog/i.test(text)) signals.push("tool_catalog_expansion");
  if (/workflow|automation|schedule|trigger|worker|resume|run|orchestrat|heartbeat|babysit/i.test(text)) signals.push("automation_boundary_change");
  if (/memory|state|store|checkpoint|database|db|persist|thread|session/i.test(text)) signals.push("memory_or_state_change");
  if (/approval|approve|decline|human|hitl|permission|guardrail|confirm/i.test(text)) signals.push("approval_or_hitl_change");
  if (/send|post|delete|close|refund|charge|email|slack|github|gitlab|browser|submit|payment|external|deploy|remote/i.test(text)) signals.push("external_side_effect_change");
  signals.push("concise_review_comment_possible");
  return unique(signals);
}

function commentBlockersFor({ candidate, summary, behaviorDeltaTier, confidence, positiveSignals, behaviorDeltaSummary }) {
  const blockers = [];
  const runtimeFindings = summary.filter((finding) => finding.runtimePath);
  const stale = Number(candidate.updatedDaysAgo ?? 0) > options.sinceDays;

  if (candidate.isDraft || /\b(wip|draft)\b|\[wip\]|\(wip\)/i.test(candidate.title ?? "")) blockers.push("draft_pr");
  if (stale) blockers.push("stale_pr");
  if (isStackedOrDependentPr(candidate)) blockers.push("stacked_or_dependent_pr");
  if (summary.length > 0 && summary.every((finding) => !finding.runtimePath || finding.docsOrExamplePath)) blockers.push("non_runtime_surface");
  if (!positiveSignals.includes("specific_capability_names") && hasOnlyGenericCapabilities(summary)) blockers.push("generic_capability_names_only");
  if (authorAlreadyExplainsDelta(candidate, runtimeFindings, behaviorDeltaSummary)) blockers.push("author_already_explained_delta_clearly");
  if (isGiantRefactor(candidate, runtimeFindings)) blockers.push("giant_refactor_or_framework_internal");
  if ((candidate.commentsCount + candidate.reviewCommentsCount) >= 12) blockers.push("noisy_thread");
  if (behaviorDeltaTier === "D" || confidence === "low") blockers.push("low_confidence_delta");

  return unique(blockers);
}

function usefulnessScoreFor({ candidate, summary, behaviorDeltaTier, confidence, positiveSignals, blockers }) {
  let score = { A: 80, B: 45, C: 15, D: 0 }[behaviorDeltaTier] ?? 0;
  if (confidence === "high") score += 15;
  if (confidence === "medium") score += 7;
  for (const signal of positiveSignals) {
    score += {
      specific_capability_names: 20,
      runtime_agent_path: 15,
      tool_catalog_expansion: 12,
      automation_boundary_change: 10,
      memory_or_state_change: 10,
      approval_or_hitl_change: 10,
      external_side_effect_change: 12,
      concise_review_comment_possible: 8
    }[signal] ?? 0;
  }
  for (const blocker of blockers) {
    score -= {
      draft_pr: 55,
      stale_pr: 35,
      stacked_or_dependent_pr: 45,
      non_runtime_surface: 60,
      generic_capability_names_only: 35,
      author_already_explained_delta_clearly: 45,
      giant_refactor_or_framework_internal: 25,
      noisy_thread: 20,
      low_confidence_delta: 50
    }[blocker] ?? 0;
  }
  const runtimeFiles = summary.filter((finding) => finding.runtimePath).length;
  if (runtimeFiles > 0 && runtimeFiles <= 4) score += 8;
  if (candidate.changedFilesCount > 30) score -= 10;
  if (candidate.additions + candidate.deletions > 2500) score -= 10;
  if (Number(candidate.updatedDaysAgo ?? 999) <= 7) score += 8;
  return Math.max(0, score);
}

function commentEligibilityFor({ behaviorDeltaTier, confidence, positiveSignals, blockers, commentUsefulnessScore }) {
  if (blockers.includes("non_runtime_surface") || blockers.includes("low_confidence_delta")) return "skip";
  if (
    behaviorDeltaTier === "A" &&
    confidence === "high" &&
    commentUsefulnessScore >= 110 &&
    positiveSignals.includes("specific_capability_names") &&
    positiveSignals.includes("runtime_agent_path") &&
    blockers.length === 0
  ) {
    return "review_now";
  }
  if (behaviorDeltaTier === "A" || behaviorDeltaTier === "B" || options.includeWatch) return "watch";
  return "skip";
}

function draftCommentFor({ candidate, summary, behaviorDeltaTier, commentEligibility }) {
  if (commentEligibility !== "review_now") return "";
  const runtimeFindings = summary.filter((finding) => finding.runtimePath);
  const added = specificCapabilityCalls(runtimeFindings).slice(0, 4);
  const removed = unique(runtimeFindings.flatMap((finding) => finding.removedSaferCalls ?? [])).slice(0, 2);
  const capabilities = [];
  if (added.length > 0) capabilities.push(...added.map((item) => `- adds/changes \`${item}\``));
  if (removed.length > 0) capabilities.push(...removed.map((item) => `- removes/changes \`${item}\``));
  for (const filePath of unique(runtimeFindings.map((finding) => finding.path).filter(Boolean)).slice(0, 3)) {
    if (capabilities.length >= 4) break;
    capabilities.push(`- runtime path \`${filePath}\``);
  }

  const draft = `Small review note: this PR appears to change an agent/runtime capability.\n\nConcrete delta I noticed:\n${capabilities.slice(0, 4).join("\n")}\n\nThis may be exactly intended. I am mentioning it because normal CI can show the code works, but not necessarily summarize what the agent/runtime can now do.`;
  return limitWords(draft, 120);
}

function authorAlreadyExplainsDelta(candidate, runtimeFindings, behaviorDeltaSummary) {
  const body = String(candidate.body ?? "").toLowerCase();
  if (body.length < 500) return false;
  const calls = specificCapabilityCalls(runtimeFindings).map((call) => call.toLowerCase());
  const mentionedCalls = calls.filter((call) => body.includes(call.toLowerCase())).length;
  const structured = /\b(before|after|now|what changed|summary|key changes|how it works|verification)\b/i.test(candidate.body ?? "");
  const ownershipWords = /\b(runtime|subscription|approval|resume|tool|agent|workflow|memory|thread|stream|api|route|worker|schedule)\b/i.test(candidate.body ?? "");
  if (mentionedCalls > 0 && structured) return true;
  return structured && ownershipWords && body.length > 1200 && /before|now|changed|fixes|adds|routes|preserved|updated/i.test(candidate.body ?? "");
}

function isGiantRefactor(candidate, runtimeFindings) {
  const changed = Number(candidate.changedFilesCount ?? candidate.changedFiles.length);
  const churn = Number(candidate.additions ?? 0) + Number(candidate.deletions ?? 0);
  const titleLooksBroad = /\b(refactor|rework|cleanup|move|migrate|version packages|monorepo|serialization-safe)\b/i.test(candidate.title ?? "");
  return (changed >= 40 || churn >= 3000 || titleLooksBroad) && runtimeFindings.length > 4;
}

function isStackedOrDependentPr(candidate) {
  const text = `${candidate.title ?? ""}\n${candidate.body ?? ""}`;
  return /\b(stacked|stacked on|depends on|dependent|blocked by|builds on|base pr|parent pr|review\/merge|review this first|merge .* first)\b/i.test(text);
}

function hasOnlyGenericCapabilities(summary) {
  const runtimeFindings = summary.filter((finding) => finding.runtimePath);
  const calls = unique(runtimeFindings.flatMap((finding) => finding.addedHighRiskCalls ?? []));
  if (calls.length === 0) return true;
  return calls.every((callName) => !isSpecificCapabilityCall(callName));
}

function candidateSummary(candidate) {
  return {
    repo: candidate.repo,
    pr: candidate.number ?? candidate.pr,
    title: candidate.title,
    url: candidate.url,
    isDraft: candidate.isDraft,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    updatedDaysAgo: candidate.updatedDaysAgo,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    changedFilesCount: candidate.changedFilesCount,
    additions: candidate.additions,
    deletions: candidate.deletions,
    changedFiles: candidate.changedFiles,
    score: candidate.score
  };
}

function summarize(result) {
  const tierCounts = countBy(result.analyzed.map((item) => item.behaviorDeltaTier ?? item.tier));
  const commentEligibilityCounts = countBy(result.analyzed.map((item) => item.commentEligibility));
  return {
    reposScanned: result.repos.length,
    openPrsInspected: sum(result.repos, (repo) => repo.openPrsInspected),
    candidatePrsFound: result.candidates.length,
    deepAnalyzed: result.analyzed.length,
    reusedAnalyzed: result.reusedAnalyzed,
    tierCounts: {
      A: tierCounts.A ?? 0,
      B: tierCounts.B ?? 0,
      C: tierCounts.C ?? 0,
      D: tierCounts.D ?? 0
    },
    commentEligibilityCounts: {
      review_now: commentEligibilityCounts.review_now ?? 0,
      watch: commentEligibilityCounts.watch ?? 0,
      skip: commentEligibilityCounts.skip ?? 0
    }
  };
}

function writeOutputs(result) {
  fs.writeFileSync(path.join(outRoot, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outRoot, "ranked-candidates.md"), renderRankedCandidates(result));
  fs.writeFileSync(path.join(outRoot, "review-now.md"), renderQueue("Review Now", ranked(result.analyzed).filter((item) => item.commentEligibility === "review_now")));
  fs.writeFileSync(path.join(outRoot, "watch.md"), renderQueue("Watch", ranked(result.analyzed).filter((item) => item.commentEligibility === "watch")));
  fs.writeFileSync(path.join(outRoot, "skip-summary.md"), renderSkipSummary(result));
}

function renderRankedCandidates(result) {
  const lines = [];
  lines.push("# Open PR Prospecting Queue");
  lines.push("");
  lines.push("Read-only local queue for public PRs that may deserve a human behavior-delta review comment.");
  lines.push("");
  lines.push("Rules followed: no external PRs, issues, comments, pushes, dependency installs, live model calls, external agent execution, or automated commenting.");
  lines.push("");
  lines.push("This queue ranks comment usefulness. It does not claim a PR is wrong, unsafe, or vulnerable.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`repos scanned: ${result.summary.reposScanned}`);
  lines.push(`open PRs inspected: ${result.summary.openPrsInspected}`);
  lines.push(`candidate PRs found: ${result.summary.candidatePrsFound}`);
  lines.push(`deep analyzed: ${result.summary.deepAnalyzed}`);
  lines.push(`reused from prior run: ${result.summary.reusedAnalyzed}`);
  lines.push(`A/B/C/D: ${result.summary.tierCounts.A}/${result.summary.tierCounts.B}/${result.summary.tierCounts.C}/${result.summary.tierCounts.D}`);
  lines.push(`review_now/watch/skip: ${result.summary.commentEligibilityCounts.review_now}/${result.summary.commentEligibilityCounts.watch}/${result.summary.commentEligibilityCounts.skip}`);
  lines.push(`stopped because: ${result.stoppedBecause ?? "completed"}`);
  lines.push("");
  lines.push("## Top Review Now Candidates");
  lines.push("");
  lines.push(renderItems(ranked(result.analyzed).filter((item) => item.commentEligibility === "review_now").slice(0, 10)));
  lines.push("");
  lines.push("## Top Watch Candidates");
  lines.push("");
  lines.push(renderItems(ranked(result.analyzed).filter((item) => item.commentEligibility === "watch").slice(0, 10)));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderQueue(title, items) {
  const lines = [`# ${title}`, ""];
  lines.push(renderItems(items.slice(0, 25)));
  return `${lines.join("\n")}\n`;
}

function renderItems(items) {
  if (items.length === 0) return "No candidates in this queue.\n";
  const lines = [];
  for (const item of items) {
    lines.push(`## ${item.repo}#${item.pr}: ${item.title}`);
    lines.push("");
    lines.push(`URL: ${item.url}`);
    lines.push(`behavior tier: ${item.behaviorDeltaTier}`);
    lines.push(`comment eligibility: ${item.commentEligibility}`);
    lines.push(`comment usefulness score: ${item.commentUsefulnessScore}`);
    lines.push(`confidence: ${item.confidence}`);
    lines.push(`updated days ago: ${item.updatedDaysAgo ?? "unknown"}`);
    lines.push(`positive signals: ${(item.positiveSignals ?? []).join(", ") || "none"}`);
    lines.push(`blockers: ${(item.commentBlockers ?? []).join(", ") || "none"}`);
    lines.push(`behavior delta: ${item.behaviorDeltaSummary}`);
    lines.push(`changed files: ${(item.changedFiles ?? []).slice(0, 8).join(", ")}`);
    if (item.findingSummary?.length > 0) {
      lines.push("");
      lines.push("finding summary:");
      for (const finding of item.findingSummary.slice(0, 4)) {
        lines.push(`- ${finding.actionability}/${finding.severity}: ${finding.title} (${finding.path})`);
        if (finding.addedHighRiskCalls?.length > 0) lines.push(`  added high-risk calls: ${finding.addedHighRiskCalls.join(", ")}`);
      }
    }
    if (item.finalCommentDraft) {
      lines.push("");
      lines.push("final comment draft:");
      lines.push("");
      lines.push("```txt");
      lines.push(item.finalCommentDraft);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderSkipSummary(result) {
  const lines = ["# Skip Summary", ""];
  const skip = ranked(result.analyzed).filter((item) => item.commentEligibility === "skip");
  const blockerCounts = countBy(skip.flatMap((item) => item.commentBlockers ?? []));
  lines.push(`skip candidates: ${skip.length}`);
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const [blocker, count] of Object.entries(blockerCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${blocker}: ${count}`);
  }
  lines.push("");
  lines.push("## Examples");
  lines.push("");
  lines.push(renderItems(skip.slice(0, 15)));
  return `${lines.join("\n")}\n`;
}

function ranked(items) {
  return [...items].sort((left, right) => {
    return (
      commentEligibilityRank(left.commentEligibility) - commentEligibilityRank(right.commentEligibility) ||
      Number(right.commentUsefulnessScore ?? 0) - Number(left.commentUsefulnessScore ?? 0) ||
      tierRank(left.behaviorDeltaTier ?? left.tier) - tierRank(right.behaviorDeltaTier ?? right.tier)
    );
  });
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

function ghJsonCached(endpoint, { namespace, preferCache = false, silent = false } = {}) {
  const cachePath = path.join(cacheRoot, namespace ?? "api", `${hash(endpoint)}.json`);
  if (preferCache && fs.existsSync(cachePath)) {
    return readJson(cachePath);
  }
  const result = spawnSync("gh", ["api", endpoint], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024
  });
  if (result.status !== 0) {
    if (fs.existsSync(cachePath)) return readJson(cachePath);
    if (!silent) console.warn(`gh api failed for ${endpoint}: ${result.stderr.trim()}`);
    return null;
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, result.stdout);
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

function readPreviousResults() {
  const filePath = path.join(outRoot, "results.json");
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function readManuallyReviewedPrs() {
  const reviewed = new Set();
  const watchlistDir = path.join(repoRoot, ".agentdiff", "open-pr-watchlist", "latest");
  if (!fs.existsSync(watchlistDir)) return reviewed;
  for (const entry of fs.readdirSync(watchlistDir)) {
    if (!/^manual-comment-review.*\.md$/i.test(entry)) continue;
    const text = fs.readFileSync(path.join(watchlistDir, entry), "utf8");
    for (const match of text.matchAll(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/g)) {
      reviewed.add(`${match[1]}#${match[2]}`);
    }
  }
  return reviewed;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return process.env[npmConfigName(name)];
  if (process.argv[index + 1]) return process.argv[index + 1];
  return process.env[npmConfigName(name)];
}

function readNumberOption(name, defaultValue, strippedPosition) {
  const raw = readOption(name);
  const parsed = Number(raw);
  if (raw !== undefined && raw !== "true" && Number.isFinite(parsed)) return parsed;
  if (raw === "true" && strippedPosition !== undefined && positionalNumbers[strippedPosition] !== undefined) {
    const positional = Number(positionalNumbers[strippedPosition]);
    if (Number.isFinite(positional)) return positional;
  }
  return defaultValue;
}

function readFlag(name) {
  if (process.argv.includes(name)) return true;
  const value = process.env[npmConfigName(name)];
  return value === "true" || value === "1";
}

function npmConfigName(name) {
  return `npm_config_${name.replace(/^--/, "").replace(/-/g, "_")}`;
}

function daysAgo(dateString) {
  if (!dateString) return undefined;
  const timestamp = Date.parse(dateString);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000)));
}

function timeBudgetExceeded() {
  return Date.now() - started > options.maxRuntimeMinutes * 60 * 1000;
}

function reviewNowCount(items) {
  return items.filter((item) => item.commentEligibility === "review_now").length;
}

function analysisKey(candidate) {
  return `${candidate.repo}#${candidate.number ?? candidate.pr}@${candidate.headSha ?? "unknown"}`;
}

function hash(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
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
  if (!normalized || genericCapabilityPattern.test(normalized)) return false;
  return /refund|charge|invoice|payment|email|slack|github|gitlab|gist|issue|ticket|workflow|memory|heartbeat|schedule|rate|tool|approval|approve|label|review|comment|file|pull|branch|run|thread|session|browser|form|submit|remote|deploy|stream|resume|close[A-Z]|delete[A-Z]|update[A-Z]|send[A-Z]|create[A-Z]|trigger[A-Z]|cancel[A-Z]|rerun[A-Z]/.test(normalized);
}

function actionabilityRank(actionability) {
  return {
    action_required: 0,
    review_recommended: 1,
    context_only: 2,
    likely_noise: 3
  }[actionability] ?? 9;
}

function tierRank(tier) {
  return { A: 0, B: 1, C: 2, D: 3 }[tier] ?? 9;
}

function commentEligibilityRank(value) {
  return { review_now: 0, watch: 1, skip: 2 }[value] ?? 9;
}

function limitWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}...`;
}
