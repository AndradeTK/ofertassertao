const { pool } = require('../config/db');

const Monitoring = {
    async getAll() {
        try {
            const [rows] = await pool.execute('SELECT id, channel_id as chat_id, channel_name as name FROM monitoring WHERE active = 1');
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

    /**
     * Check if a channel is being monitored
     * Tries multiple ID formats for flexibility
     */
    async isMonitored(channelId) {
        try {
            const id = String(channelId);
            
            // Normalize the ID - extract just the numeric part
            const numericId = id.replace(/^-100/, '').replace(/^-/, '');
            
            // Check exact match first
            const [rows] = await pool.execute(
                'SELECT id FROM monitoring WHERE active = 1 AND (channel_id = ? OR channel_id = ? OR channel_id = ? OR channel_id = ?) LIMIT 1', 
                [id, `-${numericId}`, `-100${numericId}`, numericId]
            );
            
            return rows.length > 0;
        } catch (err) {
            console.error('[Monitoring] Error checking isMonitored:', err.message);
            throw err;
        }
    },
    
    /**
     * Get all monitored IDs in all possible formats for quick lookup
     */
    async getAllMonitoredIds() {
        try {
            const [rows] = await pool.execute('SELECT channel_id FROM monitoring WHERE active = 1');
            
            const allFormats = new Set();
            for (const row of rows) {
                const id = String(row.channel_id);
                const numericId = id.replace(/^-100/, '').replace(/^-/, '');
                
                // Add all possible formats
                allFormats.add(id);
                allFormats.add(numericId);
                allFormats.add(`-${numericId}`);
                allFormats.add(`-100${numericId}`);
            }
            
            return allFormats;
        } catch (err) {
            throw err;
        }
    }
};

module.exports = Monitoring;