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
// Common TLDs used by movie/streaming sites (for domain recovery)
// ═══════════════════════════════════════════════════════════════
const RECOVERY_TLDS = [
    '.io', '.app', '.dev', '.online', '.space', '.live', '.site',
    '.com', '.net', '.org', '.to', '.cc', '.fo', '.dad', '.foo',
    '.fun', '.ink', '.vip', '.pics', '.click', '.lol', '.direct',
    '.watch', '.movie', '.autos', '.frl', '.blue', '.link',
    '.vodka', '.restaurant', '.top', '.company', '.ltd', '.im',
    '.fit', '.llc', '.cv', '.zip', '.shop', '.fans', '.cloud',
    '.my', '.in', '.co', '.xyz', '.pro', '.me', '.tv', '.is',
    '.fi', '.it'
];

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

// Get the TLD from a hostname (last part after the last dot)
function getTld(hostname) {
    const parts = hostname.split('.');
    return '.' + parts[parts.length - 1];
}

// Get base hostname without TLD
function getBaseHostname(hostname) {
    const parts = hostname.split('.');
    return parts.slice(0, -1).join('.');
}

// Detect ad/tracking/spam redirect URLs
function isAdOrTrackerUrl(url) {
    try {
        const urlObj = new URL(url);
        const host = urlObj.hostname.toLowerCase();
        const path = urlObj.pathname.toLowerCase();

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

        const adPathPatterns = [
            /^\/go\//i, /^\/redirect\//i, /^\/out\//i,
            /^\/link\//i, /^\/click\//i, /^\/track\//i, /^\/aff\//i,
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
// ═══════════════════════════════════════════════════════════════

async function fetchUpstreamUrls() {
    const merged = {};

    for (const source of UPSTREAM_SOURCES) {
        try {
            const response = await axios.get(source.url, {
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
            });

            if (response.status === 200 && response.data) {
                const data = typeof response.data === 'string'
                    ? JSON.parse(response.data)
                    : response.data;

                for (const [key, url] of Object.entries(data)) {
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
    // Any HTTP response (even 403/503 Cloudflare) = alive
    // Only ENOTFOUND / ECONNREFUSED = dead
    const methods = ['head', 'get'];
    for (const method of methods) {
        try {
            await axios[method](url, {
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: () => true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
                }
            });
            return true; // Got response = alive
        } catch (error) {
            if (error.code === 'ENOTFOUND') return false;
            if (error.code === 'ECONNREFUSED') return false;
            // timeout/other = try next method
        }
    }
    return false;
}

async function syncFromUpstream(providers, upstreamUrls, syncedKeys) {
    let changes = 0;

    for (const [name, currentUrl] of Object.entries(providers)) {
        const nameLC = name.toLowerCase();
        const upstream = upstreamUrls[nameLC];

        if (!upstream) continue;

        const upstreamDomain = getDomain(upstream.url);
        const currentDomain = getDomain(currentUrl);

        if (upstreamDomain !== currentDomain) {
            const alive = await isUrlAlive(upstream.url);
            if (alive) {
                const newUrl = preserveTrailingSlash(getFullPath(upstream.url), currentUrl);
                providers[name] = newUrl;
                syncedKeys.add(name);
                changes++;
                console.log(`📥 SYNCED ${name}: ${currentUrl} → ${newUrl} (from ${upstream.source})`);
            } else {
                console.log(`⚠️ ${name}: upstream ${upstream.url} also dead`);
            }
        } else {
            console.log(`✅ ${name}: matches upstream (${currentDomain})`);
        }
    }

    return changes;
}

// ═══════════════════════════════════════════════════════════════
// LAYER 2: HTTP Redirect Check + JS Redirect Detection
// ═══════════════════════════════════════════════════════════════

function extractJsRedirect(html) {
    if (!html || typeof html !== 'string') return null;

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

    const metaPattern = /<meta\s+http-equiv\s*=\s*["']refresh["']\s+content\s*=\s*["']\d+\s*;\s*url\s*=\s*([^"'\s>]+)["']/i;
    const metaMatch = html.match(metaPattern);
    if (metaMatch && metaMatch[1] && metaMatch[1].startsWith('http')) {
        return metaMatch[1];
    }

    return null;
}

// Returns: { newUrl, isDead }
async function checkUrl(url) {
    // ─── Try 1: GET with follow redirects ───
    try {
        const response = await axios.get(url, {
            maxRedirects: 10,
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            validateStatus: status => true,
        });

        const finalUrl = response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl || url;
        const finalDomain = getDomain(finalUrl);
        const originalDomain = getDomain(url);

        if (finalDomain !== originalDomain) {
            if (isAdOrTrackerUrl(finalUrl)) {
                console.log(`🚫 ${url} redirected to ad/tracker: ${finalUrl} — ignoring`);
                return { newUrl: null, isDead: false };
            }
            console.log(`🔄 ${url} redirected to ${finalUrl}`);
            return { newUrl: getFullPath(finalUrl), isDead: false };
        }

        if (response.status === 200 && response.data && typeof response.data === 'string') {
            const jsRedirect = extractJsRedirect(response.data);
            if (jsRedirect) {
                const jsDomain = getDomain(jsRedirect);
                if (jsDomain !== originalDomain) {
                    if (isAdOrTrackerUrl(jsRedirect)) {
                        console.log(`🚫 ${url} JS redirect to ad/tracker: ${jsRedirect} — ignoring`);
                    } else {
                        console.log(`🔀 ${url} has JS redirect to ${jsRedirect}`);
                        return { newUrl: getFullPath(jsRedirect), isDead: false };
                    }
                }
            }
        }

        if (response.status === 200) {
            console.log(`✅ ${url} is valid (200 OK)`);
            return { newUrl: null, isDead: false };
        } else if (response.status >= 500) {
            console.log(`💀 ${url} returned server error ${response.status} — marking for recovery`);
            return { newUrl: null, isDead: true };
        } else {
            console.log(`⚠️ ${url} returned status ${response.status}`);
        }
        return { newUrl: null, isDead: false };

    } catch (error) {
        // ─── Try 2: HEAD ───
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
                    return { newUrl: null, isDead: false };
                }
                console.log(`🔄 ${url} redirected to ${finalUrl}`);
                return { newUrl: getFullPath(finalUrl), isDead: false };
            }

            console.log(`✅ ${url} is valid (${response.status} via HEAD)`);
            return { newUrl: null, isDead: false };

        } catch (headError) {
            const isDead = (error.code === 'ENOTFOUND' || headError?.code === 'ENOTFOUND' ||
                            error.code === 'ECONNREFUSED' || headError?.code === 'ECONNREFUSED');

            if (error.code === 'ENOTFOUND' || headError?.code === 'ENOTFOUND') {
                console.log(`❌ ${url} — domain not found (DEAD)`);
            } else if (error.code === 'ECONNABORTED' || headError?.code === 'ECONNABORTED') {
                console.log(`⌛ ${url} — timed out`);
            } else if (error.code === 'ECONNREFUSED' || headError?.code === 'ECONNREFUSED') {
                console.log(`❌ ${url} — connection refused (DEAD)`);
            } else {
                console.log(`❌ ${url} — error: ${error.message}`);
            }
            return { newUrl: null, isDead };
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// LAYER 3: Smart Domain Recovery
// When domain is dead, try TLD variations to find the correct one
// ═══════════════════════════════════════════════════════════════

async function recoverDomain(name, deadUrl) {
    try {
        const urlObj = new URL(deadUrl);
        const hostname = urlObj.hostname;

        const currentTld = getTld(hostname);
        const baseHost = getBaseHostname(hostname);

        if (!baseHost) return null;

        console.log(`  🔧 Recovery: trying TLD variations for "${baseHost}" (was: ${currentTld})`);

        for (const tld of RECOVERY_TLDS) {
            if (tld === currentTld) continue; // skip dead TLD

            const tryHostname = baseHost + tld;
            const tryUrl = `${urlObj.protocol}//${tryHostname}`;

            try {
                const response = await axios.head(tryUrl, {
                    timeout: 4000,
                    maxRedirects: 3,
                    validateStatus: () => true,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
                    }
                });

                // Found a live domain!
                console.log(`  ✅ RECOVERED ${name}: ${tryUrl} (status: ${response.status})`);
                return tryUrl;
            } catch (error) {
                if (error.code !== 'ENOTFOUND') {
                    // Got some response (even error) = domain exists
                    // Try GET to confirm
                    try {
                        await axios.get(tryUrl, {
                            timeout: 4000,
                            maxRedirects: 3,
                            validateStatus: () => true,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
                            }
                        });
                        console.log(`  ✅ RECOVERED ${name}: ${tryUrl}`);
                        return tryUrl;
                    } catch {
                        // truly dead, continue
                    }
                }
                // ENOTFOUND = this TLD doesn't exist, try next
            }
        }

        console.log(`  ❌ Could not recover ${name} — no TLD variation worked`);
        return null;
    } catch (error) {
        return null;
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

    const upstreamUrls = await fetchUpstreamUrls();
    const syncedKeys = new Set();
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

    const deadUrls = []; // Track dead URLs for Layer 3

    for (const [name, url] of Object.entries(providers)) {
        if (syncedKeys.has(name)) {
            console.log(`⏩ Skipping ${name} — already synced from upstream`);
            continue;
        }

        console.log(`Checking ${name} (${url})...`);

        try {
            const result = await checkUrl(url);
            if (result.newUrl) {
                const finalUrl = preserveTrailingSlash(result.newUrl, url);
                if (finalUrl !== url) {
                    providers[name] = finalUrl;
                    hasChanges = true;
                    console.log(`🔄 Updated ${name}: ${url} → ${finalUrl}`);
                }
            } else if (result.isDead) {
                deadUrls.push({ name, url });
            }
        } catch (error) {
            console.log(`❌ Error processing ${name}: ${error.message}`);
        }
    }

    // ─── LAYER 3: Recover dead domains ───
    if (deadUrls.length > 0) {
        console.log('');
        console.log('═══════════════════════════════════════════');
        console.log('   LAYER 3: Smart Domain Recovery');
        console.log('═══════════════════════════════════════════');
        console.log('');
        console.log(`Found ${deadUrls.length} dead URL(s), attempting recovery...`);
        console.log('');

        for (const { name, url } of deadUrls) {
            const recovered = await recoverDomain(name, url);
            if (recovered) {
                const finalUrl = preserveTrailingSlash(recovered, url);
                providers[name] = finalUrl;
                hasChanges = true;
                console.log(`🔧 Recovered ${name}: ${url} → ${finalUrl}`);
            }
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
