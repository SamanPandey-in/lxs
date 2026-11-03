/**
 * IOC export (#11). The export is a closing beat of the demo script, so a row it
 * cannot format has to degrade rather than 500 the whole response.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attackerContext, iocsToCsv } from '../src/modules/response.ts';

describe('attackerContext', () => {
  it('capitalises the label', () => {
    assert.equal(
      attackerContext({ label: 'targeted', real_asset_reached: false, number: 3 }),
      'Targeted (incident #3)',
    );
  });

  it('calls out a real asset being reached', () => {
    assert.equal(
      attackerContext({ label: 'targeted', real_asset_reached: true, number: 7 }),
      'Targeted; reached a real asset (incident #7)',
    );
  });

  it('does not throw on an empty label', () => {
    // The column is NOT NULL but not constrained non-empty; this used to be a
    // TypeError that 500'd GET /iocs and the incident Export button.
    assert.doesNotThrow(() => attackerContext({ label: '', real_asset_reached: false, number: 1 }));
    assert.equal(
      attackerContext({ label: '', real_asset_reached: false, number: 1 }),
      'Unlabelled (incident #1)',
    );
  });

  it('still reports a real asset when the label is missing', () => {
    assert.equal(
      attackerContext({ label: '', real_asset_reached: true, number: 2 }),
      'Unlabelled; reached a real asset (incident #2)',
    );
  });

  it('handles a single-character label', () => {
    assert.equal(
      attackerContext({ label: 'x', real_asset_reached: false, number: 4 }),
      'X (incident #4)',
    );
  });
});

describe('iocsToCsv', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    type: 'ipv4',
    value: '203.0.113.7',
    first_seen: '2026-01-01T00:00:00Z',
    last_seen: '2026-01-01T00:01:00Z',
    context: 'Targeted (incident #1)',
    ...over,
  });

  it('writes a header and one CRLF-terminated line per indicator', () => {
    const csv = iocsToCsv([row(), row({ value: '198.51.100.9' })]);
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines[0], 'type,value,first_seen,last_seen,context');
    assert.equal(lines.length, 3);
    assert.ok(csv.endsWith('\r\n'));
  });

  it('neutralises spreadsheet formula injection', () => {
    // Commands and banners are attacker-controlled and land in a file analysts
    // open in Excel, so a leading =/+/-/@ must not be evaluated.
    for (const lead of ['=', '+', '-', '@']) {
      const csv = iocsToCsv([row({ type: 'command', value: `${lead}cmd|' /c calc'!A0` })]);
      assert.ok(csv.includes(`"'${lead}cmd`), `${lead} was not escaped`);
    }
  });

  it('doubles embedded quotes so a value cannot break out of its cell', () => {
    const csv = iocsToCsv([row({ type: 'command', value: 'echo "pwned"' })]);
    assert.ok(csv.includes('"echo ""pwned"""'));
  });

  it('tolerates indicators with no timestamps', () => {
    const csv = iocsToCsv([
      { type: 'command', value: 'whoami', context: 'Executed on ssh:22' } as never,
    ]);
    assert.ok(csv.includes('"whoami"'));
    assert.ok(csv.includes('"",""'));
  });
});
