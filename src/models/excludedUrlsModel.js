const { pool } = require('../config/db');

/**
 * Model for managing excluded URL patterns
 * These patterns are filtered out from promotions
 */
const ExcludedUrls = {
    /**
     * Get all excluded URL patterns
     */
    async getAll() {
        const [rows] = await pool.execute(
            'SELECT * FROM excluded_urls ORDER BY created_at DESC'
        );
        return rows;
    },

    /**
     * Get all patterns as regex strings (for filtering)
     */
    async getPatterns() {
        const [rows] = await pool.execute(
            'SELECT pattern FROM excluded_urls WHERE active = 1'
        );
        return rows.map(r => r.pattern);
    },

    /**
     * Add a new excluded URL pattern
     */
    async add(pattern, description = '') {
        const [result] = await pool.execute(
            'INSERT INTO excluded_urls (pattern, description) VALUES (?, ?)',
            [pattern, description]
        );
        return result.insertId;
    },

    /**
     * Update an excluded URL pattern
     */
    async update(id, pattern, description, active) {
        await pool.execute(
            'UPDATE excluded_urls SET pattern = ?, description = ?, active = ? WHERE id = ?',
            [pattern, description, active ? 1 : 0, id]
        );
    },

    /**
     * Toggle active status
     */
    async toggleActive(id) {
        await pool.execute(
            'UPDATE excluded_urls SET active = NOT active WHERE id = ?',
            [id]
        );
    },

    /**
     * Delete an excluded URL pattern
     */
    async delete(id) {
        await pool.execute('DELETE FROM excluded_urls WHERE id = ?', [id]);
    },

    /**
     * Check if a URL matches any excluded pattern
     */
    async isExcluded(url) {
        const patterns = await this.getPatterns();
        const urlLower = url.toLowerCase();
        
        for (const pattern of patterns) {
            try {
                const regex = new RegExp(pattern, 'i');
                if (regex.test(urlLower)) {
                    return true;
                }
            } catch (e) {
                // If pattern is not valid regex, try simple includes
                if (urlLower.includes(pattern.toLowerCase())) {
                    return true;
                }
            }
        }
        return false;
    }
};

module.exports = ExcludedUrls;
