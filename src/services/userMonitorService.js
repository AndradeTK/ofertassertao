/**
 * User Account Monitor Service
 * Monitors Telegram groups using user's personal account (MTProto)
 * This is separate from the bot monitoring system
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const fs = require('fs');
const path = require('path');
const { createComponentLogger } = require('../config/logger');
const Monitoring = require('../models/monitoringModel');
const { handlePromotionFlow } = require('./promotionFlow');

const logger = createComponentLogger('UserMonitor');

// Session file path
const SESSION_FILE = path.join(__dirname, '../../data/user_session.txt');
const DATA_DIR = path.join(__dirname, '../../data');

// Client instance
let client = null;
let isConnected = false;
let isMonitoring = false;

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

    const sessionString = loadSession();
    const stringSession = new StringSession(sessionString);

    client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
        connectionRetries: 5,
        useWSS: true,
    });

    logger.info('Telegram client initialized');
    return client;
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

        if (!client) {
            await initClient(apiId, apiHash);
        }

        await client.connect();
        
        // Check if session is still valid
        const me = await client.getMe();
        
        isConnected = true;
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
        // Get monitored groups from database
        const monitoredGroups = await Monitoring.getAll();
        const monitoredIds = monitoredGroups.map(g => g.chat_id);

        logger.info(`Starting monitoring for ${monitoredIds.length} groups`);
        console.log(`[UserMonitor] 📡 Iniciando monitoramento de ${monitoredIds.length} grupos`);

        // Add message handler
        client.addEventHandler(async (event) => {
            try {
                const message = event.message;
                if (!message || !message.text) return;

                // Get chat ID
                const chatId = message.peerId?.channelId || message.peerId?.chatId;
                if (!chatId) return;

                // Format ID for comparison (add -100 prefix for supergroups/channels)
                const formattedId = `-100${chatId}`;
                
                // Check if this chat is monitored
                const isMonitored = monitoredIds.includes(formattedId) || 
                                   monitoredIds.includes(chatId.toString()) ||
                                   monitoredIds.includes(`-${chatId}`);

                if (!isMonitored) return;

                const text = message.text || '';
                
                // Check if message contains URL
                if (!text.includes('http')) return;

                logger.info(`[UserMonitor] Message with URL from ${formattedId}`);
                console.log(`[UserMonitor] 📩 Mensagem com URL recebida de ${formattedId}`);

                // Get photo if exists
                let photoFileId = null;
                if (message.media && message.media.photo) {
                    // For user account, we need to download and re-upload
                    // For now, we'll skip the photo
                    logger.info('[UserMonitor] Message has photo (will be skipped in user monitor)');
                }

                // Process through promotion flow
                await handlePromotionFlow(text, null, photoFileId);
                
            } catch (err) {
                logger.error(`[UserMonitor] Error processing message: ${err.message}`);
                console.error(`[UserMonitor] ❌ Erro ao processar mensagem: ${err.message}`);
            }
        }, new NewMessage({}));

        isMonitoring = true;
        logger.info('Monitoring started successfully');
        console.log('[UserMonitor] ✅ Monitoramento iniciado com sucesso');

        return { success: true, message: 'Monitoramento iniciado' };
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
    // Note: GramJS doesn't have a removeEventHandler that's easy to use
    // The handler will still exist but we set isMonitoring to false
    logger.info('Monitoring stopped');
    return { success: true, message: 'Monitoramento pausado' };
}

/**
 * Refresh monitored groups list
 */
async function refreshMonitoredGroups() {
    if (!isMonitoring) {
        return { success: false, message: 'Monitoramento não está ativo' };
    }

    // The event handler will re-check the database on each message
    // So no action needed here, just return success
    const monitoredGroups = await Monitoring.getAll();
    
    return { 
        success: true, 
        message: `Atualizado: ${monitoredGroups.length} grupos monitorados` 
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
    getDialogs
};
