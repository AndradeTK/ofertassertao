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

        // Unknown host: try to follow redirects to detect shorteners (e.g., tidd.ly, bit.ly, etc.)
        try {
            const resp = await axios.get(originalUrl, {
                maxRedirects: 10,
                timeout: DEFAULT_TIMEOUT,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                validateStatus: (status) => status < 400
            });

            const finalUrl = resp.request && resp.request.res && resp.request.res.responseUrl ? resp.request.res.responseUrl : resp.config && resp.config.url ? resp.config.url : null;
            if (finalUrl && finalUrl !== originalUrl) {
                try {
                    const finalHost = new URL(finalUrl).hostname.toLowerCase();
                    // If redirect leads to a supported platform, re-run generation for the final URL
                    if (finalHost.includes('shopee') || finalHost.includes('mercadolivre') || finalHost.includes('mercado-livre') || finalHost.includes('mercadolibre') || finalHost.includes('aliexpress') || finalHost.includes('amazon') || finalHost.includes('amzn')) {
                        return await generateAffiliateLink(finalUrl);
                    }
                } catch (e) {
                    // ignore
                }
            }
        } catch (e) {
            // ignore network errors when resolving shorteners
        }

        return { affiliateUrl: originalUrl, platform: 'original' };
    } catch (err) {
        console.error('affiliateService error:', err.message || err);
        return { affiliateUrl: originalUrl, platform: 'error' };
    }
}

async function getShopeeLink(sourceUrl) {
    try {
        // Check if this is a shortened affiliate link (s.shopee.com.br) - resolve it first
        let productUrl = sourceUrl;
        if (isShopeeAffiliateLink(sourceUrl)) {
            console.log(`[Shopee] 🔍 Detectado link de afiliado, resolvendo...`);
            try {
                productUrl = await resolveShopeeAffiliateLink(sourceUrl);
                console.log(`[Shopee] ✅ Link original do produto: ${productUrl}`);
            } catch (resolveErr) {
                console.warn(`[Shopee] ⚠️ Erro ao resolver link de afiliado: ${resolveErr.message}`);
            }
        }

        // Try Open API first if credentials are configured
        if (process.env.SHOPEE_APP_ID && process.env.SHOPEE_APP_SECRET) {
            try {
                const apiLink = await generateShopeeAffiliateLink(productUrl);
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

/**
 * Check if a Shopee URL is an affiliate link that needs to be resolved
 */
function isShopeeAffiliateLink(url) {
    const urlLower = url.toLowerCase();
    // Shortened affiliate links: s.shopee.com.br/...
    // These are affiliate short links that redirect to the product
    if (urlLower.includes('s.shopee.com')) return true;
    if (urlLower.includes('shp.ee/')) return true;
    return false;
}

/**
 * Resolve a Shopee affiliate link to get the original product URL
 * Validates the product ID matches to prevent wrong product redirects
 */
async function resolveShopeeAffiliateLink(affiliateUrl) {
    try {
        // Extract any product ID from the original URL for validation
        const originalMatch = affiliateUrl.match(/-i\.(\d+)\.(\d+)/) || affiliateUrl.match(/i\.(\d+)\.(\d+)/);
        const originalProductId = originalMatch ? originalMatch[2] : null;
        
        const response = await axios.get(affiliateUrl, {
            maxRedirects: 10,
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            validateStatus: (status) => status < 400
        });

        let finalUrl = response.request.res.responseUrl || response.config.url;
        
        if (finalUrl && finalUrl.includes('shopee.com.br')) {
            const u = new URL(finalUrl);
            
            // Validate the resolved URL has the same product ID (if we knew the original)
            const resolvedMatch = finalUrl.match(/-i\.(\d+)\.(\d+)/) || finalUrl.match(/i\.(\d+)\.(\d+)/);
            const resolvedProductId = resolvedMatch ? resolvedMatch[2] : null;
            
            // If we have both IDs and they don't match, the redirect went to wrong product
            if (originalProductId && resolvedProductId && originalProductId !== resolvedProductId) {
                console.warn(`[Shopee] ⚠️ Produto ID não confere! Original: ${originalProductId}, Resolvido: ${resolvedProductId}`);
                console.warn(`[Shopee] ⚠️ Retornando URL original para evitar troca de produto`);
                return affiliateUrl; // Return original to avoid wrong product
            }
            
            // Remove affiliate tracking parameters
            u.searchParams.delete('af_siteid');
            u.searchParams.delete('af_sub_siteid');
            u.searchParams.delete('af_click_lookback');
            u.searchParams.delete('pid');
            u.searchParams.delete('c');
            u.searchParams.delete('is_from_login');
            u.searchParams.delete('af_viewthrough_lookback');
            return u.toString();
        }
        
        return finalUrl || affiliateUrl;
    } catch (err) {
        console.warn(`[Shopee] Erro ao resolver link de afiliado: ${err.message}`);
        throw err;
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

        // Check if this is an affiliate link from another person (needs to be resolved)
        let productUrl = sourceUrl;
        if (isMLAffiliateLink(sourceUrl)) {
            console.log(`[ML] 🔍 Detectado link de afiliado de terceiros, resolvendo...`);
            try {
                const resolvedUrl = await resolveMLAffiliateLink(sourceUrl);
                if (resolvedUrl) {
                    productUrl = resolvedUrl;
                    console.log(`[ML] ✅ Link original do produto: ${productUrl}`);
                } else {
                    console.warn(`[ML] ⚠️ Não foi possível resolver para um link de produto válido`);
                    // Return original URL since we can't resolve it
                    return sourceUrl;
                }
            } catch (resolveErr) {
                console.warn(`[ML] ⚠️ Erro ao resolver link de afiliado: ${resolveErr.message}`);
                // Return original URL if resolution fails
                return sourceUrl;
            }
        }

        // Try to get short link via ML API if cookies are configured
        const mlCookies = process.env.ML_COOKIES;
        if (mlCookies) {
            try {
                const shortUrl = await getMercadoLivreShortLink(productUrl, affiliateTag, mlCookies);
                if (shortUrl) {
                    console.log(`[ML] Short link generated: ${shortUrl}`);
                    return shortUrl;
                }
            } catch (apiErr) {
                console.warn('[ML] Stripe API error:', apiErr.message);
            }
        }

        // Fallback: Add affiliate parameters to URL
        const url = new URL(productUrl);
        // Remove existing affiliate parameters first
        url.searchParams.delete('matt_tool');
        url.searchParams.delete('matt_word');
        url.searchParams.delete('DEAL_ID');
        url.searchParams.delete('tracking_id');
        // Add our affiliate tag
        url.searchParams.set('matt_tool', affiliateTag);
        url.searchParams.set('matt_word', affiliateTag);
        
        return url.toString();
    } catch (err) {
        console.error('MercadoLivre affiliate error:', err.message || err);
        return sourceUrl;
    }
}

/**
 * Check if a URL is a Mercado Livre affiliate link from another person
 */
function isMLAffiliateLink(url) {
    const urlLower = url.toLowerCase();
    
    // Common patterns for ML affiliate links:
    // - mercadolivre.com/sec/... (shortened affiliate links)
    // - mercadolivre.com/social/... (social/profile affiliate links)
    // - click1.mercadolivre.com.br/...
    // - mercadolivre.com.br/...?matt_tool=...
    // - http.mercadolivre.com/...
    
    if (urlLower.includes('/sec/')) return true;
    if (urlLower.includes('/social/')) return true;
    if (urlLower.includes('click1.mercadolivre')) return true;
    if (urlLower.includes('click.mercadolivre')) return true;
    if (urlLower.includes('http.mercadolivre')) return true;
    
    // Check for affiliate parameters from other people
    try {
        const u = new URL(url);
        if (u.searchParams.has('matt_tool') || u.searchParams.has('DEAL_ID')) {
            return true;
        }
    } catch (e) {
        // Invalid URL, not an affiliate link
    }
    
    return false;
}

/**
 * Resolve a Mercado Livre affiliate link to get the original product URL
 * Follows redirects until we reach the final product page
 */
async function resolveMLAffiliateLink(affiliateUrl) {
    try {
        // Follow redirects to get the final URL
        const response = await axios.get(affiliateUrl, {
            maxRedirects: 10,
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            validateStatus: (status) => status < 400 // Accept any non-error status
        });

        // Get the final URL after all redirects
        let finalUrl = response.request.res.responseUrl || response.config.url;
        
        // If axios didn't capture it, try from headers
        if (!finalUrl && response.headers.location) {
            finalUrl = response.headers.location;
        }
        
        // Check if the final URL is a valid product page
        // Valid ML product URLs contain /p/MLB or MLB- pattern
        const isValidProductUrl = finalUrl && (
            finalUrl.includes('/p/MLB') || 
            finalUrl.includes('MLB-') ||
            finalUrl.includes('/MLB') ||
            (finalUrl.includes('mercadolivre.com.br') && /\/[a-z-]+-MLB-\d+/.test(finalUrl))
        );
        
        // If it's not a product URL (e.g., /social/, /perfil/, etc.), try to extract from HTML
        if (!isValidProductUrl && response.data) {
            console.log('[ML] URL resolvida não é um produto, buscando link do produto no HTML...');
            const productUrlMatch = response.data.match(/https:\/\/(?:www\.)?mercadolivre\.com\.br\/[^"'\s]*MLB[^"'\s]*/i);
            if (productUrlMatch) {
                finalUrl = productUrlMatch[0];
                console.log(`[ML] Link do produto encontrado no HTML: ${finalUrl}`);
            } else {
                // Try another pattern - look for item link in og:url or canonical
                const ogUrlMatch = response.data.match(/<meta[^>]*property="og:url"[^>]*content="([^"]+)"/i);
                if (ogUrlMatch && ogUrlMatch[1].includes('MLB')) {
                    finalUrl = ogUrlMatch[1];
                    console.log(`[ML] Link do produto encontrado em og:url: ${finalUrl}`);
                } else {
                    const canonicalMatch = response.data.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i);
                    if (canonicalMatch && canonicalMatch[1].includes('MLB')) {
                        finalUrl = canonicalMatch[1];
                        console.log(`[ML] Link do produto encontrado em canonical: ${finalUrl}`);
                    } else {
                        console.warn('[ML] ⚠️ Não foi possível encontrar link de produto válido');
                        // Return null to indicate we couldn't resolve to a product
                        return null;
                    }
                }
            }
        }
        
        // Clean the URL - remove affiliate parameters
        if (finalUrl) {
            try {
                const u = new URL(finalUrl);
                // Remove common affiliate tracking parameters
                u.searchParams.delete('matt_tool');
                u.searchParams.delete('matt_word');
                u.searchParams.delete('DEAL_ID');
                u.searchParams.delete('tracking_id');
                u.searchParams.delete('reco_item_pos');
                u.searchParams.delete('reco_backend');
                u.searchParams.delete('reco_client');
                u.searchParams.delete('c_id');
                u.searchParams.delete('c_element_order');
                u.searchParams.delete('reco_backend_type');
                u.searchParams.delete('forceInApp');
                u.searchParams.delete('ref');
                
                return u.toString();
            } catch (e) {
                return finalUrl;
            }
        }
        
        return null;
    } catch (err) {
        // If redirect following fails, try with axios head request
        try {
            const headResponse = await axios.head(affiliateUrl, {
                maxRedirects: 10,
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (headResponse.request.res.responseUrl) {
                const u = new URL(headResponse.request.res.responseUrl);
                // Check if it's a valid product URL
                if (u.pathname.includes('/p/MLB') || u.pathname.includes('MLB-')) {
                    u.searchParams.delete('matt_tool');
                    u.searchParams.delete('matt_word');
                    u.searchParams.delete('DEAL_ID');
                    u.searchParams.delete('tracking_id');
                    return u.toString();
                }
            }
        } catch (headErr) {
            // Ignore head request errors
        }
        
        console.error('[ML] Erro ao resolver link de afiliado:', err.message);
        return null;
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

        let productUrl = sourceUrl;
        
        // Check if this is a shortened affiliate link (s.click.aliexpress.com, etc)
        if (isAliExpressAffiliateLink(sourceUrl)) {
            console.log(`[AliExpress] 🔍 Detectado link de afiliado, resolvendo...`);
            try {
                productUrl = await resolveAliExpressAffiliateLink(sourceUrl);
                console.log(`[AliExpress] ✅ Link original do produto: ${productUrl}`);
            } catch (resolveErr) {
                console.warn(`[AliExpress] ⚠️ Erro ao resolver link: ${resolveErr.message}`);
            }
        }

        // Try to get short link via AliExpress Portal API if cookies are configured
        const aliexpressCookies = process.env.ALIEXPRESS_COOKIES;
        if (aliexpressCookies) {
            try {
                const shortUrl = await getAliExpressShortLink(productUrl, trackingId, aliexpressCookies);
                if (shortUrl) {
                    console.log(`[AliExpress] Short link generated: ${shortUrl}`);
                    return shortUrl;
                }
            } catch (apiErr) {
                console.warn('[AliExpress] Portal API error:', apiErr.message);
            }
        }

        // Fallback: Add affiliate parameters to URL
        const url = new URL(productUrl);
        // Remove existing affiliate parameters
        url.searchParams.delete('aff_fcid');
        url.searchParams.delete('aff_platform');
        url.searchParams.delete('sk');
        url.searchParams.delete('aff_trace_key');
        // Add our affiliate tag
        url.searchParams.set('aff_fcid', trackingId);
        url.searchParams.set('aff_platform', 'api');
        
        return url.toString();
    } catch (err) {
        console.error('AliExpress affiliate error:', err.message || err);
        return sourceUrl;
    }
}

/**
 * Generate AliExpress affiliate short link using the Portal API with cookies
 * Uses the same endpoint as the web interface
 */
async function getAliExpressShortLink(originalUrl, trackingId, cookies) {
    try {
        // Build the API URL with query parameters
        const apiUrl = new URL('https://portals.aliexpress.com/tools/linkGenerate/generatePromotionLinkV2.htm');
        apiUrl.searchParams.set('shipTos', 'BR');
        apiUrl.searchParams.set('trackId', trackingId);
        apiUrl.searchParams.set('targetUrl', originalUrl);
        
        const response = await axios.get(apiUrl.toString(), {
            timeout: DEFAULT_TIMEOUT,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Cookie': cookies,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'Referer': 'https://portals.aliexpress.com/affiportals/web/link_generator.htm',
                'Origin': 'https://portals.aliexpress.com',
                'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'bx-v': '2.5.36'
            }
        });
        
        // Check for successful response
        if (response.data && response.data.success === true && response.data.code === '00') {
            if (response.data.data && response.data.data.shortLink) {
                return response.data.data.shortLink;
            }
        }
        
        console.warn('[AliExpress] Portal API response invalid:', response.data);
        return null;
    } catch (err) {
        throw err;
    }
}

/**
 * Check if an AliExpress URL is an affiliate link that needs to be resolved
 */
function isAliExpressAffiliateLink(url) {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('s.click.aliexpress')) return true;
    if (urlLower.includes('click.aliexpress')) return true;
    if (urlLower.includes('aff.aliexpress')) return true;
    if (urlLower.includes('/e/')) return true; // Short affiliate format
    return false;
}

/**
 * Resolve an AliExpress affiliate link to get the original product URL
 */
async function resolveAliExpressAffiliateLink(affiliateUrl) {
    try {
        const response = await axios.get(affiliateUrl, {
            maxRedirects: 10,
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            validateStatus: (status) => status < 400
        });

        let finalUrl = response.request.res.responseUrl || response.config.url;
        
        if (finalUrl && finalUrl.includes('aliexpress')) {
            const u = new URL(finalUrl);
            // Remove affiliate tracking parameters
            u.searchParams.delete('aff_fcid');
            u.searchParams.delete('aff_platform');
            u.searchParams.delete('sk');
            u.searchParams.delete('aff_trace_key');
            return u.toString();
        }
        
        return finalUrl || affiliateUrl;
    } catch (err) {
        throw err;
    }
}

async function getAmazonLink(sourceUrl) {
    try {
        const trackingId = process.env.AMAZON_TRACKING_ID || process.env.AMAZON_AFFILIATE_TAG;
        
        if (!trackingId) {
            console.warn('Amazon tracking_id not configured, returning original URL');
            return sourceUrl;
        }

        let productUrl = sourceUrl;
        
        // Check if URL is a short link (amzn.to) - needs to be resolved to get product URL
        const urlLower = sourceUrl.toLowerCase();
        if (urlLower.includes('amzn.to/') || urlLower.includes('a.co/')) {
            console.log('[Amazon] 🔍 Detectado link curto, resolvendo para URL do produto...');
            try {
                productUrl = await resolveAmazonShortLink(sourceUrl);
                console.log(`[Amazon] ✅ Link original do produto: ${productUrl}`);
            } catch (resolveErr) {
                console.warn(`[Amazon] ⚠️ Erro ao resolver link curto: ${resolveErr.message}`);
                // Can't resolve, return original
                return sourceUrl;
            }
        }

        // Parse the Amazon URL
        const url = new URL(productUrl);
        
        // Remove existing tracking parameters if present (from other affiliates)
        url.searchParams.delete('tag');
        url.searchParams.delete('linkCode');
        url.searchParams.delete('linkId');
        url.searchParams.delete('ref_');
        url.searchParams.delete('ref');
        url.searchParams.delete('psc');
        url.searchParams.delete('smid');
        
        // Add our affiliate tag
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
 * Resolve an Amazon short link (amzn.to, a.co) to get the full product URL
 */
async function resolveAmazonShortLink(shortUrl) {
    try {
        const response = await axios.get(shortUrl, {
            maxRedirects: 10,
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            validateStatus: (status) => status < 400
        });

        let finalUrl = response.request.res.responseUrl || response.config.url;
        
        if (finalUrl && (finalUrl.includes('amazon.com') || finalUrl.includes('amzn.'))) {
            return finalUrl;
        }
        
        return finalUrl || shortUrl;
    } catch (err) {
        throw err;
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