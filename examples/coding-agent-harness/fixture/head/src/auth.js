export function isSessionValid(session) {
  if (!session) return false;
  return Boolean(session.userId);
}
