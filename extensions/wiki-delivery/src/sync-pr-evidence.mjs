#!/usr/bin/env node
// Sync delivery/evidence/<TICKET>.json pull_request.number/url to PR after gh pr create.
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

function arg(i) { return process.argv[i]; }
function die(msg) { console.error(`sync-pr-evidence: ${msg}`); process.exit(1); }

const ticket = arg(2);
const manifestPath = arg(3) || `delivery/evidence/${ticket}.json`;
if (!ticket) die("usage: sync-pr-evidence.mjs <TICKET> [manifestPath]");

const gh = spawnSync("gh", ["pr", "view", "--json", "number,url"], { encoding: "utf8" });
if (gh.status !== 0) die(`gh pr view failed: ${gh.stderr}`);
let pr;
try { pr = JSON.parse(gh.stdout); } catch (e) { die(`parse gh pr view: ${e}`); }
if (!pr.number || !pr.url) die(`gh pr view missing number/url: ${gh.stdout}`);
if (!/\/pull\/\d+/.test(pr.url)) die(`gh pr view url not /pull/<n>: ${pr.url}`);

let raw;
try { raw = await readFile(manifestPath, "utf8"); } catch (e) { die(`read ${manifestPath}: ${e}`); }
let m;
try { m = JSON.parse(raw); } catch (e) { die(`parse ${manifestPath}: ${e}`); }

const prev = { number: m.pull_request?.number, url: m.pull_request?.url };
m.pull_request = { ...(m.pull_request || {}), number: pr.number, url: pr.url };
if (m.pull_request.draft === undefined) m.pull_request.draft = true;

await writeFile(manifestPath, JSON.stringify(m, null, 2) + "\n", "utf8");
console.log(`sync-pr-evidence: ${ticket} ${prev.number}/${prev.url || ""} -> ${pr.number}/${pr.url} (${manifestPath})`);
