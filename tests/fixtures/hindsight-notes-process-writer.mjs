import { addHindsightNote } from "../../extensions/conversation-catalog/src/hindsight-notes.mjs";

const [projectRoot, sessionReference, index] = process.argv.slice(2);
await addHindsightNote(projectRoot, sessionReference, `Concurrent user-authored note ${index}.`, {
  now: () => `2026-09-01T12:00:${String(index).padStart(2, "0")}.000Z`,
});
