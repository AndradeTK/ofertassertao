const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Category mapping: AI output -> Database name
const CATEGORY_MAP = {
    'Smartphones': 'Smartphone',
    'Smartphone': 'Smartphone',
    'Teclados': 'Teclados',
    'Mouse e Mousepad': 'Mouse e Mousepad',
    'Headset e Fone': 'Headset e Fone',
    'Monitor': 'Monitor',
    'Processador': 'Processador',
    'Placa de Vídeo': 'Placa de Vídeo',
    'Placa Mãe': 'Placa Mãe',
    'Memória Ram': 'Memória Ram',
    'Armazenamento': 'Armazenamento',
    'Fonte': 'Fonte',
    'Gabinete': 'Gabinete',
    'Refrigeração': 'Refrigeração',
    'Pc e Notebook': 'Pc e Notebook',
    'Consoles': 'Consoles',
    'Áudio': 'Áudio',
    'Mesas': 'Mesas',
    'Acessórios': 'Acessórios',
    'Eletrônicos': 'Eletrônicos',
    'Cupom': 'Cupom',
    'Cupons': 'Cupom',
    'Variados': 'Variados',
    'Casa': 'Variados',
    'Moda': 'Variados',
    'Outros': 'Variados'
};

// Category keywords for fallback classification
const CATEGORY_KEYWORDS = {
    'Cupom': ['meia noite tem cupom', 'cupom shopee', 'cupom mercado livre', 'cupom amazon', 'resgate o cupom', 'cupom de desconto', 'cupom geral', 'pesquise seus produtos', 'use o cupom', 'aproveite o cupom', 'cupom disponível', 'cupom válido'],
    'Smartphone': ['iphone', 'samsung', 'xiaomi', 'motorola', 'celular', 'smartphone', 'pixel', 'redmi', 'poco', 'oppo', 'vivo', 'realme'],
    'Monitor': ['monitor', 'display', 'tela'],
    'Teclados': ['teclado', 'keyboard'],
    'Mouse e Mousepad': ['mouse', 'mousepad'],
    'Headset e Fone': ['fone', 'headset', 'headphone', 'earphone', 'earbud'],
    'Processador': ['processador', 'cpu', 'ryzen', 'intel', 'core i'],
    'Placa de Vídeo': ['placa de vídeo', 'gpu', 'nvidia', 'geforce', 'rtx', 'gtx', 'radeon'],
    'Placa Mãe': ['placa mãe', 'motherboard'],
    'Memória Ram': ['memória', 'ram', 'ddr'],
    'Armazenamento': ['ssd', 'hdd', 'armazenamento', 'nvme'],
    'Fonte': ['fonte', 'psu', 'power supply'],
    'Gabinete': ['gabinete', 'case'],
    'Refrigeração': ['cooler', 'watercooler', 'refrigeração'],
    'Pc e Notebook': ['notebook', 'laptop', 'computador', 'pc'],
    'Consoles': ['playstation', 'xbox', 'nintendo', 'console'],
    'Áudio': ['caixa de som', 'speaker', 'soundbar', 'áudio'],
    'Mesas': ['mesa', 'escrivaninha', 'desk'],
    'Acessórios': ['cabo', 'adaptador', 'acessório'],
    'Eletrônicos': ['eletrônico', 'tablet', 'camera'],
    'Variados': []
};

/**
 * Normalize text by removing accents and converting to lowercase
 * This allows matching "Placa Mae" with "Placa Mãe", etc.
 */
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ''); // Remove diacritics (accents)
}

function fallbackClassification(title = '', description = '') {
    const text = normalizeText(`${title} ${description}`);
    const originalText = `${title} ${description}`.toLowerCase();
    
    // Check if this is a GENERIC coupon message (NOT a product with a coupon code)
    // Generic coupon messages are announcements about coupons available, not specific products
    const couponIndicators = [
        'meia noite tem cupom',
        'tem cupom shopee',
        'cupom disponivel',
        'pesquise seus produtos',
        'cupom de r$',
        'cupom geral',
        'cupons disponiveis',
        'resgate o cupom'
    ];
    
    // Product indicators - if these are present, it's a PRODUCT message, not a coupon announcement
    const productIndicators = [
        /\d+[.,]\d{2}\s*(à vista|a vista|reais)?/i,  // Price pattern
        /r\$\s*\d+[.,]/i,                             // R$ price
        /MLB\d+/i,                                     // ML product ID
        /mercadolivre\.com\.br.*\/p\//i,              // ML product URL
        /shopee\.com\.br\/.*-i\.\d+\.\d+/i,           // Shopee product URL
        /amazon\.com\.br\/dp\//i,                     // Amazon product URL
    ];
    
    // Check if it's a product message (has price or product URL)
    const hasProductIndicator = productIndicators.some(pattern => pattern.test(originalText));
    
    // It's only a coupon message if it has coupon indicators AND NO product indicators
    const hasCouponIndicator = couponIndicators.some(indicator => text.includes(normalizeText(indicator)));
    const isCouponMessage = hasCouponIndicator && !hasProductIndicator;
    
    console.log(`[AI Fallback] Product indicators: ${hasProductIndicator}, Coupon indicators: ${hasCouponIndicator}, Is coupon message: ${isCouponMessage}`);
    
    // Extract title - try multiple approaches to find the PRODUCT NAME, not marketing phrases
    const lines = description.split('\n').map(l => l.trim()).filter(l => l && !l.includes('http'));
    let extractedTitle = '';
    
    // Common brand names to help identify product lines
    const brandPatterns = /\b(gillette|samsung|apple|xiaomi|motorola|lg|sony|philips|jbl|logitech|nike|adidas|puma|havaianas|oster|mondial|arno|electrolux|brastemp|consul|intelbras|positivo|dell|hp|lenovo|asus|acer|kindle|echo|alexa|fire\s*tv|chromecast|roku|playstation|xbox|nintendo|gopro|canon|nikon|fuji|dji|garmin|fitbit|amazfit|redmi|poco|realme|oppo|oneplus|huawei|honor|iphone|ipad|macbook|airpods|galaxy|pixel|moto\s*g|moto\s*e|edge|razr)/i;
    
    // Patterns that indicate marketing phrases (NOT product names)
    const marketingPatterns = /^(não|nao|super|mega|ultra|incrível|incrivel|aproveite|oferta|promoção|promocao|desconto|imperdível|imperdivel|corra|só\s*hoje|so\s*hoje|últimas|ultimas|limitado|exclusivo|melhor|ótimo|otimo|perfeito|sensacional|maravilh|fantástic|fantastic|top\s*demais|bom\s*demais|vale\s*a\s*pena|recomendo|compre|garanta|adquira|leve|confira|veja|olha|gente|pessoal|galera)/i;
    
    // First pass: try to find a line with a brand name (most likely product name)
    for (const line of lines) {
        const cleanLine = line.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
        if (cleanLine.length > 8 && brandPatterns.test(cleanLine)) {
            extractedTitle = cleanLine;
            break;
        }
    }
    
    // Second pass: if no brand found, look for product-like lines (skip marketing phrases)
    if (!extractedTitle) {
        for (const line of lines) {
            const cleanLine = line.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
            
            // Skip if too short, is a price, or looks like marketing
            if (cleanLine.length < 10) continue;
            if (cleanLine.match(/^[\d,.]+\s*(à vista|reais)?$/i)) continue;
            if (marketingPatterns.test(cleanLine)) continue;
            if (cleanLine === cleanLine.toUpperCase() && cleanLine.length < 50) continue; // Skip ALL CAPS short phrases
            
            // Skip lines that start with - or • (usually bullet points/features)
            if (cleanLine.match(/^[-•*]/)) continue;
            
            extractedTitle = cleanLine;
            break;
        }
    }
    
    // Third pass: if still nothing, just take any line with decent length that's not the first
    if (!extractedTitle && lines.length > 1) {
        for (let i = 1; i < lines.length; i++) {
            const cleanLine = lines[i].replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
            if (cleanLine.length > 15 && !cleanLine.match(/^[\d,.]+/)) {
                extractedTitle = cleanLine;
                break;
            }
        }
    }
    
    // Final fallback: use first line but warn
    if (!extractedTitle && lines.length > 0) {
        extractedTitle = lines[0].replace(/[🛒🔥💥🚨🎯👍👎😍🤩💪]/g, '').trim();
        console.warn(`⚠️ Fallback: usando primeira linha como título: "${extractedTitle}"`);
    }
    
    // For coupon messages, use a better title
    if (isCouponMessage) {
        // Try to extract coupon value for title
        const couponValueMatch = description.match(/R\$\s*(\d+)\s*OFF/i);
        if (couponValueMatch) {
            extractedTitle = `Cupom R$ ${couponValueMatch[1]} OFF`;
        } else {
            extractedTitle = extractedTitle || 'Cupom de Desconto';
        }
    }
    
    // Extract price from text (look for various patterns) - NOT for coupon messages
    let extractedPrice = '';
    let extractedVariants = [];
    
    if (!isCouponMessage) {
        // First, try to detect variants (multiple sizes/options with prices)
        // Pattern: "30ml — R$ 186" or "30ml - R$ 186" or "30ml: R$ 186" or "100ml R$ 289"
        const variantPattern = /(\d+\s*(?:ml|g|gb|tb|kg|un|pcs?|unidades?|metros?|m|cm|l|litros?))\s*[—\-:]*\s*(?:R\$\s*)?([\d.,]+)/gi;
        let variantMatch;
        while ((variantMatch = variantPattern.exec(description)) !== null) {
            const label = variantMatch[1].trim();
            let price = variantMatch[2].trim();
            // Add R$ if not present
            if (!price.startsWith('R$')) {
                price = `R$ ${price}`;
            }
            extractedVariants.push({ label, price });
        }
        
        // If we found variants, don't extract a single price
        if (extractedVariants.length === 0) {
            // Try 💰 R$ format first
            let priceMatch = description.match(/💰\s*(R\$\s*[\d.,]+)/i);
            if (priceMatch) {
                extractedPrice = priceMatch[1];
            } else {
                // Try "R$ XX,XX" or "XX,XX à vista" patterns
                priceMatch = description.match(/R\$\s*([\d.,]+)/i);
                if (priceMatch) {
                    extractedPrice = `R$ ${priceMatch[1]}`;
                } else {
                    // Try "XX,XX à vista" pattern (without R$)
                    priceMatch = description.match(/([\d]+[.,][\d]{2})\s*à vista/i);
                    if (priceMatch) {
                        extractedPrice = `R$ ${priceMatch[1]}`;
                    }
                }
            }
        }
    }
    
    // Extract coupon info - also look for coupon codes like "use o cupom MELIVERAO"
    let extractedCoupon = '';
    
    // First try to find a coupon CODE (like MELIVERAO)
    const couponCodePatterns = [
        /(?:use|com)\s+o?\s*cupom\s+[`'"]*([A-Z0-9]{4,20})[`'"]*(?:\s|$)/i,
        /cupom[:\s]+[`'"]*([A-Z0-9]{4,20})[`'"]*(?:\s|$)/i,
    ];
    
    for (const pattern of couponCodePatterns) {
        const match = description.match(pattern);
        if (match && match[1] && match[1].toLowerCase() !== 'resgate' && match[1].toLowerCase() !== 'disponivel') {
            extractedCoupon = match[1].toUpperCase();
            break;
        }
    }
    
    // If no code found, try other patterns
    if (!extractedCoupon) {
        // Try to match "R$ 100 OFF a partir de R$ 899"
        const couponDetailsMatch = description.match(/R\$\s*\d+\s*OFF[^,\n]*(a partir de[^,\n]*)?/i);
        if (couponDetailsMatch) {
            extractedCoupon = couponDetailsMatch[0].trim();
        } else {
            // Try to match coupon URL from Shopee
            const couponUrlMatch = description.match(/🎟[️\s]*(?:Cupom[:\s]*)?(?:Resgate[^:]*:\s*)?(https:\/\/s\.shopee\.com\.br\/[^\s\n]+)/i);
            if (couponUrlMatch) {
                extractedCoupon = couponUrlMatch[1];
            }
        }
    }
    
    // Classify category - check Cupom first for coupon messages
    let category = 'Outros';
    
    if (isCouponMessage) {
        category = 'Cupom';
    } else {
        for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
            if (cat === 'Outros' || cat === 'Cupom') continue;
            for (const keyword of keywords) {
                // Normalize keyword too for accent-insensitive matching
                if (text.includes(normalizeText(keyword))) {
                    category = cat;
                    break;
                }
            }
            if (category !== 'Outros') break;
        }
    }
    
    // Map fallback category to database category name
    const mappedCategory = CATEGORY_MAP[category] || category || 'Variados';
    
    console.log('📋 Fallback extraction:', { 
        title: extractedTitle, 
        price: extractedPrice, 
        coupon: extractedCoupon, 
        variants: extractedVariants,
        category: mappedCategory,
        isCouponMessage 
    });
    
    return {
        title: extractedTitle || title || '',
        price: extractedPrice || '',
        coupon: extractedCoupon || '',
        variants: extractedVariants,
        category: mappedCategory,
        confidence: 60,
        isCouponMessage: isCouponMessage,
        originalDescription: isCouponMessage ? description : ''
    };
}

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
- "category": Classify the PRODUCT into one of these:
  * Smartphone, Monitor, Teclados, Mouse e Mousepad, Headset e Fone
  * Processador, Placa de Vídeo, Placa Mãe, Memória Ram, Armazenamento
  * Fonte, Gabinete, Refrigeração, Pc e Notebook, Consoles
  * Áudio, Mesas, Acessórios, Eletrônicos, Variados
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
  "category": "Variados",
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
        const mappedCategory = CATEGORY_MAP[parsed.category] || parsed.category || 'Variados';
        
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
        
        // Se for erro 429 ou relacionado a quota, usar fallback
        if (errorMsg.includes('429') || errorMsg.includes('Resource exhausted') || errorMsg.includes('quota')) {
            console.warn(`⚠️ Gemini quota exceeded, using fallback classification`);
            return fallbackClassification(title, description);
        }
        
        // Para outros erros, tentar retry com backoff
        if (errorMsg.includes('timeout') || errorMsg.includes('ECONNRESET')) {
            console.warn(`⚠️ Gemini timeout, retrying after 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            return classifyAndCaption({ title, price, description, url });
        }
        
        console.error(`IA Classification error: ${errorMsg}, usando fallback`);
        return fallbackClassification(title, description);
    }
}

module.exports = { classifyAndCaption };