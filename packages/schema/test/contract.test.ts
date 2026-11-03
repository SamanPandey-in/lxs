/**
 * The contract is frozen. These tests exist so that a change to packages/schema
 * cannot land quietly: every consumer (agent, API, detection, dashboard) is built
 * against exactly these shapes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentPolicy, DecoyEvent, IngestBatch } from '../src/index.ts';

/** The worked example from BREAKDOWN §7.5, verbatim. */
const EXAMPLE = {
  id: '01JC8Z4T7Q2W9F0X1M3N5P7R9S',
  schema_version: 1 as const,
  timestamp: '2026-11-01T10:42:17.311Z',
  sensor: 'ssh' as const,
  decoy_id: 'ssh-db-backup-01',
  is_decoy: true,
  session_id: 'ssh-db-backup-01:7f3a',
  src_ip: '203.0.113.66',
  src_port: 51544,
  dst_service: 'ssh:22',
  event_type: 'command.exec' as const,
  outcome: 'success' as const,
  username: 'admin',
  command: 'cat /srv/exports/customer_data.csv',
};

describe('DecoyEvent', () => {
  it('parses the documented example event', () => {
    const e = DecoyEvent.parse(EXAMPLE);
    assert.equal(e.event_type, 'command.exec');
    assert.equal(e.src_ip, '203.0.113.66');
  });

  it('defaults count to 1 and simulated to false', () => {
    const e = DecoyEvent.parse(EXAMPLE);
    assert.equal(e.count, 1);
    assert.equal(e.simulated, false);
  });

  it('rejects a malformed source IP', () => {
    assert.equal(DecoyEvent.safeParse({ ...EXAMPLE, src_ip: 'not-an-ip' }).success, false);
  });

  it('accepts IPv6 sources', () => {
    assert.equal(DecoyEvent.safeParse({ ...EXAMPLE, src_ip: '2001:db8::1' }).success, true);
  });

  it('pins schema_version to 1 so consumers can branch on it later', () => {
    assert.equal(DecoyEvent.safeParse({ ...EXAMPLE, schema_version: 2 }).success, false);
  });

  it('rejects an unknown event_type rather than letting it through untagged', () => {
    assert.equal(DecoyEvent.safeParse({ ...EXAMPLE, event_type: 'nope' }).success, false);
  });

  it('caps command at 4 KB', () => {
    assert.equal(DecoyEvent.safeParse({ ...EXAMPLE, command: 'x'.repeat(4097) }).success, false);
  });

  it('requires the fields every sensor must supply', () => {
    for (const k of [
      'id',
      'timestamp',
      'sensor',
      'is_decoy',
      'src_ip',
      'dst_service',
      'event_type',
    ]) {
      const { [k]: _omitted, ...rest } = EXAMPLE as Record<string, unknown>;
      assert.equal(DecoyEvent.safeParse(rest).success, false, `${k} should be required`);
    }
  });
});

describe('IngestBatch', () => {
  it('accepts a batch of one', () => {
    assert.equal(IngestBatch.parse({ events: [EXAMPLE] }).events.length, 1);
  });

  it('rejects an empty batch and caps a batch at 500', () => {
    assert.equal(IngestBatch.safeParse({ events: [] }).success, false);
    const many = Array.from({ length: 501 }, () => EXAMPLE);
    assert.equal(IngestBatch.safeParse({ events: many }).success, false);
  });
});

describe('AgentPolicy', () => {
  it('defaults the poll interval and block TTL so an agent always has a cadence', () => {
    const p = AgentPolicy.parse({ policy_version: 0, blocklist: [], watchlist: [] });
    assert.equal(p.poll_interval_seconds, 10);
    assert.equal(p.block_ttl_seconds, 3600);
  });
});
