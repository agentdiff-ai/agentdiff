export function renderMarkdownReport(report) {
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
  lines.push(`base tools: ${report.traces.base.tool_sequence.join(" -> ") || "none"}`);
  lines.push(`head tools: ${report.traces.head.tool_sequence.join(" -> ") || "none"}`);
  lines.push("");
  lines.push(`base final output: ${report.traces.base.final_output ?? ""}`);
  lines.push(`head final output: ${report.traces.head.final_output ?? ""}`);
  lines.push("");

  return lines.join("\n");
}
