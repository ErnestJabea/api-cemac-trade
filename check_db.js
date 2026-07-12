const { sequelize, User, Trade } = require('./src/models/index');

async function testQuery() {
    try {
        await sequelize.authenticate();
        const users = await User.count();
        const trades = await Trade.count();
        console.log(`Users: ${users}, Trades: ${trades}`);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}
testQuery();
