const { Trade, User, Titre, Message, Notification } = require('../models/index');
const { authMiddleware, adminMiddleware } = require('../middlewares/authMiddleware');
const { sendMail } = require('../utils/mailer');
const { Op } = require('sequelize');
const { canonicalRoomId, parseRoomId } = require('../utils/conversations');
const { createNotificationsForUsers } = require('../services/notificationService');

const VALID_TRADE_STATUSES = new Set(['Brouillon', 'Publié', 'Désactivé', 'Vendu', 'Acheté', 'Archivé', 'En cours de négociation']);
const VALID_TRADE_TYPES = new Set(['Achat', 'Vente']);

const toPositiveInteger = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toValidPercentage = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 200 ? parsed : null;
};

const normalizeStatus = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const isNegotiableStatus = (status) => {
    const normalized = normalizeStatus(status);
    const rawStatus = String(status || '');
    return normalized === 'publie'
        || normalized === 'en cours de negociation'
        || rawStatus === 'PubliÃ©'
        || rawStatus === 'En cours de nÃ©gociation';
};

const formatNumber = (value) => Number(value || 0).toLocaleString('fr-FR');
const formatXaf = (value) => `${formatNumber(value)} XAF`;

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const buildTradeEmailDetails = (trade) => {
    const title = trade?.titre_id || 'Titre non precise';
    const quantity = formatNumber(trade?.quantite);
    const price = trade?.prix_pourcentage !== undefined && trade?.prix_pourcentage !== null
        ? `${Number(trade.prix_pourcentage).toLocaleString('fr-FR')}%`
        : 'Non precise';
    const amount = formatXaf(trade?.montant);
    const titre = trade?.titre;
    const instrument = titre
        ? `${titre.nature || 'Titre'} | ${titre.emetteur || 'Emetteur non precise'} | ${titre.taux_facial || 'Taux non precise'}`
        : '';

    return { title, quantity, price, amount, instrument };
};

const buildTradeDetailsHtml = (details) => `
    <ul>
        <li><strong>Titre :</strong> ${escapeHtml(details.title)}</li>
        <li><strong>Quantite :</strong> ${escapeHtml(details.quantity)}</li>
        <li><strong>Prix :</strong> ${escapeHtml(details.price)}</li>
        <li><strong>Volume nominal :</strong> ${escapeHtml(details.amount)}</li>
        ${details.instrument ? `<li><strong>Sous-jacent :</strong> ${escapeHtml(details.instrument)}</li>` : ''}
    </ul>
`;

module.exports = async function (fastify, opts) {
    // List all PUBLIC trades (Visible to everyone) - No auth required
    fastify.get('/', async (request, reply) => {
        try {
            const trades = await Trade.findAll({
                where: { statut: 'Publié' },
                include: [
                    {
                        model: User,
                        as: 'author',
                        attributes: ['pseudo_anonyme', 'role', 'id']
                    },
                    {
                        model: Titre,
                        as: 'titre'
                    }
                ],
                order: [['createdAt', 'DESC']]
            });

            return reply.send(trades);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Create new trade (Asset Manager)
    fastify.post('/', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const { titre_id, type, quantite, prix_pourcentage } = request.body;
            const quantity = toPositiveInteger(quantite);
            const pricePercent = toValidPercentage(prix_pourcentage);

            if (!VALID_TRADE_TYPES.has(type)) {
                return reply.code(400).send({ error: 'Type d’annonce invalide' });
            }

            if (!quantity) {
                return reply.code(400).send({ error: 'La quantité doit être un entier positif' });
            }

            if (!pricePercent) {
                return reply.code(400).send({ error: 'Le prix cible doit être un pourcentage positif valide' });
            }

            const titre = await Titre.findOne({ where: { code_emission: titre_id, asset_manager_id: request.user.id } });

            if (!titre) {
                return reply.code(404).send({ error: 'Titre non trouvé ou non autorisé' });
            }

            if (type === 'Vente' && quantity > Number(titre.quantite_titre || 0)) {
                return reply.code(400).send({ error: `La quantité à vendre (${quantity}) ne peut pas être supérieure à la quantité disponible (${titre.quantite_titre}).` });
            }

            const prixNominal = Number(titre.prix_titres || 0);
            const montantCalc = Number((quantity * prixNominal).toFixed(2));

            console.log(`[TRADE CREATE] Titre: ${titre_id} | Qté: ${quantity} | Prix Nom: ${prixNominal} | Montant Calc: ${montantCalc}`);

            const newTrade = await Trade.create({
                titre_id,
                type,
                quantite: quantity,
                prix_pourcentage: pricePercent,
                montant: montantCalc,
                statut: 'Brouillon', // Starts as draft for Asset Manager
                author_id: request.user.id
            });

            return reply.code(201).send(newTrade);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Asset Manager: List MY trades (Created by me OR Bought by me)
    fastify.get('/me', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const trades = await Trade.findAll({
                where: {
                    [Op.or]: [
                        { author_id: request.user.id },
                        { buyer_id: request.user.id }
                    ]
                },
                include: [
                    { model: Titre, as: 'titre' },
                    { model: User, as: 'author', attributes: ['pseudo_anonyme', 'email', 'id'] },
                    { model: User, as: 'buyer', attributes: ['pseudo_anonyme', 'email', 'id'] }
                ],
                order: [['updatedAt', 'DESC']]
            });
            
            // Format to match old output if needed
            const formatted = trades.map(t => ({
                id: t.id,
                titre_id: t.titre_id,
                titre: t.titre,
                type: t.type,
                quantite: t.quantite,
                prix_pourcentage: t.prix_pourcentage,
                montant: t.montant,
                statut: t.statut,
                author_id: {
                    id: t.author?.id,
                    public_identity: { pseudo_anonyme: t.author?.pseudo_anonyme, email: t.author?.email }
                },
                buyer_id: t.buyer ? {
                    id: t.buyer.id,
                    pseudo_anonyme: t.buyer.pseudo_anonyme,
                    email: t.buyer.email
                } : null,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt
            }));

            return reply.send(formatted);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Buyer: signal interest in a public offer before opening a negotiation room.
    fastify.post('/:id/interest', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const trade = await Trade.findByPk(request.params.id, {
                include: [
                    { model: User, as: 'author', attributes: ['id', 'pseudo_anonyme', 'email'] },
                    { model: Titre, as: 'titre' }
                ]
            });

            if (!trade) {
                return reply.code(404).send({ error: 'Annonce introuvable' });
            }

            if (!isNegotiableStatus(trade.statut)) {
                return reply.code(400).send({ error: 'Cette annonce ne peut pas recevoir de nouvel interet' });
            }

            const buyer = await User.findByPk(request.user.id, {
                attributes: ['id', 'pseudo_anonyme', 'email']
            });
            if (!buyer) return reply.code(404).send({ error: 'Utilisateur introuvable' });

            if (String(trade.author_id) === String(buyer.id)) {
                return reply.code(400).send({ error: 'Vous ne pouvez pas manifester un interet sur votre propre annonce' });
            }

            const roomId = canonicalRoomId(trade.id, buyer.id, trade.author_id);
            const existingConversation = await Message.count({
                where: {
                    sender_id: buyer.id,
                    [Op.or]: [
                        { room_id: roomId },
                        { room_id: { [Op.like]: `${trade.id}_%` } },
                        { room_id: { [Op.like]: `trade_${trade.id}_%` } }
                    ]
                }
            });

            const details = buildTradeEmailDetails(trade);
            const notificationMessage = `${buyer.pseudo_anonyme} manifeste un interet pour ${details.title} - Qte ${details.quantity} a ${details.price}.`;
            const existingInterest = await Notification.count({
                where: {
                    user_id: trade.author_id,
                    type: 'Interet Offre',
                    message: notificationMessage
                }
            });

            if (existingConversation > 0 || existingInterest > 0) {
                return reply.send({ success: true, notified: false, room_id: roomId });
            }

            const notifications = await createNotificationsForUsers({
                userIds: [trade.author_id],
                message: notificationMessage,
                type: 'Interet Offre',
                pushTitle: 'Nouvel interet',
                pushBody: notificationMessage,
                pushTag: `trade-${trade.id}-interest-${buyer.id}`,
                url: `/chat/${encodeURIComponent(roomId)}`,
                logger: fastify.log
            });

            notifications.forEach((notification) => {
                fastify.io?.to(`user:${notification.user_id}`).emit('notification_created', notification.toJSON());
            });

            const detailsHtml = buildTradeDetailsHtml(details);
            const sellerHtml = `
                <h2>Nouvel interet sur votre offre</h2>
                <p>Bonjour ${escapeHtml(trade.author?.pseudo_anonyme || 'Asset Manager')},</p>
                <p>${escapeHtml(buyer.pseudo_anonyme)} souhaite negocier votre annonce.</p>
                ${detailsHtml}
                <p>Connectez-vous a CEMAC Trade pour poursuivre la discussion.</p>
            `;
            const buyerHtml = `
                <h2>Demande de negociation enregistree</h2>
                <p>Bonjour ${escapeHtml(buyer.pseudo_anonyme)},</p>
                <p>Votre interet a ete transmis au vendeur.</p>
                ${detailsHtml}
                <p>Vous pouvez poursuivre l'echange depuis le chat securise.</p>
            `;

            Promise.all([
                sendMail(trade.author.email, 'CEMAC Trade - Nouvel interet sur votre offre', sellerHtml)
                    .catch((mailError) => fastify.log.error(mailError)),
                sendMail(buyer.email, 'CEMAC Trade - Demande de negociation enregistree', buyerHtml)
                    .catch((mailError) => fastify.log.error(mailError))
            ]).catch((mailError) => fastify.log.error(mailError));

            return reply.code(201).send({ success: true, notified: true, room_id: roomId });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Get single trade details
    fastify.get('/:id', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            console.log(`[TRADE GET] Fetching trade ID: ${request.params.id} for user: ${request.user.id}`);
            const trade = await Trade.findByPk(request.params.id, {
                include: [
                    { model: User, as: 'author', attributes: ['pseudo_anonyme', 'role', 'id'] },
                    { model: User, as: 'buyer', attributes: ['pseudo_anonyme', 'role', 'id'] },
                    { model: Titre, as: 'titre' }
                ]
            });

            if (!trade) {
                console.warn(`[TRADE GET] Trade NOT FOUND: ${request.params.id}`);
                return reply.code(404).send({ error: 'Trade non trouvé' });
            }

            const isAdmin = request.user.role === 'admin';
            const isAuthor = String(trade.author_id) === String(request.user.id);
            const isBuyer = trade.buyer_id && String(trade.buyer_id) === String(request.user.id);
            const isPublic = trade.statut === 'Publié';

            if (!isAdmin && !isAuthor && !isBuyer && !isPublic) {
                return reply.code(403).send({ error: 'Accès refusé à cette annonce' });
            }

            console.log(`[TRADE GET] Found trade: ${trade.titre_id} (Statut: ${trade.statut})`);
            return reply.send(trade);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Asset Manager: Update their Trade Status
    fastify.put('/:id/status', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const { statut, buyer_id, prix_pourcentage, quantite: finalQuantite } = request.body;
            // Validate statut enum
            if (!VALID_TRADE_STATUSES.has(statut)) {
                return reply.code(400).send({ error: 'Statut invalide' });
            }

            const finalQuantity = finalQuantite !== undefined ? toPositiveInteger(finalQuantite) : undefined;
            const salePricePercent = prix_pourcentage !== undefined ? toValidPercentage(prix_pourcentage) : undefined;

            if (finalQuantite !== undefined && !finalQuantity) {
                return reply.code(400).send({ error: 'La quantité finale doit être un entier positif' });
            }

            if (prix_pourcentage !== undefined && !salePricePercent) {
                return reply.code(400).send({ error: 'Le prix de vente doit être un pourcentage positif valide' });
            }

            const trade = await Trade.findOne({
                where: { id: request.params.id, author_id: request.user.id },
                include: [{ model: Titre, as: 'titre' }]
            });

            if (!trade) {
                return reply.code(404).send({ error: 'Trade not found or unauthorized' });
            }

            // Logic for entering "En cours de négociation"
            if (statut === 'En cours de négociation' && trade.statut !== 'En cours de négociation') {
                // Check if at least one message exists in any room related to this trade
                const messageCount = await Message.count({
                    where: { room_id: { [Op.like]: `${trade.id}_%` } }
                });

                if (messageCount === 0) {
                    return reply.code(400).send({ error: 'La négociation ne peut commencer que si un échange de messages a déjà eu lieu.' });
                }

                // Deduct quantity from inventory
                const titre = trade.titre;
                if (titre) {
                    if (titre.quantite_titre < trade.quantite) {
                        return reply.code(400).send({ error: 'Stock insuffisant pour engager cette négociation.' });
                    }
                    titre.quantite_titre -= trade.quantite;
                    titre.volume_disponible = titre.quantite_titre * Number(titre.prix_titres || 0);
                    await titre.save();
                }
            }

            if (statut === 'Vendu' && trade.statut !== 'Vendu' && trade.type === 'Vente') {
                // Enforce prix_pourcentage and possibly quantite update at sale time
                if (salePricePercent !== undefined) trade.prix_pourcentage = salePricePercent;
                
                // If quantity changed at sale time
                if (finalQuantity !== undefined && finalQuantity !== trade.quantite) {
                    const diff = finalQuantity - trade.quantite;
                    const titre = trade.titre;
                    if (titre) {
                        // If it was already in negotiation, the previous qty was already deducted.
                        // If it was Published, we deduct now.
                        if (trade.statut === 'En cours de négociation') {
                             if (titre.quantite_titre < diff) return reply.code(400).send({ error: 'Stock insuffisant sur le titre.' });
                             titre.quantite_titre -= diff;
                        } else {
                             if (titre.quantite_titre < finalQuantity) return reply.code(400).send({ error: 'Stock insuffisant sur le titre.' });
                             titre.quantite_titre -= finalQuantity;
                        }
                        titre.volume_disponible = titre.quantite_titre * Number(titre.prix_titres || 0);
                        await titre.save();
                    }
                    trade.quantite = finalQuantity;
                } else if (trade.statut !== 'En cours de négociation') {
                    // Normal deduction if not already handled by negotiation status
                    const titre = trade.titre;
                    if (titre) {
                        if (titre.quantite_titre < trade.quantite) {
                            return reply.code(400).send({ error: 'La quantité restante du titre est insuffisante pour valider cette annonce vendue.' });
                        }
                        titre.quantite_titre -= trade.quantite;
                        titre.volume_disponible = titre.quantite_titre * Number(titre.prix_titres || 0);
                        await titre.save();
                    }
                }

                // IMPORTANT: Recalculate Volume Nominal (always Nominal as per user request)
                trade.montant = Number((trade.quantite * Number(trade.titre?.prix_titres || 10000)).toFixed(2));

                if (buyer_id) {
                    if (buyer_id !== 'hors_plateforme') {
                        const buyer = await User.findByPk(buyer_id);
                        if (!buyer) {
                            return reply.code(400).send({ error: 'Acheteur introuvable' });
                        }

                        if (String(buyer.id) === String(request.user.id)) {
                            return reply.code(400).send({ error: 'Le vendeur ne peut pas être son propre acheteur' });
                        }

                        const buyerMessageCount = await Message.count({
                            where: {
                                sender_id: buyer.id,
                                [Op.or]: [
                                    { room_id: { [Op.like]: `${trade.id}_%` } },
                                    { room_id: { [Op.like]: `trade_${trade.id}_%` } }
                                ]
                            }
                        });

                        if (buyerMessageCount === 0) {
                            return reply.code(400).send({ error: 'Cet acheteur n’a pas encore négocié cette annonce via le chat' });
                        }

                        trade.buyer_id = buyer_id;
                        if (buyer) {
                            const notificationMessage = `Félicitations, l'offre pour le titre ${trade.titre_id} vous a été accordée (Statut Vendu).`;
                            const saleNotifications = await createNotificationsForUsers({
                                userIds: [buyer.id],
                                message: notificationMessage,
                                type: 'Trade Vendu',
                                pushTitle: 'CEMAC Trade',
                                pushBody: notificationMessage,
                                pushTag: `trade-${trade.id}-sold`,
                                url: '/asset-manager',
                                logger: fastify.log
                            });
                            saleNotifications.forEach((notification) => {
                                fastify.io?.to(`user:${notification.user_id}`).emit('notification_created', notification.toJSON());
                            });

                            const seller = await User.findByPk(request.user.id, {
                                attributes: ['id', 'pseudo_anonyme', 'email']
                            });
                            const details = buildTradeEmailDetails(trade);
                            const detailsHtml = buildTradeDetailsHtml(details);
                            const mailHtml = `
                                <h2>Offre Conclue</h2>
                                <p>Bonjour ${escapeHtml(buyer.pseudo_anonyme)},</p>
                                <p>L'annonce pour le titre <strong>${escapeHtml(details.title)}</strong> vient de vous etre vendue par l'Asset Manager.</p>
                                ${detailsHtml}
                                <p>Veuillez vous connecter pour finaliser ou consulter votre tableau de bord.</p>
                            `;
                            sendMail(buyer.email, 'CEMAC Trade - Offre Vendu', mailHtml)
                                .catch((mailError) => fastify.log.error(mailError));

                            if (seller?.email) {
                                const sellerMailHtml = `
                                    <h2>Vente confirmee</h2>
                                    <p>Bonjour ${escapeHtml(seller.pseudo_anonyme)},</p>
                                    <p>Votre vente a ete attribuee a <strong>${escapeHtml(buyer.pseudo_anonyme)}</strong> (${escapeHtml(buyer.email)}).</p>
                                    ${detailsHtml}
                                `;
                                sendMail(seller.email, 'CEMAC Trade - Vente confirmee', sellerMailHtml)
                                    .catch((mailError) => fastify.log.error(mailError));
                            }
                        }
                    } else {
                         trade.buyer_id = null; // Vendu hors plateforme
                    }
                }
            }

            trade.statut = statut;
            await trade.save();

            return reply.send(trade);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Get interested buyers for a specific trade (users who chatted in the trade's room)
    fastify.get('/:id/interested-buyers', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const tradeId = request.params.id;
            const trade = await Trade.findOne({ where: { id: tradeId, author_id: request.user.id } });

            if (!trade) {
                return reply.code(404).send({ error: 'Annonce introuvable ou non autorisée' });
            }

            // Find all messages for rooms related to this trade
            const messages = await Message.findAll({
                where: {
                    [Op.or]: [
                        { room_id: { [Op.like]: `${tradeId}_%` } },
                        { room_id: { [Op.like]: `trade_${tradeId}_%` } }
                    ]
                },
                include: [{
                    model: User,
                    as: 'sender',
                    attributes: ['id', 'pseudo_anonyme']
                }]
            });

            // Extract unique users (excluding the current user, i.e., the seller)
            const buyersMap = new Map();
            messages.forEach(msg => {
                const parsedRoom = parseRoomId(msg.room_id);
                if (!parsedRoom || parsedRoom.tradeId !== tradeId) return;

                if (msg.sender_id !== request.user.id && msg.sender) {
                    buyersMap.set(msg.sender_id, {
                        id: msg.sender.id,
                        pseudo_anonyme: msg.sender.pseudo_anonyme
                    });
                }
            });

            return reply.send(Array.from(buyersMap.values()));
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Asset Manager: Adjust amount/quantity ONLY if "En cours de négociation"
    fastify.put('/:id/negotiate', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const { quantite, montant } = request.body;
            const negotiatedQuantity = quantite !== undefined ? toPositiveInteger(quantite) : undefined;
            const negotiatedAmount = montant !== undefined ? Number(montant) : undefined;

            if (quantite !== undefined && !negotiatedQuantity) {
                return reply.code(400).send({ error: 'La quantité négociée doit être un entier positif' });
            }

            if (montant !== undefined && (!Number.isFinite(negotiatedAmount) || negotiatedAmount < 0)) {
                return reply.code(400).send({ error: 'Le montant négocié doit être positif' });
            }

            const trade = await Trade.findOne({
                where: { id: request.params.id, author_id: request.user.id }
            });

            if (!trade) {
                return reply.code(404).send({ error: 'Trade non trouvé ou accès refusé' });
            }

            if (trade.statut !== 'En cours de négociation') {
                return reply.code(400).send({ error: "L'ajustement du montant/quantité n'est autorisé qu'en statut 'En cours de négociation'." });
            }

            const titre = await Titre.findOne({ where: { code_emission: trade.titre_id } });

            if (negotiatedQuantity !== undefined) {
                const diff = negotiatedQuantity - trade.quantite;
                if (titre) {
                    if (titre.quantite_titre < diff) {
                        return reply.code(400).send({ error: 'Stock insuffisant pour ajuster la quantité de la négociation.' });
                    }
                    titre.quantite_titre -= diff;
                    titre.volume_disponible = titre.quantite_titre * Number(titre.prix_titres || 0);
                    await titre.save();
                }
                trade.quantite = negotiatedQuantity;
            }

            if (negotiatedAmount !== undefined) {
                trade.montant = negotiatedAmount;
            }

            await trade.save();
            return reply.send(trade);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Asset Manager: Delete or Archive their Trade
    fastify.delete('/:id', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const trade = await Trade.findOne({
                where: {
                    id: request.params.id,
                    [Op.or]: [
                        { author_id: request.user.id },
                        { buyer_id: request.user.id }
                    ]
                }
            });

            if (!trade) {
                return reply.code(404).send({ error: 'Annonce introuvable ou vous n\'êtes pas autorisé' });
            }

            if (trade.buyer_id === request.user.id && trade.author_id !== request.user.id) {
                // Acheteur: il ne peut que l'archiver de sa vue
                trade.statut = 'Archivé';
                await trade.save();
                return reply.send({ message: 'L\'annonce a été archivée de votre historique d\'achats.' });
            }

            if (trade.statut === 'Vendu' || trade.statut === 'Acheté') {
                // If already sold/bought, we just archive instead of deleting
                trade.statut = 'Archivé';
                await trade.save();
                return reply.send({ message: 'L\'annonce a été archivée car elle est déjà vendue/achetée.' });
            } else {
                // Restore stock if the trade was in negotiation
                if (trade.statut === 'En cours de négociation' && trade.type === 'Vente') {
                    const titre = await Titre.findOne({ where: { code_emission: trade.titre_id } });
                    if (titre) {
                        titre.quantite_titre += trade.quantite;
                        titre.volume_disponible = titre.quantite_titre * Number(titre.prix_titres || 0);
                        await titre.save();
                    }
                }
                // Otherwise, safe to physically delete
                await trade.destroy();
                return reply.send({ message: 'L\'annonce a été supprimée avec succès.' });
            }
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Admin de-anonymization
    fastify.get('/admin/all', { preHandler: [authMiddleware, adminMiddleware] }, async (request, reply) => {
        try {
            const trades = await Trade.findAll({
                include: [{
                    model: User,
                    as: 'author',
                    attributes: ['nom', 'prenom', 'email', 'telephone', 'pseudo_anonyme', 'role']
                }, {
                    model: Titre,
                    as: 'titre'
                }],
                order: [['createdAt', 'DESC']]
            });

            return reply.send(trades);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });
    // Admin KPIs
    fastify.get('/admin/stats', { preHandler: [authMiddleware, adminMiddleware] }, async (request, reply) => {
        try {
            const annoncesActives = await Trade.count({ where: { statut: 'Publié' } });
            const volumeTotal = await Trade.sum('montant', { where: { statut: 'Publié' } }) || 0;
            const utilisateursActifs = await User.count();
            const ventesEffectuees = await Trade.count({ where: { statut: ['Vendu', 'Acheté'] } });

            // Count unique chat rooms
            const uniqueRooms = await Message.aggregate('room_id', 'count', { distinct: true });

            return reply.send({
                annoncesActives,
                volumeTotal,
                utilisateursActifs,
                ventesEffectuees,
                negociationsEnCours: uniqueRooms
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Admin Users List
    fastify.get('/admin/users', { preHandler: [authMiddleware, adminMiddleware] }, async (request, reply) => {
        try {
            const users = await User.findAll({
                attributes: ['id', 'nom', 'prenom', 'email', 'telephone', 'pseudo_anonyme', 'role', 'wallet_ref', 'createdAt'],
                order: [['createdAt', 'DESC']]
            });
            return reply.send(users);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Admin: Delete ANY trade (Moderation)
    fastify.delete('/admin/:id', { preHandler: [authMiddleware, adminMiddleware] }, async (request, reply) => {
        try {
            const trade = await Trade.findByPk(request.params.id);
            if (!trade) {
                return reply.code(404).send({ error: 'Trade introuvable' });
            }
            
            // Restore stock if it was in negotiation or published
            if ((trade.statut === 'En cours de négociation' || trade.statut === 'Publié') && trade.type === 'Vente') {
                const titre = await Titre.findOne({ where: { code_emission: trade.titre_id } });
                if (titre) {
                    // Only restore if it was actually deducted.
                    // If it was Published, it's NOT deducted from Titre.quantite_titre until Sold or Negotiating.
                    // Wait, let's check trade creation logic.
                    // In POST '/', it doesn't deduct.
                    // In PUT '/:id/status', it deducts when moving TO 'En cours de négociation' or 'Vendu'.
                    if (trade.statut === 'En cours de négociation') {
                        titre.quantite_titre += trade.quantite;
                        titre.volume_disponible = titre.quantite_titre * Number(titre.prix_titres || 0);
                        await titre.save();
                    }
                }
            }

            await trade.destroy();
            return reply.send({ message: 'L\'annonce a été supprimée par l\'administrateur.' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Admin: Update ANY trade status (Moderation)
    fastify.put('/admin/:id/status', { preHandler: [authMiddleware, adminMiddleware] }, async (request, reply) => {
        try {
            const { statut } = request.body;
            if (!VALID_TRADE_STATUSES.has(statut)) {
                return reply.code(400).send({ error: 'Statut invalide' });
            }

            const trade = await Trade.findByPk(request.params.id);
            if (!trade) {
                return reply.code(404).send({ error: 'Trade introuvable' });
            }
            
            trade.statut = statut;
            await trade.save();
            return reply.send(trade);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

};

