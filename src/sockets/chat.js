const { Message, User } = require('../models/index');
const jwt = require('jsonwebtoken');
const { authorizeConversationRoom } = require('../utils/conversations');
const { notifyMessageRecipients } = require('../services/notificationService');

module.exports = (io) => {
    io.use((socket, next) => {
        try {
            const authHeader = socket.handshake.headers?.authorization;
            const token = socket.handshake.auth?.token || (authHeader && authHeader.split(' ')[1]);

            if (!token) {
                return next(new Error('Unauthorized: No token provided'));
            }

            socket.user = jwt.verify(token, process.env.JWT_SECRET);
            return next();
        } catch (error) {
            return next(new Error('Unauthorized: Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        console.log('User connected to socket:', socket.id, socket.user?.id);
        socket.join(`user:${socket.user.id}`);

        socket.on('join_room', async (roomId) => {
            try {
                const authorization = await authorizeConversationRoom(roomId, socket.user);
                if (!authorization.ok) {
                    socket.emit('message_error', { error: authorization.error });
                    return;
                }

                socket.join(roomId);
                console.log(`User ${socket.user.id} joined room ${roomId}`);
            } catch (error) {
                console.error('Socket Join Error:', error);
                socket.emit('message_error', { error: 'Impossible de rejoindre cette conversation' });
            }
        });

        socket.on('send_message', async (data) => {
            try {
                const { room_id } = data;
                const content = typeof data.content === 'string' ? data.content.trim() : '';

                if (!content) {
                    socket.emit('message_error', { error: 'Message vide' });
                    return;
                }

                if (content.length > 5000) {
                    socket.emit('message_error', { error: 'Message trop long' });
                    return;
                }

                const authorization = await authorizeConversationRoom(room_id, socket.user);
                if (!authorization.ok) {
                    socket.emit('message_error', { error: authorization.error });
                    return;
                }

                // Save to DB via Sequelize
                const newMessage = await Message.create({
                    room_id,
                    content,
                    sender_id: socket.user.id,
                    is_read: false
                });

                // Get sender info to send back public identity
                const sender = await User.findByPk(socket.user.id, {
                    attributes: ['id', 'pseudo_anonyme', 'role']
                });

                notifyMessageRecipients({
                    authorization,
                    sender,
                    roomId: room_id,
                    content,
                    logger: console
                }).then((notifications) => {
                    notifications.forEach((notification) => {
                        io.to(`user:${notification.user_id}`).emit('notification_created', notification.toJSON());
                    });
                }).catch((notificationError) => {
                    console.error('Message Notification Error:', notificationError);
                });

                // Broadcast
                io.to(room_id).emit('receive_message', {
                    id: newMessage.id,
                    room_id,
                    content,
                    sender_id: {
                        public_identity: { pseudo_anonyme: sender?.pseudo_anonyme || 'Utilisateur' },
                        role: sender?.role || 'asset_manager'
                    },
                    createdAt: newMessage.createdAt
                });
            } catch (error) {
                console.error('Socket Message Error:', error);
            }
        });

        socket.on('disconnect', () => {
            console.log('User disconnected:', socket.id);
        });
    });
};
