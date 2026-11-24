/**
 * First run (Phase 2, stream G): the onboarding test hit, sample data and the
 * read-only key check `lxs doctor` uses. DB-free: the real app on the FakeDb.
 */
process.env.LOG_LEVEL = 'silent';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { evaluateChain } from '@lxs/detection';
import { DecoyEvent } from '@lxs/schema';

const { buildWorld, addMember, ORIGIN } = await import('./helpers/tenants.ts');
const { buildSampleEvents, buildReplayEvents, FIRST_RUN_LIMIT, SAMPLE_SET, TEST_HIT_SCENARIO } =
  await import('../src/modules/demo.ts');
const { shouldOpenIndividualIncident } = await import('../src/worker/process-events.ts');
const { toIncidentSummary } = await import('../src/lib/serialize.ts');
type World = Awaited<ReturnType<typeof buildWorld>>;

const CTX = {
  now: new Date(),
  commonCredentials: new Set(['admin', 'admin/admin']),
  criticalAssets: [],
};

function opensIncident(raw: Record<string, unknown>[]): boolean {
  const events = raw.map((e) => DecoyEvent.parse(e));
  return shouldOpenIndividualIncident(evaluateChain(events, { ...CTX, now: new Date() }));
}

describe('first-run scenarios', () => {
  it('the test hit is a valid, simulated batch that opens an incident', () => {
    const raw = buildReplayEvents(TEST_HIT_SCENARIO, '203.0.113.9', Date.now(), 'test');
    assert.ok(raw.every((e) => DecoyEvent.safeParse(e).success));
    assert.ok(raw.every((e) => e.simulated === true));
    assert.ok(String(raw[0]!.session_id).startsWith('test-'));
    assert.ok(opensIncident(raw), 'a test hit that opens no incident leaves onboarding waiting');
  });

  it('sample data spans several stories from distinct documentation addresses', () => {
    const raw = buildSampleEvents();
    assert.ok(raw.every((e) => DecoyEvent.safeParse(e).success));
    assert.ok(raw.every((e) => e.simulated === true));
    const ips = new Set(raw.map((e) => e.src_ip));
    assert.equal(ips.size, SAMPLE_SET.length);
    for (const ip of ips) assert.match(String(ip), /^192\.0\.2\./, 'TEST-NET-1 only');
    assert.ok(raw.every((e) => String(e.session_id).startsWith('sample-')));
    const incidents = SAMPLE_SET.filter((s) => opensIncident(raw.filter((e) => e.src_ip === s.ip)));
    assert.ok(incidents.length >= 3, `only ${incidents.length} sample stories open an incident`);
    // And at least one is noise, so the noise filter has something to show.
    assert.ok(SAMPLE_SET.some((s) => s.scenario === 'noise'));
  });

  it('incident summaries carry the simulated and sample flags', () => {
    const base = {
      id: 'i',
      projectId: 'p',
      number: 1,
      title: 't',
      status: 'open',
      label: 'targeted',
      severity: 'high',
      score: 50,
      srcIp: '192.0.2.10',
      attackerId: 'a',
      stages: [],
      techniques: [],
      realAssetReached: false,
      honeytokenUsed: false,
      eventCount: 3,
      firstEventAt: new Date(),
      lastEventAt: new Date(),
      aiStatus: 'pending',
      floor: null,
      openedAt: new Date(),
      acknowledgedAt: null,
      resolvedAt: null,
      assigneeId: null,
      aiHeadline: null,
    };
    const real = toIncidentSummary({ ...base, simulated: false, sample: false });
    assert.equal(real.simulated, false);
    assert.equal(real.sample, false);
    const sample = toIncidentSummary({ ...base, simulated: true, sample: true });
    assert.equal(sample.simulated, true);
    assert.equal(sample.sample, true);
    // Rows from a query that did not select the flags read as real.
    assert.equal(toIncidentSummary(base).simulated, false);
  });
});

describe('first-run routes', () => {
  let w: World;
  let analyst: string;
  let viewer: string;
  let sampleState = { sample_events: 0, sample_incidents: 0, real_events: 0 };
  let cleared = 0;

  before(async () => {
    w = await buildWorld();
    analyst = addMember(w.fake, w.a.org, 'analyst');
    viewer = addMember(w.fake, w.a.org, 'viewer');
    w.fake.raw.push(
      {
        match: /as sample_events/,
        rows: (p, f) => {
          const pid = p[0];
          const ev = f.table('events').filter((e) => e.project_id === pid);
          return [
            {
              sample_events: ev.filter((e) => e.sample === true).length,
              sample_incidents: sampleState.sample_incidents,
              real_events: ev.filter((e) => !e.simulated).length,
            },
          ];
        },
      },
      {
        match: /with ev as \(\s*delete from events/,
        rows: (p, f) => {
          const pid = p[0];
          const before = f.table('events').length;
          f.tables.events = f.table('events').filter((e) => !(e.project_id === pid && e.sample));
          cleared = before - f.table('events').length;
          return [{ events: cleared, incidents: 2, attackers: 3 }];
        },
      },
    );
  });
  after(async () => {
    await w.close();
  });

  const call = (method: 'GET' | 'POST' | 'DELETE', path: string, user: string, pid = w.a.project) =>
    w.app.inject({
      method,
      url: `/v1/projects/${pid}${path}`,
      headers: {
        cookie: w.cookie(user),
        origin: ORIGIN,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { payload: '{}' }),
    });

  it('a test hit works on a production project and stores simulated events', async () => {
    const res = await call('POST', '/demo/test-hit', w.a.owner);
    assert.equal(res.statusCode, 202, res.body);
    const body = res.json();
    assert.equal(body.test, true);
    assert.match(body.src_ip, /^203\.0\.113\./);
    assert.ok(body.accepted > 0);
    const stored = w.fake
      .table('events')
      .filter((e) => e.project_id === w.a.project && e.src_ip === body.src_ip);
    assert.equal(stored.length, body.accepted);
    assert.ok(stored.every((e) => e.simulated === true && e.sample !== true));
    assert.ok(
      w.fake
        .table('audit_logs')
        .some((a) => a.action === 'demo.test_hit' && a.project_id === w.a.project),
    );
  });

  it('analysts may trigger it, viewers may not', async () => {
    assert.equal((await call('POST', '/demo/test-hit', analyst)).statusCode, 202);
    const v = await call('POST', '/demo/test-hit', viewer);
    assert.equal(v.statusCode, 403);
    assert.equal(v.json().error.code, 'insufficient_role');
  });

  it(`is limited to ${FIRST_RUN_LIMIT.max} per hour per project`, async () => {
    // Two used above (the viewer's was refused before the handler but still counts).
    let last = 0;
    for (let i = 0; i < FIRST_RUN_LIMIT.max; i++)
      last = (await call('POST', '/demo/test-hit', w.a.owner)).statusCode;
    assert.equal(last, 429);
    const res = await call('POST', '/demo/test-hit', w.a.owner);
    assert.equal(res.statusCode, 429);
    assert.match(
      res.json().message ?? res.json().error?.message ?? res.body,
      /per hour per project/,
    );
    // Another project has its own budget.
    assert.equal((await call('POST', '/demo/test-hit', w.b.owner, w.b.project)).statusCode, 202);
  });

  it('reports sample data as not loaded on a fresh project', async () => {
    const res = await call('GET', '/demo/sample-data', viewer);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().loaded, false);
  });

  it('loads sample data tagged sample, then refuses a second load', async () => {
    const res = await call('POST', '/demo/sample-data', analyst);
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().scenarios.length, SAMPLE_SET.length);
    const sample = w.fake.table('events').filter((e) => e.project_id === w.a.project && e.sample);
    assert.equal(sample.length, res.json().accepted);
    assert.ok(sample.every((e) => e.simulated === true));
    assert.ok(sample.every((e) => String(e.src_ip).startsWith('192.0.2.')));

    const status = (await call('GET', '/demo/sample-data', viewer)).json();
    assert.equal(status.loaded, true);
    assert.equal(status.sample_events, sample.length);

    const again = await call('POST', '/demo/sample-data', w.a.owner);
    assert.equal(again.statusCode, 409);
  });

  it('only owners and analysts can load or clear it', async () => {
    assert.equal((await call('POST', '/demo/sample-data', viewer)).statusCode, 403);
    assert.equal((await call('DELETE', '/demo/sample-data', viewer)).statusCode, 403);
  });

  it('clears sample data and nothing else', async () => {
    const testHits = w.fake
      .table('events')
      .filter((e) => e.project_id === w.a.project && !e.sample).length;
    const res = await call('DELETE', '/demo/sample-data', analyst);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().deleted, { events: cleared, incidents: 2, attackers: 3 });
    assert.ok(cleared > 0);
    assert.equal(
      w.fake.table('events').filter((e) => e.project_id === w.a.project && e.sample).length,
      0,
    );
    assert.equal(
      w.fake.table('events').filter((e) => e.project_id === w.a.project).length,
      testHits,
      'test hits are not sample data',
    );
    assert.ok(w.fake.table('audit_logs').some((a) => a.action === 'demo.sample_cleared'));
    sampleState = { sample_events: 0, sample_incidents: 0, real_events: 0 };
    assert.equal((await call('GET', '/demo/sample-data', viewer)).json().loaded, false);
  });

  it('whoami names the key’s project without registering a sensor', async () => {
    const sensors = w.fake.table('sensors').length;
    const res = await w.app.inject({
      method: 'GET',
      url: '/v1/agent/whoami',
      headers: { authorization: `Bearer ${w.a.ingestKey}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().project.id, w.a.project);
    assert.equal(res.json().project.name, 'Project a');
    assert.equal(w.fake.table('sensors').length, sensors);

    const bad = await w.app.inject({
      method: 'GET',
      url: '/v1/agent/whoami',
      headers: { authorization: `Bearer ds_live_${'z'.repeat(32)}` },
    });
    assert.equal(bad.statusCode, 401);
  });
});
