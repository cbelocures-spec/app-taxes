const worker = require('./syncWorker');

console.log("Running catalog sync...");
worker.scrapeCatalogs()
  .then(res => {
    console.log("SUCCESS:", res);
    process.exit(0);
  })
  .catch(err => {
    console.error("ERROR:", err);
    process.exit(1);
  });
