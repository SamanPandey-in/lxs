import type { BaitValues, CanaryRow, HoneytokenSet, WebDecoysFile } from './config.js';
import type { MintedToken } from './mint.js';

/**
 * Canned pages and bait files, one look per product (skin). Attacker input is never interpolated
 * here: the only dynamic values are trusted config (brand, mount, per-build bait values), generated
 * honeytokens and server-made nonces, and every dynamic value in HTML still goes through esc().
 *
 * Each skin is a plausible lookalike of a product's *structure* (element ids, class names, form field
 * names, asset paths, headers): the CSS and copy are written for LXS, and no vendor logo or stylesheet
 * is reproduced.
 */
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (v: unknown): string => String(v).replace(/[&<>"']/g, (c) => ESC[c] as string);

export type Skin = 'admin' | 'wordpress' | 'phpmyadmin' | 'nginx';

/** What every page renderer may use besides its own arguments. */
export interface PageEnv {
  bait: BaitValues;
  service: string;
  /** Unix ms (injected clock). */
  now: number;
  /** Fresh random hex per call (CSRF-style form tokens). */
  nonce: (bytes: number) => string;
}

const titleCase = (s: string): string =>
  s.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

/* ------------------------------------------------------------------------------------------ */
/* admin: a generic SaaS back office (the web-admin decoy)                                     */
/* ------------------------------------------------------------------------------------------ */

export const adminAsset = (mount: string, bait: BaitValues, kind: 'css' | 'js'): string =>
  `${mount}/assets/${kind}/app.${bait.asset_build}.${kind}`;

function adminDoc(opts: {
  title: string;
  mount: string;
  bodyClass: string;
  body: string;
  env: PageEnv;
}): string {
  const { mount, env } = opts;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <meta name="csrf-token" content="${esc(env.nonce(20))}">`,
    `    <title>${esc(opts.title)}</title>`,
    `    <link rel="icon" type="image/x-icon" href="${esc(mount)}/favicon.ico">`,
    `    <link rel="stylesheet" href="${esc(adminAsset(mount, env.bait, 'css'))}">`,
    '</head>',
    `<body class="${opts.bodyClass}">`,
    opts.body,
    `    <script src="${esc(adminAsset(mount, env.bait, 'js'))}" defer></script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function loginPage(
  opts: { brand: string; mount: string; action: string; error?: boolean; title?: string },
  env: PageEnv,
): string {
  const initial = esc(opts.brand.trim().charAt(0).toUpperCase() || 'A');
  const body = [
    '    <main class="auth">',
    '        <section class="auth-card">',
    `            <div class="auth-brand"><span class="auth-mark">${initial}</span>${esc(opts.brand)}</div>`,
    `            <h1 class="auth-title">${esc(opts.title ?? 'Sign in to your account')}</h1>`,
    opts.error
      ? '            <div class="alert alert-error" role="alert">These credentials do not match our records.</div>'
      : '',
    `            <form method="POST" action="${esc(opts.action)}" class="auth-form" autocomplete="off">`,
    `                <input type="hidden" name="_token" value="${esc(env.nonce(20))}">`,
    '                <div class="field">',
    '                    <label for="username">Email or username</label>',
    '                    <input id="username" name="username" type="text" required autofocus>',
    '                </div>',
    '                <div class="field">',
    '                    <label for="password">Password</label>',
    '                    <input id="password" name="password" type="password" required>',
    '                </div>',
    '                <label class="check"><input type="checkbox" name="remember"> Keep me signed in</label>',
    '                <button type="submit" class="btn btn-primary btn-block">Sign in</button>',
    '            </form>',
    `            <p class="auth-foot"><a href="${esc(opts.mount)}/password/reset">Forgot your password?</a></p>`,
    '        </section>',
    `        <footer class="auth-copy">&copy; ${new Date(env.now).getUTCFullYear()} ${esc(opts.brand)}</footer>`,
    '    </main>',
  ]
    .filter(Boolean)
    .join('\n');
  return adminDoc({
    title: `Sign in · ${opts.brand}`,
    mount: opts.mount,
    bodyClass: 'auth-page',
    body,
    env,
  });
}

function adminShell(
  opts: { brand: string; mount: string; heading: string; content: string },
  env: PageEnv,
): string {
  const m = esc(opts.mount);
  const body = [
    '    <div class="layout">',
    '        <aside class="sidebar">',
    `            <div class="sidebar-brand"><span class="auth-mark">${esc(opts.brand.charAt(0).toUpperCase() || 'A')}</span>${esc(opts.brand)}</div>`,
    '            <nav class="sidebar-nav">',
    `                <a href="${m}/panel">Dashboard</a>`,
    `                <a href="${m}/panel" class="active">Customers</a>`,
    `                <a href="${m}/export">Exports</a>`,
    `                <a href="${m}/settings">Settings</a>`,
    '            </nav>',
    '        </aside>',
    '        <div class="main">',
    `            <header class="topbar"><h1>${esc(opts.heading)}</h1><a class="topbar-link" href="${m}">Sign out</a></header>`,
    `            <div class="content">${opts.content}</div>`,
    '        </div>',
    '    </div>',
  ].join('\n');
  return adminDoc({
    title: `${opts.heading} · ${opts.brand}`,
    mount: opts.mount,
    bodyClass: 'app',
    body,
    env,
  });
}

export function panelPage(
  opts: { brand: string; mount: string; rows: CanaryRow[]; withExport: boolean },
  env: PageEnv,
): string {
  const rows = opts.rows
    .slice(0, 10)
    .map(
      (r) =>
        `<tr><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.company)}</td><td><span class="badge">${esc(r.plan)}</span></td></tr>`,
    )
    .join('');
  const content =
    `<div class="toolbar"><span class="muted">${esc(opts.rows.length)} accounts</span>` +
    (opts.withExport
      ? `<a class="btn btn-primary" href="${esc(opts.mount)}/export">Export customers</a>`
      : '') +
    '</div>' +
    `<div class="card"><table class="table"><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Company</th><th>Plan</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return adminShell({ brand: opts.brand, mount: opts.mount, heading: 'Customers', content }, env);
}

export function exportPage(
  opts: { brand: string; mount: string; count: number },
  env: PageEnv,
): string {
  const content =
    `<div class="card card-pad"><h2>Export customers</h2><p class="muted">Your export is ready: ${esc(opts.count)} records, CSV, generated just now.</p>` +
    `<a class="btn btn-primary" href="${esc(opts.mount)}/export.csv">Download customers.csv</a></div>`;
  return adminShell({ brand: opts.brand, mount: opts.mount, heading: 'Exports', content }, env);
}

/** A framework-style error page: big code, short message, nothing else. */
export function adminError(status: 404 | 403 | 405): string {
  const msg = status === 404 ? 'Not Found' : status === 403 ? 'Forbidden' : 'Method Not Allowed';
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '    <head>',
    '        <meta charset="utf-8">',
    '        <meta name="viewport" content="width=device-width, initial-scale=1">',
    `        <title>${msg}</title>`,
    '        <style>',
    '            body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7fafc;color:#a0aec0;-webkit-font-smoothing:antialiased}',
    '            .wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}',
    '            .code{padding:0 16px;border-right:1px solid #cbd5e0;font-size:18px;letter-spacing:.05em}',
    '            .msg{padding-left:16px;font-size:18px;text-transform:uppercase;letter-spacing:.05em}',
    '        </style>',
    '    </head>',
    '    <body>',
    `        <div class="wrap"><div class="code">${status}</div><div class="msg">${msg}</div></div>`,
    '    </body>',
    '</html>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------------------------------ */
/* wordpress: wp-login.php                                                                     */
/* ------------------------------------------------------------------------------------------ */

const wpAsset = (base: string, p: string, ver: string): string => `${base}${p}?ver=${ver}`;

export function wpLogin(
  opts: { base: string; action: string; error: boolean; site: string },
  env: PageEnv,
): string {
  const b = esc(opts.base);
  const site = esc(opts.site);
  const css = [
    ['dashicons-css', '/wp-includes/css/dashicons.min.css'],
    ['buttons-css', '/wp-includes/css/buttons.min.css'],
    ['login-css', '/wp-admin/css/login.min.css'],
  ]
    .map(
      ([id, p]) =>
        `<link rel='stylesheet' id='${id}' href='${esc(wpAsset(opts.base, p as string, env.bait.versions.wordpress))}' media='all' />`,
    )
    .join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en-US">',
    '<head>',
    '\t<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />',
    `\t<title>Log In &lsaquo; ${site} &#8212; WordPress</title>`,
    "\t<meta name='robots' content='max-image-preview:large, noindex, noarchive' />",
    css,
    `<script src='${b}/wp-includes/js/jquery/jquery.min.js?ver=3.7.1' id='jquery-core-js'></script>`,
    "\t<meta name='referrer' content='strict-origin-when-cross-origin' />",
    '\t<meta name="viewport" content="width=device-width" />',
    '\t</head>',
    '\t<body class="login no-js login-action-login wp-core-ui  locale-en-us">',
    '\t<div id="login">',
    `\t\t<h1><a href="${b}/">${site}</a></h1>`,
    opts.error
      ? `\t<div id="login_error" class="notice notice-error"><p><strong>Error:</strong> The username or password you entered is incorrect. <a href="${b}/wp-login.php?action=lostpassword">Lost your password?</a></p></div>`
      : '',
    `\t\t<form name="loginform" id="loginform" action="${esc(opts.action)}" method="post">`,
    '\t\t\t<p>',
    '\t\t\t\t<label for="user_login">Username or Email Address</label>',
    '\t\t\t\t<input type="text" name="log" id="user_login" class="input" value="" size="20" autocapitalize="off" autocomplete="username" required="required" />',
    '\t\t\t</p>',
    '\t\t\t<div class="user-pass-wrap">',
    '\t\t\t\t<label for="user_pass">Password</label>',
    '\t\t\t\t<div class="wp-pwd">',
    '\t\t\t\t\t<input type="password" name="pwd" id="user_pass" class="input password-input" value="" size="20" autocomplete="current-password" spellcheck="false" required="required" />',
    '\t\t\t\t</div>',
    '\t\t\t</div>',
    '\t\t\t<p class="forgetmenot"><input name="rememberme" type="checkbox" id="rememberme" value="forever"  /> <label for="rememberme">Remember Me</label></p>',
    '\t\t\t<p class="submit">',
    '\t\t\t\t<input type="submit" name="wp-submit" id="wp-submit" class="button button-primary button-large" value="Log In" />',
    `\t\t\t\t<input type="hidden" name="redirect_to" value="${b}/wp-admin/" />`,
    '\t\t\t\t<input type="hidden" name="testcookie" value="1" />',
    '\t\t\t</p>',
    '\t\t</form>',
    `\t\t\t<p id="nav"><a href="${b}/wp-login.php?action=lostpassword">Lost your password?</a></p>`,
    `\t\t<p id="backtoblog"><a href="${b}/">&larr; Go to ${site}</a></p>`,
    '\t</div>',
    '\t</body>',
    '</html>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** A theme-style 404 (WordPress answers unknown paths under its root with the theme, not the server). */
export function wp404(opts: { base: string; site: string }, env: PageEnv): string {
  const b = esc(opts.base);
  const site = esc(opts.site);
  return [
    '<!doctype html>',
    '<html lang="en-US">',
    '<head>',
    '\t<meta charset="UTF-8" />',
    '\t<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `\t<title>Page not found &#8211; ${site}</title>`,
    "<meta name='robots' content='max-image-preview:large' />",
    `<link rel='stylesheet' id='wp-block-library-css' href='${b}/wp-includes/css/dist/block-library/style.min.css?ver=${esc(env.bait.versions.wordpress)}' media='all' />`,
    '</head>',
    '<body class="error404 wp-embed-responsive">',
    '<div class="wp-site-blocks">',
    `<header class="wp-block-template-part"><p class="wp-block-site-title"><a href="${b}/" rel="home">${site}</a></p></header>`,
    '<main class="wp-block-group">',
    '<h1 class="wp-block-heading">Page Not Found</h1>',
    '<p>The page you are looking for does not exist, or it has been moved. Please try searching using the form below.</p>',
    `<form role="search" method="get" action="${b}/" class="wp-block-search"><label class="screen-reader-text" for="s">Search</label><input type="search" id="s" name="s" value="" placeholder="Search..." required /><button type="submit">Search</button></form>`,
    '</main>',
    `<footer class="wp-block-template-part"><p class="has-small-font-size">Proudly powered by WordPress</p></footer>`,
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------------------------------ */
/* phpmyadmin: index.php login                                                                 */
/* ------------------------------------------------------------------------------------------ */

export function phpmyadminLogin(
  opts: { base: string; action: string; error: boolean },
  env: PageEnv,
): string {
  const v = esc(env.bait.versions.phpmyadmin);
  const token = esc(env.nonce(16));
  return [
    '<!DOCTYPE HTML>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="referrer" content="no-referrer">',
    '  <meta name="robots" content="noindex,nofollow,notranslate">',
    '  <meta name="google" content="notranslate">',
    '  <style id="cfs-style">html{display: none;}</style>',
    `  <link rel="icon" href="favicon.ico" type="image/x-icon">`,
    `  <link rel="stylesheet" type="text/css" href="./themes/pmahomme/css/theme.css?v=${v}">`,
    '  <title>phpMyAdmin</title>',
    `  <script src="js/vendor/jquery/jquery.min.js?v=${v}"></script>`,
    '</head>',
    '<body id="loginform">',
    '<div id="page_content">',
    '<div class="container">',
    '<div class="row">',
    '<div class="col-12">',
    '<h1>Welcome to <bdo dir="ltr" lang="en">phpMyAdmin</bdo></h1>',
    '<noscript><div class="alert alert-danger" role="alert">Javascript must be enabled past this point!</div></noscript>',
    opts.error
      ? '<div class="alert alert-danger" role="alert"><img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> Cannot log in to the MySQL server</div>'
      : '',
    `<form method="post" id="login_form" action="${esc(opts.action)}" name="login_form" class="disableAjax js-show">`,
    '<fieldset class="pma-fieldset">',
    '<legend><input type="hidden" name="set_session" value="">Log in</legend>',
    '<div class="item row">',
    '<label for="input_username" class="col-form-label col-4">Username:</label>',
    '<input type="text" name="pma_username" id="input_username" value="" class="form-control col-8" autocomplete="username" spellcheck="false" autofocus>',
    '</div>',
    '<div class="item row">',
    '<label for="input_password" class="col-form-label col-4">Password:</label>',
    '<input type="password" name="pma_password" id="input_password" value="" class="form-control col-8" autocomplete="current-password" spellcheck="false">',
    '</div>',
    '<input type="hidden" name="server" value="1">',
    '</fieldset>',
    '<fieldset class="pma-fieldset tblFooters">',
    '<input class="btn btn-primary" value="Go" type="submit" id="input_go">',
    '<input type="hidden" name="route" value="/">',
    `<input type="hidden" name="token" value="${token}">`,
    '</fieldset>',
    '</form>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/* ------------------------------------------------------------------------------------------ */
/* server error pages                                                                          */
/* ------------------------------------------------------------------------------------------ */

const NGINX_REASON: Record<number, string> = {
  403: '403 Forbidden',
  404: '404 Not Found',
  405: '405 Not Allowed',
};

/** nginx's built-in error page shape (CRLF line ends, version in the footer). */
export function nginxError(status: 403 | 404 | 405, bait: BaitValues): string {
  const r = NGINX_REASON[status] as string;
  return `<html>\r\n<head><title>${r}</title></head>\r\n<body>\r\n<center><h1>${r}</h1></center>\r\n<hr><center>nginx/${esc(bait.versions.nginx)}</center>\r\n</body>\r\n</html>\r\n`;
}

/** Apache httpd's built-in error page shape (phpMyAdmin is usually served by Apache + mod_php). */
export function apacheError(status: 403 | 404, bait: BaitValues): string {
  const title = status === 404 ? '404 Not Found' : '403 Forbidden';
  const h1 = status === 404 ? 'Not Found' : 'Forbidden';
  const p =
    status === 404
      ? 'The requested URL was not found on this server.'
      : "You don't have permission to access this resource.";
  return `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>${title}</title>\n</head><body>\n<h1>${h1}</h1>\n<p>${p}</p>\n<hr>\n<address>Apache/${esc(bait.versions.apache)} Server at ${esc(bait.hosts.app)} Port 80</address>\n</body></html>\n`;
}

/* ------------------------------------------------------------------------------------------ */
/* bait files                                                                                  */
/* ------------------------------------------------------------------------------------------ */

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
  bait: BaitValues;
  breadcrumbs: boolean;
  /** Ids of the honeytokens embedded in the rendered text (reported with the log line). */
  used: string[];
  /**
   * Per-visitor minting for the API-key honeytoken. Absent (no mint secret, or minting disabled):
   * the static per-deployment token is served, exactly as before.
   */
  mint?: (base: { id: string; prefix?: string }) => MintedToken;
  /** Tokens minted while rendering (logged as `mint` lines by the server). */
  minted: MintedToken[];
}

interface DbParts {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
}

function dbParts(url: string): DbParts | null {
  const m = /^postgres(?:ql)?:\/\/([^:@/]+):([^@/]*)@([^:/]+)(?::(\d+))?\/([^?]+)/.exec(url);
  if (!m) return null;
  let password = m[2] as string;
  try {
    password = decodeURIComponent(password);
  } catch {
    /* keep raw */
  }
  return {
    user: m[1] as string,
    password,
    host: m[3] as string,
    port: m[4] ?? '5432',
    database: m[5] as string,
  };
}

/** The API-key token for this render: minted per visitor when possible, the static one otherwise. */
function apiToken(ctx: BaitContext): { id: string; value: string; prefix?: string } | undefined {
  const api = ctx.honeytokens.tokens.find((t) => t.kind === 'api_key');
  if (!api) return undefined;
  ctx.used.push(api.id);
  if (!ctx.mint) return api;
  const m = ctx.mint(api);
  ctx.minted.push(m);
  return { id: api.id, value: m.value, ...(api.prefix ? { prefix: api.prefix } : {}) };
}

export function dotenv(ctx: BaitContext): string {
  const service = ctx.decoys.service ?? 'app';
  const db = ctx.honeytokens.tokens.find((t) => t.kind === 'db_url');
  const lines = [
    `APP_NAME=${titleCase(service).replace(/\s+/g, '')}`,
    'APP_ENV=production',
    `APP_KEY=${ctx.bait.app_key}`,
    'APP_DEBUG=false',
    `APP_URL=https://${service}.internal`,
    '',
    'LOG_CHANNEL=stack',
    'LOG_LEVEL=warning',
    '',
  ];
  if (db) {
    const p = dbParts(db.value);
    if (p) {
      lines.push(
        'DB_CONNECTION=pgsql',
        `DB_HOST=${p.host}`,
        `DB_PORT=${p.port}`,
        `DB_DATABASE=${p.database}`,
        `DB_USERNAME=${p.user}`,
        `DB_PASSWORD=${p.password}`,
      );
    }
    lines.push(`DATABASE_URL=${db.value}`, '');
    ctx.used.push(db.id);
  }
  lines.push(
    'CACHE_DRIVER=redis',
    'SESSION_DRIVER=redis',
    'QUEUE_CONNECTION=redis',
    'REDIS_HOST=127.0.0.1',
    'REDIS_PASSWORD=null',
    'REDIS_PORT=6379',
    '',
  );
  const api = apiToken(ctx);
  if (api) {
    lines.push(
      `${api.prefix ? `${api.prefix.replace(/_+$/, '').toUpperCase()}_API_KEY` : 'API_KEY'}=${api.value}`,
      '',
    );
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

/** "2026-01-12T02:14:37Z" -> "2026-01-12 02:14:37 UTC" (pg_dump --verbose style). */
const pgTime = (iso: string, plusSeconds = 0): string => {
  const t = Date.parse(iso);
  const d = new Date((Number.isNaN(t) ? 0 : t) + plusSeconds * 1000);
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
};

export function sqlDump(ctx: BaitContext): string {
  const service = ctx.decoys.service ?? 'app';
  const ssh = ctx.decoys.breadcrumbs?.ssh;
  const rows = ctx.honeytokens.canary.rows;
  const db = ctx.honeytokens.tokens.find((t) => t.kind === 'db_url');
  if (db) ctx.used.push(db.id);
  const owner = (db && dbParts(db.value)?.user) || service;
  const q = (v: unknown): string => `'${String(v).replace(/'/g, "''")}'`;
  const out = [
    ctx.breadcrumbs && ssh
      ? `-- ${service}_prod nightly backup; shuttled to ${ssh.user}@${ssh.host}:/srv/backups`
      : '',
    '--',
    '-- PostgreSQL database dump',
    '--',
    '',
    `-- Dumped from database version ${ctx.bait.postgres.server}`,
    `-- Dumped by pg_dump version ${ctx.bait.postgres.dump}`,
    '',
    `-- Started on ${pgTime(ctx.bait.dumped_at)}`,
    '',
    'SET statement_timeout = 0;',
    'SET lock_timeout = 0;',
    'SET idle_in_transaction_session_timeout = 0;',
    "SET client_encoding = 'UTF8';",
    'SET standard_conforming_strings = on;',
    "SELECT pg_catalog.set_config('search_path', '', false);",
    'SET check_function_bodies = false;',
    'SET xmloption = content;',
    'SET client_min_messages = warning;',
    'SET row_security = off;',
    '',
    "SET default_tablespace = '';",
    '',
    'SET default_table_access_method = heap;',
    '',
    '--',
    `-- Name: customers; Type: TABLE; Schema: public; Owner: ${owner}`,
    '--',
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
    '',
    `ALTER TABLE public.customers OWNER TO ${owner};`,
    '',
    '--',
    `-- Data for Name: customers; Type: TABLE DATA; Schema: public; Owner: ${owner}`,
    '--',
    '',
    ...rows.map(
      (r) =>
        `INSERT INTO public.customers VALUES (${r.id}, ${q(r.name)}, ${q(r.email)}, ${q(r.phone)}, ${q(r.company)}, ${q(r.plan)}, ${q(r.card_last4)});`,
    ),
    '',
    '',
    '--',
    `-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: ${owner}`,
    '--',
    '',
    'ALTER TABLE ONLY public.customers',
    '    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);',
    '',
    '',
    `-- Completed on ${pgTime(ctx.bait.dumped_at, 3 + rows.length)}`,
    '',
    '--',
    '-- PostgreSQL database dump complete',
    '--',
    '',
  ];
  return out.filter((l, i) => !(i === 0 && l === '')).join('\n');
}

export function gitConfig(ctx: BaitContext): string {
  const service = ctx.decoys.service ?? 'app';
  const ssh = ctx.decoys.breadcrumbs?.ssh;
  const branch = ctx.bait.git.branch;
  return [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = true',
    '[remote "origin"]',
    `\turl = git@github.com:${ctx.bait.git.org}/${service}.git`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    `[branch "${branch}"]`,
    '\tremote = origin',
    `\tmerge = refs/heads/${branch}`,
    ctx.breadcrumbs && ssh
      ? `# deploy hook: ssh ${ssh.user}@${ssh.host} -p ${ssh.port} ./deploy.sh`
      : '',
    '',
  ].join('\n');
}
