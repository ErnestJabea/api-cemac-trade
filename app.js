require('dotenv').config();
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const rateLimit = require('@fastify/rate-limit');
const socketIo = require('socket.io');
const multipart = require('@fastify/multipart');
const { sequelize } = require('./src/models/index');
const { ensureSecurityColumns } = require('./src/utils/securitySchema');

const app = Fastify({
    logger: true,
    maxParamLength: 300
});
app.decorate('io', null);

// Environment variables
const PORT = process.env.PORT || 3000;
const FRONTEND_URLS = (process.env.FRONTEND_URL || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsOrigin = (origin, cb) => {
    if (!origin || FRONTEND_URLS.includes(origin)) {
        cb(null, true);
        return;
    }

    cb(new Error('Origin not allowed by CORS'), false);
};

// Plugins
app.register(cors, {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
});

app.register(multipart, {
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB
    }
});

app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute'
});

app.get('/', async (request, reply) => {
    return reply.type('text/html; charset=UTF-8').send('CEMAC Trade API is running');
});

const healthResponse = {
    status: 'ok',
    service: 'cemac-trade-api'
};

app.get('/health', async () => healthResponse);
app.get('/api/health', async () => healthResponse);

// Routes
app.register(require('./src/routes/auth'), { prefix: '/api/auth' });
app.register(require('./src/routes/titres'), { prefix: '/api/titres' });
app.register(require('./src/routes/trades'), { prefix: '/api/trades' });
app.register(require('./src/routes/messages'), { prefix: '/api/messages' });
app.register(require('./src/routes/notifications'), { prefix: '/api/notifications' });

// Start server
const start = async () => {
    if (!process.env.JWT_SECRET) {
        console.error('CRITICAL ERROR: JWT_SECRET is not defined in .env');
        process.exit(1);
    }
    try {
        await sequelize.authenticate();
        console.log('MySQL Connected (via Sequelize)');

        if (process.env.DEBUG_DB_STARTUP === 'true') {
            const users = await require('./src/models/index').User.findAll({ attributes: ['id', 'pseudo_anonyme'] });
            console.log('--- DB USERS AT STARTUP ---');
            users.forEach(u => console.log(`[USER] ID: ${u.id} | Pseudo: ${u.pseudo_anonyme}`));
        }

        if (process.env.DB_SYNC_ON_STARTUP !== 'false') {
            await sequelize.sync({ alter: process.env.DB_SYNC_ALTER === 'true' });
            console.log(`MySQL Tables Synced (alter=${process.env.DB_SYNC_ALTER === 'true'})`);
        }
        await ensureSecurityColumns(sequelize);

        const io = socketIo(app.server, {
            path: '/api/socket.io',
            cors: {
                origin: FRONTEND_URLS,
                methods: ['GET', 'POST']
            }
        });
        app.io = io;

        require('./src/sockets/chat')(io);

        await app.listen({ port: PORT, host: '0.0.0.0' });

        console.log(`Server is running on port ${PORT}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
