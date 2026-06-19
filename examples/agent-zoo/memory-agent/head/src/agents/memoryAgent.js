import { updateMemory, deleteMemory } from "../tools/memoryStore.js";

export async function runMemoryAgent(userId, memoryId, value) {
  await updateMemory(userId, memoryId, value);
  return deleteMemory(userId, memoryId);
}
