const { chromium } = require("patchright");
const { createCursor } = require("ghost-cursor-patchright");
const { PlaywrightBlocker } = require("@ghostery/adblocker-playwright");
const { pageController } = require("./module/pageController.js");
const fs = require('fs');
const path = require('path');

let adBlockerInstance = null;
let adBlockerPromise = null;
function getAdBlocker() {
  if (!adBlockerPromise) {
    const cachePath = path.join(__dirname, 'adblocker.bin');
    adBlockerPromise = PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    }).then(blocker => {
      adBlockerInstance = blocker;
      return blocker;
    }).catch(err => {
      console.error('[adblocker] Failed to initialize adblocker:', err.message);
      return null;
    });
  }
  return adBlockerPromise;
}

function loadEnvFile() {
  const envPaths = [
    path.join(process.cwd(), '.env'),
  ];

  let currentDir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(currentDir, '.env');
    if (fs.existsSync(envPath) && !envPaths.includes(envPath)) {
      envPaths.push(envPath);
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  for (const envPath of envPaths) {
    try {
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        envContent.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            const value = valueParts.join('=').replace(/^["']|["']$/g, '');
            if (key && !process.env[key]) {
              process.env[key] = value;
            }
          }
        });
        break;
      }
    } catch (error) {
      // Silently ignore .env loading errors
    }
  }
}

loadEnvFile();

function getDefaultHeadless() {
  const envHeadless = process.env.HEADLESS;
  if (envHeadless !== undefined && envHeadless !== null && envHeadless !== '') {
    const value = envHeadless.toLowerCase().trim();
    return value === 'true' || value === '1' || value === 'yes';
  }
  // Auto-detect CI environments
  if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.TRAVIS || process.env.CIRCLECI) {
    return true;
  }
  // Auto-detect headless Linux environments without X11 or Wayland
  if (process.platform === 'linux') {
    const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
    if (!hasDisplay) {
      return true;
    }
  }
  return false;
}

function setupRealPage(browser, page) {
  if (page._setupApplied) return page;
  page._setupApplied = true;

  // Enable ad blocker
  if (adBlockerInstance) {
    adBlockerInstance.enableBlockingInPage(page).catch(() => {});
  } else {
    getAdBlocker().then(blocker => {
      if (blocker) {
        blocker.enableBlockingInPage(page).catch(() => {});
      }
    });
  }

  // Human-like smooth scrolling with 60FPS Cubic Ease-Out physics
  page.realScroll = async (deltaY, duration = 600) => {
    try {
      const stepDelay = 15; // ~60 FPS
      const steps = Math.max(10, Math.floor(duration / stepDelay));
      const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
      let currentScroll = 0;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const targetScroll = deltaY * easeOutCubic(t);
        const diff = targetScroll - currentScroll;
        await page.mouse.wheel(0, diff);
        currentScroll = targetScroll;
        await new Promise(r => setTimeout(r, stepDelay));
      }
    } catch (e) {
      // Fallback to native window scroll in case of wheel errors
      try {
        await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), deltaY);
      } catch (_) {}
    }
  };

  // Ghost Cursor integration - Bézier curve human-like mouse movement
  try {
    const cursor = createCursor(page);
    page.realCursor = {
      move: async (selector, options = {}) => {
        try {
          await cursor.actions.move(selector, options);
        } catch (e) {
          // Fallback to native hover if ghost-cursor fails
          try { await page.hover(selector); } catch (_) {}
        }
      }
    };
    page.realClick = async (selector, options = {}) => {
      try {
        await cursor.actions.click({ target: selector, ...options });
      } catch (e) {
        // Fallback to native click if ghost-cursor fails
        await page.click(selector, options);
      }
    };
  } catch (e) {
    // Fallback if ghost-cursor-patchright fails to initialize
    if (!page.realClick) {
      page.realClick = async (selector, options) => {
        await page.click(selector, options);
      };
    }
    if (!page.realCursor) {
      page.realCursor = {
        move: async (selector) => {
          try { await page.hover(selector); } catch (_) {}
        }
      };
    }
  }

  return page;

}

function getBraveExecutablePath() {
  if (process.env.BRAVE_PATH && fs.existsSync(process.env.BRAVE_PATH)) {
    return process.env.BRAVE_PATH;
  }

  const platform = process.platform;
  const { execSync } = require('child_process');

  // Try automatic scanning via CLI / registry query
  if (platform === 'win32') {
    const regQueries = [
      'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe" /ve',
      'reg query "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe" /ve',
      'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Brave-Browser\\shell\\open\\command" /ve'
    ];

    for (const cmd of regQueries) {
      try {
        const output = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const match = output.match(/REG_SZ\s+(.*)/);
        if (match && match[1]) {
          let p = match[1].trim().replace(/^"|"$/g, '');
          if (!p.toLowerCase().endsWith('.exe')) {
            const exeIndex = p.toLowerCase().indexOf('.exe');
            if (exeIndex !== -1) {
              p = p.substring(0, exeIndex + 4).replace(/^"|"$/g, '');
            }
          }
          if (fs.existsSync(p)) return p;
        }
      } catch (e) {}
    }

    try {
      const output = execSync('where brave.exe', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\r\n')[0];
      if (output && fs.existsSync(output)) return output;
    } catch (e) {}
  } else if (platform === 'darwin') {
    try {
      const output = execSync('mdfind "kMDItemCFBundleIdentifier == \'com.brave.Browser\'"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
      if (output) {
        const p = path.join(output, 'Contents', 'MacOS', 'Brave Browser');
        if (fs.existsSync(p)) return p;
      }
    } catch (e) {}
  } else {
    try {
      const output = execSync('which brave-browser || which brave', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (output && fs.existsSync(output)) return output;
    } catch (e) {}
  }

  // Fallback to hardcoded common paths
  let paths = [];
  if (platform === 'win32') {
    paths = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    ].filter(p => p);
  } else if (platform === 'darwin') {
    paths = [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    ];
  } else {
    paths = [
      '/usr/bin/brave-browser',
      '/usr/bin/brave',
      '/usr/bin/brave-browser-stable',
      '/usr/bin/brave-browser-beta',
      '/usr/bin/brave-browser-nightly',
      '/usr/local/bin/brave-browser',
      '/usr/local/bin/brave'
    ];
  }

  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

async function applyUserAgentOverride(page, userAgent, userAgentMetadata) {
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: userAgent,
      userAgentMetadata: userAgentMetadata
    });
  } catch (e) {
    // Ignore errors
  }
}

async function connect({
  args = [],
  headless = getDefaultHeadless(),
  proxy = {},
  turnstile = false,
  executablePath = undefined,
} = {}) {
  let playwrightProxy = undefined;
  if (proxy && proxy.host && proxy.port) {
    playwrightProxy = {
      server: `${proxy.host}:${proxy.port}`
    };
    if (proxy.username && proxy.password) {
      playwrightProxy.username = proxy.username;
      playwrightProxy.password = proxy.password;
    }
  }

  // 1. Launch a temporary browser to retrieve the native user agent and properties
  const tempBrowser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(executablePath ? { executablePath } : {}),
  });
  const tempContext = await tempBrowser.newContext();
  const tempPage = await tempContext.newPage();
  let nativeUa = '';
  let isBrave = false;
  try {
    nativeUa = await tempPage.evaluate(() => navigator.userAgent);
    isBrave = await tempPage.evaluate(() => typeof navigator.brave !== 'undefined');
  } catch (e) {
    nativeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36';
    isBrave = executablePath && executablePath.toLowerCase().includes('brave');
  }
  await tempBrowser.close();

  let modifiedUa = nativeUa.replace(/HeadlessChrome\//g, 'Chrome/');
  const chromeVersionMatch = modifiedUa.match(/Chrome\/([\d.]+)/);
  const chromeVersion = chromeVersionMatch ? chromeVersionMatch[1] : '148.0.0.0';
  const majorVersion = chromeVersion.split('.')[0];

  const brands = [
    { brand: 'Chromium', version: majorVersion },
    { brand: 'Not/A)Brand', version: '99' }
  ];
  if (isBrave) {
    brands.unshift({ brand: 'Brave', version: majorVersion });
  } else {
    brands.unshift({ brand: 'Google Chrome', version: majorVersion });
  }

  let platformName = 'Windows';
  if (nativeUa.includes('Macintosh') || nativeUa.includes('Mac OS X')) {
    platformName = 'macOS';
  } else if (nativeUa.includes('Linux')) {
    platformName = 'Linux';
  }

  const userAgentMetadata = {
    brands: brands,
    mobile: false,
    platform: platformName,
    platformVersion: platformName === 'macOS' ? '14.0.0' : platformName === 'Linux' ? '6.0.0' : '10.0.0',
    architecture: 'x86',
    model: '',
    bitness: '64',
    wow64: false
  };

  const chromiumArgs = [
    `--user-agent=${modifiedUa}`,
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    ...args
  ];

  // If headless is true, we run with headless: false but pass '--headless=new' to args.
  // This triggers Chromium's modern undetected headless mode instead of Playwright's default old headless shell.
  let launchHeadless = headless;
  if (headless === true) {
    launchHeadless = false;
    if (!chromiumArgs.includes('--headless=new')) {
      chromiumArgs.push('--headless=new');
    }
  }

  const browser = await chromium.launch({
    headless: launchHeadless,
    args: chromiumArgs,
    proxy: playwrightProxy,
    ...(executablePath ? { executablePath } : {}),
  });

  // Ensure ad blocker is ready
  await getAdBlocker();

  const context = await browser.newContext({
    viewport: null,
  });

  let page = await context.newPage();

  await applyUserAgentOverride(page, modifiedUa, userAgentMetadata);

  setupRealPage(browser, page);

  page = await pageController({
    browser,
    page,
    proxy,
    turnstile,
  });

  context.on('page', async (newPage) => {
    await applyUserAgentOverride(newPage, modifiedUa, userAgentMetadata);
    setupRealPage(browser, newPage);
    await pageController({
      browser,
      page: newPage,
      proxy,
      turnstile,
    });
  });

  return {
    browser,
    page,
  };
}

module.exports = { connect };
