export async function send_email(input) {
  return { status: "sent", messageId: `msg-${input.recipientEmail}` };
}
