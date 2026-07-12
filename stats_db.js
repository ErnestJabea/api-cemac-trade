const { User, Trade, sequelize } = require('./src/models/index');

async function check() {
  try {
    const userCount = await User.count();
    const tradeCount = await Trade.count();
    console.log(`STATS: Users=${userCount}, Trades=${tradeCount}`);
    
    if (userCount > 0) {
      const u = await User.findOne();
      console.log('FIRST USER:', u.id, u.pseudo_anonyme);
    }
  } catch (e) {
    console.error('ERROR:', e.message);
  }
}

check().then(() => process.exit());
