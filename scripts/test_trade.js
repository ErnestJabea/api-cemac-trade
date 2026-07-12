const { sequelize, User, Titre, Trade } = require('../src/models/index');

async function testTradeBug() {
    try {
        await sequelize.authenticate();
        console.log('Database connected.');

        // 1. Create User
        const user = await User.create({
            nom: 'Test',
            prenom: 'User',
            email: `test_${Date.now()}@test.com`,
            telephone: '123456789',
            pseudo_anonyme: `pseudo_${Date.now()}`,
            password: 'password123',
            role: 'asset_manager'
        });
        console.log('User created:', user.id);

        // 2. Create Titre
        const titre = await Titre.create({
            code_emission: `TEST_TITRE_${Date.now()}`,
            nature: 'OCA',
            emetteur: 'TEST_CORP',
            quantite_titre: 100,
            prix_titres: 10000,
            volume_disponible: 100 * 10000,
            asset_manager_id: user.id
        });
        console.log('Titre created with quantity:', titre.quantite_titre);

        // 3. Create Trade (Publié)
        const trade = await Trade.create({
            titre_id: titre.code_emission,
            type: 'Vente',
            quantite: 10,
            prix_pourcentage: 100,
            montant: 10 * 10000,
            statut: 'Publié',
            author_id: user.id
        });
        console.log('Trade created with quantity:', trade.quantite);

        // 4. Update status to 'Vendu' (Simulate updating from 10 to 4)
        const finalQuantite = 4;
        const statut = 'Vendu';

        // Re-fetching like in the controller
        const tradeToUpdate = await Trade.findOne({
            where: { id: trade.id, author_id: user.id },
            include: [{ model: Titre, as: 'titre' }]
        });

        if (statut === 'Vendu' && tradeToUpdate.statut !== 'Vendu' && tradeToUpdate.type === 'Vente') {
            console.log('Entering Vendu logic...');
            // if quantity changed at sale time
            if (finalQuantite !== undefined && finalQuantite !== tradeToUpdate.quantite) {
                console.log('Quantity changed from', tradeToUpdate.quantite, 'to', finalQuantite);
                const diff = finalQuantite - tradeToUpdate.quantite;
                const fetchedTitre = tradeToUpdate.titre;
                
                if (tradeToUpdate.statut === 'En cours de négociation') {
                    fetchedTitre.quantite_titre -= diff;
                } else {
                    fetchedTitre.quantite_titre -= finalQuantite;
                }
                
                fetchedTitre.volume_disponible = fetchedTitre.quantite_titre * Number(fetchedTitre.prix_titres || 0);
                await fetchedTitre.save();
                tradeToUpdate.quantite = finalQuantite;
                console.log('Titre quantity after save (in JS memory):', fetchedTitre.quantite_titre);
            }
            
            tradeToUpdate.statut = statut;
            await tradeToUpdate.save();
        }

        // 5. Check true Titre quantity in DB
        const titreAfter = await Titre.findOne({ where: { code_emission: titre.code_emission }});
        console.log('TITRE QUANTITY IN DB AFTER UPDATE:', titreAfter.quantite_titre);

        // CLEANUP
        await trade.destroy();
        await titre.destroy();
        await user.destroy();
        
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}

testTradeBug();
