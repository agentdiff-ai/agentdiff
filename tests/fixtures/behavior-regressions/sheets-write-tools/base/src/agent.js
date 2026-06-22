import { listSheets, validateSheetWrite } from "./tools.js";

export async function runSpreadsheetAgent(request) {
  const sheets = await listSheets(request.accountId);
  return validateSheetWrite({
    spreadsheetId: sheets[0]?.id,
    range: request.range,
    values: request.values
  });
}
