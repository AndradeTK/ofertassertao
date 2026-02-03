/**
 * ========================================
 * Script de Verificação Geral do Sistema
 * OfertasSertão - Bot de Promoções
 * ========================================
 * 
 * Execute: node scripts/verificacao_geral.js
 * 
 * Este script verifica:
 * - Variáveis de ambiente (.env)
 * - Conexão com banco de dados MySQL
 * - Conexão com Redis
 * - Tabelas necessárias no banco
 * - Pastas e arquivos necessários
 * - Dependências do Node.js
 * - Configurações de plataformas afiliadas
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Cores para console
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

const OK = `${colors.green}✅${colors.reset}`;
const WARN = `${colors.yellow}⚠️${colors.reset}`;
const FAIL = `${colors.red}❌${colors.reset}`;
const INFO = `${colors.blue}ℹ️${colors.reset}`;

let totalChecks = 0;
let passedChecks = 0;
let warningChecks = 0;
let failedChecks = 0;

function logSection(title) {
    console.log('\n' + colors.cyan + colors.bright + '═'.repeat(50) + colors.reset);
    console.log(colors.cyan + colors.bright + ` ${title}` + colors.reset);
    console.log(colors.cyan + colors.bright + '═'.repeat(50) + colors.reset);
}

function logCheck(status, message, details = '') {
    totalChecks++;
    if (status === 'ok') {
        passedChecks++;
        console.log(`${OK} ${message}${details ? ` ${colors.bright}(${details})${colors.reset}` : ''}`);
    } else if (status === 'warn') {
        warningChecks++;
        console.log(`${WARN} ${message}${details ? ` ${colors.yellow}(${details})${colors.reset}` : ''}`);
    } else {
        failedChecks++;
        console.log(`${FAIL} ${message}${details ? ` ${colors.red}(${details})${colors.reset}` : ''}`);
    }
}

function logInfo(message) {
    console.log(`${INFO} ${message}`);
}

// ========================================
// 1. Verificar arquivo .env
// ========================================
async function checkEnvFile() {
    logSection('Arquivo de Configuração (.env)');
    
    const envPath = path.join(__dirname, '..', '.env');
    const envExamplePath = path.join(__dirname, '..', '.env.example');
    
    if (fs.existsSync(envPath)) {
        logCheck('ok', 'Arquivo .env encontrado');
    } else {
        logCheck('fail', 'Arquivo .env NÃO encontrado', 'Copie .env.example para .env');
        if (fs.existsSync(envExamplePath)) {
            logInfo('Use: copy .env.example .env (Windows) ou cp .env.example .env (Linux)');
        }
        return false;
    }
    
    return true;
}

// ========================================
// 2. Verificar variáveis de ambiente críticas
// ========================================
async function checkEnvVariables() {
    logSection('Variáveis de Ambiente');
    
    // Variáveis obrigatórias
    const requiredVars = [
        { key: 'DB_HOST', desc: 'Host do banco de dados' },
        { key: 'DB_USER', desc: 'Usuário do banco de dados' },
        { key: 'DB_NAME', desc: 'Nome do banco de dados' },
        { key: 'TELEGRAM_TOKEN', desc: 'Token do Bot Telegram' }
    ];
    
    // Variáveis recomendadas
    const recommendedVars = [
        { key: 'GEMINI_API_KEY', desc: 'API Key do Google Gemini (IA)' },
        { key: 'GROUP_CHAT_ID', desc: 'ID do grupo/canal Telegram' },
        { key: 'TELEGRAM_API_ID', desc: 'API ID MTProto (monitoramento)' },
        { key: 'TELEGRAM_API_HASH', desc: 'API Hash MTProto (monitoramento)' }
    ];
    
    // Verificar obrigatórias
    console.log('\n📋 Variáveis Obrigatórias:');
    let allRequiredOk = true;
    for (const v of requiredVars) {
        const value = process.env[v.key];
        if (value && value.trim() !== '' && !value.includes('seu_') && !value.includes('sua_')) {
            logCheck('ok', v.desc, v.key);
        } else {
            logCheck('fail', v.desc, `${v.key} não configurado`);
            allRequiredOk = false;
        }
    }
    
    // Verificar recomendadas
    console.log('\n📋 Variáveis Recomendadas:');
    for (const v of recommendedVars) {
        const value = process.env[v.key];
        if (value && value.trim() !== '' && !value.includes('seu_') && !value.includes('sua_')) {
            logCheck('ok', v.desc, v.key);
        } else {
            logCheck('warn', v.desc, `${v.key} não configurado`);
        }
    }
    
    // Redis
    console.log('\n📋 Configuração Redis:');
    if (process.env.REDIS_URL || process.env.REDIS_HOST) {
        logCheck('ok', 'Redis configurado', process.env.REDIS_URL ? 'via REDIS_URL' : 'via REDIS_HOST');
    } else {
        logCheck('warn', 'Redis não configurado', 'Usando padrão localhost:6379');
    }
    
    return allRequiredOk;
}

// ========================================
// 3. Verificar conexão com MySQL
// ========================================
async function checkDatabase() {
    logSection('Banco de Dados MySQL');
    
    try {
        const { pool, testConnection } = require('../src/config/db');
        
        logInfo(`Conectando a ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || 'ofertas'}...`);
        
        await testConnection();
        logCheck('ok', 'Conexão com MySQL estabelecida');
        
        // Verificar tabelas necessárias (conforme ofertassertao.sql)
        console.log('\n📋 Verificando tabelas obrigatórias:');
        const requiredTables = [
            { name: 'config', desc: 'Configurações do sistema' },
            { name: 'categories', desc: 'Categorias da IA → Tópicos Telegram' },
            { name: 'monitoring', desc: 'Canais monitorados' },
            { name: 'forbidden_words', desc: 'Palavras proibidas' },
            { name: 'excluded_urls', desc: 'URLs excluídas' },
            { name: 'pending_promotions', desc: 'Promoções pendentes de aprovação' },
            { name: 'scheduled_posts', desc: 'Postagens agendadas' },
            { name: 'post_history', desc: 'Histórico de postagens' },
            { name: 'system_logs', desc: 'Logs do sistema' }
        ];
        
        const [rows] = await pool.execute('SHOW TABLES');
        const existingTables = rows.map(r => Object.values(r)[0].toLowerCase());
        
        for (const table of requiredTables) {
            if (existingTables.includes(table.name.toLowerCase())) {
                logCheck('ok', `Tabela '${table.name}'`, table.desc);
            } else {
                logCheck('fail', `Tabela '${table.name}' não existe`, 'Execute: mysql < migrations/ofertassertao.sql');
            }
        }
        
        // Verificar se há dados em config
        console.log('\n📋 Verificando dados de configuração:');
        try {
            const [configRows] = await pool.execute('SELECT COUNT(*) as count FROM config');
            if (configRows[0].count > 0) {
                logCheck('ok', `Configurações na tabela 'config'`, `${configRows[0].count} registros`);
            } else {
                logCheck('warn', 'Tabela config vazia', 'Execute as migrations para inserir dados padrão');
            }
        } catch (e) {
            // Tabela pode não existir
        }
        
        // Verificar se há categorias configuradas
        try {
            const [catRows] = await pool.execute('SELECT COUNT(*) as count FROM categories');
            if (catRows[0].count > 0) {
                logCheck('ok', `Categorias configuradas`, `${catRows[0].count} categorias`);
            } else {
                logCheck('warn', 'Nenhuma categoria configurada', 'Configure pelo painel admin ou execute migrations');
            }
        } catch (e) {
            // Tabela pode não existir
        }
        
        await pool.end();
        return true;
    } catch (err) {
        logCheck('fail', 'Erro ao conectar MySQL', err.message);
        logInfo('Verifique se o MySQL está rodando e as credenciais estão corretas');
        return false;
    }
}

// ========================================
// 4. Verificar conexão com Redis
// ========================================
async function checkRedis() {
    logSection('Redis');
    
    try {
        const Redis = require('ioredis');
        
        const redisConfig = process.env.REDIS_URL ? process.env.REDIS_URL : {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
            password: process.env.REDIS_PASSWORD || undefined,
            connectTimeout: 5000
        };
        
        logInfo(`Conectando a ${typeof redisConfig === 'string' ? redisConfig : `${redisConfig.host}:${redisConfig.port}`}...`);
        
        const redis = new Redis(redisConfig);
        
        await new Promise((resolve, reject) => {
            redis.on('connect', resolve);
            redis.on('error', reject);
            setTimeout(() => reject(new Error('Timeout de conexão')), 5000);
        });
        
        // Testar operação
        await redis.set('verificacao_test', 'ok');
        const result = await redis.get('verificacao_test');
        await redis.del('verificacao_test');
        
        if (result === 'ok') {
            logCheck('ok', 'Conexão com Redis estabelecida');
            logCheck('ok', 'Redis operacional', 'leitura/escrita OK');
        }
        
        await redis.quit();
        return true;
    } catch (err) {
        logCheck('fail', 'Erro ao conectar Redis', err.message);
        logInfo('Verifique se o Redis está rodando (docker-compose up -d redis)');
        return false;
    }
}

// ========================================
// 5. Verificar pastas e arquivos necessários
// ========================================
async function checkFilesAndFolders() {
    logSection('Estrutura de Arquivos');
    
    const rootPath = path.join(__dirname, '..');
    
    // Pastas necessárias
    const requiredFolders = [
        { path: 'src', desc: 'Código fonte' },
        { path: 'src/config', desc: 'Configurações' },
        { path: 'src/models', desc: 'Modelos de dados' },
        { path: 'src/services', desc: 'Serviços' },
        { path: 'src/views', desc: 'Templates EJS' },
        { path: 'src/public', desc: 'Arquivos estáticos' },
        { path: 'logs', desc: 'Logs do sistema' },
        { path: 'uploads', desc: 'Uploads de imagens' },
        { path: 'data', desc: 'Dados persistentes' }
    ];
    
    console.log('\n📁 Verificando pastas:');
    for (const folder of requiredFolders) {
        const fullPath = path.join(rootPath, folder.path);
        if (fs.existsSync(fullPath)) {
            logCheck('ok', folder.desc, folder.path);
        } else {
            logCheck('warn', folder.desc, `${folder.path} não existe`);
            // Tentar criar
            try {
                fs.mkdirSync(fullPath, { recursive: true });
                logInfo(`  ↳ Pasta criada automaticamente`);
            } catch (e) {
                logInfo(`  ↳ Não foi possível criar: ${e.message}`);
            }
        }
    }
    
    // Arquivos críticos
    const criticalFiles = [
        { path: 'src/server.js', desc: 'Servidor principal' },
        { path: 'src/config/db.js', desc: 'Configuração MySQL' },
        { path: 'src/config/redis.js', desc: 'Configuração Redis' },
        { path: 'src/views/index.ejs', desc: 'Template do painel' },
        { path: 'package.json', desc: 'Dependências Node.js' }
    ];
    
    console.log('\n📄 Verificando arquivos críticos:');
    for (const file of criticalFiles) {
        const fullPath = path.join(rootPath, file.path);
        if (fs.existsSync(fullPath)) {
            logCheck('ok', file.desc, file.path);
        } else {
            logCheck('fail', file.desc, `${file.path} não encontrado`);
        }
    }
    
    // Verificar permissões de escrita
    console.log('\n📝 Verificando permissões de escrita:');
    const writableFolders = ['logs', 'uploads', 'data'];
    for (const folder of writableFolders) {
        const fullPath = path.join(rootPath, folder);
        try {
            const testFile = path.join(fullPath, '.write_test');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            logCheck('ok', `Pasta '${folder}' tem permissão de escrita`);
        } catch (e) {
            logCheck('fail', `Pasta '${folder}' sem permissão de escrita`, e.message);
        }
    }
    
    return true;
}

// ========================================
// 6. Verificar dependências Node.js
// ========================================
async function checkNodeDependencies() {
    logSection('Dependências Node.js');
    
    const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
    
    if (!fs.existsSync(nodeModulesPath)) {
        logCheck('fail', 'node_modules não encontrado', 'Execute: npm install');
        return false;
    }
    
    // Dependências críticas
    const criticalDeps = [
        'express',
        'telegraf',
        'mysql2',
        'ioredis',
        'dotenv',
        'axios',
        'ejs',
        'puppeteer',
        'ws'
    ];
    
    console.log('\n📦 Verificando dependências críticas:');
    let allDepsOk = true;
    for (const dep of criticalDeps) {
        const depPath = path.join(nodeModulesPath, dep);
        if (fs.existsSync(depPath)) {
            try {
                const pkgJson = require(path.join(depPath, 'package.json'));
                logCheck('ok', dep, `v${pkgJson.version}`);
            } catch (e) {
                logCheck('ok', dep);
            }
        } else {
            logCheck('fail', dep, 'não instalado');
            allDepsOk = false;
        }
    }
    
    // Verificar versão do Node.js
    console.log('\n🟢 Verificando Node.js:');
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
    
    if (majorVersion >= 18) {
        logCheck('ok', `Node.js ${nodeVersion}`, 'versão compatível');
    } else {
        logCheck('fail', `Node.js ${nodeVersion}`, 'requer Node.js >= 18.0.0');
    }
    
    return allDepsOk;
}

// ========================================
// 7. Verificar configurações de afiliados
// ========================================
async function checkAffiliateConfigs() {
    logSection('Plataformas de Afiliados');
    
    const platforms = [
        {
            name: 'Shopee',
            envKey: 'AFFILIATE_SHOPEE_ENABLED',
            requiredVars: ['SHOPEE_APP_ID', 'SHOPEE_APP_SECRET'],
            optionalVars: ['SHOPEE_AFFILIATE_ID', 'SHOPEE_API_KEY']
        },
        {
            name: 'Mercado Livre',
            envKey: 'AFFILIATE_ML_ENABLED',
            requiredVars: ['ML_AFFILIATE_TAG'],
            optionalVars: ['ML_COOKIES']
        },
        {
            name: 'AliExpress',
            envKey: 'AFFILIATE_ALIEXPRESS_ENABLED',
            requiredVars: ['ALIEXPRESS_TRACKING_ID'],
            optionalVars: ['ALIEXPRESS_COOKIES']
        },
        {
            name: 'Amazon',
            envKey: 'AFFILIATE_AMAZON_ENABLED',
            requiredVars: ['AMAZON_TRACKING_ID'],
            optionalVars: ['AMAZON_COOKIES']
        }
    ];
    
    for (const platform of platforms) {
        const enabled = process.env[platform.envKey] !== 'false' && process.env[platform.envKey] !== '0';
        
        console.log(`\n🏪 ${platform.name}:`);
        
        if (!enabled) {
            logCheck('warn', `${platform.name} desativado`, platform.envKey);
            continue;
        }
        
        logCheck('ok', `${platform.name} ativado`);
        
        // Verificar variáveis obrigatórias da plataforma
        let platformOk = true;
        for (const varName of platform.requiredVars) {
            const value = process.env[varName];
            if (value && value.trim() !== '' && !value.includes('seu_') && !value.includes('sua_')) {
                logCheck('ok', varName, '✓ configurado');
            } else {
                logCheck('warn', varName, 'não configurado');
                platformOk = false;
            }
        }
        
        // Verificar variáveis opcionais
        for (const varName of platform.optionalVars) {
            const value = process.env[varName];
            if (value && value.trim() !== '') {
                logCheck('ok', varName, '✓ configurado');
            } else {
                logInfo(`  ${varName}: não configurado (opcional)`);
            }
        }
    }
    
    return true;
}

// ========================================
// 8. Verificar Docker (se aplicável)
// ========================================
async function checkDocker() {
    logSection('Docker');
    
    const dockerComposePath = path.join(__dirname, '..', 'docker-compose.yml');
    
    if (fs.existsSync(dockerComposePath)) {
        logCheck('ok', 'docker-compose.yml encontrado');
        logInfo('Para iniciar serviços: docker-compose up -d');
    } else {
        logCheck('warn', 'docker-compose.yml não encontrado');
    }
    
    return true;
}

// ========================================
// Sumário Final
// ========================================
function printSummary() {
    logSection('RESULTADO DA VERIFICAÇÃO');
    
    console.log(`
${colors.green}✅ Passou:     ${passedChecks}${colors.reset}
${colors.yellow}⚠️  Avisos:     ${warningChecks}${colors.reset}
${colors.red}❌ Falhou:     ${failedChecks}${colors.reset}
${colors.blue}📊 Total:      ${totalChecks}${colors.reset}
`);
    
    if (failedChecks === 0 && warningChecks === 0) {
        console.log(colors.green + colors.bright + '🎉 Sistema totalmente configurado e pronto para uso!' + colors.reset);
    } else if (failedChecks === 0) {
        console.log(colors.yellow + colors.bright + '⚠️  Sistema operacional, mas há avisos que podem ser corrigidos.' + colors.reset);
    } else {
        console.log(colors.red + colors.bright + '❌ Há problemas críticos que precisam ser resolvidos!' + colors.reset);
    }
    
    console.log('\n' + colors.cyan + '═'.repeat(50) + colors.reset);
    console.log(colors.cyan + ' Para iniciar o sistema: npm run dev' + colors.reset);
    console.log(colors.cyan + ' Painel admin: http://localhost:3000' + colors.reset);
    console.log(colors.cyan + '═'.repeat(50) + colors.reset + '\n');
}

// ========================================
// Execução Principal
// ========================================
async function main() {
    console.clear();
    console.log(colors.magenta + colors.bright);
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║     🔍 VERIFICAÇÃO GERAL DO SISTEMA                ║');
    console.log('║        OfertasSertão - Bot de Promoções            ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log(colors.reset);
    
    const startTime = Date.now();
    
    try {
        // Executar verificações na ordem
        await checkEnvFile();
        await checkEnvVariables();
        await checkNodeDependencies();
        await checkFilesAndFolders();
        await checkDatabase();
        await checkRedis();
        await checkAffiliateConfigs();
        await checkDocker();
        
    } catch (err) {
        console.error(colors.red + '\n💥 Erro inesperado durante verificação:' + colors.reset);
        console.error(err);
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n⏱️  Verificação concluída em ${elapsed}s`);
    
    printSummary();
    
    // Encerrar processo
    process.exit(failedChecks > 0 ? 1 : 0);
}

main();
