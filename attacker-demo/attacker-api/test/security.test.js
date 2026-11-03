import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

let target;
let requests;
let sendHttp;
let server;

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

before(async () => {
  requests = 0;
  server = createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('test target');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  target = `http://127.0.0.1:${server.address().port}`;
  process.env.TARGET_APP_URL = target;
  process.env.ALLOW_TARGETS = '127.0.0.1';
  process.env.PLATFORM_URL = '';
  process.env.PLATFORM_PROJECT_ID = '';
  ({ sendHttp } = await import('../src/http-attacker.js'));
});

test('HTTP target accepts a root-relative path on the configured host', async () => {
  const result = await sendHttp({ path: '/health' });
  assert.equal(result.status, 200);
  assert.equal(requests, 1);
});

test('HTTP target rejects absolute and protocol-relative URLs without making a request', async () => {
  for (const path of ['http://169.254.169.254/latest/meta-data/', '//127.0.0.1:1/admin']) {
    const result = await sendHttp({ path });
    assert.equal(result.status, 0);
    assert.equal(result.error, 'path_must_be_root_relative');
  }
  assert.equal(requests, 1);
});

test('aborted safe scenario emits no synthetic attack steps', async () => {
  const { runScenario } = await import('../src/run-scenario.js');
  const controller = new AbortController();
  controller.abort();
  const frames = [];
  await runScenario(
    { id: 'test', seed: 1, persona: 'bot', steps: [{ kind: 'http', method: 'GET', path: '/' }] },
    { mode: 'safe', signal: controller.signal, emit: (frame) => frames.push(frame) },
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'done');
  assert.equal(frames[0].steps, 0);
  assert.equal(frames[0].aborted, true);
});
