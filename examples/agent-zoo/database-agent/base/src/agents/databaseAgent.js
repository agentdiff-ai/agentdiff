import { selectCustomerRows } from "../tools/database.js";

export async function runDatabaseAgent(accountId) {
  return selectCustomerRows(accountId);
}
