const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Op } = require('sequelize');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const xlsx = require('xlsx-js-style');
const { io } = require('../../frontend/node_modules/socket.io-client');
const { sequelize, User, Titre, Trade, Message, Notification } = require('../src/models/index');

const SHOULD_START_SERVER = process.env.START_TEST_SERVER === 'true';
const TEST_PORT = process.env.TEST_PORT || '3001';
const API_BASE_URL = process.env.TEST_API_URL || (SHOULD_START_SERVER ? `http://127.0.0.1:${TEST_PORT}/api` : 'http://127.0.0.1:3000/api');
const WS_URL = API_BASE_URL.replace(/\/api\/?$/, '');
const TEST_RUN_ID = `BF${Date.now()}`;
const PASSWORD = 'Password123!';
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
let serverProcess = null;
let cleanupEnabled = false;

const users = {
    seller: {
        nom: 'Seller',
        prenom: 'Business',
        email: `seller_${TEST_RUN_ID}@cemac.test`,
        telephone: '+237600000001',
        pseudo_anonyme: `seller_${TEST_RUN_ID}`,
        role: 'asset_manager'
    },
    buyer: {
        nom: 'Buyer',
        prenom: 'Business',
        email: `buyer_${TEST_RUN_ID}@cemac.test`,
        telephone: '+237600000002',
        pseudo_anonyme: `buyer_${TEST_RUN_ID}`,
        role: 'asset_manager'
    },
    intruder: {
        nom: 'Intruder',
        prenom: 'Business',
        email: `intruder_${TEST_RUN_ID}@cemac.test`,
        telephone: '+237600000003',
        pseudo_anonyme: `intruder_${TEST_RUN_ID}`,
        role: 'asset_manager'
    },
    admin: {
        nom: 'Admin',
        prenom: 'Business',
        email: `admin_${TEST_RUN_ID}@cemac.test`,
        telephone: '+237600000004',
        pseudo_anonyme: `admin_${TEST_RUN_ID}`,
        role: 'admin'
    }
};

const state = {
    sellerToken: null,
    buyerToken: null,
    intruderToken: null,
    adminToken: null,
    sellerId: null,
    buyerId: null,
    intruderId: null,
    adminId: null,
    titreCode: `TEST-${TEST_RUN_ID}`,
    protectedTitreCode: `PROTECTED-${TEST_RUN_ID}`,
    tradeId: null,
    draftTradeId: null,
    roomId: null
};

const results = [];

const logResult = (name, ok, details = '') => {
    results.push({ name, ok, details });
    const prefix = ok ? '[OK]' : '[FAIL]';
    console.log(`${prefix} ${name}${details ? ` - ${details}` : ''}`);
};

const assert = (condition, name, details = '') => {
    if (!condition) {
        logResult(name, false, details);
        throw new Error(`${name}${details ? `: ${details}` : ''}`);
    }
    logResult(name, true, details);
};

const request = async (path, options = {}) => {
    const res = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers: {
            ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {})
        }
    });

    const text = await res.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }

    return { res, data };
};

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

const createVerifiedUser = async (payload) => {
    const password = await bcrypt.hash(PASSWORD, 10);
    return User.create({
        ...payload,
        password,
        is_verified: true,
        verification_token: null,
        wallet_ref: `WALLET-${payload.pseudo_anonyme}`
    });
};

const login = async (email) => {
    const { res, data } = await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD })
    });

    assert(res.ok && data?.token, `Login ${email}`, `status=${res.status}`);
    return data;
};

const makeTitresWorkbookBlob = (code, quantity = 100, price = 10000) => {
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet([
        {
            'Code émission': code,
            'Code ISIN': `ISIN-${code}`,
            Nature: 'BTA',
            Emetteur: 'Etat du Cameroun',
            'Date Valeur': '01/01/2026',
            'Date Echéance': '01/01/2030',
            'Taux Facial': '5.5%',
            'Quantité Titre': quantity,
            'Prix Titre': price
        }
    ]);

    xlsx.utils.book_append_sheet(workbook, worksheet, 'Titres');
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    return new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
};

const uploadTitre = async (token, code, quantity = 100, price = 10000) => {
    const formData = new FormData();
    formData.append('file', makeTitresWorkbookBlob(code, quantity, price), `${code}.xlsx`);

    return request('/titres/import', {
        method: 'POST',
        headers: authHeaders(token),
        body: formData
    });
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const assertSafeDatabaseTarget = () => {
    const dbHost = process.env.DB_HOST || '127.0.0.1';
    const isLocalDatabase = LOCAL_DB_HOSTS.has(dbHost);
    const allowRemoteDatabase = process.env.TEST_ALLOW_REMOTE_DB === 'true';

    if (!isLocalDatabase && !allowRemoteDatabase) {
        throw new Error(`Refusing to run write/delete business-flow tests against remote DB_HOST=${dbHost}. Use a local test DB or set TEST_ALLOW_REMOTE_DB=true explicitly.`);
    }
};

const startTestServer = async () => {
    if (!SHOULD_START_SERVER) return;

    const backendDir = path.resolve(__dirname, '..');
    const stdout = fs.createWriteStream(path.join(backendDir, 'business-flow-server.out.log'), { flags: 'a' });
    const stderr = fs.createWriteStream(path.join(backendDir, 'business-flow-server.err.log'), { flags: 'a' });

    serverProcess = spawn(process.execPath, ['app.js'], {
        cwd: backendDir,
        env: {
            ...process.env,
            PORT: TEST_PORT,
            DB_SYNC_ON_STARTUP: process.env.DB_SYNC_ON_STARTUP || 'true',
            DB_SYNC_ALTER: process.env.DB_SYNC_ALTER || 'false',
            DEBUG_DB_STARTUP: 'false',
            FRONTEND_URL: process.env.FRONTEND_URL || `http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:${TEST_PORT}`
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.pipe(stdout);
    serverProcess.stderr.pipe(stderr);

    const deadline = Date.now() + 20000;
    let lastError = null;

    while (Date.now() < deadline) {
        if (serverProcess.exitCode !== null) {
            throw new Error(`Test server exited early with code ${serverProcess.exitCode}`);
        }

        try {
            const response = await fetch(`${API_BASE_URL}/trades`);
            if (response.ok) return;
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await wait(500);
    }

    throw new Error(`Test server did not start: ${lastError?.message || 'timeout'}`);
};

const stopTestServer = async () => {
    if (!serverProcess || serverProcess.exitCode !== null) return;

    serverProcess.kill();
    await wait(500);
};

const testSocketFlow = async () => {
    let unauthRejected = false;
    const unauthSocket = io(WS_URL, {
        path: '/api/socket.io',
        transports: ['polling', 'websocket'],
        timeout: 1500
    });

    await new Promise((resolve) => {
        unauthSocket.on('connect', () => {
            resolve();
        });
        unauthSocket.on('connect_error', () => {
            unauthRejected = true;
            resolve();
        });
        setTimeout(resolve, 2000);
    });
    unauthSocket.disconnect();

    assert(unauthRejected, 'Socket refuse une connexion sans JWT');

    const forgedContent = `socket-forged-${TEST_RUN_ID}`;
    const socket = io(WS_URL, {
        path: '/api/socket.io',
        auth: { token: state.buyerToken },
        transports: ['polling', 'websocket'],
        timeout: 3000
    });

    await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
        setTimeout(() => reject(new Error('Socket buyer connection timeout')), 4000);
    });

    socket.emit('join_room', state.roomId);
    await wait(250);
    socket.emit('send_message', {
        room_id: state.roomId,
        content: forgedContent,
        sender_id: state.sellerId
    });
    await wait(750);
    socket.disconnect();

    const forgedMessage = await Message.findOne({
        where: { room_id: state.roomId, content: forgedContent }
    });

    assert(
        forgedMessage && String(forgedMessage.sender_id) === String(state.buyerId),
        'Socket ignore le sender_id forgé',
        `sender=${forgedMessage?.sender_id}`
    );
};

const cleanup = async () => {
    try {
        const testUsers = await User.findAll({
            where: { email: { [Op.like]: `%_${TEST_RUN_ID}@cemac.test` } },
            attributes: ['id']
        });
        const userIds = testUsers.map((user) => user.id);

        if (state.tradeId || state.draftTradeId) {
            await Message.destroy({
                where: {
                    room_id: {
                        [Op.or]: [
                            ...(state.tradeId ? [{ [Op.like]: `${state.tradeId}_%` }, { [Op.like]: `trade_${state.tradeId}_%` }] : []),
                            ...(state.draftTradeId ? [{ [Op.like]: `${state.draftTradeId}_%` }, { [Op.like]: `trade_${state.draftTradeId}_%` }] : [])
                        ]
                    }
                }
            });
        }

        if (userIds.length > 0) {
            await Notification.destroy({ where: { user_id: userIds } });
        }

        await Trade.destroy({
            where: {
                [Op.or]: [
                    { titre_id: state.titreCode },
                    { titre_id: state.protectedTitreCode },
                    ...(state.tradeId ? [{ id: state.tradeId }] : []),
                    ...(state.draftTradeId ? [{ id: state.draftTradeId }] : [])
                ]
            }
        });
        await Titre.destroy({ where: { code_emission: [state.titreCode, state.protectedTitreCode] } });

        if (userIds.length > 0) {
            await User.destroy({ where: { id: userIds } });
        }
    } catch (error) {
        console.error('[CLEANUP ERROR]', error);
    }
};

const run = async () => {
    assertSafeDatabaseTarget();
    await startTestServer();
    await sequelize.authenticate();
    cleanupEnabled = true;
    await cleanup();

    const seller = await createVerifiedUser(users.seller);
    const buyer = await createVerifiedUser(users.buyer);
    const intruder = await createVerifiedUser(users.intruder);
    const admin = await createVerifiedUser(users.admin);

    state.sellerId = seller.id;
    state.buyerId = buyer.id;
    state.intruderId = intruder.id;
    state.adminId = admin.id;

    const sellerLogin = await login(users.seller.email);
    const buyerLogin = await login(users.buyer.email);
    const intruderLogin = await login(users.intruder.email);
    const adminLogin = await login(users.admin.email);

    state.sellerToken = sellerLogin.token;
    state.buyerToken = buyerLogin.token;
    state.intruderToken = intruderLogin.token;
    state.adminToken = adminLogin.token;

    const buyerProfile = await request('/auth/me', { headers: authHeaders(state.buyerToken) });
    assert(buyerProfile.res.ok && buyerProfile.data.email === users.buyer.email, 'Lecture profil utilisateur');

    const updatedBuyerPhone = '+237699999999';
    const updatedBuyerProfile = await request('/auth/me', {
        method: 'PUT',
        headers: authHeaders(state.buyerToken),
        body: JSON.stringify({
            nom: users.buyer.nom,
            prenom: users.buyer.prenom,
            telephone: updatedBuyerPhone,
            pseudo_anonyme: users.buyer.pseudo_anonyme,
            wallet_ref: `UPDATED-WALLET-${TEST_RUN_ID}`
        })
    });
    assert(
        updatedBuyerProfile.res.ok && updatedBuyerProfile.data.profile.telephone === updatedBuyerPhone,
        'Mise a jour profil utilisateur'
    );

    let uploaded = await uploadTitre(state.sellerToken, state.titreCode, 100, 10000);
    assert(uploaded.res.ok && uploaded.data.total_imported === 1, 'Import Excel titre vendeur', JSON.stringify(uploaded.data));

    uploaded = await uploadTitre(state.buyerToken, state.titreCode, 100, 10000);
    assert(
        uploaded.res.ok && uploaded.data.skipped_unauthorized === 1,
        'Import Excel ne réassigne pas un titre existant',
        JSON.stringify(uploaded.data)
    );

    const titres = await request('/titres', { headers: authHeaders(state.sellerToken) });
    assert(titres.res.ok && titres.data.some((titre) => titre.code_emission === state.titreCode), 'Liste des titres vendeur');

    let created = await request('/trades', {
        method: 'POST',
        headers: authHeaders(state.sellerToken),
        body: JSON.stringify({ titre_id: state.titreCode, type: 'Vente', quantite: 10, prix_pourcentage: 99.5 })
    });
    assert(created.res.status === 201 && created.data?.id, 'Création annonce brouillon', `status=${created.res.status}`);
    state.tradeId = created.data.id;

    created = await request('/trades', {
        method: 'POST',
        headers: authHeaders(state.sellerToken),
        body: JSON.stringify({ titre_id: state.titreCode, type: 'Vente', quantite: 0, prix_pourcentage: 99.5 })
    });
    assert(created.res.status === 400, 'Validation refuse une quantité invalide', `status=${created.res.status}`);

    const publicBeforePublish = await request('/trades');
    assert(
        publicBeforePublish.res.ok && !publicBeforePublish.data.some((trade) => trade.id === state.tradeId),
        'Brouillon absent du marché public'
    );

    const buyerDraftAccess = await request(`/trades/${state.tradeId}`, { headers: authHeaders(state.buyerToken) });
    assert(buyerDraftAccess.res.status === 403, 'Acheteur ne lit pas un brouillon vendeur', `status=${buyerDraftAccess.res.status}`);

    const published = await request(`/trades/${state.tradeId}/status`, {
        method: 'PUT',
        headers: authHeaders(state.sellerToken),
        body: JSON.stringify({ statut: 'Publié' })
    });
    assert(published.res.ok && published.data.statut === 'Publié', 'Publication annonce');

    const publicAfterPublish = await request('/trades');
    assert(
        publicAfterPublish.res.ok && publicAfterPublish.data.some((trade) => trade.id === state.tradeId),
        'Annonce publiée visible sur le marché'
    );

    const sortedIds = [state.buyerId, state.sellerId].sort();
    state.roomId = `${state.tradeId}_${sortedIds[0]}_${sortedIds[1]}`;

    const interest = await request(`/trades/${state.tradeId}/interest`, {
        method: 'POST',
        headers: authHeaders(state.buyerToken)
    });
    assert(interest.res.status === 201 && interest.data.notified === true, 'Interet acheteur notifie au vendeur');

    const sellerInterestNotification = await Notification.findOne({
        where: { user_id: state.sellerId, type: 'Interet Offre' }
    });
    assert(Boolean(sellerInterestNotification), 'Notification interet visible pour vendeur');

    const duplicateInterest = await request(`/trades/${state.tradeId}/interest`, {
        method: 'POST',
        headers: authHeaders(state.buyerToken)
    });
    assert(
        duplicateInterest.res.ok && duplicateInterest.data.notified === false,
        'Interet acheteur non duplique'
    );

    const intruderMessages = await request(`/messages/${state.roomId}`, { headers: authHeaders(state.intruderToken) });
    assert(intruderMessages.res.status === 403, 'Intrus refusé sur conversation', `status=${intruderMessages.res.status}`);

    const buyerMessage = await request(`/messages/${state.roomId}`, {
        method: 'POST',
        headers: authHeaders(state.buyerToken),
        body: JSON.stringify({ content: `Bonjour ${TEST_RUN_ID}` })
    });
    assert(buyerMessage.res.status === 201, 'Acheteur envoie un message de négociation', `status=${buyerMessage.res.status}`);

    const sellerConversations = await request('/messages/conversations', { headers: authHeaders(state.sellerToken) });
    assert(
        sellerConversations.res.ok && sellerConversations.data.some((conversation) => conversation.room_id === state.roomId),
        'Conversation visible par le vendeur'
    );

    const interestedBuyers = await request(`/trades/${state.tradeId}/interested-buyers`, {
        headers: authHeaders(state.sellerToken)
    });
    assert(
        interestedBuyers.res.ok && interestedBuyers.data.some((candidate) => candidate.id === state.buyerId),
        'Acheteur intéressé détecté via messages'
    );

    const buyerInterestedAccess = await request(`/trades/${state.tradeId}/interested-buyers`, {
        headers: authHeaders(state.buyerToken)
    });
    assert(buyerInterestedAccess.res.status === 404, 'Acheteur ne consulte pas les acheteurs intéressés vendeur');

    await testSocketFlow();

    const beforeNegotiationTitre = await Titre.findByPk(state.titreCode);
    const negotiation = await request(`/trades/${state.tradeId}/status`, {
        method: 'PUT',
        headers: authHeaders(state.sellerToken),
        body: JSON.stringify({ statut: 'En cours de négociation' })
    });
    assert(negotiation.res.ok && negotiation.data.statut === 'En cours de négociation', 'Passage en négociation');

    const afterNegotiationTitre = await Titre.findByPk(state.titreCode);
    assert(
        Number(afterNegotiationTitre.quantite_titre) === Number(beforeNegotiationTitre.quantite_titre) - 10,
        'Stock déduit au passage en négociation',
        `${beforeNegotiationTitre.quantite_titre}->${afterNegotiationTitre.quantite_titre}`
    );

    const sale = await request(`/trades/${state.tradeId}/status`, {
        method: 'PUT',
        headers: authHeaders(state.sellerToken),
        body: JSON.stringify({
            statut: 'Vendu',
            buyer_id: state.buyerId,
            prix_pourcentage: 99,
            quantite: 8
        })
    });
    assert(sale.res.ok && sale.data.statut === 'Vendu', 'Vente validée à un acheteur ayant négocié');

    const notification = await Notification.findOne({ where: { user_id: state.buyerId, type: 'Trade Vendu' } });
    assert(Boolean(notification), 'Notification créée pour acheteur');

    const buyerNotifications = await request('/notifications', { headers: authHeaders(state.buyerToken) });
    assert(
        buyerNotifications.res.ok && buyerNotifications.data.some((item) => item.type === 'Trade Vendu'),
        'Notification visible via API'
    );

    const adminTrades = await request('/trades/admin/all', { headers: authHeaders(state.adminToken) });
    assert(adminTrades.res.ok && adminTrades.data.some((trade) => trade.id === state.tradeId), 'Admin voit le registre des annonces');

    const adminStats = await request('/trades/admin/stats', { headers: authHeaders(state.adminToken) });
    assert(adminStats.res.ok && typeof adminStats.data.annoncesActives !== 'undefined', 'Admin voit les KPI');

    const adminUsers = await request('/trades/admin/users', { headers: authHeaders(state.adminToken) });
    assert(adminUsers.res.ok && adminUsers.data.some((user) => user.id === state.sellerId), 'Admin voit les utilisateurs');
};

run()
    .then(async () => {
        if (cleanupEnabled) {
            await cleanup();
        }
        await sequelize.close();
        await stopTestServer();
        console.log(`\n${results.length} contrôles passés.`);
        process.exit(0);
    })
    .catch(async (error) => {
        console.error('\nBusiness flow test failed:', error.message);
        if (cleanupEnabled) {
            await cleanup();
        }
        await sequelize.close();
        await stopTestServer();
        process.exit(1);
    });
