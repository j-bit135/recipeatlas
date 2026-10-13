// Runs after prerender.js. Two jobs, both fail-soft (never breaks the build):
//
// 1. Make sure EVERY real route has a page file. Any route prerendering skipped or failed on
//    gets a copy of the normal app shell, so it still loads with a 200 and the app draws it.
// 2. Write dist/404.html (the same app shell). Vercel serves it, with a real 404 status, for any
//    address that is not a real page -- instead of showing the home page as if it were valid.
//    The app still starts up from it, so something like a /search/... link keeps working.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const ROUTES_FILE = path.join(__dirname, 'routes.json');

try {
  const shellPath = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(shellPath)) {
    console.warn('Finalize: dist/index.html not found, skipping.');
  } else {
    const shell = fs.readFileSync(shellPath);
    let filled = 0;
    if (fs.existsSync(ROUTES_FILE)) {
      const routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf-8'));
      for (const route of routes) {
        if (route === '/') continue;
        const file = path.join(DIST_DIR, route, 'index.html');
        if (!fs.existsSync(file)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, shell);
          filled++;
        }
      }
    } else {
      console.warn('Finalize: routes.json not found, skipping route fill.');
    }
    fs.writeFileSync(path.join(DIST_DIR, '404.html'), shell);
    console.log(`Finalize: wrote 404.html; ${filled} routes had no pre-rendered page and got the plain app page instead.`);
  }
} catch (err) {
  console.warn('Finalize: unexpected problem, continuing anyway.', err.message);
}
