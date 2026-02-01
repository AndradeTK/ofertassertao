const { pool } = require('../config/db');

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
            const [rows] = await pool.execute('SELECT thread_id FROM categories WHERE name_ia = ? LIMIT 1', [name]);
            return rows.length > 0 ? rows[0].thread_id : null;
        } catch (err) {
            throw err;
        }
    }
};

module.exports = Category;