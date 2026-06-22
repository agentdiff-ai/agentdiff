export async function createWorkflowTool(input) {
  return { id: `workflow-${input.name}` };
}

export async function updateSchedule(input) {
  return { status: "scheduled", workflowId: input.workflowId };
}

export async function scheduleWorkflow(input) {
  return { status: "queued", workflowId: input.workflowId, runAt: input.runAt };
}

export async function deleteWorkflow(input) {
  return { status: "deleted", workflowId: input.workflowId };
}
