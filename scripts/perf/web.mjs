// Measure what the analyst actually feels: route navigation timings in a real browser.
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://localhost:3000';
const INC = process.argv[3];

const routes = [
  ['/', 'Overview'],
  ['/incidents', 'Queue'],
  [`/incidents/${INC}`, 'Incident hero'],
  ['/feed', 'Live feed'],
  ['/attackers', 'Attackers'],
  ['/attack', 'ATT&CK matrix'],
  ['/decoys', 'Decoys'],
  ['/audit', 'Audit'],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});

console.log(`${BASE}`);
console.log('route                 TTFB     DOMready      LCP   transferred   requests');
console.log('--------------------------------------------------------------------------');

for (const [path, name] of routes) {
  const page = await browser.newPage();
  let transferred = 0;
  let requests = 0;
  page.on('response', async (r) => {
    requests++;
    try {
      const len = Number(r.headers()['content-length'] ?? 0);
      transferred += len;
    } catch {}
  });
  const t0 = Date.now();
  await page.goto(BASE + path, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const lcp = performance.getEntriesByType('largest-contentful-paint').pop();
    return {
      ttfb: n ? n.responseStart - n.requestStart : null,
      dom: n ? n.domContentLoadedEventEnd : null,
      load: n ? n.loadEventEnd : null,
      lcp: lcp ? lcp.startTime : null,
    };
  });
  const wall = Date.now() - t0;
  const f = (v) => (v == null ? '    -' : `${Math.round(v)}`.padStart(5));
  console.log(
    `${name.padEnd(18)} ${f(nav.ttfb)}ms ${f(nav.dom)}ms ${f(nav.lcp)}ms ` +
      `${(transferred / 1024).toFixed(0).padStart(7)}kb ${String(requests).padStart(8)}   (wall ${wall}ms)`,
  );
  await page.close();
}

// Second pass: warm navigation, which is what the analyst does after the first load.
console.log('\nwarm re-visit (same tab, client-side nav)');
const page = await browser.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
for (const [path, name] of routes.slice(1)) {
  const t = Date.now();
  await page.goto(BASE + path, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
  console.log(`  ${name.padEnd(18)} ${String(Date.now() - t).padStart(6)}ms`);
}
await browser.close();
