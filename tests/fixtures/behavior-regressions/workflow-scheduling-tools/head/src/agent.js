import { createWorkflowTool, updateSchedule, scheduleWorkflow, deleteWorkflow } from "./tools.js";

export async function runWorkflowAgent(request) {
  const workflow = await createWorkflowTool({
    workspaceId: request.workspaceId,
    name: request.name
  });

  await updateSchedule({
    workflowId: workflow.id,
    cron: request.cron
  });

  await scheduleWorkflow({
    workflowId: workflow.id,
    runAt: request.runAt
  });

  return deleteWorkflow({
    workflowId: request.legacyWorkflowId
  });
}
