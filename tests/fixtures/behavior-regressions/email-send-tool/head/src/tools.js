export async function sendEmail(input) {
  return { status: "sent", messageId: `msg-${input.recipientEmail}` };
}
