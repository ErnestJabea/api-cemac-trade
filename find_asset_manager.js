const { User } = require('./src/models/index');
async function findAllUsers() {
    const users = await User.findAll();
    users.forEach(u => console.log(`Email: ${u.email}, Role: ${u.role}, Pseudo: ${u.pseudo_anonyme}`));
}
findAllUsers().then(() => process.exit());
