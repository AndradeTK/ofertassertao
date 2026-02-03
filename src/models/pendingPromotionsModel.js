/**
 * Pending Promotions Model
 * Handles promotions that need manual approval (AI fallback cases and no-affiliate cases)
 */

const { pool } = require('../config/db');

class PendingPromotions {
    /**
     * Add a new pending promotion
     * @param {Object} data - Promotion data
     * @param {string} data.reason - 'ai_fallback' or 'no_affiliate'
     */
    static async add(data) {
        const {
            originalText,
            processedText,
            productName,
            price,
            coupon,
            imagePath,
            urls,
            affiliateUrls,
            suggestedCategory,
            source,
            reason = 'ai_fallback'
        } = data;

        const [result] = await pool.execute(
            `INSERT INTO pending_promotions 
            (original_text, processed_text, product_name, price, coupon, image_path, urls, affiliate_urls, suggested_category, source, status, reason) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [
                originalText || '',
                processedText || '',
                productName || '',
                price || '',
                coupon || '',
                imagePath || null,
                JSON.stringify(urls || []),
                JSON.stringify(affiliateUrls || {}),
                suggestedCategory || 'Variados',
                source || 'unknown',
                reason
            ]
        );

        return result.insertId;
    }

    /**
     * Get all pending promotions (AI fallback only)
     */
    static async getPending() {
        const [rows] = await pool.execute(
            `SELECT * FROM pending_promotions 
            WHERE status = 'pending' AND (reason = 'ai_fallback' OR reason IS NULL)
            ORDER BY created_at DESC`
        );
        
        return rows.map(row => ({
            ...row,
            urls: JSON.parse(row.urls || '[]'),
            affiliate_urls: JSON.parse(row.affiliate_urls || '{}')
        }));
    }

    /**
     * Get all pending promotions without affiliate links
     */
    static async getNoAffiliate() {
        const [rows] = await pool.execute(
            `SELECT * FROM pending_promotions 
            WHERE status = 'pending' AND reason = 'no_affiliate'
            ORDER BY created_at DESC`
        );
        
        return rows.map(row => ({
            ...row,
            urls: JSON.parse(row.urls || '[]'),
            affiliate_urls: JSON.parse(row.affiliate_urls || '{}')
        }));
    }

    /**
     * Get pending count (AI fallback)
     */
    static async getPendingCount() {
        const [rows] = await pool.execute(
            `SELECT COUNT(*) as count FROM pending_promotions WHERE status = 'pending' AND (reason = 'ai_fallback' OR reason IS NULL)`
        );
        return rows[0].count;
    }

    /**
     * Get no-affiliate pending count
     */
    static async getNoAffiliateCount() {
        const [rows] = await pool.execute(
            `SELECT COUNT(*) as count FROM pending_promotions WHERE status = 'pending' AND reason = 'no_affiliate'`
        );
        return rows[0].count;
    }

    /**
     * Get a single promotion by ID
     */
    static async getById(id) {
        const [rows] = await pool.execute(
            `SELECT * FROM pending_promotions WHERE id = ?`,
            [id]
        );
        
        if (rows.length === 0) return null;
        
        const row = rows[0];
        return {
            ...row,
            urls: JSON.parse(row.urls || '[]'),
            affiliate_urls: JSON.parse(row.affiliate_urls || '{}')
        };
    }

    /**
     * Update promotion details
     */
    static async update(id, data) {
        const {
            product_name,
            productName,
            price,
            coupon,
            category,
            suggested_category,
            processed_text,
            processedText,
            image_path,
            imagePath
        } = data;

        // Support both snake_case and camelCase
        const finalProductName = product_name || productName || '';
        const finalCategory = category || suggested_category || '';
        const finalProcessedText = processed_text || processedText || null;
        const finalImagePath = image_path !== undefined ? image_path : (imagePath !== undefined ? imagePath : null);

        // Build dynamic query based on what fields are provided
        const fields = ['product_name = ?', 'price = ?', 'coupon = ?', 'suggested_category = ?'];
        const values = [finalProductName, price || '', coupon || '', finalCategory];
        
        if (finalProcessedText) {
            fields.push('processed_text = ?');
            values.push(finalProcessedText);
        }
        
        // Handle image_path - allow setting to null (empty string means remove)
        if (finalImagePath !== null) {
            fields.push('image_path = ?');
            values.push(finalImagePath || null);
        }
        
        values.push(id);
        
        await pool.execute(
            `UPDATE pending_promotions SET ${fields.join(', ')} WHERE id = ?`,
            values
        );

        return true;
    }

    /**
     * Mark promotion as approved
     */
    static async approve(id) {
        await pool.execute(
            `UPDATE pending_promotions 
            SET status = 'approved', processed_at = NOW() 
            WHERE id = ?`,
            [id]
        );
        return true;
    }

    /**
     * Mark promotion as rejected
     */
    static async reject(id) {
        await pool.execute(
            `UPDATE pending_promotions 
            SET status = 'rejected', processed_at = NOW() 
            WHERE id = ?`,
            [id]
        );
        return true;
    }

    /**
     * Delete a promotion
     */
    static async delete(id) {
        await pool.execute(
            `DELETE FROM pending_promotions WHERE id = ?`,
            [id]
        );
        return true;
    }

    /**
     * Get recent history (approved/rejected)
     */
    static async getHistory(limit = 20) {
        const [rows] = await pool.execute(
            `SELECT * FROM pending_promotions 
            WHERE status != 'pending' 
            ORDER BY processed_at DESC 
            LIMIT ?`,
            [limit]
        );
        return rows;
    }

    /**
     * Clean old processed promotions (older than 7 days)
     */
    static async cleanOld() {
        await pool.execute(
            `DELETE FROM pending_promotions 
            WHERE status != 'pending' 
            AND processed_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`
        );
    }
}

module.exports = PendingPromotions;
