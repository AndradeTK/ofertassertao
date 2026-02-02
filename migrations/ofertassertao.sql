CREATE DATABASE IF NOT EXISTS bot_afiliados;
USE bot_afiliados;

-- Tabela para mapear categorias da IA para Tópicos do Telegram
CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name_ia VARCHAR(50) NOT NULL, -- Ex: 'Eletrônicos'
    thread_id INT NOT NULL,       -- ID do Tópico no Telegram
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Canais que o Bot deve monitorar
CREATE TABLE IF NOT EXISTS monitoring (
    id INT AUTO_INCREMENT PRIMARY KEY,
    channel_id VARCHAR(50) NOT NULL, -- ID do Telegram (ex: -100...)
    channel_name VARCHAR(100),
    active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS config (id INT AUTO_INCREMENT PRIMARY KEY, key_name VARCHAR(100), value_text TEXT, UNIQUE KEY unique_key (key_name));

-- Inserir configurações padrão (Sistema / Banco)
INSERT IGNORE INTO config (key_name, value_text) VALUES 
('DB_HOST', 'localhost'),
('DB_USER', 'root'),
('DB_PASS', ''),
('DB_NAME', 'bot_afiliados'),
('REDIS_URL', 'redis://localhost:6379'),
('TELEGRAM_TOKEN', NULL),
('GROUP_CHAT_ID', NULL),
('TELEGRAM_API_ID', NULL),
('TELEGRAM_API_HASH', NULL),
('GEMINI_API_KEY', NULL),
('SHOPEE_AFFILIATE_ID', NULL),
('SHOPEE_API_KEY', NULL),
('SHOPEE_APP_ID', NULL),
('SHOPEE_APP_SECRET', NULL),
('ML_AFFILIATE_TAG', NULL),
('ML_COOKIES', NULL),
('ALIEXPRESS_APP_KEY', NULL),
('ALIEXPRESS_APP_SECRET', NULL),
('ALIEXPRESS_TRACKING_ID', NULL),
('AMAZON_TRACKING_ID', NULL),
('AMAZON_COOKIES', NULL),
('AFFILIATE_SHOPEE_ENABLED', 'true'),
('AFFILIATE_ML_ENABLED', 'true'),
('AFFILIATE_ALIEXPRESS_ENABLED', 'true'),
('AFFILIATE_AMAZON_ENABLED', 'true'),
('THEME_COLOR_PRIMARY', '#1e3a8a'),
('THEME_COLOR_SECONDARY', '#3b82f6'),
('THEME_FONT_URL', NULL);

-- Tabela para palavras proibidas
CREATE TABLE IF NOT EXISTS forbidden_words (
    id INT AUTO_INCREMENT PRIMARY KEY,
    word VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_word (word)
);

-- Tabela para postagens agendadas
CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    content TEXT NOT NULL,
    image_url TEXT,
    schedule_time DATETIME NOT NULL,
    status ENUM('pending', 'posted', 'failed', 'cancelled') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    posted_at TIMESTAMP NULL,
    error_message TEXT NULL,
    INDEX idx_schedule_time (schedule_time, status)
);

-- Tabela para histórico de postagens (tracking detalhado)
CREATE TABLE IF NOT EXISTS post_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_name VARCHAR(255),
    category VARCHAR(50),
    price VARCHAR(50),
    coupon TEXT,
    urls TEXT,
    affiliate_urls TEXT,
    posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    INDEX idx_posted_at (posted_at),
    INDEX idx_category (category)
);

-- Tabela para logs do sistema
CREATE TABLE IF NOT EXISTS system_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type ENUM('info', 'success', 'error', 'warning') DEFAULT 'info',
    message VARCHAR(500) NOT NULL,
    details TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_timestamp (timestamp),
    INDEX idx_type (type)
);

-- Tabela para promoções pendentes de aprovação (fallback quando IA falha)
CREATE TABLE IF NOT EXISTS pending_promotions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    original_text TEXT NOT NULL,
    processed_text TEXT,
    product_name VARCHAR(255),
    price VARCHAR(50),
    coupon VARCHAR(255),
    image_path TEXT,
    urls TEXT,
    affiliate_urls TEXT,
    suggested_category VARCHAR(50),
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    source VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
);

-- ========================================
-- Dados de Exemplo (Opcional)
-- ========================================

-- Inserir palavras proibidas padrão
INSERT IGNORE INTO forbidden_words (word) VALUES 
    ('esgotado'),
    ('indisponível'),
    ('sem estoque'),
    ('fora de estoque');

-- Inserir configurações padrão do General
INSERT INTO config (key_name, value_text) VALUES 
    ('SEND_TO_GENERAL', '1')
ON DUPLICATE KEY UPDATE key_name = key_name;

-- Inserir todas as categorias utilizadas pelo sistema
-- IMPORTANTE: Os thread_ids devem ser configurados com os IDs reais dos tópicos do Telegram
INSERT INTO categories (name_ia, thread_id) VALUES
('Acessórios', 2),
('Áudio', 13),
('Armazenamento', 6),
('Cadeiras', 14),
('Computador/Notebook', 28),
('Consoles', 15),
('Cupom', 16),
('Eletrônicos', 17),
('Fitness', 484),
('Fonte', 18),
('Gabinete', 19),
('Headset/Fone', 20),
('Higiene', 509),
('Jogos', 21),
('Memória RAM', 22),
('Mesas', 24),
('Monitores', 25),
('Mouse', 26),
('Outros', 516),
('Placa de Vídeo', 49),
('Placa Mãe', 50),
('Processador', 51),
('Produto de Limpeza', 514),
('Roupa/Moda', 55),
('Teclado', 54),
('Telefone/Tablet', 53),
('Televisão', 511),
ON DUPLICATE KEY UPDATE name_ia = VALUES(name_ia);

-- Mensagem de sucesso
SELECT 'Banco de dados criado com sucesso!' as status,
       'Todas as tabelas foram criadas.' as message,
       (SELECT COUNT(*) FROM categories) as total_categorias;
