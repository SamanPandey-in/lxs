import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { FRAMEWORKS, loadVectorFiles, runVector, VECTORS_DIR } from '../src/runner.js';

const files = loadVectorFiles();

test('every vector file matches conformance/schema/vector.schema.json and names are unique', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, '..', 'schema', 'vector.schema.json'), 'utf8'),
  ) as object;
  const ajv = new Ajv2020.default({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const names = new Set<string>();
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, f.file), 'utf8')) as unknown;
    assert.ok(validate(doc), `${f.file}: ${ajv.errorsText(validate.errors)}`);
    for (const v of f.vectors) {
      assert.ok(!names.has(v.name), `duplicate vector name ${v.name}`);
      names.add(v.name);
    }
  }
  assert.ok(names.size >= 40, `expected at least 40 vectors, found ${names.size}`);
});

for (const framework of FRAMEWORKS) {
  describe(`${framework} middleware`, () => {
    for (const f of files) {
      for (const v of f.vectors) {
        test(`${f.category}/${v.name}`, async () => {
          const problems = await runVector(v, framework);
          assert.deepEqual(problems, [], `${v.name} (${framework}): ${v.description}`);
        });
      }
    }
  });
}
