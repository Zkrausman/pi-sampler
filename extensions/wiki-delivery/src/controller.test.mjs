import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryController } from "./controller.mjs";
import { syncPullRequestEvidence } from "./sync-pr-evidence.mjs";

const ticket = "AIDEV-91";
const sha = "a".repeat(40);
const syncScript = new URL("./sync-pr-evidence.mjs", import.meta.url);

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-wiki-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function deliveryInput() {
  return {
    ticketId: ticket,
    expectedDeliveryCommit: sha,
    recallQuery: "AIDEV-91 delivery",
    okfPath: "docs/specs/AIDEV-91.md",
    deliveryState: "review_ready",
    pullRequest: { number: 0, url: "", draft: true },
    reviewVerdict: "approved",
    merge: { status: "not_merged" },
    sources: [
      { kind: "ticket", title: "Ticket", filePath: "docs/okf/AIDEV-91-ticket.md" },
      { kind: "spec", title: "Specification", filePath: "docs/specs/AIDEV-91.md" },
      { kind: "pull_request", title: "Pull request", filePath: "docs/okf/AIDEV-91-pr.md" },
      { kind: "review", title: "Review", filePath: "docs/okf/AIDEV-91-review.md" },
      { kind: "verification", title: "Verification", filePath: "docs/okf/AIDEV-91-verification.md" },
    ],
    canonicalPages: [{ type: "requirement", title: "AIDEV-91 manifest path" }],
    verifications: [{ command: "node --test", exit_code: 0, outcome: "passed", output_sha256: "b".repeat(64) }],
  };
}

function wiki() {
  let source = 0;
  return {
    recall: async () => {},
    capture: async () => ({ sourceId: `SRC-2026-01-01-${String(++source).padStart(3, "0")}` }),
    ingest: async () => ({ complete: true }),
    search: async () => {},
    ensurePage: async () => ({ id: "requirements/aidev-91-manifest-path" }),
    observe: async () => ({ observationId: "obs-2026-01-01-aidev-91" }),
    lint: async () => ({ complete: true, orphans: 0, missingPages: 0, contradictions: 0 }),
  };
}

function manifestWriter(root) {
  const path = join(root, "evidence", "delivery", `${ticket}.json`).replace(/\\/g, "/");
  return {
    path,
    write: async (_ticket, manifest) => {
      await mkdir(join(root, "evidence", "delivery"), { recursive: true });
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      return path;
    },
    remove: async (manifestPath) => rm(manifestPath, { force: true }),
  };
}

function controller(root, valid = true) {
  const writer = manifestWriter(root);
  return {
    writer,
    value: new DeliveryController({
      wiki: wiki(),
      git: { inspect: async () => ({ exists: true, head: sha, clean: true }) },
      manifestWriter: writer,
      validator: { validate: async () => ({ valid }) },
    }),
  };
}

test("finalized delivery is found and synchronized at the canonical manifest default", async (t) => {
  const root = await project(t);
  const { writer, value } = controller(root);
  const finalized = await value.run(deliveryInput());

  assert.equal(finalized.status, "delivered");
  assert.equal(finalized.manifestPath, writer.path);
  assert.deepEqual(JSON.parse(await readFile(writer.path, "utf8")).pull_request, { number: 0, url: "", draft: true });

  const originalCwd = process.cwd();
  let synced;
  process.chdir(root);
  try {
    synced = await syncPullRequestEvidence(ticket, undefined, () => ({
      number: 91,
      url: "https://github.com/example/project/pull/91",
    }));
  } finally {
    process.chdir(originalCwd);
  }
  assert.match(synced, /evidence\/delivery\/AIDEV-91\.json/);
  assert.deepEqual(JSON.parse(await readFile(writer.path, "utf8")).pull_request, {
    number: 91,
    url: "https://github.com/example/project/pull/91",
    draft: true,
  });
});

test("failed validation removes the canonical manifest rather than synchronizing unvalidated evidence", async (t) => {
  const root = await project(t);
  const { writer, value } = controller(root, false);

  assert.deepEqual(await value.run(deliveryInput()), {
    status: "failed",
    stage: "validation",
    code: "manifest_validation_failed",
  });
  await assert.rejects(readFile(writer.path, "utf8"));
});

test("production finalization reports and synchronization defaults use evidence/delivery", async () => {
  const [index, sync] = await Promise.all([
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(syncScript, "utf8"),
  ]);

  assert.equal(index.includes("delivery/evidence"), false);
  assert.equal(sync.includes("delivery/evidence"), false);
  assert.match(index, /DELIVERY_MANIFEST_DIRECTORY = "evidence\/delivery"/);
  assert.match(index, /Wiki delivery manifest validated: \$\{DELIVERY_MANIFEST_DIRECTORY\}\//);
  assert.match(sync, /`evidence\/delivery\/\$\{ticket\}\.json`/);
});
