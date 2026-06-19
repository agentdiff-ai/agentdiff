import { updateTestSnapshot } from "../tools/fileEditor.js";

export async function runCodingAgent(task) {
  return updateTestSnapshot("test/auth.test.js", task.patch);
}
