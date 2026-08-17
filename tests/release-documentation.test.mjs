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
  assert.match(readme, /Pi Excalidraw remains a separate, human-in-the-loop productivity plugin/);
});

test("public documentation retains local-data, security, platform, provenance, and surviving-system boundaries", async () => {
  const [readme, privacy, platform, security, contributing] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "docs", "PRIVACY.md"), "utf8"),
    readFile(join(root, "docs", "PLATFORM-AND-TRADEMARKS.md"), "utf8"),
    readFile(join(root, "SECURITY.md"), "utf8"),
    readFile(join(root, "CONTRIBUTING.md"), "utf8"),
  ]);
  assert.match(readme, /not affiliated with or endorsed by/);
  assert.match(readme, /umbrella repository for multiple independent Pi\s+extensions/);
  assert.match(readme, /zero supported or installable\s+\*\*packaged\*\* extensions/);
  assert.match(readme, /pi-evolution.*single coherent\s+self-evolution plugin/s);
  assert.match(readme, /Pi Excalidraw remains a separate, human-in-the-loop productivity plugin/);
  assert.match(readme, /does \*\*not\*\* own lifecycle authority,\s+evolution evidence, lessons, or promotion decisions/);
  assert.match(readme, /Use Pi Excalidraw only in a\s+trusted local project/);
  assert.match(readme, /hostile concurrent\s+actor replaces filesystem objects after validation/);
  assert.match(readme, /Node 24 or later and its experimental built-in\s+`node:sqlite` API/);
  assert.match(readme, /nodes: Client, API, Database; Client -> API -> Database/);
  assert.match(readme, /JSON-formatted visual nodes and arrow connections/);
  assert.match(readme, /Project profiles/);
  assert.match(readme, /Optional governance module/);
  assert.match(readme, /npm run validate:governance/);
  assert.match(readme, /go test -race \.\/\.\./);
  assert.match(privacy, /does not\s+provide a repository-operated hosted service, account system, analytics endpoint,\s+or telemetry service/);
  assert.match(privacy, /do\s+not call a network service or start a subprocess/);
  assert.match(platform, /not affiliated\s+with, sponsored by, or endorsed by/);
  assert.match(security, /private vulnerability reporting/);
  assert.match(contributing, /Developer Certificate of Origin \(DCO\)\s*1\.1/);
});
