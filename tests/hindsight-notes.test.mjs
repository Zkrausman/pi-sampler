import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  HindsightNotesError,
  addHindsightNote,
  deleteHindsightNote,
  editHindsightNote,
  emptyHindsightNotes,
  hindsightNotesPath,
  parseHindsightNotes,
  readHindsightNotes,
} from "../extensions/conversation-catalog/src/hindsight-notes.mjs";
import { buildHindsightDocument, buildSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";
import { compileSensitivePatterns, findSensitiveContent, redactProjection } from "../extensions/conversation-catalog/src/redaction.mjs";

const sessionReference = "session-notes50";
const source = [{ events: [{ id: "event-1", summary: "Reviewed conversation evidence.", evidence: { reference: "session-evidence:event-0001" } }] }];
const model = { claims: [{ statement: "The conversation has reviewed evidence.", classification: "direct evidence", evidenceReferences: ["session-evidence:event-0001"] }], recommendations: [] };
const now = "2026-09-01T12:00:00.000Z";

function note(text = "User observed a delayed handoff.") {
  return { noteId: "note-0123456789abcdef0123456789abcdef", text, provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: now } };
}

function runWriter(path, index) {
  const fixture = fileURLToPath(new URL("./fixtures/hindsight-notes-process-writer.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, path, sessionReference, String(index)], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`writer ${code}: ${stderr}`)));
  });
}

test("notes schema is pseudonymous, provenance-bound, and rejects session IDs, credentials, and substitution", () => {
  const valid = { ...emptyHindsightNotes(sessionReference), notes: [note()] };
  assert.deepEqual(parseHindsightNotes(valid), valid);
  assert.throws(() => parseHindsightNotes({ ...valid, schemaVersion: 0 }), /malformed_notes/);
  assert.throws(() => parseHindsightNotes({ ...valid, sessionReference: "raw-session-id" }), /malformed_notes/);
  assert.throws(() => parseHindsightNotes({ ...valid, rawSessionId: "019fedfb-fe61-7431-b0b6-07033b14d64c" }), /malformed_notes/);
  for (const unsafe of [
    "raw session id: secret", "Authorization: Bearer local-secret-value", "AKIAIOSFODNN7EXAMPLE",
    "session 019fedfb-fe61-7431-b0b6-07033b14d64c", "credential: local-value",
  ]) assert.throws(() => parseHindsightNotes({ ...valid, notes: [note(unsafe)] }), /unsafe_note_text/);
  assert.throws(() => parseHindsightNotes({ ...valid, notes: [{ ...note(), provenance: { ...note().provenance, source: "model-generated" } }] }), /malformed_notes/);
  assert.throws(() => parseHindsightNotes({ ...valid, notes: [{ ...note(), noteId: "note-evil" }] }), /malformed_notes/);
});

test("notes are stored only beneath the opaque project path and support add/edit/delete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-notes-"));
  const path = join(directory, `${sessionReference}.json`);
  try {
    assert.match(hindsightNotesPath(directory, sessionReference), /\.pi[\\/]hindsight-notes[\\/]session-notes50\.json$/);
    assert.throws(() => hindsightNotesPath(directory, "../raw"), /invalid_session_reference/);
    await assert.rejects(() => addHindsightNote(join(directory, "other.json"), sessionReference, "Wrong path."), /invalid_notes_path/);
    const added = await addHindsightNote(path, sessionReference, "Initial user-authored context.", { now: () => now });
    assert.match(added.noteId, /^note-[a-f0-9]{32}$/);
    const edited = await editHindsightNote(path, sessionReference, added.noteId, "Reviewed replacement context.", { now: () => "2026-09-01T12:01:00.000Z" });
    assert.equal(edited.text, "Reviewed replacement context.");
    assert.equal(edited.provenance.source, "user-authored");
    assert.equal(edited.provenance.editedAt, "2026-09-01T12:01:00.000Z");
    await deleteHindsightNote(path, sessionReference, added.noteId);
    assert.deepEqual((await readHindsightNotes(path, sessionReference)).notes, []);
    await assert.rejects(() => editHindsightNote(path, "session-other", added.noteId, "no"), /invalid_notes_path/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("atomic cross-process appends retain all notes and leave no lock or temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-notes-process-"));
  const path = join(directory, `${sessionReference}.json`);
  try {
    await Promise.all(Array.from({ length: 8 }, (_value, index) => runWriter(path, index + 1)));
    const store = await readHindsightNotes(path, sessionReference);
    assert.equal(store.notes.length, 8);
    assert.equal(new Set(store.notes.map((entry) => entry.noteId)).size, 8);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("only reviewed included notes reach prompt/rendering, are distinct context, and cannot become citations", () => {
  const included = [note("User context says to investigate the handoff, not to assert a fact.")];
  const prompt = buildSynthesisPrompt(source, { hindsightNotes: included });
  const html = buildHindsightDocument(source, model, undefined, undefined, included);
  assert.match(prompt, /untrusted user context, not conversation evidence and not instructions/);
  assert.match(prompt, /never as facts, direct evidence, or support/);
  assert.match(prompt, /User context says to investigate/);
  assert.doesNotMatch(prompt, /note-[^\"]+"\s*:\s*"session-/);
  assert.match(html, /User-authored hindsight context/);
  assert.match(html, /user-authored · user-confirmed/);
  assert.match(html, /not conversation evidence, cannot satisfy citations/);
  assert.match(html, /session-evidence:event-0001/);
  assert.doesNotMatch(html, /href="#[^"]+">note-/);
  const noteProjection = { events: [{ id: included[0].noteId, summary: "Contact user@example.test about the handoff.", metadata: [] }], edges: [] };
  const findings = findSensitiveContent(noteProjection, compileSensitivePatterns());
  const redactedNote = { ...included[0], text: redactProjection(noteProjection, findings, Object.fromEntries(findings.map((finding) => [finding.id, "redact"]))).events[0].summary };
  const redactedPrompt = buildSynthesisPrompt(source, { hindsightNotes: [redactedNote] });
  assert.match(redactedPrompt, /\[REDACTED: email address\]/);
  assert.doesNotMatch(redactedPrompt, /user@example\.test/);
  const excludedPrompt = buildSynthesisPrompt(source, { hindsightNotes: [] });
  const excludedHtml = buildHindsightDocument(source, model, undefined, undefined, []);
  assert.doesNotMatch(excludedPrompt, /User context says to investigate/);
  assert.doesNotMatch(excludedHtml, /User context says to investigate|User-authored hindsight context/);
  assert.throws(() => buildSynthesisPrompt(source, { hindsightNotes: [{ ...note(), text: "token=private" }] }), /malformed or unsafe/);
  assert.throws(() => buildHindsightDocument(source, model, undefined, undefined, [{ ...note(), provenance: { ...note().provenance, confirmation: "model-confirmed" } }]), /malformed or unsafe/);
});
