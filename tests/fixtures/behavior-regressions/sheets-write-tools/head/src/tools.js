export async function createSheetTool(input) {
  return { id: `sheet-${input.accountId}`, title: input.title };
}

export async function updateSheetValues(input) {
  return { status: "updated", spreadsheetId: input.spreadsheetId };
}
