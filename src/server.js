require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const multer = require('multer');
const fs = require('fs');

const redis = require('./config/redis');
const Category = require('./models/categoryModel');
const Monitoring = require('./models/monitoringModel');
const Config = require('./models/configModel');
const ForbiddenWords = require('./models/forbiddenWordsModel');
const Settings = require('./models/settingsModel');
const { classifyAndCaption } = require('./services/aiService');
const { generateAffiliateLink } = require('./services/affiliateService');
const { fetchMetadata } = require('./services/metaService');
const { handlePromotionFlow, initializePromotionFlow } = require('./services/promotionFlow');
const { startScheduledPostsProcessor } = require('./services/scheduledPostsService');
const { globalRateLimiter } = require('./services/rateLimiter');
const UserMonitor = require('./services/userMonitorService');
const { checkAllAPIs } = require('./services/apiMonitor');
const { createComponentLogger } = require('./config/logger');

const logger = createComponentLogger('Server');

// Configure multer for file uploads
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const app = express();

// Load settings from DB on startup
async function initializeApp() {
    try {
        const settings = await Settings.getAll();
        for (const [key, value] of Object.entries(settings)) {
            if (value) process.env[key] = value;
        }
        logger.info('Global settings loaded from database');
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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Rotas
app.get('/', async (req, res) => {
    const categories = await Category.getAll();
    const monitored = await Monitoring.getAll();
    const groupChatId = await Config.getGroupChatId();
    res.render('index', { categories, monitored, groupChatId });
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
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Start scheduled posts processor
  startScheduledPostsProcessor();
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