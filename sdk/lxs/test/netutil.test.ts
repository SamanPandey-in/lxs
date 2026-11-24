import assert from 'node:assert/strict';
import { test } from 'node:test';
import { originForm } from '../src/middleware/core.js';
import { canonicalIp, isMatchAll, parseCidr, parseIp } from '../src/netutil.js';

test('canonicalIp: dotted IPv4, RFC 5952 IPv6, mapped addresses become IPv4', () => {
  const cases: Array<[string, string | null]> = [
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['0:0:0:0:0:0:0:0', '::'],
    ['::1', '::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['1:0:0:0:0:0:0:0', '1::'],
    ['not-an-ip', null],
    ['198.51.100.1:80', null],
    ['', null],
  ];
  for (const [input, want] of cases) assert.equal(canonicalIp(input), want, input);
});

test('parseCidr: strict prefix lengths, mapped prefixes map onto IPv4', () => {
  const v4 = parseIp('203.0.113.7');
  assert.ok(v4);
  assert.equal(parseCidr('203.0.113.0/24')?.(v4), true);
  assert.equal(parseCidr('::ffff:203.0.113.0/120')?.(v4), true);
  assert.equal(parseCidr('::ffff:203.0.113.7/128')?.(v4), true);
  assert.equal(parseCidr('::ffff:203.0.113.8/125')?.(v4), false);
  for (const bad of [
    '192.0.0.0/2x',
    '1.2.3.4/24/1',
    '1.2.3.4/33',
    '::ffff:1.2.3.4/95',
    '/8',
    'x',
  ]) {
    assert.equal(parseCidr(bad), null, bad);
  }
});

test('isMatchAll catches every spelling of "all addresses"', () => {
  for (const c of ['0.0.0.0/0', '::/0', '::ffff:0.0.0.0/96', '10.0.0.0/0']) {
    assert.equal(isMatchAll(c), true, c);
  }
  for (const c of ['0.0.0.0/1', '0.0.0.0', '::ffff:0.0.0.0/97', 'nope/0']) {
    assert.equal(isMatchAll(c), false, c);
  }
});

test('originForm reduces absolute-form targets to path + query', () => {
  assert.equal(originForm('/a?b'), '/a?b');
  assert.equal(originForm('http://h/.env'), '/.env');
  assert.equal(originForm('HTTPS://h:8443/admin/x?y=1'), '/admin/x?y=1');
  assert.equal(originForm('http://h'), '/');
  assert.equal(originForm('http://h?x=1'), '/?x=1');
  assert.equal(originForm('*'), '*');
  assert.equal(originForm(undefined), '/');
});
