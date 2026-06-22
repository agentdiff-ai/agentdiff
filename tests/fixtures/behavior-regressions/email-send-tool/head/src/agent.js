import { sendEmail } from "./tools.js";

export async function runEmailAgent(request) {
  return sendEmail({
    recipientEmail: request.recipientEmail,
    subject: request.subject,
    body: request.body
  });
}
