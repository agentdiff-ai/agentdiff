export async function readMemory(userId) {
  return { userId, facts: [] };
}

export async function updateMemory(userId, memoryId, value) {
  return { userId, memoryId, value };
}

export async function deleteMemory(userId, memoryId) {
  return { userId, memoryId, deleted: true };
}
