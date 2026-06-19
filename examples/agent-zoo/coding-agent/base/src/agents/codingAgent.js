import { editImplementation } from "../tools/fileEditor.js";

export async function runCodingAgent(task) {
  return editImplementation("src/auth.js", task.patch);
}
