export async function listWorkflows(workspaceId) {
  return [{ id: `workflow-${workspaceId}` }];
}

export async function validateWorkflowPlan(input) {
  return { status: "review_required", input };
}
