const fs = require('fs');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const raw = fs.readFileSync(dbFile, 'utf8');
  const dbData = JSON.parse(raw);

  if (dbData.settings) {
    dbData.settings.username = "paniol@contenedoreshugo.com.ar";
    dbData.settings.password = "Paniol2015";
    dbData.settings.geminiApiKey = "";
    dbData.settings.claudeApiKey = "";
    dbData.settings.anthropicApiKey = "";
    dbData.settings.openaiApiKey = "";
  }

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
  console.log("✅ Completely cleared all API keys and kept Paniol2015 password!");
}
