export async function createWorkflowTool(input) {
  return { id: `workflow-${input.name}` };
}

export async function updateSchedule(input) {
  return { status: "scheduled", workflowId: input.workflowId };
}

export async function deleteWorkflow(input) {
  return { status: "deleted", workflowId: input.workflowId };
}
