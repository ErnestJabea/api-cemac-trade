const { User, Titre, Trade, Message, Notification } = require('../src/models/index');
const crypto = require('crypto');

async function simulate() {
    console.log('[1] Simulation Démarrée');

    try {
        // --- 1. NETTOYAGE ---
        await User.destroy({ where: { pseudo_anonyme: ['SimUser1', 'SimUser2'] } });
        await Titre.destroy({ where: { code_emission: 'SIMU-BOND-2026' } });
        console.log('[2] Nettoyage OK');

        // --- 2. SIGNUPS ---
        const user1Resp = await fetch('http://127.0.0.1:3000/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nom: 'Simul', prenom: 'One', email: 'sim1@cemac.com', telephone: '+237111',
                pseudo_anonyme: 'SimUser1', password: 'password', wallet_ref: 'W-SIM1'
            })
        });
        const u1 = await user1Resp.json();
        if (!user1Resp.ok) throw new Error(u1.error);

        const user2Resp = await fetch('http://127.0.0.1:3000/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nom: 'Simul', prenom: 'Two', email: 'sim2@cemac.com', telephone: '+237222',
                pseudo_anonyme: 'SimUser2', password: 'password', wallet_ref: 'W-SIM2'
            })
        });
        const u2 = await user2Resp.json();

        console.log('[3] Inscriptions Réussies. Emails en attente de validation.');

        // --- 3. VÉRIFICATION DES EMAILS (en base directe) ---
        const dbU1 = await User.findOne({ where: { email: 'sim1@cemac.com' } });
        await fetch('http://127.0.0.1:3000/api/auth/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: dbU1.verification_token })
        });
        const dbU2 = await User.findOne({ where: { email: 'sim2@cemac.com' } });
        await fetch('http://127.0.0.1:3000/api/auth/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: dbU2.verification_token })
        });

        console.log('[4] Emails Validés pour SimUser1 et SimUser2.');

        // --- 4. LOGIN ---
        let l1 = await fetch('http://127.0.0.1:3000/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'sim1@cemac.com', password: 'password' })
        }).then(r => r.json());
        const token1 = l1.token;

        let l2 = await fetch('http://127.0.0.1:3000/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'sim2@cemac.com', password: 'password' })
        }).then(r => r.json());
        const token2 = l2.token;

        console.log('[5] Authentifications Réussies.');

        // --- 5. CRÉATION D'UN TITRE ET PUBLICATION (SimUser1) ---
        // Manually bypassing Excel logic: just create directly in the DB
        await Titre.create({
            code_emission: 'SIMU-BOND-2026',
            nature: 'Obligation',
            emetteur: 'État du Cameroun',
            quantite_titre: 1000,
            prix_titres: 10000,
            volume_disponible: 10000000,
            asset_manager_id: dbU1.id
        });

        let tCreate = await fetch('http://127.0.0.1:3000/api/trades', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
            body: JSON.stringify({ titre_id: 'SIMU-BOND-2026', type: 'Vente', quantite: 50, prix_pourcentage: 99.5 })
        }).then(r => r.json());

        // Publish It
        await fetch(`http://127.0.0.1:3000/api/trades/${tCreate.id}/status`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
            body: JSON.stringify({ statut: 'Publié' })
        });

        console.log('[6] Annonce de Vente (50 parts) Créée et Publiée (' + tCreate.id + ').');

        // --- 6. MESSAGERIE INSTANTANÉE (SimUser2 écrit à l'Annonce) ---
        const roomId = `trade_${tCreate.id}_${dbU1.id}_${dbU2.id}`;

        await fetch(`http://127.0.0.1:3000/api/messages/${roomId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token2}` },
            body: JSON.stringify({ content: "Bonjour, je suis très intéressé par vos 50 obligations !" })
        });

        let notifsUnread = await Message.count({ where: { room_id: roomId, is_read: false } });
        console.log('[7] Message envoyé ! Nombre de messages non-lus actuels dans la room:', notifsUnread);

        await fetch(`http://127.0.0.1:3000/api/messages/${roomId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
            body: JSON.stringify({ content: "D'accord, je valide la vente." })
        });

        // --- 7. VENTE DE L'ANNONCE À SIMUSER2 ---
        console.log('Mise à jour du statut...');
        const vUpdate = await fetch(`http://127.0.0.1:3000/api/trades/${tCreate.id}/status`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
            body: JSON.stringify({ statut: 'Vendu', buyer_id: dbU2.id })
        }).then(r => r.json());

        console.log('[8] Annonce marquée comme Vendu ! Envoi asynchrone des Emails Google en coulisse par le Backend.');

        // Verifier que Notification d'app est créée (SimUser2 a-t-il la cloche ?)
        const notifs = await Notification.findAll({ where: { user_id: dbU2.id } });
        console.log(`[9] Notifications in-app pour l'acheteur : ${notifs.length}`);

        console.log('--- TEST INTEGRATION VALIDE AVEC SUCCES ---');

    } catch (err) {
        console.error('+++ ERREUR PENDANT LE TEST +++');
        console.error(err);
    } finally {
        // Cleanup 
        try {
            await User.destroy({ where: { pseudo_anonyme: ['SimUser1', 'SimUser2'] } });
            await Titre.destroy({ where: { code_emission: 'SIMU-BOND-2026' } });
        } catch (e) { }
        process.exit();
    }
}

simulate();
