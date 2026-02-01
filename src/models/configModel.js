const { pool } = require('../config/db');

const Config = {
  async getGroupChatId() {
    try {
      // Try GROUP_CHAT_ID first (from settings panel), then fallback to group_chat_id (legacy)
      let [rows] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['GROUP_CHAT_ID']);
      if (rows.length > 0 && rows[0].value_text) {
        return rows[0].value_text;
      }
      // Fallback to lowercase version (legacy)
      [rows] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['group_chat_id']);
      return rows.length > 0 ? rows[0].value_text : null;
    } catch (err) {
      throw err;
    }
  },

  async setGroupChatId(chatId) {
    try {
      const existing = await this.getGroupChatId();
      if (existing) {
        await pool.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [String(chatId), 'group_chat_id']);
      } else {
        await pool.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', ['group_chat_id', String(chatId)]);
      }
      return true;
    } catch (err) {
      throw err;
    }
  },

  async getSendToGeneral() {
    try {
      const [rows] = await pool.execute('SELECT value_text FROM config WHERE key_name = ? LIMIT 1', ['SEND_TO_GENERAL']);
      if (rows.length > 0) {
        return rows[0].value_text === '1' || rows[0].value_text === 'true';
      }
      // Default: enabled
      return true;
    } catch (err) {
      throw err;
    }
  },

  async setSendToGeneral(enabled) {
    try {
      const value = enabled ? '1' : '0';
      const [existing] = await pool.execute('SELECT id FROM config WHERE key_name = ? LIMIT 1', ['SEND_TO_GENERAL']);
      if (existing.length > 0) {
        await pool.execute('UPDATE config SET value_text = ? WHERE key_name = ?', [value, 'SEND_TO_GENERAL']);
      } else {
        await pool.execute('INSERT INTO config (key_name, value_text) VALUES (?, ?)', ['SEND_TO_GENERAL', value]);
      }
      return true;
    } catch (err) {
      throw err;
    }
  }
};

module.exports = Config;
