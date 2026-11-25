/**
 * Per-visitor honeytoken attribution (stream L): the pure parts. No database is touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DecoyEvent } from '@lxs/schema';
import {
  baseTokenId,
  isMintId,
  mintRow,
  splitMintEvents,
  toAttribution,
  usedMintIds,
} from '../src/lib/honeytoken-attribution.ts';
import { detectionThresholds, loadDetection } from '../src/worker/detection.ts';

const ev = (over: Partial<DecoyEvent>): DecoyEvent => ({
  id: '01JC8Z4T7Q2W9F0X1M3N5P0001',
  schema_version: 1,
  timestamp: '2026-11-24T10:02:00.000Z',
  sensor: 'web',
  decoy_id: 'web-bait-env',
  is_decoy: true,
  src_ip: '203.0.113.9',
  dst_service: 'http:/.env',
  event_type: 'honeytoken.mint',
  url: '/.env',
  honeytoken_id: 'ht_api_01.swvxpgns7opr',
  count: 1,
  simulated: false,
  ...over,
});

describe('honeytoken attribution helpers', () => {
  it('recognises minted ids and maps them to their base token', () => {
    assert.ok(isMintId('ht_api_01.swvxpgns7opr'));
    assert.ok(!isMintId('ht_api_01'));
    assert.ok(!isMintId('ht_api_01.SWVX'));
    assert.ok(!isMintId(undefined));
    assert.equal(baseTokenId('ht_api_01.swvxpgns7opr'), 'ht_api_01');
    // Static (legacy) ids pass through unchanged.
    assert.equal(baseTokenId('ht_api_01'), 'ht_api_01');
    assert.equal(baseTokenId('ht-acme-api-key'), 'ht-acme-api-key');
  });

  it('splits mint events out of the event stream and drops malformed ones', () => {
    const use = ev({
      event_type: 'honeytoken.use',
      sensor: 'sdk',
      is_decoy: false,
      src_ip: '198.51.100.4',
    });
    const read = ev({ event_type: 'honeytoken.read', honeytoken_id: 'ht_api_01' });
    const bad = ev({ honeytoken_id: 'nope' });
    const { mints, events } = splitMintEvents([ev({}), use, read, bad]);
    assert.equal(mints.length, 1);
    assert.deepEqual(
      events.map((e) => e.event_type),
      ['honeytoken.use', 'honeytoken.read'],
    );
    assert.deepEqual(usedMintIds(events), ['ht_api_01.swvxpgns7opr']);
    assert.deepEqual(
      usedMintIds([ev({ event_type: 'honeytoken.use', honeytoken_id: 'ht_api_01' })]),
      [],
    );
  });

  it('builds the mapping row and the attribution the incident shows', () => {
    const row = mintRow('p1', ev({ session_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    assert.deepEqual(
      { ...row, mintedAt: row.mintedAt.toISOString() },
      {
        projectId: 'p1',
        mintId: 'ht_api_01.swvxpgns7opr',
        baseTokenId: 'ht_api_01',
        decoyKey: 'web-bait-env',
        sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
        mintedForIp: '203.0.113.9',
        plantedVia: '/.env',
        mintedAt: '2026-11-24T10:02:00.000Z',
      },
    );
    const a = toAttribution({
      id: 'x',
      projectId: 'p1',
      mintId: 'ht_api_01.swvxpgns7opr',
      baseTokenId: 'ht_api_01',
      decoyKey: 'web-bait-env',
      sessionId: null,
      mintedForIp: '203.0.113.9',
      plantedVia: '/.env',
      mintedAt: new Date('2026-11-24T10:02:00.000Z'),
      firstUsedAt: null,
      lastUsedAt: null,
      usedFromIp: null,
      useCount: 0,
      createdAt: new Date(),
    });
    assert.deepEqual(a, {
      mint_id: 'ht_api_01.swvxpgns7opr',
      base_token_id: 'ht_api_01',
      minted_for_ip: '203.0.113.9',
      minted_at: '2026-11-24T10:02:00.000Z',
      planted_via: '/.env',
      session_id: null,
      decoy_id: 'web-bait-env',
    });
  });
});

describe('opt-in detection threshold jitter in the worker', () => {
  it('adds nothing to the context without a seed (golden tests and the demo)', async () => {
    const det = await loadDetection();
    assert.deepEqual(detectionThresholds(det, 'p1', {}), {});
    assert.deepEqual(detectionThresholds(det, 'p1', { LXS_DETECTION_JITTER_SEED: '  ' }), {});
  });

  it('derives per-project thresholds from the deployment seed', async () => {
    const det = await loadDetection();
    const env = { LXS_DETECTION_JITTER_SEED: 'prod-eu-1' };
    const a = detectionThresholds(det, 'p1', env).thresholds;
    const b = detectionThresholds(det, 'p2', env).thresholds;
    assert.ok(a && b);
    assert.deepEqual(detectionThresholds(det, 'p1', env).thresholds, a);
    assert.notDeepEqual(a, b);
  });
});
