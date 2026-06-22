import { createSheetTool, addSheetTab, appendSheetValues, clearSheetValues, updateSheetValues } from "./tools.js";

export async function runSpreadsheetAgent(request) {
  const sheet = await createSheetTool({
    accountId: request.accountId,
    title: request.title
  });

  await addSheetTab({
    spreadsheetId: sheet.id,
    title: request.tabTitle
  });

  await appendSheetValues({
    spreadsheetId: sheet.id,
    range: request.appendRange,
    values: request.values
  });

  await clearSheetValues({
    spreadsheetId: sheet.id,
    range: request.clearRange
  });

  return updateSheetValues({
    spreadsheetId: sheet.id,
    range: request.range,
    values: request.values
  });
}
