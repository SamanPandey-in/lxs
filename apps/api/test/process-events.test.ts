import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChainResult } from '../src/worker/detection.js';
import { shouldOpenIndividualIncident } from '../src/worker/process-events.js';

const result = (overrides: Partial<ChainResult> = {}): ChainResult => ({
  detections: [],
  score: 0,
  severity: 'low',
  label: 'noise',
  stagesReached: [],
  realAssetReached: false,
  honeytokenUsed: false,
  rawScore: 0,
  floor: null,
  preCorrelationLabel: 'noise',
  ...overrides,
});

describe('individual incident promotion policy', () => {
  it('keeps a generic low-signal decoy touch out of the incident stream', () => {
    assert.equal(
      shouldOpenIndividualIncident(
        result({
          score: 5,
          rawScore: 5,
          detections: [
            {
              rule_id: 'R01',
              points: 5,
              reason: 'Touched a decoy',
              techniques: [
                { id: 'T1595', name: 'Active Scanning', tactic: 'reconnaissance', confidence: 0.6 },
              ],
              stage: 'recon',
              floor: null,
              evidence_event_ids: ['event-1'],
            },
          ],
        }),
      ),
      false,
    );
  });

  it('promotes medium-or-higher scores and meaningful rule detections', () => {
    assert.equal(shouldOpenIndividualIncident(result({ score: 25 })), true);
    assert.equal(
      shouldOpenIndividualIncident(
        result({
          detections: [
            {
              rule_id: 'R04',
              points: 10,
              reason: 'Repeated failed logins',
              techniques: [],
              stage: 'initial_access',
              floor: null,
              evidence_event_ids: ['event-1'],
            },
          ],
        }),
      ),
      true,
    );
  });

  it('always promotes high-impact evidence even if its score is low', () => {
    assert.equal(shouldOpenIndividualIncident(result({ honeytokenUsed: true })), true);
    assert.equal(shouldOpenIndividualIncident(result({ realAssetReached: true })), true);
    assert.equal(shouldOpenIndividualIncident(result({ floor: 'critical' })), true);
  });

  it('does not treat event ATT&CK tags alone as a detection', () => {
    assert.equal(
      shouldOpenIndividualIncident(
        result({
          detections: [
            {
              rule_id: 'R01',
              points: 5,
              reason: 'Touched a decoy',
              techniques: [
                { id: 'T1595', name: 'Active Scanning', tactic: 'reconnaissance', confidence: 0.6 },
              ],
              stage: 'recon',
              floor: null,
              evidence_event_ids: ['event-1'],
            },
          ],
        }),
      ),
      false,
    );
  });
});
