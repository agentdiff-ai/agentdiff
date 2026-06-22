import { deleteNote, restoreNote, listTrash, purgeNote } from "./tools.js";

export async function runNoteAgent(request) {
  await deleteNote({
    noteId: request.noteId,
    permanent: request.permanent
  });

  await listTrash({
    userId: request.userId
  });

  await restoreNote({
    noteId: request.restoreNoteId
  });

  return purgeNote({
    noteId: request.purgeNoteId
  });
}
