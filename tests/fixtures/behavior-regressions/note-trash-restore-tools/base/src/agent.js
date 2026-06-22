import { getNote, reviewNoteDeletion } from "./tools.js";

export async function runNoteAgent(request) {
  const note = await getNote(request.noteId);
  return reviewNoteDeletion({
    note,
    requestedBy: request.userId
  });
}
