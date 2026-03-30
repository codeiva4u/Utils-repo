const fs = require('fs');
const axios = require('axios');

const FILE_PATH = 'urls.json';
const BASELINE_PATH = 'urls-baseline.json';

// ═══════════════════════════════════════════════════════════════
// Upstream repos to sync from
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

// Common TLDs for domain recovery (ordered by priority)
const RECOVERY_TLDS = [
    '.io', '.app', '.dev', '.online', '.space', '.live', '.site',
    '.com', '.net', '.org', '.to', '.cc', '.fo', '.dad', '.foo',
    '.fun', '.ink', '.vip', '.pics', '.click', '.lol', '.direct',
    '.watch', '.movie', '.autos', '.frl', '.blue', '.link',
    '.vodka', '.restaurant', '.top', '.company', '.ltd', '.im',
    '.fit', '.llc', '.cv', '.zip', '.shop', '.fans', '.cloud',
    '.my', '.in', '.co', '.xyz', '.pro', '.me', '.tv', '.is',
    '.fi', '.it', '.de'
];

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function readJson(path) {
    try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function getDomain(url) {
    try { return new URL(url).origin; }
    catch { return url; }
}

function getFullPath(url) {
    try {
        const u = new URL(url);
        let r = u.origin;
        if (u.pathname && u.pathname !== '/') r += u.pathname;
        return r;
    } catch { return url; }
}

function hasTrailingSlash(url) {
    return url.endsWith('/') && !url.endsWith('://');
}

function preserveTrailingSlash(newUrl, originalUrl) {
    const needs = hasTrailingSlash(originalUrl);
    const has = hasTrailingSlash(newUrl);
    if (needs && !has) return newUrl + '/';
    if (!needs && has) return newUrl.slice(0, -1);
    return newUrl;
}

function getTld(hostname) {
    const p = hostname.split('.');
    return '.' + p[p.length - 1];
}

function getBaseHostname(hostname) {
    const p = hostname.split('.');
    return p.slice(0, -1).join('.');
}

function isAdOrTrackerUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        const path = u.pathname.toLowerCase();
        const adDomains = ['bonuscaf.com','clickhubz.com','adshort.co','shrinkme.io','linkvertise.com','ouo.io','ouo.press','bit.ly','tinyurl.com','shorte.st','adf.ly','za.gl','bc.vc','exe.io','gplinks.co','shrinkforearn.in','techymozo.com','adrinolinks.in','link1s.com','earnhub.net','hugedomains.com','sedo.com','afternic.com','dan.com','bodis.com','parkingcrew.net','domainmarket.com','undeveloped.com','domainlore.com','namesilo.com'];
        if (adDomains.some(ad => host === ad || host.endsWith('.' + ad))) return true;
        if ([/^\/go\//i,/^\/redirect\//i,/^\/out\//i,/^\/link\//i,/^\/click\//i,/^\/track\//i,/^\/aff\//i].some(p => p.test(path))) return true;
        return false;
    } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════
// Network helpers
// ═══════════════════════════════════════════════════════════════

async function isUrlAlive(url) {
    for (const method of ['head', 'get']) {
        try {
            await axios[method](url, {
                timeout: 15000, maxRedirects: 5,
                validateStatus: () => true,
                headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }
            });
            return true;
        } catch (e) {
            if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') return false;
        }
    }
    return false;
}

async function fetchUpstreamUrls() {
    const merged = {};
    for (const source of UPSTREAM_SOURCES) {
        try {
            const r = await axios.get(source.url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (r.status === 200 && r.data) {
                const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
                for (const [key, url] of Object.entries(data)) {
                    merged[key.toLowerCase()] = { url, source: source.name };
                }
                console.log(`📦 Fetched ${Object.keys(data).length} URLs from ${source.name}`);
            }
        } catch (e) {
            console.log(`⚠️ Failed to fetch from ${source.name}: ${e.message}`);
        }
    }
    return merged;
}

// ═══════════════════════════════════════════════════════════════
// LAYER 1: Upstream Sync
// ═══════════════════════════════════════════════════════════════

async function syncFromUpstream(providers, upstreamUrls, updatedKeys) {
    let changes = 0;
    for (const [name, currentUrl] of Object.entries(providers)) {
        const up = upstreamUrls[name.toLowerCase()];
        if (!up) continue;
        if (getDomain(up.url) !== getDomain(currentUrl)) {
            const alive = await isUrlAlive(up.url);
            if (alive) {
                const newUrl = preserveTrailingSlash(getFullPath(up.url), currentUrl);
                providers[name] = newUrl;
                updatedKeys.add(name);
                changes++;
                console.log(`📥 SYNCED ${name}: ${currentUrl} → ${newUrl} (${up.source})`);
            } else {
                console.log(`⚠️ ${name}: upstream ${up.url} also dead`);
            }
        } else {
            console.log(`✅ ${name}: matches upstream`);
        }
    }
    return changes;
}

// ═══════════════════════════════════════════════════════════════
// LAYER 2: HTTP Redirect + JS Redirect
// ═══════════════════════════════════════════════════════════════

function extractJsRedirect(html) {
    if (!html || typeof html !== 'string') return null;
    for (const p of [
        /(?:window|document)\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
        /(?:window|document)\.location\.replace\s*\(\s*["']([^"']+)["']\s*\)/i,
        /location\.assign\s*\(\s*["']([^"']+)["']\s*\)/i,
    ]) {
        const m = html.match(p);
        if (m && m[1] && m[1].startsWith('http')) return m[1];
    }
    const meta = html.match(/<meta\s+http-equiv\s*=\s*["']refresh["']\s+content\s*=\s*["']\d+\s*;\s*url\s*=\s*([^"'\s>]+)["']/i);
    if (meta && meta[1] && meta[1].startsWith('http')) return meta[1];
    return null;
}

async function checkUrl(url) {
    try {
        const r = await axios.get(url, {
            maxRedirects: 10, timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept': 'text/html' },
            validateStatus: s => true,
        });
        const finalUrl = r.request?.res?.responseUrl || r.request?._redirectable?._currentUrl || url;
        if (getDomain(finalUrl) !== getDomain(url)) {
            if (isAdOrTrackerUrl(finalUrl)) { console.log(`🚫 ${url} → ad/tracker — ignoring`); return { newUrl: null, isDead: false }; }
            console.log(`🔄 ${url} redirected to ${finalUrl}`);
            return { newUrl: getFullPath(finalUrl), isDead: false };
        }
        if (r.status === 200 && r.data && typeof r.data === 'string') {
            const js = extractJsRedirect(r.data);
            if (js && getDomain(js) !== getDomain(url)) {
                if (isAdOrTrackerUrl(js)) { console.log(`🚫 ${url} JS → ad — ignoring`); }
                else { console.log(`🔀 ${url} JS redirect → ${js}`); return { newUrl: getFullPath(js), isDead: false }; }
            }
        }
        if (r.status === 200) { console.log(`✅ ${url} valid (200)`); return { newUrl: null, isDead: false }; }
        if (r.status >= 500) { console.log(`💀 ${url} server error ${r.status}`); return { newUrl: null, isDead: true }; }
        console.log(`⚠️ ${url} status ${r.status}`);
        return { newUrl: null, isDead: false };
    } catch (error) {
        try {
            const r = await axios.head(url, { maxRedirects: 10, timeout: 10000, validateStatus: s => true, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const finalUrl = r.request?.res?.responseUrl || r.request?._redirectable?._currentUrl || url;
            if (getDomain(finalUrl) !== getDomain(url)) {
                if (isAdOrTrackerUrl(finalUrl)) return { newUrl: null, isDead: false };
                console.log(`🔄 ${url} redirected → ${finalUrl}`);
                return { newUrl: getFullPath(finalUrl), isDead: false };
            }
            console.log(`✅ ${url} valid (${r.status} HEAD)`);
            return { newUrl: null, isDead: false };
        } catch (e2) {
            const dead = ['ENOTFOUND','ECONNREFUSED'].includes(error.code) || ['ENOTFOUND','ECONNREFUSED'].includes(e2?.code);
            if (dead) console.log(`❌ ${url} — DEAD`);
            else console.log(`❌ ${url} — ${error.code || error.message}`);
            return { newUrl: null, isDead: dead };
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// LAYER 3: Smart Domain Recovery (TLD brute-force)
// ═══════════════════════════════════════════════════════════════

async function recoverDomain(name, deadUrl) {
    try {
        const hostname = new URL(deadUrl).hostname;
        const currentTld = getTld(hostname);
        const baseHost = getBaseHostname(hostname);
        if (!baseHost) return null;

        console.log(`  🔧 Trying TLD variations for "${baseHost}" (dead: ${currentTld})`);

        for (const tld of RECOVERY_TLDS) {
            if (tld === currentTld) continue;
            const tryUrl = `https://${baseHost}${tld}`;
            try {
                await axios.head(tryUrl, { timeout: 4000, maxRedirects: 3, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0' } });
                console.log(`  ✅ RECOVERED ${name}: ${tryUrl}`);
                return tryUrl;
            } catch (e) {
                if (e.code !== 'ENOTFOUND' && e.code !== 'ECONNREFUSED') {
                    try {
                        await axios.get(tryUrl, { timeout: 4000, maxRedirects: 3, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0' } });
                        console.log(`  ✅ RECOVERED ${name}: ${tryUrl}`);
                        return tryUrl;
                    } catch {}
                }
            }
        }
        console.log(`  ❌ Could not recover ${name}`);
        return null;
    } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// LAYER 4: Baseline Protection
// If current URL differs from baseline and baseline is alive → revert
// This catches "alive but wrong" domains that other layers miss
// ═══════════════════════════════════════════════════════════════

async function baselineProtection(providers, baseline, updatedKeys) {
    if (!baseline) return 0;
    let changes = 0;

    for (const [name, currentUrl] of Object.entries(providers)) {
        // Skip if already fixed by layers 1-3
        if (updatedKeys.has(name)) continue;

        const baselineUrl = baseline[name];
        if (!baselineUrl) continue; // New key, no baseline

        // If current URL matches baseline, skip
        if (getDomain(currentUrl) === getDomain(baselineUrl)) continue;

        // Current URL differs from baseline — check if baseline is alive
        console.log(`🔍 ${name}: differs from baseline`);
        console.log(`   Current:  ${currentUrl}`);
        console.log(`   Baseline: ${baselineUrl}`);

        const baselineAlive = await isUrlAlive(baselineUrl);
        if (baselineAlive) {
            const newUrl = preserveTrailingSlash(baselineUrl, currentUrl);
            providers[name] = newUrl;
            updatedKeys.add(name);
            changes++;
            console.log(`🛡️ REVERTED ${name}: ${currentUrl} → ${newUrl} (baseline alive)`);
        } else {
            console.log(`⚠️ ${name}: baseline also dead, keeping current`);
        }
    }

    return changes;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
    const providers = readJson(FILE_PATH);
    if (!providers) { console.error('Cannot read ' + FILE_PATH); process.exit(1); }

    const baseline = readJson(BASELINE_PATH); // May be null on first run
    let hasChanges = false;
    const updatedKeys = new Set(); // Track all keys updated by any layer

    // ─── LAYER 1 ────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════');
    console.log('   LAYER 1: Upstream Sync');
    console.log('═══════════════════════════════════════════\n');

    const upstream = await fetchUpstreamUrls();
    const syncCount = await syncFromUpstream(providers, upstream, updatedKeys);
    if (syncCount > 0) { hasChanges = true; console.log(`\n📊 Synced ${syncCount} URL(s)\n`); }
    else console.log('\nℹ️ All match upstream\n');

    // ─── LAYER 2 ────────────────────────────────────────────────
    console.log('═══════════════════════════════════════════');
    console.log('   LAYER 2: HTTP Redirect Check');
    console.log('═══════════════════════════════════════════\n');

    const deadUrls = [];
    for (const [name, url] of Object.entries(providers)) {
        if (updatedKeys.has(name)) { console.log(`⏩ ${name} — synced`); continue; }
        console.log(`Checking ${name} (${url})...`);
        try {
            const { newUrl, isDead } = await checkUrl(url);
            if (newUrl) {
                const final = preserveTrailingSlash(newUrl, url);
                if (final !== url) { providers[name] = final; updatedKeys.add(name); hasChanges = true; console.log(`🔄 Updated ${name}: → ${final}`); }
            } else if (isDead) { deadUrls.push({ name, url }); }
        } catch (e) { console.log(`❌ ${name}: ${e.message}`); }
    }

    // ─── LAYER 3: Baseline Protection (for ALL changed URLs) ────
    console.log('\n═══════════════════════════════════════════');
    console.log('   LAYER 3: Baseline Protection');
    console.log('═══════════════════════════════════════════\n');

    if (baseline) {
        const revertCount = await baselineProtection(providers, baseline, updatedKeys);
        if (revertCount > 0) { hasChanges = true; console.log(`\n🛡️ Reverted ${revertCount} URL(s) to baseline\n`); }
        else console.log('ℹ️ All URLs match baseline\n');

        // Remove dead URLs that were fixed by baseline from the dead list
        const stillDead = deadUrls.filter(d => !updatedKeys.has(d.name));
        deadUrls.length = 0;
        deadUrls.push(...stillDead);
    } else {
        console.log('ℹ️ No baseline file found, creating initial baseline\n');
    }

    // ─── LAYER 4: TLD Recovery (ONLY for dead URLs not fixed by baseline)
    if (deadUrls.length > 0) {
        console.log('═══════════════════════════════════════════');
        console.log('   LAYER 4: Domain Recovery (TLD brute-force)');
        console.log('═══════════════════════════════════════════\n');
        console.log(`${deadUrls.length} dead URL(s) still need recovery...\n`);

        for (const { name, url } of deadUrls) {
            const recovered = await recoverDomain(name, url);
            if (recovered) {
                const final = preserveTrailingSlash(recovered, url);
                providers[name] = final; updatedKeys.add(name); hasChanges = true;
                console.log(`🔧 ${name}: ${url} → ${final}`);
            }
        }
    }

    // ─── Save changes ───────────────────────────────────────────
    console.log('═══════════════════════════════════════════');
    console.log('   Results');
    console.log('═══════════════════════════════════════════');

    if (hasChanges) {
        fs.writeFileSync(FILE_PATH, JSON.stringify(providers, null, 2) + '\n');
        console.log(`\n✅ Updated ${FILE_PATH}`);
    } else {
        console.log(`\nℹ️ No changes needed`);
    }

    // Always update baseline with current correct URLs
    // This ensures new keys and legitimate changes are saved
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(providers, null, 2) + '\n');
    console.log(`📋 Baseline updated`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
