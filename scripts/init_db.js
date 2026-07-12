const mysql = require('mysql2/promise');
require('dotenv').config();

async function initDB() {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            port: process.env.DB_PORT || 3306,
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || 'root'
        });

        console.log(`Création de la base de données ${process.env.DB_NAME}...`);
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\`;`);
        console.log('Base de données prête.');
        await connection.end();
    } catch (e) {
        console.error('Erreur lors de l’initialisation de la DB:', e);
    } finally {
        process.exit();
    }
}

initDB();
