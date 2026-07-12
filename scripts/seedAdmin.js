const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { sequelize, User } = require('../src/models/index');

async function seedAdmin() {
    try {
        await sequelize.authenticate();
        console.log('Database connected.');

        // Admin credentials
        const email = process.env.ADMIN_EMAIL || 'admin@cemac.com';
        const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('hex');
        const pseudo_anonyme = process.env.ADMIN_PSEUDO || 'SuperAdmin';

        const existingAdmin = await User.findOne({ where: { role: 'admin' } });

        if (existingAdmin) {
            console.log('Admin user already exists.');
        } else {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);

            await User.create({
                nom: 'Admin',
                prenom: 'System',
                email: email,
                telephone: '0000000000',
                pseudo_anonyme: pseudo_anonyme,
                password: hashedPassword,
                wallet_ref: 'ADMIN-WALLET',
                role: 'admin',
                is_verified: true
            });

            console.log(`Admin user created: ${email}`);
            if (!process.env.ADMIN_PASSWORD) {
                console.log(`Generated admin password: ${password}`);
                console.log('Set ADMIN_PASSWORD in .env before running this script in production.');
            }
        }
    } catch (err) {
        console.error('Error seeding admin', err);
    } finally {
        process.exit();
    }
}

seedAdmin();
