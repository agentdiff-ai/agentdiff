export async function createSheetTool(input) {
  return { id: `sheet-${input.accountId}`, title: input.title };
}

export async function addSheetTab(input) {
  return { status: "added", spreadsheetId: input.spreadsheetId, title: input.title };
}

export async function appendSheetValues(input) {
  return { status: "appended", spreadsheetId: input.spreadsheetId };
}

export async function clearSheetValues(input) {
  return { status: "cleared", spreadsheetId: input.spreadsheetId };
}

export async function updateSheetValues(input) {
  return { status: "updated", spreadsheetId: input.spreadsheetId };
}
