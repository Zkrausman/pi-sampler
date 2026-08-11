import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const paletteModulePath = join(repositoryRoot, "src", "components", "colorPaletteState.ts");

async function loadPaletteModule() {
  const source = readFileSync(paletteModulePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: paletteModulePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("defines exactly eight unique hexadecimal palette colors", async () => {
  const { COLOR_PALETTE } = await loadPaletteModule();

  assert.equal(COLOR_PALETTE.length, 8);
  assert.equal(new Set(COLOR_PALETTE).size, 8);
  for (const color of COLOR_PALETTE) assert.match(color, /^#[0-9A-F]{6}$/);
});

test("copies the selected hex color through navigator.clipboard.writeText", async () => {
  const { copyHexColor } = await loadPaletteModule();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const copied = [];

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (color) => copied.push(color) } },
  });
  try {
    await copyHexColor("#2A9D8F");
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }

  assert.deepEqual(copied, ["#2A9D8F"]);
});

test("only the most recent copied swatch can clear its feedback", async () => {
  const {
    INITIAL_COPY_FEEDBACK_STATE,
    clearCopiedColor,
    markColorCopied,
  } = await loadPaletteModule();
  const firstCopy = markColorCopied(INITIAL_COPY_FEEDBACK_STATE, "#264653");
  const secondCopy = markColorCopied(firstCopy, "#E76F51");

  assert.equal(clearCopiedColor(secondCopy, firstCopy.token), secondCopy);
  assert.deepEqual(clearCopiedColor(secondCopy, secondCopy.token), {
    color: null,
    status: null,
    token: secondCopy.token,
  });
});

test("records and clears temporary feedback when clipboard copying fails", async () => {
  const {
    INITIAL_COPY_FEEDBACK_STATE,
    clearCopiedColor,
    copyHexColor,
    markColorCopyFailed,
  } = await loadPaletteModule();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const clipboardError = new Error("Clipboard permission denied");

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw clipboardError; } } },
  });
  try {
    await assert.rejects(copyHexColor("#E76F51"), clipboardError);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }

  const failureFeedback = markColorCopyFailed(INITIAL_COPY_FEEDBACK_STATE, "#E76F51");
  assert.deepEqual(failureFeedback, { color: "#E76F51", status: "failed", token: 1 });
  assert.deepEqual(clearCopiedColor(failureFeedback, failureFeedback.token), {
    color: null,
    status: null,
    token: failureFeedback.token,
  });
});

test("ColorPalette composes the local Stitch layout primitives", () => {
  const component = readFileSync(join(repositoryRoot, "src", "components", "ColorPalette.tsx"), "utf8");

  assert.match(component, /import \{ Box, Flex, Grid \} from "\.\.\/ui\/ThemeProvider"/);
  assert.match(component, /<Grid/);
  assert.match(component, /<Flex/);
  assert.match(component, /<Box/);
  assert.match(component, /Copied!/);
});

test("ColorPalette catches clipboard failures and announces the failed swatch", () => {
  const component = readFileSync(join(repositoryRoot, "src", "components", "ColorPalette.tsx"), "utf8");

  assert.match(
    component,
    /try\s*{\s*await copyHexColor\(color\);\s*showCopyFeedback\(color, true\);\s*}\s*catch\s*{\s*showCopyFeedback\(color, false\);/s,
  );
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /Copy failed/);
});
