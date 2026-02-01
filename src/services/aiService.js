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

function fallbackClassification(title = '', description = '') {
    const text = `${title} ${description}`.toLowerCase();
    
    // Check if this is a coupon message (not a specific product)
    const couponIndicators = [
        'meia noite tem cupom',
        'tem cupom shopee',
        'cupom disponível',
        'use o cupom',
        'aproveite o cupom',
        'pesquise seus produtos',
        'cupom de r$',
        'cupom shopee',
        'cupom mercado livre',
        'cupom amazon'
    ];
    
    const isCouponMessage = couponIndicators.some(indicator => text.includes(indicator));
    
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
    if (!isCouponMessage) {
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
    
    // Extract coupon info
    let extractedCoupon = '';
    // Try to match "R$ 100 OFF a partir de R$ 899"
    const couponDetailsMatch = description.match(/R\$\s*\d+\s*OFF[^,\n]*(a partir de[^,\n]*)?/i);
    if (couponDetailsMatch) {
        extractedCoupon = couponDetailsMatch[0].trim();
    } else {
        // Try to match "Resgate o cupom R$ 100 OFF: https://..."
        const couponWithValueMatch = description.match(/🎟[️\s]*(?:Resgate o cupom)?\s*([R\$\s\d.,]+\s*OFF)\s*[:\s]+(https:\/\/s\.shopee\.com\.br\/[^\s\n]+)/i);
        if (couponWithValueMatch) {
            extractedCoupon = `${couponWithValueMatch[1]}: ${couponWithValueMatch[2]}`;
        } else {
            const couponUrlMatch = description.match(/🎟[️\s]*(?:Cupom[:\s]*)?(?:Resgate[^:]*:\s*)?(https:\/\/s\.shopee\.com\.br\/[^\s\n]+)/i);
            if (couponUrlMatch) {
                extractedCoupon = couponUrlMatch[1];
            } else {
                // Try to find coupon code
                const couponCodeMatch = description.match(/🎟[️\s]*Cupom[:\s]+([A-Z0-9]{4,20})/i);
                if (couponCodeMatch && couponCodeMatch[1].toLowerCase() !== 'resgate') {
                    extractedCoupon = couponCodeMatch[1];
                }
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
                if (text.includes(keyword)) {
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
        category: mappedCategory,
        isCouponMessage 
    });
    
    return {
        title: extractedTitle || title || '',
        price: extractedPrice || '',
        coupon: extractedCoupon || '',
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
1. COUPON MESSAGE - A message announcing a coupon/discount code that users can use when shopping. Signs:
   - Contains phrases like "tem cupom", "cupom disponível", "use o cupom", "cupom de R$"
   - Talks about discounts like "R$ X OFF"
   - Has a generic link for users to search products (not a specific product)
   - Does NOT mention a specific product name

2. PRODUCT MESSAGE - A message promoting a specific product. Signs:
   - Names a specific product (e.g., "Xiaomi Redmi Note 12", "SSD Kingston 480GB")
   - Shows a specific price for that product
   - Has a direct link to buy that product

EXTRACTION RULES:

FOR COUPON MESSAGES:
- "title": Use a descriptive title like "Cupom Shopee R$ X OFF" or "Cupom de Desconto" or the main message headline
- "price": Leave EMPTY (coupons don't have a price)
- "coupon": The coupon VALUE or CODE mentioned (e.g., "R$ 100 OFF a partir de R$ 899")
- "description": Preserve the FULL ORIGINAL MESSAGE with all important details about when/how to use the coupon
- "category": "Cupom"
- "isCouponMessage": true

FOR PRODUCT MESSAGES:
- "title": The product name (clean, without emojis)
- "price": The price in format "R$ X,XXX"
- "coupon": Any coupon code/URL if present, empty string if not
- "description": Empty string (we'll format it ourselves)
- "category": Classify into one of these:
  * Smartphone, Monitor, Teclados, Mouse e Mousepad, Headset e Fone
  * Processador, Placa de Vídeo, Placa Mãe, Memória Ram, Armazenamento
  * Fonte, Gabinete, Refrigeração, Pc e Notebook, Consoles
  * Áudio, Mesas, Acessórios, Eletrônicos, Variados
- "isCouponMessage": false

IMPORTANT:
- "confidence": 0-100 (how confident you are in the classification)
- For COUPON messages, include ALL the original details in "description" field
- Do NOT strip important information from coupon messages

EXAMPLE 1 (COUPON MESSAGE):
Input: "Meia noite tem cupom Shopee\\n- Provavelmente será de R$ 100 OFF a partir de R$ 899\\n🎯 Pesquise: https://..."
Output: {
  "title": "Cupom Shopee R$ 100 OFF",
  "price": "",
  "coupon": "R$ 100 OFF a partir de R$ 899",
  "description": "Meia noite tem cupom Shopee\\n\\n- Provavelmente será de R$ 100 OFF a partir de R$ 899, ideal para itens mais caros\\n\\n🎯 Pesquise seus produtos preferidos",
  "category": "Cupom",
  "isCouponMessage": true,
  "confidence": 95
}

EXAMPLE 2 (PRODUCT MESSAGE):
Input: "🛒 Xiaomi Redmi Note 12 128GB\\n💰 R$ 899,00\\n🔗 https://..."
Output: {
  "title": "Xiaomi Redmi Note 12 128GB",
  "price": "R$ 899,00",
  "coupon": "",
  "description": "",
  "category": "Smartphone",
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
        const hasPrice = parsed.price && parsed.price.includes('R$');
        
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