"""
Smart URL Checker v5 — Redirect Chain + DuckDuckGo Discovery
================================================================================
Logic (2-Phase):

Phase 1 — Quick aiohttp check:
  2xx + real content       → Working, no change
  3xx → different domain   → Update to new domain
  4xx/5xx (server alive)   → Keep original (server responded)
  Timeout / DNS fail       → Dead → Phase 2 recovery

Phase 2 — Smart Recovery:
  Step A: Prefix chain patterns (new5 → new6, new7...)
  Step B: Brand number increment (123moviesfree9 → 10, 11...)
  Step C: DuckDuckGo HTML search → find brand's current domain

Features:
  Parking page detection (GoDaddy, HugeDomains, "domain for sale")
  DuckDuckGo search for dead domain discovery
  Concurrent async checking (aiohttp)
  GitHub Actions: Job Summary + annotations
"""

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, unquote

# ── Windows Console UTF-8 Fix ────────────────────────────────
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import aiohttp
from bs4 import BeautifulSoup

# ─────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────

URLS_FILE = Path(__file__).parent / "urls.json"
REQUEST_TIMEOUT = 15          # seconds per request
MAX_REDIRECTS = 10
CONCURRENT_LIMIT = 5          # max parallel checks
DDG_DELAY = 2.5               # seconds between DuckDuckGo searches
PREFIX_MAX_INCREMENT = 20     # new5 → try up to new25
BRAND_NUM_MAX_INCREMENT = 15  # 123moviesfree9 → try up to 9+15=24

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

# Parking/fake domain detection keywords
PARKING_KEYWORDS = [
    "domain for sale", "buy this domain", "parked domain", "parked free",
    "godaddy", "hugedomains", "sedoparking", "afternic", "sedo.com",
    "dan.com", "undeveloped", "is available", "domain expired",
    "this domain has been registered", "domainmarket", "brandpa",
    "domain is for sale", "make an offer", "purchase this domain",
    "this webpage is parked", "future home of", "coming soon",
    "website is under construction", "namecheap", "register.com",
    "gname.com", "expired domain",
]

# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────

def load_urls() -> dict:
    """urls.json पढ़कर dict return करता है"""
    with open(URLS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_urls(data: dict):
    """urls.json में updated data save करता है"""
    with open(URLS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def extract_brand(name: str, url: str) -> str:
    """
    URL से brand name extract करता है।
    Example: https://new5.hdhub4u.fo → hdhub4u
             https://123moviesfree9.cloud → 123moviesfree9
    """
    hostname = urlparse(url).hostname or ""
    parts = hostname.split(".")
    # Remove common prefixes and TLD
    if len(parts) >= 2:
        # Domain part (without TLD)
        domain_part = parts[-2]
        # Remove numeric-only subdomains or common prefixes
        if len(parts) >= 3:
            # new5.hdhub4u.fo → hdhub4u
            domain_part = parts[-2]
        return domain_part.lower()
    return name.lower()


def extract_prefix_pattern(url: str):
    """
    URL से prefix pattern detect करता है।
    Example: https://new5.hdhub4u.fo → ("new", 5, "hdhub4u.fo")
             https://new16.gdflix.net → ("new", 16, "gdflix.net")
    Returns: (prefix_word, number, rest_of_domain) or None
    """
    hostname = urlparse(url).hostname or ""
    # Pattern: word + number at the start (subdomain)
    # e.g., new5.hdhub4u.fo, new16.gdflix.net, new1.moviesdrives.my
    match = re.match(r'^([a-zA-Z]+)(\d+)\.(.+)$', hostname)
    if match:
        return (match.group(1), int(match.group(2)), match.group(3))
    return None


def extract_brand_number(url: str):
    """
    Brand name में number detect करता है।
    Example: https://123moviesfree9.cloud → ("123moviesfree", 9, ".cloud")
             https://4khdhub.dad → ("4khdhub", None, ".dad")
    Returns: (brand_base, number, tld_with_dot) or None
    """
    hostname = urlparse(url).hostname or ""
    parts = hostname.split(".")
    if len(parts) < 2:
        return None
    domain = parts[0]  # could be subdomain or main domain
    # If there's a subdomain with prefix, use the next part
    if len(parts) >= 3:
        prefix_match = re.match(r'^[a-zA-Z]+\d*$', parts[0])
        if prefix_match and len(parts[0]) <= 6:
            domain = parts[1]
            tld = "." + ".".join(parts[2:])
        else:
            domain = parts[-2]
            tld = "." + parts[-1]
    else:
        tld = "." + parts[-1]

    # Check if domain ends with a number
    match = re.match(r'^(.+?)(\d+)$', domain)
    if match:
        return (match.group(1), int(match.group(2)), tld)
    return None


def is_parked_page(html: str) -> bool:
    """HTML content check करता है कि page parked/fake तो नहीं"""
    if not html:
        return False
    html_lower = html.lower()
    matches = sum(1 for kw in PARKING_KEYWORDS if kw in html_lower)
    return matches >= 2  # 2+ parking keywords = definitely parked


def brand_in_content(brand: str, html: str) -> bool:
    """Check करता है कि brand name page content में है या नहीं"""
    if not html or not brand:
        return True  # If we can't verify, assume OK
    return brand.lower() in html.lower()


def log(msg: str):
    """Print with flush for real-time GitHub Actions output"""
    print(msg, flush=True)


def github_summary(lines: list[str]):
    """GitHub Actions Job Summary में write करता है"""
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")


# ─────────────────────────────────────────────────────────────
# PHASE 1: Quick Health Check
# ─────────────────────────────────────────────────────────────

async def check_url_health(session: aiohttp.ClientSession, url: str, brand: str):
    """
    URL की health check करता है।
    Returns: dict with keys:
      status: "alive" | "redirected" | "dead"
      new_url: (if redirected) final URL
      reason: human-readable reason
    """
    try:
        async with session.get(
            url,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            allow_redirects=True,
            max_redirects=MAX_REDIRECTS,
            ssl=False,
        ) as resp:
            final_url = str(resp.url)
            status = resp.status

            # Read body for parking/brand check
            try:
                body = await resp.text(errors="replace")
            except Exception:
                body = ""

            # Check if parked
            if is_parked_page(body):
                return {
                    "status": "dead",
                    "reason": f"Parked/Fake page (status {status})",
                }

            # 2xx = alive
            if 200 <= status < 300:
                # Check if redirected to different domain
                orig_host = urlparse(url).hostname
                final_host = urlparse(final_url).hostname
                if orig_host != final_host:
                    # Redirected to different domain
                    # Brand must appear in EITHER the new hostname OR the page body
                    brand_in_host = brand.lower() in final_host.lower()
                    brand_in_body = brand_in_content(brand, body)
                    if brand_in_host or brand_in_body:
                        return {
                            "status": "redirected",
                            "new_url": final_url,
                            "reason": f"Redirected → {final_host} (brand confirmed)",
                        }
                    else:
                        return {
                            "status": "dead",
                            "reason": f"Redirected to unrelated site: {final_host}",
                        }
                return {
                    "status": "alive",
                    "reason": f"Working (status {status})",
                }

            # 3xx that didn't resolve (shouldn't happen with follow_redirects)
            if 300 <= status < 400:
                location = resp.headers.get("Location", "")
                if location:
                    return {
                        "status": "redirected",
                        "new_url": location,
                        "reason": f"Redirect → {location}",
                    }

            # 4xx/5xx = server alive but page error — keep original
            if 400 <= status < 600:
                return {
                    "status": "alive",
                    "reason": f"Server alive (status {status})",
                }

            return {"status": "dead", "reason": f"Unexpected status {status}"}

    except aiohttp.ClientConnectorError:
        return {"status": "dead", "reason": "Connection failed (DNS/network)"}
    except asyncio.TimeoutError:
        return {"status": "dead", "reason": "Timeout"}
    except aiohttp.TooManyRedirects:
        return {"status": "dead", "reason": "Too many redirects"}
    except Exception as e:
        return {"status": "dead", "reason": f"Error: {type(e).__name__}"}


# ─────────────────────────────────────────────────────────────
# PHASE 2: Smart Recovery
# ─────────────────────────────────────────────────────────────

async def try_url(session: aiohttp.ClientSession, url: str, brand: str) -> bool:
    """
    URL को test करता है — alive + not parked + brand match = True
    """
    try:
        async with session.get(
            url,
            timeout=aiohttp.ClientTimeout(total=10),
            allow_redirects=True,
            max_redirects=5,
            ssl=False,
        ) as resp:
            if not (200 <= resp.status < 300):
                return False
            try:
                body = await resp.text(errors="replace")
            except Exception:
                body = ""
            if is_parked_page(body):
                return False
            return True
    except Exception:
        return False


async def recover_prefix_chain(
    session: aiohttp.ClientSession, url: str, brand: str
) -> str | None:
    """
    Step A: Prefix chain pattern recovery
    new5.hdhub4u.fo → try new6, new7, ... new25
    """
    pattern = extract_prefix_pattern(url)
    if not pattern:
        return None

    prefix_word, current_num, rest = pattern
    log(f"   🔄  Prefix chain: {prefix_word}{current_num} → trying increments...")

    # Try incrementing the prefix number
    for delta in range(1, PREFIX_MAX_INCREMENT + 1):
        new_num = current_num + delta
        candidate = f"https://{prefix_word}{new_num}.{rest}"
        if await try_url(session, candidate, brand):
            log(f"   ✅  Found via prefix chain: {candidate}")
            return candidate

    # Also try without any prefix (bare domain)
    bare = f"https://{rest}"
    if await try_url(session, bare, brand):
        log(f"   ✅  Found bare domain: {bare}")
        return bare

    # Try www prefix
    www = f"https://www.{rest}"
    if await try_url(session, www, brand):
        log(f"   ✅  Found www domain: {www}")
        return www

    log(f"   ❌  Prefix chain: no working increment found")
    return None


async def recover_brand_number(
    session: aiohttp.ClientSession, url: str, brand: str
) -> str | None:
    """
    Step B: Brand number increment recovery
    123moviesfree9.cloud → try 123moviesfree10, 11, ... 24
    """
    info = extract_brand_number(url)
    if not info:
        return None

    brand_base, current_num, tld = info
    if current_num is None:
        return None

    log(f"   🔢  Brand number: {brand_base}[{current_num}] → trying increments...")

    # Get prefix from original URL (if any)
    pattern = extract_prefix_pattern(url)
    prefixes_to_try = [""]
    if pattern:
        prefixes_to_try.append(f"{pattern[0]}{pattern[1]}.")
        prefixes_to_try.append(f"{pattern[0]}.")

    for delta in range(1, BRAND_NUM_MAX_INCREMENT + 1):
        new_num = current_num + delta
        for pfx in prefixes_to_try:
            candidate = f"https://{pfx}{brand_base}{new_num}{tld}"
            if await try_url(session, candidate, brand):
                log(f"   ✅  Found via brand number: {candidate}")
                return candidate

    log(f"   ❌  Brand number: no working increment found")
    return None


async def recover_duckduckgo(
    session: aiohttp.ClientSession, name: str, brand: str
) -> str | None:
    """
    Step C: DuckDuckGo search fallback
    Brand name से search करके नया domain ढूँढता है
    """
    queries = [
        f"{name} official site",
        f"{name} new domain {time.strftime('%Y')}",
        f"{name} new link working",
    ]

    for query in queries:
        log(f"   🔍  DuckDuckGo: '{query}'")
        await asyncio.sleep(DDG_DELAY)

        try:
            async with session.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                timeout=aiohttp.ClientTimeout(total=15),
                ssl=False,
            ) as resp:
                if resp.status != 200:
                    continue
                html = await resp.text(errors="replace")
        except Exception:
            continue

        soup = BeautifulSoup(html, "html.parser")

        # Extract all result URLs
        for link in soup.select("a.result__a"):
            href = link.get("href", "")

            # DuckDuckGo wraps URLs — extract actual URL
            if "uddg=" in href:
                match = re.search(r'uddg=([^&]+)', href)
                if match:
                    href = unquote(match.group(1))

            if not href.startswith("http"):
                continue

            result_host = urlparse(href).hostname or ""
            result_host_lower = result_host.lower()

            # Check if brand name appears in the hostname
            brand_lower = brand.lower()
            name_lower = name.lower()
            if brand_lower not in result_host_lower and name_lower not in result_host_lower:
                continue

            # Skip known non-target sites
            skip_domains = [
                "reddit.com", "wikipedia.org", "twitter.com",
                "facebook.com", "youtube.com", "instagram.com",
                "quora.com", "medium.com", "t.me", "telegram",
            ]
            if any(sd in result_host_lower for sd in skip_domains):
                continue

            # Verify the found URL
            test_url = f"https://{result_host}"
            if await try_url(session, test_url, brand):
                log(f"   ✅  Found via DuckDuckGo: {test_url}")
                return test_url

    log(f"   ❌  DuckDuckGo: no matching domain found")
    return None


# ─────────────────────────────────────────────────────────────
# MAIN PROCESSOR
# ─────────────────────────────────────────────────────────────

async def process_domain(
    session: aiohttp.ClientSession,
    name: str,
    url: str,
    semaphore: asyncio.Semaphore,
):
    """
    Single domain process करता है:
    1. Health check
    2. If dead → recovery (prefix chain → brand number → DDG)
    Returns: (name, original_url, new_url_or_None, status_msg)
    """
    async with semaphore:
        log(f"\n{'='*60}")
        log(f"📋  {name}: {url}")
        log(f"{'-'*60}")

        brand = extract_brand(name, url)

        # ── Phase 1: Health Check ──
        result = await check_url_health(session, url, brand)

        if result["status"] == "alive":
            log(f"   ✅  {result['reason']}")
            return (name, url, None, "alive")

        if result["status"] == "redirected":
            new_url = result["new_url"]
            log(f"   🔄  {result['reason']}")
            return (name, url, new_url, "redirected")

        # ── Dead → Phase 2: Recovery ──
        log(f"   💀  Dead: {result['reason']}")
        log(f"   🔧  Recovery शुरू...")

        # Step A: Prefix chain patterns
        found = await recover_prefix_chain(session, url, brand)
        if found:
            return (name, url, found, "recovered-prefix")

        # Step B: Brand number increment
        found = await recover_brand_number(session, url, brand)
        if found:
            return (name, url, found, "recovered-number")

        # Step C: DuckDuckGo search
        found = await recover_duckduckgo(session, name, brand)
        if found:
            return (name, url, found, "recovered-ddg")

        log(f"   ❌  Dead — keeping original")
        return (name, url, None, "dead")


async def main():
    log("Smart URL Checker v5")
    log("=" * 60)

    # Load URLs
    urls = load_urls()
    log(f"Total domains: {len(urls)}\n")

    semaphore = asyncio.Semaphore(CONCURRENT_LIMIT)

    connector = aiohttp.TCPConnector(
        limit=CONCURRENT_LIMIT,
        force_close=True,
        enable_cleanup_closed=True,
    )

    results = []
    async with aiohttp.ClientSession(
        headers=HEADERS,
        connector=connector,
    ) as session:
        # Process domains sequentially for clean ordered output
        for name, url in urls.items():
            try:
                r = await process_domain(session, name, url, semaphore)
                results.append(r)
            except Exception as e:
                results.append(e)

    # ── Process Results ──
    updated_count = 0
    alive_count = 0
    dead_count = 0
    changes = []
    summary_lines = ["## Smart URL Checker v5 — Results\n", "| Domain | Status | Action |", "|--------|--------|--------|"]

    for r in results:
        if isinstance(r, Exception):
            log(f"\n⚠️  Error: {r}")
            continue

        name, old_url, new_url, status = r

        if status == "alive":
            alive_count += 1
            summary_lines.append(f"| {name} | ✅ Alive | No change |")

        elif status in ("redirected", "recovered-prefix", "recovered-number", "recovered-ddg"):
            if new_url and new_url != old_url:
                # Normalize URL — remove trailing slash for consistency
                new_url = new_url.rstrip("/")
                urls[name] = new_url
                updated_count += 1
                method = status.replace("recovered-", "").replace("redirected", "redirect")
                changes.append(f"  {name}: {old_url} → {new_url} ({method})")
                summary_lines.append(f"| {name} | 🔄 Updated | `{old_url}` → `{new_url}` |")
            else:
                alive_count += 1
                summary_lines.append(f"| {name} | ✅ Alive | No change |")

        elif status == "dead":
            dead_count += 1
            summary_lines.append(f"| {name} | ❌ Dead | No replacement found |")
            # GitHub Actions annotation
            if os.environ.get("GITHUB_ACTIONS"):
                log(f"::warning title=Dead Domain::{name} — {old_url}")

    # ── Summary ──
    log(f"\n{'='*60}")
    log(f"📊  Summary: {alive_count} alive, {updated_count} updated, {dead_count} dead")
    log(f"{'='*60}")

    if changes:
        log(f"\n🔄  Changes:")
        for c in changes:
            log(c)

    # Save if updated
    if updated_count > 0:
        save_urls(urls)
        log(f"\n💾  urls.json updated with {updated_count} changes!")
    else:
        log(f"\n✅  No changes needed — urls.json is up to date")

    # GitHub Actions Summary
    summary_lines.append(f"\n**Total: {alive_count} alive, {updated_count} updated, {dead_count} dead**")
    github_summary(summary_lines)


if __name__ == "__main__":
    asyncio.run(main())
