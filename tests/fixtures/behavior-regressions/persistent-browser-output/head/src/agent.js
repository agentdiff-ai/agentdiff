import { executeOnPage, saveBrowserOutput, writePersistentOutput, updateBrowserFile } from "./tools.js";

export async function runBrowserAgent(request) {
  const result = await executeOnPage(request.script);
  const saved = await saveBrowserOutput({
    name: request.outputName,
    content: result.html
  });

  await writePersistentOutput({
    path: saved.path,
    content: result.html
  });

  return updateBrowserFile({
    path: saved.path,
    content: result.html
  });
}
