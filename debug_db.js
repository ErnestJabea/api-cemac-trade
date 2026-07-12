const { User, Trade } = require('./src/models/index');

async function check() {
  const userId = '3d030c8a-0dd3-4731-9c8d-ac323e4a7fde';
  const user = await User.findByPk(userId);
  if (user) {
    console.log('USER FOUND:', { pseudo: user.pseudo_anonyme, email: user.email });
  } else {
    console.log('USER NOT FOUND IN DATABASE');
  }

  const trade = await Trade.findOne({
    where: { buyer_id: userId },
    include: [{ model: User, as: 'buyer' }]
  });
  if (trade) {
     console.log('TRADE FOUND. BUYER IN TRADE:', trade.buyer ? 'YES' : 'NO');
  } else {
     console.log('TRADE NOT FOUND');
  }
}

check().then(() => process.exit());
