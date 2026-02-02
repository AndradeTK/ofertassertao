/**
 * Cookie Capture Service
 * Captures cookies from Mercado Livre and Amazon using Chrome with persistent profile
 * User logs in manually, cookies are saved and reused across sessions
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { createComponentLogger } = require('../config/logger');
const { pool } = require('../config/db');

const logger = createComponentLogger('CookieService');

// Cookie storage file
const COOKIES_FILE = path.join(__dirname, '../../data/captured_cookies.json');
const DATA_DIR = path.join(__dirname, '../../data');
const CHROME_PROFILE_DIR = path.join(__dirname, '../../data/chrome-profile');

// Track browser instances
let mlBrowser = null;
let amazonBrowser = null;

// Cookie cache
let cookieCache = {
    mercadolivre: null,
    amazon: null,
    lastUpdated: {
        mercadolivre: null,
        amazon: null
    }
};

/**
 * Find Chrome executable path based on OS
 */
function findChromePath() {
    const os = require('os');
    const platform = os.platform();
    
    let possiblePaths = [];
    
    if (platform === 'win32') {
        possiblePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
            // Edge as fallback (Chromium-based)
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ];
    } else if (platform === 'darwin') {
        possiblePaths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        ];
    } else {
        // Linux
        possiblePaths = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium'
        ];
    }
    
    for (const chromePath of possiblePaths) {
        if (fs.existsSync(chromePath)) {
            console.log(`[CookieService] 🔍 Chrome encontrado: ${chromePath}`);
            return chromePath;
        }
    }
    
    console.log('[CookieService] ⚠️ Chrome não encontrado, usando Chromium do Puppeteer');
    return null;
}

/**
 * Ensure data directory exists
 */
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CHROME_PROFILE_DIR)) {
        fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
    }
}

/**
 * Load saved cookies from file
 */
function loadSavedCookies() {
    ensureDataDir();
    try {
        if (fs.existsSync(COOKIES_FILE)) {
            const data = fs.readFileSync(COOKIES_FILE, 'utf8');
            const saved = JSON.parse(data);
            cookieCache = { ...cookieCache, ...saved };
            logger.info('Cookies loaded from file');
            
            // Update process.env with saved cookies
            if (cookieCache.mercadolivre) {
                process.env.ML_COOKIES = cookieCache.mercadolivre;
            }
            if (cookieCache.amazon) {
                process.env.AMAZON_COOKIES = cookieCache.amazon;
            }
            
            return cookieCache;
        }
    } catch (err) {
        logger.warn('Could not load cookies file:', err.message);
    }
    return cookieCache;
}

/**
 * Save cookies to file
 */
function saveCookies() {
    ensureDataDir();
    try {
        fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookieCache, null, 2));
        logger.info('Cookies saved to file');
    } catch (err) {
        logger.error('Could not save cookies:', err.message);
    }
}

/**
 * Save cookies to database
 */
async function saveCookiesToDB(platform, cookieString) {
    try {
        const keyName = platform === 'mercadolivre' ? 'ML_COOKIES' : 'AMAZON_COOKIES';
        const lastUpdatedKey = platform === 'mercadolivre' ? 'ML_COOKIES_UPDATED' : 'AMAZON_COOKIES_UPDATED';
        const now = new Date().toISOString();
        
        // Check if key exists
        const [existing] = await pool.execute('SELECT id FROM config WHERE key_name = ? LIMIT 1', [keyName]);
        
        if (existing.length > 0) {
            await pool.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [cookieString, keyName]);
        } else {
            await pool.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', [keyName, cookieString]);
        }
        
        // Save last updated timestamp
        const [existingTs] = await pool.execute('SELECT id FROM config WHERE key_name = ? LIMIT 1', [lastUpdatedKey]);
        if (existingTs.length > 0) {
            await pool.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [now, lastUpdatedKey]);
        } else {
            await pool.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', [lastUpdatedKey, now]);
        }
        
        logger.info(`Cookies ${platform} saved to database`);
        console.log(`[CookieService] 💾 Cookies ${platform} salvos no banco de dados`);
        return true;
    } catch (err) {
        logger.error(`Could not save ${platform} cookies to DB:`, err.message);
        console.error(`[CookieService] ❌ Erro ao salvar cookies no banco:`, err.message);
        return false;
    }
}

/**
 * Load cookies from database
 */
async function loadCookiesFromDB() {
    try {
        // Load ML cookies
        const [mlRows] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['ML_COOKIES']);
        if (mlRows.length > 0 && mlRows[0].value_text) {
            cookieCache.mercadolivre = mlRows[0].value_text;
            process.env.ML_COOKIES = mlRows[0].value_text;
            
            // Load ML timestamp
            const [mlTs] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['ML_COOKIES_UPDATED']);
            if (mlTs.length > 0) {
                cookieCache.lastUpdated.mercadolivre = mlTs[0].value_text;
            }
        }
        
        // Load Amazon cookies
        const [amazonRows] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['AMAZON_COOKIES']);
        if (amazonRows.length > 0 && amazonRows[0].value_text) {
            cookieCache.amazon = amazonRows[0].value_text;
            process.env.AMAZON_COOKIES = amazonRows[0].value_text;
            
            // Load Amazon timestamp
            const [amazonTs] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['AMAZON_COOKIES_UPDATED']);
            if (amazonTs.length > 0) {
                cookieCache.lastUpdated.amazon = amazonTs[0].value_text;
            }
        }
        
        if (cookieCache.mercadolivre || cookieCache.amazon) {
            logger.info('Cookies loaded from database');
            console.log('[CookieService] 📥 Cookies carregados do banco de dados');
        }
        
        return cookieCache;
    } catch (err) {
        logger.warn('Could not load cookies from DB:', err.message);
        return cookieCache;
    }
}

/**
 * Launch browser with persistent profile
 */
async function launchBrowserWithProfile(platform) {
    ensureDataDir();
    
    const chromePath = findChromePath();
    const profileDir = path.join(CHROME_PROFILE_DIR, platform);
    
    // Ensure profile directory exists
    if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
    }
    
    const launchOptions = {
        headless: false, // VISIBLE browser
        defaultViewport: { width: 1280, height: 800 },
        userDataDir: profileDir, // Persistent profile - saves login state
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-popup-blocking',
            '--start-maximized'
        ],
        ignoreDefaultArgs: ['--enable-automation']
    };
    
    // Use Chrome if found, otherwise use bundled Chromium
    if (chromePath) {
        launchOptions.executablePath = chromePath;
        console.log(`[CookieService] 🌐 Usando Chrome: ${chromePath}`);
    } else {
        console.log('[CookieService] 🌐 Usando Chromium do Puppeteer');
    }
    
    console.log(`[CookieService] 📂 Perfil persistente: ${profileDir}`);
    
    const browser = await puppeteer.launch(launchOptions);
    
    // Anti-detection: Remove webdriver flag
    const pages = await browser.pages();
    for (const page of pages) {
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
            // Also override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => {
                if (parameters.name === 'notifications') {
                    return Promise.resolve({ state: Notification.permission });
                }
                return originalQuery(parameters);
            };
        });
    }
    
    return browser;
}

/**
 * Get cookie status
 */
function getStatus() {
    return {
        mercadolivre: {
            hasCookies: !!cookieCache.mercadolivre,
            lastUpdated: cookieCache.lastUpdated.mercadolivre,
            browserOpen: !!mlBrowser && mlBrowser.isConnected(),
            cookiePreview: cookieCache.mercadolivre 
                ? cookieCache.mercadolivre.substring(0, 50) + '...' 
                : null
        },
        amazon: {
            hasCookies: !!cookieCache.amazon,
            lastUpdated: cookieCache.lastUpdated.amazon,
            browserOpen: !!amazonBrowser && amazonBrowser.isConnected(),
            cookiePreview: cookieCache.amazon 
                ? cookieCache.amazon.substring(0, 50) + '...' 
                : null
        }
    };
}

/**
 * Start Mercado Livre login - opens browser for manual login
 */
async function startMercadoLivreLogin() {
    try {
        // Close existing browser if any
        if (mlBrowser && mlBrowser.isConnected()) {
            await mlBrowser.close().catch(() => {});
        }
        mlBrowser = null;
        
        console.log('[CookieService] 🚀 Abrindo navegador para Mercado Livre...');
        
        mlBrowser = await launchBrowserWithProfile('mercadolivre');
        
        const pages = await mlBrowser.pages();
        const page = pages[0] || await mlBrowser.newPage();
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Anti-detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        
        // Navigate to ML
        await page.goto('https://www.mercadolivre.com.br/', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        console.log('[CookieService] 📱 Navegador aberto! Faça login no Mercado Livre...');
        console.log('[CookieService] 💡 Seu login será mantido para a próxima vez!');
        
        return {
            success: true,
            message: 'Navegador aberto! Faça login no Mercado Livre e depois clique em "Capturar Cookies". Seu login será mantido para a próxima vez!',
            platform: 'mercadolivre'
        };
        
    } catch (err) {
        logger.error('Error starting ML login:', err.message);
        console.error('[CookieService] ❌ Erro:', err.message);
        mlBrowser = null;
        throw err;
    }
}

/**
 * Capture cookies from Mercado Livre after login
 */
async function captureMercadoLivreCookies() {
    try {
        if (!mlBrowser || !mlBrowser.isConnected()) {
            mlBrowser = null;
            throw new Error('Navegador não está aberto ou foi fechado. Clique em "Abrir Navegador" primeiro.');
        }
        
        const pages = await mlBrowser.pages();
        if (pages.length === 0) {
            throw new Error('Nenhuma página aberta no navegador.');
        }
        
        const page = pages[pages.length - 1];
        
        // Get current URL
        const currentUrl = await page.url();
        console.log(`[CookieService] 📍 URL atual: ${currentUrl}`);
        
        if (!currentUrl.includes('mercadolivre.com.br') && !currentUrl.includes('mercadolibre.com')) {
            throw new Error('Navegue para mercadolivre.com.br antes de capturar');
        }
        
        // Get all cookies
        const cookies = await page.cookies();
        
        if (cookies.length === 0) {
            throw new Error('Nenhum cookie encontrado. Navegue pelo site primeiro.');
        }
        
        // Format cookies as string
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        console.log(`[CookieService] 📊 ${cookies.length} cookies capturados do Mercado Livre`);
        
        // Save to cache and env
        cookieCache.mercadolivre = cookieString;
        cookieCache.lastUpdated.mercadolivre = new Date().toISOString();
        process.env.ML_COOKIES = cookieString;
        
        // Save to file and database
        saveCookies();
        await saveCookiesToDB('mercadolivre', cookieString);
        
        // Close browser
        try {
            await mlBrowser.close();
        } catch (e) {
            console.log('[CookieService] ⚠️ Browser já estava fechado');
        }
        mlBrowser = null;
        
        console.log('[CookieService] ✅ Cookies do Mercado Livre salvos!');
        
        return {
            success: true,
            message: `Cookies capturados com sucesso! (${cookies.length} cookies)`,
            cookieCount: cookies.length
        };
        
    } catch (err) {
        logger.error('Error capturing ML cookies:', err.message);
        // Clean up browser reference on error
        if (mlBrowser) {
            try {
                await mlBrowser.close();
            } catch (e) {}
            mlBrowser = null;
        }
        throw err;
    }
}

/**
 * Start Amazon login - opens browser for manual login
 */
async function startAmazonLogin() {
    try {
        // Close existing browser if any
        if (amazonBrowser && amazonBrowser.isConnected()) {
            await amazonBrowser.close().catch(() => {});
        }
        amazonBrowser = null;
        
        console.log('[CookieService] 🚀 Abrindo navegador para Amazon...');
        
        amazonBrowser = await launchBrowserWithProfile('amazon');
        
        const pages = await amazonBrowser.pages();
        const page = pages[0] || await amazonBrowser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Anti-detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        
        // Navigate to Amazon BR
        await page.goto('https://www.amazon.com.br/', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        console.log('[CookieService] 📱 Navegador aberto! Faça login na Amazon...');
        console.log('[CookieService] 💡 Seu login será mantido para a próxima vez!');
        
        return {
            success: true,
            message: 'Navegador aberto! Faça login na Amazon e depois clique em "Capturar Cookies". Seu login será mantido para a próxima vez!',
            platform: 'amazon'
        };
        
    } catch (err) {
        logger.error('Error starting Amazon login:', err.message);
        console.error('[CookieService] ❌ Erro:', err.message);
        amazonBrowser = null;
        throw err;
    }
}

/**
 * Capture cookies from Amazon after login
 */
async function captureAmazonCookies() {
    try {
        if (!amazonBrowser || !amazonBrowser.isConnected()) {
            amazonBrowser = null;
            throw new Error('Navegador não está aberto ou foi fechado. Clique em "Abrir Navegador" primeiro.');
        }
        
        const pages = await amazonBrowser.pages();
        if (pages.length === 0) {
            throw new Error('Nenhuma página aberta no navegador.');
        }
        
        const page = pages[pages.length - 1];
        
        const currentUrl = await page.url();
        console.log(`[CookieService] 📍 URL atual: ${currentUrl}`);
        
        if (!currentUrl.includes('amazon.com.br') && !currentUrl.includes('amazon.com')) {
            throw new Error('Navegue para amazon.com.br antes de capturar');
        }
        
        // Get all cookies
        const cookies = await page.cookies();
        
        if (cookies.length === 0) {
            throw new Error('Nenhum cookie encontrado. Navegue pelo site primeiro.');
        }
        
        // Format cookies
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        console.log(`[CookieService] 📊 ${cookies.length} cookies capturados da Amazon`);
        
        // Save to cache and env
        cookieCache.amazon = cookieString;
        cookieCache.lastUpdated.amazon = new Date().toISOString();
        process.env.AMAZON_COOKIES = cookieString;
        
        // Save to file and database
        saveCookies();
        await saveCookiesToDB('amazon', cookieString);
        
        // Close browser
        try {
            await amazonBrowser.close();
        } catch (e) {
            console.log('[CookieService] ⚠️ Browser já estava fechado');
        }
        amazonBrowser = null;
        
        console.log('[CookieService] ✅ Cookies da Amazon salvos!');
        
        return {
            success: true,
            message: `Cookies capturados com sucesso! (${cookies.length} cookies)`,
            cookieCount: cookies.length
        };
        
    } catch (err) {
        logger.error('Error capturing Amazon cookies:', err.message);
        // Clean up browser reference on error
        if (amazonBrowser) {
            try {
                await amazonBrowser.close();
            } catch (e) {}
            amazonBrowser = null;
        }
        throw err;
    }
}

/**
 * Cancel/close browser
 */
async function cancelLogin(platform) {
    try {
        if (platform === 'mercadolivre' || platform === 'ml') {
            if (mlBrowser) {
                try {
                    if (mlBrowser.isConnected()) {
                        await mlBrowser.close();
                    }
                } catch (e) {}
                mlBrowser = null;
                console.log('[CookieService] 🔴 Navegador ML fechado');
            }
        }
        if (platform === 'amazon') {
            if (amazonBrowser) {
                try {
                    if (amazonBrowser.isConnected()) {
                        await amazonBrowser.close();
                    }
                } catch (e) {}
                amazonBrowser = null;
                console.log('[CookieService] 🔴 Navegador Amazon fechado');
            }
        }
        if (platform === 'all') {
            if (mlBrowser) { 
                try { if (mlBrowser.isConnected()) await mlBrowser.close(); } catch (e) {}
                mlBrowser = null; 
            }
            if (amazonBrowser) { 
                try { if (amazonBrowser.isConnected()) await amazonBrowser.close(); } catch (e) {}
                amazonBrowser = null; 
            }
        }
        return { success: true, message: 'Navegador fechado' };
    } catch (err) {
        return { success: false, message: err.message };
    }
}

/**
 * Clear cookies for a platform
 */
function clearCookies(platform) {
    if (platform === 'mercadolivre' || platform === 'all') {
        cookieCache.mercadolivre = null;
        cookieCache.lastUpdated.mercadolivre = null;
        delete process.env.ML_COOKIES;
    }
    if (platform === 'amazon' || platform === 'all') {
        cookieCache.amazon = null;
        cookieCache.lastUpdated.amazon = null;
        delete process.env.AMAZON_COOKIES;
    }
    saveCookies();
    return { success: true, message: 'Cookies removidos' };
}

/**
 * Clear browser profile (forces new login next time)
 */
function clearBrowserProfile(platform) {
    try {
        const profileDir = path.join(CHROME_PROFILE_DIR, platform);
        if (fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true, force: true });
            console.log(`[CookieService] 🗑️ Perfil ${platform} removido`);
        }
        return { success: true, message: 'Perfil do navegador removido. O próximo login será como novo.' };
    } catch (err) {
        logger.error('Error clearing browser profile:', err.message);
        return { success: false, message: err.message };
    }
}

/**
 * Manually set cookies (paste from browser)
 */
async function setManualCookies(platform, cookieString) {
    if (!cookieString || cookieString.trim().length < 10) {
        throw new Error('Cookie string inválida');
    }
    
    if (platform === 'mercadolivre') {
        cookieCache.mercadolivre = cookieString.trim();
        cookieCache.lastUpdated.mercadolivre = new Date().toISOString();
        process.env.ML_COOKIES = cookieString.trim();
    } else if (platform === 'amazon') {
        cookieCache.amazon = cookieString.trim();
        cookieCache.lastUpdated.amazon = new Date().toISOString();
        process.env.AMAZON_COOKIES = cookieString.trim();
    } else {
        throw new Error('Plataforma inválida');
    }
    
    saveCookies();
    await saveCookiesToDB(platform, cookieString.trim());
    return { success: true, message: 'Cookies salvos com sucesso' };
}

// Load cookies on startup (from file first, then try database)
loadSavedCookies();

// Try to load from database after pool is ready (async)
setTimeout(async () => {
    try {
        await loadCookiesFromDB();
    } catch (err) {
        console.log('[CookieService] ⚠️ Could not load cookies from DB on startup');
    }
}, 2000);

module.exports = {
    getStatus,
    startMercadoLivreLogin,
    captureMercadoLivreCookies,
    startAmazonLogin,
    captureAmazonCookies,
    cancelLogin,
    clearCookies,
    clearBrowserProfile,
    setManualCookies,
    loadSavedCookies,
    loadCookiesFromDB,
    saveCookiesToDB
};
