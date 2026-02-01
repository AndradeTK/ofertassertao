const { pool } = require('../config/db');

const Settings = {
    /**
     * Get all settings as a key-value object
     */
    async getAll() {
        try {
            const [rows] = await pool.execute('SELECT key_name, value_text FROM config');
            const settings = {};
            rows.forEach(row => {
                settings[row.key_name] = row.value_text;
            });
            return settings;
        } catch (err) {
            console.error('Error fetching settings:', err);
            return {};
        }
    },

    /**
     * Get a specific setting value
     */
    async get(key, defaultValue = null) {
        try {
            const [rows] = await pool.execute('SELECT value_text FROM config WHERE key_name = ?', [key]);
            if (rows.length > 0) return rows[0].value_text;
            return defaultValue;
        } catch (err) {
            console.error(`Error fetching setting ${key}:`, err);
            return defaultValue;
        }
    },

    /**
     * Set a setting value (insert or update)
     */
    async set(key, value) {
        try {
            // Check if key exists
            const [rows] = await pool.execute('SELECT id FROM config WHERE key_name = ?', [key]);
            
            if (rows.length > 0) {
                await pool.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [value, key]);
            } else {
                await pool.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', [key, value]);
            }
            return true;
        } catch (err) {
            console.error(`Error setting ${key}:`, err);
            throw err;
        }
    },

    /**
     * Bulk update settings
     * @param {Object} settingsObj - { key: value, key2: value2 }
     */
    async updateBulk(settingsObj) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            
            for (const [key, value] of Object.entries(settingsObj)) {
                // Check if key exists
                const [rows] = await connection.execute('SELECT id FROM config WHERE key_name = ?', [key]);
                
                if (rows.length > 0) {
                    await connection.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [value, key]);
                } else {
                    await connection.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', [key, value]);
                }
            }
            
            await connection.commit();
            return true;
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    }
};

module.exports = Settings;
