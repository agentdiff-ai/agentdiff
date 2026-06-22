import { sendDiscordImage, sendDiscordEmbed, addDiscordReaction } from "./tools.js";

export async function runDiscordAgent(request) {
  await sendDiscordImage({
    channelId: request.channelId,
    imageUrl: request.imageUrl,
    caption: request.summary
  });

  await sendDiscordEmbed({
    channelId: request.channelId,
    title: request.title,
    body: request.summary
  });

  return addDiscordReaction({
    channelId: request.channelId,
    messageId: request.messageId,
    emoji: request.emoji
  });
}
