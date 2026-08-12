import { addHindsightNote, hindsightNotesEventReference } from "../../extensions/conversation-catalog/src/hindsight-notes.mjs";

const [projectRoot, sessionReference, index] = process.argv.slice(2);
const sessionId = `writer-session-${sessionReference}`; const eventIdentity = `writer-${index}`;
await addHindsightNote(projectRoot, sessionReference, hindsightNotesEventReference(sessionId, eventIdentity), "Concurrent writer event", `Concurrent user-authored note ${index}.`, {
  now: () => `2026-09-01T12:00:${String(index).padStart(2, "0")}.000Z`, actualSessionId: sessionId, eventIdentity,
});
