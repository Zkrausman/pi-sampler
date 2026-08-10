export const IMPLEMENTATION_PROMPT_PACK_VERSION = "implementation-v2";

function normalizeInstructions(instructions) {
  if (!Array.isArray(instructions) || instructions.some((instruction) => typeof instruction !== "string" || instruction.trim() === "")) {
    throw Object.assign(new Error("invalid_project_instructions"), { code: "invalid_project_instructions" });
  }
  return instructions;
}

export const IMPLEMENTATION_PROMPT_PACK = Object.freeze({
  version: IMPLEMENTATION_PROMPT_PACK_VERSION,
  render({ workItemId, branch, baseRef, instructions }) {
    const projectInstructions = normalizeInstructions(instructions);
    return [
      "## Execution Requirements",
      ...projectInstructions.map((instruction) => `- ${instruction}`),
      `Work only on branch ${branch} from ${baseRef}; do not modify unrelated files.`,
      "Run the configured verification contract exactly and record each failure, cause, correction, and rerun result.",
      `If publication is explicitly authorized for ${workItemId}, use the configured provider action. If it is unavailable, leave the completed change set intact and report the publication blocker; do not claim a pull request exists.`,
    ].join("\n");
  },
});

export function validatePromptPack(pack) {
  if (pack !== IMPLEMENTATION_PROMPT_PACK) throw Object.assign(new Error("invalid_prompt_pack"), { code: "invalid_prompt_pack" });
  if (typeof pack.version !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(pack.version) || typeof pack.render !== "function") {
    throw Object.assign(new Error("invalid_prompt_pack"), { code: "invalid_prompt_pack" });
  }
  return pack;
}

export function renderPromptPack(pack, context) {
  validatePromptPack(pack);
  let rendered;
  try { rendered = pack.render(context); } catch { throw Object.assign(new Error("invalid_prompt_pack"), { code: "invalid_prompt_pack" }); }
  if (typeof rendered !== "string" || rendered.trim() === "" || !rendered.includes("configured verification contract") || !rendered.includes("do not claim a pull request exists")) {
    throw Object.assign(new Error("invalid_prompt_pack"), { code: "invalid_prompt_pack" });
  }
  return rendered;
}
