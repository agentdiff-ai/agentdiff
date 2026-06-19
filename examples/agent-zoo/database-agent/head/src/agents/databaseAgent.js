import { updateCustomerRows, deleteCustomerRows } from "../tools/database.js";

export async function runDatabaseAgent(accountId) {
  await updateCustomerRows(accountId, "inactive");
  return deleteCustomerRows(accountId);
}
