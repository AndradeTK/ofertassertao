const axios = require('axios');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');

const DEFAULT_TIMEOUT = 8000;

// Helper to check if a platform is enabled
function isPlatformEnabled(platform) {
    const envKey = `AFFILIATE_${platform.toUpperCase()}_ENABLED`;
    const value = process.env[envKey];
    // Default to true if not set, false if explicitly set to 'false' or '0'
    if (value === undefined || value === null || value === '') return true;
    return value !== 'false' && value !== '0';
}

// Helper to generate SHA256 signature for Shopee Open API
function generateShopeeSignature(appId, appSecret, timestamp, body) {
    // SHA256(appId + timestamp + bodyJSON + secretKey)
    const baseString = appId + timestamp + JSON.stringify(body) + appSecret;
    return crypto.createHash('sha256').update(baseString).digest('hex');
}

async function generateAffiliateLink(originalUrl) {
    try {
        const u = new URL(originalUrl);
        const host = u.hostname.toLowerCase();

        if (host.includes('shopee')) {
            if (!isPlatformEnabled('shopee')) {
                console.log('[Affiliate] Shopee desativado, retornando URL original');
                return { affiliateUrl: originalUrl, platform: 'shopee-disabled' };
            }
            const affiliateUrl = await getShopeeLink(originalUrl);
            return { affiliateUrl, platform: 'shopee' };
        }

        if (host.includes('mercadolivre') || host.includes('mercado-livre') || host.includes('mercadolibre')) {
            if (!isPlatformEnabled('ml')) {
                console.log('[Affiliate] Mercado Livre desativado, retornando URL original');
                return { affiliateUrl: originalUrl, platform: 'ml-disabled' };
            }
            const affiliateUrl = await getMercadoLivreLink(originalUrl);
            return { affiliateUrl, platform: 'mercadolivre' };
        }

        if (host.includes('aliexpress') || host.includes('alibaba')) {
            if (!isPlatformEnabled('aliexpress')) {
                console.log('[Affiliate] AliExpress desativado, retornando URL original');
                return { affiliateUrl: originalUrl, platform: 'aliexpress-disabled' };
            }
            const affiliateUrl = await getAliExpressLink(originalUrl);
            return { affiliateUrl, platform: 'aliexpress' };
        }

        if (host.includes('amazon') || host.includes('amzn')) {
            if (!isPlatformEnabled('amazon')) {
                console.log('[Affiliate] Amazon desativado, retornando URL original');
                return { affiliateUrl: originalUrl, platform: 'amazon-disabled' };
            }
            const affiliateUrl = await getAmazonLink(originalUrl);
            return { affiliateUrl, platform: 'amazon' };
        }

        return { affiliateUrl: originalUrl, platform: 'original' };
    } catch (err) {
        console.error('affiliateService error:', err.message || err);
        return { affiliateUrl: originalUrl, platform: 'error' };
    }
}

async function getShopeeLink(sourceUrl) {
    try {
        // Try Open API first if credentials are configured
        if (process.env.SHOPEE_APP_ID && process.env.SHOPEE_APP_SECRET) {
            try {
                const apiLink = await generateShopeeAffiliateLink(sourceUrl);
                if (apiLink) return apiLink;
            } catch (apiErr) {
                console.warn('Shopee Open API error:', apiErr.message);
            }
        }

        // NO FALLBACK - return original URL if API fails
        return sourceUrl;
    } catch (err) {
        console.error('Shopee affiliate error:', err.message || err);
        return sourceUrl;
    }
}

async function generateShopeeAffiliateLink(sourceUrl) {
    try {
        const appId = process.env.SHOPEE_APP_ID;
        const appSecret = process.env.SHOPEE_APP_SECRET;

        if (!appId || !appSecret) return null;

        const timestamp = Math.floor(Date.now() / 1000).toString();

        // GraphQL mutation to generate affiliate link
        const body = {
            query: `mutation {
                generateShortLink(input: {
                    originUrl: "${sourceUrl}",
                    subIds: []
                }) {
                    shortLink
                }
            }`
        };

        const signature = generateShopeeSignature(appId, appSecret, timestamp, body);

        const headers = {
            'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
            'Content-Type': 'application/json'
        };

        const response = await axios.post(
            'https://open-api.affiliate.shopee.com.br/graphql',
            body,
            { headers, timeout: DEFAULT_TIMEOUT }
        );

        if (response.data && response.data.data && response.data.data.generateShortLink) {
            return response.data.data.generateShortLink.shortLink;
        }

        return null;
    } catch (err) {
        console.error('generateShopeeAffiliateLink error:', err.message);
        return null;
    }
}

async function getMercadoLivreLink(sourceUrl) {
    try {
        const affiliateTag = process.env.ML_AFFILIATE_TAG || process.env.ML_AFFILIATE_ID;
        
        if (!affiliateTag) {
            console.warn('Mercado Livre Affiliate Tag not configured');
            return sourceUrl;
        }

        // Try to get short link via ML API if cookies are configured
        const mlCookies = process.env.ML_COOKIES;
        if (mlCookies) {
            try {
                const shortUrl = await getMercadoLivreShortLink(sourceUrl, affiliateTag, mlCookies);
                if (shortUrl) {
                    console.log(`[ML] Short link generated: ${shortUrl}`);
                    return shortUrl;
                }
            } catch (apiErr) {
                console.warn('[ML] Stripe API error:', apiErr.message);
            }
        }

        // Fallback: Add affiliate parameters to URL
        const url = new URL(sourceUrl);
        url.searchParams.set('matt_tool', affiliateTag);
        url.searchParams.set('matt_word', affiliateTag);
        
        return url.toString();
    } catch (err) {
        console.error('MercadoLivre affiliate error:', err.message || err);
        return sourceUrl;
    }
}

/**
 * Get Mercado Livre short link via Stripe API
 * Requires valid ML session cookies with CSRF token
 */
async function getMercadoLivreShortLink(originalUrl, tag, cookies) {
    try {
        // Extract CSRF token from cookies
        const csrfMatch = cookies.match(/_csrf=([^;]+)/);
        const csrfToken = csrfMatch ? csrfMatch[1] : null;
        
        if (!csrfToken) {
            console.warn('[ML] CSRF token not found in cookies');
            return null;
        }
        
        const apiUrl = 'https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/links';
        
        const response = await axios.post(apiUrl, {
            tag: tag,
            url: originalUrl
        }, {
            timeout: DEFAULT_TIMEOUT,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Content-Type': 'application/json',
                'Cookie': cookies,
                'Origin': 'https://www.mercadolivre.com.br',
                'Referer': originalUrl,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'x-csrf-token': csrfToken,
                'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
            }
        });
        
        if (response.data && response.data.short_url) {
            return response.data.short_url;
        }
        
        console.warn('[ML] Stripe API response invalid:', response.data);
        return null;
    } catch (err) {
        throw err;
    }
}

async function getAliExpressLink(sourceUrl) {
    try {
        const trackingId = process.env.ALIEXPRESS_TRACKING_ID;
        
        if (!trackingId) {
            console.warn('AliExpress tracking_id not configured, returning original URL');
            return sourceUrl;
        }

        // AliExpress affiliate links usando tracking ID na URL
        const url = new URL(sourceUrl);
        url.searchParams.set('aff_fcid', trackingId);
        url.searchParams.set('aff_platform', 'api');
        
        return url.toString();
    } catch (err) {
        console.error('AliExpress affiliate error:', err.message || err);
        return sourceUrl;
    }
}

async function getAmazonLink(sourceUrl) {
    try {
        const trackingId = process.env.AMAZON_TRACKING_ID || process.env.AMAZON_AFFILIATE_TAG;
        
        if (!trackingId) {
            console.warn('Amazon tracking_id not configured, returning original URL');
            return sourceUrl;
        }

        // Check if URL is already a short link (amzn.to) - these already have affiliate tag
        const urlLower = sourceUrl.toLowerCase();
        if (urlLower.includes('amzn.to/')) {
            console.log('[Amazon] URL já é um link curto (amzn.to), retornando original');
            return sourceUrl;
        }

        // Parse the Amazon URL
        const url = new URL(sourceUrl);
        
        // Remove existing tracking parameters if present
        url.searchParams.delete('tag');
        url.searchParams.delete('linkCode');
        url.searchParams.delete('linkId');
        url.searchParams.delete('ref_');
        
        // Add affiliate tag
        url.searchParams.set('tag', trackingId);
        url.searchParams.set('linkCode', 'sl2');
        url.searchParams.set('ref_', 'as_li_ss_tl');
        
        const longUrlWithTag = url.toString();
        
        // Try to get short link via SiteStripe API if cookies are configured
        const amazonCookies = process.env.AMAZON_COOKIES;
        if (amazonCookies) {
            try {
                const shortUrl = await getAmazonShortLink(longUrlWithTag, amazonCookies);
                if (shortUrl) {
                    console.log(`[Amazon] Short link generated: ${shortUrl}`);
                    return shortUrl;
                }
            } catch (apiErr) {
                console.warn('[Amazon] SiteStripe API error:', apiErr.message);
            }
        }
        
        // Fallback to long URL with tag
        return longUrlWithTag;
    } catch (err) {
        console.error('Amazon affiliate error:', err.message || err);
        return sourceUrl;
    }
}

/**
 * Get Amazon short link via SiteStripe API
 * Requires valid Amazon Associates session cookies
 */
async function getAmazonShortLink(longUrl, cookies) {
    try {
        const marketplaceId = '526970'; // Brazil marketplace
        
        const apiUrl = new URL('https://www.amazon.com.br/associates/sitestripe/getShortUrl');
        apiUrl.searchParams.set('longUrl', longUrl);
        apiUrl.searchParams.set('marketplaceId', marketplaceId);
        
        const response = await axios.get(apiUrl.toString(), {
            timeout: DEFAULT_TIMEOUT,
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cookie': cookies,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'Referer': 'https://www.amazon.com.br/',
                'X-Requested-With': 'XMLHttpRequest',
                'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
            }
        });
        
        if (response.data && response.data.ok && response.data.shortUrl) {
            return response.data.shortUrl;
        }
        
        console.warn('[Amazon] SiteStripe response invalid:', response.data);
        return null;
    } catch (err) {
        throw err;
    }
}

module.exports = { generateAffiliateLink, isPlatformEnabled };