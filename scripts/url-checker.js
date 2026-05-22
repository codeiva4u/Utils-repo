const fs = require('fs');
const path = require('path');
// Import connect from the local lib folder
const { connect } = require('../lib/index.js');

const FILE_PATH = path.join(__dirname, '../urls.json');

// Read the urls.json file
function readUrlsJson() {
  try {
    const data = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${FILE_PATH}:`, error);
    process.exit(1);
  }
}

// Extract domain (origin) from URL without trailing slash
function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.origin;
  } catch (error) {
    console.error(`Error parsing URL ${url}:`, error);
    return url;
  }
}

// Check if original URL has a trailing slash in path
function hasTrailingSlash(url) {
  return url.endsWith('/') && !url.endsWith('://');
}

/**
 * Checks a URL using the stealth browser. 
 * If navigation fails (site is dead), it performs a Google Search Fallback to find working mirrors.
 * Returns { url: string | null, page: Page }
 */
async function checkOrSearchUrl(page, name, url) {
  const context = page.context();
  try {
    console.log(`🔍 Navigating to ${url}...`);
    // Try to load the original URL
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    
    console.log('⏳ Waiting 5 seconds for Cloudflare/scripts to stabilize...');
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    return { url: finalUrl, page };
  } catch (error) {
    console.log(`⚠️ Navigation failed for ${name} (${url}): ${error.message}`);
    console.log(`🚀 Attempting Google Search Fallback to heal dead domain for "${name}"...`);
    
    // To clear the error state and pending chrome-error:// navigations,
    // we close the current page and open a fresh one.
    try {
      await page.close().catch(() => {});
    } catch (e) {}
    
    // Create a fresh new page
    page = await context.newPage();
    await page.waitForTimeout(500); // Give async event listeners a moment to set up overrides
    
    try {
      // 1. Go to Google
      console.log('🌐 Opening Google...');
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      
      // 2. Type search query using human-like interaction
      const searchSelector = 'textarea[name="q"], input[name="q"]';
      await page.waitForSelector(searchSelector, { timeout: 10000 });
      await page.realClick(searchSelector);
      
      const searchQuery = `${name} new domain mirror`;
      console.log(`✍️ Searching for: "${searchQuery}"`);
      await page.type(searchSelector, searchQuery, { delay: 100 });
      await page.keyboard.press('Enter');
      
      // 3. Wait for search results
      await page.waitForSelector('#search', { timeout: 10000 });
      await page.waitForTimeout(3000); // Let search results fully render
      
      // 4. Extract links from Google search results
      const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('#search a'));
        return anchors
          .map(a => a.href)
          .filter(href => href && href.startsWith('http') && !href.includes('google.com') && !href.includes('webcache.googleusercontent.com'));
      });
      
      // 5. Filter and get top 3 unique candidate domains
      const uniqueDomains = [];
      const excludedSubstrings = ['youtube.com', 'twitter.com', 'facebook.com', 'wikipedia.org', 'github.com', 'instagram.com', 'reddit.com', 'pinterest.com', 'linkedin.com'];
      for (const link of links) {
        try {
          const urlObj = new URL(link);
          const domain = urlObj.origin;
          const isExcluded = excludedSubstrings.some(d => domain.includes(d));
          if (!isExcluded && !uniqueDomains.includes(domain)) {
            uniqueDomains.push(domain);
            if (uniqueDomains.length >= 3) break;
          }
        } catch (e) {}
      }
      
      if (uniqueDomains.length === 0) {
        console.log(`❌ No candidate domains found in search results for "${name}".`);
        return { url: null, page };
      }
      
      console.log(`🎯 Identified ${uniqueDomains.length} mirror candidates from Google:`, uniqueDomains);
      
      // 6. Test candidates sequentially to find a working one
      for (const candidate of uniqueDomains) {
        console.log(`🧪 Testing candidate: ${candidate}...`);
        try {
          await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(5000);
          
          const loadedUrl = page.url();
          const pageTitle = await page.title();
          console.log(`   ✅ Successful! Title: "${pageTitle}"`);
          return { url: loadedUrl, page }; // Return the working new URL
        } catch (candidateError) {
          console.log(`   ❌ Candidate failed: ${candidateError.message}`);
          
          // Re-create a clean page for the next candidate to clear navigation queue
          try {
            await page.close().catch(() => {});
          } catch (e) {}
          page = await context.newPage();
          await page.waitForTimeout(500);
        }
      }
      
    } catch (searchError) {
      console.error(`❌ Google Search Fallback failed during search process:`, searchError.message);
    }
    
    return { url: null, page };
  }
}

async function main() {
  const providers = readUrlsJson();
  let hasChanges = false;

  const SKIP_KEYS = new Set(['nfmirror']);

  console.log('🚀 Starting Undetected Real Browser...');
  
  // Auto-detect CI environment (e.g. GitHub Actions) or HEADLESS env var to run headless
  const isHeadless = process.env.HEADLESS === 'true' || process.env.CI === 'true';
  console.log(`ℹ️ Headless Mode: ${isHeadless}`);

  // Initialize the stealth browser with turnstile auto-solving and ad blocking
  const { browser, page: defaultPage } = await connect({
    headless: isHeadless,
    turnstile: true, // Auto-solve Cloudflare Turnstile CAPTCHAs
  });

  let currentPage = defaultPage;

  try {
    for (const [name, url] of Object.entries(providers)) {
      if (SKIP_KEYS.has(name)) {
        console.log(`\n⏩ Skipping ${name} (${url}) as configured`);
        continue;
      }

      console.log(`\n🔍 Checking ${name} (${url})...`);

      try {
        const result = await checkOrSearchUrl(currentPage, name, url);
        currentPage = result.page;
        const resolvedUrl = result.url;
        
        if (resolvedUrl) {
          console.log(`📍 Resolved final URL: ${resolvedUrl}`);

          const originalDomain = getDomain(url);
          const newDomain = getDomain(resolvedUrl);

          if (originalDomain !== newDomain) {
            // Check if original URL had a trailing slash
            const needsTrailingSlash = hasTrailingSlash(url);
            
            let updatedUrl = newDomain;
            if (needsTrailingSlash) {
              updatedUrl += '/';
            }

            if (updatedUrl !== url) {
              providers[name] = updatedUrl;
              hasChanges = true;
              console.log(`✅ Updated ${name} URL from ${url} -> ${updatedUrl}`);
            }
          } else {
            console.log(`✅ ${name} is valid, no domain change detected.`);
          }
        } else {
          console.log(`⚠️ ${name} could not be resolved (both original URL and Google Fallback failed).`);
        }

      } catch (error) {
        console.error(`❌ Error during checking loop for ${name}:`, error.message);
      }
    }

    // Save changes to urls.json
    if (hasChanges) {
      fs.writeFileSync(FILE_PATH, JSON.stringify(providers, null, 2), 'utf8');
      console.log(`\n💾 Saved updated URLs back to ${FILE_PATH}`);
    } else {
      console.log('\nℹ️ No changes needed in urls.json');
    }

  } finally {
    console.log('\n🔒 Closing browser...');
    try {
      await currentPage.close().catch(() => {});
    } catch (e) {}
    await browser.close();
  }
}

main().catch(error => {
  console.error('Fatal error during execution:', error);
});
