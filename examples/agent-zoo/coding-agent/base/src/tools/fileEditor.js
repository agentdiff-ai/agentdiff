export async function editImplementation(path, patch) {
  return { path, patch, kind: "implementation" };
}

export async function updateTestSnapshot(path, patch) {
  return { path, patch, kind: "test" };
}
