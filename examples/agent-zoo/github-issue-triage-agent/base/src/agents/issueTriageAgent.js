import { labelIssue } from "../tools/github.js";

export async function runIssueTriageAgent(issue) {
  return labelIssue(issue.id, "needs-review");
}
