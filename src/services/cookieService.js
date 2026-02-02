/**
 * Cookie Capture Service
 * Captures cookies from Mercado Livre and Amazon using visible browser
 * User logs in manually, then clicks to capture cookies
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { createComponentLogger } = require('../config/logger');

const logger = createComponentLogger('CookieService');

// Cookie storage file
const COOKIES_FILE = path.join(__dirname, '../../data/captured_cookies.json');
const DATA_DIR = path.join(__dirname, '../../data');

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
 * Ensure data directory exists
 */
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
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
 * Get cookie status
 */
function getStatus() {
    return {
        mercadolivre: {
            hasCookies: !!cookieCache.mercadolivre,
            lastUpdated: cookieCache.lastUpdated.mercadolivre,
            browserOpen: !!mlBrowser,
            cookiePreview: cookieCache.mercadolivre 
                ? cookieCache.mercadolivre.substring(0, 50) + '...' 
                : null
        },
        amazon: {
            hasCookies: !!cookieCache.amazon,
            lastUpdated: cookieCache.lastUpdated.amazon,
            browserOpen: !!amazonBrowser,
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
        if (mlBrowser) {
            await mlBrowser.close().catch(() => {});
        }
        
        console.log('[CookieService] 🚀 Abrindo navegador para Mercado Livre...');
        
        mlBrowser = await puppeteer.launch({
            headless: false, // VISIBLE browser
            defaultViewport: { width: 1280, height: 800 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
        
        const page = await mlBrowser.newPage();
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Navigate to ML
        await page.goto('https://www.mercadolivre.com.br/', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        console.log('[CookieService] 📱 Navegador aberto! Faça login no Mercado Livre...');
        
        return {
            success: true,
            message: 'Navegador aberto! Faça login no Mercado Livre e depois clique em "Capturar Cookies".',
            platform: 'mercadolivre'
        };
        
    } catch (err) {
        logger.error('Error starting ML login:', err.message);
        console.error('[CookieService] ❌ Erro:', err.message);
        throw err;
    }
}

/**
 * Capture cookies from Mercado Livre after login
 */
async function captureMercadoLivreCookies() {
    try {
        if (!mlBrowser) {
            throw new Error('Navegador não está aberto. Clique em "Abrir Navegador" primeiro.');
        }
        
        const pages = await mlBrowser.pages();
        const page = pages[pages.length - 1];
        
        // Get current URL
        const currentUrl = page.url();
        console.log(`[CookieService] 📍 URL atual: ${currentUrl}`);
        
        if (!currentUrl.includes('mercadolivre.com.br')) {
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
        
        // Save to file
        saveCookies();
        
        // Close browser
        await mlBrowser.close();
        mlBrowser = null;
        
        console.log('[CookieService] ✅ Cookies do Mercado Livre salvos!');
        
        return {
            success: true,
            message: `Cookies capturados com sucesso! (${cookies.length} cookies)`,
            cookieCount: cookies.length
        };
        
    } catch (err) {
        logger.error('Error capturing ML cookies:', err.message);
        throw err;
    }
}

/**
 * Start Amazon login - opens browser for manual login
 */
async function startAmazonLogin() {
    try {
        // Close existing browser if any
        if (amazonBrowser) {
            await amazonBrowser.close().catch(() => {});
        }
        
        console.log('[CookieService] 🚀 Abrindo navegador para Amazon...');
        
        amazonBrowser = await puppeteer.launch({
            headless: false, // VISIBLE browser
            defaultViewport: { width: 1280, height: 800 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security'
            ]
        });
        
        const page = await amazonBrowser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Navigate to Amazon BR
        await page.goto('https://www.amazon.com.br/', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        console.log('[CookieService] 📱 Navegador aberto! Faça login na Amazon...');
        
        return {
            success: true,
            message: 'Navegador aberto! Faça login na Amazon e depois clique em "Capturar Cookies".',
            platform: 'amazon'
        };
        
    } catch (err) {
        logger.error('Error starting Amazon login:', err.message);
        console.error('[CookieService] ❌ Erro:', err.message);
        throw err;
    }
}

/**
 * Capture cookies from Amazon after login
 */
async function captureAmazonCookies() {
    try {
        if (!amazonBrowser) {
            throw new Error('Navegador não está aberto. Clique em "Abrir Navegador" primeiro.');
        }
        
        const pages = await amazonBrowser.pages();
        const page = pages[pages.length - 1];
        
        const currentUrl = page.url();
        console.log(`[CookieService] 📍 URL atual: ${currentUrl}`);
        
        if (!currentUrl.includes('amazon.com.br')) {
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
        
        // Save
        cookieCache.amazon = cookieString;
        cookieCache.lastUpdated.amazon = new Date().toISOString();
        process.env.AMAZON_COOKIES = cookieString;
        
        saveCookies();
        
        // Close browser
        await amazonBrowser.close();
        amazonBrowser = null;
        
        console.log('[CookieService] ✅ Cookies da Amazon salvos!');
        
        return {
            success: true,
            message: `Cookies capturados com sucesso! (${cookies.length} cookies)`,
            cookieCount: cookies.length
        };
        
    } catch (err) {
        logger.error('Error capturing Amazon cookies:', err.message);
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
                await mlBrowser.close();
                mlBrowser = null;
                console.log('[CookieService] 🔴 Navegador ML fechado');
            }
        }
        if (platform === 'amazon') {
            if (amazonBrowser) {
                await amazonBrowser.close();
                amazonBrowser = null;
                console.log('[CookieService] 🔴 Navegador Amazon fechado');
            }
        }
        if (platform === 'all') {
            if (mlBrowser) { await mlBrowser.close(); mlBrowser = null; }
            if (amazonBrowser) { await amazonBrowser.close(); amazonBrowser = null; }
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
 * Manually set cookies (paste from browser)
 */
function setManualCookies(platform, cookieString) {
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
    return { success: true, message: 'Cookies salvos com sucesso' };
}

// Load cookies on startup
loadSavedCookies();

module.exports = {
    getStatus,
    startMercadoLivreLogin,
    captureMercadoLivreCookies,
    startAmazonLogin,
    captureAmazonCookies,
    cancelLogin,
    clearCookies,
    setManualCookies,
    loadSavedCookies
};
