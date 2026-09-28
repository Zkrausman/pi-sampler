// Opt-in bounded real-Pi integration: isolated session, no tools, no filesystem mutation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = process.env.PI_CLI_JS;
if (!cli) throw new Error('Set PI_CLI_JS to the installed Pi dist/cli.js (no version pin)');
const extension = fileURLToPath(new URL('../extensions/goal-loop/index.ts', import.meta.url));
const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--extension', extension, '--no-extensions', '--no-skills', '--no-context-files', '--no-tools', '--no-session', '--offline', '--provider', 'openai-codex', '--model', 'gpt-6-sol'], { stdio: ['pipe', 'pipe', 'pipe'] });
const send = (id, type, extra = {}) => child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n');
let buffer = '', err = '', ends = 0, settled = false;
const deadline = setTimeout(() => { child.kill(); throw new Error('Bounded Pi RPC integration deadline'); }, 90000);
child.stderr.on('data', chunk => { err += chunk.toString().slice(0, 1000); });
const done = new Promise((accept, reject) => {
  child.on('error', reject);
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    for (let pos; (pos = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch (error) { reject(error); child.kill(); return; }
      if (value.type === 'agent_end') ends++;
      if (value.id === 'commands') {
        try { assert.equal(value.success, true); assert.ok(value.data.commands.some(c => c.name === 'goal-loop' && c.source === 'extension')); }
        catch (error) { reject(error); child.kill(); return; }
        send('arm', 'prompt', { message: '/goal-loop start one harmless no-tools integration check' });
      } else if (value.id === 'arm') {
        if (!value.success) { reject(new Error('arm failed')); child.kill(); return; }
        send('prompt', 'prompt', { message: 'Reply with the single word READY.' });
      } else if (value.id === 'prompt' && !value.success) {
        reject(new Error('model prompt rejected')); child.kill(); return;
      } else if (value.type === 'agent_settled' && !settled) {
        settled = true;
        child.stdin.end();
      }
    }
  });
  child.on('exit', (code) => {
    clearTimeout(deadline);
    if (!settled || code !== 0) reject(new Error(`Pi did not settle cleanly: exit=${code}, agent_end=${ends}, stderr=${err.slice(0, 500)}`));
    else { try { assert.ok(ends >= 2 && ends <= 3, `expected bounded continuation, saw ${ends} agent_end; stderr=${err.slice(0, 1800)}`); accept(); } catch (error) { reject(error); } }
  });
});
send('commands', 'get_commands');
await done;
console.log(`PASS real Pi RPC loaded opt-in extension; bounded no-tools continuation settled after ${ends} runs`);
