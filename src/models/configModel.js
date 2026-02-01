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
  }
};

module.exports = Config;
