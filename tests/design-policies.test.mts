import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the crate policy fixture matches every DESIGN §3.4.5 policy example', () => {
  const design = readFileSync(new URL('../docs/DESIGN.md', import.meta.url), 'utf8');
  const section = design.split(/^#### 3\.4\.5 [^\n]*\n/m)[1]?.split(/^#{1,4} /m)[0];
  assert.ok(section, 'DESIGN §3.4.5 must exist');
  const examples = [...section.matchAll(/^\s*```json\n([\s\S]*?)^\s*```/gm)]
    .map(([, text]) => JSON.parse(text))
    .filter(value => value !== null && typeof value === 'object' && 'rules' in value);
  const fixture = JSON.parse(readFileSync(new URL('../crates/wb-proto/tests/fixtures/design-policies.json', import.meta.url), 'utf8'));
  assert.deepEqual(fixture, examples);
});
