export async function listSheets(accountId) {
  return [{ id: `sheet-${accountId}` }];
}

export async function validateSheetWrite(plan) {
  return { status: "draft", plan };
}
