const jwt = require('jsonwebtoken');

const authMiddleware = async (request, reply) => {
    try {
        const authHeader = request.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return reply.code(401).send({ error: 'Unauthorized: No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.purpose && decoded.purpose !== 'access') {
            return reply.code(401).send({ error: 'Jeton MFA temporaire non autorisÃ© pour cette ressource' });
        }
        request.user = decoded;
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return reply.code(403).send({ error: 'Session expirée. Veuillez vous reconnecter.', code: 'TOKEN_EXPIRED' });
        }
        return reply.code(403).send({ error: 'Jeton invalide. Veuillez vous reconnecter.', code: 'TOKEN_INVALID' });
    }
};

const adminMiddleware = async (request, reply) => {
    if (request.user.role !== 'admin') {
        return reply.code(403).send({ error: 'Access denied: Admin role required' });
    }
};

module.exports = { authMiddleware, adminMiddleware };
