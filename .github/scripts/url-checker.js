const fs = require('fs');
const axios = require('axios');

const FILE_PATH = 'urls.json';

// ═══════════════════════════════════════════════════════════════
// Upstream repos to sync from (actively maintained by others)
// ═══════════════════════════════════════════════════════════════
const UPSTREAM_SOURCES = [
    {
        name: 'phisher98/TVVVV',
        url: 'https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json'
    },
    {
        name: 'SaurabhKaperwan/Utils',
        url: 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/main/urls.json'
    }
];

// ═══════════════════════════════════════════════════════════════
// Keys to skip checking (stable services that don't change domains)
// ═══════════════════════════════════════════════════════════════
const SKIP_KEYS = new Set(['gofile', 'pixeldrain']);

// ═══════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════

function urlsJson() {
    try {
        const data = fs.readFileSync(FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error reading ${FILE_PATH}:`, error);
        process.exit(1);
    }
}

function getDomain(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin;
    } catch (error) {
        console.error(`Error parsing URL ${url}:`, error);
        return url;
    }
}

function getFullPath(url) {
    try {
        const urlObj = new URL(url);
        // Return origin + pathname (preserving subdomains and paths)
        let result = urlObj.origin;
        if (urlObj.pathname && urlObj.pathname !== '/') {
            result += urlObj.pathname;
        }
        return result;
    } catch (error) {
        return url;
    }
}

function hasTrailingSlash(url) {
    return url.endsWith('/') && !url.endsWith('://');
}

function preserveTrailingSlash(newUrl, originalUrl) {
    const needsSlash = hasTrailingSlash(originalUrl);
    const hasSlash = hasTrailingSlash(newUrl);
    if (needsSlash && !hasSlash) return newUrl + '/';
    if (!needsSlash && hasSlash) return newUrl.slice(0, -1);
    return newUrl;
}

// Detect ad/tracking/spam redirect URLs
function isAdOrTrackerUrl(url) {
    try {
        const urlObj = new URL(url);
        const host = urlObj.hostname.toLowerCase();
        const path = urlObj.pathname.toLowerCase();

        // Known ad/tracking domains
        const adDomains = [
            'bonuscaf.com', 'clickhubz.com', 'adshort.co', 'shrinkme.io',
            'linkvertise.com', 'ouo.io', 'ouo.press', 'bit.ly', 'tinyurl.com',
            'shorte.st', 'adf.ly', 'za.gl', 'bc.vc', 'exe.io',
            'gplinks.co', 'shrinkforearn.in', 'techymozo.com',
            'adrinolinks.in', 'link1s.com', 'earnhub.net'
        ];

        if (adDomains.some(ad => host === ad || host.endsWith('.' + ad))) {
            return true;
        }

        // Suspicious path patterns (ad redirects)
        const adPathPatterns = [
            /^\/go\//i,
            /^\/redirect\//i,
            /^\/out\//i,
            /^\/link\//i,
            /^\/click\//i,
            /^\/track\//i,
            /^\/aff\//i,
        ];

        if (adPathPatterns.some(p => p.test(path))) {
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
// LAYER 1: Upstream Sync
// Fetch latest URLs from phisher98 & SaurabhKaperwan repos
// ═══════════════════════════════════════════════════════════════

async function fetchUpstreamUrls() {
    const merged = {};

    for (const source of UPSTREAM_SOURCES) {
        try {
            const response = await axios.get(source.url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
                }
            });

            if (response.status === 200 && response.data) {
                const data = typeof response.data === 'string'
                    ? JSON.parse(response.data)
                    : response.data;

                for (const [key, url] of Object.entries(data)) {
                    // Store with lowercase key for case-insensitive matching
                    merged[key.toLowerCase()] = { url, source: source.name };
                }
                console.log(`📦 Fetched ${Object.keys(data).length} URLs from ${source.name}`);
            }
        } catch (error) {
            console.log(`⚠️ Failed to fetch from ${source.name}: ${error.message}`);
        }
    }

    return merged;
}

async function isUrlAlive(url) {
    // For upstream sync, we only need to know: does this domain EXIST?
    // Any HTTP response (even 403/503 Cloudflare) means domain is alive.
    // Only ENOTFOUND / ECONNREFUSED / timeout = truly dead.
    const methods = ['head', 'get'];
    for (const method of methods) {
        try {
            const response = await axios[method](url, {
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: () => true, // Accept ANY status
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
                }
            });
            // Got ANY response = domain is alive (even 403/503 Cloudflare)
            return true;
        } catch (error) {
            // ENOTFOUND = domain doesn't exist (truly dead)
            if (error.code === 'ENOTFOUND') return false;
            // ECONNREFUSED = server explicitly refusing (truly dead)
            if (error.code === 'ECONNREFUSED') return false;
            // Other errors (timeout, etc.) = try next method
        }
    }
    return false;
}

async function syncFromUpstream(providers, upstreamUrls, syncedKeys) {
    let changes = 0;

    for (const [name, currentUrl] of Object.entries(providers)) {
        if (SKIP_KEYS.has(name)) continue;

        const nameLC = name.toLowerCase();
        const upstream = upstreamUrls[nameLC];

        if (!upstream) continue; // This key doesn't exist in upstream

        const upstreamDomain = getDomain(upstream.url);
        const currentDomain = getDomain(currentUrl);

        // If upstream has a different domain
        if (upstreamDomain !== currentDomain) {
            // Verify the upstream URL is actually alive before updating
            const alive = await isUrlAlive(upstream.url);
            if (alive) {
                const newUrl = preserveTrailingSlash(getFullPath(upstream.url), currentUrl);
                providers[name] = newUrl;
                syncedKeys.add(name);
                changes++;
                console.log(`📥 SYNCED ${name}: ${currentUrl} → ${newUrl} (from ${upstream.source})`);
            } else {
                console.log(`⚠️ ${name}: upstream URL ${upstream.url} from ${upstream.source} is also dead, skipping`);
            }
        } else {
            console.log(`✅ ${name}: already matches upstream (${currentDomain})`);
        }
    }

    return changes;
}

// ═══════════════════════════════════════════════════════════════
// LAYER 2: HTTP Redirect Check + JS Redirect Detection
// For domains NOT found in upstream, do our own checking
// ═══════════════════════════════════════════════════════════════

function extractJsRedirect(html) {
    if (!html || typeof html !== 'string') return null;

    // Match: window.location = "url" / window.location.href = "url"
    // Match: document.location = "url" / document.location.href = "url"
    const jsPatterns = [
        /(?:window|document)\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
        /(?:window|document)\.location\.replace\s*\(\s*["']([^"']+)["']\s*\)/i,
        /location\.assign\s*\(\s*["']([^"']+)["']\s*\)/i,
    ];

    for (const pattern of jsPatterns) {
        const match = html.match(pattern);
        if (match && match[1] && match[1].startsWith('http')) {
            return match[1];
        }
    }

    // Match: <meta http-equiv="refresh" content="0;url=https://...">
    const metaPattern = /<meta\s+http-equiv\s*=\s*["']refresh["']\s+content\s*=\s*["']\d+\s*;\s*url\s*=\s*([^"'\s>]+)["']/i;
    const metaMatch = html.match(metaPattern);
    if (metaMatch && metaMatch[1] && metaMatch[1].startsWith('http')) {
        return metaMatch[1];
    }

    return null;
}

async function checkUrl(url) {
    // ─── Try 1: GET with follow redirects (catches full chain) ───
    try {
        const response = await axios.get(url, {
            maxRedirects: 10,
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            validateStatus: status => true,
            // Capture response URL after all redirects
            beforeRedirect: (options) => {
                // axios follows redirects automatically
            }
        });

        // Get the final URL after all redirects
        const finalUrl = response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl || url;
        const finalDomain = getDomain(finalUrl);
        const originalDomain = getDomain(url);

        // Check if domain changed via HTTP redirect chain
        if (finalDomain !== originalDomain) {
            if (isAdOrTrackerUrl(finalUrl)) {
                console.log(`🚫 ${url} redirected to ad/tracker: ${finalUrl} — ignoring`);
                return null;
            }
            console.log(`🔄 ${url} redirected to ${finalUrl}`);
            return getFullPath(finalUrl);
        }

        // If we got HTML, check for JS redirects in the body
        if (response.status === 200 && response.data && typeof response.data === 'string') {
            const jsRedirect = extractJsRedirect(response.data);
            if (jsRedirect) {
                const jsDomain = getDomain(jsRedirect);
                if (jsDomain !== originalDomain) {
                    if (isAdOrTrackerUrl(jsRedirect)) {
                        console.log(`🚫 ${url} JS redirect to ad/tracker: ${jsRedirect} — ignoring`);
                    } else {
                        console.log(`🔀 ${url} has JS redirect to ${jsRedirect}`);
                        return getFullPath(jsRedirect);
                    }
                }
            }
        }

        if (response.status === 200) {
            console.log(`✅ ${url} is valid (200 OK)`);
            return null;
        } else {
            console.log(`⚠️ ${url} returned status ${response.status}`);
            return null;
        }

    } catch (error) {
        // ─── Try 2: HEAD request as fallback ───
        try {
            const response = await axios.head(url, {
                maxRedirects: 10,
                timeout: 10000,
                validateStatus: status => true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
                }
            });

            const finalUrl = response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl || url;
            const finalDomain = getDomain(finalUrl);
            const originalDomain = getDomain(url);

            if (finalDomain !== originalDomain) {
                if (isAdOrTrackerUrl(finalUrl)) {
                    console.log(`🚫 ${url} redirected to ad/tracker: ${finalUrl} — ignoring`);
                    return null;
                }
                console.log(`🔄 ${url} redirected to ${finalUrl}`);
                return getFullPath(finalUrl);
            }

            if (response.status === 200) {
                console.log(`✅ ${url} is valid (200 OK via HEAD)`);
            } else {
                console.log(`⚠️ ${url} returned status ${response.status}`);
            }
            return null;

        } catch (headError) {
            // Both GET and HEAD failed
            if (error.code === 'ENOTFOUND' || headError?.code === 'ENOTFOUND') {
                console.log(`❌ ${url} — domain not found (dead)`);
            } else if (error.code === 'ECONNABORTED' || headError?.code === 'ECONNABORTED') {
                console.log(`⌛ ${url} — request timed out`);
            } else if (error.code === 'ECONNREFUSED' || headError?.code === 'ECONNREFUSED') {
                console.log(`❌ ${url} — connection refused`);
            } else {
                console.log(`❌ ${url} — error: ${error.message}`);
            }
            return null;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
    const providers = urlsJson();
    let hasChanges = false;

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('   LAYER 1: Upstream Sync');
    console.log('═══════════════════════════════════════════');
    console.log('');

    // Fetch upstream URLs
    const upstreamUrls = await fetchUpstreamUrls();
    const syncedKeys = new Set(); // Track which keys were synced
    const syncCount = await syncFromUpstream(providers, upstreamUrls, syncedKeys);
    if (syncCount > 0) {
        hasChanges = true;
        console.log(`\n📊 Synced ${syncCount} URL(s) from upstream\n`);
    } else {
        console.log('\nℹ️ All common URLs already match upstream\n');
    }

    console.log('═══════════════════════════════════════════');
    console.log('   LAYER 2: HTTP Redirect Check');
    console.log('═══════════════════════════════════════════');
    console.log('');

    // Check each URL for redirects (including ones already synced)
    for (const [name, url] of Object.entries(providers)) {
        if (SKIP_KEYS.has(name)) {
            console.log(`⏩ Skipping ${name} (${url}) — in skip list`);
            continue;
        }

        // Don't re-check URLs that were just synced from upstream
        if (syncedKeys.has(name)) {
            console.log(`⏩ Skipping ${name} — already synced from upstream`);
            continue;
        }

        console.log(`Checking ${name} (${url})...`);

        try {
            const newUrl = await checkUrl(url);
            if (newUrl) {
                const finalUrl = preserveTrailingSlash(newUrl, url);
                if (finalUrl !== url) {
                    providers[name] = finalUrl;
                    hasChanges = true;
                    console.log(`🔄 Updated ${name}: ${url} → ${finalUrl}`);
                }
            }
        } catch (error) {
            console.log(`❌ Error processing ${name}: ${error.message}`);
        }
    }

    // Write changes
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('   Results');
    console.log('═══════════════════════════════════════════');

    if (hasChanges) {
        const jsonString = JSON.stringify(providers, null, 2);
        fs.writeFileSync(FILE_PATH, jsonString + '\n');
        console.log(`\n✅ Updated ${FILE_PATH} with new URLs`);
    } else {
        console.log(`\nℹ️ No changes needed for ${FILE_PATH}`);
    }
}

main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
