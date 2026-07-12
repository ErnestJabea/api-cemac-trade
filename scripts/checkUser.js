const { User } = require('../src/models/index');

async function checkUser() {
    try {
        const user = await User.findOne({ where: { email: 'ernestjabs@gmail.com' } });
        if (user) {
            console.log("\n=============================");
            console.log("UTILISATEUR TROUVÉ EN BASE :");
            console.log("=============================");
            console.log("Email :", user.email);
            console.log("Est vérifié (is_verified) ?", user.is_verified ? "✅ OUI" : "❌ NON (en attente du clic dans le mail)");
            console.log("Token de validation :", user.verification_token);
            console.log("Date de création :", user.createdAt);
            console.log("=============================\n");

            // Checking the log to see if the mailer logged success around this time
            console.log("Recherchez dans votre console backend (node app.js) un message du type : 'Message sent: <ID>' pour confirmer le départ de l'email depuis Google.");
        } else {
            console.log("❌ Aucun utilisateur avec l'email ernestjabs@gmail.com n'a été trouvé dans la base de données. L'inscription n'est pas passée.");
        }
    } catch (err) {
        console.error("Erreur :", err);
    } finally {
        process.exit();
    }
}

checkUser();
