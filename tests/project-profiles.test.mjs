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
  const review = profile.delivery.review;
  assert.equal(typeof review.workspaceRoot, "string");
  assert.equal(typeof review.quarantineRoot, "string");
  assert.equal(review.remotePolicy, "none");
  assert.ok(Number.isSafeInteger(review.quarantineRetentionSeconds));
  assert.ok(review.quarantineRetentionSeconds >= 0);
  for (const limit of ["maxWorkspaces", "maxWorkspaceBytes", "maxQuarantineBytes", "maxUntrackedEntries", "maxUntrackedBytes"]) assert.ok(Number.isSafeInteger(review.limits[limit]));
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
  assert.ok(schema.properties.delivery.required.includes("review"));
  assertProfile(example);
  assertProfile(gelt);
  assertProfile(piSampler);

  const reviewSchema = schema.properties.delivery.properties.review;
  const limitsSchema = reviewSchema.properties.limits;
  assert.equal(schema.properties.delivery.required.includes("review"), true);
  assert.equal(reviewSchema.additionalProperties, false);
  assert.deepEqual(reviewSchema.required, ["workspaceRoot", "quarantineRoot", "remotePolicy", "quarantineRetentionSeconds", "limits"]);
  assert.equal(limitsSchema.additionalProperties, false);
  assert.deepEqual(limitsSchema.required, ["maxWorkspaces", "maxWorkspaceBytes", "maxQuarantineBytes", "maxUntrackedEntries", "maxUntrackedBytes"]);
  assert.deepEqual(piSampler.delivery.review, {
    workspaceRoot: "../ai-workspaces/review",
    quarantineRoot: "../ai-workspaces/review-quarantine",
    remotePolicy: "none",
    quarantineRetentionSeconds: 86400,
    limits: {
      maxWorkspaces: 16,
      maxWorkspaceBytes: 2147483648,
      maxQuarantineBytes: 2147483648,
      maxUntrackedEntries: 512,
      maxUntrackedBytes: 536870912,
    },
  });
  assert.ok(example.delivery.review);
  assert.ok(gelt.delivery.review);
  assert.equal(reviewSchema.properties.quarantineRetentionSeconds.minimum, 0);
  assert.equal(reviewSchema.properties.quarantineRetentionSeconds.maximum, 31536000);
  assert.equal(limitsSchema.properties.maxWorkspaces.minimum, 1);
  assert.equal(limitsSchema.properties.maxWorkspaces.maximum, 256);
  assert.equal(limitsSchema.properties.maxWorkspaceBytes.minimum, 1048576);
  assert.equal(limitsSchema.properties.maxWorkspaceBytes.maximum, 9007199254740991);
  assert.equal(limitsSchema.properties.maxQuarantineBytes.minimum, 1048576);
  assert.equal(limitsSchema.properties.maxQuarantineBytes.maximum, 9007199254740991);
  assert.equal(limitsSchema.properties.maxUntrackedEntries.minimum, 1);
  assert.equal(limitsSchema.properties.maxUntrackedEntries.maximum, 100000);
  assert.equal(limitsSchema.properties.maxUntrackedBytes.minimum, 0);
  assert.equal(limitsSchema.properties.maxUntrackedBytes.maximum, 9007199254740991);
});
