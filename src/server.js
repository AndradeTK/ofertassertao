require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const { Telegraf } = require('telegraf');
const multer = require('multer');
const fs = require('fs');

const redis = require('./config/redis');
const Category = require('./models/categoryModel');
const Monitoring = require('./models/monitoringModel');
const Config = require('./models/configModel');
const ForbiddenWords = require('./models/forbiddenWordsModel');
const Settings = require('./models/settingsModel');
const PendingPromotions = require('./models/pendingPromotionsModel');
const ExcludedUrls = require('./models/excludedUrlsModel');
const { classifyAndCaption } = require('./services/aiService');
const { generateAffiliateLink } = require('./services/affiliateService');
const { fetchMetadata } = require('./services/metaService');
const { handlePromotionFlow, initializePromotionFlow, broadcastToClients, checkDuplicateUrl, markUrlAsProcessed } = require('./services/promotionFlow');
const { startScheduledPostsProcessor } = require('./services/scheduledPostsService');
const { globalRateLimiter } = require('./services/rateLimiter');
const UserMonitor = require('./services/userMonitorService');
const CookieService = require('./services/cookieService');
const { checkAllAPIs } = require('./services/apiMonitor');
const { createComponentLogger } = require('./config/logger');

const logger = createComponentLogger('Server');

/**
 * Helper function to get image source for Telegram
 * Converts local paths to file source, validates URLs
 * @param {string} imagePath - The image path (local or URL)
 * @returns {object|string|null} - Telegram-compatible image source
 */
function getImageSourceForTelegram(imagePath) {
    if (!imagePath) return null;
    
    // If it's a local path (starts with /uploads), convert to absolute path
    if (imagePath.startsWith('/uploads')) {
        const absolutePath = path.join(__dirname, '..', imagePath);
        if (fs.existsSync(absolutePath)) {
            console.log(`[Image] Using local file: ${absolutePath}`);
            return { source: absolutePath };
        } else {
            console.log(`[Image] Local file not found: ${absolutePath}`);
            return null;
        }
    }
    
    // Skip localhost URLs that Telegram can't access
    if (imagePath.includes('localhost') || imagePath.includes('127.0.0.1') || imagePath.includes(':3000')) {
        console.log(`[Image] Skipping localhost URL: ${imagePath}`);
        return null;
    }
    
    // Public URL - use directly
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        console.log(`[Image] Using public URL: ${imagePath}`);
        return imagePath;
    }
    
    // Absolute local path
    if (fs.existsSync(imagePath)) {
        console.log(`[Image] Using absolute path: ${imagePath}`);
        return { source: imagePath };
    }
    
    console.log(`[Image] Invalid path: ${imagePath}`);
    return null;
}

// Configure multer for file uploads
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const app = express();

// WebSocket server reference (initialized later with HTTP server)
let wss = null;

// Load settings from DB on startup
async function initializeApp() {
    try {
        const settings = await Settings.getAll();
        for (const [key, value] of Object.entries(settings)) {
            if (value) process.env[key] = value;
        }
        logger.info('Global settings loaded from database');
        
        // Load rate limit settings from database
        try {
            const { pool } = require('./config/db');
            const [maxRows] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['RATE_LIMIT_MAX_MESSAGES']);
            const [timeRows] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['RATE_LIMIT_TIME_WINDOW']);
            
            const maxMessages = maxRows.length > 0 ? parseInt(maxRows[0].value_text) : 5;
            const timeWindow = timeRows.length > 0 ? parseInt(timeRows[0].value_text) : 60;
            
            globalRateLimiter.updateSettings(maxMessages, timeWindow);
            logger.info(`Rate limit loaded: ${maxMessages} messages per ${timeWindow}s`);
            
            // Set up callback for rate limit status updates
            globalRateLimiter.setStatusChangeCallback((status) => {
                broadcastToClients('rate_limit_update', status);
            });
        } catch (rlErr) {
            logger.warn(`Could not load rate limit settings: ${rlErr.message}`);
        }
    } catch (err) {
        logger.error(`Failed to load settings: ${err.message}`);
    }
}

// Call immediately but wait for promise before bot init if possible
// For this structure, we'll try to init bot after app starts or use a wrapper
// But existing code initializes bot immediately. We will wrap the bot initialization.

// Placeholder for bot instance
let bot = null;

const BOT_TOKEN = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
if (BOT_TOKEN) {
    bot = new Telegraf(BOT_TOKEN);
    global.telegramBot = bot; // Make bot available globally
} 

// Initialize promotion flow with bot and config
initializePromotionFlow(bot, Config);

// We will re-initialize bot later if token changes
async function reinitializeBot() {
    try {
        if (bot) {
            bot.stop('Restarting');
        }
        
        await initializeApp(); // Reload settings
        
        const newToken = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
        if (!newToken) throw new Error('No token found');
        
        bot = new Telegraf(newToken);
        global.telegramBot = bot; // Update global reference
        initializePromotionFlow(bot, Config);
        setupBotHandlers(bot);
        bot.launch();
        
        logger.info('Bot re-initialized successfully');
        return true;
    } catch (err) {
        logger.error(`Bot re-initialization failed: ${err.message}`);
        return false;
    }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Rotas
app.get('/', async (req, res) => {
    const categories = await Category.getAll();
    const monitored = await Monitoring.getAll();
    const groupChatId = await Config.getGroupChatId();
    res.render('index', { categories, monitored, groupChatId });
});

// Monitor page - fullscreen monitoring dashboard
app.get('/monitor', async (req, res) => {
    res.render('monitor');
});

app.post('/post-manual', async (req, res) => {
    try {
        await handlePromotionFlow(req.body.content || req.body.text || '');
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clear-cache', async (req, res) => {
    try {
        console.log('🗑️ Clearing Redis cache...');
        await redis.flushdb();
        console.log('✅ Redis cache cleared successfully');
        res.json({ status: 'ok', message: 'Cache limpo com sucesso!' });
    } catch (err) {
        console.error('❌ Error clearing Redis cache:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/delete-monitoring/:id', async (req, res) => {
    try {
        await Monitoring.delete(req.params.id);
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Erro ao deletar monitoramento');
    }
});

app.post('/categories', async (req, res) => {
    const { name_ia, thread_id } = req.body;
    try {
        await Category.create(name_ia, thread_id);
        // Check if request expects JSON (from JavaScript fetch)
        if (req.headers['content-type']?.includes('application/json')) {
            res.json({ status: 'ok', message: 'Categoria criada com sucesso' });
        } else {
            res.redirect('/');
        }
    } catch (err) {
        if (req.headers['content-type']?.includes('application/json')) {
            res.status(500).json({ error: err.message });
        } else {
            res.status(500).send('Erro ao salvar categoria');
        }
    }
});

// Save group chat ID
app.post('/set-group-chat', async (req, res) => {
    const { groupChatId } = req.body;
    try {
        if (!groupChatId) return res.status(400).json({ error: 'Group Chat ID required' });
        await Config.setGroupChatId(groupChatId);
        res.json({ status: 'ok', message: 'Group Chat ID salvo com sucesso' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sync topics from the group (attempts to use Telegram forum topics endpoint)
app.post('/sync-topics', async (req, res) => {
    try {
        // Get group chat ID from database
        const chatId = await Config.getGroupChatId();
        if (!chatId) return res.status(400).json({ error: 'Group Chat ID not configured. Salve o ID do grupo primeiro.' });

        // Attempt to call Telegram API method 'getForumTopics' (may fail depending on API/version)
        const resp = await bot.telegram.callApi('getForumTopics', { chat_id: chatId });
        // resp should contain topics array; structure may vary
        const topics = resp && resp.result && resp.result.topics ? resp.result.topics : resp.result || resp;

        // Optionally create categories from topics when requested
        if (req.body.createCategories && Array.isArray(topics)) {
            for (const t of topics) {
                const name = t.name || t.title || `Tópico ${t.message_thread_id}`;
                const threadId = t.message_thread_id || t.id;
                try { await Category.create(name, threadId); } catch (e) { /* ignore duplicates */ }
            }
        }

        res.json({ topics, message: `${topics.length} tópicos encontrados` });
    } catch (err) {
        // If Telegram returns 404 Not Found, the method is not available for this bot/API.
        const msg = (err && err.description) || (err && err.message) || String(err);
        console.error('sync-topics error:', msg);
        if (String(msg).includes('404') || String(msg).toLowerCase().includes('not found')) {
            return res.status(404).json({
                error: 'Método de listagem de tópicos não disponível para este bot.',
                guidance: 'Use os comandos do bot (/get_topic_id) para obter IDs de tópicos manualmente e crie as categorias no painel.'
            });
        }

        res.status(500).json({ error: 'Erro ao sincronizar tópicos: ' + msg });
    }
});

// Bot status endpoint to help debugging
app.get('/bot-status', async (req, res) => {
    if (!bot) return res.json({ active: false, message: 'Bot not initialized (missing token)' });
    try {
        const me = await bot.telegram.getMe();
        res.json({ active: true, me });
    } catch (err) {
        res.status(500).json({ active: false, error: (err && err.message) || String(err) });
    }
});

// Helper endpoint to get chat info
app.get('/get-chat-info', async (req, res) => {
    const chatId = req.query.chat_id || process.env.GROUP_CHAT_ID;
    if (!chatId) return res.status(400).json({ error: 'Chat ID required' });
    
    if (!bot) return res.status(500).json({ error: 'Bot not initialized' });
    try {
        const chat = await bot.telegram.getChat(chatId);
        res.json({ chat });
    } catch (err) {
        res.status(500).json({ error: (err && err.message) || String(err) });
    }
});

// ============ NEW DASHBOARD ENDPOINTS ============

// API Status Check
app.get('/api/status', async (req, res) => {
    try {
        logger.debug('API status check requested');
        const status = await checkAllAPIs();
        res.json(status);
    } catch (err) {
        logger.error(`API status check error: ${err.message}`);
        // Return fallback status
        res.json({
            shopee: { online: false, latency: null, error: 'Check failed' },
            ml: { online: false, latency: null, error: 'Check failed' },
            ali: { online: false, latency: null, error: 'Check failed' },
            ai: { online: !!process.env.GEMINI_API_KEY, latency: null, error: !process.env.GEMINI_API_KEY ? 'API key not configured' : 'Check failed' },
            timestamp: new Date().toISOString()
        });
    }
});

// Metrics
app.get('/api/metrics', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        
        // Get today's offers count from post_history
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [offersResult] = await pool.execute(
            'SELECT COUNT(*) as count FROM post_history WHERE posted_at >= ? AND success = 1',
            [today]
        );
        
        // Get active channels
        const monitored = await Monitoring.getAll();
        
        // Get errors from today
        const [errorsResult] = await pool.execute(
            'SELECT COUNT(*) as count FROM system_logs WHERE type = "error" AND timestamp >= ?',
            [today]
        );
        
        res.json({
            offersToday: offersResult[0].count || 0,
            activeChannels: monitored.length || 0,
            errors: errorsResult[0].count || 0
        });
    } catch (err) {
        console.error('Erro ao buscar métricas:', err);
        res.json({ offersToday: 0, activeChannels: 0, errors: 0 });
    }
});

// Charts Data
app.get('/api/charts', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        
        // Get last 7 days data
        const [weeklyResult] = await pool.execute(`
            SELECT 
                DATE_FORMAT(posted_at, '%w') as day_of_week,
                COUNT(*) as count
            FROM post_history
            WHERE posted_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            AND success = 1
            GROUP BY day_of_week
        `);
        
        // Map to last 7 days
        const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const weeklyData = Array(7).fill(0);
        weeklyResult.forEach(row => {
            weeklyData[parseInt(row.day_of_week)] = row.count;
        });
        
        // Get category distribution
        const [categoryResult] = await pool.execute(`
            SELECT 
                category,
                COUNT(*) as count
            FROM post_history
            WHERE posted_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            AND success = 1
            AND category IS NOT NULL
            GROUP BY category
            ORDER BY count DESC
            LIMIT 5
        `);
        
        const categoryLabels = categoryResult.map(row => row.category || 'Outros');
        const categoryValues = categoryResult.map(row => row.count);
        
        res.json({
            weekly: {
                labels: dayNames,
                values: weeklyData
            },
            categories: {
                labels: categoryLabels.length > 0 ? categoryLabels : ['Sem dados'],
                values: categoryValues.length > 0 ? categoryValues : [0]
            }
        });
    } catch (err) {
        console.error('Erro ao buscar dados dos gráficos:', err);
        res.json({ weekly: { labels: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'], values: [0,0,0,0,0,0,0] }, categories: { labels: ['Sem dados'], values: [0] } });
    }
});

// Get Categories (JSON)
app.get('/categories', async (req, res) => {
    try {
        const categories = await Category.getAll();
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Category
app.delete('/categories/:id', async (req, res) => {
    try {
        await Category.delete(req.params.id);
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Monitoring (JSON)
app.get('/monitoring', async (req, res) => {
    try {
        const monitored = await Monitoring.getAll();
        res.json(monitored);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add Monitoring (JSON)
app.post('/monitoring', async (req, res) => {
    try {
        const { chat_id, name } = req.body;
        await Monitoring.add(chat_id, name);
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Monitoring
app.delete('/monitoring/:id', async (req, res) => {
    try {
        await Monitoring.delete(req.params.id);
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// User Account Monitor (MTProto) API
// ============================================

// Get user monitor status
app.get('/api/user-monitor/status', async (req, res) => {
    try {
        const status = UserMonitor.getStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Connect with existing session
app.post('/api/user-monitor/connect', async (req, res) => {
    try {
        const apiId = process.env.TELEGRAM_API_ID;
        const apiHash = process.env.TELEGRAM_API_HASH;
        
        if (!apiId || !apiHash) {
            return res.status(400).json({ 
                error: 'TELEGRAM_API_ID e TELEGRAM_API_HASH não configurados. Configure nas settings.' 
            });
        }
        
        const result = await UserMonitor.connectWithSession(apiId, apiHash);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start login process (send code)
app.post('/api/user-monitor/login/start', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        const apiId = process.env.TELEGRAM_API_ID;
        const apiHash = process.env.TELEGRAM_API_HASH;
        
        if (!apiId || !apiHash) {
            return res.status(400).json({ 
                error: 'TELEGRAM_API_ID e TELEGRAM_API_HASH não configurados' 
            });
        }
        
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Número de telefone obrigatório' });
        }
        
        const result = await UserMonitor.startLogin(apiId, apiHash, phoneNumber);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Verify login code
app.post('/api/user-monitor/login/verify', async (req, res) => {
    try {
        const { code, password } = req.body;
        const apiId = process.env.TELEGRAM_API_ID;
        const apiHash = process.env.TELEGRAM_API_HASH;
        
        if (!code) {
            return res.status(400).json({ error: 'Código obrigatório' });
        }
        
        const result = await UserMonitor.verifyCode(apiId, apiHash, code, password);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Logout
app.post('/api/user-monitor/logout', async (req, res) => {
    try {
        const result = await UserMonitor.logout();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start monitoring
app.post('/api/user-monitor/start', async (req, res) => {
    try {
        const result = await UserMonitor.startMonitoring();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stop monitoring
app.post('/api/user-monitor/stop', async (req, res) => {
    try {
        const result = UserMonitor.stopMonitoring();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get user's groups
app.get('/api/user-monitor/dialogs', async (req, res) => {
    try {
        const dialogs = await UserMonitor.getDialogs();
        res.json(dialogs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// Cookie Capture API Routes
// ============================================

// Get cookie status
app.get('/api/cookies/status', async (req, res) => {
    try {
        const status = CookieService.getStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Open browser for Mercado Livre login
app.post('/api/cookies/ml/start', async (req, res) => {
    try {
        const result = await CookieService.startMercadoLivreLogin();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Capture Mercado Livre cookies (after login)
app.post('/api/cookies/ml/capture', async (req, res) => {
    try {
        const result = await CookieService.captureMercadoLivreCookies();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Open browser for Amazon login
app.post('/api/cookies/amazon/start', async (req, res) => {
    try {
        const result = await CookieService.startAmazonLogin();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Capture Amazon cookies (after login)
app.post('/api/cookies/amazon/capture', async (req, res) => {
    try {
        const result = await CookieService.captureAmazonCookies();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Open browser for AliExpress login
app.post('/api/cookies/aliexpress/start', async (req, res) => {
    try {
        const result = await CookieService.startAliExpressLogin();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Capture AliExpress cookies (after login)
app.post('/api/cookies/aliexpress/capture', async (req, res) => {
    try {
        const result = await CookieService.captureAliExpressCookies();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancel/close browser
app.post('/api/cookies/cancel', async (req, res) => {
    try {
        const { platform } = req.body;
        const result = await CookieService.cancelLogin(platform || 'all');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear cookies
app.post('/api/cookies/clear', async (req, res) => {
    try {
        const { platform } = req.body;
        const result = CookieService.clearCookies(platform || 'all');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set cookies manually
app.post('/api/cookies/set', async (req, res) => {
    try {
        const { platform, cookies } = req.body;
        const result = CookieService.setManualCookies(platform, cookies);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear browser profile (forces new login)
app.post('/api/cookies/clear-profile', async (req, res) => {
    try {
        const { platform } = req.body;
        const result = CookieService.clearBrowserProfile(platform);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================= PENDING PROMOTIONS API =========================

// Get all pending promotions (AI fallback)
app.get('/api/pending-promotions', async (req, res) => {
    try {
        const pending = await PendingPromotions.getPending();
        res.json({ success: true, data: pending });
    } catch (err) {
        console.error('Error getting pending promotions:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get pending promotions count (AI fallback)
app.get('/api/pending-promotions/count', async (req, res) => {
    try {
        const count = await PendingPromotions.getPendingCount();
        res.json({ success: true, count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all no-affiliate promotions
app.get('/api/no-affiliate-promotions', async (req, res) => {
    try {
        const pending = await PendingPromotions.getNoAffiliate();
        res.json({ success: true, data: pending });
    } catch (err) {
        console.error('Error getting no-affiliate promotions:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get no-affiliate promotions count
app.get('/api/no-affiliate-promotions/count', async (req, res) => {
    try {
        const count = await PendingPromotions.getNoAffiliateCount();
        res.json({ success: true, count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get a single pending promotion
app.get('/api/pending-promotions/:id', async (req, res) => {
    try {
        const promotion = await PendingPromotions.getById(req.params.id);
        if (!promotion) {
            return res.status(404).json({ error: 'Promoção não encontrada' });
        }
        res.json({ success: true, data: promotion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update a pending promotion
app.put('/api/pending-promotions/:id', async (req, res) => {
    try {
        const { product_name, price, coupon, category, processed_text, image_path } = req.body;
        const updated = await PendingPromotions.update(req.params.id, {
            product_name,
            price,
            coupon,
            suggested_category: category,
            processed_text,
            image_path
        });
        
        if (!updated) {
            return res.status(404).json({ error: 'Promoção não encontrada' });
        }
        
        res.json({ success: true, message: 'Promoção atualizada com sucesso' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Approve and send a pending promotion
app.post('/api/pending-promotions/:id/approve', async (req, res) => {
    try {
        const { category } = req.body;
        const promotion = await PendingPromotions.getById(req.params.id);
        
        if (!promotion) {
            return res.status(404).json({ error: 'Promoção não encontrada' });
        }
        
        // Parse URLs first to get the affiliate URL for duplicate check
        let affiliateUrls;
        try {
            affiliateUrls = JSON.parse(promotion.affiliate_urls || '{}');
        } catch (e) {
            affiliateUrls = {};
        }
        
        const allAffiliateUrls = Object.values(affiliateUrls);
        const primaryUrl = allAffiliateUrls[0] || promotion.original_url;
        
        // Check for duplicate using Redis
        if (primaryUrl) {
            const { isDuplicate } = await checkDuplicateUrl(primaryUrl);
            if (isDuplicate) {
                // Auto-reject the duplicate
                await PendingPromotions.reject(req.params.id, 'Duplicado detectado pelo sistema');
                
                // Broadcast updated count
                const count = await PendingPromotions.getPendingCount();
                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({
                            type: 'pending_count_update',
                            data: { count },
                            timestamp: new Date().toISOString()
                        }));
                    }
                });
                
                return res.status(409).json({ 
                    error: 'Promoção duplicada detectada',
                    duplicate: true 
                });
            }
        }
        
        // Get thread ID for the category
        const finalCategory = category || promotion.suggested_category || 'Variados';
        const threadId = await Category.getThreadIdByName(finalCategory);
        
        // Build the message
        const productName = promotion.product_name || 'Produto';
        const price = promotion.price || '';
        const cupomInfo = promotion.coupon || '';
        const groupLink = 'https://t.me/ofertasertao';
        
        let messageText = `${productName}\n\n`;
        if (price) messageText += `💰 ${price}\n`;
        if (cupomInfo) messageText += `🎟️ Cupom: ${cupomInfo}\n`;
        messageText += '\n';
        
        for (const url of allAffiliateUrls) {
            if (url !== groupLink) {
                messageText += `🔗 ${url}\n`;
            }
        }
        
        messageText += `\n📢 Mais ofertas em: \n${groupLink}`;
        
        // Get group chat ID
        const groupChatId = await Config.getGroupChatId() || process.env.GROUP_CHAT_ID;
        const sendToGeneral = await Config.getSendToGeneral();
        
        if (!groupChatId) {
            return res.status(400).json({ error: 'GROUP_CHAT_ID não configurado' });
        }
        
        const inviteLink = process.env.GROUP_INVITE_LINK || process.env.GROUP_LINK || '';
        const inlineKeyboard = [];
        if (inviteLink) inlineKeyboard.push([{ text: 'Entrar no Grupo', url: inviteLink }]);
        const replyMarkup = inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined;
        
        // Get image source for Telegram (handles local files and URLs)
        const imageSource = getImageSourceForTelegram(promotion.image_path);
        
        // Create the send callback function
        const sendCallback = async () => {
            if (imageSource) {
                // Send to General if enabled
                if (sendToGeneral) {
                    await bot.telegram.sendPhoto(groupChatId, imageSource, {
                        caption: messageText,
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                }
                
                // Send to category topic
                if (threadId) {
                    await bot.telegram.sendPhoto(groupChatId, imageSource, {
                        caption: messageText,
                        parse_mode: 'HTML',
                        message_thread_id: Number(threadId),
                        reply_markup: replyMarkup
                    });
                }
            } else {
                // Send without image
                if (sendToGeneral) {
                    await bot.telegram.sendMessage(groupChatId, messageText, {
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                }
                
                if (threadId) {
                    await bot.telegram.sendMessage(groupChatId, messageText, {
                        parse_mode: 'HTML',
                        message_thread_id: Number(threadId),
                        reply_markup: replyMarkup
                    });
                }
            }
        };
        
        // Enqueue the promotion for sending with rate limit
        const queueResult = UserMonitor.enqueueDirectSend({
            productName,
            category: finalCategory,
            threadId,
            sendCallback
        });
        
        // Mark as approved immediately (will be sent from queue)
        await PendingPromotions.approve(req.params.id, finalCategory);
        
        // Broadcast updated count
        const count = await PendingPromotions.getPendingCount();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'pending_count_update',
                    data: { count },
                    timestamp: new Date().toISOString()
                }));
            }
        });
        
        res.json({ 
            success: true, 
            message: `Promoção aprovada e adicionada à fila de envio (posição: ${queueResult.position})`,
            queued: true,
            position: queueResult.position
        });
    } catch (err) {
        console.error('Error approving promotion:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Reject/delete a pending promotion
app.post('/api/pending-promotions/:id/reject', async (req, res) => {
    try {
        const { reason } = req.body;
        await PendingPromotions.reject(req.params.id, reason);
        
        // Broadcast updated count
        const count = await PendingPromotions.getPendingCount();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'pending_count_update',
                    data: { count },
                    timestamp: new Date().toISOString()
                }));
            }
        });
        
        res.json({ success: true, message: 'Promoção rejeitada' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a pending promotion permanently
app.delete('/api/pending-promotions/:id', async (req, res) => {
    try {
        await PendingPromotions.delete(req.params.id);
        
        // Broadcast updated count
        const count = await PendingPromotions.getPendingCount();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'pending_count_update',
                    data: { count },
                    timestamp: new Date().toISOString()
                }));
            }
        });
        
        res.json({ success: true, message: 'Promoção excluída' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reanalyze all AI fallback pending promotions
app.post('/api/pending-promotions/reanalyze-all', async (req, res) => {
    try {
        // Get all pending AI fallback promotions
        const pending = await PendingPromotions.getPending();
        
        if (pending.length === 0) {
            return res.json({ success: true, message: 'Nenhuma promoção pendente para reanalisar', count: 0 });
        }
        
        const { enqueuePromotion } = require('./services/userMonitorService');
        let queuedCount = 0;
        
        for (const promo of pending) {
            // Use original_text to reprocess through the full flow
            const originalText = promo.original_text;
            const imagePath = promo.image_path;
            
            if (originalText) {
                // Create photoSource object if image exists and is a valid URL
                let photoSource = null;
                if (imagePath && (imagePath.startsWith('http://') || imagePath.startsWith('https://'))) {
                    photoSource = { url: imagePath };
                }
                
                // Enqueue for reprocessing
                enqueuePromotion(originalText, photoSource, `reanalise-${promo.source || 'manual'}`);
                queuedCount++;
                
                // Delete the pending promotion since it's now in the queue
                await PendingPromotions.delete(promo.id);
            }
        }
        
        // Broadcast updated count
        const count = await PendingPromotions.getPendingCount();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'pending_count_update',
                    data: { count },
                    timestamp: new Date().toISOString()
                }));
            }
        });
        
        console.log(`[Reanalyze] ✅ ${queuedCount} promoções adicionadas à fila para reanálise`);
        res.json({ 
            success: true, 
            message: `${queuedCount} promoções adicionadas à fila para reanálise com IA`,
            count: queuedCount 
        });
    } catch (err) {
        console.error('Error reanalyzing promotions:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Approve all AI fallback pending promotions
app.post('/api/pending-promotions/approve-all', async (req, res) => {
    try {
        const pending = await PendingPromotions.getPending();
        
        if (pending.length === 0) {
            return res.json({ success: true, message: 'Nenhuma promoção pendente', count: 0 });
        }
        
        const Category = require('./models/categoryModel');
        const { enqueueDirectSend } = require('./services/userMonitorService');
        let approvedCount = 0;
        let skippedDuplicates = 0;
        
        for (const promo of pending) {
            try {
                // Get primary URL for duplicate check
                let affiliateUrls = {};
                try {
                    affiliateUrls = JSON.parse(promo.affiliate_urls || '{}');
                } catch (e) {}
                const allAffiliateUrls = Object.values(affiliateUrls);
                const primaryUrl = allAffiliateUrls[0] || promo.original_url;
                
                // Check for duplicate using Redis
                if (primaryUrl) {
                    const { isDuplicate } = await checkDuplicateUrl(primaryUrl);
                    if (isDuplicate) {
                        // Auto-reject the duplicate
                        await PendingPromotions.reject(promo.id, 'Duplicado detectado pelo sistema');
                        skippedDuplicates++;
                        continue;
                    }
                }
                
                // Use suggested category or 'Variados'
                const category = promo.suggested_category || 'Variados';
                const threadId = await Category.getThreadIdByName(category);
                
                // Mark as approved
                await PendingPromotions.approve(promo.id, category);
                
                // Get image source for Telegram
                const imageSource = getImageSourceForTelegram(promo.image_path);
                
                // Enqueue for sending
                const sendData = {
                    productName: promo.product_name || 'Produto',
                    message: promo.processed_text || promo.original_text,
                    image: promo.image_path,
                    threadId: threadId,
                    sendCallback: async () => {
                        const bot = global.telegramBot;
                        console.log(`[SendCallback] 🔍 Iniciando envio - Bot existe: ${!!bot}, Bot.telegram existe: ${!!(bot && bot.telegram)}`);
                        
                        if (!bot || !bot.telegram) {
                            throw new Error('Bot não está inicializado');
                        }
                        const groupChatId = await Config.getGroupChatId() || process.env.GROUP_CHAT_ID;
                        console.log(`[SendCallback] 📍 GroupChatId: ${groupChatId}, ThreadId: ${threadId}, ImageSource: ${imageSource ? (typeof imageSource === 'string' ? imageSource.substring(0, 50) : JSON.stringify(imageSource).substring(0, 80)) : 'NENHUMA'}`);
                        
                        if (imageSource) {
                            console.log(`[SendCallback] 📸 Enviando com IMAGEM...`);
                            const result = await bot.telegram.sendPhoto(groupChatId, imageSource, {
                                caption: promo.processed_text || promo.original_text,
                                parse_mode: 'HTML',
                                message_thread_id: threadId || undefined
                            });
                            console.log(`[SendCallback] ✅ Foto enviada! Message ID: ${result?.message_id}`);
                        } else {
                            console.log(`[SendCallback] 📝 Enviando TEXTO apenas...`);
                            const result = await bot.telegram.sendMessage(groupChatId, promo.processed_text || promo.original_text, {
                                parse_mode: 'HTML',
                                message_thread_id: threadId || undefined,
                                disable_web_page_preview: false
                            });
                            console.log(`[SendCallback] ✅ Mensagem enviada! Message ID: ${result?.message_id}`);
                        }
                    }
                };
                
                enqueueDirectSend(sendData);
                approvedCount++;
            } catch (err) {
                console.error(`Error approving promo ${promo.id}:`, err.message);
            }
        }
        
        // Broadcast updated count
        const count = await PendingPromotions.getPendingCount();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'pending_count_update',
                    data: { count },
                    timestamp: new Date().toISOString()
                }));
            }
        });
        
        console.log(`[ApproveAll] ✅ ${approvedCount} promoções aprovadas, ${skippedDuplicates} duplicados ignorados`);
        res.json({ 
            success: true, 
            message: `${approvedCount} promoções aprovadas${skippedDuplicates > 0 ? `, ${skippedDuplicates} duplicados ignorados` : ''}`, 
            count: approvedCount,
            skippedDuplicates 
        });
    } catch (err) {
        console.error('Error approving all:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Reject all AI fallback pending promotions
app.post('/api/pending-promotions/reject-all', async (req, res) => {
    try {
        const pending = await PendingPromotions.getPending();
        
        if (pending.length === 0) {
            return res.json({ success: true, message: 'Nenhuma promoção pendente', count: 0 });
        }
        
        let rejectedCount = 0;
        
        for (const promo of pending) {
            try {
                await PendingPromotions.reject(promo.id, 'Recusado em lote');
                rejectedCount++;
            } catch (err) {
                console.error(`Error rejecting promo ${promo.id}:`, err.message);
            }
        }
        
        // Broadcast updated count
        const count = await PendingPromotions.getPendingCount();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'pending_count_update',
                    data: { count },
                    timestamp: new Date().toISOString()
                }));
            }
        });
        
        console.log(`[RejectAll] ✅ ${rejectedCount} promoções recusadas`);
        res.json({ success: true, message: `${rejectedCount} promoções recusadas`, count: rejectedCount });
    } catch (err) {
        console.error('Error rejecting all:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Approve all no-affiliate promotions
app.post('/api/no-affiliate-promotions/approve-all', async (req, res) => {
    try {
        const pending = await PendingPromotions.getNoAffiliate();
        
        if (pending.length === 0) {
            return res.json({ success: true, message: 'Nenhuma promoção sem afiliado', count: 0 });
        }
        
        const Category = require('./models/categoryModel');
        const { enqueueDirectSend } = require('./services/userMonitorService');
        let approvedCount = 0;
        let skippedDuplicates = 0;
        
        for (const promo of pending) {
            try {
                // Get primary URL for duplicate check
                let affiliateUrls = {};
                try {
                    affiliateUrls = JSON.parse(promo.affiliate_urls || '{}');
                } catch (e) {}
                const allAffiliateUrls = Object.values(affiliateUrls);
                const primaryUrl = allAffiliateUrls[0] || promo.original_url;
                
                // Check for duplicate using Redis
                if (primaryUrl) {
                    const { isDuplicate } = await checkDuplicateUrl(primaryUrl);
                    if (isDuplicate) {
                        // Auto-reject the duplicate
                        await PendingPromotions.reject(promo.id, 'Duplicado detectado pelo sistema');
                        skippedDuplicates++;
                        continue;
                    }
                }
                
                const category = promo.suggested_category || 'Outros';
                const threadId = await Category.getThreadIdByName(category);
                
                await PendingPromotions.approve(promo.id, category);
                
                // Get image source for Telegram
                const imageSource = getImageSourceForTelegram(promo.image_path);
                
                const sendData = {
                    productName: promo.product_name || 'Produto',
                    message: promo.processed_text || promo.original_text,
                    image: promo.image_path,
                    threadId: threadId,
                    sendCallback: async () => {
                        const bot = global.telegramBot;
                        console.log(`[SendCallback] 🔍 Iniciando envio (no-affiliate) - Bot existe: ${!!bot}, Bot.telegram existe: ${!!(bot && bot.telegram)}`);
                        
                        if (!bot || !bot.telegram) {
                            throw new Error('Bot não está inicializado');
                        }
                        const groupChatId = await Config.getGroupChatId() || process.env.GROUP_CHAT_ID;
                        console.log(`[SendCallback] 📍 GroupChatId: ${groupChatId}, ThreadId: ${threadId}, ImageSource: ${imageSource ? (typeof imageSource === 'string' ? imageSource.substring(0, 50) : JSON.stringify(imageSource).substring(0, 80)) : 'NENHUMA'}`);
                        
                        if (imageSource) {
                            console.log(`[SendCallback] 📸 Enviando com IMAGEM...`);
                            const result = await bot.telegram.sendPhoto(groupChatId, imageSource, {
                                caption: promo.processed_text || promo.original_text,
                                parse_mode: 'HTML',
                                message_thread_id: threadId || undefined
                            });
                            console.log(`[SendCallback] ✅ Foto enviada! Message ID: ${result?.message_id}`);
                        } else {
                            console.log(`[SendCallback] 📝 Enviando TEXTO apenas...`);
                            const result = await bot.telegram.sendMessage(groupChatId, promo.processed_text || promo.original_text, {
                                parse_mode: 'HTML',
                                message_thread_id: threadId || undefined,
                                disable_web_page_preview: false
                            });
                            console.log(`[SendCallback] ✅ Mensagem enviada! Message ID: ${result?.message_id}`);
                        }
                    }
                };
                
                enqueueDirectSend(sendData);
                approvedCount++;
            } catch (err) {
                console.error(`Error approving no-affiliate promo ${promo.id}:`, err.message);
            }
        }
        
        // Broadcast updated count
        const count = await PendingPromotions.getNoAffiliateCount();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'no_affiliate_count_update',
                    data: { count },
                    timestamp: new Date().toISOString()
                }));
            }
        });
        
        console.log(`[ApproveAllNoAff] ✅ ${approvedCount} promoções aprovadas, ${skippedDuplicates} duplicados ignorados`);
        res.json({ 
            success: true, 
            message: `${approvedCount} promoções aprovadas${skippedDuplicates > 0 ? `, ${skippedDuplicates} duplicados ignorados` : ''}`, 
            count: approvedCount,
            skippedDuplicates 
        });
    } catch (err) {
        console.error('Error approving all no-affiliate:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Reject all no-affiliate promotions
app.post('/api/no-affiliate-promotions/reject-all', async (req, res) => {
    try {
        const pending = await PendingPromotions.getNoAffiliate();
        
        if (pending.length === 0) {
            return res.json({ success: true, message: 'Nenhuma promoção sem afiliado', count: 0 });
        }
        
        let rejectedCount = 0;
        
        for (const promo of pending) {
            try {
                await PendingPromotions.reject(promo.id, 'Recusado em lote (sem afiliado)');
                rejectedCount++;
            } catch (err) {
                console.error(`Error rejecting no-affiliate promo ${promo.id}:`, err.message);
            }
        }
        
        // Broadcast updated count
        const count = await PendingPromotions.getNoAffiliateCount();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'no_affiliate_count_update',
                    data: { count },
                    timestamp: new Date().toISOString()
                }));
            }
        });
        
        console.log(`[RejectAllNoAff] ✅ ${rejectedCount} promoções recusadas`);
        res.json({ success: true, message: `${rejectedCount} promoções recusadas`, count: rejectedCount });
    } catch (err) {
        console.error('Error rejecting all no-affiliate:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get pending promotions history
app.get('/api/pending-promotions/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = await PendingPromotions.getHistory(limit);
        res.json({ success: true, data: history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get categories for dropdown
app.get('/api/categories', async (req, res) => {
    try {
        const categories = await Category.getAll();
        res.json({ success: true, data: categories });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================= END PENDING PROMOTIONS API =========================

// ========================= EXCLUDED URLS API =========================

// Get all excluded URL patterns
app.get('/api/excluded-urls', async (req, res) => {
    try {
        const urls = await ExcludedUrls.getAll();
        res.json({ success: true, data: urls });
    } catch (err) {
        console.error('Error getting excluded URLs:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Add a new excluded URL pattern
app.post('/api/excluded-urls', async (req, res) => {
    try {
        const { pattern, description } = req.body;
        if (!pattern) {
            return res.status(400).json({ error: 'Padrão é obrigatório' });
        }
        const id = await ExcludedUrls.add(pattern, description || '');
        res.json({ success: true, id, message: 'Padrão adicionado com sucesso' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update an excluded URL pattern
app.put('/api/excluded-urls/:id', async (req, res) => {
    try {
        const { pattern, description, active } = req.body;
        await ExcludedUrls.update(req.params.id, pattern, description, active);
        res.json({ success: true, message: 'Padrão atualizado com sucesso' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle active status
app.post('/api/excluded-urls/:id/toggle', async (req, res) => {
    try {
        await ExcludedUrls.toggleActive(req.params.id);
        res.json({ success: true, message: 'Status alterado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete an excluded URL pattern
app.delete('/api/excluded-urls/:id', async (req, res) => {
    try {
        await ExcludedUrls.delete(req.params.id);
        res.json({ success: true, message: 'Padrão removido com sucesso' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================= END EXCLUDED URLS API =========================

// ========================= RATE LIMIT & QUEUE API =========================

// Get rate limit settings
app.get('/api/rate-limit/settings', (req, res) => {
    const settings = globalRateLimiter.getSettings();
    res.json({ success: true, data: settings });
});

// Update rate limit settings
app.post('/api/rate-limit/settings', async (req, res) => {
    try {
        const { maxMessages, timeWindowSeconds } = req.body;
        
        if (!maxMessages || !timeWindowSeconds) {
            return res.status(400).json({ error: 'maxMessages e timeWindowSeconds são obrigatórios' });
        }
        
        // Update the rate limiter
        globalRateLimiter.updateSettings(maxMessages, timeWindowSeconds);
        
        // Save to database for persistence
        const { pool } = require('./config/db');
        
        // Save maxMessages
        const [existingMax] = await pool.execute('SELECT id FROM config WHERE key_name = ? LIMIT 1', ['RATE_LIMIT_MAX_MESSAGES']);
        if (existingMax.length > 0) {
            await pool.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [String(maxMessages), 'RATE_LIMIT_MAX_MESSAGES']);
        } else {
            await pool.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', ['RATE_LIMIT_MAX_MESSAGES', String(maxMessages)]);
        }
        
        // Save timeWindow
        const [existingTime] = await pool.execute('SELECT id FROM config WHERE key_name = ? LIMIT 1', ['RATE_LIMIT_TIME_WINDOW']);
        if (existingTime.length > 0) {
            await pool.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [String(timeWindowSeconds), 'RATE_LIMIT_TIME_WINDOW']);
        } else {
            await pool.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', ['RATE_LIMIT_TIME_WINDOW', String(timeWindowSeconds)]);
        }
        
        res.json({ success: true, message: 'Configurações de rate limit atualizadas' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get rate limit status
app.get('/api/rate-limit/status', (req, res) => {
    const status = globalRateLimiter.getStatus();
    // Format for frontend
    res.json({
        current: status.current,
        maxMessages: status.max,
        timeWindowSeconds: status.timeWindow,
        remaining: status.remaining,
        timeUntilNext: status.timeUntilNext
    });
});

// Get queue status
app.get('/api/queue/status', (req, res) => {
    const status = UserMonitor.getQueueStatus();
    res.json({ success: true, data: status });
});

// Get recent sent promotions for monitor page
app.get('/api/recent-sent', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        const limit = parseInt(req.query.limit) || 10;
        const [rows] = await pool.query(`
            SELECT id, product_name, source, price, status, processed_at as sent_at 
            FROM pending_promotions 
            WHERE status = 'approved' 
            ORDER BY processed_at DESC 
            LIMIT ?
        `, [limit]);
        res.json(rows);
    } catch (err) {
        console.error('Error getting recent sent:', err.message);
        res.json([]);
    }
});

// Get today's stats for monitor page
app.get('/api/stats/today', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        const today = new Date().toISOString().split('T')[0];
        
        const [sent] = await pool.query(`
            SELECT COUNT(*) as count FROM pending_promotions 
            WHERE status = 'approved' AND DATE(processed_at) = ?
        `, [today]);
        
        const [approved] = await pool.query(`
            SELECT COUNT(*) as count FROM pending_promotions 
            WHERE status = 'approved' AND DATE(created_at) = ?
        `, [today]);
        
        const [rejected] = await pool.query(`
            SELECT COUNT(*) as count FROM pending_promotions 
            WHERE status = 'rejected' AND DATE(processed_at) = ?
        `, [today]);
        
        // Get duplicates from Redis (approximate count)
        let duplicates = 0;
        try {
            const keys = await redis.keys('promo:*');
            duplicates = keys.length;
        } catch (e) {
            // Ignore Redis errors
        }
        
        // Get by source distribution
        const [bySourceRows] = await pool.query(`
            SELECT source, COUNT(*) as count FROM pending_promotions 
            WHERE status = 'approved' AND DATE(processed_at) = ?
            GROUP BY source
        `, [today]);
        
        const bySource = {};
        bySourceRows.forEach(row => {
            const src = (row.source || 'outros').toLowerCase();
            bySource[src] = (bySource[src] || 0) + row.count;
        });
        
        // Get hourly data
        const [hourlyRows] = await pool.query(`
            SELECT HOUR(processed_at) as hour, COUNT(*) as count 
            FROM pending_promotions 
            WHERE status = 'approved' AND DATE(processed_at) = ?
            GROUP BY HOUR(processed_at)
            ORDER BY hour
        `, [today]);
        
        const hourlyData = Array(24).fill(0);
        hourlyRows.forEach(row => {
            if (row.hour >= 0 && row.hour < 24) {
                hourlyData[row.hour] = row.count;
            }
        });
        
        res.json({
            sent: sent[0]?.count || 0,
            approved: approved[0]?.count || 0,
            rejected: rejected[0]?.count || 0,
            duplicates: duplicates,
            bySource: bySource,
            hourlyData: hourlyData
        });
    } catch (err) {
        console.error('Error getting stats:', err.message);
        res.json({ sent: 0, approved: 0, rejected: 0, duplicates: 0, bySource: {}, hourlyData: Array(24).fill(0) });
    }
});

// Get monitored groups for monitor page
app.get('/api/monitored', async (req, res) => {
    try {
        const groups = await Monitoring.getAll();
        res.json(groups);
    } catch (err) {
        console.error('Error getting monitored groups:', err.message);
        res.json([]);
    }
});

// System health check for monitor page
app.get('/api/monitor/health', async (req, res) => {
    const health = {
        redis: { status: 'offline', latency: 0 },
        mysql: { status: 'offline', latency: 0 },
        bot: { status: 'offline' },
        puppeteer: { status: 'offline' },
        shopee: { status: 'online', latency: 50 },
        mercadolivre: { status: 'online', latency: 80 },
        aliexpress: { status: 'online', latency: 120 },
        amazon: { status: 'online', latency: 60 },
        ai: { status: 'online', latency: 200 }
    };
    
    // Check Redis
    try {
        const start = Date.now();
        await redis.ping();
        health.redis = { status: 'online', latency: Date.now() - start };
    } catch (e) {
        health.redis = { status: 'offline', latency: 0 };
    }
    
    // Check MySQL
    try {
        const { pool } = require('./config/db');
        const start = Date.now();
        await pool.query('SELECT 1');
        health.mysql = { status: 'online', latency: Date.now() - start };
    } catch (e) {
        health.mysql = { status: 'offline', latency: 0 };
    }
    
    // Check Telegram Bot
    try {
        if (global.telegramBot && global.telegramBot.telegram) {
            health.bot = { status: 'online' };
        }
    } catch (e) {
        // Bot offline
    }
    
    // Puppeteer is always ready (lazy loaded)
    health.puppeteer = { status: 'online' };
    
    res.json(health);
});

// ========================= END RATE LIMIT & QUEUE API =========================

// Preview Post
app.post('/api/preview', upload.single('image'), async (req, res) => {
    try {
        const { content } = req.body;
        const imageFile = req.file;
        
        const urls = content.match(/(https?:\/\/[^\s]+)/g) || [];
        
        // Check if duplicate
        const primaryUrl = urls[0];
        const key = primaryUrl ? 'promo:' + crypto.createHash('sha1').update(primaryUrl).digest('hex') : null;
        const isDuplicate = key ? await redis.get(key) : false;
        
        // Extract basic info (simplified)
        const lines = content.split('\n');
        const title = lines[0].replace(/[🛒🔥💥🚨]/g, '').trim();
        const priceMatch = content.match(/R\$\s*[\d.,]+/);
        const price = priceMatch ? priceMatch[0] : '';
        const couponMatch = content.match(/🎟.*?(https:\/\/[^\s]+|[A-Z0-9]{4,20})/i);
        const coupon = couponMatch ? couponMatch[1] : '';
        
        // Convert image to base64 for preview
        let imagePreview = null;
        if (imageFile) {
            const imageBuffer = fs.readFileSync(imageFile.path);
            imagePreview = `data:${imageFile.mimetype};base64,${imageBuffer.toString('base64')}`;
            // Clean up uploaded file
            fs.unlinkSync(imageFile.path);
        }
        
        res.json({
            title,
            price,
            coupon,
            links: urls.slice(0, 3),
            isDuplicate: !!isDuplicate,
            imagePreview
        });
    } catch (err) {
        console.error('Preview error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Manual Post / Schedule
app.post('/api/post', upload.single('image'), async (req, res) => {
    try {
        const { content, scheduleTime } = req.body;
        const imageFile = req.file;
        
        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Conteúdo é obrigatório' });
        }
        
        // Check if this is a scheduled post
        const isScheduled = scheduleTime && scheduleTime.trim();
        
        if (isScheduled) {
            // Save to scheduled_posts table
            const { pool } = require('./config/db');
            
            // Validate schedule time
            const scheduledDate = new Date(scheduleTime);
            const now = new Date();
            
            if (isNaN(scheduledDate.getTime())) {
                return res.status(400).json({ error: 'Data e hora inválidas' });
            }
            
            if (scheduledDate <= now) {
                return res.status(400).json({ error: 'A data deve ser no futuro' });
            }
            
            // Store image path locally (do NOT send to Telegram yet)
            let imagePath = null;
            if (imageFile) {
                // Keep the uploaded file at its current path for later processing
                imagePath = imageFile.path;
                console.log(`[Scheduled] Image saved at: ${imagePath}`);
            }
            
            await pool.execute(
                'INSERT INTO scheduled_posts (content, image_url, schedule_time, status) VALUES (?, ?, ?, ?)',
                [content, imagePath, scheduleTime, 'pending']
            );
            
            return res.json({ status: 'ok', message: 'Postagem agendada com sucesso' });
        } else {
            // Post immediately
            let imageSource = null;
            if (imageFile) {
                imageSource = { source: fs.readFileSync(imageFile.path) };
            }
            
            await handlePromotionFlow(content, null, imageSource);
            
            // Clean up
            if (imageFile && fs.existsSync(imageFile.path)) {
                fs.unlinkSync(imageFile.path);
            }
            
            return res.json({ status: 'ok', message: 'Postagem enviada com sucesso' });
        }
    } catch (err) {
        console.error('Post error:', err);
        // Clean up uploaded file on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: err.message });
    }
});

// Get Logs
app.get('/api/logs', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        const limit = parseInt(req.query.limit) || 50;
        const type = req.query.type; // optional filter: 'success', 'error', 'warning'
        
        // Build query with optional type filter
        let query = 'SELECT type, message, details, timestamp FROM system_logs';
        let params = [];
        
        if (type) {
            query += ' WHERE type = ?';
            params.push(type);
        }
        
        // LIMIT must be a literal integer in some MySQL versions
        const limitInt = parseInt(limit) || 50;
        query += ` ORDER BY timestamp DESC LIMIT ${limitInt}`;
        
        // Get logs from system_logs table
        const [logs] = await pool.execute(query, params);
        
        // If no logs in database, get from post_history as fallback
        if (logs.length === 0) {
            const [postLogs] = await pool.execute(`
                SELECT 
                    CASE WHEN success = 1 THEN 'success' ELSE 'error' END as type,
                    CONCAT('Postagem: ', product_name) as message,
                    CONCAT(category, ' - ', price) as details,
                    posted_at as timestamp
                FROM post_history
                ORDER BY posted_at DESC
                LIMIT 20
            `);
            return res.json(postLogs);
        }
        
        res.json(logs);
    } catch (err) {
        logger.error(`Error fetching logs: ${err.message}`);
        console.error('Erro ao buscar logs:', err);
        res.json([]);
    }
});

// Get Recent Activity
app.get('/api/recent-activity', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        
        const [activities] = await pool.execute(`
            SELECT 
                product_name,
                category,
                price,
                posted_at,
                success,
                coupon
            FROM post_history
            ORDER BY posted_at DESC
            LIMIT 10
        `);
        
        res.json(activities);
    } catch (err) {
        console.error('Erro ao buscar atividade recente:', err);
        res.json([]);
    }
});

// Get Scheduled Posts
app.get('/api/scheduled', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        
        const [posts] = await pool.execute(`
            SELECT id, content, image_url, schedule_time, status, created_at
            FROM scheduled_posts
            WHERE status = 'pending'
            ORDER BY schedule_time ASC
        `);
        
        // Format preview (first 100 chars)
        const formattedPosts = posts.map(post => ({
            ...post,
            preview: post.content.length > 100 ? post.content.substring(0, 100) + '...' : post.content
        }));
        
        res.json(formattedPosts);
    } catch (err) {
        console.error('Error fetching scheduled posts:', err);
        res.status(500).json({ error: err.message });
    }
});

// Cancel scheduled post
app.delete('/api/scheduled/:id', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        const { id } = req.params;
        
        await pool.execute(
            'UPDATE scheduled_posts SET status = ? WHERE id = ?',
            ['cancelled', id]
        );
        
        res.json({ status: 'ok', message: 'Postagem cancelada' });
    } catch (err) {
        console.error('Error cancelling scheduled post:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// Forbidden Words API Endpoints
// ============================================

// Get all forbidden words
app.get('/api/forbidden-words', async (req, res) => {
    try {
        const words = await ForbiddenWords.getAllWithIds();
        res.json(words);
    } catch (err) {
        logger.error(`Error fetching forbidden words: ${err.message}`);
        console.error('Error fetching forbidden words:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add forbidden word
app.post('/api/forbidden-words', async (req, res) => {
    try {
        const { word } = req.body;
        if (!word || !word.trim()) {
            return res.status(400).json({ error: 'Palavra não pode estar vazia' });
        }
        
        await ForbiddenWords.add(word.trim().toLowerCase());
        logger.info(`Forbidden word added: ${word}`);
        res.json({ status: 'ok', message: 'Palavra proibida adicionada' });
    } catch (err) {
        logger.error(`Error adding forbidden word: ${err.message}`);
        console.error('Error adding forbidden word:', err);
        res.status(500).json({ error: err.message });
    }
});

// Remove forbidden word
app.delete('/api/forbidden-words/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await ForbiddenWords.remove(id);
        logger.info(`Forbidden word removed: ID ${id}`);
        res.json({ status: 'ok', message: 'Palavra proibida removida' });
    } catch (err) {
        logger.error(`Error removing forbidden word: ${err.message}`);
        console.error('Error removing forbidden word:', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper endpoint to get chat info
app.get('/get-chat-info-old', async (req, res) => {
    const chatId = req.query.chat_id || process.env.GROUP_CHAT_ID;
    if (!chatId) return res.status(400).json({ error: 'Chat ID required' });
    
    if (!bot) return res.status(500).json({ error: 'Bot not initialized' });
    try {
        const chat = await bot.telegram.getChat(chatId);
        res.json({ chat });
    } catch (err) {
        res.status(500).json({ error: (err && err.message) || String(err) });
    }
});

// ============================================
// SaaS Features: Settings & Customization
// ============================================

// 1. Settings Management
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await Settings.getAll();
        res.json(settings);
    } catch (err) {
        logger.error(`Error fetching settings: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const settingsToUpdate = req.body; // { key: value, ... }
        await Settings.updateBulk(settingsToUpdate);
        
        // Update process.env in memory
        for (const [key, value] of Object.entries(settingsToUpdate)) {
            process.env[key] = value;
        }
        
        logger.info('Settings updated successfully');
        res.json({ status: 'ok', message: 'Configurações salvas' });
    } catch (err) {
        logger.error(`Error updating settings: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 2. Restart Bot
app.post('/api/settings/restart-bot', async (req, res) => {
    try {
        const success = await reinitializeBot();
        if (success) {
            res.json({ status: 'ok', message: 'Bot reiniciado com sucesso' });
        } else {
            res.status(500).json({ error: 'Falha ao reiniciar bot. Verifique os logs.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Logo Upload
const logoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public/img'));
    },
    filename: (req, file, cb) => {
        // Always save as logo.png to replace existing
        cb(null, 'logo.png');
    }
});
const logoUpload = multer({ storage: logoStorage });

app.post('/api/upload/logo', logoUpload.single('logo'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    logger.info('Logo updated');
    res.json({ status: 'ok', message: 'Logo atualizada com sucesso' });
});

// Upload de imagem genérica (para promoções)
const promoImageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../uploads');
        // Criar diretório se não existir
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Gerar nome único com timestamp e random
        const uniqueName = `promo_${Date.now()}_${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const promoImageUpload = multer({ 
    storage: promoImageStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não permitido. Use JPG, PNG, GIF ou WebP.'));
        }
    }
});

app.post('/api/upload-image', promoImageUpload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    
    // Retornar caminho relativo para usar na promoção
    const imagePath = `/uploads/${req.file.filename}`;
    logger.info(`Image uploaded: ${imagePath}`);
    res.json({ success: true, path: imagePath, filename: req.file.filename });
});

// 4. Backup / Export
app.get('/api/backup/export', async (req, res) => {
    try {
        const { pool } = require('./config/db');
        
        // Fetch all data
        const [categories] = await pool.execute('SELECT * FROM categories');
        const [monitoring] = await pool.execute('SELECT * FROM monitoring');
        const [config] = await pool.execute('SELECT * FROM config');
        const [forbiddenWords] = await pool.execute('SELECT * FROM forbidden_words');
        
        const exportData = {
            timestamp: new Date().toISOString(),
            version: '1.0',
            data: {
                categories,
                monitoring,
                config,
                forbiddenWords
            }
        };
        
        res.header('Content-Type', 'application/json');
        res.header('Content-Disposition', `attachment; filename="backup-ofertassertao-${Date.now()}.json"`);
        res.send(JSON.stringify(exportData, null, 2));
    } catch (err) {
        logger.error(`Export error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/delete-category/:id', async (req, res) => {
    try {
        await Category.delete(req.params.id);
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Erro ao deletar categoria');
    }
});

// Function to setup bot handlers (extracted for reuse in restart)
function setupBotHandlers(botInstance) {
  if (!botInstance) return;

  botInstance.catch((err, ctx) => {
    console.error('Bot error:', err.message || err);
  });

  // Command: /getchatid - Get chat ID (for non-topic chats)
  botInstance.command('getchatid', async (ctx) => {
    try {
      console.log('Command /getchatid received from chat', ctx.chat && ctx.chat.id);
      const chatId = ctx.chat && ctx.chat.id;
      const chatType = ctx.chat && ctx.chat.type;
      await ctx.reply(`💬 Chat ID: ${chatId}\n📋 Tipo: ${chatType}`);
    } catch (e) {
      console.error('getchatid error:', e);
      await ctx.reply('❌ Não foi possível obter o Chat ID');
    }
  });

  // Command: /getgroupid - Get group ID (alias for getchatid)
  botInstance.command('getgroupid', async (ctx) => {
    try {
      console.log('Command /getgroupid received from chat', ctx.chat && ctx.chat.id);
      const chatId = ctx.chat && ctx.chat.id;
      const chatType = ctx.chat && ctx.chat.type;
      const chatTitle = ctx.chat && ctx.chat.title;
      
      let response = `🏷️ ID do Grupo: ${chatId}`;
      if (chatTitle) response += `\n📝 Nome: ${chatTitle}`;
      response += `\n📋 Tipo: ${chatType}`;
      
      await ctx.reply(response);
    } catch (e) {
      console.error('getgroupid error:', e);
      await ctx.reply('❌ Não foi possível obter o ID do Grupo');
    }
  });

  // Command: /gettopicid - Get topic/thread ID
  botInstance.command('gettopicid', async (ctx) => {
    try {
      console.log('Command /gettopicid received from chat', ctx.chat && ctx.chat.id);
      const msg = ctx.message || ctx.update.channel_post || {};
      const thread = msg.message_thread_id || msg.message_thread || null;
      
      if (!thread) {
        await ctx.reply('❌ Você não está dentro de um tópico. Execute este comando dentro do tópico desejado.');
      } else {
        await ctx.reply(`📌 ID do Tópico (Thread ID): ${thread}`);
      }
    } catch (e) {
      console.error('gettopicid error:', e);
      await ctx.reply('❌ Não foi possível obter o ID do Tópico');
    }
  });

  // Handler for forwarded messages - shows info like Json Dump Bot
  botInstance.on(['message', 'channel_post'], async (ctx) => {
    try {
      const msg = ctx.message || ctx.channel_post || {};
      
      // Check if message is forwarded (using both old and new API fields)
      const hasForwardInfo = msg.forward_from_chat || msg.forward_from || msg.forward_sender_name || msg.forward_origin;
      
      if (hasForwardInfo && ctx.chat.type === 'private') {
        console.log('Forwarded message detected');
        
        let infoText = '📨 **Informações da Mensagem Encaminhada**\n\n';
        
        // Try new API first (forward_origin - Bot API 7.0+)
        if (msg.forward_origin) {
          const origin = msg.forward_origin;
          
          if (origin.type === 'channel') {
            // Message from a channel
            infoText += `📢 **Origem: Canal**\n`;
            infoText += `🏷️ **ID do Canal:** \`${origin.chat.id}\`\n`;
            if (origin.chat.title) infoText += `📋 **Nome:** ${origin.chat.title}\n`;
            if (origin.chat.username) infoText += `👤 **Username:** @${origin.chat.username}\n`;
            if (origin.message_id) infoText += `🆔 **ID da Mensagem:** ${origin.message_id}\n`;
            if (origin.author_signature) infoText += `✍️ **Assinatura:** ${origin.author_signature}\n`;
          } else if (origin.type === 'chat') {
            // Message from a group/supergroup with author signature
            infoText += `👥 **Origem: Grupo**\n`;
            infoText += `🏷️ **ID do Grupo:** \`${origin.sender_chat.id}\`\n`;
            if (origin.sender_chat.title) infoText += `📋 **Nome:** ${origin.sender_chat.title}\n`;
            if (origin.sender_chat.username) infoText += `👤 **Username:** @${origin.sender_chat.username}\n`;
            if (origin.author_signature) infoText += `✍️ **Autor:** ${origin.author_signature}\n`;
          } else if (origin.type === 'user') {
            // Message from a user
            infoText += `👤 **Origem: Usuário**\n`;
            infoText += `🆔 **User ID:** \`${origin.sender_user.id}\`\n`;
            if (origin.sender_user.first_name) {
              infoText += `📝 **Nome:** ${origin.sender_user.first_name}`;
              if (origin.sender_user.last_name) infoText += ` ${origin.sender_user.last_name}`;
              infoText += '\n';
            }
            if (origin.sender_user.username) infoText += `👤 **Username:** @${origin.sender_user.username}\n`;
            infoText += `\n⚠️ *Nota: Esta mensagem foi encaminhada de um usuário. O Telegram não revela o grupo/chat onde o usuário enviou a mensagem por questões de privacidade.*\n`;
          } else if (origin.type === 'hidden_user') {
            infoText += `👤 **Origem:** ${origin.sender_user_name}\n`;
            infoText += `🔒 *Usuário ocultou suas informações*\n`;
          }
        } else {
          // Fallback to old API fields
          
          // Info from forwarded chat (channel/group)
          if (msg.forward_from_chat) {
            const fwdChat = msg.forward_from_chat;
            const chatTypeEmoji = fwdChat.type === 'channel' ? '📢' : '👥';
            const chatTypeName = fwdChat.type === 'channel' ? 'Canal' : 'Grupo';
            
            infoText += `${chatTypeEmoji} **Origem: ${chatTypeName}**\n`;
            infoText += `🏷️ **ID:** \`${fwdChat.id}\`\n`;
            infoText += `📝 **Tipo:** ${fwdChat.type || 'N/A'}\n`;
            
            if (fwdChat.title) {
              infoText += `📋 **Nome:** ${fwdChat.title}\n`;
            }
            
            if (fwdChat.username) {
              infoText += `👤 **Username:** @${fwdChat.username}\n`;
            }
            
            if (msg.forward_from_message_id) {
              infoText += `🆔 **ID da Mensagem Original:** ${msg.forward_from_message_id}\n`;
            }
            
            if (msg.forward_signature) {
              infoText += `✍️ **Assinatura:** ${msg.forward_signature}\n`;
            }
          }
          
          // Info from forwarded user (if forwarded from private chat or user in group)
          if (msg.forward_from) {
            const fwdUser = msg.forward_from;
            infoText += `👤 **Origem: Usuário**\n`;
            infoText += `🆔 **User ID:** \`${fwdUser.id}\`\n`;
            
            if (fwdUser.first_name) {
              infoText += `📝 **Nome:** ${fwdUser.first_name}`;
              if (fwdUser.last_name) infoText += ` ${fwdUser.last_name}`;
              infoText += '\n';
            }
            
            if (fwdUser.username) {
              infoText += `👤 **Username:** @${fwdUser.username}\n`;
            }
            
            if (fwdUser.is_bot) {
              infoText += `🤖 **É um Bot:** Sim\n`;
            }
            
            infoText += `\n⚠️ *Nota: Esta mensagem foi encaminhada de um usuário. O Telegram não revela o grupo/chat onde o usuário enviou a mensagem por questões de privacidade.*\n`;
          }
          
          // If user privacy settings hide info
          if (msg.forward_sender_name && !msg.forward_from && !msg.forward_from_chat) {
            infoText += `👤 **Encaminhado de:** ${msg.forward_sender_name}\n`;
            infoText += `🔒 *Informações ocultas por configurações de privacidade*\n`;
          }
        }
        
        // Info about the current chat
        infoText += `\n📍 **Chat Atual:**\n`;
        infoText += `   🆔 **ID:** \`${ctx.chat.id}\`\n`;
        infoText += `   📋 **Tipo:** ${ctx.chat.type}\n`;
        if (ctx.chat.title) {
          infoText += `   📝 **Nome:** ${ctx.chat.title}\n`;
        }
        
        // Message thread info (if in topic)
        if (msg.message_thread_id) {
          infoText += `   📌 **Thread ID:** ${msg.message_thread_id}\n`;
        }
        
        infoText += `\n💡 **Dica:** Para ver IDs de grupos, encaminhe mensagens de **canais** ou de grupos que permitem identificação. Mensagens de usuários em grupos privados não revelam o grupo de origem.`;
        
        await ctx.reply(infoText, { parse_mode: 'Markdown' });
        return; // Stop processing to avoid triggering promotion flow
      }
      
      // Continue with normal message processing
      const chatId = ctx.chat && ctx.chat.id;
      logger.info(`Message received from chat: ${chatId}`);
      console.log('Message received from chat:', chatId);
      const monitored = await Monitoring.isMonitored(chatId);
      if (!monitored) return;

      const text = (msg.text || msg.caption || '') + '';
      if (text && text.includes('http')) {
        // Check rate limit
        if (!globalRateLimiter.canProcess()) {
          const status = globalRateLimiter.getStatus();
          logger.warn(`Rate limit exceeded in chat ${chatId}: ${status.current}/${status.max} messages`);
          console.warn(`⏱️ Rate limit: ${status.current}/${status.max} mensagens nos últimos ${status.timeWindow}s`);
          
          // Optionally notify user
          try {
            await ctx.reply(`⏱️ Limite de mensagens atingido. Aguarde ${Math.ceil((status.oldestTimestamp + status.timeWindow * 1000 - Date.now()) / 1000)}s antes de enviar outra oferta.`);
          } catch (replyErr) {
            logger.error(`Failed to send rate limit message: ${replyErr.message}`);
          }
          return;
        }

        logger.info(`Processing promotion from chat ${chatId}`);
        console.log('Processing promotion from chat', chatId);
        
        // Get attached photo if exists (use file_id directly)
        let photoFileId = null;
        if (msg.photo && msg.photo.length > 0) {
          const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
          photoFileId = photo.file_id;
          logger.info(`Photo attached (file_id): ${photoFileId}`);
          console.log('📸 Photo attached (file_id):', photoFileId);
        }
        
        await handlePromotionFlow(text, ctx, photoFileId);
      }
    } catch (err) {
      logger.error(`Bot handler error: ${err.message}`, { stack: err.stack });
      console.error('bot handler error:', err.message || err);

      // Feedback to user for common errors
      if (ctx && (err.message.includes('Palavras proibidas') || err.message.includes('Rate limit') || err.message.includes('Nenhuma URL') || err.message.includes('Rate limit'))) {
          try {
             await ctx.reply(`⚠️ ${err.message}`, { reply_to_message_id: ctx.message ? ctx.message.message_id : undefined });
          } catch (replyErr) {
             console.error('Failed to send error reply:', replyErr.message);
          }
      }
    }
  });

  console.log('Bot handlers registered');
}

// Bot handling - MUST be registered BEFORE polling starts
if (bot) {
    setupBotHandlers(bot);
} else {
  console.warn('Bot not initialized — Telegram commands unavailable (missing token).');
}

// Launch
const PORT = process.env.PORT || 3000;

// Create HTTP server and WebSocket server
const httpServer = http.createServer(app);
wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    console.log('[WebSocket] Nova conexão estabelecida');
    
    // Send initial pending count
    PendingPromotions.getPendingCount().then(count => {
        ws.send(JSON.stringify({
            type: 'pending_count_update',
            data: { count },
            timestamp: new Date().toISOString()
        }));
    }).catch(err => {
        console.warn('[WebSocket] Error getting initial pending count:', err.message);
    });
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('[WebSocket] Mensagem recebida:', data.type);
            
            // Handle ping/pong for connection health
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
            }
        } catch (err) {
            console.warn('[WebSocket] Error parsing message:', err.message);
        }
    });
    
    ws.on('close', () => {
        console.log('[WebSocket] Conexão fechada');
    });
    
    ws.on('error', (err) => {
        console.warn('[WebSocket] Error:', err.message);
    });
});

// Re-initialize promotion flow with WebSocket server
initializePromotionFlow(bot, Config, wss);

const server = httpServer.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Load settings from database FIRST
  await initializeApp();
  
  // Start scheduled posts processor
  startScheduledPostsProcessor();
  
  // Auto-start user monitoring if session exists
  try {
    const apiId = process.env.TELEGRAM_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH;
    
    if (apiId && apiHash) {
      console.log('[UserMonitor] Tentando conectar automaticamente...');
      const connectResult = await UserMonitor.connectWithSession(apiId, apiHash);
      
      if (connectResult.success) {
        console.log(`[UserMonitor] ✅ Conectado automaticamente como ${connectResult.user?.firstName || 'usuário'}`);
        
        // Auto-start monitoring
        const monitorResult = await UserMonitor.startMonitoring();
        console.log(`[UserMonitor] ✅ ${monitorResult.message}`);
      } else {
        console.log('[UserMonitor] ⚠️ Sessão não encontrada ou expirada. Faça login pelo painel.');
      }
    } else {
      console.log('[UserMonitor] ⚠️ API_ID/API_HASH não configurados. Configure nas settings.');
    }
  } catch (err) {
    console.error('[UserMonitor] ❌ Erro ao iniciar monitoramento automático:', err.message);
  }
});

if (bot) {
  console.log('Bot instance created, attempting to launch...');
  bot.catch((err, ctx) => {
    console.error('Bot error:', err.message || err);
  });
  
  // Use polling explicitly instead of relying on launch() to decide
  console.log('Starting bot polling...');
  bot.startPolling();
  
  // Try to set commands after a short delay
  setTimeout(async () => {
    try {
      console.log('Attempting to set bot commands...');
      const commands = [
        { command: 'getgroupid', description: 'Pegar ID do Grupo' },
        { command: 'gettopicid', description: 'Pegar ID do Tópico' },
        { command: 'getchatid', description: 'Pegar ID do chat que não é tópico' }
      ];
      
      // Set commands for group chats
      await bot.telegram.setMyCommands(commands, { scope: { type: 'all_group_chats' } });
      console.log('Bot commands registered for group chats');
      
      // Also set for private chats
      await bot.telegram.setMyCommands(commands, { scope: { type: 'all_private_chats' } });
      console.log('Bot commands registered for private chats');
      
      console.log('Bot launched successfully');
    } catch (e) {
      console.error('setMyCommands failed:', e.message || e);
      console.log('Bot is polling but commands could not be set');
    }
  }, 1000);
} else {
  console.error('Bot is null - token may be missing or invalid');
}

process.once('SIGINT', () => {
  console.log('Shutting down...');
  if (bot) bot.stop('SIGINT');
  server.close(() => process.exit(0));
});

process.once('SIGTERM', () => {
  console.log('Shutting down...');
  if (bot) bot.stop('SIGTERM');
  server.close(() => process.exit(0));
});