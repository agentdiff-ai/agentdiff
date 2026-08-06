export const CAPABILITY_POLICY_VERSION = "0.1";

const DECISIONS = new Set(["allow", "review", "block"]);

export class CapabilityPolicyValidationError extends Error {
  constructor(source, errors) {
    super(`invalid agentdiff capability policy (${source}):\n- ${errors.join("\n- ")}`);
    this.name = "CapabilityPolicyValidationError";
    this.source = source;
    this.errors = errors;
  }
}

export function normalizeCapabilityPolicy(value, { source = "capability policy" } = {}) {
  const errors = [];
  if (!isPlainObject(value)) throw new CapabilityPolicyValidationError(source, ["root must be a JSON object"]);

  const version = String(value.version ?? CAPABILITY_POLICY_VERSION);
  if (version !== CAPABILITY_POLICY_VERSION) {
    errors.push(`version must be ${JSON.stringify(CAPABILITY_POLICY_VERSION)}`);
  }

  if (value.defaults !== undefined && !isPlainObject(value.defaults)) errors.push("defaults must be an object");
  const unmatched = isPlainObject(value.defaults) ? value.defaults.unmatched ?? "review" : "review";
  validateDecision(unmatched, "defaults.unmatched", errors);

  if (value.rules !== undefined && !Array.isArray(value.rules)) errors.push("rules must be an array");
  const seenIds = new Set();
  const rules = (Array.isArray(value.rules) ? value.rules : []).map((rule, index) => {
    const prefix = `rules[${index}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${prefix} must be an object`);
      return null;
    }

    const id = requiredString(rule.id, `${prefix}.id`, errors);
    const capability = requiredString(rule.capability, `${prefix}.capability`, errors);
    const reason = requiredString(rule.reason, `${prefix}.reason`, errors);
    if (id && seenIds.has(id)) errors.push(`${prefix}.id must be unique`);
    seenIds.add(id);

    if (rule.path !== undefined && !isNonEmptyString(rule.path)) errors.push(`${prefix}.path must be a non-empty string`);
    if (rule.require !== undefined && !isPlainObject(rule.require)) errors.push(`${prefix}.require must be an object`);
    if (rule.decision !== undefined && !isPlainObject(rule.decision)) errors.push(`${prefix}.decision must be an object`);

    const requiredScenarios = rule.require?.scenarios ?? [];
    if (!Array.isArray(requiredScenarios) || requiredScenarios.some((item) => !isNonEmptyString(item))) {
      errors.push(`${prefix}.require.scenarios must be an array of non-empty strings`);
    }
    if (rule.require?.confirmation !== undefined && typeof rule.require.confirmation !== "boolean") {
      errors.push(`${prefix}.require.confirmation must be a boolean`);
    }

    const covered = rule.decision?.covered ?? "review";
    const uncovered = rule.decision?.uncovered ?? "block";
    validateDecision(covered, `${prefix}.decision.covered`, errors);
    validateDecision(uncovered, `${prefix}.decision.uncovered`, errors);

    return {
      id,
      capability,
      path: isNonEmptyString(rule.path) ? rule.path.trim() : null,
      reason,
      require: {
        scenarios: Array.isArray(requiredScenarios) ? [...new Set(requiredScenarios.map((item) => item.trim()))] : [],
        confirmation: rule.require?.confirmation === true
      },
      decision: { covered, uncovered }
    };
  }).filter(Boolean);

  if (errors.length > 0) throw new CapabilityPolicyValidationError(source, errors);

  return {
    version: CAPABILITY_POLICY_VERSION,
    defaults: { unmatched },
    rules
  };
}

export function buildCapabilityPlan({ classificationReport, policy, scenarios = [], policySource = "agentdiff.policy.json", warnings = [] }) {
  const normalizedPolicy = normalizeCapabilityPolicy(policy, { source: policySource });
  const scenarioById = new Map();
  for (const scenario of scenarios) {
    if (scenarioById.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
    scenarioById.set(scenario.id, scenario);
  }
  const capabilityChanges = [];
  const controlChanges = [];

  for (const finding of classificationReport.diff_aware_findings ?? []) {
    for (const capability of finding.added_high_risk_calls ?? []) {
      const rule = normalizedPolicy.rules.find((candidate) => matchesRule(candidate, capability, finding.path));
      const coverage = rule ? evaluateCoverage(rule, capability, scenarioById) : emptyCoverage();
      const decision = rule
        ? coverage.covered ? rule.decision.covered : rule.decision.uncovered
        : normalizedPolicy.defaults.unmatched;

      capabilityChanges.push({
        capability,
        kind: "added_high_risk_call",
        path: finding.path,
        risk: finding.severity ?? "high",
        rule_id: rule?.id ?? null,
        decision,
        reason: rule?.reason ?? "No capability policy rule matched this newly added high-risk call.",
        coverage,
        evidence: unique([
          `added high-risk call: ${capability}`,
          ...(finding.evidence ?? [])
        ])
      });
    }

    for (const guardrail of finding.removed_safer_calls ?? []) {
      controlChanges.push({
        guardrail,
        kind: "removed_guardrail_call",
        path: finding.path,
        decision: "review",
        reason: "A safer, escalation, validation, or confirmation path was removed.",
        evidence: unique([
          `removed safer/guardrail call: ${guardrail}`,
          ...(finding.evidence ?? [])
        ])
      });
    }
  }

  const decisions = [...capabilityChanges.map((change) => change.decision), ...controlChanges.map((change) => change.decision)];
  const decision = highestDecision(decisions);
  const counts = countDecisions(decisions);
  const covered = capabilityChanges.filter((change) => change.coverage.covered).length;
  const uncovered = capabilityChanges.filter((change) => change.rule_id && !change.coverage.covered).length;

  return {
    run_id: new Date().toISOString().replace(/[:.]/g, "-"),
    repo: classificationReport.repo,
    mode: "plan",
    decision,
    status: decision,
    policy: {
      source: policySource,
      version: normalizedPolicy.version,
      rules: normalizedPolicy.rules.length
    },
    warnings: unique(warnings),
    summary: {
      added_capabilities: capabilityChanges.length,
      removed_guardrails: controlChanges.length,
      covered,
      uncovered,
      matched_rules: capabilityChanges.filter((change) => change.rule_id).length,
      unmatched_capabilities: capabilityChanges.filter((change) => !change.rule_id).length,
      ...counts
    },
    capability_changes: capabilityChanges,
    control_changes: controlChanges,
    classification_summary: {
      status: classificationReport.status,
      changed_surfaces: classificationReport.changed_surfaces?.length ?? 0,
      diff_aware_findings: classificationReport.diff_aware_findings?.length ?? 0,
      map_drift_findings: classificationReport.map_drift?.length ?? 0,
      suppressed_findings: classificationReport.suppressed_findings?.length ?? 0
    },
    cost: {
      estimated_cost_usd: 0,
      actual_cost_usd: 0
    }
  };
}

function evaluateCoverage(rule, capability, scenarioById) {
  const requiredScenarios = rule.require.scenarios;
  const presentScenarios = requiredScenarios.filter((id) => scenarioById.has(id));
  const missingScenarios = requiredScenarios.filter((id) => !scenarioById.has(id));
  const confirmationCovered = !rule.require.confirmation || presentScenarios.some((id) =>
    scenarioById.get(id).expectations.some((expectation) =>
      expectation.type === "requires_confirmation" && matchesGlob(expectation.before_tool, capability)
    )
  );

  return {
    required_scenarios: requiredScenarios,
    present_scenarios: presentScenarios,
    missing_scenarios: missingScenarios,
    confirmation_required: rule.require.confirmation,
    confirmation_covered: confirmationCovered,
    covered: missingScenarios.length === 0 && confirmationCovered
  };
}

function emptyCoverage() {
  return {
    required_scenarios: [],
    present_scenarios: [],
    missing_scenarios: [],
    confirmation_required: false,
    confirmation_covered: false,
    covered: false
  };
}

function matchesRule(rule, capability, filePath) {
  return matchesGlob(rule.capability, capability) && (!rule.path || matchesGlob(rule.path, normalizePath(filePath)));
}

function matchesGlob(pattern, value) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(String(value));
}

function highestDecision(decisions) {
  if (decisions.includes("block")) return "block";
  if (decisions.includes("review")) return "review";
  return "allow";
}

function countDecisions(decisions) {
  return {
    allow: decisions.filter((decision) => decision === "allow").length,
    review: decisions.filter((decision) => decision === "review").length,
    block: decisions.filter((decision) => decision === "block").length
  };
}

function validateDecision(value, path, errors) {
  if (!DECISIONS.has(value)) errors.push(`${path} must be one of: allow, review, block`);
}

function requiredString(value, path, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function unique(values) {
  return [...new Set(values)];
}
