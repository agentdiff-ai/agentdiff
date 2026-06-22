import { executeOnPage, validateBrowserResult } from "./tools.js";

export async function runBrowserAgent(request) {
  const result = await executeOnPage(request.script);
  return validateBrowserResult({
    result,
    requestedOutput: request.outputName
  });
}
