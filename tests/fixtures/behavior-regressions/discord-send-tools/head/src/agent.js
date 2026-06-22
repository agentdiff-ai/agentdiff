import { sendDiscordImage, sendDiscordEmbed } from "./tools.js";

export async function runDiscordAgent(request) {
  await sendDiscordImage({
    channelId: request.channelId,
    imageUrl: request.imageUrl,
    caption: request.summary
  });

  return sendDiscordEmbed({
    channelId: request.channelId,
    title: request.title,
    body: request.summary
  });
}
