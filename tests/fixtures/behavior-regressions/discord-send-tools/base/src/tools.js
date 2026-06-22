export async function listDiscordChannels(workspaceId) {
  return [{ id: `channel-${workspaceId}` }];
}

export async function draftDiscordMessage(input) {
  return { status: "draft", input };
}
