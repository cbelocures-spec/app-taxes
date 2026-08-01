const sheetId = '1UdieUhcgaCDNUTk7toUGObKSySbXn1ZGS6IOio1A2lM';
const namesToTest = ['Unidadaes Livianas', 'Unidades Livianas', 'UnidadaesLivianas', 'UnidadesLivianas'];

async function testSheet() {
  for (const name of namesToTest) {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
    try {
      const r = await fetch(url);
      const csv = await r.text();
      if (r.ok && !csv.includes('<!DOCTYPE') && !csv.includes('html>')) {
        console.log(`SUCCESS with sheet name "${name}":`);
        console.log(csv.slice(0, 400));
        return;
      } else {
        console.log(`Failed "${name}": HTTP ${r.status}`);
      }
    } catch (e) {
      console.log(`Error "${name}":`, e.message);
    }
  }
}
testSheet();
