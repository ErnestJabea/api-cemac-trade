const { DataTypes } = require('sequelize');

const addColumnIfMissing = async (queryInterface, tableDescription, tableName, columnName, definition) => {
    if (tableDescription[columnName]) return;
    await queryInterface.addColumn(tableName, columnName, definition);
};

const ensureSecurityColumns = async (sequelize) => {
    const queryInterface = sequelize.getQueryInterface();
    const tableName = 'Users';

    try {
        const tableDescription = await queryInterface.describeTable(tableName);

        await addColumnIfMissing(queryInterface, tableDescription, tableName, 'mfa_enabled', {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false
        });

        await addColumnIfMissing(queryInterface, tableDescription, tableName, 'mfa_secret', {
            type: DataTypes.STRING,
            allowNull: true
        });

        await addColumnIfMissing(queryInterface, tableDescription, tableName, 'mfa_enabled_at', {
            type: DataTypes.DATE,
            allowNull: true
        });

        await addColumnIfMissing(queryInterface, tableDescription, tableName, 'password_changed_at', {
            type: DataTypes.DATE,
            allowNull: true
        });

        await addColumnIfMissing(queryInterface, tableDescription, tableName, 'password_reset_token', {
            type: DataTypes.STRING,
            allowNull: true
        });

        await addColumnIfMissing(queryInterface, tableDescription, tableName, 'password_reset_expires_at', {
            type: DataTypes.DATE,
            allowNull: true
        });
    } catch (error) {
        if (error?.original?.code === 'ER_NO_SUCH_TABLE') {
            console.warn(`Security schema check skipped: ${error.message}`);
            return;
        }
        throw error;
    }
};

module.exports = { ensureSecurityColumns };
