import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage/store.js';
import { startRuntime, runtimeRequest } from '../dist/runtime/server.js';
import { codexCommand, codexPlannerCommand, codexReviewCommand } from '../dist/adapters/codex.js';
import { git } from '../dist/runtime/workspace.js';

test('manager profile keeps CLI defaults, schemas and enforced read-only sandbox', () => {
  assert.ok(!codexCommand().args.includes('--profile'));
  for (const build of [codexPlannerCommand, codexReviewCommand]) {
    const spec = build('codex', '9router');
    assert.equal(spec.args[spec.args.indexOf('--profile') + 1], '9router');
    assert.equal(spec.args[spec.args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(spec.args.includes('--output-schema'));
    assert.equal(spec.args.at(-1), '-');
    assert.throws(() => build('codex', ''), /profile/);
    assert.throws(() => build('codex', 'bad\nname'), /profile/);
  }
});

test('runtime CLI forwards manager profile independently of worker profiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rarp-manager-cli-'));
  const store = new Store(root, true);
  const start = spawnSync(process.execPath, [resolve('dist/cli/index.js'), '--project', root, 'runtime', 'start', '--codex', process.execPath, '--manager-profile', '9router'], { encoding: 'utf8', timeout: 20000 });
  try {
    assert.equal(start.status, 0, start.stderr);
    const metadata = await runtimeRequest(root, 'profiles');
    assert.equal(metadata.planner.profile, '9router');
    assert.equal(metadata.reviewer.profile, '9router');
    assert.equal(metadata.profiles.find(p => p.id === 'codex:default').model, 'CLI default');
  } finally {
    await runtimeRequest(root, 'stop', {}).catch(() => {});
    store.close();
  }
});

test('profiled planner and reviewer actually execute with an independent Antigravity worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rarp-manager-flow-'));
  git(root, 'init'); git(root, 'config', 'user.name', 'Tests'); git(root, 'config', 'user.email', 'tests@localhost');
  writeFileSync(join(root, '.gitignore'), '.rarp/\n'); writeFileSync(join(root, 'a.txt'), 'base');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  const store = new Store(root, true);
  const profiled = build => { const spec = build(process.execPath, '9router'); spec.args.unshift(resolve('tests/fixtures/manager-profile.mjs')); return spec; };
  const worker = { file: process.execPath, args: [resolve('tests/fixtures/workflow-agent.mjs'), 'worker', 'accept'], protocol: 'antigravity' };
  const runtime = await startRuntime(root, worker, { planner: profiled(codexPlannerCommand), manager: profiled(codexReviewCommand), antigravity: worker });
  try {
    const { plan } = await runtimeRequest(root, 'goals', { title: 'Scoped change', requirements: 'Write done to a.txt', acceptance: ['File correct'] });
    const draft = await runtimeRequest(root, `plans/${plan.id}/analyze`, {});
    assert.equal(draft.status, 'awaiting_approval');
    assert.ok(draft.logs.some(l => l.data.type === 'profile.trace'));
    store.register('m', 'manager'); store.register('w', 'worker');
    const task = store.create({ title: 'Payable must be 50000', actor: 'm', assignee: 'w' });
    await runtimeRequest(root, 'workflow', { taskId: task.id, adapter: 'antigravity', maxRounds: 1, timeoutMs: 10000, totalTimeoutMs: 20000 });
    for (let i = 0; i < 300 && store.show(task.id).status !== 'accepted'; i++) await new Promise(r => setTimeout(r, 30));
    assert.equal(store.show(task.id).status, 'accepted');
    assert.ok(store.events().some(e => JSON.parse(e.payload).type === 'profile.trace'));
    assert.ok(!worker.args.includes('--profile'));
  } finally { await runtime.stop(); store.close(); }
});
