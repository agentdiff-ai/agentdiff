import { canAccessAccount } from "../src/auth.js";

export function testCanAccessAccount() {
  return canAccessAccount({}) === false;
}
