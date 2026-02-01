const axios = require('axios');
const { createComponentLogger } = require('../config/logger');

const logger = createComponentLogger('APIMonitor');

/**
 * Check if Shopee API is accessible
 */
async function checkShopee() {
    try {
        const start = Date.now();
        const response = await axios.get('https://shopee.com.br', {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const latency = Date.now() - start;
        
        const online = response.status >= 200 && response.status < 300;
        logger.debug(`Shopee check: ${online ? 'online' : 'offline'} (${latency}ms)`);
        
        return { online, latency, error: null };
    } catch (err) {
        logger.error(`Shopee check failed: ${err.message}`);
        return { online: false, latency: null, error: err.message };
    }
}

/**
 * Check if Mercado Livre API is accessible
 */
async function checkMercadoLivre() {
    try {
        const start = Date.now();
        const response = await axios.get('https://www.mercadolivre.com.br', {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const latency = Date.now() - start;
        
        const online = response.status >= 200 && response.status < 300;
        logger.debug(`Mercado Livre check: ${online ? 'online' : 'offline'} (${latency}ms)`);
        
        return { online, latency, error: null };
    } catch (err) {
        logger.error(`Mercado Livre check failed: ${err.message}`);
        return { online: false, latency: null, error: err.message };
    }
}

/**
 * Check if AliExpress API is accessible
 */
async function checkAliExpress() {
    try {
        const start = Date.now();
        const response = await axios.get('https://www.aliexpress.com', {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const latency = Date.now() - start;
        
        const online = response.status >= 200 && response.status < 300;
        logger.debug(`AliExpress check: ${online ? 'online' : 'offline'} (${latency}ms)`);
        
        return { online, latency, error: null };
    } catch (err) {
        logger.error(`AliExpress check failed: ${err.message}`);
        return { online: false, latency: null, error: err.message };
    }
}

/**
 * Check if Amazon is accessible
 */
async function checkAmazon() {
    try {
        const start = Date.now();
        const response = await axios.get('https://www.amazon.com.br', {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const latency = Date.now() - start;
        
        const online = response.status >= 200 && response.status < 300;
        logger.debug(`Amazon check: ${online ? 'online' : 'offline'} (${latency}ms)`);
        
        return { online, latency, error: null };
    } catch (err) {
        logger.error(`Amazon check failed: ${err.message}`);
        return { online: false, latency: null, error: err.message };
    }
}

/**
 * Check if Google Gemini API is accessible
 */
async function checkGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        logger.warn('Gemini API key not configured');
        return { online: false, latency: null, error: 'API key not configured' };
    }
    
    try {
        const start = Date.now();
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
                contents: [{
                    parts: [{ text: 'test' }]
                }]
            },
            {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            }
        );
        const latency = Date.now() - start;
        
        const online = response.status >= 200 && response.status < 300;
        logger.debug(`Gemini check: ${online ? 'online' : 'offline'} (${latency}ms)`);
        
        return { online, latency, error: null };
    } catch (err) {
        // Gemini might return 400 for invalid request, but that means API is accessible
        if (err.response && err.response.status === 400) {
            const latency = Date.now() - start;
            logger.debug(`Gemini check: online (${latency}ms) - API responded with 400 (accessible)`);
            return { online: true, latency, error: null };
        }
        
        logger.error(`Gemini check failed: ${err.message}`);
        return { online: false, latency: null, error: err.message };
    }
}

/**
 * Check all APIs in parallel
 */
async function checkAllAPIs() {
    logger.debug('Starting API health checks...');
    
    const [shopee, ml, ali, amazon, gemini] = await Promise.all([
        checkShopee(),
        checkMercadoLivre(),
        checkAliExpress(),
        checkAmazon(),
        checkGemini()
    ]);
    
    const result = {
        shopee,
        ml,
        ali,
        amazon,
        ai: gemini,
        timestamp: new Date().toISOString()
    };
    
    logger.debug('API health checks completed');
    return result;
}

module.exports = {
    checkShopee,
    checkMercadoLivre,
    checkAliExpress,
    checkAmazon,
    checkGemini,
    checkAllAPIs
};
