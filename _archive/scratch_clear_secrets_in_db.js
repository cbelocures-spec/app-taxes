const fs = require('fs');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const raw = fs.readFileSync(dbFile, 'utf8');
  const dbData = JSON.parse(raw);
  
  if (dbData.settings) {
    dbData.settings.geminiApiKey = "";
    dbData.settings.anthropicApiKey = "";
    dbData.settings.openaiApiKey = "";
    dbData.settings.claudeApiKey = "";
  }

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
  console.log("✅ Cleared claudeApiKey secret from db.json settings!");
}
