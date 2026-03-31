"""
Smart URL Checker v4 — TLD Brute-Force + Dead Domain Discovery
================================================================================
Logic (3-Phase):

Phase 1 — Quick aiohttp check:
  200 OK + real content  → ✅ Working, no change
  3xx → different domain → 🔄 Update to new domain
  4xx/5xx (server alive) → ✅ Keep original (server responded)
  Timeout / DNS fail     → ❌ Dead/wrong → Phase 2 TLD brute-force

Phase 2 — TLD Brute-Force:
  Same brand, different TLD try → verify with aiohttp

Phase 3 — DuckDuckGo Discovery:
  DuckDuckGo HTML search → find brand's current domain
  Verify the found URL   → if real content → 🔄 Update

Features:
  ✅ Parking page detection (GoDaddy, HugeDomains, "domain for sale")
  ✅ DuckDuckGo search for dead domain discovery
  ✅ Concurrent async checking (aiohttp)
  ✅ GitHub Actions: Job Summary + Dead domain annotations
"""

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    import aiohttp  # type: ignore
    from bs4 import BeautifulSoup  # type: ignore
except ImportError as e:
    print(f"❌ Missing dependency: {e}")
    print("   Run: pip install aiohttp beautifulsoup4")
    sys.exit(1)

import builtins
import contextvars

_log_ctx = contextvars.ContextVar('log_ctx', default=None)

def _custom_print(*args, **kwargs):
    ctx = _log_ctx.get()
    if ctx is not None:
        ctx.append(" ".join(str(a) for a in args))
    else:
        builtins.print(*args, **kwargs)

print = _custom_print

# ══════════════════════════════════════════════════════════
# Configuration
# ══════════════════════════════════════════════════════════

FILE_PATH    = Path("urls.json")
MAX_REDIRECTS  = 10
AIOHTTP_TIMEOUT = 12    # seconds — Phase 1 quick check
DDG_TIMEOUT     = 10    # seconds — Phase 3 DuckDuckGo search
CONCURRENCY     = 8     # एक साथ max async domains

# Comprehensive TLDs for brute-force discovery (Phase 2.5)
# Dead domain मिला → same brand, different TLD try करो
# सभी popular + niche TLDs included ताकि कोई भी domain miss न हो
COMMON_TLDS = [
    # Classic
    "com", "net", "org", "info", "biz",
    # Country codes (popular)
    "io", "co", "me", "tv", "cc", "in", "de", "uk", "us",
    "ca", "au", "fr", "it", "es", "nl", "ru", "br", "pl",
    "se", "no", "fi", "dk", "at", "ch", "be", "pt", "cz",
    "mx", "ar", "cl", "pe", "za", "ng", "ke", "pk", "bd",
    "th", "ph", "sg", "my", "id", "vn", "kr", "jp", "tw",
    "hk", "nz", "ie", "il", "ae", "sa", "tr", "eg", "ma",
    # Niche country codes used by sites
    "to", "cx", "pw", "gg", "li", "la", "im", "is", "st",
    "ws", "ms", "nu", "tk", "cf", "ga", "gq", "ml", "cv",
    "fo", "re", "pm", "yt", "wf", "tf", "ai", "sx", "tc",
    # New gTLDs (popular)
    "dev", "app", "site", "online", "cloud", "xyz", "link",
    "space", "pro", "fun", "lol", "top", "win", "bid",
    "click", "pics", "mov", "zip", "foo", "bar",
    # New gTLDs (niche but used by streaming/movie sites)
    "fans", "dad", "autos", "sbs", "mom", "rip", "wtf",
    "life", "live", "world", "today", "one", "plus",
    "buzz", "zone", "work", "works", "tech", "digital",
    "media", "video", "stream", "tube", "watch", "show",
    "download", "movie", "film", "games", "play",
    "studio", "network", "page", "run", "blog",
    "wiki", "guru", "expert", "ninja", "rocks",
    "club", "vip", "best", "cool", "new", "now",
    "land", "city", "town", "place", "center",
    "store", "shop", "market", "trade", "exchange",
    "solutions", "services", "systems", "group",
    "name", "email", "chat", "social", "community",
    "agency", "company", "enterprises", "ventures",
    "foundation", "institute", "academy", "university",
    "fans"
]

# ══════════════════════════════════════════════════════════
# Browser-like headers
# ══════════════════════════════════════════════════════════

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Cache-Control": "max-age=0",
}

# ══════════════════════════════════════════════════════════
# Parking / dead domain detection patterns
# ══════════════════════════════════════════════════════════

PARKING_PATTERNS = [
    r"domain.*(?:for\s*sale|available|buy\s*this|is\s*for\s*sale)",
    r"(?:hugedomains|godaddy\.com|sedo\.com|dan\.com|afternic)",
    r"(?:parked|parking)\s*(?:page|domain|by)",
    r"this\s*domain\s*(?:is|has been)?\s*(?:for\s*sale|expired|available)",
    r"buy\s*this\s*domain",
    r"make\s+an\s+offer",
    r"domain\s+(?:name\s+)?marketplace",
    r"register\s+your\s+domain",
    r"web\s*hosting.*coming\s*soon",
    r"under\s+construction.*domain",
    r"default\s+web\s+page",            # Apache/nginx default page
    r"welcome\s+to\s+(?:nginx|apache|iis)",  # server default pages
]
PARKING_RE = [re.compile(p, re.IGNORECASE) for p in PARKING_PATTERNS]

# Known parking/domain-sale sites — redirect इनपर जाए तो DEAD मानो
PARKING_DOMAINS = {
    "hugedomains.com", "www.hugedomains.com",
    "godaddy.com", "www.godaddy.com",
    "sedo.com", "www.sedo.com",
    "dan.com", "www.dan.com",
    "afternic.com", "www.afternic.com",
    "namecheap.com", "www.namecheap.com",
    "bodis.com", "www.bodis.com",
    "parkingcrew.net", "www.parkingcrew.net",
    "domainmarket.com", "www.domainmarket.com",
    "undeveloped.com", "www.undeveloped.com",
    "porkbun.com", "www.porkbun.com",
    "dynadot.com", "www.dynadot.com",
    "above.com", "www.above.com",
    "uniregistry.com", "www.uniregistry.com",
    "sedoparking.com", "www.sedoparking.com",
}


def is_parking_redirect(url: str) -> bool:
    """क्या redirect target एक known parking/sale site है?"""
    try:
        host = urlparse(url).hostname or ""
        return host.lower() in PARKING_DOMAINS
    except Exception:
        return False


# "No content" page patterns — pixeldrain.de जैसे cases
NO_CONTENT_RE = re.compile(
    r"(?:has\s+no\s+content|no\s+content\s*[-–—]?\s*nada"
    r"|nothing\s+here|empty\s+page|page\s+not\s+found"
    r"|coming\s+soon|be\s+right\s+back)",
    re.IGNORECASE,
)

def is_parking_or_dead(html: str, url: str) -> bool:
    """
    क्या यह page actually dead/parking है?
    True → dead/parking/empty → trust मत करो
    False → probably real/working page → trust करो

    IMPORTANT: JS-rendered sites (React, Vue, WordPress SPA) often return
    minimal/empty HTML via HTTP but work perfectly in browser.
    Empty body alone ≠ dead. Only KNOWN dead patterns = dead.
    """
    # Completely empty response = can't determine, let caller decide
    if not html:
        return False  # Benefit of doubt — could be JS app

    try:
        soup = BeautifulSoup(html, "html.parser")
        body_text = soup.get_text(" ", strip=True)
        title = (soup.find("title") or soup.new_tag("t")).get_text().strip().lower()
        body_lower = body_text.lower()

        # ── Check 1: "No content" explicit patterns ───────
        # pixeldrain.de: "This page has no content - nada"
        combined_short = f"{title} {body_text[:500]}"
        if NO_CONTENT_RE.search(combined_short):
            return True

        # ── Check 2: JS lander/redirect-only pages ────────
        # hubcdn.com: only has <script>window.location.href="/lander"</script>
        # Page with ONLY redirect JS and no real content = dead
        scripts = soup.find_all("script")
        if scripts and len(body_text) < 200:
            all_script_text = " ".join(s.get_text() for s in scripts).lower()
            if re.search(r'(?:window\.location|location\.href|location\.replace|'
                         r'document\.location|top\.location)', all_script_text):
                # Check: is there ANY real visible text beyond the redirect script?
                soup_copy = BeautifulSoup(html, "html.parser")
                for s in soup_copy.find_all("script"):
                    s.decompose()
                visible_text = soup_copy.get_text(" ", strip=True)
                if len(visible_text.strip()) < 30:
                    return True

        # ── Check 3: Title = domain name (parking indicator) ─
        try:
            host = urlparse(url).hostname or ""
            host_no_www = host.replace("www.", "")
            if title and title in (host, host_no_www, host_no_www.split(".")[0]):
                # Title is just the domain name — parking page
                if len(body_text) < 500:
                    return True
        except Exception:
            pass

        # ── Check 4: Known parking keywords ───────────────
        combined = f"{title} {body_lower[:3000]}"
        for pat in PARKING_RE:
            if pat.search(combined):
                return True




    except Exception:
        pass

    return False


def brand_matches_content(html: str, brand: str) -> bool:
    """
    200 OK page में brand का नाम है या नहीं?

    True  → Page brand से match करता है → domain CORRECT है
    False → Brand नहीं मिला → domain WRONG हो सकता है

    Example:
      brand = "pixeldrain"
      pixeldrain.de → title "Web Hosting Company" → False ❌ (wrong domain)
      pixeldrain.com → title "Pixeldrain" → True ✅ (correct)
    """
    if not html or not brand:
        return True  # Benefit of doubt — content नहीं मिला

    brand_lower = brand.lower()

    try:
        soup = BeautifulSoup(html, "html.parser")

        # 1. Page title में brand
        title_tag = soup.find("title")
        if title_tag:
            title = title_tag.get_text().lower()
            if brand_lower in title:
                return True

        # 2. Meta description में brand
        for meta in soup.find_all("meta", attrs={"name": ["description", "application-name", "og:site_name"]}):
            content = (meta.get("content") or "").lower()
            if brand_lower in content:
                return True

        # 3. og:title या og:site_name में brand
        for prop in ["og:title", "og:site_name", "twitter:title", "twitter:site"]:
            meta = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
            if meta:
                content = (meta.get("content") or "").lower()
                if brand_lower in content:
                    return True

        # 4. h1 heading में brand
        h1 = soup.find("h1")
        if h1 and brand_lower in h1.get_text().lower():
            return True

        # 5. पूरे body में brand कम से कम 2 बार हो
        body_text = soup.get_text(" ", strip=True).lower()
        if body_text.count(brand_lower) >= 2:
            return True

        # Brand नहीं मिला → शायद wrong domain
        return False

    except Exception:
        return True   # Parse error → benefit of doubt

# ══════════════════════════════════════════════════════════
# Helper utilities
# ══════════════════════════════════════════════════════════

def get_origin(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"

def get_path(url: str) -> str:
    p = urlparse(url)
    return p.path if p.path not in ("", "/") else ""

def extract_brand(url: str) -> str:
    """URL से brand name निकालो — subdomain और TLD हटाकर।"""
    try:
        hostname = urlparse(url).hostname or ""
        if not hostname:
            return ""
        parts = hostname.split(".")
        # co.uk, com.au जैसे compound TLDs
        if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "ac"}:
            return parts[-3]
        if len(parts) >= 2:
            return parts[-2]
        return parts[0]
    except Exception:
        return ""

def resolve_redirect(location: str, base_url: str) -> str:
    if location.startswith("http"):
        return location
    return urljoin(base_url, location)


# ══════════════════════════════════════════════════════════
# Phase 1: aiohttp quick check — async
# ══════════════════════════════════════════════════════════

async def aiohttp_check(session: aiohttp.ClientSession, url: str) -> dict:
    """
    Fast async HTTP check।
    Returns: {status, final_url, html, domain_changed, error}
    """
    current = url
    visited: set[str] = set()
    original_origin = get_origin(url)
    timeout = aiohttp.ClientTimeout(total=AIOHTTP_TIMEOUT)
    last_headers: dict = {}
    last_html = ""

    for hop in range(MAX_REDIRECTS):
        if current in visited:
            break
        visited.add(current)

        try:
            # HEAD पहले try करो (fast)
            async with session.request(
                "HEAD", current,
                timeout=timeout,
                allow_redirects=False,
                headers=HEADERS, ssl=False,
            ) as r:
                status = r.status
                last_headers = dict(r.headers)

            # HEAD fail (405) → GET try करो
            if status == 405:
                async with session.request(
                    "GET", current,
                    timeout=timeout,
                    allow_redirects=False,
                    headers=HEADERS, ssl=False,
                ) as r:
                    status = r.status
                    last_headers = dict(r.headers)
                    if status == 200:
                        last_html = await r.text(errors="ignore")

        except aiohttp.ClientConnectorError as e:
            return {"status": 0, "final_url": current, "html": "",
                    "domain_changed": False,
                    "error": f"DNS/Connection: {e}"}
        except asyncio.TimeoutError:
            return {"status": 0, "final_url": current, "html": "",
                    "domain_changed": False,
                    "error": "Timeout"}
        except Exception as e:
            return {"status": 0, "final_url": current, "html": "",
                    "domain_changed": False,
                    "error": str(e)}

        # Redirect follow करो
        if 300 <= status < 400:
            location = last_headers.get("location") or last_headers.get("Location", "")
            if location:
                next_url = resolve_redirect(location, current)
                current = next_url
                continue
            break

        # Final response
        if status == 200 and not last_html:
            # GET करो content के लिए
            try:
                async with session.request(
                    "GET", current,
                    timeout=timeout,
                    allow_redirects=False,
                    headers=HEADERS, ssl=False,
                ) as r:
                    last_html = await r.text(errors="ignore")
            except Exception:
                pass

        domain_changed = get_origin(current) != original_origin
        return {
            "status": status,
            "final_url": current,
            "html": last_html,
            "domain_changed": domain_changed,
            "error": None,
        }

    domain_changed = get_origin(current) != original_origin
    return {"status": 0, "final_url": current, "html": "",
            "domain_changed": domain_changed,
            "error": "Max redirects"}


# ══════════════════════════════════════════════════════════
# Phase 2: TLD Brute-Force — dead domain का सही TLD ढूँढो
# ══════════════════════════════════════════════════════════

async def discover_via_tld_bruteforce(
    session: aiohttp.ClientSession,
    name: str,
    brand: str,
    original_url: str,
) -> str | None:
    """
    Phase 2.5: TLD brute-force — same brand, different TLD try करो।

    Example: pixeldrain.de dead → try pixeldrain.com, .net, .dev, .io ...
    पहला valid domain return करो।
    """
    if not brand:
        return None

    original_path = get_path(original_url)
    original_host = urlparse(original_url).hostname or ""

    # Subdomain handling: www.brand.de → try www.brand.net etc.
    # brand.de → try brand.net
    host_parts = original_host.split(".")
    # Extract prefix (everything before brand + TLD)
    prefix_parts = []
    if len(host_parts) > 2:
        # e.g. new1.pixeldrain.de → prefix = "new1"
        for part in host_parts[:-2]:
            prefix_parts.append(part)
    prefix = ".".join(prefix_parts) + "." if prefix_parts else ""

    # Current TLD skip करो
    current_tld = host_parts[-1] if host_parts else ""

    candidates = []
    for tld in COMMON_TLDS:
        if tld == current_tld:
            continue
        candidate = f"https://{prefix}{brand}.{tld}"
        candidates.append(candidate)

    print(f"   🔀  Phase 2.5: TLD brute-force — {len(candidates)} TLDs testing for '{brand}'")

    # ── Strict domain verification ────────────────────
    # 100% verified: brand in title/h1/meta + minimum content + not parking
    def strict_verify(html: str, url: str, name: str, brand: str) -> bool:
        """
        100% strict verification — सिर्फ तभी True जब:
        1. Page parking/dead नहीं है
        2. Visible text >= 100 chars (real site, not placeholder)
        3. Brand name title/h1/meta/og:site_name में है
           (body text count ignore — domain name reference पकड़ता है)
        4. Content relevance — page looks like a similar type of site
           (has links, downloads, media embeds — not random unrelated site)
        """
        if not html or len(html) < 200:
            return False

        if is_parking_or_dead(html, url):
            return False

        try:
            # Parse on full html first for structural checks
            soup_full = BeautifulSoup(html, "html.parser")

            # 1. Brand or JSON Name MUST be in semantic elements
            brand_lower = brand.lower()
            name_lower = name.lower()
            found_brand = False

            def matches_name_or_brand(text: str) -> bool:
                t = text.lower()
                return brand_lower in t or name_lower in t

            # Title tag
            title_tag = soup_full.find("title")
            if title_tag and matches_name_or_brand(title_tag.get_text()):
                found_brand = True

            # h1 heading
            if not found_brand:
                h1 = soup_full.find("h1")
                if h1 and matches_name_or_brand(h1.get_text()):
                    found_brand = True

            # Meta description / og:site_name
            if not found_brand:
                for meta in soup_full.find_all("meta"):
                    content = (meta.get("content") or "").lower()
                    name_attr = (meta.get("name") or meta.get("property") or "").lower()
                    if name_attr in ("description", "og:site_name", "og:title",
                                     "application-name", "twitter:title"):
                        if matches_name_or_brand(content):
                            found_brand = True
                            break

            # h2/h3 as last resort
            if not found_brand:
                for h in soup_full.find_all(["h2", "h3"]):
                    if matches_name_or_brand(h.get_text()):
                        found_brand = True
                        break

            if not found_brand:
                return False

            # 2. Minimum visible content — strip scripts/styles
            soup_clean = BeautifulSoup(html, "html.parser")
            for tag in soup_clean.find_all(["script", "style"]):
                tag.decompose()
            visible_text = soup_clean.get_text(" ", strip=True)
            if len(visible_text) < 100:
                return False

            # 3. Content relevance check — replacement should be similar site type
            # All urls.json sites are streaming/movie/file-sharing/link sites
            # Must have relevant keywords or media embeds to prove content match
            has_media = bool(soup_full.find(["iframe", "video", "embed", "object"]))
            html_lower = html.lower()
            has_relevant_kw = any(kw in html_lower for kw in [
                "download", "stream", "movie", "drive", "cloud",
                "storage", "upload", "file", "server", "cdn",
                "watch", "episode", "season", "series",
            ])

            # Must have keywords OR media — link count alone is NOT enough
            # (unrelated sites like education portals also have many links)
            if not (has_media or has_relevant_kw):
                return False

            return True

        except Exception:
            return False

    # Async batch check — dedicated session to avoid main session bottleneck
    timeout = aiohttp.ClientTimeout(total=15)
    tld_sem = asyncio.Semaphore(10)  # Max 10 concurrent
    tld_connector = aiohttp.TCPConnector(ssl=False, limit=20)

    async def try_tld(tld_session: aiohttp.ClientSession, candidate_base: str) -> str | None:
        test_url = f"{candidate_base}{original_path}"
        async with tld_sem:
            try:
                # 1. Fetch with strict timeout
                status = 0
                html = ""
                async with tld_session.request(
                    "GET", test_url,
                    timeout=timeout,
                    allow_redirects=True,
                    headers=HEADERS, ssl=False,
                ) as r:
                    status = r.status
                    if status == 200:
                        html = await r.text(errors="ignore")

                # 2. Process outside the strict aiohttp timeout block
                if status == 200 and html:
                    if strict_verify(html, test_url, name, brand):
                        print(f"   ✅  TLD verified: {test_url}")
                        return test_url

                return None

            except Exception:
                return None

    # Run with dedicated session
    async with aiohttp.ClientSession(connector=tld_connector) as tld_session:
        tasks = [try_tld(tld_session, c) for c in candidates]
        results = await asyncio.gather(*tasks)

    # Return first verified result
    for result in results:
        if result:
            return result

    print(f"   ❌  TLD brute-force: कोई 100% verified TLD नहीं मिला")
    return None


# ══════════════════════════════════════════════════════════
# Phase 3: DuckDuckGo Discovery — dead domain के लिए
# ══════════════════════════════════════════════════════════

async def discover_new_domain(
    session: aiohttp.ClientSession,
    name: str,
    brand: str,
    original_url: str,
) -> str | None:
    """
    Phase 3: DuckDuckGo search से brand या name का सही current domain ढूँढो।

    Rule: सिर्फ वो domain accept करो जिसके hostname में brand या name हो।
    """
    if not brand and not name:
        return None

    original_path = get_path(original_url)
    original_origin = get_origin(original_url)
    loop = asyncio.get_running_loop()

    # DuckDuckGo HTML — bot-friendly endpoint, no JS needed
    # Search by JSON Key (name) instead of URL brand to get better results
    query = f"{name} official site" if name != brand else f"{brand} official site"
    search_url = f"https://html.duckduckgo.com/html/?q={query}"
    print(f"   🔍 DuckDuckGo: '{query}'")

    try:
        timeout = aiohttp.ClientTimeout(total=DDG_TIMEOUT)
        async with session.get(
            search_url, timeout=timeout, headers=HEADERS, ssl=False
        ) as resp:
            if resp.status not in (200, 202):
                print(f"   ⚠️  DDG returned status {resp.status}")
                return None
            html = await resp.text(errors="ignore")
    except Exception as e:
        print(f"   ⚠️  DDG error: {e}")
        return None

    soup = BeautifulSoup(html, "html.parser")
    brand_lower = brand.lower()
    name_lower = name.lower()
    candidates: list[str] = []

    # DDG HTML structure changes हो सकती है — generic approach:
    # सभी <a> tags + पूरी HTML में uddg= encoded links ढूँढो
    all_ddg_urls = re.findall(r"uddg=(https?(?:%3A|:)//[^&\"'\s]+)", html)

    for raw_url in all_ddg_urls:
        # URL decode (basic)
        from urllib.parse import unquote
        candidate_url = unquote(raw_url)
        chost = urlparse(candidate_url).hostname or ""

        # KEY RULE: brand या name का नाम domain में MANDATORY है
        if brand_lower not in chost.lower() and name_lower not in chost.lower():
            continue

        c_origin = get_origin(candidate_url)
        if c_origin == original_origin:
            continue
        if c_origin not in candidates:
            candidates.append(c_origin)

    if not candidates:
        print(f"   ❌ DDG: brand '{brand}' वाला कोई domain नहीं मिला")
        return None

    # Candidates verify करो
    for candidate_origin in candidates[:5]:
        test_url = f"{candidate_origin}{original_path}"
        print(f"   🔗 Verifying: {test_url}")

        result = await aiohttp_check(session, test_url)
        result_html = result.get("html", "")
        result_final = result.get("final_url", test_url)

        # Redirect → final check करो
        if result["domain_changed"] and result["status"] in (301, 302, 307, 308):
            final = f"{get_origin(result_final)}{original_path}"
            fr = await aiohttp_check(session, final)
            fhtml = fr.get("html", "")
            if (fr["status"] == 200
                    and not is_parking_or_dead(fhtml, final)
                    and brand_matches_content(fhtml, brand)):
                print(f"   ✅ Found (DDG + redirect): {final}")
                return final
            continue

        # Direct 200 + real content + brand confirmed
        if (result["status"] == 200
                and not is_parking_or_dead(result_html, test_url)
                and brand_matches_content(result_html, brand)):
            print(f"   ✅ Found (DDG): {test_url}")
            return test_url

    print(f"   ❌ कोई valid candidate नहीं मिला")
    return None


# ══════════════════════════════════════════════════════════
# Main: एक domain को process करो (3-phase)
# ══════════════════════════════════════════════════════════

DomainResult = dict

async def process_domain(
    session: aiohttp.ClientSession,
    name: str,
    url: str,
) -> DomainResult:
    print(f"\n{'═' * 60}")
    print(f"📋  {name}: {url}")
    print(f"{'─' * 60}")

    original_path = get_path(url)
    brand = extract_brand(url)

    # ── Phase 1: aiohttp quick check ──────────────────────
    r1 = await aiohttp_check(session, url)

    # Redirect → different domain
    if r1["domain_changed"] and r1["status"] > 0:
        new_url = f"{get_origin(r1['final_url'])}{original_path}"

        # ⚠️ Parking site redirect check — hugedomains, godaddy, sedo etc.
        if is_parking_redirect(r1["final_url"]):
            print(f"   ⚠️  Redirect → parking site ({get_origin(r1['final_url'])}) — expired domain!")
            # Treat as dead → TLD brute-force → DDG
            print(f"   🔀  Phase 2: TLD brute-force...")
            new_url = await discover_via_tld_bruteforce(session, name, brand, url)
            if new_url and new_url != url:
                print(f"   🔄  TLD brute-force found: {new_url}")
                return {"name": name, "old_url": url, "new_url": new_url,
                        "emoji": "🔄", "note": f"Expired (parking redirect) → TLD → {get_origin(new_url)}"}
            print(f"   🔍  Phase 3: DDG Discovery...")
            new_url = await discover_new_domain(session, name, brand, url)
            if new_url and new_url != url:
                print(f"   🔄  DDG found: {new_url}")
                return {"name": name, "old_url": url, "new_url": new_url,
                        "emoji": "🔄", "note": f"Expired (parking redirect) → DDG → {get_origin(new_url)}"}
            print(f"   ❌  Expired domain — no replacement found")
            if os.environ.get("GITHUB_ACTIONS"):
                builtins.print(f"::error title=Expired Domain::{name}: {url} → parking redirect, no replacement")
            return {"name": name, "old_url": url, "new_url": None,
                    "emoji": "❌", "note": f"Expired domain (→ parking site)"}

        # Brand verification on redirect target
        print(f"   🔄  Redirect detected → {new_url}")
        return {"name": name, "old_url": url, "new_url": new_url,
                "emoji": "🔄", "note": f"Redirect → {get_origin(r1['final_url'])}"}

    # 200 OK → parking check + BRAND VERIFICATION
    if r1["status"] == 200:
        html = r1["html"]

        if is_parking_or_dead(html, url):
            # ── Dead/Parking domain detected (200 OK but no real content) ──
            # Go directly to TLD brute-force → DDG discovery
            print(f"   ⚠️  Parking/dead page detected (200 OK but empty content)")
            print(f"   🔀  Phase 2: TLD brute-force...")
            new_url = await discover_via_tld_bruteforce(session, name, brand, url)
            if new_url and new_url != url:
                print(f"   🔄  TLD brute-force found: {new_url}")
                return {"name": name, "old_url": url, "new_url": new_url,
                        "emoji": "🔄", "note": f"Dead domain → TLD brute-force → {get_origin(new_url)}"}
            # TLD brute-force fail → DDG discovery
            print(f"   🔍  Phase 3: DDG Discovery...")
            new_url = await discover_new_domain(session, name, brand, url)
            if new_url and new_url != url:
                print(f"   🔄  DDG discovery found: {new_url}")
                return {"name": name, "old_url": url, "new_url": new_url,
                        "emoji": "🔄", "note": f"Dead domain → DDG → {get_origin(new_url)}"}
            # सब fail → flag as dead
            print(f"   ❌  Dead domain — no replacement found")
            if os.environ.get("GITHUB_ACTIONS"):
                builtins.print(f"::error title=Dead Domain::{name}: {url} — parking/dead page, no replacement found")
            return {"name": name, "old_url": url, "new_url": None,
                    "emoji": "❌", "note": f"Dead domain (parking/empty page)"}

        elif brand_matches_content(html, brand):
            # Real content + brand confirmed → ✅ Working
            print(f"   ✅  Working + brand '{brand}' confirmed")
            return {"name": name, "old_url": url, "new_url": None,
                    "emoji": "✅", "note": f"Working (brand confirmed)"}

        else:
            # 200 OK + real content + brand NOT found
            # Site is live but brand not in server-rendered HTML (JS app)
            # DON'T replace — just warn
            print(f"   ⚠️  200 OK, content real, brand '{brand}' not confirmed")
            print(f"   ✅  Working (content real, brand not confirmed)")
            if os.environ.get("GITHUB_ACTIONS"):
                builtins.print(f"::warning title=Brand Not Found::{name}: {url} — brand '{brand}' not in page (but site is live)")
            return {"name": name, "old_url": url, "new_url": None,
                    "emoji": "✅", "note": f"Working (brand not confirmed but site live)"}

    # If status is 4xx/5xx or 0 -> treat as dead/blocked and find new TLD
    # GitHub Actions gets 403/503 for Cloudflare challenges, which means it's blocked.
    if r1["status"] >= 400 or r1["status"] == 0:
        print(f"   ❓  Phase 1 failed (Status {r1['status']} / {r1['error']}) → TLD brute-force")

    # ── Phase 2: TLD Brute-Force (general failure path) ──
    print(f"   🔀  Phase 2: TLD brute-force...")
    new_url = await discover_via_tld_bruteforce(session, name, brand, url)
    if new_url and new_url != url:
        print(f"   🔄  TLD brute-force found: {new_url}")
        return {"name": name, "old_url": url, "new_url": new_url,
                "emoji": "🔄", "note": f"TLD brute-force → {get_origin(new_url)}"}

    # ── Phase 3: DuckDuckGo Discovery ─────────────────────
    print(f"   🔍  Phase 3: Domain discovery...")
    brand = extract_brand(url)
    new_url = await discover_new_domain(session, name, brand, url)

    if new_url and new_url != url:
        print(f"   🔄  Discovered new domain: {new_url}")
        return {"name": name, "old_url": url, "new_url": new_url,
                "emoji": "🔄", "note": f"Discovery → {get_origin(new_url)}"}

    # सब fail → original रखो
    error_note = r1["error"] or f"Status {r1['status']}"
    print(f"   ❌  Dead/unreachable — keeping original ({error_note})")
    if os.environ.get("GITHUB_ACTIONS"):
        builtins.print(f"::error title=Dead Domain::{name}: {url} — {error_note}")
    return {"name": name, "old_url": url, "new_url": None,
            "emoji": "❌", "note": f"Dead — {error_note}"}


# ══════════════════════════════════════════════════════════
# GitHub Actions Job Summary
# ══════════════════════════════════════════════════════════

def write_github_summary(results: list[DomainResult], updated: int) -> None:
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_file:
        return
    lines = [
        "## 🔄 URL Checker Results\n",
        f"**{updated} domain(s) updated**\n\n",
        "| Domain | Status | Old URL | New URL |",
        "|--------|--------|---------|---------|",
    ]
    for r in results:
        new = f"`{r['new_url']}`" if r["new_url"] else "—"
        lines.append(f"| `{r['name']}` | {r['emoji']} {r['note']} | `{r['old_url']}` | {new} |")
    with open(summary_file, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\n📋  GitHub Summary written")


# ══════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════

async def main() -> None:
    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║  Smart URL Checker v4 — Pure Async TLD Brute-Force + Discovery  ║")
    print("║  Phase1: aiohttp check | Phase2: TLD Brute-force | DDG Search   ║")
    print("╚═══════════════════════════════════════════════════════════════════╝")

    try:
        data: dict[str, str] = json.loads(FILE_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"❌ {FILE_PATH} error: {e}")
        sys.exit(1)

    entries = list(data.items())
    print(f"\n📊  Total domains: {len(entries)}\n")

    sem = asyncio.Semaphore(CONCURRENCY)
    connector = aiohttp.TCPConnector(ssl=False, limit=50, ttl_dns_cache=300)

    async with aiohttp.ClientSession(connector=connector) as session:

        async def bounded(name: str, url: str) -> DomainResult:
            async with sem:
                logs = []
                token = _log_ctx.set(logs)
                try:
                    res = await process_domain(session, name, url)
                    res["logs"] = logs
                    return res
                finally:
                    _log_ctx.reset(token)

        tasks = [bounded(name, url) for name, url in entries]
        results: list[DomainResult] = await asyncio.gather(*tasks)

    # Print logs sequentially
    for r in results:
        if "logs" in r:
            for line in r["logs"]:
                builtins.print(line)

    # Collect changes
    changes = [r for r in results if r["new_url"] and r["new_url"] != r["old_url"]]

    if changes:
        for r in changes:
            data[r["name"]] = r["new_url"]
            print(f"📝  [{r['name']}]: {r['old_url']} → {r['new_url']}")
        FILE_PATH.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"\n✅  urls.json updated ({len(changes)} changes)")
    else:
        print(f"\nℹ️  कोई बदलाव नहीं — urls.json unchanged")

    # Summary
    ok      = sum(1 for r in results if r["emoji"] == "✅")
    updated = len(changes)
    dead    = sum(1 for r in results if r["emoji"] == "❌")

    print(f"\n{'═' * 60}")
    print(f"📊  Summary:")
    print(f"   ✅  Working   : {ok}")
    print(f"   🔄  Updated   : {updated}")
    print(f"   ❌  Dead/unreachable: {dead}")
    print(f"{'═' * 60}")

    write_github_summary(results, updated)


if __name__ == "__main__":
    asyncio.run(main())
