const webPush = require('web-push');
const { PushSubscription } = require('../models/index');

let isConfigured = false;

const configureWebPush = () => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;

    if (!publicKey || !privateKey) {
        return false;
    }

    if (!isConfigured) {
        webPush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:admin@cemac-trade.local',
            publicKey,
            privateKey
        );
        isConfigured = true;
    }

    return true;
};

const sendPushToUser = async (userId, payload) => {
    if (!configureWebPush()) {
        return { sent: 0, skipped: true };
    }

    const subscriptions = await PushSubscription.findAll({ where: { user_id: userId } });
    let sent = 0;

    await Promise.all(subscriptions.map(async (subscriptionRecord) => {
        const subscription = {
            endpoint: subscriptionRecord.endpoint,
            keys: {
                p256dh: subscriptionRecord.p256dh,
                auth: subscriptionRecord.auth
            }
        };

        try {
            await webPush.sendNotification(subscription, JSON.stringify(payload));
            sent += 1;
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
                await subscriptionRecord.destroy();
                return;
            }

            console.error('Push notification error:', error);
        }
    }));

    return { sent, skipped: false };
};

module.exports = {
    sendPushToUser
};
