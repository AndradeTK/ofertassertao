const crypto = require('crypto');
const { pool } = require('../config/db');
const redis = require('../config/redis');
const Category = require('../models/categoryModel');
const ForbiddenWords = require('../models/forbiddenWordsModel');
const PendingPromotions = require('../models/pendingPromotionsModel');
const ExcludedUrls = require('../models/excludedUrlsModel');
const { classifyAndCaption } = require('./aiService');
const { generateAffiliateLink } = require('./affiliateService');
const { fetchMetadata } = require('./metaService');
const { globalRateLimiter } = require('./rateLimiter');
const { createComponentLogger } = require('../config/logger');

const logger = createComponentLogger('PromotionFlow');

let bot = null;
let Config = null;
let wss = null; // WebSocket server instance

/**
 * Sanitize text to ensure valid UTF-8 encoding
 * Removes invalid characters that cause Telegram API errors
 * Preserves valid emojis and Unicode characters
 */
function sanitizeUtf8(text) {
    if (!text) return '';
    
    // Convert to string if not already
    let str = String(text);
    
    // Remove null bytes and other control characters (except newlines, tabs, carriage returns)
    str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    
    // Remove only truly invalid/unpaired surrogates
    // This regex finds lone high surrogates not followed by low surrogates
    // and lone low surrogates not preceded by high surrogates
    try {
        // Use a safer approach - encode to buffer and back
        str = Buffer.from(str, 'utf8').toString('utf8');
    } catch (e) {
        // If encoding fails, try character by character
        str = str.split('').filter(char => {
            const code = char.charCodeAt(0);
            // Keep valid characters including emojis
            return code < 0xD800 || code > 0xDFFF || (code >= 0xD800 && code <= 0xDBFF);
        }).join('');
    }
    
    // Normalize to NFC form (composed characters)
    try {
        str = str.normalize('NFC');
    } catch (e) {
        // If normalization fails, return as-is
    }
    
    return str;
}

// Initialize with bot instance (called from server.js)
function initializePromotionFlow(botInstance, ConfigModel, wsServer = null) {
    bot = botInstance;
    Config = ConfigModel;
    wss = wsServer;
}

/**
 * Broadcast message to all connected WebSocket clients
 */
function broadcastToClients(eventType, data) {
    if (!wss) return;
    
    const message = JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() });
    
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(message);
            } catch (err) {
                logger.warn(`WebSocket broadcast error: ${err.message}`);
            }
        }
    });
}

/**
 * Filter out unwanted URLs that are not affiliate store links
 * Removes Telegram links, bots, blogs, and other non-store URLs
 * Also checks database for custom excluded patterns
 */
async function filterAffiliateUrls(urls) {
    if (!urls || urls.length === 0) return [];
    
    // Base domains/patterns to exclude (hardcoded essentials)
    const baseExcludePatterns = [
        /t\.me\//i,                    // Telegram links
        /telegram\.(me|org)\//i,       // Telegram
        /wa\.me\//i,                   // WhatsApp
        /whatsapp\.com/i,              // WhatsApp
        /discord\.(gg|com)/i,          // Discord
        /ofertasertao/i,               // Our own group
        /_bot$/i,                      // Bot usernames
    ];
    
    // Get custom excluded patterns from database
    let customPatterns = [];
    try {
        const dbPatterns = await ExcludedUrls.getPatterns();
        customPatterns = dbPatterns.map(p => {
            try {
                return new RegExp(p, 'i');
            } catch (e) {
                // If not valid regex, create a simple pattern
                return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            }
        });
    } catch (err) {
        console.warn('[Filter] Error loading custom patterns:', err.message);
    }
    
    const excludePatterns = [...baseExcludePatterns, ...customPatterns];
    
    // Domains to ALWAYS include (affiliate stores)
    const includePatterns = [
        /shopee\.com/i,
        /mercadolivre\.com/i,
        /mercadolibre\.com/i,
        /amazon\.com/i,
        /amzn\.to/i,
        /amzn\.com/i,
        /aliexpress\.com/i,
        /s\.click\.aliexpress/i,
        /magazineluiza\.com/i,
        /magalu\.com/i,
        /casasbahia\.com/i,
        /americanas\.com/i,
        /submarino\.com/i,
        /kabum\.com/i,
        /pichau\.com/i,
        /terabyte\.com/i,
    ];
    
    return urls.filter(url => {
        const urlLower = url.toLowerCase();
        
        // First check if it's explicitly an affiliate store
        for (const pattern of includePatterns) {
            if (pattern.test(urlLower)) {
                return true; // Keep this URL
            }
        }
        
        // Then check if it should be excluded
        for (const pattern of excludePatterns) {
            if (pattern.test(urlLower)) {
                console.log(`[Filter] ❌ Excluindo URL não-afiliada: ${url.substring(0, 50)}...`);
                return false; // Exclude this URL
            }
        }
        
        // Default: keep URLs that look like they might be stores
        // (have /item/, /product/, /dp/, /p/, etc in path)
        if (/\/(item|product|dp|p|produto|oferta)s?\//i.test(urlLower)) {
            return true;
        }
        
        // Exclude if it doesn't look like a store URL
        console.log(`[Filter] ⚠️ URL desconhecida, mantendo: ${url.substring(0, 50)}...`);
        return true; // Keep by default, but log for debugging
    });
}

async function handlePromotionFlow(text, ctx = null, attachedPhotoUrl = null) {
    // Check rate limit (without consuming slot - we only consume when actually sending)
    if (!globalRateLimiter.checkLimit()) {
        const status = globalRateLimiter.getStatus();
        logger.warn(`Rate limit exceeded: ${status.current}/${status.max} messages in ${status.timeWindow}s`);
        throw new Error(`⏱️ Rate limit: aguarde ${status.timeWindow}s (${status.current}/${status.max} mensagens processadas)`);
    }

    // Extract ALL URLs from text
    const allUrls = text && text.match(/(https?:\/\/[^\s]+)/g);
    if (!allUrls || allUrls.length === 0) {
        logger.error('No URLs found in text');
        throw new Error('Nenhuma URL encontrada no texto');
    }
    
    // Filter out non-affiliate URLs (Telegram, blogs, etc)
    const urls = await filterAffiliateUrls(allUrls);
    if (urls.length === 0) {
        logger.warn('All URLs were filtered out (non-affiliate)');
        throw new Error('Nenhuma URL de loja afiliada encontrada (apenas links de Telegram/blogs)');
    }
    
    if (urls.length < allUrls.length) {
        console.log(`[Filter] 📊 URLs filtradas: ${allUrls.length} → ${urls.length} (removidas ${allUrls.length - urls.length} não-afiliadas)`);
    }

    // Check for forbidden words
    const forbiddenCheck = await ForbiddenWords.containsForbiddenWords(text);
    if (forbiddenCheck.hasForbidden) {
        logger.warn(`Forbidden words detected: ${forbiddenCheck.words.join(', ')}`);
        throw new Error(`🚫 Palavras proibidas detectadas: ${forbiddenCheck.words.join(', ')}`);
    }

    // Use first URL as key for deduplication
    const primaryUrl = urls[0];
    logger.info(`URLs encontradas: ${urls.length} - Primary: ${primaryUrl}`);
    console.log(`[1/8] URLs encontradas: ${urls.length} - Primary: ${primaryUrl}`);
    const key = 'promo:' + crypto.createHash('sha1').update(primaryUrl).digest('hex');

    try {
        console.log(`[2/8] Verificando duplicatas no Redis...`);
        let alreadyProcessing;
        try {
            // Use SETNX (SET if Not eXists) for atomic lock to prevent race conditions
            // This ensures only one processor (bot OR user account) handles this URL
            // Expiry: 3600 seconds (1 hour) - allows reposting after 1 hour
            alreadyProcessing = await Promise.race([
                redis.set(key, 'processing', 'EX', 3600, 'NX'), // 1h expiry, only set if not exists
                new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 3000))
            ]);
            // SETNX returns 'OK' if key was set (meaning we got the lock), null if key exists
            const gotLock = alreadyProcessing === 'OK';
            console.log(`[2/8] ✅ Redis check ok (got lock: ${gotLock})`);
            
            if (!gotLock) {
                logger.info(`Duplicate URL detected (already processed in last 1h), skipping: ${primaryUrl.substring(0, 50)}`);
                console.log(`[2/8] ⚠️ URL duplicada (processada na última 1h): ${primaryUrl.substring(0, 50)}...`);
                return { skipped: true, reason: 'duplicated' };
            }
        } catch (redisErr) {
            logger.warn(`Redis error: ${redisErr.message}`);
            console.warn(`[2/8] ⚠️ Redis error: ${redisErr.message}, continuando...`);
            // Continue anyway if Redis fails, but log a warning
        }

        console.log(`[3/8] Gerando links de afiliado para ${urls.length} URL(s)...`);
        const affiliateUrls = {};
        const platformsDetected = [];
        let hasRealAffiliate = false;
        
        for (let i = 0; i < urls.length; i++) {
            try {
                const { affiliateUrl, platform } = await generateAffiliateLink(urls[i]);
                affiliateUrls[urls[i]] = affiliateUrl;
                platformsDetected.push(platform);
                console.log(`[3/8] ✅ URL ${i+1}: ${platform} -> ${affiliateUrl}`);
                
                // Check if it's a real affiliate platform (not original, error, or disabled)
                if (!['original', 'error'].includes(platform) && !platform.endsWith('-disabled')) {
                    hasRealAffiliate = true;
                }
            } catch (linkErr) {
                logger.error(`Failed to generate affiliate link for ${urls[i]}`, { error: linkErr.message });
                // Continue with original URL if affiliate generation fails
                affiliateUrls[urls[i]] = urls[i];
                platformsDetected.push('error');
            }
        }

        // IMPORTANT: Replace all URLs in original text with their affiliate versions
        let processedText = text;
        for (const [originalUrl, affiliateUrl] of Object.entries(affiliateUrls)) {
            const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            processedText = processedText.replace(
                new RegExp(escapeRegex(originalUrl), 'g'),
                affiliateUrl
            );
        }
        
        // If no real affiliate links were generated, save to pending queue for manual approval
        if (!hasRealAffiliate) {
            logger.info('[3/8] ⚠️ No affiliate links generated - saving to pending queue');
            console.log(`[3/8] ⚠️ Nenhum link de afiliado - salvando para aprovação manual`);
            
            // Determine source from URL
            let source = platformsDetected[0] || 'unknown';
            if (source === 'original' || source === 'error') {
                // Try to detect from URL hostname
                try {
                    const hostname = new URL(urls[0]).hostname.toLowerCase();
                    if (hostname.includes('kabum')) source = 'kabum';
                    else if (hostname.includes('pichau')) source = 'pichau';
                    else if (hostname.includes('terabyte')) source = 'terabyte';
                    else if (hostname.includes('magalu') || hostname.includes('magazineluiza')) source = 'magalu';
                    else if (hostname.includes('casasbahia')) source = 'casasbahia';
                    else if (hostname.includes('americanas')) source = 'americanas';
                    else source = hostname.split('.')[0];
                } catch (e) {
                    source = 'unknown';
                }
            }
            
            // Save to pending_promotions table with reason 'no_affiliate'
            const pendingData = {
                originalText: text,
                processedText: processedText,
                productName: '',
                price: '',
                coupon: '',
                imagePath: attachedPhotoUrl || '',
                urls: urls,
                affiliateUrls: affiliateUrls,
                suggestedCategory: null,
                source: source,
                reason: 'no_affiliate'
            };
            
            const pendingId = await PendingPromotions.add(pendingData);
            logger.info(`Promotion saved to pending queue (no affiliate) with ID: ${pendingId}`);
            console.log(`[3/8] ✅ Promoção salva na fila (sem afiliado) com ID: ${pendingId}`);
            
            // Broadcast notification to all connected WebSocket clients
            broadcastToClients('new_no_affiliate_promotion', {
                id: pendingId,
                source: source,
                url: urls[0]
            });
            
            // Get updated count for badge
            const noAffiliateCount = await PendingPromotions.getNoAffiliateCount();
            broadcastToClients('no_affiliate_count_update', { count: noAffiliateCount });
            
            return {
                success: true,
                noAffiliate: true,
                pendingId: pendingId,
                message: 'Promoção salva para aprovação manual (sem link de afiliado)'
            };
        }

        logger.info('[4/8] Fetching metadata...');
        console.log(`[4/8] Buscando metadados...`);
        const meta = await fetchMetadata(primaryUrl).catch(err => {
            logger.warn(`Metadata fetch error: ${err.message}`);
            console.warn(`[4/8] ⚠️ Erro ao buscar metadados: ${err.message}`);
            return {};
        });
        logger.info(`Metadata: title="${meta.title}", price="${meta.price}", image=${!!meta.image}`);
        console.log(`[4/8] ✅ Metadados obtidos:`);
        console.log(`   - Title: "${meta.title}"`);
        console.log(`   - Price: "${meta.price}"`);
        console.log(`   - Image: ${!!meta.image}`);
        console.log(`   - Coupon: "${meta.coupon}"`);

        logger.info('[5/8] Classifying with AI...');
        console.log(`[5/8] Classificando com IA e extraindo dados...`);
        const ai = await classifyAndCaption({ title: meta.title || '', price: meta.price || '', description: text, url: primaryUrl });
        logger.info(`AI classification: category="${ai.category}", confidence=${ai.confidence}, isCouponMessage=${ai.isCouponMessage}, needsApproval=${ai.needsApproval}`);
        console.log(`[5/8] ✅ AI Results:`);
        console.log(`   - Category: "${ai.category}" (confidence: ${ai.confidence})`);
        console.log(`   - Title: "${ai.title}"`);
        console.log(`   - Price: "${ai.price}"`);
        console.log(`   - Coupon: "${ai.coupon}"`);
        console.log(`   - Is Coupon Message: ${ai.isCouponMessage}`);
        console.log(`   - Needs Approval: ${ai.needsApproval || false}`);
        console.log(`   - Meta title: "${meta.title}"`);
        
        // If AI failed to classify and needs manual approval, save to pending queue
        if (ai.needsApproval) {
            logger.info('[5/8] ⚠️ AI failed to classify - saving to pending queue for manual approval');
            console.log(`[5/8] ⚠️ IA não conseguiu classificar - salvando para aprovação manual`);
            
            // Determine source from URL
            let source = 'manual';
            if (primaryUrl.includes('shopee')) source = 'shopee';
            else if (primaryUrl.includes('mercadolivre') || primaryUrl.includes('mercadolibre')) source = 'mercadolivre';
            else if (primaryUrl.includes('amazon') || primaryUrl.includes('amzn')) source = 'amazon';
            else if (primaryUrl.includes('aliexpress')) source = 'aliexpress';
            else if (primaryUrl.includes('magalu') || primaryUrl.includes('magazineluiza')) source = 'magalu';
            else if (ctx && ctx.message) source = 'telegram_monitor';
            
            // Save to pending_promotions table
            const pendingData = {
                originalText: text,
                processedText: processedText,
                productName: ai.title || meta.title || '',
                price: ai.price || meta.price || '',
                coupon: ai.coupon || '',
                imagePath: attachedPhotoUrl || meta.image || '',
                urls: urls,
                affiliateUrls: affiliateUrls,
                suggestedCategory: ai.category || null,
                source: source
            };
            
            const pendingId = await PendingPromotions.add(pendingData);
            logger.info(`Promotion saved to pending queue with ID: ${pendingId}`);
            console.log(`[5/8] ✅ Promoção salva na fila de pendentes com ID: ${pendingId}`);
            
            // Broadcast notification to all connected WebSocket clients
            broadcastToClients('new_pending_promotion', {
                id: pendingId,
                product_name: pendingData.product_name,
                price: pendingData.price,
                source: source,
                suggested_category: pendingData.suggested_category
            });
            
            // Get updated count for badge
            const pendingCount = await PendingPromotions.getPendingCount();
            broadcastToClients('pending_count_update', { count: pendingCount });
            
            return {
                success: true,
                needsApproval: true,
                pendingId: pendingId,
                message: 'Promoção salva para aprovação manual (IA não conseguiu classificar)'
            };
        };
        console.log(`   - Meta price: "${meta.price}"`);

        logger.info('[6/8] Getting thread ID for category...');
        console.log(`[6/8] Buscando threadId para categoria...`);
        const threadId = await Category.getThreadIdByName(ai.category);
        logger.info(`Thread ID for category "${ai.category}": ${threadId}`);
        console.log(`[6/8] ✅ Thread ID for category "${ai.category}": ${threadId}`);

        // Use AI extracted data with meta fallback if empty
        // Sanitize all text fields to ensure valid UTF-8
        const productName = sanitizeUtf8(ai.title || meta.title || 'Produto');
        const price = sanitizeUtf8(ai.price || meta.price || '');
        const cupomInfo = sanitizeUtf8(ai.coupon || '');

        logger.info('[7/8] Preparing message...');
        console.log(`[7/8] Dados finais para mensagem:`);
        console.log(`   - Product Name: "${productName}"`);
        console.log(`   - Price: "${price}"`);
        console.log(`   - Coupon: "${cupomInfo}"`);
        console.log(`   - Is Coupon Message: ${ai.isCouponMessage}`);

        const groupLink = 'https://t.me/ofertasertao';
        
        // Get all affiliate URLs (not just the primary one)
        const allAffiliateUrls = Object.values(affiliateUrls);
        logger.info(`Generated ${allAffiliateUrls.length} affiliate links`);
        console.log(`[7/8] Links de afiliado gerados: ${allAffiliateUrls.length}`);

        let messageText = '';
        
        // Check if this is a coupon message - format differently
        if (ai.isCouponMessage && ai.originalDescription) {
            // For coupon messages, preserve the original content but replace URLs with affiliate links
            logger.info('[7/8] Formatting as COUPON message (preserving original content)');
            console.log(`[7/8] 🎟️ Mensagem de CUPOM detectada - preservando conteúdo original`);
            
            // Start with a nice header
            messageText = `🎟️ ${productName}\n\n`;
            
            // Use the original description but replace URLs with affiliate versions
            // Also sanitize the original content
            let originalContent = sanitizeUtf8(ai.originalDescription);
            for (const [originalUrl, affiliateUrl] of Object.entries(affiliateUrls)) {
                const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                originalContent = originalContent.replace(
                    new RegExp(escapeRegex(originalUrl), 'g'),
                    affiliateUrl
                );
            }
            
            // Clean up and add the original content
            messageText += originalContent;
            
            // Add group link at the end
            messageText += `\n\n📢 Mais ofertas em: ${groupLink}`;
        } else {
            // Standard product message format
            messageText = `${productName}\n\n`;
            
            // Check if we have variants (multiple sizes/options with different prices)
            const variants = ai.variants || [];
            
            if (variants.length > 0) {
                // Product with variants - show each variant with its price and link
                console.log(`[7/8] 📦 Produto com ${variants.length} variantes detectadas`);
                
                // Match variants with URLs if possible
                const urlList = Object.values(affiliateUrls).filter(u => u !== groupLink);
                
                for (let i = 0; i < variants.length; i++) {
                    const variant = variants[i];
                    const variantUrl = urlList[i] || '';
                    
                    // More compact format: variant info and link on separate lines
                    messageText += `📦 ${variant.label} — ${variant.price}`;
                    if (variantUrl) {
                        messageText += `\n${variantUrl}`;
                    }
                    messageText += '\n\n';
                }
                
                // Add coupon if present
                if (cupomInfo && !cupomInfo.includes('http')) {
                    messageText += `🎟️ Cupom: ${cupomInfo}\n`;
                }
            } else {
                // Simple product - single price and links
                if (price) {
                    messageText += `💰 ${price}\n`;
                }
                
                // If cupomInfo is a URL, convert to affiliate link
                if (cupomInfo) {
                    if (cupomInfo.includes('http')) {
                        const match = cupomInfo.match(/^(.*?):\s*(https?:\/\/[^\s]+)$/);
                        if (match) {
                            const discountValue = match[1].trim();
                            const cupomUrl = match[2];
                            const cupomAffiliateUrl = affiliateUrls[cupomUrl] || cupomUrl;
                            messageText += `🎟️ Cupom ${discountValue}: ${cupomAffiliateUrl}\n`;
                        } else {
                            const cupomAffiliateUrl = affiliateUrls[cupomInfo] || cupomInfo;
                            messageText += `🎟️ Cupom: ${cupomAffiliateUrl}\n`;
                        }
                    } else {
                        messageText += `🎟️ Cupom: ${cupomInfo}\n`;
                    }
                }
                
                // Add all product links (exclude group link)
                messageText += `\n`;
                for (const url of allAffiliateUrls) {
                    let cupomActualUrl = null;
                    if (cupomInfo && cupomInfo.includes('http')) {
                        const urlMatch = cupomInfo.match(/(https?:\/\/[^\s]+)/);
                        if (urlMatch) cupomActualUrl = urlMatch[1];
                    }
                    
                    if (cupomActualUrl && affiliateUrls[cupomActualUrl] === url) continue;
                    if (url === groupLink) continue;
                    messageText += `🔗 ${url}\n`;
                }
            }
            
            messageText += `\n📢 Mais ofertas em: \n${groupLink}`;
        }

        // Sanitize the caption to ensure valid UTF-8
        let caption = sanitizeUtf8(messageText);
        
        // Telegram caption limit is 1024 characters for photos
        // If caption is too long, truncate it intelligently
        const MAX_CAPTION_LENGTH = 1024;
        if (caption.length > MAX_CAPTION_LENGTH) {
            logger.warn(`Caption too long (${caption.length} chars), truncating to ${MAX_CAPTION_LENGTH}`);
            console.log(`[7/8] ⚠️ Mensagem muito longa (${caption.length}), truncando para ${MAX_CAPTION_LENGTH} caracteres`);
            
            // Find the group link section and preserve it
            const groupLinkSection = `\n\n📢 Mais ofertas em: ${groupLink}`;
            const maxContentLength = MAX_CAPTION_LENGTH - groupLinkSection.length - 10; // 10 chars buffer
            
            // Truncate content and add ellipsis
            let truncatedCaption = caption.substring(0, maxContentLength);
            
            // Try to cut at last complete line
            const lastNewline = truncatedCaption.lastIndexOf('\n');
            if (lastNewline > maxContentLength * 0.7) {
                truncatedCaption = truncatedCaption.substring(0, lastNewline);
            }
            
            // Add group link at the end
            caption = truncatedCaption + '\n...' + groupLinkSection;
        }
        
        logger.info(`Caption generated: ${caption.length} chars`);
        console.log(`[7/8] ✅ Mensagem construída, tamanho: ${caption.length} caracteres`);

        // Get group chat ID and build reply markup
        const groupChatId = await Config.getGroupChatId() || process.env.GROUP_CHAT_ID;
        
        // Validate group chat ID - should be negative for groups/supergroups
        if (!groupChatId) {
            logger.error('GROUP_CHAT_ID não configurado!');
            throw new Error('GROUP_CHAT_ID não configurado. Configure o ID do grupo nas Configurações.');
        }
        
        // Warn if ID appears to be a private chat (positive number)
        const chatIdNum = Number(groupChatId);
        if (chatIdNum > 0) {
            logger.warn(`⚠️ GROUP_CHAT_ID (${groupChatId}) é positivo - isso parece ser um chat privado, não um grupo! IDs de grupos são negativos (ex: -1001234567890)`);
            console.warn(`⚠️ ATENÇÃO: GROUP_CHAT_ID (${groupChatId}) é positivo - isso indica um CHAT PRIVADO, não um grupo!`);
            console.warn(`   Para corrigir: use /getchatid dentro do GRUPO e atualize nas Configurações.`);
        }

        // Get General topic configuration
        const sendToGeneral = await Config.getSendToGeneral();
        
        const inviteLink = process.env.GROUP_INVITE_LINK || process.env.GROUP_LINK || '';
        const inlineKeyboard = [];
        if (inviteLink) inlineKeyboard.push([{ text: 'Entrar no Grupo', url: inviteLink }]);

        logger.info('[7/8] Building message...');
        console.log(`[7/8] Construindo mensagem...`);
        const replyMarkup = inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined;
        logger.info(`Message built: ${caption.length} chars`);
        console.log(`[7/8] ✅ Mensagem construída, tamanho: ${caption.length} caracteres`);

        logger.info(`[8/8] Sending to group ${groupChatId}, General: ${sendToGeneral ? 'enabled' : 'disabled'}, Category: ${threadId}`);
        console.log(`[8/8] Enviando para groupChatId: ${groupChatId}, General: ${sendToGeneral ? 'ativado' : 'desativado'}, Categoria: ${threadId}`);

        // Consume rate limit slot now that we're actually sending
        if (!globalRateLimiter.consumeSlot()) {
            const status = globalRateLimiter.getStatus();
            logger.warn(`Rate limit exceeded at send time: ${status.current}/${status.max}`);
            throw new Error(`⏱️ Rate limit: aguarde ${status.timeWindow}s (${status.current}/${status.max} mensagens processadas)`);
        }

        // Use attached photo (file_id) or meta image (URL)
        const imageSource = attachedPhotoUrl || meta.image;
        
        // Send with image if available
        if (imageSource) {
            logger.info('[8/8] Sending with image...');
            console.log(`[8/8] Enviando com imagem...`);
            
            // 1. Send to General (main chat, no thread_id)
            if (groupChatId && sendToGeneral) {
                try {
                    await bot.telegram.sendPhoto(groupChatId, imageSource, {
                        caption,
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                    logger.info('Sent to General (main chat) with image');
                    console.log(`[8/8] ✅ Enviado para General (chat principal) com imagem`);
                } catch (err) {
                    logger.warn(`Failed to send to General: ${err.message}`);
                    console.warn(`⚠️ Erro ao enviar para General: ${err.message}`);
                }
            }

            // 2. Send to specific category topic (if threadId exists)
            if (threadId && groupChatId && threadId !== 'null' && threadId !== null) {
                try {
                    await bot.telegram.sendPhoto(groupChatId, imageSource, {
                        caption,
                        parse_mode: 'HTML',
                        message_thread_id: Number(threadId),
                        reply_markup: replyMarkup
                    });
                    logger.info(`Sent to category ${threadId} with image`);
                    console.log(`[8/8] ✅ Enviado para categoria ${threadId} com imagem`);
                } catch (threadErr) {
                    logger.warn(`Failed to send to thread ${threadId}: ${threadErr.message}`);
                    console.warn(`⚠️ Erro ao enviar para tópico ${threadId}: ${threadErr.message}`);
                }
            }
        } else {
            logger.info('[8/8] Sending without image (text only)...');
            console.log(`[8/8] Enviando sem imagem (texto)...`);
            
            // 1. Send to General (main chat, no thread_id)
            if (groupChatId && sendToGeneral) {
                try {
                    await bot.telegram.sendMessage(groupChatId, caption, { 
                        parse_mode: 'HTML', 
                        reply_markup: replyMarkup 
                    });
                    logger.info('Sent to General (main chat) without image');
                    console.log(`[8/8] ✅ Enviado para General (chat principal) sem imagem`);
                } catch (err) {
                    logger.warn(`Failed to send to General: ${err.message}`);
                    console.warn(`⚠️ Erro ao enviar para General: ${err.message}`);
                }
            }
            
            // 2. Send to specific category topic (if threadId exists)
            if (threadId && groupChatId && threadId !== 'null' && threadId !== null) {
                try {
                    await bot.telegram.sendMessage(groupChatId, caption, { 
                        parse_mode: 'HTML', 
                        message_thread_id: Number(threadId), 
                        reply_markup: replyMarkup 
                    });
                    logger.info(`Sent to category ${threadId} without image`);
                    console.log(`[8/8] ✅ Enviado para categoria ${threadId} sem imagem`);
                } catch (threadErr) {
                    logger.warn(`Failed to send to thread ${threadId}: ${threadErr.message}`);
                    console.warn(`[8/8] ⚠️ Erro ao enviar para tópico ${threadId}: ${threadErr.message}`);
                }
            }
        }

        // Mark in Redis for 1h (prevent reposting same URL within 1 hour)
        logger.info('Promotion processed successfully');
        console.log(`[✅ COMPLETO] Promoção processada com sucesso!`);
        try {
            await Promise.race([
                redis.set(key, '1', 'EX', 3600), // 1 hour expiry
                new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 3000))
            ]);
            logger.info('Marked in Redis (1h)');
        } catch (redisErr) {
            logger.warn(`Failed to mark in Redis: ${redisErr.message}`);
            console.warn(`⚠️ Falha ao marcar no Redis (continuando): ${redisErr.message}`);
        }
        
        // Save to post_history
        try {
            await pool.execute(`
                INSERT INTO post_history 
                (product_name, category, price, coupon, urls, affiliate_urls, success, posted_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            `, [
                productName,
                ai.category,
                price,
                cupomInfo || null,
                JSON.stringify(urls),
                JSON.stringify(allAffiliateUrls),
                1
            ]);
            logger.info('Saved to post_history');
            console.log(`[✅ DB] Salvo no histórico de postagens`);
            
            // Log success to system_logs
            await pool.execute(`
                INSERT INTO system_logs (type, message, details, timestamp) 
                VALUES (?, ?, ?, NOW())
            `, [
                'success',
                'Oferta postada com sucesso',
                `${productName} - ${ai.category}`
            ]);
        } catch (dbErr) {
            logger.error(`Database save error: ${dbErr.message}`);
            console.warn(`⚠️ Erro ao salvar no banco: ${dbErr.message}`);
        }
        
        return { skipped: false };
    } catch (err) {
        logger.error(`handlePromotionFlow error: ${err.message}`, { stack: err.stack });
        console.error('[❌ ERRO] handlePromotionFlow error:', err.message || err);
        console.error('Stack:', err.stack);
        
        // Log error to system_logs
        try {
            await pool.execute(`
                INSERT INTO system_logs (type, message, details, timestamp) 
                VALUES (?, ?, ?, NOW())
            `, [
                'error',
                'Falha ao processar oferta',
                err.message || 'Erro desconhecido'
            ]);
        } catch (logErr) {
            console.warn(`⚠️ Erro ao salvar log de erro: ${logErr.message}`);
        }
        
        throw err;
    }
}

module.exports = {
    handlePromotionFlow,
    initializePromotionFlow,
    broadcastToClients
};
