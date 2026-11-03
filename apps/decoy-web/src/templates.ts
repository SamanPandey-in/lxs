import type { CanaryRow, HoneytokenSet, WebDecoysFile } from './config.js';

/**
 * Static templates. Attacker input is never interpolated here: the only dynamic values are trusted config
 * (brand, mount) and generated honeytokens, and every dynamic value still goes through esc().
 */
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (v: unknown): string => String(v).replace(/[&<>"']/g, (c) => ESC[c] as string);

const CSS = `
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;color:#1f2937}
.card{max-width:360px;margin:12vh auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:32px;box-shadow:0 4px 18px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 4px}p.sub{margin:0 0 20px;color:#6b7280}label{display:block;font-weight:600;margin:12px 0 4px}
input{width:100%;padding:9px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
.err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:8px 10px;border-radius:6px;margin-bottom:8px}
.top{background:#111827;color:#fff;padding:12px 24px;display:flex;justify-content:space-between}.top a{color:#9ca3af;margin-left:16px;text-decoration:none}
.wrap{max-width:900px;margin:24px auto;padding:0 16px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #e5e7eb}th{background:#f9fafb;font-size:12px;text-transform:uppercase;color:#6b7280}
a.btn{display:inline-block;background:#2563eb;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600}
`;

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

export function loginPage(opts: {
  brand: string;
  action: string;
  error?: boolean;
  title?: string;
}): string {
  return page(
    `${opts.brand} - Sign in`,
    `<div class="card"><h1>${esc(opts.brand)}</h1><p class="sub">${esc(opts.title ?? 'Administration console')}</p>` +
      (opts.error ? '<div class="err">Invalid username or password.</div>' : '') +
      `<form method="post" action="${esc(opts.action)}" autocomplete="off">` +
      '<label for="u">Username</label><input id="u" name="username" type="text" autofocus>' +
      '<label for="p">Password</label><input id="p" name="password" type="password">' +
      '<button type="submit">Sign in</button></form></div>',
  );
}

export function panelPage(opts: {
  brand: string;
  mount: string;
  rows: CanaryRow[];
  withExport: boolean;
}): string {
  const rows = opts.rows
    .slice(0, 10)
    .map(
      (r) =>
        `<tr><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.company)}</td><td>${esc(r.plan)}</td></tr>`,
    )
    .join('');
  return page(
    `${opts.brand} - Customers`,
    `<div class="top"><strong>${esc(opts.brand)}</strong><span><a href="${esc(opts.mount)}/panel">Customers</a><a href="${esc(opts.mount)}">Sign out</a></span></div>` +
      `<div class="wrap"><h1>Customers</h1><p class="sub">${esc(opts.rows.length)} accounts</p>` +
      (opts.withExport
        ? `<p><a class="btn" href="${esc(opts.mount)}/export">Export customers</a></p>`
        : '') +
      `<table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Company</th><th>Plan</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  );
}

export function exportPage(opts: { brand: string; mount: string; count: number }): string {
  return page(
    `${opts.brand} - Export customers`,
    `<div class="top"><strong>${esc(opts.brand)}</strong><span><a href="${esc(opts.mount)}/panel">Customers</a></span></div>` +
      `<div class="wrap"><h1>Export customers</h1><p class="sub">Your export is ready: ${esc(opts.count)} records, CSV, generated just now.</p>` +
      `<p><a class="btn" href="${esc(opts.mount)}/export.csv">Download customers.csv</a></p></div>`,
  );
}

const csvCell = (v: unknown): string => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function customersCsv(rows: CanaryRow[]): string {
  const head = 'id,name,email,phone,company,plan,card_last4';
  const body = rows.map((r) =>
    [r.id, r.name, r.email, r.phone, r.company, r.plan, r.card_last4].map(csvCell).join(','),
  );
  return `${[head, ...body].join('\n')}\n`;
}

export interface BaitContext {
  decoys: WebDecoysFile;
  honeytokens: HoneytokenSet;
  breadcrumbs: boolean;
  /** Ids of the honeytokens embedded in the rendered text (reported with the log line). */
  used: string[];
}

export function dotenv(ctx: BaitContext): string {
  const service = ctx.decoys.service ?? 'app';
  const api = ctx.honeytokens.tokens.find((t) => t.kind === 'api_key');
  const db = ctx.honeytokens.tokens.find((t) => t.kind === 'db_url');
  const lines = [
    `APP_NAME=${service}`,
    'APP_ENV=production',
    'APP_DEBUG=false',
    'APP_KEY=base64:VGhpcyBpcyBub3QgYSByZWFsIGtleSBhdCBhbGwhISE=',
    'LOG_LEVEL=warning',
    '',
  ];
  if (db) {
    lines.push(`DATABASE_URL=${db.value}`, '');
    ctx.used.push(db.id);
  }
  if (api) {
    lines.push(
      `${api.prefix ? `${api.prefix.replace(/_+$/, '').toUpperCase()}_API_KEY` : 'API_KEY'}=${api.value}`,
      '',
    );
    ctx.used.push(api.id);
  }
  const ssh = ctx.decoys.breadcrumbs?.ssh;
  if (ctx.breadcrumbs && ssh) {
    lines.push(
      '# nightly backup shuttle (do not remove)',
      `SSH_HOST=${ssh.host}`,
      `SSH_PORT=${ssh.port}`,
      `SSH_USER=${ctx.honeytokens.credentials.ssh.user}`,
      `SSH_PASSWORD=${ctx.honeytokens.credentials.ssh.password}`,
      '',
    );
  }
  const admin = ctx.decoys.breadcrumbs?.adminMount;
  if (ctx.breadcrumbs && admin) lines.push(`ADMIN_PATH=${admin}`, '');
  return `${lines.join('\n')}\n`;
}

export function sqlDump(ctx: BaitContext): string {
  const service = ctx.decoys.service ?? 'app';
  const ssh = ctx.decoys.breadcrumbs?.ssh;
  const rows = ctx.honeytokens.canary.rows;
  const db = ctx.honeytokens.tokens.find((t) => t.kind === 'db_url');
  if (db) ctx.used.push(db.id);
  const q = (v: unknown): string => `'${String(v).replace(/'/g, "''")}'`;
  const out = [
    '--',
    '-- PostgreSQL database dump',
    '--',
    '',
    '-- Dumped from database version 14.9 (Debian 14.9-1.pgdg110+1)',
    '-- Dumped by pg_dump version 14.9',
    `-- Host: ${ssh?.host ?? 'db-01'}  Database: ${service}_prod`,
    ctx.breadcrumbs && ssh ? `-- Copied to ${ssh.host}:/srv/backups by ${ssh.user}` : '',
    '',
    'SET statement_timeout = 0;',
    "SET client_encoding = 'UTF8';",
    '',
    'CREATE TABLE public.customers (',
    '    id integer NOT NULL,',
    '    name text,',
    '    email text,',
    '    phone text,',
    '    company text,',
    '    plan text,',
    '    card_last4 character(4)',
    ');',
    '',
    ...rows.map(
      (r) =>
        `INSERT INTO public.customers VALUES (${r.id}, ${q(r.name)}, ${q(r.email)}, ${q(r.phone)}, ${q(r.company)}, ${q(r.plan)}, ${q(r.card_last4)});`,
    ),
    '',
    '-- Dump complete',
    '',
  ];
  return out.join('\n');
}

export function gitConfig(ctx: BaitContext): string {
  const service = ctx.decoys.service ?? 'app';
  const ssh = ctx.decoys.breadcrumbs?.ssh;
  return [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = true',
    '\tbare = false',
    '[remote "origin"]',
    `\turl = git@github.com:internal-platform/${service}.git`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '[branch "main"]',
    '\tremote = origin',
    '\tmerge = refs/heads/main',
    ctx.breadcrumbs && ssh
      ? `# deploy hook: ssh ${ssh.user}@${ssh.host} -p ${ssh.port} ./deploy.sh`
      : '',
    '',
  ].join('\n');
}

export function wpLogin(action: string, error: boolean): string {
  return page(
    'Log In - WordPress',
    `<div class="card"><h1>WordPress</h1><p class="sub">Log in to continue</p>${error ? '<div class="err"><strong>Error:</strong> The username or password you entered is incorrect.</div>' : ''}` +
      `<form method="post" action="${esc(action)}"><label for="l">Username or Email Address</label><input id="l" name="log" type="text">` +
      '<label for="w">Password</label><input id="w" name="pwd" type="password"><button type="submit">Log In</button></form></div>',
  );
}

export function phpmyadminLogin(action: string, error: boolean): string {
  return page(
    'phpMyAdmin',
    `<div class="card"><h1>phpMyAdmin</h1><p class="sub">Welcome to phpMyAdmin</p>${error ? '<div class="err">Access denied for user.</div>' : ''}` +
      `<form method="post" action="${esc(action)}"><label for="u">Username</label><input id="u" name="pma_username" type="text">` +
      '<label for="p">Password</label><input id="p" name="pma_password" type="password"><button type="submit">Go</button></form></div>',
  );
}

export const NOT_FOUND = page(
  '404 Not Found',
  '<div class="card"><h1>404</h1><p class="sub">The requested page could not be found.</p></div>',
);
