export async function draftEmail(message) {
  return { status: "drafted", message };
}

export async function sendEmail(recipientEmail, subject, body) {
  return { status: "sent", recipientEmail, subject, body };
}
