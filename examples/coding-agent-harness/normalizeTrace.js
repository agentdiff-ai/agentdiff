export function normalizeCodingAgentTrace({
  scenarioId,
  branch,
  agentRuntime,
  finalOutput,
  commandsRun = [],
  filesChanged = [],
  testsRun = [],
  stateBefore = {},
  stateAfter = {},
  modelCalls = [],
  cost = null
}) {
  return {
    scenario_id: scenarioId,
    branch,
    agent_runtime: agentRuntime,
    final_output: finalOutput,
    commands_run: commandsRun,
    files_changed: filesChanged.map((file) => ({
      path: file.path,
      change_type: file.change_type ?? "modified",
      risk: file.risk ?? []
    })),
    tests_run: testsRun,
    state_before: stateBefore,
    state_after: stateAfter,
    model_calls: modelCalls,
    cost
  };
}
