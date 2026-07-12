const { User } = require('./src/models/index');

async function check() {
  const users = await User.findAll({ attributes: ['id', 'pseudo_anonyme', 'email'] });
  console.log('--- ALL USERS ---');
  users.forEach(u => console.log(JSON.stringify(u)));
}

check().then(() => process.exit());
