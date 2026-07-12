const nodemailer = require('nodemailer');

// For dev, using ethereal email or a simple fallback.
// In production, configure SMTP values via environment variables.

const createTransporter = async () => {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        return nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS // Must be an App Password, not the regular Gmail password
            }
        });
    } else {
        // Generate a test account if no SMTP provided
        let testAccount = await nodemailer.createTestAccount();
        return nodemailer.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass
            }
        });
    }
};

const sendMail = async (to, subject, html) => {
    const transporter = await createTransporter();
    const info = await transporter.sendMail({
        from: '"CEMAC Trade" <no-reply@cemac-trade.com>',
        to,
        subject,
        html
    });

    console.log("Message sent: %s", info.messageId);
    // If using ethereal test account, we can log the preview URL
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
        console.log("Preview URL: %s", previewUrl);
    }

    return info;
};

module.exports = { sendMail };
