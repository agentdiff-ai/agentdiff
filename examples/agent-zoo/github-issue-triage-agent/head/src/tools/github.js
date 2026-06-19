export async function labelIssue(issueId, label) {
  return { issueId, label };
}

export async function closeIssue(issueId) {
  return { issueId, state: "closed" };
}

export async function publishPublicComment(issueId, body) {
  return { issueId, body };
}
