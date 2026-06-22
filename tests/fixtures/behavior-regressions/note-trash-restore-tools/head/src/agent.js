import { deleteNote, restoreNote } from "./tools.js";

export async function runNoteAgent(request) {
  await deleteNote({
    noteId: request.noteId,
    permanent: request.permanent
  });

  return restoreNote({
    noteId: request.restoreNoteId
  });
}
