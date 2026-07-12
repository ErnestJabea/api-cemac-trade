const { Notification, PushSubscription } = require('../models/index');
const { authMiddleware } = require('../middlewares/authMiddleware');

module.exports = async function (fastify, opts) {
    fastify.addHook('preHandler', authMiddleware);

    fastify.get('/', async (request, reply) => {
        try {
            const notifications = await Notification.findAll({
                where: { user_id: request.user.id },
                order: [['createdAt', 'DESC']],
                limit: 50
            });
            return reply.send(notifications);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.get('/push/public-key', async (request, reply) => {
        return reply.send({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
    });

    fastify.post('/push/subscribe', async (request, reply) => {
        try {
            const { subscription } = request.body || {};
            const endpoint = subscription?.endpoint;
            const p256dh = subscription?.keys?.p256dh;
            const auth = subscription?.keys?.auth;

            if (!endpoint || !p256dh || !auth) {
                return reply.code(400).send({ error: 'Abonnement push invalide' });
            }

            const existingSubscription = await PushSubscription.findOne({ where: { endpoint } });
            if (existingSubscription) {
                existingSubscription.user_id = request.user.id;
                existingSubscription.p256dh = p256dh;
                existingSubscription.auth = auth;
                existingSubscription.user_agent = request.headers['user-agent'] || null;
                await existingSubscription.save();
                return reply.send({ success: true });
            }

            await PushSubscription.create({
                user_id: request.user.id,
                endpoint,
                p256dh,
                auth,
                user_agent: request.headers['user-agent'] || null
            });

            return reply.code(201).send({ success: true });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.delete('/push/subscribe', async (request, reply) => {
        try {
            const { endpoint } = request.body || {};
            if (!endpoint) {
                return reply.code(400).send({ error: 'Endpoint push requis' });
            }

            await PushSubscription.destroy({
                where: {
                    endpoint,
                    user_id: request.user.id
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Mark specific as read
    fastify.put('/:id/read', async (request, reply) => {
        try {
            await Notification.update(
                { is_read: true },
                { where: { id: request.params.id, user_id: request.user.id } }
            );
            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    // Mark all as read
    fastify.put('/read-all', async (request, reply) => {
        try {
            await Notification.update(
                { is_read: true },
                { where: { user_id: request.user.id, is_read: false } }
            );
            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });
};
