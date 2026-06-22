import { listDiscordChannels, draftDiscordMessage } from "./tools.js";

export async function runDiscordAgent(request) {
  const channels = await listDiscordChannels(request.workspaceId);
  return draftDiscordMessage({
    channelId: channels[0]?.id,
    content: request.summary
  });
}
