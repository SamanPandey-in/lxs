import type { BaitValues } from './config.js';

/**
 * Second-order static assets: the stylesheets, scripts and images a scanner (or a browser) fetches
 * right after a decoy page answers. Small plausible stubs, written for LXS: selectors and file names
 * follow each product's layout, the rules themselves are minimal and no vendor file is copied.
 *
 * Keys are paths relative to the skin's base (the admin mount, the WordPress root, the phpMyAdmin
 * directory, the .git directory). Values are rendered per build (versions, build hash).
 */
export interface StaticAsset {
  type: string;
  body: string | Buffer;
  /** Override Cache-Control (hashed admin assets are immutable). */
  cache?: string;
}

/** 1x1 transparent GIF. */
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** A valid 1x1, 32-bit .ico (header + directory entry + BITMAPINFOHEADER + one pixel + AND mask). */
function icon(rgba: [number, number, number, number]): Buffer {
  const b = Buffer.alloc(70);
  b.writeUInt16LE(0, 0); // reserved
  b.writeUInt16LE(1, 2); // type: icon
  b.writeUInt16LE(1, 4); // count
  b.writeUInt8(1, 6); // width
  b.writeUInt8(1, 7); // height
  b.writeUInt16LE(1, 10); // planes
  b.writeUInt16LE(32, 12); // bpp
  b.writeUInt32LE(48, 14); // bytes in resource
  b.writeUInt32LE(22, 18); // offset
  b.writeUInt32LE(40, 22); // BITMAPINFOHEADER size
  b.writeInt32LE(1, 26); // width
  b.writeInt32LE(2, 30); // height (XOR + AND)
  b.writeUInt16LE(1, 34); // planes
  b.writeUInt16LE(32, 36); // bpp
  const [r, g, bl, a] = rgba;
  b.writeUInt8(bl, 62);
  b.writeUInt8(g, 63);
  b.writeUInt8(r, 64);
  b.writeUInt8(a, 65);
  return b;
}

const JQUERY_STUB = (v: string): string =>
  `/*! jQuery v${v} | MIT License */\n!function(e,t){"use strict";var n=function(r){return new n.fn.init(r)};n.fn=n.prototype={jquery:"${v}",init:function(r){this.length=0;if(typeof r==="function")t.addEventListener("DOMContentLoaded",r);return this},ready:function(r){t.addEventListener("DOMContentLoaded",r);return this}};n.fn.init.prototype=n.fn;e.jQuery=e.$=n}(window,document);\n`;

const ADMIN_CSS = `:root{--bg:#f4f6f9;--panel:#fff;--line:#e3e8ee;--text:#1a2433;--muted:#6b7785;--brand:#3b5bdb;--brand-dark:#2f4ac0;--danger:#c92a2a}
*,*::before,*::after{box-sizing:border-box}html{font-size:14px}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
.auth{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.auth-card{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:32px 28px;box-shadow:0 10px 30px rgba(16,24,40,.06)}
.auth-brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;margin-bottom:20px}
.auth-mark{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--brand);color:#fff;font-weight:700}
.auth-title{font-size:20px;margin:0 0 18px;font-weight:600}.auth-foot{margin:18px 0 0;text-align:center;font-size:13px}.auth-copy{margin-top:20px;color:var(--muted);font-size:12px}
.field{margin-bottom:14px}.field label{display:block;font-weight:500;margin-bottom:6px}
.field input{width:100%;height:38px;padding:0 12px;border:1px solid #cfd6de;border-radius:8px;font:inherit;background:#fff}.field input:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(59,91,219,.15)}
.check{display:flex;align-items:center;gap:8px;margin:4px 0 18px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:38px;padding:0 16px;border-radius:8px;border:1px solid transparent;font:inherit;font-weight:600;cursor:pointer}
.btn-primary{background:var(--brand);color:#fff}.btn-primary:hover{background:var(--brand-dark);text-decoration:none}.btn-block{width:100%}
.alert{padding:10px 12px;border-radius:8px;margin-bottom:14px;font-size:13px}.alert-error{background:#fff5f5;border:1px solid #ffc9c9;color:var(--danger)}
.layout{display:flex;min-height:100vh}.sidebar{width:232px;background:#111827;color:#cbd2dc;padding:18px 14px;flex-shrink:0}
.sidebar-brand{display:flex;align-items:center;gap:10px;color:#fff;font-weight:600;margin:0 6px 22px}
.sidebar-nav a{display:block;padding:8px 10px;border-radius:6px;color:#cbd2dc}.sidebar-nav a.active,.sidebar-nav a:hover{background:#1f2937;color:#fff;text-decoration:none}
.main{flex:1;min-width:0}.topbar{display:flex;align-items:center;justify-content:space-between;height:60px;padding:0 28px;background:var(--panel);border-bottom:1px solid var(--line)}
.topbar h1{font-size:18px;margin:0}.content{padding:24px 28px}.toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.muted{color:var(--muted)}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}.card-pad{padding:22px}.card h2{margin:0 0 6px;font-size:16px}
.table{width:100%;border-collapse:collapse}.table th,.table td{padding:10px 14px;border-bottom:1px solid var(--line);text-align:left}
.table th{background:#f9fafb;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#edf2ff;color:var(--brand);font-size:12px;font-weight:600}
`;

const ADMIN_JS = (build: string): string =>
  `/* app.${build}.js */\n(function(){"use strict";var t=document.querySelector('meta[name="csrf-token"]');document.addEventListener("submit",function(e){var f=e.target;if(t&&f&&f.querySelector&&!f.querySelector('input[name="_token"]')){var i=document.createElement("input");i.type="hidden";i.name="_token";i.value=t.getAttribute("content")||"";f.appendChild(i)}var b=f&&f.querySelector&&f.querySelector('button[type="submit"]');if(b){b.disabled=true}},true)})();\n`;

const WP_LOGIN_CSS = `body.login{background:#f0f0f1;min-width:0;color:#3c434a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;font-size:13px;line-height:1.4}
#login{width:320px;padding:8% 0 0;margin:auto}
.login h1{text-align:center}.login h1 a{display:block;width:84px;height:84px;margin:0 auto 25px;border-radius:50%;background:#3c434a;overflow:hidden;text-indent:-9999px;outline:0}
.login form{margin-top:20px;margin-left:0;padding:26px 24px 34px;font-weight:400;overflow:hidden;background:#fff;border:1px solid #c3c4c7;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.login label{font-size:14px;line-height:1.5;display:inline-block;margin-bottom:3px}
.login form .input,.login input[type=text],.login input[type=password]{font-size:24px;line-height:1.33;width:100%;border-width:.0625rem;padding:.1875rem .3125rem;margin:0 6px 16px 0;min-height:40px;max-height:none;background:#fff;border:1px solid #8c8f94;border-radius:4px}
.login .forgetmenot{font-weight:400;float:left;margin-bottom:0}.login .button-primary{float:right}
#login_error,.login .message{border-left:4px solid #d63638;padding:12px;margin-left:0;margin-bottom:20px;background-color:#fff;box-shadow:0 1px 1px 0 rgba(0,0,0,.1);word-wrap:break-word}
.login #nav,.login #backtoblog{font-size:13px;padding:0 24px;margin:24px 0 0}.login #nav a,.login #backtoblog a{text-decoration:none;color:#50575e}
`;

const WP_BUTTONS_CSS = `.wp-core-ui .button,.wp-core-ui .button-primary,.wp-core-ui .button-secondary{display:inline-block;text-decoration:none;font-size:13px;line-height:2.15384615;min-height:30px;margin:0;padding:0 10px;cursor:pointer;border-width:1px;border-style:solid;border-radius:3px;white-space:nowrap;box-sizing:border-box}
.wp-core-ui .button-primary{background:#2271b1;border-color:#2271b1;color:#fff;text-shadow:none}.wp-core-ui .button-primary:hover{background:#135e96;border-color:#135e96;color:#fff}
.wp-core-ui .button.button-large{min-height:32px;line-height:2.30769231;padding:0 12px}
`;

const WP_DASHICONS_CSS = `.dashicons,.dashicons-before:before{font-family:dashicons;display:inline-block;line-height:1;font-weight:400;font-style:normal;speak:never;text-decoration:inherit;text-transform:none;text-rendering:auto;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;width:20px;height:20px;font-size:20px;vertical-align:top;text-align:center;transition:color .1s ease-in}
`;

const PMA_THEME_CSS = `body{font-family:sans-serif;padding:0;margin:0;margin-left:240px;color:#444;background:#fff;font-size:82%}
body#loginform{margin:0}body#loginform .container{text-align:center;max-width:500px;margin:0 auto;padding-top:2em}
body#loginform h1{color:#444;font-size:1.7em;font-weight:400;margin:.6em 0 .8em}
.pma-fieldset{margin-top:1em;border-radius:4px 4px 0 0;border:#aaa solid 1px;padding:.5em;background:#eee;text-shadow:1px 1px 2px #fff inset;text-align:left}
.pma-fieldset legend{font-weight:700;color:#444;padding:5px 10px;border-radius:2px;border:1px solid #aaa;background-color:#fff;width:initial;font-size:1em;float:none}
.pma-fieldset.tblFooters{margin-top:0;margin-bottom:.5em;border-top:0;text-align:right;float:none;clear:both;border-radius:0 0 4px 4px}
#login_form .item{margin-bottom:.5em}#login_form label{width:10em;font-weight:700}#login_form input[type=text],#login_form input[type=password]{padding:.3em;border:1px solid #aaa;border-radius:2px;width:14em}
.btn-primary{color:#111;background:linear-gradient(#fff,#ccc);border:1px solid #aaa;border-radius:4px;padding:3px 7px;cursor:pointer;font-weight:700}
.alert-danger{color:#000;background:#fce4e4;border:1px solid #c00;border-radius:4px;padding:.5em;margin:.5em 0;text-align:left}
.icon{margin:0 .3em;width:16px;height:16px;vertical-align:-3px}.hide{display:none}
`;

const PMA_ROBOTS = 'User-agent: *\nDisallow: /\n';

const GIT_DESCRIPTION =
  "Unnamed repository; edit this file 'description' to name the repository.\n";
const GIT_EXCLUDE =
  "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to use them):\n# *.[oa]\n# *~\n";

const WP_README = (v: string): string =>
  `<!DOCTYPE html>
<html lang="en">
<head>
	<meta name="viewport" content="width=device-width" />
	<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
	<title>WordPress &#8250; ReadMe</title>
	<link rel="stylesheet" href="wp-admin/css/install.css?ver=${v}" type="text/css" />
</head>
<body>
<h1 id="logo">WordPress</h1>
<h2>Getting started</h2>
<p>Upload the files to your web server, create a database and a database user, then open the installer and follow the steps.</p>
<h2>Installation</h2>
<ol>
	<li>Unpack the archive into an empty directory and upload it.</li>
	<li>Open <span class="file"><a href="wp-admin/install.php">wp-admin/install.php</a></span> in a browser.</li>
</ol>
<h2>Requirements</h2>
<ul>
	<li>PHP <strong>7.0</strong> or newer.</li>
	<li>MySQL <strong>5.0.15</strong> or newer, or MariaDB.</li>
</ul>
</body>
</html>
`;

export type AssetSkin = 'admin' | 'wordpress' | 'phpmyadmin' | 'git';

/** The asset table for one skin, rendered for this build. */
export function assetTable(skin: AssetSkin, bait: BaitValues): Record<string, StaticAsset> {
  const css = 'text/css';
  const js = 'application/javascript';
  switch (skin) {
    case 'admin': {
      const immutable = 'public, max-age=31536000, immutable';
      return {
        [`/assets/css/app.${bait.asset_build}.css`]: {
          type: css,
          body: ADMIN_CSS,
          cache: immutable,
        },
        [`/assets/js/app.${bait.asset_build}.js`]: {
          type: js,
          body: ADMIN_JS(bait.asset_build),
          cache: immutable,
        },
        '/favicon.ico': { type: 'image/x-icon', body: icon([59, 91, 219, 255]) },
      };
    }
    case 'wordpress':
      return {
        '/wp-admin/css/login.min.css': { type: css, body: WP_LOGIN_CSS },
        '/wp-includes/css/buttons.min.css': { type: css, body: WP_BUTTONS_CSS },
        '/wp-includes/css/dashicons.min.css': { type: css, body: WP_DASHICONS_CSS },
        '/wp-includes/js/jquery/jquery.min.js': { type: js, body: JQUERY_STUB('3.7.1') },
        '/wp-includes/images/spinner.gif': { type: 'image/gif', body: GIF_1X1 },
        '/readme.html': { type: 'text/html', body: WP_README(bait.versions.wordpress) },
        // wp-content/index.php: "Silence is golden." An empty 200.
        '/wp-content': { type: 'text/html; charset=UTF-8', body: '' },
      };
    case 'phpmyadmin':
      return {
        '/themes/pmahomme/css/theme.css': { type: css, body: PMA_THEME_CSS },
        '/js/vendor/jquery/jquery.min.js': { type: js, body: JQUERY_STUB('3.6.4') },
        '/themes/dot.gif': { type: 'image/gif', body: GIF_1X1 },
        '/favicon.ico': { type: 'image/x-icon', body: icon([255, 153, 0, 255]) },
        '/robots.txt': { type: 'text/plain', body: PMA_ROBOTS },
      };
    case 'git':
      return {
        '/HEAD': { type: 'application/octet-stream', body: `ref: refs/heads/${bait.git.branch}\n` },
        '/description': { type: 'application/octet-stream', body: GIT_DESCRIPTION },
        '/info/exclude': { type: 'application/octet-stream', body: GIT_EXCLUDE },
      };
    default:
      return {};
  }
}

/** nginx-style validators for a static file: Last-Modified, ETag "<mtime hex>-<length hex>". */
export function staticHeaders(body: string | Buffer, bait: BaitValues): Record<string, string> {
  const len = Buffer.byteLength(body);
  const t = Date.parse(bait.assets_modified);
  const mtime = Number.isNaN(t) ? 0 : Math.floor(t / 1000);
  return {
    'last-modified': bait.assets_modified,
    etag: `"${mtime.toString(16)}-${len.toString(16)}"`,
    'accept-ranges': 'bytes',
  };
}
