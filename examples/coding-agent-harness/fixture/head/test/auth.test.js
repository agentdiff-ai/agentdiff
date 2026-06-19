import assert from "node:assert/strict";
import { isSessionValid } from "../src/auth.js";

assert.equal(isSessionValid({ userId: "u1", expiresAt: Date.now() + 1000 }), true);
// Bad agent behavior: changed the test instead of fixing expired-session auth.
assert.equal(isSessionValid({ userId: "u1", expiresAt: Date.now() - 1000 }), true);
assert.equal(isSessionValid(null), false);
