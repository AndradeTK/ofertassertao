const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_TIMEOUT = 8000;

async function fetchMetadata(url) {
  try {
    // Extract product data for Shopee using API
    if (url.includes('shopee.com')) {
      try {
        const shopeeData = await fetchShopeeMetadata(url);
        if (shopeeData) return shopeeData;
      } catch (err) {
        console.warn('Shopee API error, falling back to HTML parsing:', err.message);
      }
    }

    const resp = await axios.get(url, { timeout: DEFAULT_TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OfertasSertaoBot/1.0)' } });
    const html = resp.data;
    const $ = cheerio.load(html);

    const meta = {};
    meta.url = url;
    meta.title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    meta.description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    meta.image = $('meta[property="og:image"]').attr('content') || $('link[rel="image_src"]').attr('href') || '';

    // Enhanced price extraction with multiple strategies
    let price = $('meta[property="product:price:amount"]').attr('content') || 
                $('meta[itemprop="price"]').attr('content') || 
                $('meta[property="og:price:amount"]').attr('content') ||
                $('.price').first().text().trim() ||
                $('[itemprop="price"]').first().text().trim() ||
                '';
    
    // Clean price text
    if (price) {
      price = price.replace(/\s+/g, ' ').trim();
    }
    
    meta.price = price;

    // coupon detection heuristics (depends on site)
    const pageText = $('body').text();
    const couponMatch = pageText.match(/(cupom|coupon)[:#\s]*([A-Z0-9\-]{4,20})/i);
    meta.coupon = couponMatch ? couponMatch[2] : '';

    return meta;
  } catch (err) {
    console.error('fetchMetadata error:', err.message);
    return { url, title: '', description: '', image: '', price: '', coupon: '' };
  }
}

// Extract shop_id and item_id from Shopee URL
function parseShopeeUrl(url) {
  const match = url.match(/shopee\.com\.br\/([^/]+)-i\.(\d+)\.\d+/) || url.match(/shopee\.com\.br\/([^/]+)-i\.(\d+)/);
  if (match) {
    return { shop_id: match[1], item_id: match[2] };
  }
  return null;
}

async function fetchShopeeMetadata(url) {
  try {
    const parsed = parseShopeeUrl(url);
    if (!parsed) return null;

    // Use Shopee's public API to get product details
    const apiUrl = `https://shopee.com.br/api/v4/item/get?itemid=${parsed.item_id}&shopid=${parsed.shop_id}`;
    const resp = await axios.get(apiUrl, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OfertasSertaoBot/1.0)',
        'Referer': 'https://shopee.com.br/'
      }
    });

    if (resp.data && resp.data.data) {
      const item = resp.data.data;
      let price = '';
      
      // Try multiple price fields
      if (item.price) {
        price = `R$ ${(item.price / 100000).toFixed(2)}`;
      } else if (item.price_min && item.price_max) {
        if (item.price_min === item.price_max) {
          price = `R$ ${(item.price_min / 100000).toFixed(2)}`;
        } else {
          price = `R$ ${(item.price_min / 100000).toFixed(2)} - R$ ${(item.price_max / 100000).toFixed(2)}`;
        }
      }

      return {
        url,
        title: item.name || '',
        description: item.description || '',
        image: item.image ? `https://cf.shopee.com.br/file/${item.image}` : '',
        price: price || '',
        coupon: ''
      };
    }
  } catch (err) {
    console.warn('Shopee API fetch failed:', err.message);
  }
  return null;
}

module.exports = { fetchMetadata };
