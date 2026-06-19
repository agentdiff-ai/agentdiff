export async function selectCustomerRows(accountId) {
  return [{ accountId, status: "active" }];
}

export async function updateCustomerRows(accountId, status) {
  return { accountId, status };
}

export async function deleteCustomerRows(accountId) {
  return { accountId, deleted: true };
}
