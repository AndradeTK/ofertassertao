const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Category mapping: AI output -> Database `categories.name_ia`
// Synchronized with migrations/ofertassertao.sql
const CATEGORY_MAP = {
    'Acessorios': 'Acessórios',
    'Acessórios': 'Acessórios',
    'Áudio': 'Áudio',
    'Audio': 'Áudio',
    'Armazenamento': 'Armazenamento',
    'Cadeiras': 'Cadeiras',
    'Computador/Notebook': 'Computador/Notebook',
    'Pc e Notebook': 'Computador/Notebook',
    'Consoles': 'Consoles',
    'Cupom': 'Cupom',
    'Cupons': 'Cupom',
    'Eletronicos': 'Eletrônicos',
    'Eletrônicos': 'Eletrônicos',
    'Fitness': 'Fitness',
    'Fonte': 'Fonte',
    'Gabinete': 'Gabinete',
    'Headset/Fone': 'Headset/Fone',
    'Headset e Fone': 'Headset/Fone',
    'Higiene': 'Higiene',
    'Jogos': 'Jogos',
    'Memoria RAM': 'Memória RAM',
    'Memória RAM': 'Memória RAM',
    'Mesas': 'Mesas',
    'Monitores': 'Monitores',
    'Mouse': 'Mouse',
    'Outros': 'Outros',
    'Placa de Video': 'Placa de Vídeo',
    'Placa de Vídeo': 'Placa de Vídeo',
    'Placa Mae': 'Placa Mãe',
    'Placa Mãe': 'Placa Mãe',
    'Processador': 'Processador',
    'Produto de Limpeza': 'Produto de Limpeza',
    'Roupa/Moda': 'Roupa/Moda',
    'Teclado': 'Teclado',
    'Telefone/Tablet': 'Telefone/Tablet',
    'Telefone / Tablet': 'Telefone/Tablet',
    'Televisao': 'Televisão',
    'Televisão': 'Televisão'
};

/**
 * Normalize text by removing accents and converting to lowercase
 */
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Simple data extraction (NOT classification)
 * Only extracts title, price, coupon from text
 * Does NOT attempt to classify category - that requires AI
 */
function extractBasicData(title = '', description = '') {
    const text = normalizeText(`${title} ${description}`);
    const originalText = `${title} ${description}`;
    
    // Extract title - first non-empty line that looks like a product name
    const lines = description.split('\n').map(l => l.trim()).filter(l => l && !l.includes('http'));
    let extractedTitle = '';
    
    const brandPatterns = /\b(gillette|samsung|apple|xiaomi|motorola|lg|sony|philips|jbl|logitech|nike|adidas|puma|havaianas|oster|mondial|arno|electrolux|brastemp|consul|intelbras|positivo|dell|hp|lenovo|asus|acer|kindle|echo|alexa|fire\s*tv|chromecast|roku|playstation|xbox|nintendo|gopro|canon|nikon|fuji|dji|garmin|fitbit|amazfit|redmi|poco|realme|oppo|oneplus|huawei|honor|iphone|ipad|macbook|airpods|galaxy|pixel|moto\s*g|moto\s*e|edge|razr)/i;
    
    // Try to find a line with a brand name
    for (const line of lines) {
        const cleanLine = line.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
        if (cleanLine.length > 8 && brandPatterns.test(cleanLine)) {
            extractedTitle = cleanLine;
            break;
        }
    }
    
    // Fallback: use first decent line
    if (!extractedTitle && lines.length > 0) {
        for (const line of lines) {
            const cleanLine = line.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
            if (cleanLine.length > 10 && !cleanLine.match(/^[\d,.]+/)) {
                extractedTitle = cleanLine;
                break;
            }
        }
    }
    
    if (!extractedTitle && lines.length > 0) {
        extractedTitle = lines[0].replace(/[🛒🔥💥🚨🎯👍👎😍🤩💪]/g, '').trim();
    }
    
    // Extract price
    let extractedPrice = '';
    let priceMatch = description.match(/💰\s*(R\$\s*[\d.,]+)/i);
    if (priceMatch) {
        extractedPrice = priceMatch[1];
    } else {
        priceMatch = description.match(/R\$\s*([\d.,]+)/i);
        if (priceMatch) {
            extractedPrice = `R$ ${priceMatch[1]}`;
        } else {
            priceMatch = description.match(/([\d]+[.,][\d]{2})\s*à vista/i);
            if (priceMatch) {
                extractedPrice = `R$ ${priceMatch[1]}`;
            }
        }
    }
    
    // Extract coupon
    let extractedCoupon = '';
    const couponCodePatterns = [
        /(?:use|com)\s+o?\s*cupom\s+[`'"]*([A-Z0-9]{4,20})[`'"]*(?:\s|$)/i,
        /cupom[:\s]+[`'"]*([A-Z0-9]{4,20})[`'"]*(?:\s|$)/i,
    ];
    
    for (const pattern of couponCodePatterns) {
        const match = description.match(pattern);
        if (match && match[1] && match[1].toLowerCase() !== 'resgate') {
            extractedCoupon = match[1].toUpperCase();
            break;
        }
    }
    
    console.log('📋 Basic extraction (NO AI):', { 
        title: extractedTitle, 
        price: extractedPrice, 
        coupon: extractedCoupon 
    });
    
    return {
        title: extractedTitle || title || '',
        price: extractedPrice || '',
        coupon: extractedCoupon || '',
        variants: [],
        category: null, // NO CATEGORY - requires manual approval
        confidence: 0,
        isCouponMessage: false,
        needsApproval: true // Flag indicating this needs manual approval
    };
}

// Removed keyword-based fallback classification
// Now when AI fails, we use extractBasicData and return needsApproval: true

async function classifyAndCaption({ title = '', price = '', description = '', url = '' }, retryCount = 0) {
    const prompt = `Analyze this promotional message and return ONLY a valid JSON object.

MESSAGE:
${description}

FIRST, determine the MESSAGE TYPE:

1. COUPON MESSAGE (isCouponMessage=true) - A GENERIC announcement about coupons available. Signs:
   - Does NOT have a specific product with a price
   - Is announcing that coupons will be available (e.g., "meia noite tem cupom")
   - Has a generic search link, NOT a direct product link

2. PRODUCT MESSAGE (isCouponMessage=false) - A message promoting a SPECIFIC PRODUCT. Signs:
   - Names a specific product
   - Shows a specific price for that product
   - Has a direct link to buy that SPECIFIC product
   - MAY include a coupon code to use on checkout - this does NOT make it a "coupon message"!

IMPORTANT: Check if the message has MULTIPLE VARIANTS (different sizes/colors/versions with different prices).
Example: "30ml — R$ 186" and "100ml — R$ 289" are TWO VARIANTS of the same product.

EXTRACTION RULES:

FOR PRODUCT MESSAGES:
- "title": The product name (clean, without emojis)
- "price": The LOWEST price OR leave empty if there are variants
- "coupon": Any coupon code mentioned, empty if none
- "variants": Array of variants if the product has multiple sizes/options with different prices. Each variant: {"label": "30ml", "price": "R$ 186"}
  * If no variants, use empty array []
  * IMPORTANT: Extract ALL variants with their labels and prices!
- "category": Classify the PRODUCT into one of these (these names match the system categories):
    * Acessórios
    * Áudio
    * Armazenamento
    * Cadeiras
    * Computador/Notebook
    * Consoles
    * Cupom
    * Eletrônicos
    * Fitness
    * Fonte
    * Gabinete
    * Headset/Fone
    * Higiene
    * Jogos
    * Memória RAM
    * Mesas
    * Monitores
    * Mouse
    * Outros
    * Placa de Vídeo
    * Placa Mãe
    * Processador
    * Produto de Limpeza
    * Roupa/Moda
    * Teclado
    * Telefone/Tablet
    * Televisão

    EXAMPLES (keyword -> category):
    - "iphone" -> "Telefone/Tablet"
    - "ipad" -> "Telefone/Tablet"
    - "macbook" -> "Computador/Notebook"
    - "notebook" -> "Computador/Notebook"
    - "ssd" -> "Armazenamento"
    - "hd" -> "Armazenamento"
    - "rtx" -> "Placa de Vídeo"
    - "placa de vídeo" -> "Placa de Vídeo"
    - "ryzen" -> "Processador"
    - "intel" -> "Processador"
    - "teclado" -> "Teclado"
    - "fone" -> "Headset/Fone"
    - "airpods" -> "Headset/Fone"
    - "monitor" -> "Monitores"
    - "tv" -> "Televisão"

- "isCouponMessage": false
- "confidence": 0-100

FOR COUPON MESSAGES:
- "title": Descriptive title like "Cupom Shopee R$ X OFF"
- "price": Empty
- "coupon": The coupon VALUE
- "variants": []
- "category": "Cupom"
- "isCouponMessage": true

EXAMPLE 1 (PRODUCT WITH VARIANTS):
Input: "Perfume Calvin Klein\\n30ml — R$ 186\\nhttps://...\\n100ml — R$ 289\\nhttps://..."
Output: {
  "title": "Perfume Calvin Klein",
  "price": "",
  "coupon": "",
  "variants": [
    {"label": "30ml", "price": "R$ 186"},
    {"label": "100ml", "price": "R$ 289"}
  ],
  "category": "Outros",
  "isCouponMessage": false,
  "confidence": 95
}

EXAMPLE 2 (SIMPLE PRODUCT):
Input: "SSD Kingston 480GB\\nR$ 199,90\\nhttps://..."
Output: {
  "title": "SSD Kingston 480GB",
  "price": "R$ 199,90",
  "coupon": "",
  "variants": [],
  "category": "Armazenamento",
  "isCouponMessage": false,
  "confidence": 95
}

EXAMPLE 3 (PRODUCT WITH COUPON):
Input: "Lavadora Lava Jato\\n- use o cupom MELIVERAO\\n92,30 à vista\\nhttps://..."
Output: {
  "title": "Lavadora Lava Jato",
  "price": "R$ 92,30",
  "coupon": "MELIVERAO",
  "variants": [],
  "category": "Eletrônicos",
  "isCouponMessage": false,
  "confidence": 95
}

Return ONLY the JSON object.`;

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const response = await model.generateContent(prompt);
        
        const content = response.response?.text?.();
        if (!content) throw new Error('Sem resposta do modelo');

        console.log(`🤖 IA Raw Response (attempt ${retryCount + 1}):`, content.substring(0, 200));

        // Tenta extrair JSON da resposta
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            // Tentar encontrar o primeiro bloco JSON no texto
            const m = content.match(/\{[\s\S]*\}/);
            if (m) {
                parsed = JSON.parse(m[0]);
            } else {
                throw new Error('Resposta do modelo não contém JSON válido');
            }
        }

        // Valida formato esperado
        if (!parsed.category || typeof parsed.confidence === 'undefined') {
            throw new Error('Formato JSON inválido retornado pela IA');
        }

        console.log('✅ IA parsed successfully:', JSON.stringify(parsed, null, 2));

        // Validação de qualidade dos dados
        const hasTitle = parsed.title && parsed.title.length > 5;
        const hasPrice = (parsed.price && parsed.price.includes('R$')) || (parsed.variants && parsed.variants.length > 0);
        
        // Se dados importantes estão vazios e ainda temos retries, tenta novamente
        if ((!hasTitle || !hasPrice) && retryCount < 2) {
            console.warn(`⚠️ Dados insuficientes da IA (title: ${hasTitle}, price: ${hasPrice}). Retry ${retryCount + 1}/2...`);
            await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
            return classifyAndCaption({ title, price, description, url }, retryCount + 1);
        }

        // Map AI category to database category name
        const mappedCategory = CATEGORY_MAP[parsed.category] || parsed.category || 'Outros';
        
        return {
            title: parsed.title || '',
            price: parsed.price || '',
            coupon: parsed.coupon || '',
            variants: parsed.variants || [],
            category: mappedCategory,
            confidence: Number(parsed.confidence),
            isCouponMessage: !!parsed.isCouponMessage,
            originalDescription: parsed.description || ''
        };
    } catch (err) {
        const errorMsg = err.message || String(err);
        
        console.warn(`⚠️ IA Error: ${errorMsg}`);
        
        // Para outros erros, tentar retry com backoff
        if (errorMsg.includes('timeout') || errorMsg.includes('ECONNRESET')) {
            console.warn(`⚠️ Gemini timeout, retrying after 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            return classifyAndCaption({ title, price, description, url });
        }
        
        // For any AI error, extract basic data and mark as needing approval
        // NO keyword-based fallback - promotions go to pending queue for manual review
        console.warn(`⚠️ IA Classification failed: ${errorMsg}. Promotion will need manual approval.`);
        return extractBasicData(title, description);
    }
}

module.exports = { classifyAndCaption, extractBasicData };