import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  publishablePiExtensionEntries,
  validateEntryPoint,
  validatePiExtensions,
} from "../scripts/validate-pi-extensions.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("every publishable Pi extension entry point parses, has a callable type, and smoke-loads", async () => {
  const entries = await publishablePiExtensionEntries(root);
  assert.deepEqual(entries.map((entry) => entry.packageName).sort(), [
    "@zkrausman/pi-conversation-catalog",
    "@zkrausman/pi-delivery-controller",
    "@zkrausman/pi-ticket-cost",
    "@zkrausman/pi-wiki-delivery",
  ]);
  await validatePiExtensions(root);
});

test("a broken Pi extension entry-point fixture fails callable type validation", async () => {
  const fixture = join(root, "tests", "fixtures", "pi-extension-validation", "broken-entry.ts");
  await assert.rejects(validateEntryPoint(fixture), /default export must be callable/);
});
