export async function deleteNote(input) {
  return { status: input.permanent ? "purged" : "trashed", noteId: input.noteId };
}

export async function restoreNote(input) {
  return { status: "restored", noteId: input.noteId };
}

export async function listTrash(input) {
  return { status: "listed", userId: input.userId };
}

export async function purgeNote(input) {
  return { status: "purged", noteId: input.noteId };
}
