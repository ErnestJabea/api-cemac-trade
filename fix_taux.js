const { Titre } = require('./src/models/index');
const sequelize = require('./src/models/index').sequelize;

async function fixTaux() {
    try {
        await sequelize.authenticate();
        const titres = await Titre.findAll();
        let updated = 0;
        for (let titre of titres) {
            let tauxBrut = String(titre.taux_facial || '').replace(/\s/g, '');
            let tauxFormat = tauxBrut;
            if (tauxBrut && !tauxBrut.includes('%')) {
                let num = parseFloat(tauxBrut.replace(',', '.'));
                if (!isNaN(num)) {
                    if (num < 1 && num > 0) {
                        tauxFormat = (num * 100).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + '%';
                    } else {
                        tauxFormat = num.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + '%';
                    }
                }
            } else if (tauxBrut && tauxBrut.includes('%')) {
                tauxFormat = tauxBrut.replace('.', ',');
            }
            if (tauxFormat !== titre.taux_facial) {
                titre.taux_facial = tauxFormat;
                await titre.save();
                updated++;
            }
        }
        console.log(`Updated ${updated} titres.`);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}
fixTaux();
