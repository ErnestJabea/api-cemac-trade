const { User } = require('../models/index');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { sendMail } = require('../utils/mailer');
const { authMiddleware } = require('../middlewares/authMiddleware');
const { buildOtpAuthUrl, generateMfaSecret, verifyTotp } = require('../utils/totp');

const isTruthyFlag = (value) => value === true || value === 1 || value === '1' || value === 'true';

const isMfaEnabledForUser = (user) => {
    if (!user) return false;
    const value = typeof user.get === 'function' ? user.get('mfa_enabled') : user.mfa_enabled;
    return isTruthyFlag(value);
};

const sanitizeUser = (user) => ({
    id: user.id,
    public_identity: { pseudo_anonyme: user.pseudo_anonyme },
    role: user.role,
    mfa_enabled: isMfaEnabledForUser(user)
});

const createAccessToken = (user) => jwt.sign(
    { id: user.id, role: user.role, pseudo: user.pseudo_anonyme, purpose: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
);

const createMfaToken = (user) => jwt.sign(
    { id: user.id, purpose: 'mfa' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
);

const verifyCurrentPassword = async (user, currentPassword) => {
    if (!currentPassword) return false;
    return bcrypt.compare(currentPassword, user.password);
};

const getFrontendBaseUrl = () => {
    return String(process.env.FRONTEND_URL || 'https://cemac-trade.e-jabbing.net')
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)[0];
};

const hashResetToken = (token) => crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

module.exports = async function (fastify, opts) {
    fastify.post('/register', async (request, reply) => {
        let newUser = null;
        try {
            const { nom, prenom, email, telephone, pseudo_anonyme, password } = request.body;

            // Basic validation
            if (!email || !password || !pseudo_anonyme || !nom) {
                return reply.code(400).send({ error: 'Missing required fields' });
            }

            if (String(password).length < 8) {
                return reply.code(400).send({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
            }

            // Check if user exists
            const existingUser = await User.findOne({
                where: {
                    [require('sequelize').Op.or]: [
                        { email },
                        { pseudo_anonyme }
                    ]
                }
            });

            if (existingUser) {
                return reply.code(400).send({ error: 'User with this email or pseudo already exists' });
            }

            // Hash password
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);

            // Add verification token logic
            const verificationToken = crypto.randomBytes(32).toString('hex');

            // Create user
            newUser = await User.create({
                nom,
                prenom,
                email,
                telephone,
                pseudo_anonyme,
                password: hashedPassword,
                verification_token: verificationToken,
                is_verified: false
            });

            // Send Verification Email
            const frontendUrl = getFrontendBaseUrl();
            const verifyLink = `${frontendUrl}/login?verify=${verificationToken}`;
            const mailHtml = `
                <h2>Bienvenue sur CEMAC Trade</h2>
                <p>Afin d'activer votre compte, veuillez cliquer sur le lien ci-dessous :</p>
                <a href="${verifyLink}" style="padding: 10px; background: #8c52ff; color: white; text-decoration: none; border-radius: 5px;">Vérifier mon Email</a>
                <p>Si le bouton ne fonctionne pas, copiez ce lien : ${verifyLink}</p>
            `;
            await sendMail(email, 'Vérification de votre compte CEMAC Trade', mailHtml);

            return reply.code(201).send({
                message: 'Utilisateur enregistré avec succès. Veuillez vérifier votre adresse email pour activer votre compte.',
                user: sanitizeUser(newUser)
            });
        } catch (error) {
            fastify.log.error(error);
            if (newUser && !newUser.is_verified) {
                await newUser.destroy().catch((cleanupError) => fastify.log.error(cleanupError));
            }
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.post('/verify', async (request, reply) => {
        try {
            const { token } = request.body;
            if (!token) return reply.code(400).send({ error: 'Token manquant' });

            const user = await User.findOne({ where: { verification_token: token } });
            if (!user) return reply.code(400).send({ error: 'Jeton de vérification invalide ou expiré.' });

            user.is_verified = true;
            user.verification_token = null;
            await user.save();

            return reply.send({ message: 'Email vérifié avec succès. Vous pouvez maintenant vous connecter.' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.post('/password/forgot', async (request, reply) => {
        try {
            const { email } = request.body;
            const genericMessage = 'Si un compte correspond a cet email, un lien de reinitialisation a ete envoye.';

            if (!email) {
                return reply.send({ message: genericMessage });
            }

            const user = await User.findOne({ where: { email } });
            if (!user) {
                return reply.send({ message: genericMessage });
            }

            const resetToken = crypto.randomBytes(32).toString('hex');
            user.password_reset_token = hashResetToken(resetToken);
            user.password_reset_expires_at = new Date(Date.now() + 30 * 60 * 1000);
            await user.save();

            const resetLink = `${getFrontendBaseUrl()}/reset-password?token=${resetToken}`;
            const mailHtml = `
                <h2>Reinitialisation du mot de passe</h2>
                <p>Vous avez demande la modification de votre mot de passe CEMAC Trade.</p>
                <p>Ce lien expire dans 30 minutes.</p>
                <a href="${resetLink}" style="padding: 10px; background: #491d00; color: white; text-decoration: none; border-radius: 5px;">Modifier mon mot de passe</a>
                <p>Si le bouton ne fonctionne pas, copiez ce lien : ${resetLink}</p>
                <p>Si vous n'etes pas a l'origine de cette demande, ignorez cet email.</p>
            `;

            await sendMail(user.email, 'CEMAC Trade - Reinitialisation du mot de passe', mailHtml);
            return reply.send({ message: genericMessage });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.post('/password/reset', async (request, reply) => {
        try {
            const { token, new_password } = request.body;

            if (!token || !new_password) {
                return reply.code(400).send({ error: 'Token et nouveau mot de passe requis' });
            }

            if (String(new_password).length < 8) {
                return reply.code(400).send({ error: 'Le nouveau mot de passe doit contenir au moins 8 caracteres' });
            }

            const user = await User.findOne({
                where: {
                    password_reset_token: hashResetToken(token),
                    password_reset_expires_at: { [Op.gt]: new Date() }
                }
            });

            if (!user) {
                return reply.code(400).send({ error: 'Lien de reinitialisation invalide ou expire' });
            }

            const isSamePassword = await bcrypt.compare(new_password, user.password);
            if (isSamePassword) {
                return reply.code(400).send({ error: 'Le nouveau mot de passe doit etre different de l ancien' });
            }

            user.password = await bcrypt.hash(new_password, 10);
            user.password_changed_at = new Date();
            user.password_reset_token = null;
            user.password_reset_expires_at = null;
            await user.save();

            return reply.send({ message: 'Mot de passe modifie avec succes. Vous pouvez vous connecter.' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.post('/login', async (request, reply) => {
        try {
            const { email, password } = request.body;

            const user = await User.findOne({ where: { email } });
            if (!user) {
                return reply.code(401).send({ error: 'Identifiants invalides' });
            }

            if (!user.is_verified && user.role !== 'admin') {
                return reply.code(403).send({ error: 'Un mail de verification a été envoyé à votre adresse email. Veuillez vérifier votre adresse email avant de vous connecter.' });
            }

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return reply.code(401).send({ error: 'Identifiants invalides' });
            }

            if (isMfaEnabledForUser(user)) {
                return reply.send({
                    mfa_required: true,
                    mfa_token: createMfaToken(user),
                    message: 'Code MFA requis'
                });
            }

            const token = createAccessToken(user);

            return reply.send({
                token,
                user: sanitizeUser(user)
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.post('/login/mfa', async (request, reply) => {
        try {
            const { mfa_token, code } = request.body;
            if (!mfa_token || !code) {
                return reply.code(400).send({ error: 'Jeton MFA et code requis' });
            }

            let decoded;
            try {
                decoded = jwt.verify(mfa_token, process.env.JWT_SECRET);
            } catch {
                return reply.code(401).send({ error: 'Session MFA expiree. Reconnectez-vous.' });
            }

            if (decoded.purpose !== 'mfa') {
                return reply.code(401).send({ error: 'Jeton MFA invalide' });
            }

            const user = await User.findByPk(decoded.id);
            if (!user || !isMfaEnabledForUser(user) || !user.mfa_secret) {
                return reply.code(401).send({ error: 'MFA non disponible pour ce compte' });
            }

            if (!verifyTotp(user.mfa_secret, code)) {
                return reply.code(401).send({ error: 'Code MFA invalide' });
            }

            return reply.send({
                token: createAccessToken(user),
                user: sanitizeUser(user)
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.get('/me/security', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const user = await User.findByPk(request.user.id);
            if (!user) return reply.code(404).send({ error: 'Utilisateur introuvable' });

            return reply.send({
                email: user.email,
                pseudo_anonyme: user.pseudo_anonyme,
                role: user.role,
                mfa_enabled: isMfaEnabledForUser(user),
                mfa_enabled_at: user.mfa_enabled_at,
                password_changed_at: user.password_changed_at
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.put('/password', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const { current_password, new_password } = request.body;
            const user = await User.findByPk(request.user.id);
            if (!user) return reply.code(404).send({ error: 'Utilisateur introuvable' });

            if (!(await verifyCurrentPassword(user, current_password))) {
                return reply.code(401).send({ error: 'Mot de passe actuel invalide' });
            }

            if (String(new_password || '').length < 8) {
                return reply.code(400).send({ error: 'Le nouveau mot de passe doit contenir au moins 8 caracteres' });
            }

            const isSamePassword = await bcrypt.compare(new_password, user.password);
            if (isSamePassword) {
                return reply.code(400).send({ error: 'Le nouveau mot de passe doit etre different de l ancien' });
            }

            user.password = await bcrypt.hash(new_password, 10);
            user.password_changed_at = new Date();
            await user.save();

            return reply.send({ message: 'Mot de passe modifie avec succes' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.post('/mfa/setup', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const { current_password } = request.body;
            const user = await User.findByPk(request.user.id);
            if (!user) return reply.code(404).send({ error: 'Utilisateur introuvable' });

            if (isMfaEnabledForUser(user)) {
                return reply.code(400).send({ error: 'Le MFA est deja active sur ce compte' });
            }

            if (!(await verifyCurrentPassword(user, current_password))) {
                return reply.code(401).send({ error: 'Mot de passe actuel invalide' });
            }

            const secret = generateMfaSecret();
            user.mfa_secret = secret;
            user.mfa_enabled = false;
            user.mfa_enabled_at = null;
            await user.save();

            return reply.send({
                secret,
                otpauth_url: buildOtpAuthUrl({ secret, email: user.email })
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.post('/mfa/enable', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const { current_password, code } = request.body;
            const user = await User.findByPk(request.user.id);
            if (!user) return reply.code(404).send({ error: 'Utilisateur introuvable' });

            if (!(await verifyCurrentPassword(user, current_password))) {
                return reply.code(401).send({ error: 'Mot de passe actuel invalide' });
            }

            if (!user.mfa_secret) {
                return reply.code(400).send({ error: 'Generez d abord une cle MFA' });
            }

            if (!verifyTotp(user.mfa_secret, code)) {
                return reply.code(401).send({ error: 'Code MFA invalide' });
            }

            user.mfa_enabled = true;
            user.mfa_enabled_at = new Date();
            await user.save();

            return reply.send({
                message: 'MFA active avec succes',
                user: sanitizeUser(user)
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });

    fastify.post('/mfa/disable', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            const { current_password, code } = request.body;
            const user = await User.findByPk(request.user.id);
            if (!user) return reply.code(404).send({ error: 'Utilisateur introuvable' });

            if (!isMfaEnabledForUser(user)) {
                return reply.code(400).send({ error: 'Le MFA est deja desactive' });
            }

            if (!(await verifyCurrentPassword(user, current_password))) {
                return reply.code(401).send({ error: 'Mot de passe actuel invalide' });
            }

            if (!verifyTotp(user.mfa_secret, code)) {
                return reply.code(401).send({ error: 'Code MFA invalide' });
            }

            user.mfa_enabled = false;
            user.mfa_secret = null;
            user.mfa_enabled_at = null;
            await user.save();

            return reply.send({
                message: 'MFA desactive avec succes',
                user: sanitizeUser(user)
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Erreur interne du serveur' });
        }
    });
};
