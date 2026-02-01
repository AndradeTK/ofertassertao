const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ofertas',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function testConnection() {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.ping();
        conn.release();
        return true;
    } catch (err) {
        if (conn) conn.release();
        throw err;
    }
}

module.exports = {
    pool,
    testConnection
};