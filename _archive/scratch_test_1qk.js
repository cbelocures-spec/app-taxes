const sheetId = '1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk';
const namesToTest = ['Unidadaes Livianas', 'Unidades Livianas', 'UnidadaesLivianas', 'UnidadesLivianas', 'preventivo x hora'];

async function testSheet() {
  for (const name of namesToTest) {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
    try {
      const r = await fetch(url);
      const csv = await r.text();
      if (r.ok && !csv.includes('<!DOCTYPE') && !csv.includes('html>')) {
        console.log(`SUCCESS in 1QK... with sheet name "${name}":`);
        console.log(csv.slice(0, 400));
      } else {
        console.log(`Failed in 1QK... "${name}": HTTP ${r.status}`);
      }
    } catch (e) {
      console.log(`Error "${name}":`, e.message);
    }
  }
}
testSheet();
