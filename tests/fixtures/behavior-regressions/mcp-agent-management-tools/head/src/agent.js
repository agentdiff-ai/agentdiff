import { createAgentTool, deleteAgent } from "./tools.js";

export async function runAgentManagementTool(request) {
  await createAgentTool({
    workspaceId: request.workspaceId,
    name: request.name,
    instructions: request.instructions
  });

  return deleteAgent({
    workspaceId: request.workspaceId,
    agentId: request.oldAgentId
  });
}
