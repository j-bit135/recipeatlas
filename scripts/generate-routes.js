// Reads the real recipe/event/blog data straight out of the app's own source
// file and produces the full, current list of every URL on the site. Because
// it reads the live data rather than a hand-maintained list, it automatically
// stays correct as recipes, events or blog posts are added or removed --
// nothing here needs to be updated by hand when content changes.
//
// Run as part of the build, before prerender.js: node scripts/generate-routes.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_FILE = path.join(__dirname, '..', 'src', 'App.jsx');
const OUT_FILE = path.join(__dirname, 'routes.json');

// Same slugify implementation as the app itself (src/App.jsx), copied
// verbatim so generated URLs always match exactly what the app's own router
// expects.
function slugify(s) {
  if (!s || typeof s !== 'string') return '';
  const map = {'à':'a','á':'a','â':'a','ã':'a','ä':'a','å':'a','è':'e','é':'e','ê':'e','ë':'e','ì':'i','í':'i','î':'i','ï':'i','ò':'o','ó':'o','ô':'o','õ':'o','ö':'o','ù':'u','ú':'u','û':'u','ü':'u','ý':'y','ÿ':'y','ñ':'n','ç':'c','ß':'ss','ž':'z','ż':'z','ź':'z','ł':'l','š':'s','ă':'a','ț':'t','ő':'o','ű':'u','ā':'a','ē':'e','ī':'i','ō':'o','ū':'u'};
  return s.toLowerCase().split('').map(c => map[c] || c).join('').replace(/[^a-z0-9\s-]/g,'').replace(/[\s_]+/g,'-').trim();
}

// Finds the exact text of the value assigned to `const NAME = ...;` by
// counting matching braces/brackets/strings -- robust to nested objects,
// arrays and quoted strings containing braces, unlike a regex-only approach.
function extractDeclaration(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Could not find "${marker}" in source file`);
  let i = start + marker.length;
  const openChar = source[i];
  if (openChar !== '{' && openChar !== '[') {
    throw new Error(`Expected "${name}" to start with { or [, found "${openChar}"`);
  }
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0, inString = false, stringChar = '';
  const valueStart = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const text = source.slice(valueStart, i);
  // Evaluate as real JavaScript rather than JSON.parse: this codebase mixes
  // quoted and unquoted object keys, so a strict JSON parser would reject
  // some of these declarations even though they're perfectly valid JS.
  return new Function(`return (${text});`)();
}

function main() {
  const source = fs.readFileSync(SRC_FILE, 'utf-8');

  const RECIPE_DB = extractDeclaration(source, 'RECIPE_DB');
  const EVENTS_DB = extractDeclaration(source, 'EVENTS_DB');
  const REGIONS = extractDeclaration(source, 'REGIONS');
  const BLOG_POSTS = extractDeclaration(source, 'BLOG_POSTS');

  const routes = new Set();
  routes.add('/');

  // Region and country pages
  for (const region of REGIONS) {
    routes.add(`/${region.id}`);
    for (const country of region.countries || []) {
      routes.add(`/${region.id}/${slugify(country)}`);
    }
  }

  // Recipe pages: /{region}/{country}/{dish}
  const countryToRegion = {};
  for (const region of REGIONS) {
    for (const country of region.countries || []) {
      countryToRegion[country] = region.id;
    }
  }
  let skippedRecipes = 0;
  for (const [dishKey, recipe] of Object.entries(RECIPE_DB)) {
    const regionId = countryToRegion[recipe.country];
    if (!regionId) { skippedRecipes++; continue; }
    routes.add(`/${regionId}/${slugify(recipe.country)}/${slugify(dishKey)}`);
  }

  // Events
  routes.add('/events');
  let skippedEvents = 0;
  for (const [slug, event] of Object.entries(EVENTS_DB)) {
    // Built from the event's OWN region, exactly as the site's event links and router do. (Looking
    // the region up from the country list would skip events in countries that have no recipes.)
    if (!event.region || !event.country) { skippedEvents++; continue; }
    routes.add(`/events/${event.region}/${slugify(event.country)}/${slug}`);
  }

  // Blog
  routes.add('/blog');
  for (const post of BLOG_POSTS) {
    if (post.slug) routes.add(`/blog/${post.slug}`);
  }

  // Static info pages
  for (const p of ['about', 'contact', 'privacy', 'terms', 'pantry-to-plate']) {
    routes.add(`/${p}`);
  }

  const sortedRoutes = Array.from(routes).sort();
  fs.writeFileSync(OUT_FILE, JSON.stringify(sortedRoutes, null, 2));

  console.log(`Generated ${sortedRoutes.length} routes -> ${OUT_FILE}`);
  console.log(`  Recipes: ${Object.keys(RECIPE_DB).length} (${skippedRecipes} skipped, no matching region)`);
  console.log(`  Events: ${Object.keys(EVENTS_DB).length} (${skippedEvents} skipped, missing region/country)`);
  console.log(`  Blog posts: ${BLOG_POSTS.length}`);
  console.log(`  Regions: ${REGIONS.length}`);
}

main();
