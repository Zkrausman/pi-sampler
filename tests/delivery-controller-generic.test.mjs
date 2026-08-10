import assert from "node:assert/strict";
import test from "node:test";
import { buildVerificationRecords, validateReviewInput } from "../extensions/delivery-controller/src/pi-review-worker.mjs";
import { IMPLEMENTATION_PROMPT_PACK, renderPromptPack } from "../extensions/delivery-controller/src/jules-prompt-pack.mjs";
import { reviewInputFromProfile } from "../extensions/delivery-controller/src/project-profile.mjs";
import exampleProfile from "../profiles/example-project.json" with { type: "json" };

const sha = "a".repeat(40);
const validInput = {
  ticketId: "ENG-42",
  candidateBranch: "feature/eng-42",
  candidateCommitSha: sha,
  baseRef: "origin/main",
  baseCommitSha: sha,
  reviewerSessionId: "reviewer-42",
  reviewerIdentity: "reviewer@example.invalid",
  verificationCommands: [
    { command: "npm", args: ["test"], label: "npm test" },
    { command: "npm", args: ["run", "lint"], label: "npm run lint" },
  ],
};

test("review worker derives verification commands from a validated consumer profile", () => {
  const profileInput = reviewInputFromProfile(exampleProfile, { ...validInput, ticketId: "ENG-42" });
  const input = validateReviewInput(profileInput);
  assert.deepEqual(input.verificationCommands.map(({ label }) => label), ["npm test", "npm run lint"]);
  assert.throws(() => reviewInputFromProfile(exampleProfile, { ...validInput, ticketId: "OTHER-42" }), /work_item_id_does_not_match_profile/);
});

test("failure markers stay failed until project policy classifies them", () => {
  const [record] = buildVerificationRecords([{ command: "npm test", exitCode: 0, output: "[FAIL] smoke" }]);
  assert.equal(record.outcome, "failed");
  assert.equal(record.classification, "failure-marker");
});

test("prompt pack receives instructions from the consumer profile", () => {
  const prompt = renderPromptPack(IMPLEMENTATION_PROMPT_PACK, {
    workItemId: "ENG-42",
    branch: "feature/eng-42",
    baseRef: "origin/main",
    instructions: ["Read CONTRIBUTING.md before editing."],
  });
  assert.match(prompt, /Read CONTRIBUTING\.md/);
  assert.match(prompt, /configured verification contract/);
});
