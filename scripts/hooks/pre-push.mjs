#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';

let stdinBuffer = '';
try {
  // Read from stdin to get the pushed refs. 
  // fs.readFileSync(0, 'utf-8') can block if stdin is empty and not closed.
  stdinBuffer = fs.readFileSync(0, 'utf8');
} catch (e) {
  // ignore
}

const lines = stdinBuffer.split('\n').filter(Boolean);

// The exact regex from validate-adversarial-review-attestation.mjs
const TICKET_BRANCH = /^zkrausman\/aidev-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;

let shouldValidate = false;

for (const line of lines) {
  // Format: <local ref> <local sha1> <remote ref> <remote sha1>
  const [localRef] = line.split(' ');
  const branchNameMatch = localRef.match(/refs\/heads\/(.*)/);
  if (branchNameMatch) {
    const branchName = branchNameMatch[1];
    if (TICKET_BRANCH.test(branchName)) {
      shouldValidate = true;
      break;
    }
  }
}

if (shouldValidate) {
  console.log(`[pre-push] Ticket branch detected. Running validate:adversarial-review...`);
  try {
    execSync('npm run validate:adversarial-review', { stdio: 'inherit' });
  } catch (err) {
    console.error(`\n[pre-push] ❌ Adversarial review attestation validation failed.`);
    console.error(`[pre-push] The cryptographic marker in the PR body or the commit hash is stale.`);
    console.error(`[pre-push] Please generate a new JSON attestation marker before pushing.\n`);
    process.exit(1);
  }
} else {
  // Optional: check if the current branch being pushed is a ticket branch, just in case stdin parsing failed
  try {
    const currentBranch = execSync('git symbolic-ref --short HEAD').toString().trim();
    if (TICKET_BRANCH.test(currentBranch)) {
       console.log(`[pre-push] Ticket branch detected (${currentBranch}). Running validate:adversarial-review...`);
       execSync('npm run validate:adversarial-review', { stdio: 'inherit' });
    }
  } catch (err) {
    if (err.status !== 0 && err.status !== undefined) {
      console.error(`\n[pre-push] ❌ Adversarial review attestation validation failed.\n`);
      process.exit(1);
    }
  }
}

process.exit(0);
