/**
 * Script para migrar configurações do .env para o banco de dados
 * Execute: node scripts/migrate_settings.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrateSettings() {
    console.log('🚀 Migrando configurações do .env para o banco de dados...\n');
    
    // Conexão direta para não depender do pool
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'bot_afiliados',
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306
    });
    
    // Configurações a migrar (todas do sistema)
    const settingsToMigrate = [
        // Telegram
        { key: 'TELEGRAM_TOKEN', value: process.env.TELEGRAM_TOKEN || process.env.TG_BOT_TOKEN },
        { key: 'GROUP_CHAT_ID', value: process.env.GROUP_CHAT_ID },
        { key: 'GROUP_INVITE_LINK', value: process.env.GROUP_INVITE_LINK || process.env.GROUP_LINK },
        { key: 'TELEGRAM_API_ID', value: process.env.TELEGRAM_API_ID },
        { key: 'TELEGRAM_API_HASH', value: process.env.TELEGRAM_API_HASH },
        
        // IA
        { key: 'GEMINI_API_KEY', value: process.env.GEMINI_API_KEY },
        
        // Shopee
        { key: 'SHOPEE_APP_ID', value: process.env.SHOPEE_APP_ID },
        { key: 'SHOPEE_APP_SECRET', value: process.env.SHOPEE_APP_SECRET },
        { key: 'SHOPEE_AFFILIATE_ID', value: process.env.SHOPEE_AFFILIATE_ID },
        { key: 'SHOPEE_API_KEY', value: process.env.SHOPEE_API_KEY },
        
        // Mercado Livre
        { key: 'ML_AFFILIATE_TAG', value: process.env.ML_AFFILIATE_TAG },
        { key: 'ML_COOKIES', value: process.env.ML_COOKIES },
        
        // AliExpress (usa portal com cookies, não precisa de APP_KEY/SECRET)
        { key: 'ALIEXPRESS_TRACKING_ID', value: process.env.ALIEXPRESS_TRACKING_ID },
        { key: 'ALIEXPRESS_COOKIES', value: process.env.ALIEXPRESS_COOKIES },
        
        // Amazon
        { key: 'AMAZON_TRACKING_ID', value: process.env.AMAZON_TRACKING_ID },
        { key: 'AMAZON_COOKIES', value: process.env.AMAZON_COOKIES },
        
        // Toggles de plataformas (default: true)
        { key: 'AFFILIATE_SHOPEE_ENABLED', value: process.env.AFFILIATE_SHOPEE_ENABLED || 'true' },
        { key: 'AFFILIATE_ML_ENABLED', value: process.env.AFFILIATE_ML_ENABLED || 'true' },
        { key: 'AFFILIATE_ALIEXPRESS_ENABLED', value: process.env.AFFILIATE_ALIEXPRESS_ENABLED || 'true' },
        { key: 'AFFILIATE_AMAZON_ENABLED', value: process.env.AFFILIATE_AMAZON_ENABLED || 'true' },
        
        // Redis
        { key: 'REDIS_URL', value: process.env.REDIS_URL || 'redis://localhost:6379' },
    ];

    let migrated = 0;
    let skipped = 0;

    for (const setting of settingsToMigrate) {
        if (setting.value !== undefined && setting.value !== null) {
            try {
                // Verifica se já existe
                const [rows] = await connection.execute('SELECT id FROM config WHERE key_name = ?', [setting.key]);
                
                if (rows.length === 0) {
                    // Insere nova configuração
                    await connection.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', [setting.key, setting.value]);
                    console.log(`✅ Migrado: ${setting.key}`);
                    migrated++;
                } else {
                    // Atualiza se o valor atual é NULL
                    const [current] = await connection.execute('SELECT value_text FROM config WHERE key_name = ?', [setting.key]);
                    if (current[0].value_text === null && setting.value) {
                        await connection.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [setting.value, setting.key]);
                        console.log(`🔄 Atualizado: ${setting.key}`);
                        migrated++;
                    } else {
                        console.log(`⏭️  Já existe: ${setting.key}`);
                        skipped++;
                    }
                }
            } catch (err) {
                console.error(`❌ Erro ao migrar ${setting.key}:`, err.message);
            }
        }
    }
    
    console.log('\n========================================');
    console.log(`✅ Migrados: ${migrated}`);
    console.log(`⏭️  Ignorados: ${skipped}`);
    console.log('========================================\n');
    
    await connection.end();
    console.log('🎉 Migração concluída!');
    process.exit(0);
}

migrateSettings().catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
