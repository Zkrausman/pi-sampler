#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';

let stdinBuffer = '';
try {
  stdinBuffer = fs.readFileSync(0, 'utf8');
} catch (e) {}

const lines = stdinBuffer.split('\n').filter(Boolean);
const TICKET_BRANCH = /^zkrausman\/aidev-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;

let shouldValidate = false;
let branchToValidate = '';
let localShaToValidate = '';

for (const line of lines) {
  const [localRef, localSha] = line.split(' ');
  const branchNameMatch = localRef.match(/refs\/heads\/(.*)/);
  if (branchNameMatch) {
    const branchName = branchNameMatch[1];
    if (TICKET_BRANCH.test(branchName)) {
      shouldValidate = true;
      branchToValidate = branchName;
      localShaToValidate = localSha;
      break;
    }
  }
}

if (!shouldValidate) {
  try {
    const currentBranch = execSync('git symbolic-ref --short HEAD').toString().trim();
    if (TICKET_BRANCH.test(currentBranch)) {
      shouldValidate = true;
      branchToValidate = currentBranch;
      localShaToValidate = execSync('git rev-parse HEAD').toString().trim();
    }
  } catch (err) {}
}

if (shouldValidate) {
  console.log(`[pre-push] Ticket branch detected (${branchToValidate}). Checking attestation...`);
  
  let prBody = '';
  try {
    prBody = execSync(`gh pr view ${branchToValidate} --json body -q .body`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (err) {
    console.log(`[pre-push] No PR found for this branch yet. Skipping attestation validation.`);
    console.log(`[pre-push] ⚠️ Don't forget to generate your Adversarial Review Attestation marker and include it in your PR body when you open it!`);
    process.exit(0);
  }

  try {
    const baseSha = execSync(`gh pr view ${branchToValidate} --json baseRefName -q .baseRefName`).toString().trim();
    const baseCommit = execSync(`git rev-parse origin/${baseSha}`).toString().trim();
    
    // We pass the base commit, the local SHA being pushed, and the PR body directly to the validate script
    execSync(`node scripts/validate-adversarial-review-attestation.mjs --base ${baseCommit} --head ${localShaToValidate}`, { 
      env: { ...process.env, ADVERSARIAL_REVIEW_PR_BODY: prBody },
      stdio: 'inherit' 
    });
    console.log(`[pre-push] ✅ Adversarial review attestation is valid for this push!`);
  } catch (err) {
    console.error(`\n[pre-push] ❌ Adversarial review attestation validation failed.`);
    console.error(`[pre-push] The cryptographic marker in the PR body is missing or stale.`);
    console.error(`[pre-push] Please generate a new JSON attestation marker for commit ${localShaToValidate} and update the PR body before pushing.\n`);
    process.exit(1);
  }
}

process.exit(0);
