import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertValidFinalReviewAttestation,
  createFinalReviewAttestation,
  createFinalReviewReceipt,
  finalReviewReceiptSha256,
  parseFinalReviewAttestation,
  resumeFinalReviewReceipt,
  revokeFinalReviewReceipt,
  validateFinalReviewAttestation,
  validateFinalReviewReceipt,
} from "../scripts/final-review-receipt.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { TRUSTED_V3_ATTESTATION_ACTIVATION } from "../scripts/validate-adversarial-review-attestation.mjs";

const base = "a".repeat(40);
const head = "b".repeat(40);
const packet = "c".repeat(64);
const matrix = "d".repeat(64);
const evidence = "e".repeat(64);
const laterHead = "f".repeat(40);
const laterPacket = "1".repeat(64);
const laterMatrix = "2".repeat(64);
const laterEvidence = "3".repeat(64);
const time0 = "2026-08-21T00:00:00.000Z";
const time1 = "2026-08-21T00:01:00.000Z";
const time2 = "2026-08-21T00:02:00.000Z";

function receipt(overrides = {}) {
  return createFinalReviewReceipt({
    repository: "Zkrausman/pi-sampler",
    pullRequest: "159",
    base,
    head,
    packetSha256: packet,
    acceptanceMatrixSha256: matrix,
    verificationEvidenceSha256: evidence,
    reviewerModelId: "openai/gpt-5.6",
    reviewProfileVersion: "terra-final-v1",
    lineageId: "opaque-child-lineage",
    recordedAt: time0,
    ...overrides,
  });
}

test("a fresh clean receipt is canonical and renders only minimal v3 provenance", () => {
  const value = receipt();
  const result = validateFinalReviewReceipt(value, { requireClean: true, base, head });
  assert.equal(result.ok, true);
  assert.equal(value.receiptSha256, finalReviewReceiptSha256(value));
  const marker = createFinalReviewAttestation(value, {
    repository: value.repository, pullRequest: value.pullRequest, base: value.base, head: value.head,
    packetSha256: value.packetSha256, acceptanceMatrixSha256: value.acceptanceMatrixSha256,
    verificationEvidenceSha256: value.verificationEvidenceSha256,
  });
  const parsed = parseFinalReviewAttestation(marker);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.base, base);
  assert.equal(parsed.head, head);
  assert.equal(parsed.receiptSha256, value.receiptSha256);
  assert.doesNotMatch(marker, /lineage|session|transcript|finding|token|cost|path/i);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "acceptanceMatrixSha256", "base", "format", "head", "outcome", "packetSha256",
    "receiptSha256", "reviewProfileVersion", "reviewerModelId", "verificationEvidenceSha256", "version",
  ].sort());
});

test("corrections re-review the complete candidate on the same child and cap at two", () => {
  const first = receipt();
  const sameHeadCorrection = () => resumeFinalReviewReceipt(first, {
    head, packetSha256: laterPacket, acceptanceMatrixSha256: laterMatrix,
    verificationEvidenceSha256: laterEvidence, recordedAt: time1,
  });
  assert.throws(sameHeadCorrection, /newly frozen exact head/);
  const second = resumeFinalReviewReceipt(first, {
    head: laterHead,
    packetSha256: laterPacket,
    acceptanceMatrixSha256: laterMatrix,
    verificationEvidenceSha256: laterEvidence,
    recordedAt: time1,
  });
  const third = resumeFinalReviewReceipt(second, {
    head: "0".repeat(40),
    packetSha256: "4".repeat(64),
    acceptanceMatrixSha256: "5".repeat(64),
    verificationEvidenceSha256: "6".repeat(64),
    recordedAt: time2,
  });
  assert.equal(third.lifecycle.correctionCount, 2);
  assert.equal(third.lifecycle.passes.length, 3);
  assert.equal(new Set(third.lifecycle.passes.map((pass) => pass.lineageId)).size, 1);
  assert.equal(validateFinalReviewReceipt(third, { requireClean: true }).ok, true);
  const forgedSameHead = structuredClone(second);
  forgedSameHead.lifecycle.passes[1].head = forgedSameHead.lifecycle.passes[0].head;
  forgedSameHead.head = forgedSameHead.lifecycle.passes[0].head;
  forgedSameHead.lifecycle.passes[1].packetSha256 = "4".repeat(64);
  forgedSameHead.packetSha256 = "4".repeat(64);
  forgedSameHead.receiptSha256 = finalReviewReceiptSha256(forgedSameHead);
  assert.equal(validateFinalReviewReceipt(forgedSameHead).ok, false);
  const forgedSameInputs = structuredClone(second);
  forgedSameInputs.lifecycle.passes[1].head = "0".repeat(40);
  forgedSameInputs.lifecycle.passes[1].packetSha256 = forgedSameInputs.lifecycle.passes[0].packetSha256;
  forgedSameInputs.lifecycle.passes[1].acceptanceMatrixSha256 = forgedSameInputs.lifecycle.passes[0].acceptanceMatrixSha256;
  forgedSameInputs.lifecycle.passes[1].verificationEvidenceSha256 = forgedSameInputs.lifecycle.passes[0].verificationEvidenceSha256;
  forgedSameInputs.packetSha256 = forgedSameInputs.lifecycle.passes[0].packetSha256;
  forgedSameInputs.acceptanceMatrixSha256 = forgedSameInputs.lifecycle.passes[0].acceptanceMatrixSha256;
  forgedSameInputs.verificationEvidenceSha256 = forgedSameInputs.lifecycle.passes[0].verificationEvidenceSha256;
  forgedSameInputs.head = "0".repeat(40);
  forgedSameInputs.receiptSha256 = finalReviewReceiptSha256(forgedSameInputs);
  assert.equal(validateFinalReviewReceipt(forgedSameInputs).ok, false);
  assert.throws(() => createFinalReviewAttestation(forgedSameHead, {
    repository: forgedSameHead.repository, pullRequest: forgedSameHead.pullRequest, base: forgedSameHead.base,
    head: forgedSameHead.head, packetSha256: forgedSameHead.packetSha256,
    acceptanceMatrixSha256: forgedSameHead.acceptanceMatrixSha256,
    verificationEvidenceSha256: forgedSameHead.verificationEvidenceSha256,
  }), /correction/);
  const generatedA = createFinalReviewReceipt({ repository: "Zkrausman/pi-sampler", pullRequest: "159", base, head, packetSha256: packet, acceptanceMatrixSha256: matrix, verificationEvidenceSha256: evidence, reviewerModelId: "openai/gpt-5.6", reviewProfileVersion: "terra-final-v1", recordedAt: time0 });
  const generatedB = createFinalReviewReceipt({ repository: "Zkrausman/pi-sampler", pullRequest: "159", base, head, packetSha256: packet, acceptanceMatrixSha256: matrix, verificationEvidenceSha256: evidence, reviewerModelId: "openai/gpt-5.6", reviewProfileVersion: "terra-final-v1", recordedAt: time0 });
  assert.notEqual(generatedA.lifecycle.lineageId, generatedB.lifecycle.lineageId);
  assert.notEqual(generatedA.nonce, generatedB.nonce);
  assert.throws(() => resumeFinalReviewReceipt(third, {
    head: "1".repeat(40), packetSha256: "7".repeat(64),
    acceptanceMatrixSha256: "8".repeat(64), verificationEvidenceSha256: "9".repeat(64), recordedAt: "2026-08-21T00:03:00.000Z",
  }), /correction limit/);
});

test("blocker output and later Terra findings revoke clean state even at unchanged HEAD", () => {
  const blocked = receipt({ outcome: "blocked", blockerCount: 1, recordedAt: time0 });
  assert.equal(validateFinalReviewReceipt(blocked, { requireClean: true }).ok, false);
  assert.throws(() => createFinalReviewAttestation(blocked, {
    repository: blocked.repository, pullRequest: blocked.pullRequest, base: blocked.base, head: blocked.head,
    packetSha256: blocked.packetSha256, acceptanceMatrixSha256: blocked.acceptanceMatrixSha256,
    verificationEvidenceSha256: blocked.verificationEvidenceSha256,
  }), /current clean/);
  const clean = receipt();
  const revoked = revokeFinalReviewReceipt(clean, { reason: "later authenticated Terra blocker", source: "terra-parent", recordedAt: time1 });
  assert.equal(revoked.head, clean.head);
  assert.equal(revoked.receiptSha256 === clean.receiptSha256, false);
  assert.equal(validateFinalReviewReceipt(revoked).ok, true);
  assert.equal(validateFinalReviewReceipt(revoked, { requireClean: true }).ok, false);
  const cleanMarker = createFinalReviewAttestation(clean, {
    repository: clean.repository, pullRequest: clean.pullRequest, base: clean.base, head: clean.head,
    packetSha256: clean.packetSha256, acceptanceMatrixSha256: clean.acceptanceMatrixSha256,
    verificationEvidenceSha256: clean.verificationEvidenceSha256,
  });
  assert.equal(validateFinalReviewAttestation(cleanMarker, clean, {
    repository: clean.repository, pullRequest: clean.pullRequest, base: clean.base, head: clean.head,
  }).ok, true);
  const revokedMarkerValidation = validateFinalReviewAttestation(cleanMarker, revoked, {
    repository: revoked.repository, pullRequest: revoked.pullRequest, base: revoked.base, head: revoked.head,
  });
  assert.equal(revokedMarkerValidation.ok, false);
  assert.equal(validateFinalReviewReceipt(revoked, { attestation: cleanMarker }).ok, false);
  assert.match(revokedMarkerValidation.errors[0], /current clean|non-revoked receipt/);
  assert.throws(() => assertValidFinalReviewAttestation(cleanMarker, revoked, {
    repository: revoked.repository, pullRequest: revoked.pullRequest, base: revoked.base, head: revoked.head,
  }), /current clean|non-revoked receipt/);
  assert.throws(() => createFinalReviewAttestation(revoked, {
    repository: revoked.repository, pullRequest: revoked.pullRequest, base: revoked.base, head: revoked.head,
    packetSha256: revoked.packetSha256, acceptanceMatrixSha256: revoked.acceptanceMatrixSha256,
    verificationEvidenceSha256: revoked.verificationEvidenceSha256,
  }), /current clean/);
  assert.throws(() => createFinalReviewAttestation(receipt()), /all exact frozen/);
});

test("head, packet, matrix, evidence, model, and profile mismatches fail closed", () => {
  const value = receipt();
  for (const [key, expected] of [
    ["nonce", "0".repeat(32)], ["head", laterHead], ["packetSha256", laterPacket], ["acceptanceMatrixSha256", laterMatrix],
    ["verificationEvidenceSha256", laterEvidence], ["reviewerModelId", "anthropic/claude"], ["reviewProfileVersion", "other-v1"],
  ]) assert.equal(validateFinalReviewReceipt(value, { [key]: expected }).ok, false, key);
  assert.equal(validateFinalReviewReceipt(value, { currentHead: laterHead }).ok, false);
});

test("the local receipt schema is strict and matches the bounded contract", async () => {
  const schema = JSON.parse(await readFile(join(process.cwd(), "docs", "final-review-receipt-v1.schema.json"), "utf8"));
  assert.equal(schema.$id, "https://pi-sampler.dev/schemas/final-review-receipt-v1.json");
  const visit = (value, path = "$") => {
    if (!value || typeof value !== "object") return;
    if (value.type === "object") assert.equal(value.additionalProperties, false, `${path} must reject additional properties`);
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  };
  visit(schema);
  assert.ok(schema.required.includes("nonce"));
  assert.equal(schema.properties.outcome.enum.join(","), "clean,blocked");
});

test("a v3 marker validates exact packet bytes and rejects a v2 downgrade when required", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-final-review-receipt-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Final review test");
    await writeFile(join(cwd, "tracked.txt"), "base\n");
    await mkdir(join(cwd, "scripts"));
    await mkdir(join(cwd, "profiles"));
    await writeFile(join(cwd, "profiles", "pi-sampler.json"), `${JSON.stringify({
      repository: { source: "Zkrausman/pi-sampler" },
      delivery: { branchPrefix: "zkrausman" },
      workItem: { idPattern: "^AIDEV-[0-9]+$" },
    })}\n`);
    await writeFile(join(cwd, "scripts", "validate-adversarial-review-attestation.mjs"), "export const legacyTrustedValidator = true;\n");
    git("add", "tracked.txt", "profiles/pi-sampler.json", "scripts/validate-adversarial-review-attestation.mjs"); git("commit", "--quiet", "-m", "base");
    await writeFile(join(cwd, "scripts", "validate-adversarial-review-attestation.mjs"), `export const TRUSTED_V3_ATTESTATION_ACTIVATION = ${JSON.stringify(TRUSTED_V3_ATTESTATION_ACTIVATION)};\n`);
    git("add", "scripts/validate-adversarial-review-attestation.mjs"); git("commit", "--quiet", "-m", "activate v3");
    const exactBase = git("rev-parse", "HEAD");
    await writeFile(join(cwd, "tracked.txt"), "head\n");
    git("add", "tracked.txt"); git("commit", "--quiet", "-m", "head");
    const exactHead = git("rev-parse", "HEAD");
    const generator = join(process.cwd(), "scripts", "generate-review-packet.mjs");
    const packetText = execFileSync(process.execPath, [generator, "--base", exactBase, "--head", exactHead], { cwd, encoding: "utf8" });
    const packetSha256 = createHash("sha256").update(packetText).digest("hex");
    const marker = `<!-- pi-sampler-adversarial-review-attestation:v3 ${JSON.stringify({
      format: "pi-sampler.adversarial-review-attestation", version: 3, base: exactBase, head: exactHead,
      outcome: "clean", packetSha256, acceptanceMatrixSha256: matrix, verificationEvidenceSha256: evidence,
      reviewerModelId: "openai/gpt-5.6", reviewProfileVersion: "terra-final-v1", receiptSha256: packetSha256,
    })} -->`;
    const validator = join(process.cwd(), "scripts", "validate-adversarial-review-attestation.mjs");
    const run = (body, extra = []) => spawnSync(process.execPath, [validator, "--base", exactBase, "--head", exactHead, "--branch", "zkrausman/aidev-159-final-gate", ...extra], {
      cwd, encoding: "utf8", input: undefined, env: { ...process.env, ADVERSARIAL_REVIEW_PR_BODY: body },
    });
    assert.equal(run(marker).status, 0);
    const v2 = marker.replace(":v3", ":v2").replace(/,"acceptanceMatrixSha256"[^}]+/, "");
    assert.notEqual(run(v2).status, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
