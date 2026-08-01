const SHEET_ID = '1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk';
fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=FLOTA`)
  .then(r => r.text())
  .then(csv => {
    const lines = csv.split(/\r?\n/).slice(1);
    const flotaInternos = new Set();
    for (const l of lines) {
      const cols = l.split(',').map(c => c.replace(/"/g, '').trim());
      if (cols[0]) {
        flotaInternos.add(cols[0]);
      }
    }
    console.log('Total internos in Google Sheets FLOTA:', flotaInternos.size);
    const sorted = [...flotaInternos].sort((a,b) => (parseInt(a,10)||0) - (parseInt(b,10)||0));
    console.log('Internos list in Google Sheets FLOTA:\n', sorted.join(', '));
  }).catch(console.error);
