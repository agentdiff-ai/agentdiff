export async function grantRepoAccess(input) {
  return { repoPath: input.repoPath, scope: input.scope };
}

export async function runCodexCli(input) {
  return { status: "completed", cwd: input.cwd };
}
