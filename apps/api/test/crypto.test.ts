import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signToken, verifyToken } from '../src/lib/crypto.js';

const secret = 'test-session-secret-at-least-16-chars';

test('signToken creates a compact HS256 JWT and verifyToken reads it', () => {
  const token = signToken({ uid: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  const [header, payload, signature, ...extra] = token.split('.');

  assert.equal(extra.length, 0);
  assert.equal(JSON.parse(Buffer.from(header!, 'base64url').toString()).alg, 'HS256');
  assert.deepEqual(verifyToken(token, secret), {
    uid: 'user-1',
    exp: JSON.parse(Buffer.from(payload!, 'base64url').toString()).exp,
  });
  assert.ok(signature);
});

test('verifyToken rejects malformed and tampered JWTs', () => {
  const token = signToken({ uid: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  const [header, payload, signature] = token.split('.');

  assert.equal(verifyToken('not-a-jwt', secret), null);
  assert.equal(verifyToken(`${header}.${payload}.${signature}extra`, secret), null);
  assert.equal(verifyToken(`${header}.${payload}.invalid`, secret), null);
  assert.equal(verifyToken(token, `${secret}-different`), null);
});

test('verifyToken rejects expired JWTs and tokens without an expiration', () => {
  assert.equal(verifyToken(signToken({ uid: 'user-1', exp: 1 }, secret), secret), null);
  assert.equal(verifyToken(signToken({ uid: 'user-1' }, secret), secret), null);
});
