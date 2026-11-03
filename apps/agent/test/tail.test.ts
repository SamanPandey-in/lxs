import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { type TailLine, TailManager } from '../src/tail.js';
import { Counters } from '../src/telemetry.js';

function setup(maxLine?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tail-'));
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  const lines: TailLine[] = [];
  const counters = new Counters();
  const mk = () =>
    new TailManager({
      sources: [{ kind: 'web', dir: logs, match: /^ds-web\.jsonl$/, decoyId: 'ds-web' }],
      statePath: path.join(dir, 'state', 'offsets.json'),
      onLine: (l) => lines.push(l),
      counters,
      maxLine,
    });
  return { dir, logs, lines, counters, mk, file: path.join(logs, 'ds-web.jsonl') };
}

test('reads lines, waits for the newline, and follows appends', async () => {
  const { logs, lines, mk, file } = setup();
  fs.writeFileSync(file, '{"a":1}\n{"a":2');
  const t = mk();
  await t.pollOnce();
  assert.deepEqual(
    lines.map((l) => l.text),
    ['{"a":1}'],
  );
  fs.appendFileSync(file, '}\n{"a":3}\n');
  await t.pollOnce();
  assert.deepEqual(
    lines.map((l) => l.text),
    ['{"a":1}', '{"a":2}', '{"a":3}'],
  );
  assert.equal(lines[1]?.offset, 8);
  await t.stop();
  assert.ok(fs.existsSync(path.join(logs, '..', 'state', 'offsets.json')));
});

test('resumes from the persisted offset after a restart', async () => {
  const { lines, mk, file } = setup();
  fs.writeFileSync(file, 'one\ntwo\n');
  const t1 = mk();
  await t1.pollOnce();
  await t1.stop(); // commits offsets
  fs.appendFileSync(file, 'three\n');
  const t2 = mk();
  await t2.pollOnce();
  await t2.stop();
  assert.deepEqual(
    lines.map((l) => l.text),
    ['one', 'two', 'three'],
  );
});

test('drains the rotated file then follows the new one', async () => {
  const { logs, lines, mk, file } = setup();
  fs.writeFileSync(file, 'a\n');
  const t = mk();
  await t.pollOnce();
  fs.appendFileSync(file, 'b\n');
  fs.renameSync(file, path.join(logs, 'ds-web.jsonl.1'));
  fs.writeFileSync(file, 'c\n');
  await t.pollOnce();
  await t.pollOnce();
  assert.deepEqual(
    lines.map((l) => l.text),
    ['a', 'b', 'c'],
  );
  await t.stop();
});

test('restarts from 0 when the file is truncated', async () => {
  const { lines, mk, file } = setup();
  fs.writeFileSync(file, 'first\nsecond\n');
  const t = mk();
  await t.pollOnce();
  fs.writeFileSync(file, 'x\n');
  await t.pollOnce();
  assert.deepEqual(
    lines.map((l) => l.text),
    ['first', 'second', 'x'],
  );
  await t.stop();
});

test('over-long lines are dropped and counted, not buffered forever', async () => {
  const { lines, counters, mk, file } = setup(100);
  fs.writeFileSync(file, `${'x'.repeat(500)}\nok\n`);
  const t = mk();
  await t.pollOnce();
  assert.deepEqual(
    lines.map((l) => l.text),
    ['ok'],
  );
  assert.ok(counters.get('lines_dropped_oversize') >= 1);
  await t.stop();
});
