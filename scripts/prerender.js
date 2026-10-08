// After the normal `vite build`, this opens every real URL on the site in an
// actual headless Chrome, waits for it to render exactly as a visitor would
// see it, and saves that as genuine static HTML in the matching folder --
// so a crawler hitting e.g. /europe/italy/spaghetti-carbonara gets real,
// already-rendered content instantly, instead of an empty JS shell.
//
// Deliberately fails soft: if anything here goes wrong -- Chrome won't
// launch, a dependency is missing, whatever -- this script logs it clearly
// and exits successfully anyway, so the normal (non-prerendered) build still
// deploys rather than the whole site going down over a prerendering problem.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const ROUTES_FILE = path.join(__dirname, 'routes.json');
const PORT = 4173;
const CONCURRENCY = 6;
const PAGE_TIMEOUT_MS = 20000;
const OVERALL_BUDGET_MS = 25 * 60 * 1000; // safety ceiling so this can never run away and eat the whole build

// Hosts the app itself needs in order to draw a page (the map's d3/topojson and world data).
// EVERYTHING else third-party is blocked while pre-rendering: otherwise each of the ~1,500
// page visits during a build would be counted by Google Analytics as a real visitor, and the
// cookie banner's own code would be captured into every saved page and then clash with the
// live one when a real visitor loads it.
const ALLOWED_HOSTS = new Set(['cdnjs.cloudflare.com', 'cdn.jsdelivr.net']);
const ORIGIN = `http://localhost:${PORT}`;
const SITE_URL = 'https://recipeatlas.co.uk';
// 1x1 transparent PNG. Images are answered instantly with this (the <img> tags and their real
// src URLs stay in the saved HTML) rather than downloading thousands of photos during a build.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml',
};

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      let filePath = path.join(DIST_DIR, urlPath);
      // SPA-style fallback for any path without a real file yet (matches
      // how the site behaves in production before prerendering fills it in)
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(DIST_DIR, 'index.html');
      }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(PORT, () => resolve(server));
  });
}

async function prerenderRoute(browser, route) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      let u;
      try { u = new URL(req.url()); } catch (e) { return req.continue(); }
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.origin === ORIGIN) return req.continue();
      if (ALLOWED_HOSTS.has(u.hostname)) return req.continue();
      if (req.resourceType() === 'image') return req.respond({ status: 200, contentType: 'image/png', body: TINY_PNG });
      return req.abort();
    });
    await page.goto(`http://localhost:${PORT}${route}`, {
      waitUntil: 'networkidle0',
      timeout: PAGE_TIMEOUT_MS,
    });
    // The site's own data (recipes, events, blog) is bundled in the JS and
    // renders synchronously; a short additional wait covers the dynamic
    // <title>/meta-description effect. Ratings/comments (Firebase) are
    // intentionally not waited on -- not needed for SEO content, and would
    // slow every single page down waiting on a network call.
    await new Promise(r => setTimeout(r, 400));
    // Remove what the cookie-banner stub injects at runtime. If these were saved into the page,
    // the live stub would find them already there and skip setting up consent handling.
    await page.evaluate(() => {
      document.querySelectorAll('iframe[name^="__tcf"], iframe[name^="__gpp"], iframe[name^="__uspapi"]').forEach((n) => n.remove());
      document.querySelectorAll('script[src*="cmp.inmobi.com"]').forEach((n) => n.remove());
      document.querySelectorAll('[id^="qc-cmp"], [class*="qc-cmp"]').forEach((n) => n.remove());
    });
    // The page was rendered from the local build server, so any URL the app built from
    // window.location (og:url etc.) says localhost. Point those at the real site.
    const html = (await page.content()).split(ORIGIN).join(SITE_URL);

    const outDir = route === '/' ? DIST_DIR : path.join(DIST_DIR, route);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), html);
    return { route, ok: true };
  } catch (err) {
    return { route, ok: false, error: err.message };
  } finally {
    await page.close();
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let idx = 0;
  const startedAt = Date.now();
  async function next() {
    while (idx < items.length) {
      if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
        console.warn(`Prerender time budget reached, stopping early at ${idx}/${items.length} routes.`);
        return;
      }
      const i = idx++;
      results.push(await worker(items[i]));
    }
  }
  await Promise.all(Array.from({ length: limit }, next));
  return results;
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.warn('Prerender: dist/ not found, skipping (did `vite build` run first?)');
    return;
  }
  if (!fs.existsSync(ROUTES_FILE)) {
    console.warn('Prerender: routes.json not found, skipping (did generate-routes.js run first?)');
    return;
  }

  const routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf-8'));
  console.log(`Prerendering ${routes.length} routes...`);

  // Vercel/Linux build machines lack Chrome's system libraries, so use the
  // self-contained @sparticuz/chromium build there. Locally (Windows/Mac),
  // fall back to full puppeteer if it is installed.
  let launchBrowser;
  try {
    if (process.platform === 'linux') {
      const puppeteer = (await import('puppeteer-core')).default;
      const chromium = (await import('@sparticuz/chromium')).default;
      launchBrowser = async () => puppeteer.launch({
        args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: await chromium.executablePath(),
        headless: 'shell',
      });
    } else {
      const puppeteer = (await import('puppeteer')).default;
      launchBrowser = async () => puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    }
  } catch (err) {
    console.warn('Prerender: browser package not available, skipping prerendering. Site will still deploy normally as a plain SPA.');
    console.warn(err.message);
    return;
  }

  let server, browser;
  try {
    server = await startStaticServer();
  } catch (err) {
    console.warn('Prerender: could not start local static server, skipping.', err.message);
    return;
  }

  try {
    browser = await launchBrowser();
  } catch (err) {
    console.warn('Prerender: Chrome failed to launch, skipping prerendering. Site will still deploy normally as a plain SPA.');
    console.warn(err.message);
    server.close();
    return;
  }

  try {
    const results = await runWithConcurrency(routes, CONCURRENCY, (route) => prerenderRoute(browser, route));
    const failed = results.filter(r => !r.ok);
    console.log(`Prerendered ${results.length - failed.length}/${routes.length} routes successfully.`);
    if (failed.length) {
      console.warn(`${failed.length} routes failed to prerender (these will fall back to the normal client-rendered page, not broken -- just not pre-rendered):`);
      failed.slice(0, 20).forEach(f => console.warn(`  ${f.route}: ${f.error}`));
      if (failed.length > 20) console.warn(`  ...and ${failed.length - 20} more`);
    }
  } catch (err) {
    console.warn('Prerender: unexpected error during crawl, some routes may not be prerendered.', err.message);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  // Absolute last resort: never let prerendering take the whole build down.
  console.warn('Prerender: unexpected top-level failure, continuing without prerendering.', err);
});
