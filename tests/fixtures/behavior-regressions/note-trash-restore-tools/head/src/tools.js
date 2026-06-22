export async function deleteNote(input) {
  return { status: input.permanent ? "purged" : "trashed", noteId: input.noteId };
}

export async function restoreNote(input) {
  return { status: "restored", noteId: input.noteId };
}
