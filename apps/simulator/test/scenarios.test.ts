import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildScenario, SCENARIO_NAMES } from '../src/scenarios.ts';

describe('simulator scenarios', () => {
  for (const name of SCENARIO_NAMES) {
    it(`${name}: valid, time-ordered, unique ids, simulated`, () => {
      let n = 0;
      const sc = buildScenario(name, {
        base: new Date('2026-11-01T10:00:00Z'),
        makeId: () => `01JC8Z4T7Q2W9F0X1M3N5P${String(++n).padStart(4, '0')}`,
      });
      assert.ok(sc.length > 0);
      const ids = new Set(sc.map((s) => s.event.id));
      assert.equal(ids.size, sc.length);
      for (let i = 1; i < sc.length; i++)
        assert.ok(
          (sc[i] as (typeof sc)[number]).offsetMs >= (sc[i - 1] as (typeof sc)[number]).offsetMs,
        );
      for (const s of sc) {
        assert.equal(s.event.schema_version, 1);
        assert.equal(s.event.simulated, true);
        assert.ok(s.event.id.length >= 20 && s.event.id.length <= 40);
        assert.ok(!Number.isNaN(Date.parse(s.event.timestamp)));
      }
    });
  }

  it('ps-attacker command gaps are human (>= 1.5 s)', () => {
    const sc = buildScenario('ps-attacker', {
      base: new Date(),
      makeId: (() => {
        let i = 0;
        return () => `01JC8Z4T7Q2W9F0X1M3N5P${String(++i).padStart(4, '0')}`;
      })(),
    });
    const cmds = sc.filter((s) => s.event.event_type === 'command.exec');
    for (let i = 1; i < cmds.length; i++) {
      assert.ok(
        (cmds[i] as (typeof cmds)[number]).offsetMs -
          (cmds[i - 1] as (typeof cmds)[number]).offsetMs >=
          1500,
      );
    }
  });
});
