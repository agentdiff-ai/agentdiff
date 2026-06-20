export function renderMarkdownReport(report) {
  if (report.mode === "classify") {
    return renderClassificationReport(report);
  }

  const lines = [];
  lines.push("# agentdiff behavior report");
  lines.push("");
  lines.push(`status: ${report.status}`);
  lines.push(`run mode: ${report.mode}`);
  lines.push(`scenario: ${report.scenario_id}`);
  lines.push(`findings: ${report.behavior_findings.length}`);
  lines.push(`estimated cost: $${report.cost.estimated_cost_usd.toFixed(4)}`);
  lines.push(`actual cost: $${report.cost.actual_cost_usd.toFixed(4)}`);
  lines.push("");

  if (report.behavior_findings.length === 0) {
    lines.push("## top findings");
    lines.push("");
    lines.push("No behavior regressions detected for this trace pair.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## top findings");
  lines.push("");

  report.behavior_findings.forEach((finding, index) => {
    lines.push(`### ${index + 1}. ${finding.title}`);
    lines.push("");
    lines.push(`severity: ${finding.severity}`);
    lines.push(`type: ${finding.finding_type}`);
    lines.push("");
    lines.push(`reason: ${finding.reason}`);
    lines.push("");
    lines.push("evidence:");
    for (const item of finding.evidence) {
      lines.push(`- ${item}`);
    }
    lines.push("");
    renderExplanation(lines, finding);
    lines.push(`recommendation: ${finding.recommendation}`);
    lines.push("");
  });

  lines.push("## trace summary");
  lines.push("");
  if (report.traces.base.agent_runtime || report.traces.head.agent_runtime) {
    lines.push(`base runtime: ${report.traces.base.agent_runtime ?? "unknown"}`);
    lines.push(`head runtime: ${report.traces.head.agent_runtime ?? "unknown"}`);
  }
  lines.push(`base tools: ${report.traces.base.tool_sequence.join(" -> ") || "none"}`);
  lines.push(`head tools: ${report.traces.head.tool_sequence.join(" -> ") || "none"}`);
  lines.push(`base files changed: ${formatChangedFiles(report.traces.base.files_changed)}`);
  lines.push(`head files changed: ${formatChangedFiles(report.traces.head.files_changed)}`);
  lines.push(`base commands: ${report.traces.base.commands_run.join(" | ") || "none"}`);
  lines.push(`head commands: ${report.traces.head.commands_run.join(" | ") || "none"}`);
  lines.push("");
  lines.push(`base final output: ${report.traces.base.final_output ?? ""}`);
  lines.push(`head final output: ${report.traces.head.final_output ?? ""}`);
  lines.push("");

  return lines.join("\n");
}

function formatChangedFiles(files) {
  if (!files || files.length === 0) return "none";
  return files.map((file) => `${file.path}${file.risk?.length ? ` (${file.risk.join(", ")})` : ""}`).join(", ");
}

function renderClassificationReport(report) {
  const lines = [];
  const groupedFindings = groupClassificationFindings(report);
  const actionabilityCounts = countGroupedFindings(groupedFindings);
  lines.push("# agentdiff classification report");
  lines.push("");
  lines.push(`status: ${report.status}`);
  lines.push(`run mode: ${report.mode}`);
  lines.push(`changed surfaces: ${report.changed_surfaces.length}`);
  lines.push(`diff-aware findings: ${report.diff_aware_findings.length}`);
  lines.push(`map drift findings: ${report.map_drift.length}`);
  lines.push(`suppressed findings: ${report.suppressed_findings?.length ?? 0}`);
  lines.push(`action_required: ${actionabilityCounts.action_required}`);
  lines.push(`review_recommended: ${actionabilityCounts.review_recommended}`);
  lines.push(`context_only: ${actionabilityCounts.context_only}`);
  lines.push(`likely_noise: ${actionabilityCounts.likely_noise}`);
  lines.push(`estimated cost: $${report.cost.estimated_cost_usd.toFixed(4)}`);
  lines.push(`actual cost: $${report.cost.actual_cost_usd.toFixed(4)}`);
  lines.push("");

  if ((report.suppression_warnings ?? []).length > 0) {
    lines.push("## suppression warnings");
    lines.push("");
    for (const warning of report.suppression_warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  if (allGroupedFindings(groupedFindings).length === 0) {
    lines.push("## action required");
    lines.push("");
    lines.push("No unsuppressed agent-related changed surfaces detected.");
    lines.push("");
    renderSuppressedFindings(lines, report);
    return lines.join("\n");
  }

  renderActionabilityGroup(lines, "Action required", "action_required", groupedFindings.action_required, {
    emptyText: "No action-required findings. This PR has no urgent agentdiff finding.",
    collapsed: false
  });
  renderActionabilityGroup(lines, "Review recommended", "review_recommended", groupedFindings.review_recommended, {
    emptyText: "No review-recommended findings.",
    collapsed: false
  });
  renderActionabilityGroup(lines, "Context only", "context_only", groupedFindings.context_only, {
    emptyText: "No context-only findings.",
    collapsed: true,
    note: "Context-only findings are shown for traceability. They do not mean this PR is unsafe."
  });
  renderActionabilityGroup(lines, "Likely noise", "likely_noise", groupedFindings.likely_noise, {
    emptyText: "No likely-noise findings.",
    collapsed: true,
    note: "Likely-noise findings are low-priority docs/config/generated/archive signals and do not mean this PR is unsafe."
  });

  lines.push("## changed surfaces");
  lines.push("");
  for (const surface of report.changed_surfaces) {
    const reachable = typeof surface.reachable_from_entrypoint === "boolean" ? `, reachable=${surface.reachable_from_entrypoint ? "yes" : "no"}` : "";
    const provenance = surface.reachability_provenance ? `, provenance=${surface.reachability_provenance}` : "";
    const actionability = surface.actionability ? `, actionability=${surface.actionability}` : "";
    const suppressed = surface.suppressed ? ", suppressed=yes" : "";
    lines.push(`- ${surface.path}: ${surface.label}/${surface.surface_category ?? "uncategorized"} (${surface.confidence}${reachable}${provenance}${actionability}${suppressed})`);
  }
  lines.push("");

  renderSuppressedFindings(lines, report);

  return lines.join("\n");
}

function groupClassificationFindings(report) {
  const grouped = {
    action_required: [],
    review_recommended: [],
    context_only: [],
    likely_noise: []
  };

  for (const finding of [...(report.diff_aware_findings ?? []), ...(report.map_drift ?? [])]) {
    grouped[actionabilityForFinding(finding)].push(finding);
  }

  return grouped;
}

function allGroupedFindings(grouped) {
  return Object.values(grouped).flat();
}

function countGroupedFindings(grouped) {
  return {
    action_required: grouped.action_required.length,
    review_recommended: grouped.review_recommended.length,
    context_only: grouped.context_only.length,
    likely_noise: grouped.likely_noise.length
  };
}

function actionabilityForFinding(finding) {
  if (["action_required", "review_recommended", "context_only", "likely_noise"].includes(finding.actionability)) {
    return finding.actionability;
  }
  if (finding.severity === "critical" || finding.severity === "high") return "action_required";
  if (finding.severity === "medium") return "review_recommended";
  return "context_only";
}

function renderActionabilityGroup(lines, title, actionability, findings, { emptyText, collapsed, note } = {}) {
  const heading = `${title} (${findings.length})`;
  if (collapsed && findings.length > 0) {
    lines.push(`<details>`);
    lines.push(`<summary>${heading}</summary>`);
    lines.push("");
    if (note) {
      lines.push(note);
      lines.push("");
    }
  } else {
    lines.push(`## ${heading}`);
    lines.push("");
    if (note && findings.length > 0) {
      lines.push(note);
      lines.push("");
    }
  }

  if (findings.length === 0) {
    lines.push(emptyText);
    lines.push("");
  } else {
    findings.forEach((finding, index) => {
      renderClassificationFinding(lines, finding, index + 1, actionability);
    });
  }

  if (collapsed && findings.length > 0) {
    lines.push("</details>");
    lines.push("");
  }
}

function renderClassificationFinding(lines, finding, index, actionability) {
  lines.push(`### ${index}. ${finding.title ?? finding.path}`);
  lines.push("");
  lines.push(`file: ${finding.path}`);
  lines.push(`severity: ${finding.severity}`);
  lines.push(`type: ${finding.finding_type}`);
  lines.push(`actionability: ${finding.actionability ?? actionability}`);

  if (isDiffAwareFinding(finding)) {
    renderDiffAwareFinding(lines, finding);
  } else {
    renderMapDriftFinding(lines, finding);
  }

  lines.push("");
  renderExplanation(lines, finding);
  renderSuggestedSuppression(lines, finding);
  lines.push(`recommendation: ${finding.recommendation}`);
  lines.push("");
}

function isDiffAwareFinding(finding) {
  return Array.isArray(finding.added_calls) || Array.isArray(finding.removed_calls);
}

function renderDiffAwareFinding(lines, finding) {
  lines.push("");
  lines.push("added calls:");
  for (const call of finding.added_calls ?? []) {
    const suffix = (finding.added_high_risk_calls ?? []).includes(call) ? " (high-risk)" : "";
    lines.push(`- ${call}${suffix}`);
  }
  if ((finding.added_calls ?? []).length === 0) lines.push("- none");
  lines.push("");
  lines.push("removed calls:");
  for (const call of finding.removed_calls ?? []) {
    const suffix = (finding.removed_safer_calls ?? []).includes(call) ? " (safer/guardrail)" : "";
    lines.push(`- ${call}${suffix}`);
  }
  if ((finding.removed_calls ?? []).length === 0) lines.push("- none");
  lines.push("");
  lines.push(`why it matters: ${finding.reason}`);
  lines.push("");
  lines.push("evidence:");
  for (const item of finding.evidence ?? []) {
    lines.push(`- ${item}`);
  }
}

function renderMapDriftFinding(lines, finding) {
  lines.push(`label: ${finding.label}`);
  lines.push(`risk: ${finding.risk?.length ? finding.risk.join(", ") : "none"}`);
  if (finding.reachability_provenance) {
    lines.push(`reachability provenance: ${finding.reachability_provenance}`);
  }
  if (typeof finding.reachable_from_entrypoint === "boolean") {
    lines.push(`reachable from entrypoint: ${finding.reachable_from_entrypoint ? "yes" : "no"}`);
  }
  lines.push("");
  lines.push("evidence:");
  for (const item of finding.evidence ?? []) {
    lines.push(`- ${item}`);
  }
}

function renderExplanation(lines, finding) {
  const explanation = finding.explanation;
  if (!explanation) return;
  lines.push("why agentdiff flagged this:");
  for (const item of explanation.why_flagged ?? []) {
    lines.push(`- ${item}`);
  }
  if ((explanation.reachability_chain ?? []).length > 0) {
    lines.push("");
    lines.push(`reachable from: ${explanation.reachability_chain.join(" -> ")}`);
  }
  if (finding.reachability_provenance_reason) {
    lines.push(`reachability provenance reason: ${finding.reachability_provenance_reason}`);
  }
  if ((finding.imported_by ?? []).length > 0) {
    lines.push("");
    lines.push("imported by:");
    for (const importer of finding.imported_by.slice(0, 5)) {
      lines.push(`- ${importer.path}: ${importer.import_statement}`);
    }
  }
  if ((explanation.risk_evidence ?? []).length > 0) {
    lines.push("");
    lines.push("risk evidence:");
    for (const item of explanation.risk_evidence) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");
  lines.push(`confidence reason: ${explanation.confidence_reason}`);
  lines.push("");
}

function renderSuggestedSuppression(lines, finding) {
  lines.push("suggested suppression if intentional:");
  lines.push("");
  lines.push("```yaml");
  lines.push("ignore:");
  lines.push(`  - path: "${finding.path}"`);
  lines.push('    reason: "intentional agent-relevant surface, covered by review"');
  lines.push('    expires: "2026-07-31"');
  lines.push("```");
  lines.push("");
}

function renderSuppressedFindings(lines, report) {
  const suppressed = report.suppressed_findings ?? [];
  if (suppressed.length === 0) return;
  lines.push("## suppressed findings");
  lines.push("");
  for (const finding of suppressed) {
    lines.push(`- ${finding.path}: ${finding.title ?? finding.finding_type} (${finding.severity})`);
    lines.push(`  suppressed by: ${finding.suppression?.path}`);
    lines.push(`  reason: ${finding.suppression?.reason}`);
    if (finding.suppression?.expires) lines.push(`  expires: ${finding.suppression.expires}`);
  }
  lines.push("");
}
