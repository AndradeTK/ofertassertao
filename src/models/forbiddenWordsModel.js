const { pool } = require('../config/db');

const ForbiddenWords = {
    /**
     * Get all forbidden words from database
     */
    async getAll() {
        try {
            const [rows] = await pool.execute('SELECT word FROM forbidden_words');
            return rows.map(row => row.word.toLowerCase());
        } catch (err) {
            console.error('Error fetching forbidden words:', err);
            return [];
        }
    },

    /**
     * Check if text contains any forbidden words
     */
    async containsForbiddenWords(text) {
        if (!text) return { hasForbidden: false, words: [] };

        const forbiddenWords = await this.getAll();
        if (forbiddenWords.length === 0) return { hasForbidden: false, words: [] };

        const lowerText = text.toLowerCase();
        const foundWords = forbiddenWords.filter(word => lowerText.includes(word));

        return {
            hasForbidden: foundWords.length > 0,
            words: foundWords
        };
    },

    /**
     * Add a new forbidden word
     */
    async add(word) {
        try {
            await pool.execute(
                'INSERT INTO forbidden_words (word) VALUES (?) ON DUPLICATE KEY UPDATE word = word',
                [word.toLowerCase()]
            );
            return true;
        } catch (err) {
            throw err;
        }
    },

    /**
     * Remove a forbidden word
     */
    async remove(id) {
        try {
            const [result] = await pool.execute('DELETE FROM forbidden_words WHERE id = ?', [id]);
            return result.affectedRows > 0;
        } catch (err) {
            throw err;
        }
    },

    /**
     * Get all with IDs (for display)
     */
    async getAllWithIds() {
        try {
            const [rows] = await pool.execute('SELECT id, word, created_at FROM forbidden_words ORDER BY word ASC');
            return rows;
        } catch (err) {
            throw err;
        }
    }
};

module.exports = ForbiddenWords;
