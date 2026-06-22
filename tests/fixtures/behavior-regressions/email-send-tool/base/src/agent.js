import { draftEmail } from "./tools.js";

export async function runEmailAgent(request) {
  return draftEmail({
    recipientEmail: request.recipientEmail,
    subject: request.subject,
    body: request.body
  });
}
