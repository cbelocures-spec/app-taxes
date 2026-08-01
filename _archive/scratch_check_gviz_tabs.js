const sheetId = '1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk';

async function checkGviz() {
  const tabNames = ['Unidadaes Livianas', 'Unidadaes Livianas ', 'Unidades Livianas', 'FLOTA'];
  for (const tab of tabNames) {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
    const res = await fetch(url);
    const text = await res.text();
    console.log(`Tab [${tab}]:`, text.slice(0, 100).replace(/\r?\n/g, ' '));
  }
}

checkGviz();
