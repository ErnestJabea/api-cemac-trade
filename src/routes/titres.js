const { Titre } = require('../models/index');
const { authMiddleware } = require('../middlewares/authMiddleware');
const xlsx = require('xlsx-js-style');

const EDITABLE_TITRE_FIELDS = [
    'code_isin',
    'nature',
    'emetteur',
    'date_valeur',
    'date_echeance',
    'taux_facial',
    'quantite_titre',
    'prix_titres',
    'prix'
];

module.exports = async function (fastify, opts) {
    fastify.addHook('preHandler', authMiddleware);

    // List only current Asset Manager's titres
    fastify.get('/', async (request, reply) => {
        try {
            const titres = await Titre.findAll({
                where: { asset_manager_id: request.user.id }
            });
            return reply.send(titres);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Download Excel Template
    fastify.get('/template', async (request, reply) => {
        try {
            const templateData = [
                {
                    "Code émission": "CM0000000000",
                    "Code ISIN": "ISIN000000",
                    "Nature": "BTA",
                    "Emetteur": "Etat du Cameroun",
                    "Date Valeur": "01/01/2026",
                    "Date Echéance": "01/01/2027",
                    "Taux Facial": "5.5%",
                    "Quantité Titre": 1000,
                    "Volume Disponible": 10000000,
                    "Prix Titre": 10000
                }
            ];

            const worksheet = xlsx.utils.json_to_sheet(templateData);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Titres");

            const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

            reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            reply.header('Content-Disposition', 'attachment; filename="Modele_Import_Titres.xlsx"');
            return reply.send(buffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur lors de la génération du modèle' });
        }
    });

    // Import Excel file (Admin usually, but open for demo or check role)
    fastify.post('/import', async (request, reply) => {
        try {
            const data = await request.file();
            if (!data) {
                return reply.code(400).send({ error: 'No file uploaded' });
            }

            const buffer = await data.toBuffer();
            const workbook = xlsx.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(sheet);

            // Helper to parse dates like DD/MM/YYYY
            const parseDate = (d) => {
                if (!d) return null;
                if (typeof d === 'number') {
                    // Excel serial date format (days from 1900)
                    const date = new Date(Math.round((d - 25569) * 86400 * 1000));
                    return date.toISOString().split('T')[0];
                }
                if (typeof d === 'string' && d.includes('/')) {
                    const parts = d.split('/');
                    if (parts.length === 3) {
                        return `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
                    }
                }
                return null;
            };

            let count = 0;
            let skippedUnauthorized = 0;
            for (let rawRow of rows) {
                // Normalize keys (lowercase, remove accents, trim spaces)
                const row = {};
                for (let key in rawRow) {
                    const normalizedKey = key.toLowerCase()
                        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                        .trim();
                    row[normalizedKey] = rawRow[key];
                }

                const code_emission = row['code emission'] || Object.values(rawRow)[0];
                if (!code_emission) continue;

                // Strip spaces
                const cleanCode = String(code_emission).trim();

                const dateEcheance = parseDate(row['date echeance']);

                // Only import if maturity date is in the future
                if (dateEcheance) {
                    const expDate = new Date(dateEcheance);
                    const now = new Date();
                    // Reset time to midnight for accurate day comparison
                    now.setHours(0, 0, 0, 0);

                    if (expDate <= now) {
                        continue; // Skip expired titles
                    }
                }

                let quantite = parseInt(String(row['quantite titre'] || row['quantite'] || '0').replace(/\s/g, ''), 10);
                if (isNaN(quantite)) quantite = 0;

                let prix = parseFloat(String(row['prix titre'] || row['prix titres'] || row['prix'] || '0').replace(/\s/g, '').replace(',', '.'));
                if (isNaN(prix)) prix = 0;

                let tauxBrut = String(row['taux facial'] || '').replace(/\s/g, '');
                let tauxFormat = tauxBrut;
                // Si c'est un nombre genre 0.065 ou 6.5 sans le symbole %
                if (tauxBrut && !tauxBrut.includes('%')) {
                    let num = parseFloat(tauxBrut.replace(',', '.'));
                    if (!isNaN(num)) {
                        if (num < 1 && num > 0) {
                            // ex: 0.0625 -> 6,25%
                            tauxFormat = (num * 100).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 4 }) + '%';
                        } else {
                            // ex: 6.25 -> 6,25%
                            tauxFormat = num.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 4 }) + '%';
                        }
                    }
                } else if (tauxBrut && tauxBrut.includes('%')) {
                    // S'il a déjà un %, on standardise la virgule
                    tauxFormat = tauxBrut.replace('.', ',');
                }

                const titrePayload = {
                    code_emission: cleanCode,
                    code_isin: String(row['code isin'] || ''),
                    nature: String(row['nature'] || ''),
                    emetteur: String(row['emetteur'] || ''),
                    date_valeur: parseDate(row['date valeur']),
                    date_echeance: dateEcheance,
                    taux_facial: tauxFormat,
                    quantite_titre: quantite,
                    prix_titres: prix,
                    volume_disponible: quantite * prix,
                    prix: String(row['prix'] || ''),
                    asset_manager_id: request.user.id
                };

                const existingTitre = await Titre.findByPk(cleanCode);
                if (existingTitre && String(existingTitre.asset_manager_id) !== String(request.user.id)) {
                    skippedUnauthorized++;
                    continue;
                }

                if (existingTitre) {
                    await existingTitre.update(titrePayload);
                } else {
                    await Titre.create(titrePayload);
                }

                count++;
            }

            return reply.send({ message: 'Import successful', total_imported: count, skipped_unauthorized: skippedUnauthorized });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to import file: ' + error.message });
        }
    });

    // Update specific titre
    fastify.put('/update', async (request, reply) => {
        try {
            console.log("UPDATE PUT CALLED:", request.body.code_emission);
            const titre = await Titre.findOne({
                where: { code_emission: request.body.code_emission, asset_manager_id: request.user.id }
            });

            if (!titre) {
                console.log("NOT FOUND FOR UPDATE:", request.body.code_emission);
                return reply.code(404).send({ error: 'Titre non trouvé ou non autorisé' });
            }

            const quantite = request.body.quantite_titre !== undefined ? Number(request.body.quantite_titre) : titre.quantite_titre;
            const prix = request.body.prix_titres !== undefined ? Number(request.body.prix_titres) : titre.prix_titres;

            if (!Number.isFinite(quantite) || quantite < 0) {
                return reply.code(400).send({ error: 'Quantité invalide' });
            }

            if (!Number.isFinite(prix) || prix < 0) {
                return reply.code(400).send({ error: 'Prix invalide' });
            }

            const safeUpdate = {};
            for (const field of EDITABLE_TITRE_FIELDS) {
                if (request.body[field] !== undefined) {
                    safeUpdate[field] = request.body[field];
                }
            }

            safeUpdate.quantite_titre = quantite;
            safeUpdate.prix_titres = prix;
            safeUpdate.volume_disponible = quantite * prix;

            await titre.update(safeUpdate);
            return reply.send(titre);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Delete specific titre
    fastify.delete('/remove', async (request, reply) => {
        try {
            const code = request.query.code;
            console.log("DELETE CALLED FOR CODE:", code);
            const titre = await Titre.findOne({
                where: { code_emission: code, asset_manager_id: request.user.id }
            });

            if (!titre) {
                console.log("NOT FOUND FOR DELETE:", code);
                return reply.code(404).send({ error: 'Titre non trouvé ou non autorisé' });
            }

            // This will automatically delete connected trades because of onDelete: 'CASCADE' in Sequelize
            await titre.destroy();
            return reply.send({ message: 'Titre et annonces associées supprimés avec succès' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });
};
