/**
 * Stream hub bookkeeping (#10). Cleanup used to hang off two events only, so a
 * client that vanished otherwise stayed in the hub and kept a 15 s heartbeat
 * writing for the life of the process. These cover the drop-on-dead-socket path
 * the heartbeat and the fan-out both now rely on.
 */
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import { hub, MAX_CLIENTS_PER_PROJECT, MAX_CLIENTS_TOTAL } from '../src/plugins/sse.ts';

interface FakeRes {
  chunks: string[];
  destroyed: boolean;
  writableEnded: boolean;
  throwOnWrite: boolean;
  write(text: string): boolean;
}

function fakeRes(over: Partial<FakeRes> = {}): FakeRes & ServerResponse {
  const res: FakeRes = {
    chunks: [],
    destroyed: false,
    writableEnded: false,
    throwOnWrite: false,
    write(text: string) {
      if (this.throwOnWrite) throw new Error('socket gone');
      this.chunks.push(text);
      return true;
    },
    ...over,
  };
  return res as unknown as FakeRes & ServerResponse;
}

/** A project id per test, so the shared singleton cannot leak state across them. */
let n = 0;
const pid = () => `p-${++n}`;

describe('StreamHub accounting', () => {
  it('counts a client per project and forgets it on remove', () => {
    const p = pid();
    const res = fakeRes();
    hub.add(p, res);
    assert.equal(hub.countFor(p), 1);
    hub.remove(p, res);
    assert.equal(hub.countFor(p), 0);
  });

  it('keeps projects independent', () => {
    const a = pid();
    const b = pid();
    const ra = fakeRes();
    const rb = fakeRes();
    hub.add(a, ra);
    hub.add(b, rb);
    assert.equal(hub.countFor(a), 1);
    assert.equal(hub.countFor(b), 1);
    hub.remove(a, ra);
    assert.equal(hub.countFor(a), 0);
    assert.equal(hub.countFor(b), 1);
    hub.remove(b, rb);
  });
});

describe('StreamHub.write', () => {
  it('writes to a live client', () => {
    const p = pid();
    const res = fakeRes();
    hub.add(p, res);
    assert.equal(hub.write(p, res, 'hello'), true);
    assert.deepEqual(res.chunks, ['hello']);
    hub.remove(p, res);
  });

  it('drops a destroyed client instead of writing to it', () => {
    const p = pid();
    const res = fakeRes({ destroyed: true });
    hub.add(p, res);
    assert.equal(hub.write(p, res, 'hello'), false);
    assert.equal(res.chunks.length, 0);
    // This is what stops the heartbeat: the client is gone from the hub.
    assert.equal(hub.countFor(p), 0);
  });

  it('drops a client whose stream has already ended', () => {
    const p = pid();
    const res = fakeRes({ writableEnded: true });
    hub.add(p, res);
    assert.equal(hub.write(p, res, 'hello'), false);
    assert.equal(hub.countFor(p), 0);
  });

  it('drops a client whose write throws', () => {
    const p = pid();
    const res = fakeRes({ throwOnWrite: true });
    hub.add(p, res);
    assert.equal(hub.write(p, res, 'hello'), false);
    assert.equal(hub.countFor(p), 0);
  });
});

describe('StreamHub.prune', () => {
  it('reaps only the dead clients', () => {
    const p = pid();
    const live = fakeRes();
    const dead = fakeRes({ destroyed: true });
    hub.add(p, live);
    hub.add(p, dead);
    assert.equal(hub.countFor(p), 2);
    assert.equal(hub.prune(), 1);
    assert.equal(hub.countFor(p), 1);
    assert.equal(hub.prune(), 0, 'pruning twice must not double-count');
    hub.remove(p, live);
  });

  it('leaves no empty project entries behind', () => {
    const p = pid();
    hub.add(p, fakeRes({ destroyed: true }));
    hub.prune();
    assert.equal(hub.countFor(p), 0);
    assert.equal(hub.connections, 0, 'hub should be empty between tests');
  });
});

describe('connection ceilings', () => {
  it('are bounded, so the route has something to enforce', () => {
    assert.ok(MAX_CLIENTS_PER_PROJECT > 0 && Number.isFinite(MAX_CLIENTS_PER_PROJECT));
    assert.ok(MAX_CLIENTS_TOTAL >= MAX_CLIENTS_PER_PROJECT);
  });

  it('counts toward the ceiling only while a client is live', () => {
    const p = pid();
    const many = Array.from({ length: MAX_CLIENTS_PER_PROJECT }, () => fakeRes());
    for (const r of many) hub.add(p, r);
    assert.equal(hub.countFor(p), MAX_CLIENTS_PER_PROJECT);
    // A reload storm leaves dead sockets; prune is why that does not lock the
    // project out of its own stream.
    for (const r of many) r.destroyed = true;
    assert.equal(hub.prune(), MAX_CLIENTS_PER_PROJECT);
    assert.equal(hub.countFor(p), 0);
  });
});
