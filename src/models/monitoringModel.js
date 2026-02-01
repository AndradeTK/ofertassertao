const { pool } = require('../config/db');

const Monitoring = {
    async getAll() {
        try {
            const [rows] = await pool.execute('SELECT id, channel_id as chat_id, channel_name as name FROM monitoring');
            return rows;
        } catch (err) {
            throw err;
        }
    },

    async add(chat_id, name) {
        try {
            const [result] = await pool.execute('INSERT INTO monitoring (channel_id, channel_name, active) VALUES (?, ?, 1)', [String(chat_id), name || 'Canal']);
            return result.insertId;
        } catch (err) {
            throw err;
        }
    },

    async delete(id) {
        try {
            const [result] = await pool.execute('DELETE FROM monitoring WHERE id = ?', [id]);
            return result.affectedRows > 0;
        } catch (err) {
            throw err;
        }
    },

    async isMonitored(channelId) {
        try {
            const [rows] = await pool.execute('SELECT id FROM monitoring WHERE channel_id = ? AND active = 1 LIMIT 1', [String(channelId)]);
            return rows.length > 0;
        } catch (err) {
            throw err;
        }
    }
};

module.exports = Monitoring;