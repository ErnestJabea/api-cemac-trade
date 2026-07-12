const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buffer) => {
    let bits = '';
    let output = '';

    for (const byte of buffer) {
        bits += byte.toString(2).padStart(8, '0');
    }

    for (let i = 0; i < bits.length; i += 5) {
        const chunk = bits.slice(i, i + 5).padEnd(5, '0');
        output += BASE32_ALPHABET[parseInt(chunk, 2)];
    }

    return output;
};

const base32Decode = (secret) => {
    const cleanSecret = String(secret || '')
        .replace(/\s+/g, '')
        .replace(/=+$/g, '')
        .toUpperCase();
    let bits = '';

    for (const char of cleanSecret) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) {
            throw new Error('Secret MFA invalide');
        }
        bits += value.toString(2).padStart(5, '0');
    }

    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }

    return Buffer.from(bytes);
};

const generateMfaSecret = () => base32Encode(crypto.randomBytes(20));

const buildOtpAuthUrl = ({ secret, email, issuer = 'CEMAC Trade' }) => {
    const label = `${issuer}:${email}`;
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30'
    });

    return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
};

const generateTotp = (secret, counter) => {
    const key = base32Decode(secret);
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buffer.writeUInt32BE(counter % 0x100000000, 4);

    const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = ((hmac[offset] & 0x7f) << 24)
        | ((hmac[offset + 1] & 0xff) << 16)
        | ((hmac[offset + 2] & 0xff) << 8)
        | (hmac[offset + 3] & 0xff);

    return String(binary % 1000000).padStart(6, '0');
};

const timingSafeEqualString = (left, right) => {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));

    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyTotp = (secret, code, { window = 1, step = 30 } = {}) => {
    const cleanCode = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanCode)) return false;

    const currentCounter = Math.floor(Date.now() / 1000 / step);

    for (let offset = -window; offset <= window; offset += 1) {
        const expected = generateTotp(secret, currentCounter + offset);
        if (timingSafeEqualString(expected, cleanCode)) return true;
    }

    return false;
};

module.exports = {
    buildOtpAuthUrl,
    generateMfaSecret,
    verifyTotp
};
