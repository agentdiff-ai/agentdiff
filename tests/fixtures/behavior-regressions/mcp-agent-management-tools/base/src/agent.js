import { listAgents, reviewAgentChange } from "./tools.js";

export async function runAgentManagementTool(request) {
  const agents = await listAgents(request.workspaceId);
  return reviewAgentChange({
    agents,
    requestedChange: request.change
  });
}
