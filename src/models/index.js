const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
    process.env.DB_NAME || 'cemac_trade',
    process.env.DB_USER || 'root',
    process.env.DB_PASS || 'root',
    {
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 3306,
        dialect: 'mysql',
        logging: false,
    }
);

const User = sequelize.define('User', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    nom: { type: DataTypes.STRING, allowNull: false },
    prenom: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    telephone: { type: DataTypes.STRING, allowNull: false },
    pseudo_anonyme: { type: DataTypes.STRING, allowNull: false, unique: true },
    password: { type: DataTypes.STRING, allowNull: false },
    wallet_ref: { type: DataTypes.STRING, allowNull: true },
    role: {
        type: DataTypes.ENUM('asset_manager', 'admin', 'moderator'),
        defaultValue: 'asset_manager'
    },
    is_verified: { type: DataTypes.BOOLEAN, defaultValue: false },
    verification_token: { type: DataTypes.STRING, allowNull: true },
    mfa_enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    mfa_secret: { type: DataTypes.STRING, allowNull: true },
    mfa_enabled_at: { type: DataTypes.DATE, allowNull: true },
    password_changed_at: { type: DataTypes.DATE, allowNull: true },
    password_reset_token: { type: DataTypes.STRING, allowNull: true },
    password_reset_expires_at: { type: DataTypes.DATE, allowNull: true }
}, {
    timestamps: true
});

const Titre = sequelize.define('Titre', {
    code_emission: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    code_isin: { type: DataTypes.STRING },
    nature: { type: DataTypes.STRING },
    emetteur: { type: DataTypes.STRING },
    date_valeur: { type: DataTypes.DATEONLY },
    date_echeance: { type: DataTypes.DATEONLY },
    taux_facial: { type: DataTypes.STRING },
    quantite_titre: { type: DataTypes.INTEGER },
    prix_titres: { type: DataTypes.DECIMAL(20, 2) },
    volume_disponible: { type: DataTypes.DECIMAL(20, 2) },
    prix: { type: DataTypes.STRING },
    asset_manager_id: { type: DataTypes.UUID, allowNull: false } // Linked to User

}, {
    timestamps: true
});

const Trade = sequelize.define('Trade', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    titre_id: { type: DataTypes.STRING, allowNull: false }, // References code_emission
    type: { type: DataTypes.ENUM('Achat', 'Vente'), allowNull: false },
    quantite: { type: DataTypes.INTEGER, allowNull: true },
    prix_pourcentage: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    montant: { type: DataTypes.DECIMAL(20, 2), allowNull: false },
    statut: { type: DataTypes.ENUM('Brouillon', 'Publié', 'Désactivé', 'Vendu', 'Acheté', 'Archivé', 'En cours de négociation'), defaultValue: 'Brouillon' },
    buyer_id: { type: DataTypes.UUID, allowNull: true } // Identifiant de l'acheteur
}, {
    timestamps: true
});

const Message = sequelize.define('Message', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    room_id: { type: DataTypes.STRING, allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    is_read: { type: DataTypes.BOOLEAN, defaultValue: false }
}, {
    timestamps: true
});

const Notification = sequelize.define('Notification', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    user_id: { type: DataTypes.UUID, allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: true },
    is_read: { type: DataTypes.BOOLEAN, defaultValue: false }
}, {
    timestamps: true
});

const PushSubscription = sequelize.define('PushSubscription', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    user_id: { type: DataTypes.UUID, allowNull: false },
    endpoint: { type: DataTypes.TEXT, allowNull: false },
    p256dh: { type: DataTypes.TEXT, allowNull: false },
    auth: { type: DataTypes.STRING, allowNull: false },
    user_agent: { type: DataTypes.STRING, allowNull: true }
}, {
    timestamps: true
});

// Relationships
User.hasMany(Trade, { foreignKey: 'author_id' });
Trade.belongsTo(User, { as: 'author', foreignKey: 'author_id' });

Titre.hasMany(Trade, { foreignKey: 'titre_id', onDelete: 'CASCADE', onUpdate: 'CASCADE' });
Trade.belongsTo(Titre, { as: 'titre', foreignKey: 'titre_id' });

User.hasMany(Message, { foreignKey: 'sender_id' });
Message.belongsTo(User, { as: 'sender', foreignKey: 'sender_id' });

User.hasMany(Titre, { foreignKey: 'asset_manager_id' });
Titre.belongsTo(User, { as: 'asset_manager', foreignKey: 'asset_manager_id' });

User.hasMany(Trade, { foreignKey: 'buyer_id' });
Trade.belongsTo(User, { as: 'buyer', foreignKey: 'buyer_id' });

User.hasMany(Notification, { foreignKey: 'user_id' });
Notification.belongsTo(User, { as: 'user', foreignKey: 'user_id' });

User.hasMany(PushSubscription, { foreignKey: 'user_id' });
PushSubscription.belongsTo(User, { as: 'user', foreignKey: 'user_id' });

module.exports = { sequelize, User, Titre, Trade, Message, Notification, PushSubscription };
