import { buildToolSurface, validateToolSurface } from "./tools.js";

export async function runCodingAssistant(request) {
  const tools = buildToolSurface({
    mode: "constrained",
    allowFileWrites: false
  });

  return validateToolSurface({
    tools,
    task: request.task
  });
}
