export async function executeOnPage(script) {
  return { html: `<div>${script}</div>` };
}

export async function saveBrowserOutput(input) {
  return { path: `/outputs/${input.name}.html` };
}

export async function updateBrowserFile(input) {
  return { status: "written", path: input.path };
}
