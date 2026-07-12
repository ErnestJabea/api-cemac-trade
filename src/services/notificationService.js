const { Notification, User } = require('../models/index');
const { sendPushToUser } = require('./pushService');

const truncateText = (value, maxLength = 120) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1)}…`;
};

const uniqueIds = (ids) => {
    return Array.from(new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean)));
};

const createNotificationsForUsers = async ({
    userIds,
    message,
    type = 'Info',
    pushTitle = 'CEMAC Trade',
    pushBody,
    pushTag,
    url = '/',
    logger = console
}) => {
    const targetIds = uniqueIds(userIds);
    if (targetIds.length === 0 || !message) return [];

    const existingUsers = await User.findAll({
        where: { id: targetIds },
        attributes: ['id']
    });
    const existingUserIds = existingUsers.map((user) => user.id);

    const notifications = await Promise.all(existingUserIds.map((userId) => {
        return Notification.create({
            user_id: userId,
            message,
            type
        });
    }));

    Promise.all(existingUserIds.map((userId) => {
        return sendPushToUser(userId, {
            title: pushTitle,
            body: pushBody || message,
            tag: pushTag || `${type}-${Date.now()}`,
            url
        }).catch((error) => {
            if (logger?.error) logger.error(error);
        });
    })).catch((error) => {
        if (logger?.error) logger.error(error);
    });

    return notifications;
};

const notifyMessageRecipients = async ({ authorization, sender, roomId, content, logger }) => {
    const senderId = String(sender?.id || '').trim();
    const recipientIds = uniqueIds(authorization?.parsedRoom?.participantIds)
        .filter((participantId) => participantId !== senderId);

    if (recipientIds.length === 0) return [];

    const senderName = sender?.pseudo_anonyme || 'Un utilisateur';
    const tradeTitle = authorization?.trade?.titre_id || 'une annonce';
    const preview = truncateText(content, 90);
    const message = `Nouveau message de ${senderName} sur ${tradeTitle}: ${preview}`;

    return createNotificationsForUsers({
        userIds: recipientIds,
        message,
        type: 'Message',
        pushTitle: 'Nouveau message',
        pushBody: message,
        pushTag: `chat-${roomId}`,
        url: `/chat/${encodeURIComponent(roomId)}`,
        logger
    });
};

module.exports = {
    createNotificationsForUsers,
    notifyMessageRecipients
};
