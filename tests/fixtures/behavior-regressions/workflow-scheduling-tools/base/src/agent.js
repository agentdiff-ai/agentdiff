import { listWorkflows, validateWorkflowPlan } from "./tools.js";

export async function runWorkflowAgent(request) {
  const workflows = await listWorkflows(request.workspaceId);
  return validateWorkflowPlan({
    existing: workflows,
    proposedSchedule: request.schedule
  });
}
