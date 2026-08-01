const fs = require('fs');

const backupFiles = fs.readdirSync('./').filter(f => f.startsWith('db_backup_'));
console.log("Found backups:", backupFiles);

let realPass = null;
for (const b of backupFiles) {
  try {
    const data = JSON.parse(fs.readFileSync(b, 'utf8'));
    if (data.settings && data.settings.password && !data.settings.password.includes("••")) {
      realPass = data.settings.password;
      console.log(`Found real password in ${b}`);
      break;
    }
  } catch(e){}
}

if (!realPass) {
  // Check if we can search git log for settings.password
  console.log("No unmasked password found in backups, checking settings...");
} else {
  const dbData = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  dbData.settings.password = realPass;
  fs.writeFileSync('./db.json', JSON.stringify(dbData, null, 2));
  console.log("✅ Restored real password in db.json!");
}
