require('dotenv').config();
const { sendMail } = require('../src/utils/mailer');

async function testMail() {
    console.log("Sending test mail using setup in .env:");
    console.log("SMTP_USER:", process.env.SMTP_USER);
    try {
        await sendMail('ernestjabae@gmail.com', 'Test Email CEMAC Trade', '<p>Test successful!</p>');
        console.log("Mail function returned.");
    } catch (e) {
        console.error("Test mail failed:", e);
    }
}

testMail();
