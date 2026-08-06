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

  if (value.controls !== undefined && !isPlainObject(value.controls)) errors.push("controls must be an object");
  const controlDecision = isPlainObject(value.controls) ? value.controls.decision ?? "block" : "block";
  const controlPaths = isPlainObject(value.controls) ? value.controls.paths ?? [] : [];
  if (controlDecision !== "block") errors.push("controls.decision must be block");
  if (!Array.isArray(controlPaths) || controlPaths.some((item) => !isNonEmptyString(item))) {
    errors.push("controls.paths must be an array of non-empty strings");
  }

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
    const execution = normalizeExecutionRequirement(rule.require?.execution, `${prefix}.require.execution`, errors);
    if (execution.required && (!Array.isArray(requiredScenarios) || requiredScenarios.length === 0)) {
      errors.push(`${prefix}.require.execution needs at least one required scenario`);
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
        confirmation: rule.require?.confirmation === true,
        execution
      },
      decision: { covered, uncovered }
    };
  }).filter(Boolean);

  if (errors.length > 0) throw new CapabilityPolicyValidationError(source, errors);

  return {
    version: CAPABILITY_POLICY_VERSION,
    defaults: { unmatched },
    controls: {
      decision: controlDecision,
      paths: Array.isArray(controlPaths) ? [...new Set(controlPaths.map((item) => item.trim()))] : []
    },
    rules
  };
}

export function buildCapabilityPlan({
  classificationReport,
  policy,
  scenarios = [],
  runReports = [],
  expectedRevision = null,
  policySource = "agentdiff.policy.json",
  warnings = []
}) {
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
      const coverage = rule ? evaluateCoverage(rule, capability, scenarioById, runReports, expectedRevision) : emptyCoverage();
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

  controlChanges.push(...buildProtectedControlChanges({
    classificationReport,
    policy: normalizedPolicy,
    policySource,
    scenarios,
    runReports
  }));

  const decisions = [...capabilityChanges.map((change) => change.decision), ...controlChanges.map((change) => change.decision)];
  const decision = highestDecision(decisions);
  const counts = countDecisions(decisions);
  const covered = capabilityChanges.filter((change) => change.coverage.covered).length;
  const declaredCovered = capabilityChanges.filter((change) => change.coverage.declared_covered).length;
  const executionCovered = capabilityChanges.filter((change) => change.coverage.execution_required && change.coverage.execution_covered).length;
  const provenanceCovered = capabilityChanges.filter((change) => change.coverage.provenance_required && change.coverage.provenance_covered).length;
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
      rules: normalizedPolicy.rules.length,
      control_decision: normalizedPolicy.controls.decision,
      configured_control_paths: normalizedPolicy.controls.paths.length
    },
    execution_context: {
      expected_revision: expectedRevision
    },
    warnings: unique(warnings),
    summary: {
      added_capabilities: capabilityChanges.length,
      removed_guardrails: controlChanges.filter((change) => change.kind === "removed_guardrail_call").length,
      changed_review_controls: controlChanges.filter((change) => change.kind === "changed_review_control").length,
      covered,
      declared_covered: declaredCovered,
      execution_covered: executionCovered,
      provenance_covered: provenanceCovered,
      uncovered,
      matched_rules: capabilityChanges.filter((change) => change.rule_id).length,
      unmatched_capabilities: capabilityChanges.filter((change) => !change.rule_id).length,
      ...counts
    },
    capability_changes: capabilityChanges,
    control_changes: controlChanges,
    classification_summary: {
      status: classificationReport.status,
      changed_files: classificationReport.changed_files?.length ?? classificationReport.changed_surfaces?.length ?? 0,
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

function buildProtectedControlChanges({ classificationReport, policy, policySource, scenarios, runReports }) {
  const protectedControls = [];
  addProtectedControl(protectedControls, policySource, "policy", false);
  for (const scenario of scenarios) addProtectedControl(protectedControls, scenario.source_path, "scenario", false);
  for (const report of runReports) {
    const artifacts = report.execution_provenance?.artifacts ?? {};
    if (artifacts.scenario?.repository_local !== false) addProtectedControl(protectedControls, artifacts.scenario?.path, "scenario", false);
    if (artifacts.harness_module?.repository_local !== false) addProtectedControl(protectedControls, artifacts.harness_module?.path, "harness", false);
  }
  for (const pattern of policy.controls.paths) addProtectedControl(protectedControls, pattern, "configured", true);

  const changedFiles = unique([
    ...(classificationReport.changed_files ?? []),
    ...(classificationReport.changed_surfaces ?? []).map((surface) => surface.path)
  ].map(normalizeRepositoryPath).filter(Boolean));

  return changedFiles.flatMap((filePath) => {
    const matches = protectedControls.filter((control) =>
      control.glob ? matchesGlob(control.pattern, filePath) : control.pattern.toLowerCase() === filePath.toLowerCase()
    );
    if (matches.length === 0) return [];
    return [{
      control: unique(matches.map((match) => match.type)).join(", "),
      kind: "changed_review_control",
      path: filePath,
      matched_patterns: unique(matches.map((match) => match.pattern)),
      decision: policy.controls.decision,
      reason: "This pull request changes a policy, scenario, harness, or configured control used to evaluate the same change.",
      evidence: unique(matches.map((match) => `${match.type} control matched: ${match.pattern}`))
    }];
  });
}

function addProtectedControl(controls, value, type, glob) {
  const pattern = normalizeRepositoryPath(value);
  if (!pattern || pattern === ".." || pattern.startsWith("../")) return;
  const key = `${type}:${glob ? "glob" : "exact"}:${pattern.toLowerCase()}`;
  if (controls.some((control) => control.key === key)) return;
  controls.push({ key, pattern, type, glob });
}

function evaluateCoverage(rule, capability, scenarioById, runReports, expectedRevision) {
  const requiredScenarios = rule.require.scenarios;
  const presentScenarios = requiredScenarios.filter((id) => scenarioById.has(id));
  const missingScenarios = requiredScenarios.filter((id) => !scenarioById.has(id));
  const confirmationCovered = !rule.require.confirmation || presentScenarios.some((id) =>
    scenarioById.get(id).expectations.some((expectation) =>
      expectation.type === "requires_confirmation" && matchesGlob(expectation.before_tool, capability)
    )
  );
  const executionRequirement = rule.require.execution;
  const reportsForScenario = (id) => runReports.filter((report) => report.scenario_result?.scenario_id === id);
  const eligibilityForReport = (report) => executionEligibility(report, executionRequirement, expectedRevision);
  const eligibleReportsForScenario = (id) => reportsForScenario(id).filter((report) => eligibilityForReport(report).eligible);
  const validReportsForScenario = (id) => eligibleReportsForScenario(id).filter((report) => isValidScenarioResult(report.scenario_result));
  const executedScenarios = requiredScenarios.filter((id) => validReportsForScenario(id).length > 0);
  const passingScenarios = requiredScenarios.filter((id) => {
    const matching = eligibleReportsForScenario(id);
    const valid = validReportsForScenario(id);
    return matching.length > 0 && valid.length === matching.length && valid.every((report) => report.scenario_result.status === "pass");
  });
  const failingScenarios = requiredScenarios.filter((id) => validReportsForScenario(id).some((report) => report.scenario_result.status === "fail"));
  const invalidExecutionScenarios = requiredScenarios.filter((id) => eligibleReportsForScenario(id).some((report) => !isValidScenarioResult(report.scenario_result)));
  const staleExecutionScenarios = requiredScenarios.filter((id) => reportsForScenario(id).some((report) => eligibilityForReport(report).reasons.includes("revision_mismatch")));
  const dirtyWorktreeScenarios = requiredScenarios.filter((id) => reportsForScenario(id).some((report) => eligibilityForReport(report).reasons.includes("worktree_not_clean")));
  const unapprovedHarnessScenarios = requiredScenarios.filter((id) => reportsForScenario(id).some((report) => eligibilityForReport(report).reasons.includes("unapproved_harness")));
  const unverifiedArtifactScenarios = requiredScenarios.filter((id) => reportsForScenario(id).some((report) => eligibilityForReport(report).reasons.includes("artifacts_unverified")));
  const missingExecutionScenarios = requiredScenarios.filter((id) => !executedScenarios.includes(id));
  const executionCovered = !executionRequirement.required || requiredScenarios.every((id) => passingScenarios.includes(id));
  const provenanceRequired = executionRequirement.current_revision || executionRequirement.artifacts || executionRequirement.harnesses.length > 0;
  const provenanceCovered = !provenanceRequired || requiredScenarios.every((id) => eligibleReportsForScenario(id).length > 0);
  const declaredCovered = missingScenarios.length === 0 && confirmationCovered;
  const executionEvidence = runReports
    .filter((report) => requiredScenarios.includes(report.scenario_result?.scenario_id))
    .map((report) => {
      const eligibility = eligibilityForReport(report);
      return {
      scenario_id: report.scenario_result.scenario_id,
      status: report.scenario_result.status,
      source_path: report.source_path ?? null,
      run_id: report.run_id ?? null,
      eligible: eligibility.eligible,
      rejection_reasons: eligibility.reasons,
      git_revision: report.execution_provenance?.git_revision ?? null,
      base_revision: report.execution_provenance?.base_revision ?? null,
      head_revision: report.execution_provenance?.head_revision ?? null,
      worktree_clean: report.execution_provenance?.worktree_dirty === false,
      harness_id: report.execution_provenance?.harness_id ?? null,
      artifacts_verified: report.execution_provenance?.verified === true,
      artifact_verification_errors: report.execution_provenance?.verification_errors ?? [],
      expectations_failed: report.scenario_result.expectations_failed ?? 0,
      failed_expectations: (report.scenario_result.expectation_results ?? [])
        .filter((result) => result.status === "fail")
        .slice(0, 5)
        .map((result) => ({ type: result.type, reason: result.reason, evidence: result.evidence ?? [] }))
      };
    });

  return {
    required_scenarios: requiredScenarios,
    present_scenarios: presentScenarios,
    missing_scenarios: missingScenarios,
    confirmation_required: rule.require.confirmation,
    confirmation_covered: confirmationCovered,
    declared_covered: declaredCovered,
    execution_required: executionRequirement.required,
    execution_requirements: executionRequirement,
    executed_scenarios: executedScenarios,
    passing_scenarios: passingScenarios,
    failing_scenarios: failingScenarios,
    invalid_execution_scenarios: invalidExecutionScenarios,
    stale_execution_scenarios: staleExecutionScenarios,
    dirty_worktree_scenarios: dirtyWorktreeScenarios,
    unapproved_harness_scenarios: unapprovedHarnessScenarios,
    unverified_artifact_scenarios: unverifiedArtifactScenarios,
    missing_execution_scenarios: missingExecutionScenarios,
    execution_evidence: executionEvidence,
    execution_covered: executionCovered,
    provenance_required: provenanceRequired,
    provenance_covered: provenanceCovered,
    expected_revision: expectedRevision,
    covered: declaredCovered && executionCovered && provenanceCovered
  };
}

function emptyCoverage() {
  return {
    required_scenarios: [],
    present_scenarios: [],
    missing_scenarios: [],
    confirmation_required: false,
    confirmation_covered: false,
    declared_covered: false,
    execution_required: false,
    execution_requirements: { required: false, current_revision: false, artifacts: false, harnesses: [] },
    executed_scenarios: [],
    passing_scenarios: [],
    failing_scenarios: [],
    invalid_execution_scenarios: [],
    stale_execution_scenarios: [],
    dirty_worktree_scenarios: [],
    unapproved_harness_scenarios: [],
    unverified_artifact_scenarios: [],
    missing_execution_scenarios: [],
    execution_evidence: [],
    execution_covered: false,
    provenance_required: false,
    provenance_covered: false,
    expected_revision: null,
    covered: false
  };
}

function matchesRule(rule, capability, filePath) {
  return matchesGlob(rule.capability, capability) && (!rule.path || matchesGlob(rule.path, normalizePath(filePath)));
}

function isValidScenarioResult(result) {
  if (!result || !["pass", "fail"].includes(result.status)) return false;
  const total = result.expectations_total;
  const passed = result.expectations_passed;
  const failed = result.expectations_failed;
  return Number.isInteger(total) && total > 0 && Number.isInteger(passed) && Number.isInteger(failed) && passed + failed === total;
}

function normalizeExecutionRequirement(value, path, errors) {
  if (value === undefined || value === false) {
    return { required: false, current_revision: false, artifacts: false, harnesses: [] };
  }
  if (value === true) {
    return { required: true, current_revision: false, artifacts: false, harnesses: [] };
  }
  if (!isPlainObject(value)) {
    errors.push(`${path} must be a boolean or object`);
    return { required: false, current_revision: false, artifacts: false, harnesses: [] };
  }

  for (const field of ["required", "current_revision", "artifacts"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") errors.push(`${path}.${field} must be a boolean`);
  }
  if (value.harnesses !== undefined && (!Array.isArray(value.harnesses) || value.harnesses.some((item) => !isNonEmptyString(item)))) {
    errors.push(`${path}.harnesses must be an array of non-empty strings`);
  }

  const requirement = {
    required: value.required ?? true,
    current_revision: value.current_revision === true,
    artifacts: value.artifacts === true,
    harnesses: Array.isArray(value.harnesses) ? [...new Set(value.harnesses.map((item) => item.trim()))] : []
  };
  if (!requirement.required && (requirement.current_revision || requirement.artifacts || requirement.harnesses.length > 0)) {
    errors.push(`${path}.required cannot be false when provenance constraints are configured`);
  }
  return requirement;
}

function executionEligibility(report, requirement, expectedRevision) {
  const reasons = [];
  const provenance = report.execution_provenance;
  if (requirement.current_revision) {
    if (!expectedRevision || provenance?.git_revision !== expectedRevision) reasons.push("revision_mismatch");
    if (provenance?.head_revision && provenance.head_revision !== expectedRevision && !reasons.includes("revision_mismatch")) {
      reasons.push("revision_mismatch");
    }
    if (provenance?.worktree_dirty !== false) reasons.push("worktree_not_clean");
  }
  if (requirement.harnesses.length > 0 && !requirement.harnesses.includes(provenance?.harness_id)) {
    reasons.push("unapproved_harness");
  }
  if (requirement.artifacts && provenance?.verified !== true) reasons.push("artifacts_unverified");
  return { eligible: reasons.length === 0, reasons };
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

function normalizeRepositoryPath(value) {
  return normalizePath(value).replace(/^\.\//, "");
}

function unique(values) {
  return [...new Set(values)];
}
