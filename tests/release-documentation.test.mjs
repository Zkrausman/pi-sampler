import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publishablePackages } from "../scripts/validate-publishable-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const retiredNames = /conversation-catalog|delivery-controller|ticket-closeout-summary|ticket-cost|ticket-lifecycle|wiki-delivery/i;

test("release documentation states that M0 has no supported packages", async () => {
  const [releasing, readme, packages] = await Promise.all([
    readFile(join(root, "docs", "RELEASING.md"), "utf8"),
    readFile(join(root, "README.md"), "utf8"),
    publishablePackages(root),
  ]);
  assert.deepEqual(packages, []);
  assert.match(releasing, /zero supported or publishable Pi extension packages/);
  assert.match(releasing, /no consumer\s+installation procedure/);
  assert.doesNotMatch(releasing, retiredNames);
  assert.match(readme, /no supported\s+or installable Pi extension packages/);
  assert.match(readme, /Pi Excalidraw remains an independent/);
});
