const { Message, User } = require('../models/index');
const { authMiddleware } = require('../middlewares/authMiddleware');
const { Op } = require('sequelize');
const { authorizeConversationRoom, parseRoomId, roomHasParticipant } = require('../utils/conversations');
const { notifyMessageRecipients } = require('../services/notificationService');

module.exports = async function (fastify, opts) {
    fastify.addHook('preHandler', authMiddleware);

    // Get all conversations for current user
    fastify.get('/conversations', async (request, reply) => {
        try {
            const userId = request.user.id;
            const messages = await Message.findAll({
                where: {
                    room_id: { [Op.like]: `%${userId}%` }
                },
                order: [['createdAt', 'DESC']],
                attributes: ['room_id', 'content', 'createdAt', 'is_read', 'sender_id'],
                include: [{
                    model: User,
                    as: 'sender',
                    attributes: ['pseudo_anonyme']
                }]
            });

            // Group by room_id, taking the latest message
            const conversationsMap = {};
            for (let m of messages) {
                const parsedRoom = parseRoomId(m.room_id);
                if (!parsedRoom || !roomHasParticipant(parsedRoom, userId)) {
                    continue;
                }

                if (!conversationsMap[m.room_id]) {
                    conversationsMap[m.room_id] = {
                        room_id: m.room_id,
                        last_message: m.content,
                        sender: m.sender ? m.sender.pseudo_anonyme : 'Unknown',
                        updatedAt: m.createdAt,
                        trade_id: parsedRoom.tradeId,
                        unread_count: 0
                    };
                }
                if (!m.is_read && m.sender_id !== userId) {
                    conversationsMap[m.room_id].unread_count += 1;
                }
            }

            const values = Object.values(conversationsMap);
            const authorizedValues = [];
            for (let conv of values) {
                const authorization = await authorizeConversationRoom(conv.room_id, request.user);
                if (!authorization.ok) {
                    continue;
                }

                const trade = authorization.trade;
                conv.titre_id = trade.titre_id;
                conv.trade_type = trade.type;
                authorizedValues.push(conv);
            }

            return reply.send(authorizedValues);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // List messages for a specific room (anonymized sender)
    fastify.get('/:room_id', async (request, reply) => {
        try {
            const authorization = await authorizeConversationRoom(request.params.room_id, request.user);
            if (!authorization.ok) {
                return reply.code(authorization.statusCode).send({ error: authorization.error });
            }

            const messages = await Message.findAll({
                where: { room_id: request.params.room_id },
                include: [{
                    model: User,
                    as: 'sender',
                    attributes: ['pseudo_anonyme', 'role']
                }],
                order: [['createdAt', 'ASC']]
            });

            // Format to match old output if needed
            const formatted = messages.map(m => ({
                id: m.id,
                room_id: m.room_id,
                content: m.content,
                sender_id: {
                    public_identity: { pseudo_anonyme: m.sender ? m.sender.pseudo_anonyme : 'System' },
                    role: m.sender ? m.sender.role : 'user'
                },
                createdAt: m.createdAt
            }));

            return reply.send(formatted);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // POST Message to save to DB (typically called from sockets or via API)
    fastify.post('/:room_id', async (request, reply) => {
        try {
            const { content } = request.body;
            const cleanContent = typeof content === 'string' ? content.trim() : '';

            if (!cleanContent) {
                return reply.code(400).send({ error: 'Message vide' });
            }

            if (cleanContent.length > 5000) {
                return reply.code(400).send({ error: 'Message trop long' });
            }

            const authorization = await authorizeConversationRoom(request.params.room_id, request.user);
            if (!authorization.ok) {
                return reply.code(authorization.statusCode).send({ error: authorization.error });
            }

            const newMessage = await Message.create({
                room_id: request.params.room_id,
                content: cleanContent,
                sender_id: request.user.id,
                is_read: false
            });

            const sender = await User.findByPk(request.user.id, {
                attributes: ['id', 'pseudo_anonyme', 'role']
            });

            try {
                const notifications = await notifyMessageRecipients({
                    authorization,
                    sender,
                    roomId: request.params.room_id,
                    content: cleanContent,
                    logger: fastify.log
                });
                notifications.forEach((notification) => {
                    fastify.io?.to(`user:${notification.user_id}`).emit('notification_created', notification.toJSON());
                });
            } catch (notificationError) {
                fastify.log.error(notificationError);
            }

            return reply.code(201).send(newMessage);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Mark messages as read in a room
    fastify.put('/:room_id/mark-read', async (request, reply) => {
        try {
            const authorization = await authorizeConversationRoom(request.params.room_id, request.user);
            if (!authorization.ok) {
                return reply.code(authorization.statusCode).send({ error: authorization.error });
            }

            await Message.update(
                { is_read: true },
                {
                    where: {
                        room_id: request.params.room_id,
                        sender_id: { [Op.ne]: request.user.id },
                        is_read: false
                    }
                }
            );
            return reply.send({ success: true });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });
};
