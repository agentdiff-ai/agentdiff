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

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function classifyChangedFile({ filePath, content = "" }) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  const lowerContent = content.toLowerCase();
  const exportedFunctions = extractExportedFunctionNames(content);
  const evidence = [];
  const risk = [];
  let label = "not_agent_related";
  let confidence = 0.15;
  let recommendedCheckDepth = "classify";

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
    exportedFunctions.some(isHighRiskCall)
  ) {
    label = "tool_implementation";
    confidence = Math.max(confidence, 0.76);
    evidence.push(
      exportedFunctions.some(isHighRiskCall)
        ? `exports high-risk function ${exportedFunctions.find(isHighRiskCall)}`
        : "path suggests tool implementation"
    );
  }

  if (matchesAny(basename, ["schema", "zod", "jsonschema"])) {
    label = label === "not_agent_related" ? "tool_definition" : label;
    confidence = Math.max(confidence, 0.62);
    evidence.push("path suggests schema or tool definition");
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
    label = label === "not_agent_related" ? "agent_entrypoint" : label;
    confidence = Math.max(confidence, 0.82);
    evidence.push("content contains model-call pattern");
  }

  if (/\b(z\.object|jsonschema|parameters|tool_call|function_call)\b/.test(lowerContent)) {
    label = label === "not_agent_related" ? "tool_definition" : label;
    confidence = Math.max(confidence, 0.78);
    evidence.push("content contains tool/schema pattern");
  }

  if (/\b(delete|refund|charge|send|publish|close|update|create|write)\b/.test(normalized + "\n" + lowerContent)) {
    risk.push("state_mutation");
    evidence.push("name or content suggests state mutation");
  }

  const exportedHighRiskFunction = exportedFunctions.find(isHighRiskCall);
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

  return {
    path: filePath,
    label,
    confidence: Number(confidence.toFixed(2)),
    risk: [...new Set(risk)],
    evidence: [...new Set(evidence)],
    recommended_check_depth: recommendedCheckDepth
  };
}

export function buildClassificationReport({ files, repo = process.cwd() }) {
  const changedSurfaces = files.map((file) => classifyChangedFile(file));
  const diffAwareFindings = files.flatMap((file) => buildDiffAwareFindings(file));
  const mappedPaths = collectMappedSurfacePaths(files[0]?.agentMap);
  const mapDrift = changedSurfaces
    .filter((surface) => surface.label !== "not_agent_related")
    .flatMap((surface) => buildMapDriftFinding({ surface, mappedPaths }));

  const status = statusFromFindings([...diffAwareFindings, ...mapDrift]);

  return {
    run_id: new Date().toISOString().replace(/[:.]/g, "-"),
    repo,
    mode: "classify",
    status,
    changed_surfaces: changedSurfaces,
    diff_aware_findings: diffAwareFindings,
    map_drift: mapDrift,
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

export function buildAgentMap({ files, repo = process.cwd() }) {
  const surfaces = files
    .map((file) => classifyChangedFile(file))
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
  findings.push(...findConfirmationRegressions(headTrace.scenario_id, headTools));
  findings.push(...compareState(baseTrace.scenario_id, baseTrace.state_after, headTrace.state_after));
  findings.push(...compareCost(baseTrace.scenario_id, baseTrace, headTrace));

  const status = statusFromFindings(findings);

  return {
    run_id: new Date().toISOString().replace(/[:.]/g, "-"),
    mode: "base_head_light",
    status,
    scenario_id: headTrace.scenario_id ?? baseTrace.scenario_id,
    behavior_findings: findings,
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

function buildMapDriftFinding({ surface, mappedPaths }) {
  const isMapped = mappedPaths.has(normalizePath(surface.path));
  const severity = surface.risk.includes("external_side_effect") ? "high" : "medium";

  if (mappedPaths.size > 0 && !isMapped) {
    return [
      {
        finding_type: "new_unmapped_agent_surface",
        severity,
        title: titleForUnmappedSurface(surface),
        path: surface.path,
        label: surface.label,
        risk: surface.risk,
        evidence: surface.evidence,
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
      risk: surface.risk,
      evidence: surface.evidence,
      recommendation: recommendationForSurface(surface)
    }
  ];
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
  const addedHighRiskCalls = calls.added_calls.filter(isHighRiskCall);
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

function isHighRiskCall(call) {
  const normalized = call.toLowerCase();
  return HIGH_RISK_CALL_WORDS.some((word) => normalized.includes(word));
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
    final_output: trace.final_output,
    tool_sequence: (trace.tool_calls ?? []).map((tool) => tool.name),
    cost_usd: totalCost(trace),
    latency_ms: totalLatency(trace)
  };
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
