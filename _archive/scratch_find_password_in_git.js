const { execSync } = require('child_process');

try {
  const diffs = execSync('git log -p -n 25 db.json', { maxBuffer: 10 * 1024 * 1024 }).toString();
  const matches = diffs.match(/"password"\s*:\s*"([^"]+)"/g);
  console.log("Password matches found in git history:", matches);
} catch (e) {
  console.error(e.message);
}
