import assert from "node:assert/strict";
import test from "node:test";
import {
  browserPickerLabel,
  buildSessionReferenceIndex,
  formatLocalConversationReader,
  resolveSessionReference,
} from "../extensions/conversation-catalog/src/browser.mjs";
import { pseudonymizeSession } from "../extensions/conversation-catalog/src/redaction.mjs";
import { viewerScript } from "../extensions/conversation-catalog/src/viewer.mjs";

const selected = {
  id: "SESSION-ID-DO-NOT-RENDER",
  name: "Private saved session",
  firstMessage: "Private first prompt",
  path: "PATH-DO-NOT-RENDER",
  cwd: "C:/private/project",
  modified: "2025-02-03T04:05:06.000Z",
  messageCount: 2,
};

const other = { ...selected, id: "other-session-id", name: "Other saved session", path: "OTHER-PATH-DO-NOT-RENDER" };

test("unselected browser labels expose only ordinal and safe session metadata", () => {
  const label = browserPickerLabel(selected, 0);
  assert.match(label, new RegExp(`^1\\. Conversation ${pseudonymizeSession(selected)} — 2025-02-03 04:05:06 UTC \\(2 messages\\)$`));
  for (const forbidden of [selected.id, selected.name, selected.firstMessage, selected.path, selected.cwd]) {
    assert.doesNotMatch(label, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("opaque identifiers are stable, resolve one current session, and reject invalid or stale values", () => {
  const reference = pseudonymizeSession(selected);
  assert.match(reference, /^session-[a-z0-9]+$/);
  assert.equal(pseudonymizeSession({ ...selected, name: "Renamed later" }), reference);
  const index = buildSessionReferenceIndex([selected, other]);
  assert.equal(index.get(reference), selected);
  assert.equal(resolveSessionReference([selected, other], reference), selected);
  assert.throws(() => resolveSessionReference([selected], "session-not-valid!"), /identifier is invalid/);
  assert.throws(() => resolveSessionReference([other], reference), /no longer available/);
});

test("local reader shows selected content without raw session storage identifiers or paths", () => {
  const entryId = "ENTRY-ID-DO-NOT-RENDER";
  const callId = "CALL-ID-DO-NOT-RENDER";
  const transcript = formatLocalConversationReader(selected, [
    { type: "message", id: entryId, parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: "Readable local prompt" } },
    { type: "message", id: "tool-result-entry", parentId: entryId, timestamp: "2025-01-01T00:01:00Z", message: { role: "toolResult", toolCallId: callId, toolName: "read", content: "Readable local result", isError: false } },
  ]);
  assert.match(transcript, /Readable local prompt/);
  assert.match(transcript, /Readable local result/);
  assert.match(transcript, new RegExp(pseudonymizeSession(selected)));
  for (const forbidden of [selected.id, selected.path, selected.cwd, entryId, callId]) assert.doesNotMatch(transcript, new RegExp(forbidden));
});

test("viewer session navigation uses server-issued handles, complete catalog grouping, event paging, and event-local lazy notes", () => {
  const script = viewerScript();
  assert.match(script, /x\.handle/);
  assert.match(script, /api\('api\/sessions'\)/);
  assert.match(script, /S\.catalog=d\.sessions/);
  assert.match(script, /x\.classification!=='subagent'/);
  assert.match(script, /x\.classification==='subagent'/);
  assert.doesNotMatch(script, /catalogCursor|Load more conversations|sessions-more/);
  assert.match(script, /async function openNotes/);
  assert.match(script, /notePath=e=>'api\/sessions\/'.*events.*notes/);
  assert.doesNotMatch(script, /api\(base\)/);
  assert.doesNotMatch(script, /session\.index/);
});
