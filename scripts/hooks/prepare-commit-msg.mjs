#!/usr/bin/env node
import fs from 'fs';
import { execSync } from 'child_process';

const commitMsgFile = process.argv[2];
if (!commitMsgFile || !fs.existsSync(commitMsgFile)) {
  process.exit(0);
}

const msg = fs.readFileSync(commitMsgFile, 'utf8');

// If already signed off, skip
if (msg.match(/^Signed-off-by:/m)) {
  process.exit(0);
}

try {
  const name = execSync('git config user.name').toString().trim();
  const email = execSync('git config user.email').toString().trim();
  
  if (name && email) {
    fs.appendFileSync(commitMsgFile, `\n\nSigned-off-by: ${name} <${email}>\n`);
  }
} catch (err) {
  // Ignore error if git config is missing
}
