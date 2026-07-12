const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'src', 'routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

files.forEach(file => {
    const fullPath = path.join(routesDir, file);
    let content = fs.readFileSync(fullPath, 'utf8');
    content = content.replace(/Internal Server Error/g, 'Erreur interne du serveur');
    fs.writeFileSync(fullPath, content);
});
console.log('Translations updated in routes.');
