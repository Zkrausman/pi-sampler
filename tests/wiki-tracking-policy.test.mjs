import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function json(path) {
  return JSON.parse(await text(path));
}

test("the public project wiki uses company mode and purpose directories", async () => {
  const config = await json(".llm-wiki/config.json");
  const wikiIndex = await text(".llm-wiki/wiki/index.md");

  assert.equal(config.mode, "company");
  assert.match(wikiIndex, /\[decisions\/\]\(decisions\/\)/);
  assert.match(wikiIndex, /\[changes\/\]\(changes\/\)/);
  await text(".llm-wiki/wiki/decisions/index.md");
  await text(".llm-wiki/wiki/changes/index.md");
});

test("contribution policy requires wiki classification before handoff", async () => {
  const contributing = await text("CONTRIBUTING.md");
  const schema = await text(".llm-wiki/WIKI_SCHEMA.md");

  for (const policy of [contributing, schema]) {
    assert.match(policy, /git status --short -- \.llm-wiki/);
    assert.match(policy, /durable/i);
    assert.match(policy, /personal vault/i);
    assert.match(policy, /absolute machine paths/i);
  }
  assert.match(contributing, /focused `docs\(wiki\): \.\.\.` pull request/i);
});

test("wiki governance versions declarative config but keeps runtime state local", async () => {
  const policy = await json("governance/docs/wiki-governance/path-policy-v1.json");

  assert.ok(policy.canonical_versioned.includes(".llm-wiki/config.json"));
  assert.ok(!policy.generated_local.includes(".llm-wiki/config.json"));
  assert.ok(!policy.clean_clone_must_not_contain.includes(".llm-wiki/config.json"));
  for (const path of [".llm-wiki/meta/**", ".llm-wiki/outputs/**", ".llm-wiki/.discoveries/**"]) {
    assert.ok(policy.generated_local.includes(path));
  }
  assert.ok(policy.external_immutable_evidence.includes(".llm-wiki/raw/**"));

  const ignored = [
    ".llm-wiki/raw/source.txt",
    ".llm-wiki/meta/registry.json",
    ".llm-wiki/outputs/report.md",
    ".llm-wiki/.discoveries/state.json",
    ".llm-wiki/sessions/current.json",
    ".llm-wiki/session-current.json",
    ".llm-wiki/private/credential.token",
    ".llm-wiki/private/key.pem",
    ".llm-wiki/private/key.key",
    "artifacts/tool-output/raw.txt",
  ];
  for (const path of ignored) {
    const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", path], { cwd: rootPath, windowsHide: true });
    assert.equal(result.status, 0, `${path} must remain ignored at the project root`);
  }
  const configResult = spawnSync("git", ["check-ignore", "--quiet", "--no-index", ".llm-wiki/config.json"], { cwd: rootPath, windowsHide: true });
  assert.notEqual(configResult.status, 0, "declarative company wiki config must remain versionable");
});
