import type { Path, WebBaitTemplate } from './types.js';

/**
 * Second-order paths: what a scanner fetches right after a bait page answers (the stylesheet a login
 * page links to, `/.git/HEAD` after `/.git/config`, ...). They are routed to ds-web with the bait's
 * decoy id, so the decoy answers them consistently instead of the real app 404ing on all of them alike.
 * ds-web owns the content; this list only decides routing (and is written to .lxs/web-decoys.json).
 *
 * dotenv and sql-dump have none: a scanner's next guesses (`/.env.bak`, ...) are their own decoys.
 */
export function companionPaths(template: WebBaitTemplate, mount: Path): Path[] {
  const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));
  switch (template) {
    case 'wp-login': {
      const base = dirOf(mount);
      return [
        `${base}/wp-admin`,
        `${base}/wp-admin/css/login.min.css`,
        `${base}/wp-includes`,
        `${base}/wp-includes/css/buttons.min.css`,
        `${base}/wp-includes/css/dashicons.min.css`,
        `${base}/wp-includes/js/jquery/jquery.min.js`,
        `${base}/wp-includes/images/spinner.gif`,
        `${base}/wp-content`,
        `${base}/readme.html`,
        `${base}/xmlrpc.php`,
      ] as Path[];
    }
    case 'phpmyadmin': {
      const base = mount.endsWith('.php') ? dirOf(mount) : mount;
      return [
        `${base}/index.php`,
        `${base}/favicon.ico`,
        `${base}/robots.txt`,
        `${base}/themes/dot.gif`,
        `${base}/themes/pmahomme/css/theme.css`,
        `${base}/js/vendor/jquery/jquery.min.js`,
      ].filter((p) => p !== mount) as Path[];
    }
    case 'git-config': {
      const base = dirOf(mount);
      if (!base) return [];
      return [base, `${base}/HEAD`, `${base}/description`, `${base}/info/exclude`] as Path[];
    }
    default:
      return [];
  }
}
