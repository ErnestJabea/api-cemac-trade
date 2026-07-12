const { Trade } = require('../models/index');

const PUBLIC_CHAT_STATUSES = new Set(['Publié', 'En cours de négociation']);
const CLOSED_CHAT_STATUSES = new Set(['Vendu', 'Acheté', 'Archivé']);

const normalizeId = (value) => String(value || '').trim();

const parseRoomId = (roomId) => {
    if (typeof roomId !== 'string') return null;

    const parts = roomId.split('_').map(normalizeId).filter(Boolean);
    if (parts.length < 3) return null;

    if (parts[0] === 'trade' && parts.length >= 4) {
        return {
            tradeId: parts[1],
            participantIds: [parts[2], parts[3]]
        };
    }

    return {
        tradeId: parts[0],
        participantIds: [parts[1], parts[2]]
    };
};

const canonicalRoomId = (tradeId, firstUserId, secondUserId) => {
    const ids = [normalizeId(firstUserId), normalizeId(secondUserId)].sort();
    return `${normalizeId(tradeId)}_${ids[0]}_${ids[1]}`;
};

const roomHasParticipant = (parsedRoom, userId) => {
    const normalizedUserId = normalizeId(userId);
    return parsedRoom?.participantIds?.some((id) => id === normalizedUserId);
};

const authorizeConversationRoom = async (roomId, user) => {
    const parsedRoom = parseRoomId(roomId);
    const userId = normalizeId(user?.id);

    if (!parsedRoom || !userId) {
        return { ok: false, statusCode: 400, error: 'Salon de conversation invalide' };
    }

    if (!roomHasParticipant(parsedRoom, userId)) {
        return { ok: false, statusCode: 403, error: 'Accès refusé à cette conversation' };
    }

    const trade = await Trade.findByPk(parsedRoom.tradeId, {
        attributes: ['id', 'author_id', 'buyer_id', 'statut', 'titre_id', 'type']
    });

    if (!trade) {
        return { ok: false, statusCode: 404, error: 'Annonce introuvable' };
    }

    const authorId = normalizeId(trade.author_id);
    const buyerId = normalizeId(trade.buyer_id);

    if (!roomHasParticipant(parsedRoom, authorId)) {
        return { ok: false, statusCode: 403, error: 'Conversation non liée au vendeur de cette annonce' };
    }

    const isAuthor = userId === authorId;
    const isBuyer = buyerId && userId === buyerId;
    const isPublicNegotiation = PUBLIC_CHAT_STATUSES.has(trade.statut);
    const isClosedParticipant = CLOSED_CHAT_STATUSES.has(trade.statut) && (isAuthor || isBuyer);

    if (!isAuthor && !isBuyer && !isPublicNegotiation && !isClosedParticipant) {
        return { ok: false, statusCode: 403, error: 'Cette annonce ne peut pas être négociée' };
    }

    return {
        ok: true,
        parsedRoom,
        trade,
        canonicalRoomId: canonicalRoomId(trade.id, parsedRoom.participantIds[0], parsedRoom.participantIds[1])
    };
};

module.exports = {
    authorizeConversationRoom,
    canonicalRoomId,
    parseRoomId,
    roomHasParticipant
};
