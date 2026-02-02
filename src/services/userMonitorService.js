/**
 * User Account Monitor Service
 * Monitors Telegram groups using user's personal account (MTProto)
 * This is separate from the bot monitoring system
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Raw } = require('telegram/events');
const input = require('input');
const fs = require('fs');
const path = require('path');
const { createComponentLogger } = require('../config/logger');
const Monitoring = require('../models/monitoringModel');
const Config = require('../models/configModel');
const { handlePromotionFlow, broadcastToClients } = require('./promotionFlow');
const os = require('os');

const logger = createComponentLogger('UserMonitor');

// Destination chat ID (to exclude from monitoring)
let destinationChatId = null;

// Session file path
const SESSION_FILE = path.join(__dirname, '../../data/user_session.txt');
const DATA_DIR = path.join(__dirname, '../../data');

// Client instance
let client = null;
let isConnected = false;
let isMonitoring = false;

// Auto-reconnect settings
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000; // 5 seconds between reconnect attempts
let reconnectTimeout = null;
let keepAliveInterval = null;
let storedApiId = null;
let storedApiHash = null;

// Cache of monitored IDs for fast lookup (refreshed periodically)
let monitoredIdsCache = new Set();
let lastCacheRefresh = 0;
const CACHE_TTL = 60000; // Refresh cache every 60 seconds

// Track last message ID per channel for polling
let lastMessageIds = new Map();
let pollingInterval = null;
const POLLING_INTERVAL = 10000; // Check for new messages every 10 seconds

// Queue for processing promotions with delay
let promotionQueue = [];
let isProcessingQueue = false;
const PROMOTION_DELAY = 10000; // 10 seconds between each promotion

// Queue for direct sends (approved promotions from panel)
let directSendQueue = [];
let isProcessingDirectQueue = false;

/**
 * Check if a URL is from an affiliate store (not Telegram, blogs, etc)
 */
function isAffiliateStoreUrl(url) {
    const urlLower = url.toLowerCase();
    
    // URLs to EXCLUDE (not stores)
    const excludePatterns = [
        /t\.me\//i,                    // Telegram
        /telegram\.(me|org)/i,
        /wa\.me\//i,                   // WhatsApp
        /whatsapp\.com/i,
        /discord\.(gg|com)/i,
        /youtube\.com/i,
        /youtu\.be/i,
        /instagram\.com/i,
        /facebook\.com/i,
        /twitter\.com/i,
        /x\.com/i,
        /tiktok\.com/i,
        /tecnan\.com/i,                // Reference sites
        /pelando\.com/i,
        /promobit\.com/i,
        /hardmob\.com/i,
        /gatry\.com/i,
        /ofertasertao/i,               // Our own
        /_bot$/i,                      // Bots
        /\/coin-index\//i,             // AliExpress coin pages
    ];
    
    // URLs to INCLUDE (affiliate stores)
    const includePatterns = [
        /shopee\.com/i,
        /mercadolivre\.com/i,
        /mercadolibre\.com/i,
        /amazon\.com/i,
        /amzn\.to/i,
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
    
    // Check if it's an affiliate store
    for (const pattern of includePatterns) {
        if (pattern.test(urlLower)) return true;
    }
    
    // Check if it should be excluded
    for (const pattern of excludePatterns) {
        if (pattern.test(urlLower)) return false;
    }
    
    // Default: assume it might be a store
    return true;
}

// Store pending login state
let pendingLogin = {
    active: false,
    phoneNumber: null,
    phoneCodeHash: null
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
 * Load saved session string
 */
function loadSession() {
    ensureDataDir();
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const session = fs.readFileSync(SESSION_FILE, 'utf8').trim();
            return session;
        }
    } catch (err) {
        logger.warn('Could not load session file:', err.message);
    }
    return '';
}

/**
 * Save session string
 */
function saveSession(sessionString) {
    ensureDataDir();
    try {
        fs.writeFileSync(SESSION_FILE, sessionString);
        logger.info('Session saved successfully');
    } catch (err) {
        logger.error('Could not save session:', err.message);
    }
}

/**
 * Get client status
 */
function getStatus() {
    return {
        connected: isConnected,
        monitoring: isMonitoring,
        hasSession: !!loadSession(),
        pendingLogin: pendingLogin.active
    };
}

/**
 * Initialize the Telegram client
 */
async function initClient(apiId, apiHash) {
    if (!apiId || !apiHash) {
        throw new Error('API_ID e API_HASH são obrigatórios');
    }

    // Store credentials for auto-reconnect
    storedApiId = apiId;
    storedApiHash = apiHash;

    const sessionString = loadSession();
    const stringSession = new StringSession(sessionString);

    client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
        connectionRetries: 5,
        useWSS: true,
        baseLogger: logger,
        autoReconnect: true,
        retryDelay: 3000,
    });

    // Enable catching up on missed messages
    client.floodSleepThreshold = 60;

    // Set up connection event handlers
    setupConnectionHandlers();

    logger.info('Telegram client initialized');
    return client;
}

/**
 * Setup connection event handlers for auto-reconnect
 */
function setupConnectionHandlers() {
    if (!client) return;

    logger.info('Setting up connection handlers for auto-reconnect');

    // Override the client's disconnect method to catch disconnections
    const originalDisconnect = client.disconnect.bind(client);
    client.disconnect = async function(...args) {
        logger.warn('Client disconnect called');
        isConnected = false;
        stopKeepAlive();
        
        // Notify frontend about disconnection
        broadcastToClients({
            type: 'connection_status',
            status: 'disconnected',
            message: 'Conexão encerrada'
        });
        
        return originalDisconnect(...args);
    };

    // Listen for disconnect events via client's internal mechanisms
    if (client._connection) {
        const originalOnDisconnect = client._connection._onDisconnect?.bind(client._connection);
        client._connection._onDisconnect = async function(...args) {
            logger.warn('Connection dropped, will attempt to reconnect...');
            isConnected = false;
            
            // Notify frontend about disconnection
            broadcastToClients({
                type: 'connection_status',
                status: 'disconnected',
                message: 'Conexão perdida, tentando reconectar...'
            });
            
            stopKeepAlive();
            
            if (originalOnDisconnect) {
                await originalOnDisconnect(...args);
            }
            
            // Trigger reconnection
            scheduleReconnect();
        };
    }

    // Also try to catch _handleUpdate for connection issues
    if (typeof client._handleConnectionError === 'function') {
        const originalErrorHandler = client._handleConnectionError.bind(client);
        client._handleConnectionError = async function(...args) {
            logger.warn('Connection error detected');
            isConnected = false;
            broadcastToClients({
                type: 'connection_status',
                status: 'error',
                message: 'Erro de conexão detectado'
            });
            return originalErrorHandler(...args);
        };
    }
}

/**
 * Check connection and reconnect if needed
 */
async function checkConnectionAndReconnect() {
    if (!client) return false;
    
    try {
        // Try a simple API call to check connection
        await client.getMe();
        isConnected = true;
        return true;
    } catch (err) {
        logger.warn(`Connection check failed: ${err.message}`);
        isConnected = false;
        
        // If we're not already reconnecting, schedule one
        if (!reconnectTimeout && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            stopKeepAlive();
            scheduleReconnect();
        }
        
        return false;
    }
}

/**
 * Schedule automatic reconnection
 */
function scheduleReconnect() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Manual intervention required.`);
        return;
    }

    const delay = RECONNECT_DELAY * Math.min(reconnectAttempts + 1, 5); // Exponential backoff, max 25s
    logger.info(`Scheduling reconnect attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay/1000}s...`);

    reconnectTimeout = setTimeout(async () => {
        await attemptReconnect();
    }, delay);

    // Notify frontend about reconnection attempt
    broadcastToClients({
        type: 'connection_status',
        status: 'reconnecting',
        message: `Tentando reconectar (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`,
        attempt: reconnectAttempts + 1,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        nextRetryIn: delay / 1000
    });
}

/**
 * Attempt to reconnect
 */
async function attemptReconnect() {
    if (isConnected) {
        logger.info('Already connected, skipping reconnect');
        return;
    }

    reconnectAttempts++;
    logger.info(`Attempting reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

    try {
        if (!client) {
            if (storedApiId && storedApiHash) {
                await initClient(storedApiId, storedApiHash);
            } else {
                logger.error('Cannot reconnect: no stored credentials');
                broadcastToClients({
                    type: 'connection_status',
                    status: 'error',
                    message: 'Não foi possível reconectar: credenciais não encontradas'
                });
                return;
            }
        }

        await client.connect();
        
        // Check if session is valid
        const me = await client.getMe();
        
        isConnected = true;
        reconnectAttempts = 0; // Reset counter on success
        logger.info(`Reconnected successfully as ${me.firstName}`);

        // Notify frontend about successful reconnection
        broadcastToClients({
            type: 'connection_status',
            status: 'connected',
            message: `Reconectado como ${me.firstName}`,
            user: {
                firstName: me.firstName,
                username: me.username
            }
        });

        // Restart monitoring if it was active
        if (isMonitoring) {
            logger.info('Restarting monitoring after reconnect...');
            // Re-setup event handlers
            await startMonitoring();
        }

        // Start keep-alive
        startKeepAlive();

    } catch (err) {
        logger.error(`Reconnect failed: ${err.message}`);
        isConnected = false;
        
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            broadcastToClients({
                type: 'connection_status',
                status: 'failed',
                message: `Falha ao reconectar após ${MAX_RECONNECT_ATTEMPTS} tentativas. Requer intervenção manual.`
            });
        }
        
        scheduleReconnect();
    }
}

/**
 * Start keep-alive ping to prevent disconnection
 */
function startKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }

    logger.info('Starting keep-alive system (ping every 2 minutes)');

    // Send a ping every 2 minutes to keep connection alive
    keepAliveInterval = setInterval(async () => {
        if (!client) {
            return;
        }

        try {
            // Use getMe() as a simple keep-alive check
            const me = await client.getMe();
            isConnected = true;
            logger.debug(`Keep-alive: connected as ${me.firstName}`);
        } catch (err) {
            logger.warn(`Keep-alive failed: ${err.message}`);
            isConnected = false;
            
            // If ping fails, connection might be dead - try to reconnect
            stopKeepAlive();
            
            // Notify frontend
            broadcastToClients({
                type: 'connection_status',
                status: 'disconnected',
                message: 'Keep-alive falhou, tentando reconectar...'
            });
            
            scheduleReconnect();
        }
    }, 2 * 60 * 1000); // Every 2 minutes (more frequent)
}

/**
 * Stop keep-alive
 */
function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

/**
 * Start phone login process
 */
async function startLogin(apiId, apiHash, phoneNumber) {
    try {
        if (!client) {
            await initClient(apiId, apiHash);
        }

        await client.connect();
        
        // Send code request
        const result = await client.invoke(
            new Api.auth.SendCode({
                phoneNumber: phoneNumber,
                apiId: parseInt(apiId),
                apiHash: apiHash,
                settings: new Api.CodeSettings({
                    allowFlashcall: false,
                    currentNumber: true,
                    allowAppHash: true,
                }),
            })
        );

        pendingLogin = {
            active: true,
            phoneNumber: phoneNumber,
            phoneCodeHash: result.phoneCodeHash
        };

        logger.info('Login code sent to phone');
        return { 
            success: true, 
            message: 'Código enviado para o seu Telegram',
            phoneCodeHash: result.phoneCodeHash
        };
    } catch (err) {
        logger.error('Error starting login:', err.message);
        throw err;
    }
}

/**
 * Complete login with verification code
 */
async function verifyCode(apiId, apiHash, code, password = null) {
    try {
        if (!pendingLogin.active) {
            throw new Error('Nenhum login pendente. Inicie o processo novamente.');
        }

        let result;
        try {
            result = await client.invoke(
                new Api.auth.SignIn({
                    phoneNumber: pendingLogin.phoneNumber,
                    phoneCodeHash: pendingLogin.phoneCodeHash,
                    phoneCode: code,
                })
            );
        } catch (err) {
            // Check if 2FA is required
            if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                if (!password) {
                    return { 
                        success: false, 
                        requires2FA: true, 
                        message: 'Autenticação de dois fatores necessária. Insira sua senha.' 
                    };
                }
                
                // Get password info and verify
                const passwordInfo = await client.invoke(new Api.account.GetPassword());
                const passwordHash = await client.computeSrpParams(passwordInfo, password);
                
                result = await client.invoke(
                    new Api.auth.CheckPassword({
                        password: passwordHash,
                    })
                );
            } else {
                throw err;
            }
        }

        // Save session
        const sessionString = client.session.save();
        saveSession(sessionString);

        isConnected = true;
        pendingLogin = { active: false, phoneNumber: null, phoneCodeHash: null };

        logger.info('Login successful');
        return { success: true, message: 'Login realizado com sucesso!' };
    } catch (err) {
        logger.error('Error verifying code:', err.message);
        throw err;
    }
}

/**
 * Connect using saved session
 */
async function connectWithSession(apiId, apiHash) {
    try {
        const sessionString = loadSession();
        if (!sessionString) {
            return { success: false, message: 'Nenhuma sessão salva encontrada' };
        }

        // Store credentials for auto-reconnect
        storedApiId = apiId;
        storedApiHash = apiHash;

        if (!client) {
            await initClient(apiId, apiHash);
        }

        await client.connect();
        
        // Force catch up on missed updates
        try {
            await client.catchUp();
            logger.info('Caught up on missed updates');
        } catch (e) {
            logger.warn('Could not catch up:', e.message);
        }
        
        // Check if session is still valid
        const me = await client.getMe();
        
        isConnected = true;
        reconnectAttempts = 0; // Reset reconnect counter
        
        // Start keep-alive to prevent disconnection
        startKeepAlive();
        
        logger.info(`Connected as ${me.firstName} (@${me.username || 'no username'})`);
        
        return { 
            success: true, 
            message: `Conectado como ${me.firstName}`,
            user: {
                id: me.id.toString(),
                firstName: me.firstName,
                lastName: me.lastName,
                username: me.username,
                phone: me.phone
            }
        };
    } catch (err) {
        logger.error('Error connecting with session:', err.message);
        isConnected = false;
        return { success: false, message: 'Sessão inválida ou expirada' };
    }
}

/**
 * Disconnect and clear session
 */
async function disconnect() {
    try {
        // Stop keep-alive
        stopKeepAlive();
        
        // Clear any pending reconnect
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
        
        if (client) {
            await client.disconnect();
        }
        isConnected = false;
        isMonitoring = false;
        logger.info('Disconnected');
        return { success: true, message: 'Desconectado' };
    } catch (err) {
        logger.error('Error disconnecting:', err.message);
        return { success: false, message: err.message };
    }
}

/**
 * Logout and delete session
 */
async function logout() {
    try {
        await disconnect();
        
        if (fs.existsSync(SESSION_FILE)) {
            fs.unlinkSync(SESSION_FILE);
        }
        
        client = null;
        logger.info('Logged out and session deleted');
        return { success: true, message: 'Logout realizado e sessão removida' };
    } catch (err) {
        logger.error('Error logging out:', err.message);
        return { success: false, message: err.message };
    }
}

/**
 * Refresh the monitored IDs cache
 */
async function refreshMonitoredIdsCache() {
    try {
        monitoredIdsCache = await Monitoring.getAllMonitoredIds();
        lastCacheRefresh = Date.now();
        console.log(`[UserMonitor] 🔄 Cache atualizado: ${monitoredIdsCache.size} IDs monitorados`);
        // Debug: show all IDs in cache
        console.log(`[UserMonitor] 📋 IDs no cache:`, Array.from(monitoredIdsCache).slice(0, 20));
        return monitoredIdsCache;
    } catch (err) {
        console.error('[UserMonitor] Erro ao atualizar cache:', err.message);
        return monitoredIdsCache; // Return old cache on error
    }
}

/**
 * Check if an ID is monitored (using cache)
 */
async function isIdMonitored(rawChatId) {
    // Refresh cache if stale
    if (Date.now() - lastCacheRefresh > CACHE_TTL) {
        await refreshMonitoredIdsCache();
    }
    
    const idStr = String(rawChatId);
    
    // Generate all possible formats from the raw ID
    // Raw ID from GramJS is usually just the number (e.g., "3537007460")
    // Database may have it as "-1003537007460" or "3537007460" or "-3537007460"
    const possibleFormats = [
        idStr,                          // 3537007460
        `-${idStr}`,                    // -3537007460
        `-100${idStr}`,                 // -1003537007460
        `100${idStr}`,                  // 1003537007460
    ];
    
    // Also handle if the ID already has a prefix
    const numericOnly = idStr.replace(/^-100/, '').replace(/^-/, '').replace(/^100/, '');
    if (numericOnly !== idStr) {
        possibleFormats.push(numericOnly);
        possibleFormats.push(`-${numericOnly}`);
        possibleFormats.push(`-100${numericOnly}`);
    }
    
    // Check each format
    for (const format of possibleFormats) {
        if (monitoredIdsCache.has(format)) {
            console.log(`[UserMonitor] ✅ Match encontrado: ${format}`);
            return true;
        }
    }
    
    return false;
}

/**
 * Download photo from message and return local file path
 */
async function downloadMessagePhoto(message) {
    try {
        if (!message.media || !message.media.photo) {
            return null;
        }
        
        console.log(`[UserMonitor] 📷 Baixando imagem...`);
        
        // Download to temp file
        const tempPath = path.join(os.tmpdir(), `tg_photo_${Date.now()}.jpg`);
        await client.downloadMedia(message.media, {
            outputFile: tempPath
        });
        
        console.log(`[UserMonitor] ✅ Imagem baixada: ${tempPath}`);
        return tempPath;
    } catch (err) {
        console.error(`[UserMonitor] ❌ Erro ao baixar imagem: ${err.message}`);
        return null;
    }
}

/**
 * Check if chat ID is the destination chat (should be excluded from monitoring)
 */
function isDestinationChat(chatId) {
    if (!destinationChatId) return false;
    
    const destStr = String(destinationChatId).replace(/^-100/, '').replace(/^-/, '');
    const chatStr = String(chatId).replace(/^-100/, '').replace(/^-/, '');
    
    return destStr === chatStr;
}

// Maximum retry attempts for failed promotions
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Add promotion to queue for delayed processing
 */
function enqueuePromotion(text, photoSource, source = 'unknown', retryCount = 0) {
    promotionQueue.push({ text, photoSource, source, addedAt: Date.now(), retryCount });
    console.log(`[Queue] ➕ Promoção adicionada à fila (${promotionQueue.length} na fila) - Fonte: ${source}${retryCount > 0 ? ` [tentativa ${retryCount + 1}]` : ''}`);
    
    // Broadcast queue update
    broadcastQueueStatus();
    
    // Start processing if not already running
    if (!isProcessingQueue) {
        processPromotionQueue();
    }
}

/**
 * Add approved promotion to direct send queue
 * This is for promotions approved from the admin panel that are already processed
 * @param {object} sendData - Contains all data needed to send: message, image, threadId, etc
 */
function enqueueDirectSend(sendData) {
    directSendQueue.push({ ...sendData, addedAt: Date.now() });
    console.log(`[DirectQueue] ➕ Promoção aprovada adicionada à fila (${directSendQueue.length} na fila) - ${sendData.productName || 'Produto'}`);
    
    // Broadcast queue update
    broadcastQueueStatus();
    
    // Start processing if not already running
    if (!isProcessingDirectQueue) {
        processDirectSendQueue();
    }
    
    return { queued: true, position: directSendQueue.length };
}

/**
 * Process direct send queue with rate limiting
 */
async function processDirectSendQueue() {
    if (isProcessingDirectQueue || directSendQueue.length === 0) return;
    
    isProcessingDirectQueue = true;
    console.log(`[DirectQueue] 🚀 Iniciando processamento da fila de envio direto (${directSendQueue.length} itens)`);
    broadcastQueueStatus();
    
    // Import required modules
    const { globalRateLimiter } = require('./rateLimiter');
    
    while (directSendQueue.length > 0) {
        const item = directSendQueue[0]; // Peek at first item
        const waitTime = Math.floor((Date.now() - item.addedAt) / 1000);
        const retryCount = item.retryCount || 0;
        
        console.log(`[DirectQueue] 📤 Processando envio (aguardou ${waitTime}s, restam ${directSendQueue.length})${retryCount > 0 ? ` [tentativa ${retryCount + 1}/${MAX_RETRY_ATTEMPTS}]` : ''}`);
        
        // Check rate limit before sending
        if (!globalRateLimiter.canProcess()) {
            const status = globalRateLimiter.getStatus();
            const waitSeconds = status.timeUntilNext || 65;
            console.log(`[DirectQueue] ⏱️ Rate limit atingido! Aguardando ${waitSeconds}s...`);
            broadcastQueueStatus();
            await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
            continue; // Re-check rate limit
        }
        
        // Remove item from queue now that we can process
        directSendQueue.shift();
        broadcastQueueStatus();
        
        let sendSuccess = false;
        let shouldRetry = false;
        
        try {
            // Call the send callback
            if (item.sendCallback && typeof item.sendCallback === 'function') {
                await item.sendCallback();
                console.log(`[DirectQueue] ✅ Promoção ENVIADA: ${item.productName || 'Produto'}`);
                sendSuccess = true;
            }
        } catch (err) {
            console.error(`[DirectQueue] ❌ Erro ao enviar: ${err.message}`);
            
            // If rate limit error, re-queue and wait (don't count as retry)
            if (err.message && (err.message.includes('Too Many Requests') || err.message.includes('FLOOD'))) {
                directSendQueue.unshift(item);
                console.log(`[DirectQueue] ⏱️ Rate limit do Telegram! Aguardando 65s...`);
                broadcastQueueStatus();
                await new Promise(resolve => setTimeout(resolve, 65000));
                continue;
            }
            
            // Check if error is recoverable (network, timeout, connection issues)
            const recoverableErrors = [
                'timeout', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
                'network', 'connection', 'socket', 'disconnected',
                'Telegram server error', 'request failed', 'internal error',
                'Bad Request', 'invalid file'
            ];
            
            const isRecoverable = recoverableErrors.some(e => 
                err.message && err.message.toLowerCase().includes(e.toLowerCase())
            );
            
            if (isRecoverable && retryCount < MAX_RETRY_ATTEMPTS - 1) {
                shouldRetry = true;
            } else if (retryCount >= MAX_RETRY_ATTEMPTS - 1) {
                console.log(`[DirectQueue] ⚠️ Máximo de tentativas atingido (${MAX_RETRY_ATTEMPTS}) - promoção descartada`);
            } else {
                // Unknown error - still try to retry if under limit
                if (retryCount < MAX_RETRY_ATTEMPTS - 1) {
                    shouldRetry = true;
                } else {
                    console.log(`[DirectQueue] ⚠️ Erro após ${MAX_RETRY_ATTEMPTS} tentativas - promoção descartada`);
                }
            }
        }
        
        // Re-queue failed item for retry if needed
        if (shouldRetry) {
            const newRetryCount = retryCount + 1;
            console.log(`[DirectQueue] 🔄 Re-enfileirando promoção para nova tentativa (${newRetryCount}/${MAX_RETRY_ATTEMPTS})`);
            
            // Add back to end of queue with incremented retry count
            directSendQueue.push({
                ...item,
                retryCount: newRetryCount,
                addedAt: Date.now() // Reset wait time for retry
            });
            broadcastQueueStatus();
            
            // Wait a bit before continuing (backoff)
            const backoffDelay = Math.min(5000 * newRetryCount, 30000); // 5s, 10s, 15s... max 30s
            console.log(`[DirectQueue] ⏳ Aguardando ${backoffDelay/1000}s antes de continuar (backoff)...`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            continue;
        }
        
        // Wait before processing next item
        if (directSendQueue.length > 0) {
            console.log(`[DirectQueue] ⏳ Aguardando ${PROMOTION_DELAY/1000}s antes do próximo...`);
            await new Promise(resolve => setTimeout(resolve, PROMOTION_DELAY));
        }
    }
    
    isProcessingDirectQueue = false;
    console.log(`[DirectQueue] ✅ Fila de envio direto vazia`);
    broadcastQueueStatus();
}

/**
 * Broadcast queue status to all clients
 */
function broadcastQueueStatus() {
    const status = getQueueStatusInternal();
    broadcastToClients('queue_status_update', status);
}

/**
 * Get queue status (internal version without module.exports)
 */
function getQueueStatusInternal() {
    const now = Date.now();
    // Include both queues in the count
    const queueLength = promotionQueue.length + directSendQueue.length;
    const isProcessing = isProcessingQueue || isProcessingDirectQueue;
    const estimatedTimeSeconds = queueLength * (PROMOTION_DELAY / 1000);
    
    let avgWaitTime = 0;
    const allItems = [...promotionQueue, ...directSendQueue];
    if (allItems.length > 0) {
        const totalWaitTime = allItems.reduce((sum, item) => {
            return sum + (now - item.addedAt);
        }, 0);
        avgWaitTime = Math.floor((totalWaitTime / allItems.length) / 1000);
    }
    
    return {
        queueLength,
        isProcessing,
        estimatedTimeSeconds,
        avgWaitTimeSeconds: avgWaitTime,
        promotionDelay: PROMOTION_DELAY / 1000,
        // Additional details
        monitorQueue: promotionQueue.length,
        approvalQueue: directSendQueue.length
    };
}

/**
 * Process promotion queue with delay between each
 */
async function processPromotionQueue() {
    if (isProcessingQueue || promotionQueue.length === 0) return;
    
    isProcessingQueue = true;
    console.log(`[Queue] 🚀 Iniciando processamento da fila (${promotionQueue.length} itens)`);
    broadcastQueueStatus();
    
    while (promotionQueue.length > 0) {
        const item = promotionQueue.shift();
        const waitTime = Math.floor((Date.now() - item.addedAt) / 1000);
        const retryCount = item.retryCount || 0;
        
        console.log(`[Queue] 📤 Processando promoção (aguardou ${waitTime}s na fila, restam ${promotionQueue.length})${retryCount > 0 ? ` [tentativa ${retryCount + 1}/${MAX_RETRY_ATTEMPTS}]` : ''}`);
        broadcastQueueStatus();
        
        let wasSkipped = false;
        let sendSuccess = false;
        let shouldRetry = false;
        
        try {
            const result = await handlePromotionFlow(item.text, null, item.photoSource);
            if (result && result.skipped) {
                console.log(`[Queue] ⏭️ Promoção PULADA (duplicata já processada)`);
                wasSkipped = true;
            } else {
                console.log(`[Queue] ✅ Promoção ENVIADA com sucesso`);
                sendSuccess = true;
            }
        } catch (err) {
            console.error(`[Queue] ❌ Erro ao processar: ${err.message}`);
            
            // Check if it's a rate limit error - if so, re-queue the item and wait
            if (err.message && err.message.includes('Rate limit')) {
                // Put item back at the beginning of the queue (don't count as retry)
                promotionQueue.unshift(item);
                console.log(`[Queue] ⏱️ Rate limit atingido! Aguardando 65s antes de retentar... (${promotionQueue.length} na fila)`);
                broadcastQueueStatus();
                
                // Wait 65 seconds before retrying (rate limit window is 60s)
                await new Promise(resolve => setTimeout(resolve, 65000));
                continue; // Skip the normal delay and retry immediately
            }
            
            // Check if error is recoverable (network, timeout, connection issues)
            const recoverableErrors = [
                'timeout', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
                'network', 'connection', 'socket', 'FLOOD_WAIT', 'disconnected',
                'Telegram server error', 'request failed', 'internal error'
            ];
            
            const isRecoverable = recoverableErrors.some(e => 
                err.message && err.message.toLowerCase().includes(e.toLowerCase())
            );
            
            // Non-recoverable errors (don't retry these)
            const nonRecoverableErrors = [
                'forbidden', 'proibidas', 'Nenhuma URL', 'duplicada', 'already processed'
            ];
            
            const isNonRecoverable = nonRecoverableErrors.some(e => 
                err.message && err.message.toLowerCase().includes(e.toLowerCase())
            );
            
            if (isNonRecoverable) {
                console.log(`[Queue] 🚫 Erro não recuperável - promoção descartada`);
            } else if (isRecoverable && retryCount < MAX_RETRY_ATTEMPTS - 1) {
                shouldRetry = true;
            } else if (retryCount >= MAX_RETRY_ATTEMPTS - 1) {
                console.log(`[Queue] ⚠️ Máximo de tentativas atingido (${MAX_RETRY_ATTEMPTS}) - promoção descartada`);
            } else {
                // Unknown error but still try to retry if under limit
                if (retryCount < MAX_RETRY_ATTEMPTS - 1) {
                    shouldRetry = true;
                } else {
                    console.log(`[Queue] ⚠️ Erro desconhecido após ${MAX_RETRY_ATTEMPTS} tentativas - promoção descartada`);
                }
            }
        }
        
        // Re-queue failed item for retry if needed
        if (shouldRetry) {
            const newRetryCount = retryCount + 1;
            console.log(`[Queue] 🔄 Re-enfileirando promoção para nova tentativa (${newRetryCount}/${MAX_RETRY_ATTEMPTS})`);
            
            // Add back to end of queue with incremented retry count
            promotionQueue.push({
                ...item,
                retryCount: newRetryCount,
                addedAt: Date.now() // Reset wait time for retry
            });
            broadcastQueueStatus();
            
            // Wait a bit before continuing (backoff)
            const backoffDelay = Math.min(5000 * (newRetryCount), 30000); // 5s, 10s, 15s... max 30s
            console.log(`[Queue] ⏳ Aguardando ${backoffDelay/1000}s antes de continuar (backoff)...`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            continue;
        }
        
        // Clean up photo file if exists (only if NOT rate limited and not re-queued)
        if (!shouldRetry && item.photoSource && item.photoSource.source && !promotionQueue.some(q => q.photoSource?.source === item.photoSource.source)) {
            try {
                fs.unlinkSync(item.photoSource.source);
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        
        // Wait before processing next item (only if there are more items AND promotion was NOT skipped)
        if (promotionQueue.length > 0 && !wasSkipped) {
            console.log(`[Queue] ⏳ Aguardando ${PROMOTION_DELAY/1000}s antes da próxima...`);
            await new Promise(resolve => setTimeout(resolve, PROMOTION_DELAY));
        } else if (promotionQueue.length > 0 && wasSkipped) {
            console.log(`[Queue] ⚡ Promoção duplicata - processando próxima imediatamente...`);
        }
    }
    
    isProcessingQueue = false;
    console.log(`[Queue] ✅ Fila vazia, processamento finalizado`);
    broadcastQueueStatus();
}

/**
 * Poll monitored channels for new messages (for broadcast channels that don't trigger events)
 */
async function pollMonitoredChannels() {
    if (!client || !isConnected) return;
    
    try {
        const monitoredGroups = await Monitoring.getAll();
        const monitoredIds = new Set(monitoredGroups.map(g => {
            const id = g.chat_id.toString();
            return id.replace(/^-100/, '').replace(/^-/, '');
        }));
        
        // Get all dialogs to check for new messages
        const dialogs = await client.getDialogs({ limit: 200 });
        const channels = dialogs.filter(d => d.isChannel);
        
        for (const channel of channels) {
            try {
                const channelId = channel.id?.toString() || '';
                const numericId = channelId.replace(/^-100/, '').replace(/^-/, '');
                const dbIdFormat = `-100${numericId}`;
                const isMonitored = monitoredIds.has(numericId);
                
                // Skip destination chat (our own group)
                if (isDestinationChat(numericId)) {
                    continue;
                }
                
                // Get last few messages
                const messages = await client.getMessages(channel.entity, { limit: 3 });
                
                if (!messages || messages.length === 0) continue;
                
                // Get the last processed message ID for this channel
                const lastMsgId = lastMessageIds.get(numericId) || 0;
                
                // Process new messages only
                for (const message of messages.reverse()) {
                    if (!message || !message.id) continue;
                    if (message.id <= lastMsgId) continue;
                    
                    // Update last message ID
                    lastMessageIds.set(numericId, message.id);
                    
                    // Skip if no text
                    const text = message.message || '';
                    if (!text) continue;
                    
                    // Extract URLs from entities
                    const extractedUrls = [];
                    if (message.entities && message.entities.length > 0) {
                        for (const ent of message.entities) {
                            if (ent.className === 'MessageEntityTextUrl' && ent.url) {
                                extractedUrls.push(ent.url);
                            }
                            if (ent.className === 'MessageEntityUrl') {
                                const url = text.substring(ent.offset, ent.offset + ent.length);
                                if (url) extractedUrls.push(url);
                            }
                        }
                    }
                    
                    // Check reply markup for button URLs
                    if (message.replyMarkup && message.replyMarkup.rows) {
                        for (const row of message.replyMarkup.rows) {
                            if (row.buttons) {
                                for (const button of row.buttons) {
                                    if (button.url) extractedUrls.push(button.url);
                                }
                            }
                        }
                    }
                    
                    // Filter URLs to keep only affiliate store links
                    const filteredUrls = extractedUrls.filter(url => isAffiliateStoreUrl(url));
                    const textUrls = (text.match(/(https?:\/\/[^\s]+)/g) || []).filter(url => isAffiliateStoreUrl(url));
                    
                    const hasUrlInText = textUrls.length > 0;
                    const hasUrlInEntities = filteredUrls.length > 0;
                    
                    // Always log the message with channel info (for adding to DB)
                    const preview = text.substring(0, 80).replace(/\n/g, ' ');
                    console.log(`\n${'='.repeat(60)}`);
                    console.log(`📡 [POLLING] MENSAGEM DETECTADA`);
                    console.log(`${'='.repeat(60)}`);
                    console.log(`📌 Canal: ${channel.title}`);
                    console.log(`🆔 ID (raw): ${numericId}`);
                    console.log(`🆔 ID (para DB): ${dbIdFormat}`);
                    console.log(`📋 Monitorado: ${isMonitored ? '✅ SIM' : '❌ NÃO - Adicione no painel!'}`);
                    console.log(`📝 Mensagem: ${preview}${text.length > 80 ? '...' : ''}`);
                    if (hasUrlInText || hasUrlInEntities) {
                        console.log(`🔗 URLs: ${hasUrlInText ? 'texto' : ''} ${hasUrlInEntities ? `+ ${extractedUrls.length} entidades` : ''}`);
                    }
                    console.log(`${'='.repeat(60)}\n`);
                    
                    // Only process if monitored and has URL
                    if (!isMonitored) {
                        console.log(`[POLLING] ⚠️ Canal não monitorado. Adicione ${dbIdFormat} no painel para processar.`);
                        continue;
                    }
                    
                    if (!hasUrlInText && !hasUrlInEntities) {
                        console.log(`[POLLING] ⏭️ Sem URL, ignorando`);
                        continue;
                    }
                    
                    // Process the message - use only filtered URLs
                    let processText = text;
                    if (!hasUrlInText && hasUrlInEntities) {
                        processText = text + '\n' + filteredUrls.join('\n');
                    }
                    
                    // Download image if present
                    let photoPath = null;
                    if (message.media && message.media.photo) {
                        photoPath = await downloadMessagePhoto(message);
                    }
                    
                    console.log(`[POLLING] ➕ Adicionando à fila...${photoPath ? ' (com imagem)' : ''}`);
                    
                    // Pass photo path with { source: path } format for Telegraf
                    const photoSource = photoPath ? { source: photoPath } : null;
                    enqueuePromotion(processText, photoSource, `POLLING: ${channel.title}`);
                    // Note: Photo cleanup is handled by the queue processor
                }
            } catch (err) {
                // Silently ignore errors for individual channels
                if (!err.message.includes('Could not find') && !err.message.includes('CHANNEL_PRIVATE')) {
                    console.error(`[POLLING] Erro ao verificar canal: ${err.message}`);
                }
            }
        }
    } catch (err) {
        console.error(`[POLLING] Erro geral: ${err.message}`);
    }
}

/**
 * Start polling interval
 */
function startPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    
    console.log(`[UserMonitor] 🔄 Iniciando polling a cada ${POLLING_INTERVAL/1000}s para canais broadcast...`);
    
    // Run immediately once
    pollMonitoredChannels();
    
    // Then run periodically
    pollingInterval = setInterval(pollMonitoredChannels, POLLING_INTERVAL);
}

/**
 * Stop polling
 */
function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

/**
 * Start monitoring groups
 */
async function startMonitoring() {
    if (!isConnected || !client) {
        throw new Error('Cliente não conectado');
    }

    if (isMonitoring) {
        return { success: true, message: 'Monitoramento já está ativo' };
    }

    try {
        // Load destination chat ID to exclude it from monitoring
        destinationChatId = await Config.getGroupChatId() || process.env.GROUP_CHAT_ID;
        if (destinationChatId) {
            console.log(`[UserMonitor] 🚫 Chat de destino (será ignorado): ${destinationChatId}`);
        }
        
        // Load all monitored groups from DB at startup
        const monitoredGroups = await Monitoring.getAll();
        await refreshMonitoredIdsCache();
        
        logger.info(`Starting monitoring for ${monitoredGroups.length} groups from database`);
        console.log(`[UserMonitor] 📡 Iniciando monitoramento de ${monitoredGroups.length} grupos cadastrados`);
        
        // Log all monitored group IDs for debugging
        for (const group of monitoredGroups) {
            console.log(`[UserMonitor] 📌 Grupo cadastrado: ID="${group.chat_id}" Nome="${group.name}"`);
        }

        // IMPORTANT: Load dialogs to ensure we receive updates from private channels
        console.log(`[UserMonitor] 🔄 Carregando diálogos para ativar canais privados...`);
        try {
            const dialogs = await client.getDialogs({ limit: 500 });
            const channels = dialogs.filter(d => d.isChannel);
            const groups = dialogs.filter(d => d.isGroup);
            console.log(`[UserMonitor] ✅ Diálogos carregados: ${channels.length} canais, ${groups.length} grupos`);
            
            // Log ALL channels for reference
            console.log(`[UserMonitor] 📺 Lista de TODOS os canais:`);
            for (const channel of channels) {
                const channelId = channel.id?.toString() || 'unknown';
                // Remove -100 prefix if present for raw ID
                const rawId = channelId.replace(/^-100/, '');
                console.log(`[UserMonitor]    📺 "${channel.title}" | Raw: ${rawId} | Full: ${channelId}`);
            }
            
            // Force "read" dialogs to ensure we receive updates
            console.log(`[UserMonitor] 🔔 Forçando inscrição em canais para receber updates...`);
            for (const dialog of dialogs) {
                try {
                    // Mark dialog as "read" to ensure we receive updates
                    if (dialog.entity && (dialog.isChannel || dialog.isGroup)) {
                        await client.invoke(new Api.messages.GetHistory({
                            peer: dialog.entity,
                            limit: 1
                        }));
                    }
                } catch (e) {
                    // Ignore errors
                }
            }
            console.log(`[UserMonitor] ✅ Inscrição forçada em ${dialogs.length} diálogos`);
        } catch (dialogErr) {
            console.error(`[UserMonitor] ⚠️ Erro ao carregar diálogos: ${dialogErr.message}`);
        }

        // Add RAW update handler to catch ALL updates (for debugging)
        client.addEventHandler(async (update) => {
            // Log raw update type for debugging
            if (update.className) {
                const updateType = update.className;
                // Only log channel/chat related updates
                if (updateType.includes('Message') || updateType.includes('Channel') || updateType.includes('Chat')) {
                    console.log(`[UserMonitor] 🔔 RAW Update: ${updateType}`);
                }
                
                // Handle UpdateNewChannelMessage specifically for private channels
                if (updateType === 'UpdateNewChannelMessage' && update.message) {
                    console.log(`[UserMonitor] 📺 UpdateNewChannelMessage detectado!`);
                    await processRawMessage(update.message);
                }
                
                // Also handle UpdateNewMessage for groups
                if (updateType === 'UpdateNewMessage' && update.message) {
                    console.log(`[UserMonitor] 💬 UpdateNewMessage detectado!`);
                    await processRawMessage(update.message);
                }
            }
        }, new Raw({}));
        
        // Helper function to process raw messages
        async function processRawMessage(message) {
            try {
                if (!message.peerId) return;
                
                // Get chat ID
                let rawChatId = null;
                let chatType = 'unknown';
                
                if (message.peerId.channelId) {
                    chatType = 'channel';
                    rawChatId = message.peerId.channelId.value 
                        ? message.peerId.channelId.value.toString() 
                        : message.peerId.channelId.toString();
                } else if (message.peerId.chatId) {
                    chatType = 'group';
                    rawChatId = message.peerId.chatId.value 
                        ? message.peerId.chatId.value.toString() 
                        : message.peerId.chatId.toString();
                } else if (message.peerId.userId) {
                    return; // Ignore private
                }
                
                if (!rawChatId) return;
                
                // Skip destination chat (our own group)
                if (isDestinationChat(rawChatId)) {
                    return;
                }
                
                const dbIdFormat = `-100${rawChatId}`;
                const text = message.message || '';
                const msgPreview = (text || '[sem texto]').substring(0, 80).replace(/\n/g, ' ');
                
                console.log(`[RAW] 📨 ${chatType.toUpperCase()} | ID: ${rawChatId} | DB: ${dbIdFormat}`);
                console.log(`[RAW] 📝 ${msgPreview}${text.length > 80 ? '...' : ''}`);
                
                // Check if monitored
                const isMonitoredGroup = await isIdMonitored(rawChatId);
                if (!isMonitoredGroup) {
                    console.log(`[RAW] ⚠️ ID ${rawChatId} NÃO está monitorado. Adicione ${dbIdFormat} no painel.`);
                    return;
                }
                
                console.log(`[RAW] ✅ Grupo monitorado! Processando...`);
                
                // Extract URLs
                const extractedUrls = [];
                if (message.entities && message.entities.length > 0) {
                    for (const entity of message.entities) {
                        if (entity.className === 'MessageEntityTextUrl' && entity.url) {
                            extractedUrls.push(entity.url);
                        }
                        if (entity.className === 'MessageEntityUrl') {
                            const url = text.substring(entity.offset, entity.offset + entity.length);
                            if (url) extractedUrls.push(url);
                        }
                    }
                }
                
                // Check reply markup
                if (message.replyMarkup && message.replyMarkup.rows) {
                    for (const row of message.replyMarkup.rows) {
                        if (row.buttons) {
                            for (const button of row.buttons) {
                                if (button.url) extractedUrls.push(button.url);
                            }
                        }
                    }
                }
                
                // Filter URLs to keep only affiliate store links
                const filteredUrls = extractedUrls.filter(url => isAffiliateStoreUrl(url));
                const textUrls = (text.match(/(https?:\/\/[^\s]+)/g) || []).filter(url => isAffiliateStoreUrl(url));
                
                const hasUrlInText = textUrls.length > 0;
                const hasUrlInEntities = filteredUrls.length > 0;
                
                if (!hasUrlInText && !hasUrlInEntities) {
                    console.log(`[RAW] ⏭️ Sem URL de loja, ignorando`);
                    return;
                }
                
                let processText = text;
                if (!hasUrlInText && hasUrlInEntities) {
                    processText = text + '\n' + filteredUrls.join('\n');
                }
                
                // Download image if present
                let photoPath = null;
                if (message.media && message.media.photo) {
                    photoPath = await downloadMessagePhoto(message);
                }
                
                console.log(`[RAW] ➕ Adicionando à fila...${photoPath ? ' (com imagem)' : ''}`);
                
                const photoSource = photoPath ? { source: photoPath } : null;
                enqueuePromotion(processText, photoSource, `RAW: ${chatType}`);
                // Note: Photo cleanup is handled by the queue processor
                
            } catch (err) {
                console.error(`[RAW] ❌ Erro: ${err.message}`);
            }
        }

        // Add message handler (backup - NewMessage event)
        client.addEventHandler(async (event) => {
            try {
                const message = event.message;
                
                // Debug: Log EVERYTHING that arrives
                console.log(`[UserMonitor] 📥 Evento recebido - Tipo: ${event.className || 'unknown'}`);
                
                if (!message) {
                    console.log(`[UserMonitor] ⚠️ Evento sem mensagem`);
                    return;
                }

                // Debug: log raw peerId to understand the structure
                console.log(`[UserMonitor] 🔍 PeerId recebido:`, JSON.stringify(message.peerId, (key, value) =>
                    typeof value === 'bigint' ? value.toString() : value
                ));

                // Get chat ID - handle different peer types
                let rawChatId = null;
                let chatType = 'unknown';
                
                if (message.peerId?.channelId) {
                    chatType = 'channel';
                    rawChatId = message.peerId.channelId.value 
                        ? message.peerId.channelId.value.toString() 
                        : message.peerId.channelId.toString();
                } else if (message.peerId?.chatId) {
                    chatType = 'group';
                    rawChatId = message.peerId.chatId.value 
                        ? message.peerId.chatId.value.toString() 
                        : message.peerId.chatId.toString();
                } else if (message.peerId?.userId) {
                    chatType = 'private';
                    return; // Ignore private messages
                }
                
                if (!rawChatId) {
                    console.log(`[UserMonitor] ⚠️ Não foi possível extrair ID. PeerId:`, message.peerId);
                    return;
                }
                
                // Skip destination chat (our own group)
                if (isDestinationChat(rawChatId)) {
                    return;
                }

                // Get chat/group name
                let chatName = 'Desconhecido';
                try {
                    const chat = await message.getChat();
                    chatName = chat?.title || chat?.firstName || 'Desconhecido';
                } catch (e) {
                    // Ignore error getting chat name
                }

                // Format IDs for database use
                const dbIdFormat = `-100${rawChatId}`;
                const msgPreview = (message.text || '[sem texto]').substring(0, 100).replace(/\n/g, ' ');

                // Always log incoming messages with group info
                console.log(`\n${'='.repeat(60)}`);
                console.log(`📨 MENSAGEM RECEBIDA`);
                console.log(`${'='.repeat(60)}`);
                console.log(`📌 Grupo/Canal: ${chatName}`);
                console.log(`📋 Tipo: ${chatType.toUpperCase()}`);
                console.log(`🆔 ID (raw): ${rawChatId}`);
                console.log(`🆔 ID (para DB): ${dbIdFormat}`);
                console.log(`📝 Mensagem: ${msgPreview}${message.text?.length > 100 ? '...' : ''}`);
                console.log(`${'='.repeat(60)}\n`);

                if (!message.text) {
                    return;
                }

                // Check if this group is monitored using cache
                const isMonitoredGroup = await isIdMonitored(rawChatId);

                if (!isMonitoredGroup) {
                    return;
                }
                
                console.log(`[UserMonitor] ✅ Grupo monitorado! Processando mensagem...`);

                const text = message.text || '';
                
                // Extract URLs from message entities (buttons, text links, etc.)
                const extractedUrls = [];
                
                // Check text entities for URLs
                if (message.entities && message.entities.length > 0) {
                    for (const entity of message.entities) {
                        // TextUrl type contains a URL in the entity itself
                        if (entity.className === 'MessageEntityTextUrl' && entity.url) {
                            extractedUrls.push(entity.url);
                        }
                        // Regular URL in text
                        if (entity.className === 'MessageEntityUrl') {
                            const url = text.substring(entity.offset, entity.offset + entity.length);
                            if (url) extractedUrls.push(url);
                        }
                    }
                }
                
                // Check reply markup (inline buttons)
                if (message.replyMarkup && message.replyMarkup.rows) {
                    for (const row of message.replyMarkup.rows) {
                        if (row.buttons) {
                            for (const button of row.buttons) {
                                if (button.url) {
                                    extractedUrls.push(button.url);
                                }
                            }
                        }
                    }
                }
                
                // Filter URLs to keep only affiliate store links
                const filteredUrls = extractedUrls.filter(url => isAffiliateStoreUrl(url));
                const textUrls = (text.match(/(https?:\/\/[^\s]+)/g) || []).filter(url => isAffiliateStoreUrl(url));
                
                const hasUrlInText = textUrls.length > 0;
                const hasUrlInEntities = filteredUrls.length > 0;
                
                if (!hasUrlInText && !hasUrlInEntities) {
                    return;
                }
                
                // If URL is only in entities, append to text for processing
                let processText = text;
                if (!hasUrlInText && hasUrlInEntities) {
                    processText = text + '\n' + filteredUrls.join('\n');
                    console.log(`[UserMonitor] 🔗 URLs de lojas extraídas: ${filteredUrls.length}`);
                }

                // Download image if present
                let photoPath = null;
                if (message.media && message.media.photo) {
                    photoPath = await downloadMessagePhoto(message);
                }

                console.log(`[UserMonitor] ➕ Adicionando à fila...${photoPath ? ' (com imagem)' : ''}`);

                // Pass photo path with { source: path } format for Telegraf
                const photoSource = photoPath ? { source: photoPath } : null;
                enqueuePromotion(processText, photoSource, `NewMessage: ${chatName}`);
                // Note: Photo cleanup is handled by the queue processor
                
            } catch (err) {
                logger.error(`[UserMonitor] Error processing message: ${err.message}`);
                console.error(`[UserMonitor] ❌ Erro ao processar mensagem: ${err.message}`);
            }
        }, new NewMessage({}));

        isMonitoring = true;
        logger.info('Monitoring started successfully');
        console.log('[UserMonitor] ✅ Monitoramento por eventos iniciado');
        
        // Start polling for broadcast channels (they don't trigger events)
        startPolling();

        return { success: true, message: `Monitoramento iniciado para ${monitoredGroups.length} grupos` };
    } catch (err) {
        logger.error('Error starting monitoring:', err.message);
        throw err;
    }
}

/**
 * Stop monitoring
 */
function stopMonitoring() {
    isMonitoring = false;
    stopPolling();
    // Note: GramJS doesn't have a removeEventHandler that's easy to use
    // The handler will still exist but we set isMonitoring to false
    logger.info('Monitoring stopped');
    return { success: true, message: 'Monitoramento pausado' };
}

/**
 * Refresh monitored groups list (forces cache refresh)
 */
async function refreshMonitoredGroups() {
    // Force refresh the cache
    await refreshMonitoredIdsCache();
    
    const monitoredGroups = await Monitoring.getAll();
    
    console.log(`[UserMonitor] 🔄 Lista de grupos atualizada: ${monitoredGroups.length} grupos`);
    for (const group of monitoredGroups) {
        console.log(`[UserMonitor] 📌 ID="${group.chat_id}" Nome="${group.name}"`);
    }
    
    return { 
        success: true, 
        message: `Atualizado: ${monitoredGroups.length} grupos monitorados`,
        groups: monitoredGroups
    };
}

/**
 * Get list of user's groups/channels
 */
async function getDialogs() {
    if (!isConnected || !client) {
        throw new Error('Cliente não conectado');
    }

    try {
        const dialogs = await client.getDialogs({ limit: 100 });
        
        const groups = dialogs
            .filter(d => d.isGroup || d.isChannel)
            .map(d => ({
                id: d.id.toString(),
                title: d.title,
                isChannel: d.isChannel,
                isGroup: d.isGroup,
                participantsCount: d.entity?.participantsCount || 0
            }));

        return groups;
    } catch (err) {
        logger.error('Error getting dialogs:', err.message);
        throw err;
    }
}

/**
 * Get queue status for dashboard display
 */
function getQueueStatus() {
    return getQueueStatusInternal();
}

module.exports = {
    getStatus,
    initClient,
    startLogin,
    verifyCode,
    connectWithSession,
    disconnect,
    logout,
    startMonitoring,
    stopMonitoring,
    refreshMonitoredGroups,
    getDialogs,
    getQueueStatus,
    enqueuePromotion,
    enqueueDirectSend
};
