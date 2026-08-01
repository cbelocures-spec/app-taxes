const fs = require('fs');

try {
  const dbData = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  const activeOrders = (dbData.workOrders || []).filter(o => !o.archived && !o.deleted);
  const catalogs = dbData.catalogs || {};

  console.log(`=== CHECKING ${activeOrders.length} ACTIVE ORDERS FOR MISSING EMPLEADO OR CENTRO COSTO ===`);

  const missingOrders = [];

  activeOrders.forEach(o => {
    (o.tasks || []).forEach((t, idx) => {
      const empEmpty = !t.empleado || t.empleado === '' || t.empleado === '—';
      const ccEmpty = !t.centroCosto || t.centroCosto === '' || t.centroCosto === '—';

      if (empEmpty || ccEmpty) {
        missingOrders.push({
          orderId: o.id,
          otNumber: o.taxesOrderNumber || '—',
          interno: o.interno,
          rodado: o.rodado,
          taskIdx: idx + 1,
          taskDesc: t.descripcion,
          empleado: t.empleado || '(VACÍO)',
          centroCosto: t.centroCosto || '(VACÍO)',
          responsable: o.responsable,
          createdBy: o.createdBy
        });
      }
    });
  });

  console.log(`Found ${missingOrders.length} tasks with missing Empleado or Centro de Costo:`);
  console.log(JSON.stringify(missingOrders, null, 2));

} catch(e) {
  console.error("Error:", e.message);
}
