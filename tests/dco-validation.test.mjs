import assert from "node:assert/strict";
import test from "node:test";
import { validateDco } from "../scripts/validate-dco.mjs";

const base = "a".repeat(40);
const head = "b".repeat(40);
const signed = "c".repeat(40);
const unsigned = "d".repeat(40);

function runner(messages) {
  return async (args) => {
    if (args[0] === "rev-parse") return { stdout: `${args.at(-1).startsWith("base") ? base : head}\n`, stderr: "" };
    if (args[0] === "rev-list") return { stdout: `${Object.keys(messages).join("\n")}\n`, stderr: "" };
    if (args[0] === "show") return { stdout: messages[args.at(-1)], stderr: "" };
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

test("DCO validator accepts every introduced commit with a valid sign-off", async () => {
  const commits = await validateDco({
    baseRef: "base",
    headRef: "head",
    gitRunner: runner({ [signed]: "feat: compliant\n\nSigned-off-by: Contributor <contributor@example.com>\n" }),
  });
  assert.deepEqual(commits, [signed]);
});

test("DCO validator rejects an introduced commit without a sign-off", async () => {
  await assert.rejects(
    validateDco({
      baseRef: "base",
      headRef: "head",
      gitRunner: runner({ [signed]: "Signed-off-by: Contributor <contributor@example.com>\n", [unsigned]: "fix: unsigned\n" }),
    }),
    new RegExp(`DCO sign-off missing from commit\\(s\\): ${unsigned}`),
  );
});
