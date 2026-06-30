import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
assert.equal(args[args.indexOf('--profile') + 1], '9router');
assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
const schema = args[args.indexOf('--output-schema') + 1];
JSON.parse(readFileSync(schema, 'utf8'));
let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ type: 'profile.trace', args }));
const planner = schema.endsWith('plan.json');
const fixture = fileURLToPath(new URL(planner ? './phase7-agent.mjs' : './workflow-agent.mjs', import.meta.url));
const result = spawnSync(process.execPath, [fixture, ...(planner ? [] : ['manager', 'accept'])], { input, encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
