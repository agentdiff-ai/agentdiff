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
  lines.push("# agentdiff classification report");
  lines.push("");
  lines.push(`status: ${report.status}`);
  lines.push(`run mode: ${report.mode}`);
  lines.push(`changed surfaces: ${report.changed_surfaces.length}`);
  lines.push(`diff-aware findings: ${report.diff_aware_findings.length}`);
  lines.push(`map drift findings: ${report.map_drift.length}`);
  lines.push(`estimated cost: $${report.cost.estimated_cost_usd.toFixed(4)}`);
  lines.push(`actual cost: $${report.cost.actual_cost_usd.toFixed(4)}`);
  lines.push("");

  if (report.diff_aware_findings.length === 0 && report.map_drift.length === 0) {
    lines.push("## top findings");
    lines.push("");
    lines.push("No agent-related changed surfaces detected.");
    lines.push("");
    return lines.join("\n");
  }

  if (report.diff_aware_findings.length > 0) {
    lines.push("## diff-aware findings");
    lines.push("");

    report.diff_aware_findings.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${finding.title}`);
      lines.push("");
      lines.push(`file: ${finding.path}`);
      lines.push(`severity: ${finding.severity}`);
      lines.push(`type: ${finding.finding_type}`);
      lines.push("");
      lines.push("added calls:");
      for (const call of finding.added_calls) {
        const suffix = finding.added_high_risk_calls.includes(call) ? " (high-risk)" : "";
        lines.push(`- ${call}${suffix}`);
      }
      if (finding.added_calls.length === 0) {
        lines.push("- none");
      }
      lines.push("");
      lines.push("removed calls:");
      for (const call of finding.removed_calls) {
        const suffix = finding.removed_safer_calls.includes(call) ? " (safer/guardrail)" : "";
        lines.push(`- ${call}${suffix}`);
      }
      if (finding.removed_calls.length === 0) {
        lines.push("- none");
      }
      lines.push("");
      lines.push(`why it matters: ${finding.reason}`);
      lines.push("");
      lines.push("evidence:");
      for (const item of finding.evidence) {
        lines.push(`- ${item}`);
      }
      lines.push("");
      lines.push(`recommendation: ${finding.recommendation}`);
      lines.push("");
    });
  }

  lines.push("## top findings");
  lines.push("");

  report.map_drift.forEach((finding, index) => {
    lines.push(`### ${index + 1}. ${finding.title ?? finding.path}`);
    lines.push("");
    lines.push(`file: ${finding.path}`);
    lines.push(`severity: ${finding.severity}`);
    lines.push(`type: ${finding.finding_type}`);
    lines.push(`label: ${finding.label}`);
    lines.push(`risk: ${finding.risk.length ? finding.risk.join(", ") : "none"}`);
    if (typeof finding.reachable_from_entrypoint === "boolean") {
      lines.push(`reachable from entrypoint: ${finding.reachable_from_entrypoint ? "yes" : "no"}`);
    }
    lines.push("");
    lines.push("evidence:");
    for (const item of finding.evidence) {
      lines.push(`- ${item}`);
    }
    lines.push("");
    lines.push(`recommendation: ${finding.recommendation}`);
    lines.push("");
  });

  lines.push("## changed surfaces");
  lines.push("");
  for (const surface of report.changed_surfaces) {
    const reachable = typeof surface.reachable_from_entrypoint === "boolean" ? `, reachable=${surface.reachable_from_entrypoint ? "yes" : "no"}` : "";
    lines.push(`- ${surface.path}: ${surface.label} (${surface.confidence}${reachable})`);
  }
  lines.push("");

  return lines.join("\n");
}
