import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { env } from '../src/env.ts';
import { ingestRetryAfterHeader, ingestSensorOwnedBy } from '../src/modules/ingest.ts';
import { buildIngestQuotaScopes, exceedsIngestQuota } from '../src/plugins/rate-limit.ts';

describe('ingest quota policy', () => {
  it('uses project and sensor scopes, with a bounded active-peer share', () => {
    const scopes = buildIngestQuotaScopes('project-1', 'sensor-1', 8);
    assert.deepEqual(
      scopes.map(({ scopeKey }) => scopeKey),
      ['project:project-1', 'sensor:sensor-1'],
    );
    assert.equal(scopes[0]?.maxEvents, env.INGEST_PROJECT_EVENTS_PER_MIN);
    assert.equal(
      scopes[1]?.maxEvents,
      Math.min(env.INGEST_SENSOR_EVENTS_PER_MIN, Math.floor(env.INGEST_PROJECT_EVENTS_PER_MIN / 8)),
    );
    assert.equal(
      scopes[1]?.maxBytes,
      Math.min(env.INGEST_SENSOR_BYTES_PER_MIN, Math.floor(env.INGEST_PROJECT_BYTES_PER_MIN / 8)),
    );
  });

  it('keeps a project bucket when no authenticated sensor is available', () => {
    assert.deepEqual(
      buildIngestQuotaScopes('project-1', null, 3).map(({ scopeKey }) => scopeKey),
      ['project:project-1'],
    );
  });

  it('enforces event and byte ceilings independently and permits exact limits', () => {
    assert.equal(exceedsIngestQuota(90, 900, 10, 100, 100, 1000), false);
    assert.equal(exceedsIngestQuota(100, 0, 1, 0, 100, 1000), true);
    assert.equal(exceedsIngestQuota(0, 1000, 0, 1, 100, 1000), true);
  });

  it('formats a positive integer Retry-After value for HTTP 429 responses', () => {
    assert.equal(ingestRetryAfterHeader(7), '7');
    assert.equal(ingestRetryAfterHeader(7.2), '8');
    assert.equal(ingestRetryAfterHeader(0), '1');
  });
});

describe('ingest sensor ownership', () => {
  it('requires both project and API-key ownership for client sensor ids', () => {
    const sensor = { projectId: 'project-1', apiKeyId: 'key-1' };
    assert.equal(ingestSensorOwnedBy(sensor, 'project-1', 'key-1'), true);
    assert.equal(ingestSensorOwnedBy(sensor, 'project-2', 'key-1'), false);
    assert.equal(ingestSensorOwnedBy(sensor, 'project-1', 'key-2'), false);
  });
});
