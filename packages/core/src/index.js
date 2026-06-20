import fs from "node:fs";

const HIGH_RISK_TAGS = new Set([
  "destructive",
  "external_side_effect",
  "money_movement",
  "state_mutation",
  "customer_visible"
]);

const HIGH_RISK_CALL_WORDS = [
  "refund",
  "charge",
  "send",
  "delete",
  "close",
  "publish",
  "update",
  "create",
  "approve",
  "reject",
  "revoke",
  "grant"
];

const SAFER_CALL_WORDS = [
  "escalate",
  "review",
  "require_confirmation",
  "ask_confirmation",
  "draft",
  "validate",
  "check_policy"
];

const IGNORED_CALLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "console",
  "log"
]);

const JS_TS_EXTENSIONS = [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];
const ACTIONABILITY_TO_SEVERITY = {
  action_required: "high",
  review_recommended: "medium",
  context_only: "low",
  likely_noise: "low"
};

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function classifyChangedFile({ filePath, content = "" }) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  const lowerContent = content.toLowerCase();
  const exportedFunctions = extractExportedFunctionNames(content);
  const frameworkConfigSignal = frameworkConfigSignalFor({ normalized, basename, lowerContent });
  const aiSdkToolSignals = aiSdkToolSignalsFor(content);
  const toolSchemaSignals = toolSchemaSignalsFor(content);
  const evidence = [];
  const risk = [];
  let label = "not_agent_related";
  let confidence = 0.15;
  let recommendedCheckDepth = "classify";
  const context = `${normalized}\n${lowerContent}`;

  if (matchesAny(basename, ["agent", "assistant", "workflow", "orchestrator"]) || /export\s+async\s+function\s+run.*agent/i.test(content)) {
    label = "agent_entrypoint";
    confidence = Math.max(confidence, 0.72);
    evidence.push("path suggests agent entrypoint or orchestration code");
  }

  if (matchesAny(basename, ["prompt", "system-message", "instructions"])) {
    label = "prompt";
    confidence = Math.max(confidence, 0.78);
    evidence.push("path suggests prompt or instruction surface");
  }

  if (
    matchesAny(normalized, ["/tools/", "/tool/"]) ||
    matchesAny(basename, ["tool", "function", "action"]) ||
    exportedFunctions.some((name) => isHighRiskCall(name, context))
  ) {
    label = "tool_implementation";
    confidence = Math.max(confidence, 0.76);
    evidence.push(
      exportedFunctions.some((name) => isHighRiskCall(name, context))
        ? `exports high-risk function ${exportedFunctions.find((name) => isHighRiskCall(name, context))}`
        : "path suggests tool implementation"
    );
  }

  if (matchesAny(basename, ["schema", "zod", "jsonschema"])) {
    label = label === "not_agent_related" ? "tool_definition" : label;
    confidence = Math.max(confidence, 0.62);
    evidence.push("path suggests schema or tool definition");
  }

  if (frameworkConfigSignal) {
    label = label === "not_agent_related" ? "agent_entrypoint" : label;
    confidence = Math.max(confidence, frameworkConfigSignal.confidence);
    evidence.push(frameworkConfigSignal.evidence);
  }

  if (aiSdkToolSignals.length > 0) {
    label = label === "not_agent_related" ? "tool_definition" : label;
    confidence = Math.max(confidence, 0.8);
    evidence.push(...aiSdkToolSignals);
  }

  if (toolSchemaSignals.length > 0) {
    label = label === "not_agent_related" ? "tool_definition" : label;
    confidence = Math.max(confidence, 0.8);
    evidence.push(...toolSchemaSignals);
  }

  if (matchesAny(basename, ["model", "provider", "router", "llm"])) {
    label = label === "not_agent_related" ? "model_config" : label;
    confidence = Math.max(confidence, 0.65);
    evidence.push("path suggests model/provider configuration");
  }

  if (matchesAny(basename, ["retriev", "vector", "embedding", "memory"])) {
    label = label === "not_agent_related" ? "retrieval" : label;
    confidence = Math.max(confidence, 0.62);
    evidence.push("path suggests retrieval or memory surface");
  }

  if (/\b(openai|anthropic|chat\.completions|responses\.create|generateobject|streamtext)\b/.test(lowerContent)) {
    label = label === "not_agent_related" || (label === "tool_definition" && aiSdkToolSignals.length > 0) ? "agent_entrypoint" : label;
    confidence = Math.max(confidence, 0.82);
    evidence.push("content contains model-call pattern");
  }

  if (/\b(z\.object|jsonschema|parameters|tool_call|function_call)\b/.test(lowerContent)) {
    label = label === "not_agent_related" ? "tool_definition" : label;
    confidence = Math.max(confidence, 0.78);
    evidence.push("content contains tool/schema pattern");
  }

  if (/\b(delete|refund|charge|send|publish|close|update|write|grant|revoke|approve|reject)\b/.test(context) || /\bcreate\b/.test(context) && hasStrongMutationContext(context)) {
    risk.push("state_mutation");
    evidence.push("name or content suggests state mutation");
  }

  const exportedHighRiskFunction = exportedFunctions.find((name) => isHighRiskCall(name, context));
  if (exportedHighRiskFunction) {
    risk.push("state_mutation");
    evidence.push(`exported function ${exportedHighRiskFunction} suggests state mutation`);
  }

  if (/\b(refund|charge|invoice|email|send|publish|recipientemail|customerid|amountusd|payment|accountid)\b/.test(normalized + "\n" + lowerContent)) {
    risk.push("external_side_effect");
    recommendedCheckDepth = "standard";
    evidence.push("name or content suggests external side effect");
  }

  const sensitiveArgs = extractSensitiveArgumentNames(content);
  if (sensitiveArgs.length > 0) {
    confidence = Math.max(confidence, 0.82);
    evidence.push(`function args include ${sensitiveArgs.join(", ")}`);
  }

  if (label !== "not_agent_related" && risk.length === 0) {
    recommendedCheckDepth = "light";
  }

  if (label === "not_agent_related") {
    evidence.push("no agent-related path or content signals detected");
  }

  const reachabilityProvenance = classifyReachabilityProvenance({ path: filePath });

  const baseSurface = {
    path: filePath,
    label,
    surface_category: surfaceCategoryFor({ filePath, label, content, frameworkConfigSignal, aiSdkToolSignals, toolSchemaSignals }),
    reachability_provenance: reachabilityProvenance.provenance,
    reachability_provenance_reason: reachabilityProvenance.reason,
    confidence: Number(confidence.toFixed(2)),
    risk: [...new Set(risk)],
    evidence: [...new Set(evidence)],
    recommended_check_depth: recommendedCheckDepth
  };
  const actionability = actionabilityDecisionForSurface(baseSurface);
  return {
    ...baseSurface,
    actionability: actionability.actionability,
    actionability_reason: actionability.reason
  };
}

export function buildClassificationReport({ files, repo = process.cwd(), suppressions = [], now = new Date() }) {
  const suppressionState = normalizeSuppressions(suppressions, now);
  const changedSurfaces = files
    .map((file) => applyMappedSurfaceMetadata(classifyChangedFile(file), file.agentMap))
    .map((surface) => attachSurfaceExplanation(surface))
    .map((surface) => applySuppressionToItem(surface, suppressionState));
  const diffAwareFindings = files.flatMap((file) => buildDiffAwareFindings(file)).map((finding) => applySuppressionToItem(finding, suppressionState));
  const mappedPaths = collectMappedSurfacePaths(files[0]?.agentMap);
  const mapDrift = changedSurfaces
    .filter((surface) => surface.label !== "not_agent_related")
    .flatMap((surface) => buildMapDriftFinding({ surface, mappedPaths }))
    .map((finding) => applySuppressionToItem(finding, suppressionState));
  const activeDiffAwareFindings = diffAwareFindings.filter((finding) => !finding.suppressed);
  const activeMapDrift = mapDrift.filter((finding) => !finding.suppressed);
  const suppressedFindings = [...diffAwareFindings, ...mapDrift].filter((finding) => finding.suppressed);

  const status = statusFromFindings([...activeDiffAwareFindings, ...activeMapDrift]);

  return {
    run_id: new Date().toISOString().replace(/[:.]/g, "-"),
    repo,
    mode: "classify",
    status,
    changed_surfaces: changedSurfaces,
    diff_aware_findings: activeDiffAwareFindings,
    map_drift: activeMapDrift,
    suppressed_findings: suppressedFindings,
    suppression_warnings: suppressionState.warnings,
    behavior_findings: [],
    cost: {
      estimated_cost_usd: 0,
      actual_cost_usd: 0
    }
  };
}

export function extractCallsFromUnifiedDiff(diffText = "") {
  const added = [];
  const removed = [];

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      added.push(...extractCallsFromCodeLine(line.slice(1)));
    }
    if (line.startsWith("-")) {
      removed.push(...extractCallsFromCodeLine(line.slice(1)));
    }
  }

  return {
    added_calls: unique(added),
    removed_calls: unique(removed)
  };
}

export function buildAgentMap({ files, repo = process.cwd(), entrypointGlobs = [], entrypointSources = {}, importResolver = {} }) {
  const fileRecords = files.map((file) => ({
    filePath: normalizePath(file.filePath),
    content: file.content ?? ""
  }));
  const normalizedEntrypointSources = normalizeEntrypointSources(entrypointSources);
  const importGraph = buildImportGraph(fileRecords, importResolver);
  const initialSurfaces = fileRecords
    .map((file) => classifyChangedFile(file))
    .map((surface) => applyRepoContext(surface, repo))
    .map((surface) => applyConfiguredEntrypoint(surface, entrypointGlobs, normalizedEntrypointSources));
  const entrypoints = resolveGraphEntrypoints({ surfaces: initialSurfaces, files: fileRecords, entrypointGlobs });
  const reachability = computeReachability(importGraph.edges, entrypoints);
  const importedBy = buildImportedBy(importGraph.edges);

  importGraph.entrypoints = entrypoints;
  importGraph.entrypoint_sources = normalizedEntrypointSources;
  importGraph.reachable_files = [...reachability.reachableFiles].sort();

  const surfaces = initialSurfaces
    .map((surface) => applyReachability(surface, { reachability, importedBy, entrypoints, edges: importGraph.edges }))
    .map((surface) => attachSurfaceExplanation(surface))
    .filter((surface) => surface.label !== "not_agent_related");

  const agents = surfaces
    .filter((surface) => surface.label === "agent_entrypoint")
    .map((surface) => ({
      id: idFromPath(surface.path),
      display_name: displayNameFromPath(surface.path),
      entrypoints: [surface.path],
      prompts: relatedPaths(surfaces, "prompt"),
      tools: relatedPaths(surfaces, "tool_implementation"),
      schemas: relatedPaths(surfaces, "tool_definition"),
      state: surfaces
        .filter((candidate) => candidate.risk.includes("state_mutation"))
        .map((candidate) => ({ path: candidate.path, risk: candidate.risk })),
      model_configs: relatedPaths(surfaces, "model_config"),
      retrievers: relatedPaths(surfaces, "retrieval"),
      memory: [],
      reachable_from_entrypoint: surface.reachable_from_entrypoint,
      risk: [...new Set(surface.risk.length ? surface.risk : ["unknown"])],
      evidence: surface.evidence.map((item) => ({
        type: "classifier",
        path: surface.path,
        detail: item,
        confidence: surface.confidence
      }))
    }));

  return {
    version: "0.1",
    generated_at: new Date().toISOString(),
    repo,
    agents,
    surfaces,
    import_graph: importGraph,
    evidence: surfaces.flatMap((surface) =>
      surface.evidence.map((item) => ({
        type: "classifier",
        path: surface.path,
        label: surface.label,
        detail: item,
        confidence: surface.confidence
      }))
    )
  };
}

export function analyzeTracePair({ baseTrace, headTrace }) {
  const findings = [];
  const baseTools = baseTrace.tool_calls ?? [];
  const headTools = headTrace.tool_calls ?? [];

  findings.push(...compareToolSequence(baseTrace.scenario_id, baseTools, headTools));
  findings.push(...compareCodingAgentBehavior(baseTrace, headTrace));
  findings.push(...findConfirmationRegressions(headTrace.scenario_id, headTools));
  findings.push(...compareState(baseTrace.scenario_id, baseTrace.state_after, headTrace.state_after));
  findings.push(...compareCost(baseTrace.scenario_id, baseTrace, headTrace));

  const explainedFindings = findings.map(attachGenericFindingExplanation);
  const status = statusFromFindings(explainedFindings);

  return {
    run_id: new Date().toISOString().replace(/[:.]/g, "-"),
    mode: "base_head_light",
    status,
    scenario_id: headTrace.scenario_id ?? baseTrace.scenario_id,
    behavior_findings: explainedFindings,
    traces: {
      base: summarizeTrace(baseTrace),
      head: summarizeTrace(headTrace)
    },
    cost: summarizeCost(baseTrace, headTrace)
  };
}

function compareToolSequence(scenarioId, baseTools, headTools) {
  const baseNames = baseTools.map((tool) => tool.name);
  const headNames = headTools.map((tool) => tool.name);

  if (JSON.stringify(baseNames) === JSON.stringify(headNames)) {
    return [];
  }

  const headIntroducedHighRiskTool = headTools.find((tool) => {
    const wasInBase = baseNames.includes(tool.name);
    return !wasInBase && hasHighRiskTag(tool);
  });

  return [
    {
      scenario_id: scenarioId,
      finding_type: "tool_sequence_changed",
      severity: headIntroducedHighRiskTool ? "high" : "medium",
      title: headIntroducedHighRiskTool
        ? `Head introduced high-risk tool: ${headIntroducedHighRiskTool.name}`
        : "Tool sequence changed",
      reason: headIntroducedHighRiskTool
        ? "The head trace calls a high-risk tool that base did not call."
        : "The agent changed which tools it calls for the same scenario.",
      evidence: [
        `base tools: ${baseNames.length ? baseNames.join(" -> ") : "none"}`,
        `head tools: ${headNames.length ? headNames.join(" -> ") : "none"}`
      ],
      recommendation: headIntroducedHighRiskTool
        ? "Block merge unless this new high-risk action is intentional and covered by a scenario."
        : "Review whether the changed tool sequence is intended."
    }
  ];
}

function findConfirmationRegressions(scenarioId, tools) {
  return tools
    .filter((tool) => tool.requires_confirmation === true && tool.confirmed !== true)
    .map((tool) => ({
      scenario_id: scenarioId,
      finding_type: "missing_confirmation",
      severity: hasHighRiskTag(tool) ? "critical" : "high",
      title: `${tool.name} ran without required confirmation`,
      reason: "The trace marks this tool as requiring confirmation, but the head run did not confirm it.",
      evidence: [
        `tool: ${tool.name}`,
        `risk tags: ${(tool.risk ?? []).join(", ") || "none"}`,
        `args: ${stableStringify(tool.args ?? {})}`
      ],
      recommendation: "Require explicit confirmation before this tool executes, or change the scenario expectation if this behavior is intended."
    }));
}

function compareState(scenarioId, baseState, headState) {
  const diffs = diffObjects(baseState ?? {}, headState ?? {});
  const importantDiffs = diffs.filter((diff) => {
    const path = diff.path.toLowerCase();
    return path.includes("status") || path.includes("refund") || path.includes("amount") || path.includes("assignee");
  });

  if (importantDiffs.length === 0) {
    return [];
  }

  return [
    {
      scenario_id: scenarioId,
      finding_type: "state_diff",
      severity: "high",
      title: "Head changed important state differently than base",
      reason: "The same scenario produced different durable state after execution.",
      evidence: importantDiffs.slice(0, 5).map((diff) => `${diff.path}: base=${stableStringify(diff.base)} head=${stableStringify(diff.head)}`),
      recommendation: "Review the state mutation. Add a deterministic expectation if this field must not change."
    }
  ];
}

function compareCost(scenarioId, baseTrace, headTrace) {
  const baseCost = totalCost(baseTrace);
  const headCost = totalCost(headTrace);
  if (baseCost <= 0 || headCost <= baseCost * 1.25) {
    return [];
  }

  return [
    {
      scenario_id: scenarioId,
      finding_type: "cost_regression",
      severity: "medium",
      title: "Head run cost increased",
      reason: "The head trace cost is more than 25% higher than base.",
      evidence: [
        `base cost: $${baseCost.toFixed(4)}`,
        `head cost: $${headCost.toFixed(4)}`
      ],
      recommendation: "Check model choice, retry behavior, prompt size, and scenario selection."
    }
  ];
}

function statusFromFindings(findings) {
  if (findings.some((finding) => finding.severity === "critical")) return "fail";
  if (findings.some((finding) => finding.severity === "high")) return "action_required";
  if (findings.some((finding) => finding.severity === "medium")) return "warn";
  return "pass";
}

function recommendationForSurface(surface) {
  if (surface.actionability === "likely_noise") {
    return "Keep as context unless this surface is directly changed or configured as runtime agent code.";
  }

  if (surface.actionability === "context_only") {
    return "Treat as context. Review only if this PR intentionally changes test harness, examples, or evaluation behavior.";
  }

  if (surface.risk.includes("external_side_effect")) {
    return "Add or update a scenario before merge. External side effects should not ship without a behavior check.";
  }

  if (surface.label === "prompt") {
    return "Run at least a light behavior check because prompt edits can change tool choice and policy behavior.";
  }

  if (surface.label === "model_config") {
    return "Review cost, latency, and model capability impact before merge.";
  }

  return "Review whether this surface belongs in .agentdiff/map.json.";
}

export function classifyReachabilityProvenance({ path: filePath = "", chain = [], reachableEntryPoints = [] } = {}) {
  const paths = unique([...chain, ...reachableEntryPoints, filePath].filter(Boolean)).map((item) => normalizePath(item).toLowerCase());
  const checks = [
    ["generated", isGeneratedPath],
    ["archive", isArchivePath],
    ["docs", isDocsPath],
    ["config", isConfigProvenancePath],
    ["test", isTestOrFixturePath],
    ["example", isExamplePath]
  ];

  for (const [provenance, predicate] of checks) {
    const matched = paths.find((item) => predicate(item));
    if (matched) return { provenance, reason: `${provenance} path matched ${matched}` };
  }

  const runtimePath = paths.find((item) => isRuntimePath(item));
  if (runtimePath) return { provenance: "runtime", reason: `runtime path matched ${runtimePath}` };
  if (paths.length > 0) return { provenance: "unknown", reason: `no runtime/test/example/docs/archive/generated/config pattern matched ${paths[0]}` };
  return { provenance: "unknown", reason: "no reachability path available" };
}

function actionabilityDecisionForSurface(surface) {
  const hasHighRisk = (surface.risk ?? []).some((risk) => HIGH_RISK_TAGS.has(risk));
  const provenance = surface.reachability_provenance ?? "unknown";

  if (isGeneratedDocsContext(surface)) {
    return {
      actionability: "likely_noise",
      reason: "generated_docs_context: generated docs/search/config data is not urgent runtime behavior unless explicitly configured as an entrypoint"
    };
  }

  if (isFrontendUiContext(surface)) {
    return {
      actionability: "context_only",
      reason: "frontend_ui_context: frontend/UI state surfaces are context unless they are API or tool execution boundaries"
    };
  }

  if (isExampleTemplateContext(surface) && !isExplicitProductionEntrypoint(surface)) {
    return {
      actionability: hasHighRisk ? "review_recommended" : "context_only",
      reason: "example_template_context: examples, templates, starters, courses, workshops, and demos are visible but not production-urgent by default"
    };
  }

  if (isGenericServerCrudContext(surface)) {
    return {
      actionability: hasHighRisk ? "context_only" : "likely_noise",
      reason: "generic_server_crud_context: generic API/server CRUD routes need agent/tool/framework evidence before becoming action_required"
    };
  }

  if (isConfigHelperContext(surface) && !hasExecutableToolBoundary(surface)) {
    return {
      actionability: hasHighRisk ? "review_recommended" : "context_only",
      reason: "config_helper_context: config/helper/SDK internals are not urgent unless they define or execute a tool, agent, or workflow boundary"
    };
  }

  if (provenance === "test") {
    return { actionability: "context_only", reason: "test_context: test and fixture surfaces are context-only by default" };
  }

  if (["docs", "config", "generated", "archive"].includes(provenance)) {
    return {
      actionability: "likely_noise",
      reason: `${provenance}_context: ${provenance} surfaces are not urgent runtime behavior by default`
    };
  }

  if (provenance === "example" && hasHighRisk) {
    return {
      actionability: "review_recommended",
      reason: "example_template_context: high-risk example surfaces are reviewable but not production-urgent by default"
    };
  }

  if (provenance === "runtime" && hasHighRisk && hasActionRequiredEvidence(surface)) {
    return {
      actionability: "action_required",
      reason: "runtime_tool_execution_context: runtime surface has agent/tool execution evidence and strong side-effect evidence"
    };
  }

  if (provenance === "runtime" && hasHighRisk) {
    return {
      actionability: "review_recommended",
      reason: "weak_runtime_evidence_context: runtime path has risk words but lacks enough executable agent/tool side-effect evidence for action_required"
    };
  }

  if (hasHighRisk) {
    return {
      actionability: surface.reachable_from_entrypoint ? "review_recommended" : "context_only",
      reason: "weak_runtime_evidence_context: high-risk wording is visible but not proven urgent runtime agent behavior"
    };
  }

  if (surface.label !== "not_agent_related") {
    return { actionability: "context_only", reason: "agent_context_without_high_risk: agent-related surface has no high-risk behavior evidence" };
  }

  return { actionability: "likely_noise", reason: "no_agent_context: no agent-related surface evidence" };
}

function hasActionRequiredEvidence(surface) {
  return hasExecutableToolBoundary(surface) && hasStrongSideEffectEvidence(surface);
}

function hasExecutableToolBoundary(surface) {
  const normalized = normalizePath(surface.path ?? "").toLowerCase();
  const label = surface.label ?? "";
  const category = surface.surface_category ?? "";
  const evidence = (surface.evidence ?? []).join("\n").toLowerCase();

  return (
    surface.configured_entrypoint === true ||
    surface.reachable_from_entrypoint === true ||
    ["agent_entrypoint", "tool_implementation"].includes(label) ||
    ["runtime_agent", "tool_implementation", "ai_sdk_tool", "tool_schema", "browser_tool", "framework_config"].includes(category) ||
    matchesAny(normalized, ["/agents/", "/agent/", "/tools/", "/tool/", "/workflows/", "/workflow/", "/mastra/", "/langgraph", "/mcp", "/github-tools", "/gitlab"]) ||
    /\b(model-call pattern|tool\/schema pattern|tool syntax|tool schema|agent factory|stategraph|mastra runtime|langgraph graph)\b/.test(evidence)
  );
}

function hasStrongSideEffectEvidence(surface) {
  const risk = surface.risk ?? [];
  const evidence = (surface.evidence ?? []).join("\n").toLowerCase();
  const normalized = normalizePath(surface.path ?? "").toLowerCase();
  return (
    risk.some((item) => ["external_side_effect", "money_movement", "destructive", "customer_visible"].includes(item)) ||
    /\b(exported function .*suggests state mutation|function args include|ai sdk tool syntax: execute|openai tool schema|anthropic tool schema|external side effect|refund|charge|invoice|email|recipient|customer|payment|account|send|delete|close|publish|approve|revoke|grant)\b/.test(evidence) ||
    /\b(refund|charge|invoice|email|payment|github|gitlab|slack|browser|mcp)\b/.test(normalized)
  );
}

function isGeneratedDocsContext(surface) {
  const normalized = normalizePath(surface.path ?? "").toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  return (
    normalized.includes("/.agentdiff/") ||
    normalized.startsWith(".agentdiff/") ||
    normalized.includes("/.agents/") ||
    normalized.startsWith(".agents/") ||
    basename === "search-index.json" ||
    normalized.includes("/search-index.") ||
    normalized.includes("/docs-data/") ||
    normalized.includes("/docs/data/") ||
    normalized.includes("/web/src/data/") ||
    ([".json", ".yaml", ".yml"].some((extension) => basename.endsWith(extension)) && !isExplicitRuntimeConfig(surface))
  );
}

function isFrontendUiContext(surface) {
  const normalized = normalizePath(surface.path ?? "").toLowerCase();
  if (isApiOrToolExecutionPath(normalized)) return false;
  return (
    normalized.includes("/frontend/") ||
    normalized.startsWith("frontend/") ||
    normalized.includes("/renderer/") ||
    normalized.startsWith("renderer/") ||
    normalized.includes("/components/") ||
    normalized.startsWith("components/") ||
    normalized.includes("/ui/") ||
    normalized.startsWith("ui/") ||
    normalized.includes("/web/src/")
  );
}

function isExampleTemplateContext(surface) {
  const normalized = normalizePath(surface.path ?? "").toLowerCase();
  const repoContext = normalizePath(surface.repo_context ?? "").toLowerCase();
  return isExamplePath(normalized) || isExamplePath(repoContext);
}

function isExplicitProductionEntrypoint(surface) {
  return surface.configured_entrypoint === true && surface.entrypoint_source === "agentdiff.yml";
}

function isConfigHelperContext(surface) {
  const normalized = normalizePath(surface.path ?? "").toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  return (
    matchesAny(basename, ["config", "schema", "types", "session", "constants", "provider", "adapter", "selector", "matcher"]) ||
    matchesAny(normalized, ["/config/", "/schemas/", "/types/", "/providers/", "/adapters/", "/selectors/", "/sessions/"])
  );
}

function isGenericServerCrudContext(surface) {
  const normalized = normalizePath(surface.path ?? "").toLowerCase();
  if (!isServerApiRoutePath(normalized)) return false;
  if (matchesAny(normalized, ["agent", "tool", "workflow", "mastra", "langgraph", "mcp", "github", "gitlab"])) return false;
  const evidence = (surface.evidence ?? []).join("\n").toLowerCase();
  if (/\b(model-call pattern|tool\/schema pattern|tool syntax|tool schema|agent factory|stategraph|mastra runtime|langgraph graph)\b/.test(evidence)) return false;
  return true;
}

function isServerApiRoutePath(normalized) {
  return (
    normalized.includes("/app/api/") ||
    normalized.startsWith("app/api/") ||
    normalized.includes("/server/") ||
    normalized.startsWith("server/") ||
    normalized.includes("/routes/") ||
    normalized.startsWith("routes/")
  );
}

function isApiOrToolExecutionPath(normalized) {
  return (
    normalized.includes("/app/api/") ||
    normalized.startsWith("app/api/") ||
    normalized.includes("/server/") ||
    normalized.startsWith("server/") ||
    normalized.includes("/tools/") ||
    normalized.includes("/tool/") ||
    normalized.includes("/mcp")
  );
}

function isExplicitRuntimeConfig(surface) {
  const basename = normalizePath(surface.path ?? "").toLowerCase().split("/").pop() ?? "";
  return surface.configured_entrypoint === true || basename === "langgraph.json";
}

function applyRepoContext(surface, repo = "") {
  const normalizedRepo = normalizePath(repo).toLowerCase();
  if (!normalizedRepo || !isExamplePath(normalizedRepo)) return surface;
  const evidence = [...surface.evidence, `repo context suggests example/template/demo: ${repo}`];
  const withContext = {
    ...surface,
    repo_context: normalizedRepo,
    evidence: unique(evidence)
  };
  const actionability = actionabilityDecisionForSurface(withContext);
  return {
    ...withContext,
    actionability: actionability.actionability,
    actionability_reason: actionability.reason
  };
}

function isTestOrFixturePath(pathName) {
  return (
    pathName.includes("/__tests__/") ||
    pathName.startsWith("__tests__/") ||
    pathName.includes("/test/") ||
    pathName.startsWith("test/") ||
    pathName.includes("/tests/") ||
    pathName.startsWith("tests/") ||
    pathName.includes("/integration-tests/") ||
    pathName.startsWith("integration-tests/") ||
    pathName.includes("/e2e/") ||
    pathName.startsWith("e2e/") ||
    pathName.includes("/fixtures/") ||
    pathName.startsWith("fixtures/") ||
    /\.[a-z]*test\.[^.]+$/.test(pathName) ||
    /\.[a-z]*spec\.[^.]+$/.test(pathName) ||
    /\.test\./.test(pathName) ||
    /\.spec\./.test(pathName) ||
    /\.test-/.test(pathName) ||
    /\.spec-/.test(pathName)
  );
}

function isDocsPath(pathName) {
  const basename = pathName.split("/").pop() ?? pathName;
  if (pathName.includes("/docs/") || pathName.startsWith("docs/") || pathName.includes("/website/") || pathName.startsWith("website/")) return true;
  if (["readme.md", "changelog.md"].includes(basename)) return true;
  if ((pathName.endsWith(".md") || pathName.endsWith(".mdx")) && !isExplicitAgentInstructionPath(pathName)) return true;
  return false;
}

function isExplicitAgentInstructionPath(pathName) {
  const basename = pathName.split("/").pop() ?? pathName;
  return basename === "agents.md" || basename === "agent.md" || basename.includes(".agent.");
}

function isArchivePath(pathName) {
  return (
    pathName.includes("/archive/") ||
    pathName.startsWith("archive/") ||
    pathName.includes("/deprecated/") ||
    pathName.startsWith("deprecated/") ||
    pathName.includes("/legacy/") ||
    pathName.startsWith("legacy/")
  );
}

function isGeneratedPath(pathName) {
  const basename = pathName.split("/").pop() ?? pathName;
  return (
    pathName.includes("/generated/") ||
    pathName.startsWith("generated/") ||
    pathName.includes(".gen.") ||
    /routetree\.gen\./.test(pathName) ||
    basename === "search-index.json" ||
    pathName.includes("/web/src/data/")
  );
}

function isExamplePath(pathName) {
  return (
    pathName.includes("/examples/") ||
    pathName.startsWith("examples/") ||
    pathName.includes("/example/") ||
    pathName.startsWith("example/") ||
    pathName.includes("/demo/") ||
    pathName.startsWith("demo/") ||
    pathName.includes("/sample/") ||
    pathName.startsWith("sample/") ||
    pathName.includes("/starter/") ||
    pathName.startsWith("starter/") ||
    pathName.includes("/template/") ||
    pathName.startsWith("template/") ||
    pathName.includes("/workshop/") ||
    pathName.startsWith("workshop/") ||
    pathName.includes("/course/") ||
    pathName.startsWith("course/") ||
    /(^|[/_-])(example|template|starter|workshop|course|demo)([/_-]|$)/.test(pathName)
  );
}

function isConfigProvenancePath(pathName) {
  const basename = pathName.split("/").pop() ?? pathName;
  return (
    pathName.includes("/.github/") ||
    pathName.startsWith(".github/") ||
    pathName.includes("/.agents/") ||
    pathName.startsWith(".agents/") ||
    basename === "package.json" ||
    basename === "tsconfig.json" ||
    basename === "jsconfig.json" ||
    basename.startsWith("typedoc.") ||
    basename.includes(".config.") ||
    ((basename.endsWith(".json") || basename.endsWith(".yaml") || basename.endsWith(".yml")) && basename !== "langgraph.json") ||
    basename === "package-lock.json" ||
    basename === "pnpm-lock.yaml" ||
    basename === "yarn.lock" ||
    basename === "bun.lockb"
  );
}

function isRuntimePath(pathName) {
  return (
    pathName.includes("/app/api/") ||
    pathName.startsWith("app/api/") ||
    pathName.includes("/server/") ||
    pathName.startsWith("server/") ||
    pathName.includes("/src/") ||
    pathName.startsWith("src/") ||
    /(^|\/)packages\/[^/]+\/src\//.test(pathName) ||
    pathName.includes("/lib/") ||
    pathName.startsWith("lib/") ||
    pathName.includes("/routes/") ||
    pathName.includes("/workflows/") ||
    pathName.includes("/agents/") ||
    pathName.includes("/tools/")
  );
}

function compareCodingAgentBehavior(baseTrace, headTrace) {
  const baseFiles = baseTrace.files_changed ?? [];
  const headFiles = headTrace.files_changed ?? [];
  if (baseFiles.length === 0 && headFiles.length === 0) return [];

  const basePaths = baseFiles.map((file) => file.path);
  const headPaths = headFiles.map((file) => file.path);
  const headTestFiles = headFiles.filter((file) => isTestPath(file.path));
  const baseImplementationFiles = baseFiles.filter((file) => !isTestPath(file.path));
  const headImplementationFiles = headFiles.filter((file) => !isTestPath(file.path));

  if (samePathSet(basePaths, headPaths)) {
    return [];
  }

  if (headTestFiles.length > 0 && baseImplementationFiles.length > 0 && headImplementationFiles.length === 0) {
    return [
      {
        scenario_id: headTrace.scenario_id ?? baseTrace.scenario_id,
        finding_type: "suspicious_coding_agent_fix",
        severity: "high",
        title: "Suspicious coding-agent fix",
        reason: "The head agent appears to make tests pass by changing test files instead of fixing implementation behavior.",
        evidence: [
          `base changed: ${basePaths.join(", ")}`,
          `head changed: ${headPaths.join(", ")}`,
          `head test files modified: ${headTestFiles.map((file) => file.path).join(", ")}`,
          ...summarizeTests("base", baseTrace.tests_run ?? []),
          ...summarizeTests("head", headTrace.tests_run ?? []),
          ...summarizeCommands("head", headTrace.commands_run ?? [])
        ],
        recommendation: "Block merge unless the test change is intentional. Prefer an implementation fix and add an approval scenario for this behavior."
      }
    ];
  }

  return [
    {
      scenario_id: headTrace.scenario_id ?? baseTrace.scenario_id,
      finding_type: "coding_agent_file_diff",
      severity: "medium",
      title: "Coding-agent file changes differ",
      reason: "The base and head agent traces changed different files for the same scenario.",
      evidence: [
        `base changed: ${basePaths.join(", ") || "none"}`,
        `head changed: ${headPaths.join(", ") || "none"}`
      ],
      recommendation: "Review whether the changed file set matches the requested fix."
    }
  ];
}

function normalizeSuppressions(suppressions = [], now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const warnings = [];
  const active = [];

  for (const suppression of suppressions ?? []) {
    if (!suppression?.path) continue;
    const normalized = {
      path: normalizePath(suppression.path),
      reason: suppression.reason,
      expires: suppression.expires
    };

    if (!normalized.reason) {
      warnings.push(`ignore ${normalized.path} is missing required reason`);
      continue;
    }

    if (!normalized.expires) {
      warnings.push(`ignore ${normalized.path} is missing expires`);
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized.expires)) {
      warnings.push(`ignore ${normalized.path} has invalid expires date ${normalized.expires}`);
    } else if (normalized.expires < today) {
      warnings.push(`ignore ${normalized.path} expired on ${normalized.expires}`);
      continue;
    }

    active.push(normalized);
  }

  return { active, warnings };
}

function applySuppressionToItem(item, suppressionState) {
  const suppression = suppressionState.active.find((candidate) => globToRegex(candidate.path).test(normalizePath(item.path ?? "")));
  if (!suppression) return item;
  return {
    ...item,
    suppressed: true,
    suppression: {
      path: suppression.path,
      reason: suppression.reason,
      expires: suppression.expires
    }
  };
}

function attachSurfaceExplanation(surface) {
  return {
    ...surface,
    explanation: buildSurfaceExplanation(surface)
  };
}

function buildSurfaceExplanation(surface) {
  const whyFlagged = [];
  if (surface.reachable_from_entrypoint) {
    whyFlagged.push(`reachable from agent entrypoint ${(surface.reachable_entrypoints ?? []).join(", ") || surface.path}`);
  }
  for (const importer of surface.imported_by ?? []) {
    whyFlagged.push(`imported by ${importer.path}`);
  }
  whyFlagged.push(`classified as ${surface.label}`);
  if (surface.surface_category) whyFlagged.push(`surface category: ${surface.surface_category}`);
  if (surface.reachability_provenance) {
    whyFlagged.push(`reachability provenance: ${surface.reachability_provenance}`);
  }
  if (surface.actionability_reason) {
    whyFlagged.push(surface.actionability_reason);
  }

  const riskEvidence = riskEvidenceForSurface(surface);
  const reachabilityChain = surface.reachability_chain?.length
    ? surface.reachability_chain
    : surface.reachable_from_entrypoint
      ? [surface.reachable_entrypoints?.[0], surface.path].filter(Boolean)
      : [];

  return {
    why_flagged: unique([...whyFlagged, ...surface.evidence.slice(0, 4)]),
    reachability_chain: unique(reachabilityChain),
    risk_evidence: riskEvidence,
    confidence_reason: confidenceReasonForSurface(surface)
  };
}

function riskEvidenceForSurface(surface) {
  const items = [];
  for (const item of surface.evidence ?? []) {
    if (/(risk|mutation|side effect|args include|high-risk|send|email|refund|charge|delete|close|write|update|recipient|amount|customer)/i.test(item)) {
      items.push(item);
    }
  }
  if ((surface.risk ?? []).length > 0) items.push(`risk tags: ${surface.risk.join(", ")}`);
  return unique(items);
}

function confidenceReasonForSurface(surface) {
  if (surface.actionability_reason) {
    return surface.actionability_reason;
  }
  if (surface.actionability === "likely_noise") {
    return `low because this surface is ${surface.reachability_provenance ?? "non-runtime"}-reachable and should not be treated as urgent runtime risk`;
  }
  if (surface.actionability === "context_only") {
    return `context-only because this surface is ${surface.reachability_provenance ?? "not clearly runtime"}-reachable`;
  }
  if (surface.actionability === "review_recommended") {
    return `medium because this is ${surface.reachability_provenance ?? "non-production"}-reachable high-risk behavior`;
  }
  if (surface.actionability === "action_required") {
    return "high because this is runtime-reachable high-risk behavior";
  }
  if (surface.confidence >= 0.85 && surface.reachable_from_entrypoint) {
    return `high because this surface is reachable from an entrypoint and has ${surface.label} evidence`;
  }
  if (surface.confidence <= 0.45 && isLowSignalCategory(surface.surface_category)) {
    return `low because this looks like ${surface.surface_category} and is not proven reachable from runtime agent code`;
  }
  if (surface.confidence >= 0.75) {
    return `medium-high because this surface has ${surface.label} signals`;
  }
  return "low until agentdiff sees stronger runtime, tool, or reachability evidence";
}

function explanationForDiffAwareFinding(finding) {
  return {
    why_flagged: unique([
      `classified as ${finding.finding_type}`,
      ...finding.added_high_risk_calls.map((call) => `added high-risk call: ${call}`),
      ...finding.removed_safer_calls.map((call) => `removed safer/guardrail call: ${call}`)
    ]),
    reachability_chain: [finding.path],
    risk_evidence: finding.evidence,
    confidence_reason: finding.severity === "high" ? "high because this diff adds high-risk calls inside a changed surface" : "medium because this diff changes guardrail behavior"
  };
}

function explanationForFindingFromSurface(surface) {
  return surface.explanation ?? buildSurfaceExplanation(surface);
}

function attachGenericFindingExplanation(finding) {
  if (finding.explanation) return finding;
  return {
    ...finding,
    explanation: {
      why_flagged: unique([`classified as ${finding.finding_type}`, finding.reason, ...(finding.evidence ?? []).slice(0, 3)].filter(Boolean)),
      reachability_chain: finding.path ? [finding.path] : [],
      risk_evidence: (finding.evidence ?? []).filter((item) => /(risk|tool|state|cost|confirmation|test|changed)/i.test(item)),
      confidence_reason: `severity ${finding.severity} because the recorded trace evidence matched ${finding.finding_type}`
    }
  };
}

function samePathSet(left, right) {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left.map((item) => item.replaceAll("\\", "/")));
  return right.every((item) => leftSet.has(item.replaceAll("\\", "/")));
}

function isTestPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/test/") || normalized.includes(".test.") || normalized.includes(".spec.");
}

function summarizeTests(prefix, tests) {
  return tests.map((test) => `${prefix} test: ${test.command} (${test.status})`);
}

function summarizeCommands(prefix, commands) {
  return commands.slice(0, 5).map((command) => `${prefix} command: ${command}`);
}

function buildMapDriftFinding({ surface, mappedPaths }) {
  const isMapped = mappedPaths.has(normalizePath(surface.path));
  const severity = severityForSurface(surface);

  if (mappedPaths.size > 0 && !isMapped) {
    return [
      {
        finding_type: "new_unmapped_agent_surface",
        severity,
        title: titleForUnmappedSurface(surface),
        path: surface.path,
        label: surface.label,
        surface_category: surface.surface_category,
        risk: surface.risk,
        reachable_from_entrypoint: surface.reachable_from_entrypoint,
        reachability_provenance: surface.reachability_provenance,
        reachability_provenance_reason: surface.reachability_provenance_reason,
        actionability: surface.actionability,
        reachable_entrypoints: surface.reachable_entrypoints,
        reachability_chain: surface.reachability_chain,
        imported_by: surface.imported_by,
        evidence: surface.evidence,
        explanation: explanationForFindingFromSurface(surface),
        recommendation: recommendationForUnmappedSurface(surface)
      }
    ];
  }

  return [
    {
      finding_type: "changed_agent_surface",
      severity,
      title: "Mapped agent surface changed",
      path: surface.path,
      label: surface.label,
      surface_category: surface.surface_category,
      risk: surface.risk,
      reachable_from_entrypoint: surface.reachable_from_entrypoint,
      reachability_provenance: surface.reachability_provenance,
      reachability_provenance_reason: surface.reachability_provenance_reason,
      actionability: surface.actionability,
      reachable_entrypoints: surface.reachable_entrypoints,
      reachability_chain: surface.reachability_chain,
      imported_by: surface.imported_by,
      evidence: surface.evidence,
      explanation: explanationForFindingFromSurface(surface),
      recommendation: recommendationForSurface(surface)
    }
  ];
}

function applyMappedSurfaceMetadata(surface, agentMap) {
  const mapped = (agentMap?.surfaces ?? []).find((candidate) => normalizePath(candidate.path) === normalizePath(surface.path));
  if (!mapped) return surface;
  const evidence = [...surface.evidence];
  if (mapped.reachable_from_entrypoint) {
    evidence.push(`reachable from entrypoint: ${(mapped.reachable_entrypoints ?? []).join(", ")}`);
  }
  return {
    ...surface,
    surface_category: mapped.surface_category ?? surface.surface_category,
    evidence: unique(evidence),
    reachable_from_entrypoint: mapped.reachable_from_entrypoint ?? surface.reachable_from_entrypoint ?? false,
    reachable_entrypoints: mapped.reachable_entrypoints ?? surface.reachable_entrypoints ?? [],
    reachability_chain: mapped.reachability_chain ?? surface.reachability_chain ?? [],
    imported_by: mapped.imported_by ?? surface.imported_by ?? [],
    reachability_provenance: mapped.reachability_provenance ?? surface.reachability_provenance,
    reachability_provenance_reason: mapped.reachability_provenance_reason ?? surface.reachability_provenance_reason,
    actionability: mapped.actionability ?? surface.actionability,
    actionability_reason: mapped.actionability_reason ?? surface.actionability_reason,
    repo_context: mapped.repo_context ?? surface.repo_context
  };
}

function severityForSurface(surface) {
  if (surface.actionability && ACTIONABILITY_TO_SEVERITY[surface.actionability]) {
    return ACTIONABILITY_TO_SEVERITY[surface.actionability];
  }
  if (!surface.reachable_from_entrypoint && isDocLikeSurface(surface)) return "low";
  if (surface.reachable_from_entrypoint && surface.label === "tool_implementation" && surface.risk.includes("external_side_effect")) return "high";
  if (surface.label === "tool_implementation" && surface.risk.includes("external_side_effect")) return "high";
  if (surface.risk.includes("external_side_effect")) return surface.reachable_from_entrypoint ? "high" : "medium";
  return "medium";
}

function titleForUnmappedSurface(surface) {
  if (surface.label === "tool_implementation" && surface.risk.includes("external_side_effect")) {
    return `New unmapped high-risk tool: ${surface.path}`;
  }

  return `New unmapped agent surface: ${surface.path}`;
}

function recommendationForUnmappedSurface(surface) {
  if (surface.label === "tool_implementation") {
    return "Add this tool to .agentdiff/map.json and create a scenario before merge.";
  }

  return "Add this surface to .agentdiff/map.json or ignore it with a reason and expiration.";
}

function collectMappedSurfacePaths(agentMap) {
  const paths = new Set();
  if (!agentMap) return paths;

  for (const surface of agentMap.surfaces ?? []) {
    if (surface.path) paths.add(normalizePath(surface.path));
  }

  for (const agent of agentMap.agents ?? []) {
    for (const entrypoint of agent.entrypoints ?? []) paths.add(normalizePath(entrypoint));
    for (const collectionName of ["prompts", "tools", "schemas", "state", "model_configs", "retrievers", "memory"]) {
      for (const item of agent[collectionName] ?? []) {
        if (typeof item === "string") paths.add(normalizePath(item));
        if (item?.path) paths.add(normalizePath(item.path));
      }
    }
  }

  return paths;
}

function buildDiffAwareFindings(file) {
  if (!file.diffText) return [];

  const calls = extractCallsFromUnifiedDiff(file.diffText);
  const addedHighRiskCalls = calls.added_calls.filter((call) => isHighRiskCall(call));
  const removedSaferCalls = calls.removed_calls.filter(isSaferCall);

  if (calls.added_calls.length === 0 && calls.removed_calls.length === 0) {
    return [];
  }

  if (addedHighRiskCalls.length === 0 && removedSaferCalls.length === 0) {
    return [];
  }

  const severity = addedHighRiskCalls.length > 0 ? "high" : "medium";
  const evidence = [
    ...addedHighRiskCalls.map((call) => `added high-risk call: ${call}`),
    ...removedSaferCalls.map((call) => `removed safer call: ${call}`)
  ];

  return [
    {
      type: "behavior_surface_change",
      finding_type: "behavior_surface_change",
      path: file.filePath,
      severity,
      title: addedHighRiskCalls.length > 0 ? "High-risk agent behavior added" : "Agent behavior guardrail changed",
      added_calls: calls.added_calls,
      removed_calls: calls.removed_calls,
      added_high_risk_calls: addedHighRiskCalls,
      removed_safer_calls: removedSaferCalls,
      evidence,
      explanation: explanationForDiffAwareFinding({
        finding_type: "behavior_surface_change",
        path: file.filePath,
        severity,
        added_high_risk_calls: addedHighRiskCalls,
        removed_safer_calls: removedSaferCalls,
        evidence
      }),
      reason: reasonForDiffAwareFinding({ addedHighRiskCalls, removedSaferCalls }),
      recommendation: "Review before merge. Add confirmation, policy checks, or an approval scenario if this behavior is intended."
    }
  ];
}

function extractCallsFromCodeLine(line) {
  const calls = [];
  const regex = /\b(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*\(/g;
  let match;

  while ((match = regex.exec(line)) !== null) {
    const call = match[1];
    if (!call || IGNORED_CALLS.has(call)) continue;
    calls.push(call);
  }

  return calls;
}

function extractExportedFunctionNames(content) {
  const names = [];
  const regex = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    names.push(match[1]);
  }

  return unique(names);
}

function extractSensitiveArgumentNames(content) {
  const sensitiveWords = ["email", "amount", "customerid", "invoiceid", "payment", "accountid"];
  const args = [];
  const functionSignatureRegex = /\bfunction\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g;
  let match;

  while ((match = functionSignatureRegex.exec(content)) !== null) {
    const identifiers = match[1].match(/[A-Za-z_$][\w$]*/g) ?? [];
    for (const identifier of identifiers) {
      const normalized = identifier.toLowerCase();
      if (sensitiveWords.some((word) => normalized.includes(word))) {
        args.push(identifier);
      }
    }
  }

  return unique(args);
}

function isHighRiskCall(call, context = "") {
  const normalized = call.toLowerCase();
  if (normalized.includes("create")) return hasStrongMutationContext(`${normalized}\n${context}`);
  return HIGH_RISK_CALL_WORDS.filter((word) => word !== "create").some((word) => normalized.includes(word));
}

function hasStrongMutationContext(context) {
  return /\b(tool|schema|state|store|database|db|write|delete|send|email|refund|charge|invoice|payment|customer|account|ticket|publish|approve|reject|grant|revoke|mutation)\b/.test(
    context.toLowerCase()
  );
}

function frameworkConfigSignalFor({ normalized, basename, lowerContent }) {
  if (basename === "langgraph.json") {
    return {
      category: "framework_config",
      confidence: 0.84,
      evidence: "framework config detected: langgraph.json"
    };
  }

  if (
    normalized.includes("/src/mastra/index.") ||
    normalized.includes("/src/mastra/agents/") ||
    normalized.includes("/src/mastra/tools/") ||
    normalized.includes("/src/mastra/workflows/")
  ) {
    return {
      category: "framework_config",
      confidence: lowerContent.includes("@mastra/") || lowerContent.includes("new mastra") ? 0.84 : 0.74,
      evidence: "Mastra runtime path detected under src/mastra"
    };
  }

  return null;
}

function aiSdkToolSignalsFor(content = "") {
  const signals = [];
  const patterns = [
    [/\btool\s*\(/, "AI SDK tool syntax: tool(...)"],
    [/\bcreateTool\s*\(/, "AI SDK tool syntax: createTool(...)"],
    [/\bdefineTool\s*\(/, "AI SDK tool syntax: defineTool(...)"],
    [/\btools\s*:/, "AI SDK tool syntax: tools:"],
    [/\bparameters\s*:/, "AI SDK tool syntax: parameters:"],
    [/\bexecute\s*:/, "AI SDK tool syntax: execute:"],
    [/import\s+type\s+\{[^}]*\bTool\b[^}]*\}\s+from\s+["']ai["']/i, "AI SDK tool type import: Tool from ai"],
    [/from\s+["']ai["'][\s\S]{0,1200}\bcreate\w*Agent\b/i, "AI SDK import with agent factory syntax"]
  ];
  for (const [regex, evidence] of patterns) {
    if (regex.test(content)) signals.push(evidence);
  }
  return unique(signals);
}

function toolSchemaSignalsFor(content = "") {
  const signals = [];
  if (/type\s*:\s*["']function["']/i.test(content)) signals.push('OpenAI tool schema syntax: type: "function"');
  if (/function\s*:\s*\{[\s\S]{0,400}\bname\s*:/i.test(content) && /function\s*:\s*\{[\s\S]{0,600}\bparameters\s*:/i.test(content)) {
    signals.push("OpenAI tool schema syntax: function { name, parameters }");
  }
  if (/\binput_schema\s*:/i.test(content)) signals.push("Anthropic tool schema syntax: input_schema");
  return unique(signals);
}

function surfaceCategoryFor({ filePath, label, content = "", frameworkConfigSignal = null, aiSdkToolSignals = [], toolSchemaSignals = [] }) {
  const normalized = normalizePath(filePath).toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  const lowerContent = content.toLowerCase();

  if (isDocPath(normalized)) return "docs_example";
  if (isTestPath(normalized) || normalized.includes("/__tests__/") || normalized.includes("/fixtures/") || normalized.includes("/fixture/")) return "test_fixture";
  if (frameworkConfigSignal) return "framework_config";
  if (toolSchemaSignals.length > 0) return "tool_schema";
  if (aiSdkToolSignals.length > 0) return "ai_sdk_tool";
  if (isConfigPath(normalized)) return "config_metadata";
  if ((normalized.includes("browser") || lowerContent.includes("browser")) && (normalized.includes("/tools/") || label === "tool_implementation")) return "browser_tool";
  if (matchesAny(normalized, ["checkpoint", "memory", "postgres", "store", "persistence"])) return "persistence";
  if (matchesAny(basename, ["utils.ts", "utils.js", "util.ts", "util.js", "helpers.ts", "helpers.js"])) return "helper_utility";
  if (label === "agent_entrypoint") return "runtime_agent";
  if (label === "tool_implementation") return "tool_implementation";
  return label === "not_agent_related" ? "unclassified" : label;
}

function isDocPath(normalizedPath) {
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".mdx") || normalizedPath.endsWith(".txt") || normalizedPath.includes("/docs/");
}

function isConfigPath(normalizedPath) {
  const basename = normalizedPath.split("/").pop() ?? normalizedPath;
  return (
    basename === "package.json" ||
    basename.endsWith(".config.ts") ||
    basename.endsWith(".config.js") ||
    basename.endsWith(".config.mjs") ||
    basename.endsWith(".config.cjs") ||
    basename.endsWith(".yml") ||
    basename.endsWith(".yaml")
  );
}

function isLowSignalCategory(category) {
  return ["docs_example", "test_fixture", "config_metadata"].includes(category);
}

function isSaferCall(call) {
  const normalized = call.toLowerCase();
  return SAFER_CALL_WORDS.some((word) => normalized.includes(word));
}

function reasonForDiffAwareFinding({ addedHighRiskCalls, removedSaferCalls }) {
  if (addedHighRiskCalls.length > 0 && removedSaferCalls.length > 0) {
    return "This PR appears to add state-mutating or external-side-effect calls while removing safer escalation, review, confirmation, or validation behavior.";
  }

  if (addedHighRiskCalls.length > 0) {
    return "This PR appears to add state-mutating or external-side-effect calls in an agent surface.";
  }

  return "This PR appears to remove escalation, review, confirmation, or validation behavior from an agent surface.";
}

function unique(values) {
  return [...new Set(values)];
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function isJsTsPath(filePath) {
  return JS_TS_EXTENSIONS.includes(fileExtension(filePath));
}

function fileExtension(filePath) {
  const normalized = normalizePath(filePath);
  const name = normalized.split("/").pop() ?? normalized;
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
}

function normalizeEntrypointSources(entrypointSources = {}) {
  return Object.fromEntries(
    Object.entries(entrypointSources).map(([filePath, metadata]) => [normalizePath(filePath), metadata])
  );
}

function applyConfiguredEntrypoint(surface, entrypointGlobs, entrypointSources = {}) {
  if (!matchesEntrypointGlob(surface.path, entrypointGlobs)) return surface;
  const source = entrypointSources[normalizePath(surface.path)];
  const evidence = [...surface.evidence];
  if (source?.entrypoint_source === "langgraph.json") {
    evidence.push(`LangGraph graph entrypoint from langgraph.json: ${source.graph_name}`);
  } else {
    evidence.push("configured agentdiff.yml entrypoint");
  }
  const configuredSurface = {
    ...surface,
    label: surface.label === "not_agent_related" ? "agent_entrypoint" : surface.label,
    confidence: Math.max(surface.confidence, 0.84),
    evidence: unique(evidence),
    configured_entrypoint: true,
    entrypoint_source: source?.entrypoint_source ?? "agentdiff.yml",
    graph_name: source?.graph_name
  };
  const actionability = actionabilityDecisionForSurface(configuredSurface);
  return {
    ...configuredSurface,
    actionability: actionability.actionability,
    actionability_reason: actionability.reason
  };
}

function resolveGraphEntrypoints({ surfaces, files, entrypointGlobs }) {
  const explicit = files
    .filter((file) => isJsTsPath(file.filePath) && matchesEntrypointGlob(file.filePath, entrypointGlobs))
    .map((file) => file.filePath);
  if (explicit.length > 0) return unique(explicit).sort();

  return surfaces
    .filter((surface) => surface.label === "agent_entrypoint" && isJsTsPath(surface.path))
    .map((surface) => surface.path)
    .sort();
}

function matchesEntrypointGlob(filePath, globs) {
  if (!globs || globs.length === 0) return false;
  return globs.some((glob) => globToRegex(glob).test(normalizePath(filePath)));
}

function globToRegex(glob) {
  const normalized = normalizePath(glob).replace(/^\.\//, "");
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }
    pattern += escapeRegex(char);
  }
  return new RegExp(`^${pattern}$`);
}

function escapeRegex(char) {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function computeReachability(edges, entrypoints) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }

  const reachableFiles = new Set();
  const reachableEntryPoints = new Map();

  for (const entrypoint of entrypoints) {
    const queue = [entrypoint];
    const seen = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      reachableFiles.add(current);
      if (!reachableEntryPoints.has(current)) reachableEntryPoints.set(current, new Set());
      reachableEntryPoints.get(current).add(entrypoint);

      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) queue.push(next);
      }
    }
  }

  return { reachableFiles, reachableEntryPoints };
}

function buildImportedBy(edges) {
  const importedBy = new Map();
  for (const edge of edges) {
    if (!importedBy.has(edge.to)) importedBy.set(edge.to, []);
    importedBy.get(edge.to).push({
      path: edge.from,
      import_statement: edge.import_statement
    });
  }
  return importedBy;
}

function applyReachability(surface, { reachability, importedBy, entrypoints, edges = [] }) {
  const normalized = normalizePath(surface.path);
  const reachableFromEntrypoint = reachability.reachableFiles.has(normalized);
  const reachableEntryPoints = [...(reachability.reachableEntryPoints.get(normalized) ?? [])].sort();
  const directImporters = importedBy.get(normalized) ?? [];
  const isConfiguredOrInferredEntrypoint = entrypoints.includes(normalized);
  const reachabilityChain = reachableEntryPoints.length > 0 ? findReachabilityChain(edges, reachableEntryPoints[0], normalized) : [];
  const evidence = [...surface.evidence];
  let confidence = surface.confidence;
  let recommendedCheckDepth = surface.recommended_check_depth;

  if (isConfiguredOrInferredEntrypoint) {
    evidence.push("entrypoint for import graph reachability");
    confidence = Math.max(confidence, 0.86);
  }

  if (reachableFromEntrypoint && !isConfiguredOrInferredEntrypoint) {
    evidence.push(`reachable from entrypoint: ${reachableEntryPoints.join(", ")}`);
    confidence = Math.max(confidence, surface.risk.length > 0 ? 0.86 : 0.74);
  }

  if (!reachableFromEntrypoint && isDocLikeSurface(surface)) {
    evidence.push("not reachable from configured or inferred JS/TS entrypoints");
    confidence = Math.min(confidence, 0.4);
    recommendedCheckDepth = "classify";
  }

  if (isLowSignalCategory(surface.surface_category) && (!reachableFromEntrypoint || isConfiguredOrInferredEntrypoint) && !surface.configured_entrypoint) {
    evidence.push(`${surface.surface_category} downranked until reachable from runtime agent code`);
    confidence = Math.min(confidence, 0.45);
    recommendedCheckDepth = "classify";
  }
  const provenance = classifyReachabilityProvenance({
    path: surface.path,
    chain: reachabilityChain,
    reachableEntryPoints
  });
  const enrichedSurface = {
    ...surface,
    reachable_from_entrypoint: reachableFromEntrypoint,
    reachable_entrypoints: reachableEntryPoints,
    reachability_chain: reachabilityChain,
    imported_by: directImporters,
    reachability_provenance: provenance.provenance,
    reachability_provenance_reason: provenance.reason
  };
  const actionabilityDecision = actionabilityDecisionForSurface(enrichedSurface);

  return {
    ...enrichedSurface,
    confidence: Number(confidence.toFixed(2)),
    evidence: unique(evidence),
    recommended_check_depth: recommendedCheckDepth,
    actionability: actionabilityDecision.actionability,
    actionability_reason: actionabilityDecision.reason
  };
}

function findReachabilityChain(edges, start, target) {
  if (!start || !target) return [];
  if (start === target) return [target];
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }

  const queue = [[start]];
  const seen = new Set();
  while (queue.length > 0) {
    const chain = queue.shift();
    const current = chain[chain.length - 1];
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) {
      const nextChain = [...chain, next];
      if (next === target) return nextChain;
      if (!seen.has(next)) queue.push(nextChain);
    }
  }
  return [start, target].filter(Boolean);
}

function isDocLikeSurface(surface) {
  const normalized = normalizePath(surface.path).toLowerCase();
  return (
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx") ||
    normalized.endsWith(".txt") ||
    normalized.includes("/docs/") ||
    normalized.includes("/.claude/skills/") ||
    normalized.includes("/skills/") ||
    normalized.endsWith("skill.md")
  );
}

function extractImportReferences(content = "") {
  const refs = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[^'"]+\s+from\s+|\*\s+from\s+)["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const statement = statementAt(content, match.index);
      refs.push({
        specifier: match[1],
        statement
      });
    }
  }

  return refs;
}

function statementAt(content, index) {
  const start = content.lastIndexOf("\n", index) + 1;
  const endOfLine = content.indexOf("\n", index);
  const end = endOfLine === -1 ? content.length : endOfLine;
  return content.slice(start, end).trim();
}

function resolveRelativeImport(fromPath, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null;
  const fromDir = normalizePath(fromPath).split("/").slice(0, -1).join("/");
  const raw = normalizePath(joinPath(fromDir, specifier));
  return resolvePathCandidate(raw, fileSet);
}

function resolvePathCandidate(rawPath, fileSet) {
  const raw = normalizePath(rawPath);
  if (!isSafeRepoPath(raw)) return null;
  const candidates = [];

  candidates.push({ path: raw });
  for (const replacement of runtimeSpecifierSourceFallbacks(raw)) candidates.push(replacement);
  for (const ext of JS_TS_EXTENSIONS) candidates.push({ path: `${raw}${ext}` });
  for (const ext of JS_TS_EXTENSIONS) candidates.push({ path: `${raw}/index${ext}` });

  return candidates.find((candidate) => fileSet.has(candidate.path)) ?? null;
}

function runtimeSpecifierSourceFallbacks(rawPath) {
  const ext = fileExtension(rawPath);
  const replacements = {
    ".js": [".ts", ".tsx", ".mts", ".cts"],
    ".mjs": [".mts"],
    ".cjs": [".cts"]
  }[ext];
  if (!replacements) return [];
  const withoutExt = rawPath.slice(0, -ext.length);
  return replacements.map((replacementExt) => ({
    path: `${withoutExt}${replacementExt}`,
    specifier_ext: ext,
    resolved_source_ext: replacementExt,
    note: "resolved JS runtime specifier to TS source"
  }));
}

function isSafeRepoPath(filePath) {
  const normalized = normalizePath(filePath);
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.startsWith("../") && !normalized.includes("/../");
}

function joinPath(base, relative) {
  const parts = `${base}/${relative}`.split("/");
  const output = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      output.pop();
      continue;
    }
    output.push(part);
  }
  return output.join("/");
}

function dedupeEdges(edges) {
  const seen = new Set();
  const result = [];
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}\0${edge.import_statement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result.sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`));
}

function normalizeImportResolver(importResolver = {}) {
  return {
    tsconfigPaths: (importResolver.tsconfigPaths ?? []).flatMap((entry) => {
      const aliasPattern = normalizeAliasPattern(entry.aliasPattern ?? entry.pattern);
      const targetPatterns = entry.targetPatterns ?? (entry.targetPattern ? [entry.targetPattern] : []);
      if (!aliasPattern || targetPatterns.length === 0) return [];
      return [
        {
          aliasPattern,
          targetPatterns: targetPatterns.map((target) => normalizePath(target)).filter(Boolean)
        }
      ];
    }),
    workspacePackages: (importResolver.workspacePackages ?? [])
      .filter((entry) => entry?.packageName && entry?.packageRoot)
      .map((entry) => ({
        packageName: entry.packageName,
        packageRoot: normalizePath(entry.packageRoot),
        entrypoints: (entry.entrypoints ?? []).map((item) => normalizePath(item)).filter(Boolean),
        subpathExports: (entry.subpathExports ?? []).map((item) => ({
          subpathPattern: normalizePath(item.subpathPattern ?? ""),
          targetPatterns: (item.targetPatterns ?? []).map((target) => normalizePath(target)).filter(Boolean)
        }))
      }))
      .sort((left, right) => right.packageName.length - left.packageName.length)
  };
}

function normalizeAliasPattern(pattern) {
  if (!pattern || typeof pattern !== "string") return "";
  return pattern.replaceAll("\\", "/");
}

function resolveImportReference({ fromPath, importRef, fileSet, resolver }) {
  const specifier = importRef.specifier;
  if (specifier.startsWith(".")) {
    const resolved = resolveRelativeImport(fromPath, specifier, fileSet);
    if (!resolved) return null;
    return {
      to: resolved.path,
      resolved_via: "relative",
      specifier_ext: resolved.specifier_ext,
      resolved_source_ext: resolved.resolved_source_ext,
      note: resolved.note,
      evidence: [`relative import: ${specifier}`, resolved.note].filter(Boolean)
    };
  }

  const workspaceResolved = resolveWorkspacePackageImport(specifier, resolver.workspacePackages, fileSet);
  if (workspaceResolved) return workspaceResolved;

  const tsconfigResolved = resolveTsconfigPathImport(specifier, resolver.tsconfigPaths, fileSet);
  if (tsconfigResolved) return tsconfigResolved;

  return resolveProjectAliasImport(fromPath, specifier, fileSet);
}

function resolveTsconfigPathImport(specifier, tsconfigPaths, fileSet) {
  for (const entry of tsconfigPaths) {
    const match = matchAliasPattern(specifier, entry.aliasPattern);
    if (!match.matched) continue;

    for (const targetPattern of entry.targetPatterns) {
      const rawTarget = applyAliasTargetPattern(targetPattern, match.capture);
      const resolved = resolvePathCandidate(rawTarget, fileSet);
      if (!resolved) continue;
      return {
        to: resolved.path,
        resolved_via: "tsconfig_paths",
        alias_pattern: entry.aliasPattern,
        target_pattern: targetPattern,
        evidence: [`tsconfig path alias: ${entry.aliasPattern} -> ${targetPattern}`]
      };
    }
  }
  return null;
}

function matchAliasPattern(specifier, pattern) {
  if (!pattern.includes("*")) {
    if (specifier === pattern) return { matched: true, capture: "" };
    if (pattern.endsWith("/") && specifier.startsWith(pattern)) {
      return { matched: true, capture: specifier.slice(pattern.length) };
    }
    return { matched: false, capture: "" };
  }

  const [prefix, suffix = ""] = pattern.split("*");
  if (!specifier.startsWith(prefix) || (suffix && !specifier.endsWith(suffix))) {
    return { matched: false, capture: "" };
  }
  return {
    matched: true,
    capture: specifier.slice(prefix.length, suffix ? -suffix.length : undefined)
  };
}

function applyAliasTargetPattern(targetPattern, capture) {
  if (targetPattern.includes("*")) return targetPattern.replaceAll("*", capture);
  if (!capture) return targetPattern;
  return joinPath(targetPattern, capture);
}

function resolveWorkspacePackageImport(specifier, workspacePackages, fileSet) {
  for (const workspacePackage of workspacePackages) {
    if (specifier !== workspacePackage.packageName && !specifier.startsWith(`${workspacePackage.packageName}/`)) {
      continue;
    }

    const subpath = specifier === workspacePackage.packageName ? "" : specifier.slice(workspacePackage.packageName.length + 1);
    const candidates = workspacePackageCandidatePaths(workspacePackage, subpath);
    for (const candidate of candidates) {
      const resolved = resolvePathCandidate(candidate, fileSet);
      if (!resolved) continue;
      return {
        to: resolved.path,
        resolved_via: "workspace_package",
        package_name: workspacePackage.packageName,
        package_root: workspacePackage.packageRoot,
        evidence: [`workspace package import: ${workspacePackage.packageName}`]
      };
    }
  }
  return null;
}

function workspacePackageCandidatePaths(workspacePackage, subpath) {
  const root = workspacePackage.packageRoot;
  if (subpath) {
    return [
      ...workspacePackageExportCandidatePaths(workspacePackage, subpath),
      joinPath(root, subpath),
      joinPath(joinPath(root, "src"), subpath)
    ];
  }

  const entrypoints = workspacePackage.entrypoints.length > 0 ? workspacePackage.entrypoints : ["src/index", "index"];
  return entrypoints.map((entrypoint) => joinPath(root, entrypoint.replace(/^\.\//, "")));
}

function workspacePackageExportCandidatePaths(workspacePackage, subpath) {
  const candidates = [];
  for (const entry of workspacePackage.subpathExports ?? []) {
    const match = matchAliasPattern(subpath, entry.subpathPattern.replace(/^\.\//, ""));
    if (!match.matched) continue;
    for (const targetPattern of entry.targetPatterns) {
      const target = applyAliasTargetPattern(targetPattern.replace(/^\.\//, ""), match.capture);
      candidates.push(joinPath(workspacePackage.packageRoot, target));
    }
  }
  return candidates;
}

function resolveProjectAliasImport(fromPath, specifier, fileSet) {
  const match = specifier.match(/^(@|~)\/(.+)$/);
  if (!match) return null;

  const aliasPrefix = `${match[1]}/`;
  const capture = normalizePath(match[2]);
  if (!capture || capture.startsWith("../") || capture.includes("/../")) return null;

  const candidates = projectAliasCandidatePaths(fromPath, capture);
  for (const candidate of candidates) {
    const resolved = resolvePathCandidate(candidate, fileSet);
    if (!resolved) continue;
    return {
      to: resolved.path,
      resolved_via: "project_alias",
      alias_pattern: `${aliasPrefix}*`,
      target_pattern: candidate.endsWith(capture) ? candidate.slice(0, -capture.length) + "*" : candidate,
      specifier_ext: resolved.specifier_ext,
      resolved_source_ext: resolved.resolved_source_ext,
      note: resolved.note,
      evidence: [`project-local alias import: ${aliasPrefix} -> nearest existing project file`]
    };
  }
  return null;
}

function projectAliasCandidatePaths(fromPath, capture) {
  const fromDir = normalizePath(fromPath).split("/").slice(0, -1).join("/");
  const ancestors = pathAncestors(fromDir);
  const candidates = [];
  const seen = new Set();

  for (const anchor of ancestors) {
    for (const candidate of [joinPath(anchor, capture), joinPath(joinPath(anchor, "src"), capture)]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function pathAncestors(dirPath) {
  const normalized = normalizePath(dirPath);
  const parts = normalized ? normalized.split("/") : [];
  const ancestors = [];
  for (let index = parts.length; index >= 0; index -= 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  return ancestors;
}

function classifyUnresolvedImport({ specifier, resolver }) {
  if (isAliasLikeSpecifier(specifier)) {
    return {
      bucket: "alias_like",
      reason: "alias-like specifier did not resolve to a local file"
    };
  }

  const workspaceMatch = matchingWorkspacePackage(specifier, resolver.workspacePackages);
  if (workspaceMatch) {
    return {
      bucket: "workspace_package_like",
      reason: `matched local workspace package ${workspaceMatch.packageName} but no obvious file/export resolved`
    };
  }

  if (sharesWorkspaceScope(specifier, resolver.workspacePackages)) {
    return {
      bucket: "workspace_package_like",
      reason: "shares a local workspace package scope but no matching package was found"
    };
  }

  if (resolver.tsconfigPaths.some((entry) => matchAliasPattern(specifier, entry.aliasPattern).matched)) {
    return {
      bucket: "alias_like",
      reason: "matched tsconfig/jsconfig alias pattern but target did not resolve"
    };
  }

  if (isExternalDependencyLike(specifier)) {
    return {
      bucket: "external_dependency_like",
      reason: "bare package import; likely external dependency"
    };
  }

  return {
    bucket: "unknown",
    reason: "non-relative import is not covered by configured aliases or workspace packages"
  };
}

function matchingWorkspacePackage(specifier, workspacePackages) {
  return workspacePackages.find((workspacePackage) => specifier === workspacePackage.packageName || specifier.startsWith(`${workspacePackage.packageName}/`));
}

function sharesWorkspaceScope(specifier, workspacePackages) {
  if (!specifier.startsWith("@")) return false;
  const scope = specifier.split("/")[0];
  return workspacePackages.some((workspacePackage) => workspacePackage.packageName.startsWith(`${scope}/`));
}

function isAliasLikeSpecifier(specifier) {
  return specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#/");
}

function isExternalDependencyLike(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (specifier.startsWith("@")) return /^@[^/]+\/[^/]+(?:\/.*)?$/.test(specifier);
  return /^[a-zA-Z0-9][\w.-]*(?:\/.*)?$/.test(specifier);
}

function makeUnresolvedImportBuckets() {
  return {
    external_dependency_like: { specifiers: new Set(), samples: [], sampleKeys: new Set() },
    workspace_package_like: { specifiers: new Set(), samples: [], sampleKeys: new Set() },
    alias_like: { specifiers: new Set(), samples: [], sampleKeys: new Set() },
    unknown: { specifiers: new Set(), samples: [], sampleKeys: new Set() }
  };
}

function addUnresolvedImportBucket(buckets, { bucket, specifier, fromPath, statement, reason }) {
  const target = buckets[bucket] ?? buckets.unknown;
  target.specifiers.add(specifier);
  if (target.samples.length >= 12) return;
  const key = `${specifier}\0${fromPath}`;
  if (target.sampleKeys.has(key)) return;
  target.sampleKeys.add(key);
  target.samples.push({
    specifier,
    importing_file: fromPath,
    reason,
    import_statement: statement
  });
}

function unresolvedBucketSummary(buckets) {
  return Object.fromEntries(
    Object.entries(buckets).map(([bucket, value]) => [
      bucket,
      {
        count: value.specifiers.size,
        samples: value.samples
      }
    ])
  );
}

function relatedPaths(surfaces, label) {
  return surfaces
    .filter((surface) => surface.label === label)
    .map((surface) => ({ path: surface.path, risk: surface.risk, confidence: surface.confidence }));
}

function idFromPath(filePath) {
  const name = filePath
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "");
  return name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "agent";
}

function displayNameFromPath(filePath) {
  return idFromPath(filePath).replaceAll("_", " ");
}

function matchesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function summarizeTrace(trace) {
  return {
    scenario_id: trace.scenario_id,
    branch: trace.branch,
    agent_runtime: trace.agent_runtime,
    final_output: trace.final_output,
    tool_sequence: (trace.tool_calls ?? []).map((tool) => tool.name),
    commands_run: (trace.commands_run ?? []).map(formatCommandSummary),
    files_changed: trace.files_changed ?? [],
    tests_run: trace.tests_run ?? [],
    cost_usd: totalCost(trace),
    latency_ms: totalLatency(trace)
  };
}

export function buildImportGraph(files, importResolver = {}) {
  const normalizedFiles = files.map((file) => ({
    filePath: normalizePath(file.filePath),
    content: file.content ?? ""
  }));
  const jsFiles = normalizedFiles.filter((file) => isJsTsPath(file.filePath));
  const fileSet = new Set(jsFiles.map((file) => file.filePath));
  const edges = [];
  const resolver = normalizeImportResolver(importResolver);
  const unresolvedNonRelativeImports = new Set();
  const unresolvedImportBuckets = makeUnresolvedImportBuckets();
  let aliasImportsResolved = 0;
  let workspaceImportsResolved = 0;

  for (const file of jsFiles) {
    for (const importRef of extractImportReferences(file.content)) {
      const resolved = resolveImportReference({ fromPath: file.filePath, importRef, fileSet, resolver });
      if (!resolved) {
        if (!importRef.specifier.startsWith(".")) {
          unresolvedNonRelativeImports.add(importRef.specifier);
          addUnresolvedImportBucket(unresolvedImportBuckets, {
            ...classifyUnresolvedImport({ specifier: importRef.specifier, resolver }),
            specifier: importRef.specifier,
            fromPath: file.filePath,
            statement: importRef.statement
          });
        }
        continue;
      }
      if (resolved.resolved_via === "tsconfig_paths" || resolved.resolved_via === "project_alias") aliasImportsResolved += 1;
      if (resolved.resolved_via === "workspace_package") workspaceImportsResolved += 1;
      edges.push({
        from: file.filePath,
        to: resolved.to,
        import_statement: importRef.statement,
        resolved_via: resolved.resolved_via,
        specifier_ext: resolved.specifier_ext,
        resolved_source_ext: resolved.resolved_source_ext,
        note: resolved.note,
        alias_pattern: resolved.alias_pattern,
        target_pattern: resolved.target_pattern,
        package_name: resolved.package_name,
        package_root: resolved.package_root,
        evidence: resolved.evidence
      });
    }
  }

  return {
    nodes: jsFiles.map((file) => file.filePath).sort(),
    edges: dedupeEdges(edges),
    entrypoints: [],
    reachable_files: [],
    alias_imports_resolved: aliasImportsResolved,
    workspace_imports_resolved: workspaceImportsResolved,
    unresolved_non_relative_imports: unresolvedNonRelativeImports.size,
    unresolved_non_relative_import_samples: [...unresolvedNonRelativeImports].sort().slice(0, 20),
    unresolved_import_buckets: unresolvedBucketSummary(unresolvedImportBuckets)
  };
}

function formatCommandSummary(command) {
  if (typeof command === "string") return command;
  if (!command || typeof command !== "object") return String(command);
  const status = command.status ?? (command.exit_code === 0 ? "passed" : command.exit_code == null ? null : "failed");
  const suffix = status ? ` (${status})` : "";
  return `${command.command ?? "command"}${suffix}`;
}

function summarizeCost(baseTrace, headTrace) {
  const base = totalCost(baseTrace);
  const head = totalCost(headTrace);
  return {
    estimated_cost_usd: Number((base + head).toFixed(4)),
    actual_cost_usd: Number((base + head).toFixed(4)),
    base_cost_usd: Number(base.toFixed(4)),
    head_cost_usd: Number(head.toFixed(4)),
    delta_usd: Number((head - base).toFixed(4))
  };
}

function totalCost(trace) {
  const modelCost = (trace.model_calls ?? []).reduce((sum, call) => sum + Number(call.cost_usd ?? 0), 0);
  const usageCost = Number(trace.usage?.actual_cost_usd ?? trace.usage?.estimated_cost_usd ?? 0);
  return modelCost + usageCost;
}

function totalLatency(trace) {
  return (trace.model_calls ?? []).reduce((sum, call) => sum + Number(call.latency_ms ?? 0), Number(trace.usage?.latency_ms ?? 0));
}

function hasHighRiskTag(tool) {
  return (tool.risk ?? []).some((tag) => HIGH_RISK_TAGS.has(tag));
}

function diffObjects(base, head, prefix = "") {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(head ?? {})]);
  const diffs = [];

  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const baseValue = base?.[key];
    const headValue = head?.[key];
    const bothObjects = isPlainObject(baseValue) && isPlainObject(headValue);

    if (bothObjects) {
      diffs.push(...diffObjects(baseValue, headValue, path));
      continue;
    }

    if (stableStringify(baseValue) !== stableStringify(headValue)) {
      diffs.push({ path, base: baseValue, head: headValue });
    }
  }

  return diffs;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
}
