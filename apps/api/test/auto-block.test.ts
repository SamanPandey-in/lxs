/**
 * Auto-block policy (roadmap §3.3): the pure decision, the safety rails, the worker job over
 * the in-memory FakeDb (same block path as a manual block, system actor, rule recorded,
 * monitor mode records "would block" only), and the settings routes.
 */
process.env.LOG_LEVEL = 'silent';
process.env.PLATFORM_IP_RANGES = '198.18.0.0/15,2001:db8:ffff::/48';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  type AutoBlockContext,
  type AutoBlockIncident,
  type AutoBlockPolicy,
  DEFAULT_POLICY,
  decideAutoBlock,
  describePolicy,
  ipInCidrs,
  targetGuard,
} from '../src/lib/auto-block.ts';

const { buildWorld, addMember, ORIGIN } = await import('./helpers/tenants.ts');
const { autoBlockIncident, AUTO_BLOCK_ACTOR } = await import('../src/worker/auto-block.ts');

const on: AutoBlockPolicy = { ...DEFAULT_POLICY, enabled: true, mode: 'enforce' };
const inc = (over: Partial<AutoBlockIncident> = {}): AutoBlockIncident => ({
  id: 'i1',
  number: 7,
  status: 'open',
  severity: 'critical',
  label: 'targeted',
  realAssetReached: false,
  srcIp: '45.155.205.10',
  ...over,
});
const ctx = (over: Partial<AutoBlockContext> = {}): AutoBlockContext => ({
  allowlist: [],
  platformRanges: [],
  alreadyBlocked: false,
  alreadyActed: false,
  recentlyUnblockedByHuman: false,
  ...over,
});
const decide = (
  p: Partial<AutoBlockPolicy> = {},
  i: Partial<AutoBlockIncident> = {},
  c: Partial<AutoBlockContext> = {},
) => decideAutoBlock({ policy: { ...on, ...p }, incident: inc(i), ctx: ctx(c) });

describe('decideAutoBlock', () => {
  it('is off by default', () => {
    assert.equal(DEFAULT_POLICY.enabled, false);
    assert.deepEqual(decideAutoBlock({ policy: DEFAULT_POLICY, incident: inc(), ctx: ctx() }), {
      action: 'skip',
      reason: 'disabled',
    });
  });

  it('blocks Critical + targeted for 24 h with the rule recorded', () => {
    const d = decide();
    assert.equal(d.action, 'block');
    if (d.action !== 'block') return;
    assert.equal(d.durationHours, 24);
    assert.equal(d.rule.rule, 'auto_block');
    assert.equal(d.rule.incident_number, 7);
    assert.deepEqual(d.rule.matched, {
      severity: 'critical',
      label: 'targeted',
      real_asset_reached: false,
    });
    assert.equal(
      d.rule.description,
      'block when severity >= critical AND label in [targeted], for 1 d',
    );
  });

  it('monitor mode only says it would block', () => {
    const d = decide({ mode: 'monitor' });
    assert.equal(d.action, 'would_block');
  });

  it('respects min severity, labels and real-asset touch', () => {
    assert.deepEqual(decide({}, { severity: 'high' }), {
      action: 'skip',
      reason: 'below_severity',
    });
    assert.equal(decide({ minSeverity: 'high' }, { severity: 'high' }).action, 'block');
    assert.deepEqual(decide({}, { label: 'opportunistic' }), {
      action: 'skip',
      reason: 'label_not_matched',
    });
    assert.equal(decide({ labels: [] }, { label: 'noise' }).action, 'block');
    assert.deepEqual(decide({ requireRealAssetTouch: true }), {
      action: 'skip',
      reason: 'no_real_asset_touch',
    });
    assert.equal(
      decide({ requireRealAssetTouch: true }, { realAssetReached: true }).action,
      'block',
    );
  });

  it('never acts on resolved incidents or sample data', () => {
    assert.equal(decide({}, { status: 'resolved' }).action, 'skip');
    assert.deepEqual(decide({}, { sample: true }), { action: 'skip', reason: 'sample_data' });
  });

  it('never blocks the allowlist or the platform ranges', () => {
    assert.deepEqual(decide({}, {}, { allowlist: ['45.155.205.0/24'] }), {
      action: 'skip',
      reason: 'allowlisted',
    });
    assert.deepEqual(decide({}, {}, { platformRanges: ['45.155.0.0/16'] }), {
      action: 'skip',
      reason: 'platform_range',
    });
    assert.equal(
      decide({}, { srcIp: '2001:db8:ffff::5' }, { platformRanges: ['2001:db8:ffff::/48'] }).action,
      'skip',
    );
  });

  it('refuses private and loopback ranges unless the project allows them', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.0.9', '100.64.1.1', '::1', 'fd00::1']) {
      const d = decide({}, { srcIp: ip });
      assert.equal(d.action, 'skip', ip);
      if (d.action === 'skip') assert.equal(d.reason, 'private_range', ip);
      if (d.action === 'skip') assert.ok(d.detail, ip);
    }
    assert.equal(decide({ allowPrivate: true }, { srcIp: '10.1.2.3' }).action, 'block');
  });

  it('acts once per incident and never fights a human undo', () => {
    assert.deepEqual(decide({}, {}, { alreadyActed: true }), {
      action: 'skip',
      reason: 'already_acted',
    });
    assert.deepEqual(decide({}, {}, { alreadyBlocked: true }), {
      action: 'skip',
      reason: 'already_blocked',
    });
    assert.deepEqual(decide({}, {}, { recentlyUnblockedByHuman: true }), {
      action: 'skip',
      reason: 'recently_unblocked',
    });
  });

  it('clamps the duration to 1 h – 30 d', () => {
    const lo = decide({ durationHours: 0 });
    const hi = decide({ durationHours: 10_000 });
    assert.equal(lo.action === 'block' && lo.durationHours, 1);
    assert.equal(hi.action === 'block' && hi.durationHours, 720);
  });

  it('describes the rule in plain words', () => {
    assert.equal(
      describePolicy({ ...on, labels: [], requireRealAssetTouch: true, durationHours: 6 }),
      'block when severity >= critical AND touched a real asset, for 6 h',
    );
  });
});

describe('ipInCidrs / targetGuard', () => {
  it('matches v4 and v6 prefixes and host entries; ignores junk', () => {
    assert.ok(ipInCidrs('203.0.113.9', ['203.0.113.0/24']));
    assert.ok(ipInCidrs('203.0.113.9', ['203.0.113.9']));
    assert.ok(!ipInCidrs('203.0.114.9', ['203.0.113.0/24']));
    assert.ok(ipInCidrs('2001:db8::1', ['2001:db8::/32']));
    assert.ok(!ipInCidrs('203.0.113.9', ['not-a-cidr', '1.2.3.4/99']));
    assert.ok(!ipInCidrs('nope', ['0.0.0.0/0']));
  });

  it('rejects invalid input', () => {
    assert.deepEqual(targetGuard('x', { allowlist: [], platformRanges: [], allowPrivate: false }), {
      ok: false,
      reason: 'invalid_ip',
    });
  });
});

/* ───────── worker job + routes over the FakeDb ───────── */

describe('auto-block job (FakeDb)', () => {
  let w: Awaited<ReturnType<typeof buildWorld>>;
  const flags = { sample: false, acted: false, blocked: false, unblocked: false };

  before(async () => {
    w = await buildWorld();
    w.fake.raw.push({ match: /as unblocked/, rows: () => [{ ...flags }] });
    const a = w.fake.table('attackers').find((r) => r.id === w.a.attacker)!;
    a.ip = '45.155.205.10';
    const i = w.fake.table('incidents').find((r) => r.id === w.a.incident)!;
    Object.assign(i, {
      number: 7,
      severity: 'critical',
      label: 'targeted',
      real_asset_reached: false,
      status: 'open',
    });
  });
  after(async () => {
    await w.close();
  });

  const setPolicy = (over: Record<string, unknown>) => {
    const t = w.fake.table('response_policies');
    t.length = 0;
    t.push({
      project_id: w.a.project,
      enabled: true,
      mode: 'enforce',
      min_severity: 'critical',
      labels: ['targeted'],
      duration_hours: 24,
      require_real_asset_touch: false,
      allow_private: false,
      ...over,
    });
  };

  it('does nothing without a policy (off by default)', async () => {
    const before = w.fake.table('blocklist_entries').length;
    const d = await autoBlockIncident(w.a.incident);
    assert.deepEqual(d, { action: 'skip', reason: 'disabled' });
    assert.equal(w.fake.table('blocklist_entries').length, before);
  });

  it('monitor mode records "would block" and blocks nothing', async () => {
    setPolicy({ mode: 'monitor' });
    const blocks = w.fake.table('blocklist_entries').length;
    const d = await autoBlockIncident(w.a.incident);
    assert.equal(d?.action, 'would_block');
    assert.equal(w.fake.table('blocklist_entries').length, blocks);
    const dry = w.fake.table('response_actions').find((r) => r.type === 'auto_block_dry_run');
    assert.ok(dry);
    assert.equal(dry.requested_by, AUTO_BLOCK_ACTOR);
    const log = w.fake
      .table('audit_logs')
      .find((r) => r.action === 'response.auto_block.would_block');
    assert.equal(log?.actor_type, 'system');
  });

  it('enforce mode blocks through blockIp as the system actor with the rule', async () => {
    setPolicy({ mode: 'enforce' });
    const d = await autoBlockIncident(w.a.incident);
    assert.equal(d?.action, 'block');
    const entry = w.fake
      .table('blocklist_entries')
      .find((r) => r.source === 'auto' && r.incident_id === w.a.incident);
    assert.ok(entry, 'auto blocklist row');
    assert.equal(entry.ip, '45.155.205.10');
    assert.equal(entry.created_by, AUTO_BLOCK_ACTOR);
    const rule = typeof entry.rule === 'string' ? JSON.parse(entry.rule) : entry.rule;
    assert.equal(rule.rule, 'auto_block');
    assert.ok(entry.expires_at);
    const log = w.fake
      .table('audit_logs')
      .find((r) => r.action === 'response.block_ip' && r.target_id === entry.id);
    assert.equal(log?.actor_type, 'system');
    const meta = typeof log?.metadata === 'string' ? JSON.parse(log.metadata) : log?.metadata;
    assert.equal(meta.source, 'auto');
    assert.ok(w.fake.table('response_actions').some((r) => r.type === 'block_ip'));
  });

  it('acts once per incident', async () => {
    flags.acted = true;
    const d = await autoBlockIncident(w.a.incident);
    assert.deepEqual(d, { action: 'skip', reason: 'already_acted' });
    flags.acted = false;
  });

  it('never blocks an allowlisted source; records the refusal once', async () => {
    const p = w.fake.table('projects').find((r) => r.id === w.a.project)!;
    p.allowlist = ['45.155.205.0/24'];
    const before = w.fake.table('blocklist_entries').length;
    const d = await autoBlockIncident(w.a.incident);
    assert.deepEqual(d, { action: 'skip', reason: 'allowlisted' });
    assert.equal(w.fake.table('blocklist_entries').length, before);
    assert.ok(w.fake.table('response_actions').some((r) => r.type === 'auto_block_refused'));
    p.allowlist = [];
  });

  it('settings: owner saves the policy, analysts cannot, viewers can read it', async () => {
    w.fake.table('response_policies').length = 0;
    const url = `/v1/projects/${w.a.project}/response-policy`;
    const body = {
      enabled: true,
      mode: 'monitor',
      min_severity: 'critical',
      labels: ['targeted'],
      duration_hours: 48,
      require_real_asset_touch: true,
    };
    const analyst = addMember(w.fake, w.a.org, 'analyst');
    const denied = await w.app.inject({
      method: 'PUT',
      url,
      headers: { cookie: w.cookie(analyst), origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    assert.equal(denied.statusCode, 403);
    const bad = await w.app.inject({
      method: 'PUT',
      url,
      headers: { cookie: w.cookie(w.a.owner), origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...body, duration_hours: 24 * 31 }),
    });
    assert.equal(bad.statusCode, 422, bad.body);
    const ok = await w.app.inject({
      method: 'PUT',
      url,
      headers: { cookie: w.cookie(w.a.owner), origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().policy.duration_hours, 48);
    assert.ok(w.fake.table('audit_logs').some((r) => r.action === 'response.policy.update'));
    const viewer = addMember(w.fake, w.a.org, 'viewer');
    const got = await w.app.inject({ method: 'GET', url, headers: { cookie: w.cookie(viewer) } });
    assert.equal(got.statusCode, 200, got.body);
    assert.equal(got.json().policy.mode, 'monitor');
    assert.equal(got.json().policy.require_real_asset_touch, true);
    assert.equal(got.json().platform_ranges_configured, true);
  });

  it('a project with no policy row reads the safe default', async () => {
    const res = await w.app.inject({
      method: 'GET',
      url: `/v1/projects/${w.b.project}/response-policy`,
      headers: { cookie: w.cookie(w.b.owner) },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().policy.enabled, false);
    assert.equal(res.json().policy.mode, 'monitor');
    void randomUUID;
  });
});
