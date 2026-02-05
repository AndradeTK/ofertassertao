const { pool } = require('../config/db');

/**
 * Normalize text by removing accents and converting to lowercase
 * This allows matching "Placa Mae" with "Placa Mãe", "Eletrônicos" with "Eletronicos", etc.
 */
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove diacritics (accents)
        .replace(/[^\w\s]/g, '') // Remove special characters except spaces
        .trim();
}

const Category = {
    async getAll() {
        try {
            const [rows] = await pool.execute('SELECT id, name_ia, thread_id FROM categories ORDER BY name_ia ASC');
            return rows;
        } catch (err) {
            throw err;
        }
    },

    async create(name_ia, thread_id) {
        try {
            const [result] = await pool.execute('INSERT INTO categories (name_ia, thread_id) VALUES (?, ?)', [name_ia, thread_id]);
            return result.insertId;
        } catch (err) {
            throw err;
        }
    },

    async delete(id) {
        try {
            const [result] = await pool.execute('DELETE FROM categories WHERE id = ?', [id]);
            return result.affectedRows > 0;
        } catch (err) {
            throw err;
        }
    },

    async getThreadIdByName(name) {
        try {
            // First try exact match
            const [exactRows] = await pool.execute('SELECT thread_id FROM categories WHERE name_ia = ? LIMIT 1', [name]);
            if (exactRows.length > 0) {
                return exactRows[0].thread_id;
            }
            
            // If no exact match, try normalized match (ignoring accents and case)
            const normalizedName = normalizeText(name);
            const [allRows] = await pool.execute('SELECT name_ia, thread_id FROM categories');
            
            for (const row of allRows) {
                const normalizedCategory = normalizeText(row.name_ia);
                if (normalizedCategory === normalizedName) {
                    console.log(`[Category] Matched "${name}" with "${row.name_ia}" (normalized: "${normalizedName}")`);
                    return row.thread_id;
                }
            }
            
            // Try partial match (if the category name contains the search term or vice versa)
            for (const row of allRows) {
                const normalizedCategory = normalizeText(row.name_ia);
                if (normalizedCategory.includes(normalizedName) || normalizedName.includes(normalizedCategory)) {
                    console.log(`[Category] Partial match "${name}" with "${row.name_ia}"`);
                    return row.thread_id;
                }
            }
            
            // Last resort: try to find "Outros" or "Variados" category as fallback
            const fallbackCategories = ['outros', 'geral', 'other'];
            for (const row of allRows) {
                const normalizedCategory = normalizeText(row.name_ia);
                if (fallbackCategories.includes(normalizedCategory)) {
                    console.log(`[Category] No match for "${name}", using fallback category "${row.name_ia}"`);
                    return row.thread_id;
                }
            }
            
            console.log(`[Category] No category found for "${name}", returning null (will use General)`);
            return null;
        } catch (err) {
            throw err;
        }
    }
};

module.exports = Category;