#!/usr/bin/env node
// Sync evidence/delivery/<TICKET>.json pull_request.number/url to PR after gh pr create.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function pullRequestFromGh() {
  const gh = spawnSync("gh", ["pr", "view", "--json", "number,url"], { encoding: "utf8" });
  if (gh.status !== 0) throw new Error(`gh pr view failed: ${gh.stderr}`);
  try {
    return JSON.parse(gh.stdout);
  } catch (error) {
    throw new Error(`parse gh pr view: ${error}`);
  }
}

export async function syncPullRequestEvidence(ticket, manifestPath, lookupPullRequest = pullRequestFromGh) {
  if (!ticket) throw new Error("usage: sync-pr-evidence.mjs <TICKET> [manifestPath]");
  const resolvedManifestPath = manifestPath || `evidence/delivery/${ticket}.json`;
  const pr = await lookupPullRequest();
  if (!pr?.number || !pr?.url) throw new Error(`gh pr view missing number/url: ${JSON.stringify(pr)}`);
  if (!/\/pull\/\d+/.test(pr.url)) throw new Error(`gh pr view url not /pull/<n>: ${pr.url}`);

  let raw;
  try {
    raw = await readFile(resolvedManifestPath, "utf8");
  } catch (error) {
    throw new Error(`read ${resolvedManifestPath}: ${error}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`parse ${resolvedManifestPath}: ${error}`);
  }

  const previous = { number: manifest.pull_request?.number, url: manifest.pull_request?.url };
  manifest.pull_request = { ...(manifest.pull_request || {}), number: pr.number, url: pr.url };
  if (manifest.pull_request.draft === undefined) manifest.pull_request.draft = true;
  await writeFile(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return `sync-pr-evidence: ${ticket} ${previous.number}/${previous.url || ""} -> ${pr.number}/${pr.url} (${resolvedManifestPath})`;
}

async function main() {
  try {
    console.log(await syncPullRequestEvidence(process.argv[2], process.argv[3]));
  } catch (error) {
    console.error(`sync-pr-evidence: ${error instanceof Error ? error.message : "operation failed"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
