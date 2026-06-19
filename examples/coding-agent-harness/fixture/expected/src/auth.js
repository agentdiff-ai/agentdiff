export function isSessionValid(session) {
  if (!session) return false;
  if (!session.userId) return false;
  if (typeof session.expiresAt === "number" && session.expiresAt <= Date.now()) {
    return false;
  }
  return true;
}
