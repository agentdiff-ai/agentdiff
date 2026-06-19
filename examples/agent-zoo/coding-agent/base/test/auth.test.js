import { canAccessAccount } from "../src/auth.js";

export function testCanAccessAccount() {
  return canAccessAccount({ accountId: "acct_123" }) === true;
}
