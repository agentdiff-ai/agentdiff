import { readMemory } from "../tools/memoryStore.js";

export async function runMemoryAgent(userId) {
  return readMemory(userId);
}
