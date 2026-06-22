export async function grantRepoAccess(input) {
  return { repoPath: input.repoPath, scope: input.scope };
}

export async function executeCliRunner(input) {
  return { id: `exec-${input.cwd}`, status: "completed", cwd: input.cwd };
}

export async function delegateRunner(input) {
  return { status: "delegated", executionId: input.executionId };
}
