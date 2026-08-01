const scriptUrl = 'https://script.google.com/macros/s/AKfycbwuPIslBnq77dG5bhk19h2H2s9TlOeB6XrCpqCMDX-8dvO8uisNRdx7P43lyJtT1sZIgQ/exec';
const actions = ['getLivianasData', 'getUnidadesLivianas', 'getLivianas', 'getRawSheets'];

async function test() {
  for (const act of actions) {
    try {
      const r = await fetch(scriptUrl + '?accion=' + act);
      const text = await r.text();
      try {
        const json = JSON.parse(text);
        console.log(act, 'JSON:', Array.isArray(json) ? `Array[${json.length}]` : json);
      } catch (e) {
        console.log(act, 'TEXT snippet:', text.slice(0, 150));
      }
    } catch (err) {
      console.log(act, 'ERR:', err.message);
    }
  }
}
test();
