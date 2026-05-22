const { checkTurnstile } = require('./turnstile.js');

async function pageController({ browser, page, proxy, turnstile }) {
    if (page._pageControllerApplied) return page;
    page._pageControllerApplied = true;

    let solveStatus = turnstile;

    page.on('close', () => {
        solveStatus = false;
    });

    async function turnstileSolver() {
        while (solveStatus) {
            await checkTurnstile({ page }).catch(() => { });
            await new Promise(r => setTimeout(r, 1000));
        }
        return;
    }

    if (solveStatus) {
        turnstileSolver();
    }

    // === POPUP AD BLOCKING ===
    const context = page.context();
    context.on('page', async (newPage) => {
        try {
            const opener = await newPage.opener();
            if (opener) {
                const url = newPage.url();
                const isAdPopup = url === 'about:blank' ||
                    url.includes('ad') ||
                    url.includes('pop') ||
                    url.includes('click') ||
                    url.includes('redirect') ||
                    url.includes('track');
                if (isAdPopup) {
                    await newPage.close().catch(() => { });
                    console.error('[popup-blocker] Blocked popup ad:', url.substring(0, 50));
                }
            }
        } catch (e) {
            // Ignore errors
        }
    });

    // NOTE: JS stealth overrides are commented out because Patchright natively handles automation hiding.
    // Manual JS overrides trigger Pixelscan fingerprint masking detectors.
    /*
    await page.addInitScript(() => {
        // ========== HARDWARE CONCURRENCY & DEVICE MEMORY FIX ==========
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 8,
            configurable: true
        });

        if ('deviceMemory' in navigator) {
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8,
                configurable: true
            });
        }
    });
    */

    return page;
}

module.exports = { pageController };