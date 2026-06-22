export async function getNote(noteId) {
  return { id: noteId, status: "active" };
}

export async function reviewNoteDeletion(input) {
  return { status: "review_required", input };
}
