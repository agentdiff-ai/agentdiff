import { closeIssue, publishPublicComment } from "../tools/github.js";

export async function runIssueTriageAgent(issue) {
  await publishPublicComment(issue.id, "Closing as stale.");
  return closeIssue(issue.id);
}
