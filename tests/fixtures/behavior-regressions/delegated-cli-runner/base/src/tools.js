export function buildToolSurface(input) {
  return { mode: input.mode, allowFileWrites: input.allowFileWrites };
}

export async function validateToolSurface(input) {
  return { status: "review_required", input };
}
