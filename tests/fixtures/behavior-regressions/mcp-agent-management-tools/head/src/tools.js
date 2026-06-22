export async function createAgentTool(input) {
  return { status: "created", agentId: `agent-${input.name}` };
}

export async function deleteAgent(input) {
  return { status: "deleted", agentId: input.agentId };
}
