import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildClassificationReport } from "../packages/core/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outRoot = path.join(repoRoot, ".agentdiff", "open-pr-prospect", "latest");
const cacheRoot = path.join(repoRoot, ".agentdiff", "open-pr-prospect", "cache");
const manualOutcomesPath = path.join(repoRoot, ".agentdiff", "open-pr-prospect", "manual-outcomes.json");
const started = Date.now();
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const positionalStrings = positional.filter((arg) => !/^-?\d+(\.\d+)?$/.test(arg) && arg !== "true" && arg !== "false");
const positionalJson = positionalStrings.find((arg) => /\.json$/i.test(arg));

const candidatePathPattern = /(^|\/)(agents?|tools?|workflows?|mastra|langgraph|mcp|app\/api|server|routes?)(\/|$)|github|gitlab|slack|discord|email|browser|memory|payment|refund|ticket|issue|sandbox|harness|runner/i;
const candidateTextPattern = /\b(agent|agents|tool|tools|workflow|workflows|mastra|langgraph|mcp|github|gitlab|slack|discord|email|browser|memory|payment|refund|ticket|issue|approval|human-in-the-loop|hitl|sandbox|harness)\b|app\/api|server|routes?/i;
const riskyWordPattern = /\b(send|post|delete|close|refund|charge|approve|write|execute|shell|browser|submit|email|ticket|issue|memory|database|payment|publish|revoke|grant|trigger|cancel|rerun|create|update)\b/i;
const createWritePattern = /\b(create|add|append|insert|upsert|write|save|schedule|persist|execute|restore|clear|delete|send)\w*/i;
const approvalPattern = /\b(approval|human|review|confirmation|confirm|escalat|hitl|policy|permission|guardrail|manual)\b|human-in-the-loop/i;
const docsOrExamplePathPattern = /(^|\/)(docs?|documentation|examples?|templates?|starters?|workshops?|courses?|notebooks?|fixtures?|tests?|test|testing|__tests__|e2e|dist|build|coverage|ui|frontend|components|generated|node_modules|\.claude)(\/|$)|(^|\/)readme\.|\.(test|spec)\.[cm]?[jt]sx?$|\.mdx?$|\.ipynb$/i;
const genericCapabilityPattern = /^(update|delete|close|send|reject|approve|create|publish|write|post|submit|trigger|cancel|rerun|grant|revoke|set|get|map|add|append|insert|save|execute)$/i;

const options = {
  targetRaw: readNumberOption("--target-raw", 100, 0),
  maxDeepAnalyzed: readNumberOption("--max-deep-analyzed", 100, 1),
  sinceDays: readNumberOption("--since-days", 90, 2),
  maxRuntimeMinutes: readNumberOption("--max-runtime-minutes", 45, 3),
  resume: readFlag("--resume"),
  mode: readOption("--mode") ?? "open",
  outputSuffix: readStringOption("--output-suffix") ?? positionalStrings.filter((arg) => !/\.json$/i.test(arg)).at(-1) ?? "v3",
  respectRateLimit: readBooleanOption("--respect-rate-limit", true),
  verifyFrom: readStringOption("--verify-from") ?? positionalJson,
  maxRepos: readNumberOption("--max-repos", 50, 5),
  prsPerRepo: readNumberOption("--prs-per-repo", 60, 6),
  start: readNumberOption("--start", 0, 7)
};

if (!["open", "merged", "both"].includes(options.mode)) {
  throw new Error(`--mode must be open, merged, or both; got ${options.mode}`);
}

fs.mkdirSync(outRoot, { recursive: true });
fs.mkdirSync(cacheRoot, { recursive: true });

if (options.verifyFrom) {
  generateGoldBank();
} else {
  mineEvidenceBank();
}

function mineEvidenceBank() {
  const seedRepos = readSeedRepos().slice(options.start, options.start + options.maxRepos);
  const manualOutcomes = readManualOutcomes();
  const priorLabels = readPriorLabels();
  const rateLimitLog = [];
  const searchLog = [];
  const results = {
    generatedAt: new Date().toISOString(),
    configuration: {
      ...options,
      verifyFrom: undefined,
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
    stoppedBecause: null
  };

  const queue = [];
  const seen = new Set();
  for (const repo of seedRepos) {
    if (timeBudgetExceeded()) {
      results.stoppedBecause = "max_runtime_minutes";
      break;
    }
    console.log(`\n== ${repo}`);
    const repoResult = inspectRepo(repo, { rateLimitLog, searchLog });
    results.repos.push(repoResult);
    for (const candidate of repoResult.candidates) {
      const key = `${candidate.repo}#${candidate.pr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(candidate);
    }
  }

  queue.sort((left, right) => right.score - left.score);

  for (const candidate of queue) {
    if (results.analyzed.length >= options.maxDeepAnalyzed) {
      results.stoppedBecause ??= "max_deep_analyzed";
      break;
    }
    if (rawAccepted(results.analyzed).length >= options.targetRaw) {
      results.stoppedBecause ??= "target_raw";
      break;
    }
    if (timeBudgetExceeded()) {
      results.stoppedBecause ??= "max_runtime_minutes";
      break;
    }
    if (rateLimitLog.some((entry) => entry.stopRecommended)) {
      results.stoppedBecause ??= "rate_limit";
      break;
    }

    console.log(`analyzing ${candidate.repo}#${candidate.pr}`);
    const analyzed = analyzeCandidate(candidate);
    const prior = priorLabels.get(`${candidate.repo}#${candidate.pr}`);
    if (prior) analyzed.priorManualLabel = prior;
    const manualOutcome = manualOutcomes.get(`${candidate.repo}#${candidate.pr}`);
    if (manualOutcome) {
      analyzed.manualOutcome = manualOutcome.decision;
      analyzed.manualOutcomeReasons = manualOutcome.reasons ?? [];
      analyzed.commentBlockers = unique([...(analyzed.commentBlockers ?? []), "previously_reviewed", ...(manualOutcome.reasons ?? [])]);
      analyzed.commentEligibility = manualOutcome.decision === "comment_candidate" ? analyzed.commentEligibility : "watch";
      analyzed.finalCommentDraft = analyzed.commentEligibility === "review_now" ? analyzed.finalCommentDraft : "";
    }
    results.analyzed.push(analyzed);
  }

  results.summary = summarize(results);
  const accepted = rawAccepted(results.analyzed);
  const verifierPackets = accepted.map(toVerifierPacket);

  const suffix = options.outputSuffix;
  const rawBank = {
    ...results,
    accepted,
    verifierPacketPath: `.agentdiff/open-pr-prospect/latest/verifier-packets-${suffix}.json`
  };
  writeJson(path.join(outRoot, `autonomous-regression-bank-${suffix}.json`), rawBank);
  fs.writeFileSync(path.join(outRoot, `autonomous-regression-bank-${suffix}.md`), renderRawBank(rawBank));
  writeJson(path.join(outRoot, `verifier-packets-${suffix}.json`), {
    generatedAt: new Date().toISOString(),
    source: `autonomous-regression-bank-${suffix}.json`,
    instructions: verifierInstructions(),
    packets: verifierPackets
  });
  fs.writeFileSync(path.join(outRoot, `verifier-packets-${suffix}.md`), renderVerifierPackets(verifierPackets));
  fs.writeFileSync(path.join(outRoot, `search-log-${suffix}.md`), renderSearchLog({ results, searchLog }));
  fs.writeFileSync(path.join(outRoot, `rate-limit-log-${suffix}.md`), renderRateLimitLog(rateLimitLog));

  console.log(`\nevidence bank raw report: ${path.join(outRoot, `autonomous-regression-bank-${suffix}.md`)}`);
  console.log(`verifier packets: ${path.join(outRoot, `verifier-packets-${suffix}.md`)}`);
  console.log(`repos scanned: ${results.summary.reposScanned}`);
  console.log(`PRs inspected: ${results.summary.prsInspected}`);
  console.log(`deep analyzed: ${results.summary.deepAnalyzed}`);
  console.log(`raw accepted: ${accepted.length}`);
  console.log(`A/B/C/D: ${results.summary.tierCounts.A}/${results.summary.tierCounts.B}/${results.summary.tierCounts.C}/${results.summary.tierCounts.D}`);
  console.log(`stopped because: ${results.stoppedBecause ?? "completed"}`);
}

function generateGoldBank() {
  const suffix = options.outputSuffix;
  const rawPath = path.join(outRoot, `autonomous-regression-bank-${suffix}.json`);
  const raw = readJson(rawPath);
  if (!raw) throw new Error(`missing raw bank for suffix ${suffix}: ${rawPath}`);

  const labelsPath = path.resolve(repoRoot, options.verifyFrom);
  const labelsFile = readJson(labelsPath);
  if (!labelsFile) throw new Error(`could not read --verify-from labels: ${labelsPath}`);
  const labels = normalizeLabels(labelsFile);
  const byKey = new Map(labels.map((label) => [`${label.repo}#${label.pr}`, label]));
  const candidates = raw.accepted.map((candidate) => {
    const label = byKey.get(`${candidate.repo}#${candidate.pr}`) ?? {};
    const verified = label.verified_classification ?? label.label ?? "watch";
    return {
      repo: candidate.repo,
      pr: candidate.pr,
      url: candidate.url,
      title: candidate.title,
      state: candidate.state,
      raw_tier: candidate.behaviorDeltaTier,
      raw_comment_eligibility: candidate.commentEligibility,
      verified_classification: verified,
      confidence: label.confidence ?? candidate.confidence,
      quality: label.quality ?? qualityForVerified(verified),
      behavior_delta_summary: label.behavior_delta_summary ?? candidate.behaviorDeltaSummary,
      before_behavior: label.before_behavior ?? candidate.suspectedBefore,
      after_behavior: label.after_behavior ?? candidate.suspectedAfter,
      changed_boundary: label.changed_boundary ?? boundaryFor(candidate),
      evidence_files: label.evidence_files ?? candidate.changedFiles ?? [],
      evidence_functions: label.evidence_functions ?? addedCalls(candidate),
      scanner_evidence: candidate.findingSummary ?? [],
      why_normal_ci_misses_it: label.why_normal_ci_misses_it ?? "Normal CI can show tests/builds pass, but it does not summarize that the agent/tool/API capability boundary changed.",
      why_not_public_accusation: "This is internal product validation of a behavior delta, not a vulnerability report or claim that an external project made a bad change.",
      comment_worthiness: label.comment_worthiness ?? (verified === "comment_candidate" ? "yes" : "no"),
      comment_blockers: label.comment_blockers ?? candidate.commentBlockers ?? [],
      human_reason: label.human_reason ?? "Manual/Codex verification label imported from verified label file.",
      product_lesson: label.product_lesson ?? "",
      final_comment_draft: verified === "comment_candidate" ? (label.final_comment_draft ?? candidate.finalCommentDraft ?? "") : ""
    };
  });

  const gold = {
    generatedAt: new Date().toISOString(),
    source: `autonomous-regression-bank-${suffix}.json`,
    labelsSource: path.relative(repoRoot, labelsPath).replace(/\\/g, "/"),
    verifier: "Manual/Codex labels imported from a local JSON file; no external LLM APIs were called.",
    summary: {
      inspected: candidates.length,
      ...countBy(candidates.map((candidate) => candidate.verified_classification))
    },
    candidates
  };

  writeJson(path.join(outRoot, `gold-evidence-bank-${suffix}.json`), gold);
  fs.writeFileSync(path.join(outRoot, `gold-evidence-bank-${suffix}.md`), renderGoldBank(gold));
  writeGoldSubset(suffix, "verified-regressions", "verified_regression_candidate", candidates);
  writeGoldSubset(suffix, "verified-behavior-deltas", "verified_behavior_delta", candidates);
  writeGoldSubset(suffix, "verified-comment-candidates", "comment_candidate", candidates);
  writeGoldSubset(suffix, "rejected-candidates", "reject", candidates);

  console.log(`gold bank: ${path.join(outRoot, `gold-evidence-bank-${suffix}.md`)}`);
  console.log(JSON.stringify(gold.summary, null, 2));
}

function inspectRepo(repo, { rateLimitLog, searchLog }) {
  const result = { repo, status: "ok", prsInspected: 0, candidates: [], errors: [] };
  const states = options.mode === "both" ? ["open", "merged"] : [options.mode];

  for (const mode of states) {
    if (timeBudgetExceeded()) break;
    const pulls = fetchPulls(repo, mode, rateLimitLog);
    searchLog.push({ repo, mode, count: Array.isArray(pulls) ? pulls.length : 0 });
    if (!Array.isArray(pulls)) {
      result.status = "api_error";
      result.errors.push(`${mode} pull list unavailable`);
      continue;
    }

    for (const pr of pulls.slice(0, options.prsPerRepo)) {
      if (timeBudgetExceeded()) break;
      const updatedAt = pr.updated_at ?? pr.merged_at ?? pr.closed_at ?? pr.created_at;
      const updatedDaysAgo = daysAgo(updatedAt);
      if (updatedDaysAgo !== undefined && updatedDaysAgo > options.sinceDays) continue;
      result.prsInspected += 1;

      const files = ghJsonCached(`repos/${repo}/pulls/${pr.number}/files?per_page=100`, {
        namespace: "files",
        preferCache: options.resume,
        rateLimitLog
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
        pr: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        url: pr.html_url,
        state: mode === "merged" ? "merged" : pr.state,
        isDraft: Boolean(pr.draft),
        createdAt: pr.created_at,
        updatedAt,
        updatedDaysAgo,
        baseSha: pr.base?.sha,
        headSha: pr.head?.sha ?? pr.merge_commit_sha,
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
          patch: compactPatch(file.patch ?? ""),
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes
        }))
      };
      result.candidates.push(candidate);
    }
  }

  return result;
}

function fetchPulls(repo, mode, rateLimitLog) {
  if (mode === "open") {
    return ghJsonCached(`repos/${repo}/pulls?state=open&per_page=${Math.min(100, options.prsPerRepo)}&sort=updated&direction=desc`, {
      namespace: "pulls",
      preferCache: options.resume,
      rateLimitLog
    });
  }
  const pulls = ghJsonCached(`repos/${repo}/pulls?state=closed&per_page=${Math.min(100, options.prsPerRepo)}&sort=updated&direction=desc`, {
    namespace: "pulls",
    preferCache: options.resume,
    rateLimitLog
  });
  return Array.isArray(pulls) ? pulls.filter((pull) => pull.merged_at) : pulls;
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
    report = buildClassificationReport({ repo: candidate.repo, files });
  } catch (error) {
    return {
      ...candidateSummary(candidate),
      status: "analysis_error",
      behaviorDeltaTier: "D",
      confidence: "low",
      commentEligibility: "skip",
      commentBlockers: ["analysis_error"],
      positiveSignals: [],
      commentUsefulnessScore: 0,
      behaviorDeltaSummary: "Agentdiff analysis failed for this PR candidate.",
      findingSummary: [],
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
  const calls = specificCapabilityCalls(summary.filter((finding) => finding.runtimePath));

  return {
    ...candidateSummary(candidate),
    status: report.status,
    behaviorDeltaTier,
    confidence,
    commentEligibility,
    commentBlockers: blockers,
    positiveSignals,
    commentUsefulnessScore,
    behaviorDeltaSummary,
    suspectedBefore: suspectedBeforeFor({ candidate, calls }),
    suspectedAfter: suspectedAfterFor({ candidate, calls }),
    reasonCodes: reasonCodesFor({ candidate, summary, positiveSignals, blockers }),
    actionabilityCounts: countBy(findings.map(actionabilityForFinding)),
    findingSummary: summary.slice(0, 12),
    finalCommentDraft: commentEligibility === "review_now" ? draftCommentFor({ summary }) : ""
  };
}

function toVerifierPacket(candidate) {
  return {
    repo: candidate.repo,
    pr: candidate.pr,
    url: candidate.url,
    title: candidate.title,
    state: candidate.state,
    updatedAt: candidate.updatedAt,
    changedFiles: candidate.changedFiles,
    bodyExcerpt: compactText(candidate.body, 1800),
    deterministic: {
      behaviorDeltaTier: candidate.behaviorDeltaTier,
      confidence: candidate.confidence,
      commentEligibility: candidate.commentEligibility,
      commentBlockers: candidate.commentBlockers,
      positiveSignals: candidate.positiveSignals,
      behaviorDeltaSummary: candidate.behaviorDeltaSummary,
      suspectedBefore: candidate.suspectedBefore,
      suspectedAfter: candidate.suspectedAfter,
      reasonCodes: candidate.reasonCodes,
      priorManualLabel: candidate.priorManualLabel,
      manualOutcome: candidate.manualOutcome,
      manualOutcomeReasons: candidate.manualOutcomeReasons
    },
    findings: candidate.findingSummary,
    patchSnippets: candidate.files?.slice(0, 8).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: compactPatch(file.patch ?? "")
    })) ?? [],
    verificationPrompt: {
      allowedLabels: ["verified_regression_candidate", "verified_behavior_delta", "comment_candidate", "watch", "reject"],
      hardRules: [
        "No verified regression unless before/after is concrete.",
        "No gold if evidence is docs/logs/generated/.claude/node_modules only.",
        "No comment candidate if author already explains the delta clearly.",
        "No comment candidate if the thread is noisy.",
        "Downgrade generic create/update/delete unless the capability is specific.",
        "Use behavior delta language, not vulnerability/security framing."
      ]
    }
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
    if (candidatePathPattern.test(file.filename)) score += 6;
    if (candidateTextPattern.test(haystack)) score += 3;
    if (riskyWordPattern.test(haystack)) score += 5;
    if (createWritePattern.test(haystack)) score += 5;
    if (approvalPattern.test(`${pr.title}\n${haystack}`)) score += 4;
    if (/mcp|github|gitlab|slack|discord|email|refund|charge|payment|browser|memory|ticket|issue|workflow|schedule|sandbox|runner/i.test(file.filename)) score += 4;
    if (isRuntimeBehaviorPath(file.filename)) score += 5;
    if (isDocsOrExamplePath(file.filename)) score -= 5;
  }
  const text = `${pr.title ?? ""}\n${pr.body ?? ""}`;
  if (/agent|tool|workflow|mcp|refund|email|issue|memory|browser|approval|hitl|schedule|persist|sandbox/i.test(text)) score += 5;
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
    silent: true,
    rateLimitLog: []
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
  const hasPersistence = /memory|store|checkpoint|database|db|write|save|persist|schedule|workflow/i.test(candidate.changedFiles.join("\n"));
  const actionRequired = findings.some((finding) => actionabilityForFinding(finding) === "action_required") || report.status === "action_required";
  const runtimeActionRequired = summary.some((finding) => finding.actionability === "action_required" && isRuntimeBehaviorPath(finding.path ?? ""));
  const reviewRecommended = findings.some((finding) => actionabilityForFinding(finding) === "review_recommended");
  const runtimeReviewRecommended = summary.some((finding) => finding.actionability === "review_recommended" && isRuntimeBehaviorPath(finding.path ?? ""));

  if (runtimeActionRequired && hasRuntimeHighRiskAdded) return "A";
  if (runtimeActionRequired && (hasApprovalChange || hasPersistence || candidate.changedFiles.some(isRuntimeBehaviorPath))) return "B";
  if (runtimeReviewRecommended && (hasHighRiskAdded || hasApprovalChange || hasPersistence)) return "B";
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
  if (/workflow|automation|schedule|trigger|worker|resume|run|orchestrat|heartbeat|babysit|wakeup/i.test(text)) signals.push("automation_boundary_change");
  if (/memory|state|store|checkpoint|database|db|persist|thread|session/i.test(text)) signals.push("memory_or_state_change");
  if (/approval|approve|decline|human|hitl|permission|guardrail|confirm/i.test(text)) signals.push("approval_or_hitl_change");
  if (/send|post|delete|close|refund|charge|email|slack|discord|github|gitlab|browser|submit|payment|external|deploy|remote/i.test(text)) signals.push("external_side_effect_change");
  if (createWritePattern.test(text)) signals.push("create_write_schedule_signal");
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
      create_write_schedule_signal: 12,
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
  if (behaviorDeltaTier === "A" || behaviorDeltaTier === "B") return "watch";
  return "skip";
}

function draftCommentFor({ summary }) {
  const runtimeFindings = summary.filter((finding) => finding.runtimePath);
  const added = specificCapabilityCalls(runtimeFindings).slice(0, 4);
  const capabilities = [];
  if (added.length > 0) capabilities.push(...added.map((item) => `- adds/changes \`${item}\``));
  for (const filePath of unique(runtimeFindings.map((finding) => finding.path).filter(Boolean)).slice(0, 3)) {
    if (capabilities.length >= 4) break;
    capabilities.push(`- runtime path \`${filePath}\``);
  }
  return limitWords(`Small review note: this PR appears to change an agent/runtime capability.\n\nConcrete delta I noticed:\n${capabilities.slice(0, 4).join("\n")}\n\nThis may be exactly intended. I am mentioning it because normal CI can show the code works, but not necessarily summarize what the agent/runtime can now do.`, 120);
}

function suspectedBeforeFor({ calls }) {
  const text = calls.join(" ");
  if (/memory|persist|save|store|checkpoint/i.test(text)) return "Prior inspected behavior did not expose the same persistence or memory mutation path.";
  if (/send|email|slack|discord|whatsapp|outbound/i.test(text)) return "Prior inspected behavior had no equivalent external-message send path or a narrower channel surface.";
  if (/schedule|workflow|wakeup|heartbeat|background/i.test(text)) return "Prior inspected behavior was narrower, less durable, or less automated.";
  if (/execute|sandbox|runner|shell|file|write/i.test(text)) return "Prior inspected behavior did not expose the same delegated execution or file/tool boundary.";
  return "Previous behavior not fully inferable from compact public PR evidence.";
}

function suspectedAfterFor({ candidate, calls }) {
  if (calls.length > 0) return `After behavior includes ${calls.slice(0, 8).join(", ")} in agent/tool/API runtime paths.`;
  return candidate.title;
}

function reasonCodesFor({ summary, positiveSignals, blockers }) {
  const calls = unique(summary.flatMap((finding) => finding.addedHighRiskCalls ?? []));
  return unique([
    ...positiveSignals,
    ...blockers,
    ...calls.filter((call) => createWritePattern.test(call)).map((call) => `create_write_call:${call}`)
  ]);
}

function authorAlreadyExplainsDelta(candidate, runtimeFindings) {
  const rawBody = String(candidate.body ?? "");
  const text = `${candidate.title ?? ""}\n${rawBody}`.toLowerCase();
  if (text.length < 500) return false;
  const calls = specificCapabilityCalls(runtimeFindings).map((call) => call.toLowerCase());
  const mentionedCalls = calls.filter((call) => text.includes(call)).length;
  const structured = /\b(before|after|now|what changed|summary|key changes|how it works|verification|testing|scope|flow|ingest contract|routing|worker)\b/i.test(rawBody);
  const ownershipWords = /\b(runtime|subscription|approval|resume|tool|agent|workflow|memory|thread|stream|api|route|routing|worker|schedule|channel|webhook|ingest|send endpoint|reply|persist|sandbox)\b/i.test(rawBody);
  if (mentionedCalls > 0 && structured) return true;
  const categoryHits = capabilityCategoriesFor(calls, candidate).filter((category) => category.pattern.test(text)).length;
  const explainsFlow = /\b(before|after|now|changed|fixes|adds|routes?|routing|forwards?|dispatch|delivered|worker|endpoint|ownership|handled|verified|thread|subscription|approval|resume|persist|durable|sandbox)\b/i.test(rawBody);
  return structured && ownershipWords && explainsFlow && categoryHits >= 2;
}

function capabilityCategoriesFor(calls, candidate) {
  const names = `${calls.join(" ")} ${candidate.title ?? ""} ${(candidate.changedFiles ?? []).join(" ")}`.toLowerCase();
  const categories = [];
  if (/whatsapp|sendwhatsapp|channel|ingest|concierge|discord|slack/.test(names)) categories.push({ pattern: /\b(whatsapp|discord|slack|concierge|channel|inbound|ingest|phone|routing|worker|send endpoint|reply)\b/i });
  if (/resume|stream|approval|toolapproval|sendstreamresume/.test(names)) categories.push({ pattern: /\b(resume|stream|subscription|subscribed|approval|decline|tool|run id|boundary)\b/i });
  if (/heartbeat|schedule|wakeup/.test(names)) categories.push({ pattern: /\b(heartbeat|schedule|scheduled|cron|worker|wakeup|self-poll|check-in|signal)\b/i });
  if (/github|gitlab|gist|issue|pull|review|label/.test(names)) categories.push({ pattern: /\b(github|gitlab|gist|issue|pull request|review|label|comment|workflow)\b/i });
  if (/remote|deploy|sandbox|shell|northflank|tensorlake/.test(names)) categories.push({ pattern: /\b(remote|deploy|sandbox|shell|filesystem|provider|session|manifest)\b/i });
  if (/memory|state|checkpoint|thread|session|persist/.test(names)) categories.push({ pattern: /\b(memory|state|checkpoint|thread|session|persist|storage|durable)\b/i });
  if (/send|email|outbound|message/.test(names)) categories.push({ pattern: /\b(send|sent|outbound|message|email|reply|deliver)\b/i });
  return categories;
}

function isGiantRefactor(candidate, runtimeFindings) {
  const changed = Number(candidate.changedFilesCount ?? candidate.changedFiles.length);
  const churn = Number(candidate.additions ?? 0) + Number(candidate.deletions ?? 0);
  const titleLooksBroad = /\b(refactor|rework|cleanup|move|migrate|version packages|monorepo|serialization-safe)\b/i.test(candidate.title ?? "");
  return (changed >= 40 || churn >= 3000 || titleLooksBroad) && runtimeFindings.length > 4;
}

function hasOnlyGenericCapabilities(summary) {
  const runtimeFindings = summary.filter((finding) => finding.runtimePath);
  const calls = unique(runtimeFindings.flatMap((finding) => finding.addedHighRiskCalls ?? []));
  if (calls.length === 0) return true;
  return calls.every((callName) => !isSpecificCapabilityCall(callName));
}

function specificCapabilityCalls(findings) {
  return unique(findings.flatMap((finding) => finding.addedHighRiskCalls ?? []).filter(isSpecificCapabilityCall));
}

function isSpecificCapabilityCall(callName) {
  const normalized = String(callName ?? "");
  if (!normalized || genericCapabilityPattern.test(normalized)) return false;
  return /refund|charge|invoice|payment|email|slack|discord|github|gitlab|gist|issue|ticket|workflow|memory|heartbeat|schedule|wakeup|rate|tool|approval|approve|label|review|comment|file|pull|branch|run|thread|session|browser|form|submit|remote|deploy|stream|resume|close[A-Z]|delete[A-Z]|update[A-Z]|send[A-Z]|create[A-Z]|trigger[A-Z]|cancel[A-Z]|rerun[A-Z]|persist|save|write|sandbox|runner|agent/i.test(normalized);
}

function rawAccepted(items) {
  return items.filter((item) => ["A", "B", "C"].includes(item.behaviorDeltaTier));
}

function summarize(results) {
  const tiers = countBy(results.analyzed.map((item) => item.behaviorDeltaTier));
  const eligibility = countBy(results.analyzed.map((item) => item.commentEligibility));
  return {
    reposScanned: results.repos.length,
    prsInspected: sum(results.repos, (repo) => repo.prsInspected),
    candidatePrsFound: results.repos.reduce((total, repo) => total + repo.candidates.length, 0),
    deepAnalyzed: results.analyzed.length,
    rawAccepted: rawAccepted(results.analyzed).length,
    tierCounts: { A: tiers.A ?? 0, B: tiers.B ?? 0, C: tiers.C ?? 0, D: tiers.D ?? 0 },
    commentEligibilityCounts: { review_now: eligibility.review_now ?? 0, watch: eligibility.watch ?? 0, skip: eligibility.skip ?? 0 }
  };
}

function candidateSummary(candidate) {
  return {
    repo: candidate.repo,
    pr: candidate.pr,
    title: candidate.title,
    url: candidate.url,
    state: candidate.state,
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
    body: candidate.body,
    files: candidate.files,
    score: candidate.score
  };
}

function readHeadSafeText() {
  return "";
}

function fetchRateLimit() {
  const result = spawnSync("gh", ["api", "rate_limit"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function ghJsonCached(endpoint, { namespace = "api", preferCache = false, silent = false, rateLimitLog = [] } = {}) {
  const cachePath = path.join(cacheRoot, namespace, `${hash(endpoint)}.json`);
  if (preferCache && fs.existsSync(cachePath)) return readJson(cachePath);

  if (options.respectRateLimit) {
    const rate = fetchRateLimit();
    const core = rate?.resources?.core;
    if (core && Number(core.remaining) <= 1) {
      rateLimitLog.push({ endpoint, remaining: core.remaining, reset: core.reset, stopRecommended: true });
      if (fs.existsSync(cachePath)) return readJson(cachePath);
      return null;
    }
  }

  const result = spawnSync("gh", ["api", endpoint], { cwd: repoRoot, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim();
    const rateLimited = /secondary rate|rate limit|API rate limit/i.test(message);
    rateLimitLog.push({ endpoint, error: compactText(message, 500), stopRecommended: rateLimited });
    if (fs.existsSync(cachePath)) return readJson(cachePath);
    if (!silent) console.warn(`gh api failed for ${endpoint}: ${message}`);
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

function readManualOutcomes() {
  const data = readJson(manualOutcomesPath);
  const outcomes = Array.isArray(data?.outcomes) ? data.outcomes : [];
  return new Map(outcomes.map((outcome) => [`${outcome.repo}#${outcome.pr}`, outcome]));
}

function readPriorLabels() {
  const labels = new Map();
  for (const fileName of fs.existsSync(outRoot) ? fs.readdirSync(outRoot) : []) {
    if (!/^gold-evidence-bank-.*\.json$/.test(fileName)) continue;
    const data = readJson(path.join(outRoot, fileName));
    for (const candidate of data?.candidates ?? []) {
      labels.set(`${candidate.repo}#${candidate.pr}`, {
        source: fileName,
        verified_classification: candidate.verified_classification,
        quality: candidate.quality,
        human_reason: candidate.human_reason
      });
    }
  }
  return labels;
}

function normalizeLabels(labelsFile) {
  const items = Array.isArray(labelsFile) ? labelsFile : labelsFile.candidates ?? labelsFile.labels ?? [];
  if (!Array.isArray(items)) throw new Error("--verify-from must contain an array, candidates array, or labels array");
  return items.map((item) => ({
    ...item,
    repo: item.repo,
    pr: Number(item.pr ?? item.number)
  })).filter((item) => item.repo && item.pr);
}

function renderRawBank(rawBank) {
  const lines = [
    `# Autonomous Regression Bank ${options.outputSuffix}`,
    "",
    "Read-only local evidence-bank mining output.",
    "",
    "No external repos were modified. No comments/issues/PRs were created. No live model APIs were called.",
    "",
    "## Summary",
    "",
    `repos scanned: ${rawBank.summary.reposScanned}`,
    `PRs inspected: ${rawBank.summary.prsInspected}`,
    `candidate PRs found: ${rawBank.summary.candidatePrsFound}`,
    `deep analyzed: ${rawBank.summary.deepAnalyzed}`,
    `raw accepted: ${rawBank.summary.rawAccepted}`,
    `A/B/C/D: ${rawBank.summary.tierCounts.A}/${rawBank.summary.tierCounts.B}/${rawBank.summary.tierCounts.C}/${rawBank.summary.tierCounts.D}`,
    `review_now/watch/skip: ${rawBank.summary.commentEligibilityCounts.review_now}/${rawBank.summary.commentEligibilityCounts.watch}/${rawBank.summary.commentEligibilityCounts.skip}`,
    `stopped because: ${rawBank.stoppedBecause ?? "completed"}`,
    "",
    "## Top Raw Candidates",
    ""
  ];
  for (const [index, item] of ranked(rawBank.accepted).slice(0, 40).entries()) {
    lines.push(`### ${index + 1}. ${item.repo}#${item.pr}: ${item.title}`);
    lines.push("");
    lines.push(item.url);
    lines.push("");
    lines.push(`tier: ${item.behaviorDeltaTier}; eligibility: ${item.commentEligibility}; confidence: ${item.confidence}`);
    lines.push(`delta: ${item.behaviorDeltaSummary}`);
    lines.push(`calls: ${addedCalls(item).slice(0, 10).join(", ") || "none"}`);
    lines.push(`blockers: ${(item.commentBlockers ?? []).join(", ") || "none"}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderVerifierPackets(packets) {
  const lines = [
    `# Verifier Packets ${options.outputSuffix}`,
    "",
    "Use these compact packets for Codex/manual semantic judgment. Do not call external LLM APIs from this script.",
    "",
    verifierInstructions(),
    ""
  ];
  for (const [index, packet] of packets.entries()) {
    lines.push(`## ${index + 1}. ${packet.repo}#${packet.pr}: ${packet.title}`);
    lines.push("");
    lines.push(packet.url);
    lines.push("");
    lines.push(`tier: ${packet.deterministic.behaviorDeltaTier}; eligibility: ${packet.deterministic.commentEligibility}; confidence: ${packet.deterministic.confidence}`);
    lines.push(`summary: ${packet.deterministic.behaviorDeltaSummary}`);
    lines.push(`suspected before: ${packet.deterministic.suspectedBefore}`);
    lines.push(`suspected after: ${packet.deterministic.suspectedAfter}`);
    lines.push(`reason codes: ${(packet.deterministic.reasonCodes ?? []).join(", ") || "none"}`);
    lines.push("");
    lines.push("Findings:");
    for (const finding of packet.findings.slice(0, 5)) {
      lines.push(`- ${finding.actionability}/${finding.severity}: ${finding.path}; calls: ${(finding.addedHighRiskCalls ?? []).join(", ") || "none"}`);
    }
    lines.push("");
    lines.push("Patch snippets:");
    for (const snippet of packet.patchSnippets.slice(0, 3)) {
      lines.push(`- ${snippet.filename}: +${snippet.additions}/-${snippet.deletions}`);
      lines.push("```diff");
      lines.push(compactText(snippet.patch, 1400));
      lines.push("```");
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function verifierInstructions() {
  return [
    "Allowed labels: verified_regression_candidate, verified_behavior_delta, comment_candidate, watch, reject.",
    "Hard rules: no verified regression without concrete before/after; no gold for docs/logs/generated/.claude/node_modules only; no comment candidate if author already explains the delta clearly or thread is noisy; downgrade generic create/update/delete unless the capability is specific; use behavior-delta language, not vulnerability/security framing."
  ].join("\n\n");
}

function renderSearchLog({ results, searchLog }) {
  const lines = [
    `# Search Log ${options.outputSuffix}`,
    "",
    `mode: ${options.mode}`,
    `since days: ${options.sinceDays}`,
    `repos scanned: ${results.summary.reposScanned}`,
    `PRs inspected: ${results.summary.prsInspected}`,
    `candidate PRs found: ${results.summary.candidatePrsFound}`,
    `deep analyzed: ${results.summary.deepAnalyzed}`,
    `stopped because: ${results.stoppedBecause ?? "completed"}`,
    "",
    "## Per Repo",
    ""
  ];
  for (const entry of searchLog) {
    lines.push(`- ${entry.repo} ${entry.mode}: ${entry.count}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderRateLimitLog(entries) {
  const lines = [`# Rate Limit Log ${options.outputSuffix}`, ""];
  if (entries.length === 0) {
    lines.push("No rate-limit errors were observed.");
  } else {
    for (const entry of entries) {
      lines.push(`- endpoint: ${entry.endpoint}`);
      if (entry.remaining !== undefined) lines.push(`  remaining: ${entry.remaining}; reset: ${entry.reset}`);
      if (entry.error) lines.push(`  error: ${entry.error}`);
      if (entry.stopRecommended) lines.push("  stop recommended: yes");
    }
    lines.push("");
    lines.push("Resume with the same command and `--resume`; cached successful responses will be reused.");
  }
  return `${lines.join("\n")}\n`;
}

function renderGoldBank(gold) {
  const lines = [
    `# Gold Evidence Bank ${options.outputSuffix}`,
    "",
    "Manual/Codex verified local evidence bank. This is not a benchmark, security audit, or claim that external repos are unsafe.",
    "",
    "## Summary",
    "",
    ...Object.entries(gold.summary).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Candidates",
    ""
  ];
  for (const [index, item] of gold.candidates.entries()) {
    lines.push(`### ${index + 1}. ${item.repo}#${item.pr}: ${item.title}`);
    lines.push("");
    lines.push(item.url);
    lines.push("");
    lines.push(`classification: ${item.verified_classification}`);
    lines.push(`quality: ${item.quality}`);
    lines.push(`boundary: ${item.changed_boundary}`);
    lines.push(`delta: ${item.behavior_delta_summary}`);
    lines.push(`evidence calls: ${(item.evidence_functions ?? []).slice(0, 10).join(", ") || "none"}`);
    lines.push(`reason: ${item.human_reason}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function writeGoldSubset(suffix, baseName, classification, candidates) {
  const items = candidates.filter((candidate) => candidate.verified_classification === classification);
  const lines = [`# ${baseName} ${suffix}`, "", `count: ${items.length}`, ""];
  for (const [index, item] of items.entries()) {
    lines.push(`## ${index + 1}. ${item.repo}#${item.pr}: ${item.title}`);
    lines.push("");
    lines.push(item.url);
    lines.push("");
    lines.push(`delta: ${item.behavior_delta_summary}`);
    lines.push(`calls: ${(item.evidence_functions ?? []).slice(0, 10).join(", ") || "none"}`);
    lines.push(`reason: ${item.human_reason}`);
    lines.push("");
  }
  fs.writeFileSync(path.join(outRoot, `${baseName}-${suffix}.md`), `${lines.join("\n")}\n`);
}

function ranked(items) {
  return [...items].sort((left, right) => {
    return (
      tierRank(left.behaviorDeltaTier) - tierRank(right.behaviorDeltaTier) ||
      Number(right.commentUsefulnessScore ?? 0) - Number(left.commentUsefulnessScore ?? 0) ||
      Number(right.score ?? 0) - Number(left.score ?? 0)
    );
  });
}

function addedCalls(item) {
  return unique((item.findingSummary ?? []).flatMap((finding) => finding.addedHighRiskCalls ?? []));
}

function boundaryFor(candidate) {
  const text = `${candidate.title} ${addedCalls(candidate).join(" ")} ${(candidate.changedFiles ?? []).join(" ")}`;
  if (/memory|persist|save|store|checkpoint/i.test(text)) return "memory_or_persistence";
  if (/schedule|workflow|wakeup|heartbeat|background/i.test(text)) return "schedule_or_workflow";
  if (/send|email|slack|discord|whatsapp|outbound/i.test(text)) return "external_message";
  if (/sandbox|runner|shell|execute|file|write/i.test(text)) return "execution_or_file_boundary";
  if (/approve|approval|human|confirm/i.test(text)) return "approval_boundary";
  return "agent_capability_change";
}

function qualityForVerified(verified) {
  return {
    verified_regression_candidate: "gold",
    comment_candidate: "gold",
    verified_behavior_delta: "silver",
    watch: "bronze",
    reject: "none"
  }[verified] ?? "bronze";
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
  if (/packages\/[^/]+\/src\//i.test(normalized) && /tools?|agents?|workflows?|mcp|github|gitlab|slack|discord|email|browser|memory|payment|refund|ticket|issue|sandbox|harness/i.test(normalized)) return true;
  if (/apps\/[^/]+\/server\//i.test(normalized)) return true;
  if (/(^|\/)src\//i.test(normalized) && /agents?|tools?|workflows?|mcp|github|gitlab|slack|discord|email|browser|memory|payment|refund|ticket|issue|sandbox|harness/i.test(normalized)) return true;
  return false;
}

function isStackedOrDependentPr(candidate) {
  const text = `${candidate.title ?? ""}\n${candidate.body ?? ""}`;
  return /\b(stacked|stacked on|depends on|dependent|blocked by|builds on|base pr|parent pr|review\/merge|review this first|merge .* first)\b/i.test(text);
}

function compactPatch(patch) {
  return String(patch).split("\n").filter((line) => /^@@/.test(line) || /^\+[^+]/.test(line) || /^-[^-]/.test(line)).slice(0, 140).join("\n").slice(0, 9000);
}

function compactText(text, maxLength) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return process.env[npmConfigName(name)];
  if (process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  return process.env[npmConfigName(name)] ?? "true";
}

function readStringOption(name) {
  const value = readOption(name);
  if (value === undefined || value === "true" || value === "false") return undefined;
  return value;
}

function readNumberOption(name, defaultValue, position) {
  const raw = readOption(name);
  const parsed = Number(raw);
  if (raw !== undefined && raw !== "true" && Number.isFinite(parsed)) return parsed;
  if (position !== undefined && positional[position] !== undefined) {
    const positionalParsed = Number(positional[position]);
    if (Number.isFinite(positionalParsed)) return positionalParsed;
  }
  return defaultValue;
}

function readFlag(name) {
  if (process.argv.includes(name)) return true;
  const value = process.env[npmConfigName(name)];
  return value === "true" || value === "1";
}

function readBooleanOption(name, defaultValue) {
  const raw = readOption(name);
  if (raw === undefined) return defaultValue;
  if (raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  return defaultValue;
}

function npmConfigName(name) {
  return `npm_config_${name.replace(/^--/, "").replace(/-/g, "_")}`;
}

function timeBudgetExceeded() {
  return Date.now() - started > options.maxRuntimeMinutes * 60 * 1000;
}

function daysAgo(dateString) {
  if (!dateString) return undefined;
  const timestamp = Date.parse(dateString);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000)));
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function actionabilityRank(actionability) {
  return { action_required: 0, review_recommended: 1, context_only: 2, likely_noise: 3 }[actionability] ?? 9;
}

function tierRank(tier) {
  return { A: 0, B: 1, C: 2, D: 3 }[tier] ?? 9;
}

function limitWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}...`;
}
