## CI/CD Auto-Update Script

To enable automatic updates from GitHub and restart the application using Docker Compose, use the provided script:

```
./ci_cd_update.sh
```

This script will:
- Pull the latest code from the repository
- Rebuild and restart the Docker containers if there are updates
- Warn if there are local changes that need manual resolution

You can schedule this script with a cron job or run it manually after pushing updates to GitHub.
# 🛒 OfertasSertão - Bot de Promoções Afiliadas

Sistema completo para monitoramento e republicação automática de promoções com links de afiliados para Telegram.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![MySQL](https://img.shields.io/badge/MySQL-8.0-blue)
![Redis](https://img.shields.io/badge/Redis-7+-red)
![Telegram](https://img.shields.io/badge/Telegram-Bot%20API-blue)

## 📋 Funcionalidades

### 🤖 Bot de Telegram
- Monitora canais/grupos de promoções
- Classifica produtos automaticamente por categoria usando IA (Google Gemini)
- Converte links para afiliados (Shopee, Mercado Livre, AliExpress, Amazon)
- Republica ofertas formatadas em grupo com tópicos
- Detecta e formata mensagens de cupom separadamente

### 👤 Monitor de Conta de Usuário (MTProto)
- Monitora grupos usando conta pessoal do Telegram
- Acesso a grupos que não aceitam bots
- Sistema de deduplicação com Redis para evitar duplicatas

### 🌐 Painel Administrativo
- Dashboard com métricas em tempo real
- Gerenciamento de canais monitorados
- Configuração de categorias e tópicos
- Palavras proibidas (filtro de ofertas)
- Agendamento de posts
- Histórico de postagens
- Logs do sistema
- Configurações de afiliados
- Scripts úteis para configuração

### 🔗 Plataformas de Afiliados
| Plataforma | Tipo de Link | Configuração |
|------------|--------------|--------------|
| Shopee | API GraphQL | App ID, App Secret |
| Mercado Livre | Short Link API | Tag + Cookies |
| AliExpress | URL Params | Tracking ID |
| Amazon | SiteStripe API | Tag + Cookies |

## 🚀 Instalação

### Pré-requisitos
- Node.js 18+
- MySQL 8.0
- Redis 7+
- Docker (opcional, para Redis)

### 1. Clone o repositório
```bash
git clone https://github.com/seu-usuario/ofertassertao.git
cd ofertassertao
```

### 2. Instale as dependências
```bash
npm install
```

### 3. Configure o ambiente
```bash
cp .env.example .env
# Edite o .env com suas configurações
```

### 4. Inicie o Redis (via Docker)
```bash
docker-compose up -d
```

### 5. Configure o banco de dados
```bash
# Importe o schema
mysql -u root -p < migrations/ofertassertao.sql
```

### 6. Migre configurações do .env para o banco
```bash
node scripts/migrate_settings.js
```

### 7. Inicie o sistema
```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

### 8. Acesse o painel
Abra no navegador: `http://localhost:3000`

## ⚙️ Configuração

### Telegram Bot
1. Crie um bot com [@BotFather](https://t.me/BotFather)
2. Copie o token e adicione no `.env` ou painel

### Telegram MTProto (User Monitor)
1. Acesse [my.telegram.org](https://my.telegram.org/apps)
2. Crie uma aplicação
3. Copie API ID e API Hash

### Google Gemini AI
1. Acesse [Google AI Studio](https://aistudio.google.com/apikey)
2. Crie uma API Key
3. Adicione no `.env` ou painel

### Afiliados

#### Shopee
1. Cadastre-se no [Shopee Affiliates](https://affiliate.shopee.com.br)
2. Obtenha as credenciais da Open API

#### Mercado Livre
1. Cadastre-se como afiliado no Mercado Livre
2. Obtenha sua tag de afiliado
3. Siga o tutorial no painel (aba Scripts) para obter os cookies

#### Amazon
1. Cadastre-se no [Amazon Associates](https://associados.amazon.com.br)
2. Obtenha sua tag (ex: `suatag-20`)
3. Siga o tutorial no painel (aba Scripts) para obter os cookies

#### AliExpress
1. Cadastre-se no programa de afiliados
2. Obtenha seu Tracking ID

## 📁 Estrutura do Projeto

```
ofertassertao/
├── src/
│   ├── server.js           # Servidor Express + Bot Telegram
│   ├── config/
│   │   ├── db.js           # Conexão MySQL
│   │   ├── redis.js        # Conexão Redis
│   │   └── logger.js       # Winston Logger
│   ├── controllers/
│   │   └── categoryController.js
│   ├── models/
│   │   ├── categoryModel.js
│   │   ├── configModel.js
│   │   ├── forbiddenWordsModel.js
│   │   ├── monitoringModel.js
│   │   └── settingsModel.js
│   ├── services/
│   │   ├── affiliateService.js    # Conversão de links
│   │   ├── aiService.js           # Google Gemini AI
│   │   ├── apiMonitor.js          # Health check das APIs
│   │   ├── metaService.js         # Extração de metadados
│   │   ├── promotionFlow.js       # Fluxo de republicação
│   │   ├── rateLimiter.js         # Rate limiting
│   │   ├── scheduledPostsService.js
│   │   └── userMonitorService.js  # MTProto Monitor
│   ├── views/
│   │   └── index.ejs              # Painel administrativo
│   └── public/
│       └── img/
├── migrations/
│   └── ofertassertao.sql          # Schema do banco
├── scripts/
│   └── migrate_settings.js        # Migração .env → DB
├── docker-compose.yml             # Redis container
├── package.json
├── .env.example
└── README.md
```

## 🔧 Scripts Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Inicia em modo desenvolvimento (nodemon) |
| `npm start` | Inicia em modo produção |
| `node scripts/migrate_settings.js` | Migra configurações do .env para o banco |

## 🐳 Docker

O `docker-compose.yml` está configurado para subir apenas o Redis:

```bash
# Iniciar Redis
docker-compose up -d

# Parar Redis
docker-compose down

# Ver logs
docker-compose logs -f
```

## 📊 Comandos do Bot

| Comando | Descrição |
|---------|-----------|
| `/getgroupid` | Retorna o ID do grupo atual |
| `/gettopicid` | Retorna o ID do tópico atual |
| `/getchatid` | Retorna informações do chat e tópico |

## 🔒 Segurança

- Nunca commite o arquivo `.env`
- Os cookies do Amazon e ML expiram periodicamente
- Tokens e chaves são armazenados no banco de dados
- CSRF token é extraído automaticamente dos cookies do ML

## 📝 Categorias Suportadas

O sistema classifica automaticamente os produtos nas seguintes categorias:

- Smartphone
- Teclados
- Mouse e Mousepad
- Headset e Fone
- Monitor
- Processador
- Placa de Vídeo
- Placa Mãe
- Memória Ram
- Armazenamento
- Fonte
- Gabinete
- Refrigeração
- Pc e Notebook
- Consoles
- Áudio
- Mesas
- Acessórios
- Eletrônicos
- Cupom
- Variados (categoria padrão)

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch (`git checkout -b feature/nova-funcionalidade`)
3. Commit suas mudanças (`git commit -m 'Adiciona nova funcionalidade'`)
4. Push para a branch (`git push origin feature/nova-funcionalidade`)
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença ISC.

## 👨‍💻 Autor

Desenvolvido com ❤️ para OfertasSertão
