/**
 * Project allowlist entries (#8). The allowlist is on the demo path — it is what
 * stops assertBlockable blocking our own scanners — and a rejected prefix used to
 * surface as a generic 422 with no indication of which entry was wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toCidr } from '../src/modules/projects.ts';

describe('toCidr', () => {
  it('defaults a bare address to a host prefix', () => {
    assert.equal(toCidr('10.0.0.1'), '10.0.0.1/32');
    assert.equal(toCidr('2001:db8::1'), '2001:db8::1/128');
  });

  it('accepts valid prefixes at both ends of the range', () => {
    assert.equal(toCidr('10.0.0.0/8'), '10.0.0.0/8');
    assert.equal(toCidr('0.0.0.0/0'), '0.0.0.0/0');
    assert.equal(toCidr('10.0.0.1/32'), '10.0.0.1/32');
    assert.equal(toCidr('2001:db8::/32'), '2001:db8::/32');
    assert.equal(toCidr('2001:db8::1/128'), '2001:db8::1/128');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(toCidr('  10.0.0.0/8  '), '10.0.0.0/8');
  });

  it('rejects a prefix length above the family maximum', () => {
    // This is the reported bug: /999 used to pass and fail later in Postgres.
    assert.throws(() => toCidr('10.0.0.0/999'), /at most 32/);
    assert.throws(() => toCidr('10.0.0.0/33'), /at most 32/);
    assert.throws(() => toCidr('2001:db8::/129'), /at most 128/);
  });

  it('rejects a non-numeric prefix length', () => {
    assert.throws(() => toCidr('10.0.0.0/abc'), /expected a number/);
    assert.throws(() => toCidr('10.0.0.0/-1'), /expected a number/);
    assert.throws(() => toCidr('10.0.0.0/'), /expected a number/);
    assert.throws(() => toCidr('10.0.0.0/ 8'), /expected a number/);
  });

  it('rejects a trailing second prefix rather than ignoring it', () => {
    // split('/') used to keep the first mask and drop the rest silently.
    assert.throws(() => toCidr('10.0.0.0/8/8'), /expected a number/);
  });

  it('rejects things that are not addresses', () => {
    assert.throws(() => toCidr('not-an-ip'), /not an IPv4 or IPv6 address/);
    assert.throws(() => toCidr('10.0.0.256/8'), /not an IPv4 or IPv6 address/);
    assert.throws(() => toCidr(''), /empty/);
    assert.throws(() => toCidr('   '), /empty/);
    assert.throws(() => toCidr('/8'), /not an IPv4 or IPv6 address/);
  });

  it('names the offending value in the message', () => {
    // An operator fixing the Settings page needs to know which entry to change.
    assert.throws(() => toCidr('10.0.0.0/999'), /10\.0\.0\.0\/999/);
  });

  it('masks IPv4 host bits down to the network address', () => {
    // `cidr` refuses bits to the right of the mask, so this used to be an opaque
    // Postgres error for anyone who typed a host address with a network prefix.
    assert.equal(toCidr('192.168.1.5/24'), '192.168.1.0/24');
    assert.equal(toCidr('10.1.2.3/8'), '10.0.0.0/8');
    assert.equal(toCidr('255.255.255.255/0'), '0.0.0.0/0');
    assert.equal(toCidr('172.16.5.130/26'), '172.16.5.128/26');
  });

  it('leaves an already-normalised IPv4 network untouched', () => {
    assert.equal(toCidr('192.168.1.0/24'), '192.168.1.0/24');
    assert.equal(toCidr('172.16.0.0/12'), '172.16.0.0/12');
  });
});
