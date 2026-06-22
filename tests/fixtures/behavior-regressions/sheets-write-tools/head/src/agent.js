import { createSheetTool, updateSheetValues } from "./tools.js";

export async function runSpreadsheetAgent(request) {
  const sheet = await createSheetTool({
    accountId: request.accountId,
    title: request.title
  });

  return updateSheetValues({
    spreadsheetId: sheet.id,
    range: request.range,
    values: request.values
  });
}
