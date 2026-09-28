#!/usr/bin/env python3
"""
find-event-images.py

Finds candidate replacement images for every Recipe Atlas event still on the
default placeholder image, searching Pexels then Openverse, trying the most
specific, relevant search first and only broadening if nothing turns up.

For each event, the query chain tried is (in order, stopping at first hit):
  1. The event's full name              e.g. "Lucerne Cheese Festival"
  2. The event's location + its type    e.g. "Lucerne Festival"
  3. The event's location alone         e.g. "Lucerne"
  4. The event's country alone          e.g. "Switzerland"
At each level, Pexels is tried first, then Openverse -- so relevance (query
specificity) always wins over source preference, but Pexels is preferred
whenever both have something at the same level.

SETUP
-----
1. pip install requests
2. Get a free Pexels API key: https://www.pexels.com/api/  (takes ~1 minute,
   no payment details needed). Openverse needs no key at all.
3. Run:
     python find-event-images.py --pexels-key YOUR_KEY_HERE
   or set it as an environment variable instead:
     export PEXELS_API_KEY=YOUR_KEY_HERE
     python find-event-images.py

By default this reads src/App.jsx (run it from your project root, or pass
--source path/to/App.jsx). It writes two files next to itself:
  - event_image_results.csv   (open in Excel/Sheets to review)
  - event_image_results.json  (send this one back to Claude to apply)

This script only *finds* candidates -- it does not modify App.jsx. Review
the results, drop anything that doesn't look right, then hand the results
file over to apply the good ones.
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse

DEFAULT_IMAGE_MARKER = "images.pexels.com/photos/1640777"
REQUEST_DELAY_SECONDS = 0.4  # be polite to both APIs
MAX_RETRIES = 3


def extract_events_db(source_path):
    """Pulls EVENTS_DB out of App.jsx the same way generate-routes.js does:
    find the exact text of the object literal by counting braces/strings,
    then evaluate it as real JS (via Node) rather than JSON.parse, since the
    file mixes quoted and unquoted keys in places."""
    with open(source_path, "r", encoding="utf-8") as f:
        source = f.read()

    marker = "const EVENTS_DB = "
    start = source.index(marker) + len(marker)
    depth = 0
    in_string = False
    string_char = ""
    i = start
    while i < len(source):
        ch = source[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_string = False
            i += 1
            continue
        if ch in "\"'":
            in_string = True
            string_char = ch
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                i += 1
                break
        i += 1

    events_text = source[start:i]

    # Evaluate via Node so mixed quote styles / unquoted keys parse correctly.
    node_script = f"const EVENTS_DB = {events_text};\nconsole.log(JSON.stringify(EVENTS_DB));"
    tmp_path = "_tmp_extract_events.js"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(node_script)
    try:
        import subprocess
        result = subprocess.run(
            ["node", tmp_path], capture_output=True, text=True,
            encoding="utf-8", errors="replace", check=True,
        )
        return json.loads(result.stdout)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def build_query_chain(event):
    """Builds the specific -> broad fallback list of search queries for one
    event, deduplicating consecutive identical entries (e.g. if the location
    has no separate city part)."""
    name = event.get("name", "").strip()
    loc = event.get("loc", "").strip()
    tag = event.get("tag", "").strip()
    country = event.get("country", "").strip()

    # loc is often "City, Region" -- take just the city part for the
    # broader queries, since "Lucerne" beats "Lucerne, Switzerland" for
    # finding a generic photo of the place.
    city = loc.split(",")[0].strip() if loc else ""

    chain = []
    if name:
        chain.append(name)
    if city and tag:
        chain.append(f"{city} {tag}")
    if city:
        chain.append(city)
    if country:
        chain.append(country)

    # de-duplicate while preserving order
    seen = set()
    deduped = []
    for q in chain:
        key = q.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(q)
    return deduped


BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}


def http_get_json(url, headers=None):
    merged_headers = {**BROWSER_HEADERS, **(headers or {})}
    req = urllib.request.Request(url, headers=merged_headers)
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** (attempt + 1)
                print(f"    rate limited, waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            if e.code == 401:
                raise RuntimeError("API key rejected (401) -- check your Pexels key.")
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            print(f"    HTTP {e.code} error calling {url.split('?')[0]}: {body}", file=sys.stderr)
            return None
        except urllib.error.URLError as e:
            print(f"    could not reach {url.split('?')[0]}: {e.reason}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"    request error calling {url.split('?')[0]}: {type(e).__name__}: {e}", file=sys.stderr)
            return None
    return None


STOPWORDS = {"a", "an", "the", "of", "in", "on", "at", "for", "and", "&", "to", "de", "la", "le",
             "festival", "fest", "day", "days", "week", "celebration", "annual"}


def significant_words(query):
    """Words worth checking for in a result's title -- drops short/common
    words and generic event-type words (since a generic word like "festival"
    matching a generic word in a photo's title tells us nothing about
    whether the photo is actually about the right festival)."""
    words = re.findall(r"[a-zA-Z]+", query.lower())
    return [w for w in words if w not in STOPWORDS and len(w) > 2]


def is_relevant(query, title):
    """A result counts as relevant if enough significant words from the
    query appear in the result's own title. For broad single-word fallback
    queries (just a city or country name), one match is trivially all there
    is to check -- that's the intentional "less relevant but still
    contextual" tier, not a bug. For multi-word queries, a single generic
    word matching isn't a strong enough signal on its own, so at least two
    distinct words must match when there are two or more available.

    Known limitation: this is plain substring matching, so it can still be
    fooled when an event's own name is itself made of generic/common words
    (e.g. "Otro Sabor" -- Spanish for "different flavor" -- can coincidentally
    match an unrelated food photo's caption that happens to say "other
    flavors"). No keyword-only check can fully solve that; events whose name
    reads as a generic phrase rather than a distinctive proper noun are
    worth a closer look in the review CSV for exactly this reason."""
    sig = significant_words(query)
    if not sig:
        return True  # nothing left to check against, don't block on it
    title_lower = (title or "").lower()
    matches = [w for w in sig if w in title_lower]
    required = min(2, len(sig))
    return len(matches) >= required


def search_pexels(query, api_key):
    if not api_key:
        return None
    url = "https://api.pexels.com/v1/search?" + urllib.parse.urlencode({
        "query": query, "per_page": 1, "orientation": "landscape"
    })
    data = http_get_json(url, headers={"Authorization": api_key})
    if not data or not data.get("photos"):
        return None
    photo = data["photos"][0]
    return {
        "source": "pexels",
        "image_url": photo["src"]["large"],
        "width": photo.get("width"),
        "height": photo.get("height"),
        "photographer_name": photo.get("photographer"),
        "photographer_url": photo.get("photographer_url"),
        "license": "Pexels License (free use, attribution appreciated not required)",
        "license_url": "https://www.pexels.com/license/",
        "source_page_url": photo.get("url"),
    }


def search_openverse(query):
    """Requests a handful of results rather than just one, and returns the
    first one that actually passes the relevance check against the query --
    not just whatever Openverse ranked first. Restricted to license_type
    "commercial", which excludes every Non-Commercial (NC) variant --
    important since this site runs ads, so an NC-licensed image genuinely
    can't be used here regardless of how relevant it looks."""
    url = "https://api.openverse.org/v1/images/?" + urllib.parse.urlencode({
        "q": query, "page_size": 8, "license_type": "commercial",
        "orientation": "landscape", "mature": "false"
    })
    data = http_get_json(url)
    if not data or not data.get("results"):
        return None
    for img in data["results"]:
        license_name = (img.get("license") or "").upper()
        if "NC" in license_name:
            # Defensive double-check: don't just trust the API filter alone
            # for something this consequential -- skip it outright if it
            # slips through anyway.
            continue
        if not is_relevant(query, img.get("title")):
            continue
        return {
            "source": "openverse",
            "image_url": img.get("url"),
            "width": img.get("width"),
            "height": img.get("height"),
            "photographer_name": img.get("creator") or "Unknown",
            "photographer_url": img.get("creator_url") or "",
            "license": f"{(img.get('license') or '').upper()} {img.get('license_version') or ''}".strip(),
            "license_url": img.get("license_url") or "",
            "source_page_url": img.get("foreign_landing_url") or "",
            "openverse_page_url": f"https://openverse.org/image/{img.get('id')}",
            "matched_title": img.get("title"),
        }
    return None


def find_image_for_event(event, pexels_key):
    chain = build_query_chain(event)
    for level, query in enumerate(chain, start=1):
        print(f"  [{level}/{len(chain)}] trying: {query!r}")
        # Openverse first: its results have title/tag data we can actually
        # check for relevance, unlike Pexels which will surface its closest
        # guess even when nothing genuinely matches.
        result = search_openverse(query)
        time.sleep(REQUEST_DELAY_SECONDS)
        if result:
            result["query_used"] = query
            result["query_level"] = level
            return result
        result = search_pexels(query, pexels_key)
        time.sleep(REQUEST_DELAY_SECONDS)
        if result:
            result["query_used"] = query
            result["query_level"] = level
            return result
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", default="src/App.jsx", help="Path to App.jsx (default: src/App.jsx)")
    parser.add_argument("--pexels-key", default=os.environ.get("PEXELS_API_KEY"),
                         help="Pexels API key (or set PEXELS_API_KEY env var)")
    parser.add_argument("--limit", type=int, default=None,
                         help="Only process the first N events (useful for a quick test run)")
    parser.add_argument("--only-slugs", default=None,
                         help="Path to a JSON file containing a list of event slugs to reprocess "
                              "(e.g. [\"lucerne-cheese-festival\", ...]). If given, only these "
                              "events are searched, instead of every event on the default image.")
    args = parser.parse_args()

    if not args.pexels_key:
        print("WARNING: no Pexels API key given -- will search Openverse only.")
        print("Get a free key at https://www.pexels.com/api/ for much better results.\n")

    if not os.path.exists(args.source):
        print(f"ERROR: could not find {args.source}. Run this from your project root,")
        print("or pass --source path/to/App.jsx")
        sys.exit(1)

    print(f"Reading events from {args.source}...")
    events = extract_events_db(args.source)
    print(f"Total events: {len(events)}")

    if args.only_slugs:
        with open(args.only_slugs, "r", encoding="utf-8") as f:
            wanted_slugs = set(json.load(f))
        todo = [(slug, ev) for slug, ev in events.items() if slug in wanted_slugs]
        missing = wanted_slugs - {slug for slug, _ in todo}
        print(f"Reprocessing only the {len(todo)} events listed in {args.only_slugs}")
        if missing:
            print(f"WARNING: {len(missing)} slugs from that file were not found in {args.source}: {sorted(missing)[:10]}")
    else:
        todo = [(slug, ev) for slug, ev in events.items()
                if DEFAULT_IMAGE_MARKER in (ev.get("image") or "")]
        print(f"Events still on the default image: {len(todo)}")

    if args.limit:
        todo = todo[:args.limit]
        print(f"(--limit set: only processing first {len(todo)})")

    results = []
    not_found = []

    for idx, (slug, event) in enumerate(todo, start=1):
        print(f"\n[{idx}/{len(todo)}] {event.get('name')} ({event.get('country')})")
        found = find_image_for_event(event, args.pexels_key)
        if found:
            row = {
                "slug": slug,
                "name": event.get("name"),
                "country": event.get("country"),
                "loc": event.get("loc"),
                **found,
            }
            results.append(row)
            print(f"  -> FOUND via {found['source']} at level {found['query_level']} ({found['query_used']!r})")
        else:
            not_found.append({"slug": slug, "name": event.get("name"), "country": event.get("country")})
            print("  -> nothing found at any fallback level")

    # Write CSV for human review
    csv_path = "event_image_results.csv"
    fieldnames = ["slug", "name", "country", "loc", "query_used", "query_level", "source",
                  "image_url", "width", "height", "photographer_name", "photographer_url",
                  "license", "license_url", "source_page_url", "openverse_page_url"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            writer.writerow(row)

    # Write JSON for re-processing
    json_path = "event_image_results.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"found": results, "not_found": not_found}, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*60}")
    print(f"Done. {len(results)} found, {len(not_found)} not found.")
    print(f"Review: {csv_path}")
    print(f"Send back for updating: {json_path}")
    if not_found:
        print(f"\n{len(not_found)} events found nothing at any fallback level, including country name:")
        for nf in not_found[:15]:
            print(f"  - {nf['name']} ({nf['country']})")
        if len(not_found) > 15:
            print(f"  ...and {len(not_found) - 15} more (see JSON file)")


if __name__ == "__main__":
    main()
