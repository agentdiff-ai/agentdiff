export function canAccessAccount(user) {
  return Boolean(user && user.accountId);
}
