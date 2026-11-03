import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createNormalizerContext,
  normalizeCowrie,
  normalizeTelemetry,
  normalizeWebDecoy,
  parseCommonCredentials,
} from '../src/index.ts';

const creds = parseCommonCredentials('# c\nadmin\nroot\nroot/toor\n123456\n');
const mk = () =>
  createNormalizerContext({
    commonCredentials: creds,
    projectSalt: 'salt-1',
    sshDecoyId: 'ssh-db-backup-01',
    now: () => new Date('2026-11-01T10:00:00.000Z'),
  });
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('normalizeCowrie', () => {
  it('maps connect / login / command / download / forward / close', () => {
    const ctx = mk();
    const base = {
      src_ip: '203.0.113.66',
      src_port: 51544,
      session: '7f3a',
      timestamp: '2026-11-01T10:42:17.311301Z',
    };
    const connect = normalizeCowrie(
      { ...base, eventid: 'cowrie.session.connect', dst_port: 22 },
      ctx,
    );
    assert.equal(connect?.event_type, 'connection.open');
    assert.equal(connect?.session_id, 'ssh-db-backup-01:7f3a');
    assert.equal(connect?.dst_service, 'ssh:22');
    assert.equal(connect?.timestamp, '2026-11-01T10:42:17.311Z');
    assert.match(connect?.id ?? '', ULID);
    assert.equal(connect?.sensor, 'ssh');
    assert.equal(connect?.is_decoy, true);

    const ver = normalizeCowrie(
      { ...base, eventid: 'cowrie.client.version', version: 'SSH-2.0-libssh_0.9.6' },
      ctx,
    );
    assert.equal(ver?.event_type, 'ssh.client');
    assert.equal(ver?.client_banner, 'SSH-2.0-libssh_0.9.6');

    const kex = normalizeCowrie({ ...base, eventid: 'cowrie.client.kex', hassh: 'abc123' }, ctx);
    assert.equal(kex?.event_type, 'ssh.client');
    assert.equal(kex?.raw?.hassh, 'abc123');

    const cmd = normalizeCowrie({ ...base, eventid: 'cowrie.command.input', input: 'ls -la' }, ctx);
    assert.equal(cmd?.event_type, 'command.exec');
    assert.equal(cmd?.command, 'ls -la');

    const dl = normalizeCowrie(
      {
        ...base,
        eventid: 'cowrie.session.file_download',
        url: 'http://x/y.sh',
        shasum: 'a'.repeat(64),
        outfile: 'var/lib/x',
      },
      ctx,
    );
    assert.equal(dl?.event_type, 'file.download');
    assert.equal(dl?.file_sha256, 'a'.repeat(64));

    const fwd = normalizeCowrie(
      { ...base, eventid: 'cowrie.direct-tcpip.request', dst_ip: '10.0.0.5', dst_port: 3306 },
      ctx,
    );
    assert.equal(fwd?.event_type, 'proxy.attempt');
    assert.equal(fwd?.dst_service, 'tcpip:10.0.0.5:3306');

    const closed = normalizeCowrie(
      { ...base, eventid: 'cowrie.session.closed', duration: 63.2 },
      ctx,
    );
    assert.equal(closed?.event_type, 'connection.close');
    assert.equal(closed?.raw?.duration, 63.2);
    assert.equal(ctx.stats.accepted, 7);
  });

  it('stores clear text only for common credentials; masks + salted-hashes the rest', () => {
    const ctx = mk();
    const base = { src_ip: '203.0.113.66', session: 's1', timestamp: '2026-11-01T10:42:17Z' };
    const common = normalizeCowrie(
      { ...base, eventid: 'cowrie.login.success', username: 'admin', password: 'admin' },
      ctx,
    );
    assert.equal(common?.outcome, 'success');
    assert.equal(common?.password_clear, 'admin');
    assert.equal(common?.password_masked, undefined);

    const pair = normalizeCowrie(
      { ...base, eventid: 'cowrie.login.success', username: 'root', password: 'toor' },
      ctx,
    );
    assert.equal(pair?.password_clear, 'toor'); // "root/toor" pair is on the list

    const secret = normalizeCowrie(
      { ...base, eventid: 'cowrie.login.failed', username: 'alice', password: 'S3cretPassw0rd' },
      ctx,
    );
    assert.equal(secret?.outcome, 'failure');
    assert.equal(secret?.password_clear, undefined);
    assert.equal(secret?.password_masked, 'S***d');
    assert.equal(
      secret?.password_sha256,
      createHash('sha256').update('salt-1S3cretPassw0rd').digest('hex'),
    );
    assert.ok(
      !JSON.stringify(secret).includes('S3cretPassw0rd'),
      'clear password must not appear anywhere in the event',
    );
  });

  it('drops loopback sources and unmapped eventids, and counts them', () => {
    const ctx = mk();
    const t = '2026-11-01T10:42:17Z';
    assert.equal(
      normalizeCowrie(
        { eventid: 'cowrie.session.connect', src_ip: '127.0.0.1', timestamp: t },
        ctx,
      ),
      null,
    );
    assert.equal(
      normalizeCowrie({ eventid: 'cowrie.session.connect', src_ip: '::1', timestamp: t }, ctx),
      null,
    );
    assert.equal(
      normalizeCowrie({ eventid: 'cowrie.log.closed', src_ip: '203.0.113.9', timestamp: t }, ctx),
      null,
    );
    assert.equal(
      normalizeCowrie({ eventid: 'cowrie.log.closed', src_ip: '203.0.113.9', timestamp: t }, ctx),
      null,
    );
    assert.equal(
      normalizeCowrie(
        { eventid: 'cowrie.session.params', src_ip: '203.0.113.9', timestamp: t },
        ctx,
      ),
      null,
    );
    assert.equal(ctx.stats.dropped_loopback, 2);
    assert.equal(ctx.stats.dropped_unmapped, 3);
    assert.deepEqual(ctx.stats.unmapped, { 'cowrie.log.closed': 2, 'cowrie.session.params': 1 });
    assert.equal(ctx.stats.accepted, 0);
  });

  it('caps command at 4 KB and raw at 4 KB', () => {
    const ctx = mk();
    const ev = normalizeCowrie(
      {
        eventid: 'cowrie.command.input',
        src_ip: '203.0.113.9',
        timestamp: '2026-11-01T10:42:17Z',
        input: 'A'.repeat(10_000),
      },
      ctx,
    );
    assert.equal(ev?.command?.length, 4096);
    assert.ok(JSON.stringify(ev?.raw).length <= 4096);
    assert.equal(ev?.raw?.truncated, true);
  });
});

describe('normalizeWebDecoy', () => {
  it('maps the documented ds-web login line', () => {
    const ctx = mk();
    const ev = normalizeWebDecoy(
      {
        ts: '2026-11-01T10:41:02.120Z',
        decoy_id: 'web-admin-admin',
        kind: 'login',
        ip: '203.0.113.66',
        method: 'POST',
        path: '/admin/login',
        ua: 'Mozilla/5.0',
        username: 'admin',
        password: 'admin',
        accepted: true,
        req_id: '01JC8Z4T7Q2W9F0X1M3N5P7R9S',
      },
      ctx,
    );
    assert.ok(ev);
    assert.equal(ev?.id, '01JC8Z4T7Q2W9F0X1M3N5P7R9S');
    assert.equal(ev?.event_type, 'auth.attempt');
    assert.equal(ev?.outcome, 'success');
    assert.equal(ev?.sensor, 'web');
    assert.equal(ev?.decoy_id, 'web-admin-admin');
    assert.equal(ev?.dst_service, 'http:/admin/login');
    assert.equal(ev?.password_clear, 'admin');
    assert.equal(ev?.method, 'POST');
    assert.equal(ev?.user_agent, 'Mozilla/5.0');
    assert.equal(ev?.timestamp, '2026-11-01T10:41:02.120Z');
  });

  it('masks non-common web passwords and strips the password from raw', () => {
    const ctx = mk();
    const ev = normalizeWebDecoy(
      {
        ts: '2026-11-01T10:41:02Z',
        decoy_id: 'web-admin-admin',
        kind: 'login',
        ip: '203.0.113.7',
        method: 'POST',
        path: '/admin/login',
        username: 'cfo',
        password: 'Hunter2!Hunter2',
        accepted: false,
        req_id: 'not-a-ulid',
      },
      ctx,
    );
    assert.equal(ev?.outcome, 'failure');
    assert.equal(ev?.password_masked, 'H***2');
    assert.equal(ev?.password_sha256?.length, 64);
    assert.match(ev?.id ?? '', ULID);
    assert.ok(!JSON.stringify(ev).includes('Hunter2!'));
  });

  it('maps requests, bait downloads and honeytoken reads; drops unknown kinds and loopback', () => {
    const ctx = mk();
    const l = {
      ts: '2026-11-01T10:41:02Z',
      decoy_id: 'web-admin-admin',
      ip: '203.0.113.7',
      method: 'GET',
    };
    assert.equal(
      normalizeWebDecoy({ ...l, kind: 'request', path: '/.env?x=1', status: 404 }, ctx)?.event_type,
      'http.request',
    );
    assert.equal(
      normalizeWebDecoy({ ...l, kind: 'request', path: '/.env?x=1', status: 404 }, ctx)
        ?.dst_service,
      'http:/.env',
    );
    const bait = normalizeWebDecoy(
      { ...l, kind: 'bait', path: '/backup.sql', status: 200, file: 'backup.sql' },
      ctx,
    );
    assert.equal(bait?.event_type, 'file.download');
    assert.equal(bait?.file_name, 'backup.sql');
    const ht = normalizeWebDecoy(
      { ...l, kind: 'honeytoken', path: '/.env', token_id: 'ht-1' },
      ctx,
    );
    assert.equal(ht?.event_type, 'honeytoken.read');
    assert.equal(ht?.honeytoken_id, 'ht-1');
    assert.equal(normalizeWebDecoy({ ...l, kind: 'weird', path: '/' }, ctx), null);
    assert.equal(
      normalizeWebDecoy({ ...l, ip: '127.0.0.1', kind: 'request', path: '/' }, ctx),
      null,
    );
    assert.equal(ctx.stats.dropped_unmapped, 1);
    assert.equal(ctx.stats.dropped_loopback, 1);
  });
});

describe('normalizeTelemetry', () => {
  it('maps firewall.jsonl records to prod.firewall', () => {
    const ctx = mk();
    const ev = normalizeTelemetry(
      {
        ts: '2026-11-01T10:43:00Z',
        src_ip: '203.0.113.66',
        dst_ip: '10.0.1.20',
        dst_port: 443,
        proto: 'tcp',
        action: 'allow',
      },
      ctx,
    );
    assert.equal(ev?.event_type, 'prod.firewall');
    assert.equal(ev?.sensor, 'prod');
    assert.equal(ev?.is_decoy, false);
    assert.equal(ev?.outcome, 'success');
    assert.equal(ev?.dst_service, 'fw:10.0.1.20:443');
    const denied = normalizeTelemetry(
      {
        ts: '2026-11-01T10:43:00Z',
        src_ip: '203.0.113.66',
        dst_ip: '10.0.1.20',
        dst_port: 22,
        action: 'deny',
      },
      ctx,
    );
    assert.equal(denied?.outcome, 'failure');
  });

  it('maps auth.jsonl records to prod.auth', () => {
    const ctx = mk();
    const ev = normalizeTelemetry(
      {
        ts: '2026-11-01T10:43:05Z',
        src_ip: '203.0.113.66',
        user: 'svc-payments',
        service: 'payments-api',
        result: 'success',
        asset: 'Payments API',
      },
      ctx,
    );
    assert.equal(ev?.event_type, 'prod.auth');
    assert.equal(ev?.outcome, 'success');
    assert.equal(ev?.username, 'svc-payments');
    assert.equal(ev?.asset_name, 'Payments API');
    assert.equal(ev?.dst_service, 'auth:payments-api');
  });
});
