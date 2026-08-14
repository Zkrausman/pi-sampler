import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publishablePackages, validatePackedArtifact } from "../scripts/validate-publishable-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = {
  name: "@example/pi-extension",
  version: "1.2.3",
  files: ["src", "README.md"],
  bin: { "pi-example": "bin/pi-example.mjs" },
  exports: "./src/index.mjs",
  pi: { extensions: ["./src/index.ts"] },
};
const completeArtifact = {
  name: manifest.name,
  version: manifest.version,
  files: [
    { path: "package.json" },
    { path: "README.md" },
    { path: "bin/pi-example.mjs" },
    { path: "src/index.mjs" },
    { path: "src/index.ts" },
  ],
};

test("publishable package discovery excludes withdrawn private workspaces", async () => {
  const packages = await publishablePackages(root);
  assert.deepEqual(packages.map((packageInfo) => packageInfo.manifest.name).sort(), [
    "@zkrausman/pi-conversation-catalog",
    "@zkrausman/pi-delivery-controller",
    "@zkrausman/pi-ticket-closeout-summary",
    "@zkrausman/pi-ticket-cost",
    "@zkrausman/pi-ticket-lifecycle",
    "@zkrausman/pi-wiki-delivery",
  ]);
});

test("packed artifacts must include every declared package and entry-point file", () => {
  validatePackedArtifact(manifest, completeArtifact);
  assert.throws(
    () => validatePackedArtifact(manifest, { ...completeArtifact, files: completeArtifact.files.filter((file) => file.path !== "src/index.ts") }),
    /missing expected content src\/index\.ts/,
  );
});
