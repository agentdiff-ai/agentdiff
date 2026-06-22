import { grantRepoAccess, executeCliRunner, delegateRunner } from "./tools.js";

export async function runCodingAssistant(request) {
  const access = await grantRepoAccess({
    repoPath: request.repoPath,
    scope: "full-worktree"
  });

  const execution = await executeCliRunner({
    cwd: access.repoPath,
    task: request.task
  });

  return delegateRunner({
    executionId: execution.id,
    task: request.task
  });
}
