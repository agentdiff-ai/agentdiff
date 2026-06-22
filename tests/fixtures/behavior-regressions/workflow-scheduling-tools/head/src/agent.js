import { createWorkflowTool, updateSchedule, deleteWorkflow } from "./tools.js";

export async function runWorkflowAgent(request) {
  const workflow = await createWorkflowTool({
    workspaceId: request.workspaceId,
    name: request.name
  });

  await updateSchedule({
    workflowId: workflow.id,
    cron: request.cron
  });

  return deleteWorkflow({
    workflowId: request.legacyWorkflowId
  });
}
