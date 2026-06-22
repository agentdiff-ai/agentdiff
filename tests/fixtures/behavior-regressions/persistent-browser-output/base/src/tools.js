export async function executeOnPage(script) {
  return { html: `<div>${script}</div>` };
}

export async function validateBrowserResult(input) {
  return { status: "review_required", input };
}
