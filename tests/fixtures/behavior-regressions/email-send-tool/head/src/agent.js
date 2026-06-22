import { send_email } from "./tools.js";

export async function runEmailAgent(request) {
  return send_email({
    recipientEmail: request.recipientEmail,
    subject: request.subject,
    body: request.body
  });
}
