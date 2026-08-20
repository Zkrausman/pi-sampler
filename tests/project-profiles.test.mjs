import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function readJson(...parts) {
  return JSON.parse(await readFile(join(root, ...parts), "utf8"));
}

function assertProfile(profile) {
  assert.match(profile.projectId, /^[a-z][a-z0-9-]{1,63}$/);
  assert.equal(typeof profile.workItem.idPattern, "string");
  assert.ok(profile.workItem.idPattern.length > 0);
  assert.equal(typeof profile.repository.source, "string");
  assert.ok(profile.repository.source.length > 0);
  assert.match(profile.delivery.remote, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.equal(typeof profile.delivery.baseBranch, "string");
  assert.ok(profile.delivery.baseBranch.length > 0);
  assert.equal(typeof profile.delivery.worktreeRoot, "string");
  assert.ok(profile.delivery.worktreeRoot.length > 0);
  assert.match(profile.delivery.branchPrefix, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.ok(Number.isSafeInteger(profile.delivery.suffixLength));
  assert.ok(profile.delivery.suffixLength >= 4 && profile.delivery.suffixLength <= 12);
  assert.ok(Array.isArray(profile.verification.commands) && profile.verification.commands.length > 0);
  for (const command of profile.verification.commands) {
    assert.equal(typeof command.command, "string");
    assert.ok(Array.isArray(command.args));
  }
  assert.ok(Array.isArray(profile.governance.requiredChecks));
  assert.equal(typeof profile.governance.paths.evidence, "string");
  assert.equal(typeof profile.governance.paths.specification, "string");
}

test("project-profile schema and examples preserve consumer-owned configuration boundaries", async () => {
  const [schema, example, gelt, piSampler] = await Promise.all([
    readJson("profiles", "project-profile.schema.json"),
    readJson("profiles", "example-project.json"),
    readJson("profiles", "gelt-trading.example.json"),
    readJson("profiles", "pi-sampler.json"),
  ]);
  assert.equal(schema.title, "Pi Sampler project profile");
  assert.deepEqual(schema.required, ["projectId", "workItem", "repository", "delivery", "verification", "governance"]);
  assert.equal(schema.additionalProperties, false);
  assertProfile(example);
  assertProfile(gelt);
  assertProfile(piSampler);
});
