export async function listAgents(workspaceId) {
  return [{ id: `agent-${workspaceId}` }];
}

export async function reviewAgentChange(input) {
  return { status: "review_required", input };
}
