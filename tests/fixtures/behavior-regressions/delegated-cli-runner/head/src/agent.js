import { grantRepoAccess, runCodexCli } from "./tools.js";

export async function runCodingAssistant(request) {
  const access = await grantRepoAccess({
    repoPath: request.repoPath,
    scope: "full-worktree"
  });

  return runCodexCli({
    cwd: access.repoPath,
    task: request.task
  });
}
