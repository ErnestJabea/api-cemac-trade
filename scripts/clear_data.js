const { Trade, Titre, Message, Notification, sequelize } = require('../src/models/index');

async function clearData() {
    try {
        await sequelize.authenticate();
        console.log('Connexion à la base de données réussie.');

        const countM = await Message.count();
        const countN = await Notification.count();
        const countT = await Trade.count();
        const countTitres = await Titre.count();

        console.log(`Suppression de ${countM} messages...`);
        await Message.destroy({ where: {} });

        console.log(`Suppression de ${countN} notifications...`);
        await Notification.destroy({ where: {} });

        console.log(`Suppression de ${countT} annonces (tout statut confondu)...`);
        await Trade.destroy({ where: {} });

        console.log(`Suppression de ${countTitres} titres...`);
        await Titre.destroy({ where: {} });

        console.log('Nettoyage complet terminé avec succès !');
    } catch (error) {
        console.error('Erreur lors du nettoyage :', error);
    } finally {
        await sequelize.close();
        process.exit();
    }
}

clearData();
