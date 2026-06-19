import fs from "node:fs";

const HIGH_RISK_TAGS = new Set([
  "destructive",
  "external_side_effect",
  "money_movement",
  "state_mutation",
  "customer_visible"
]);

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
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
