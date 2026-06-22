export async function sendDiscordImage(input) {
  return { status: "sent", type: "image", channelId: input.channelId };
}

export async function sendDiscordEmbed(input) {
  return { status: "sent", type: "embed", channelId: input.channelId };
}

export async function addDiscordReaction(input) {
  return { status: "added", type: "reaction", messageId: input.messageId };
}
