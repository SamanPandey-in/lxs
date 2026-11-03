import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for BREAKDOWN 7.10-7.12: ds-web source must stay incapable of executing attacker input,
 * opening outbound sockets, or writing outside the log volume. A failing test here is a containment regression.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const read = (f: string): string =>
  fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('no process spawning, outbound networking, dynamic code or DNS', () => {
  const forbidden =
    /child_process|node:net\b|node:http\b|node:https\b|node:http2|node:dns|node:dgram|node:tls|node:cluster|node:worker_threads|node:vm\b|\beval\s*\(|new Function|\bfetch\s*\(|WebSocket|XMLHttpRequest/;
  for (const f of files) assert.ok(!forbidden.test(read(f)), `${f} uses a forbidden capability`);
});

test('filesystem writes only happen in log.ts (log volume) and main.ts (own socket)', () => {
  const writes =
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rename|renameSync|unlink|unlinkSync|chmod|chmodSync|createWriteStream|copyFile)\b/;
  for (const f of files) {
    if (f === 'log.ts' || f === 'main.ts') continue;
    assert.ok(!writes.test(read(f)), `${f} writes to the filesystem`);
  }
});

test('only one listener and it is a socket path', () => {
  const listens = files.flatMap((f) =>
    [...read(f).matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1] as string),
  );
  assert.equal(listens.length, 1);
  assert.match(listens[0] as string, /path:\s*socketPath/);
});
