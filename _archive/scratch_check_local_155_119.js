const fs = require('fs');

if (fs.existsSync('db.json')) {
  const data = JSON.parse(fs.readFileSync('db.json', 'utf8'));
  const o155 = (data.workOrders || []).find(o => String(o.interno) === '155');
  const o119 = (data.workOrders || []).find(o => String(o.interno) === '119');

  console.log("=== LOCAL DB ORDER 155 ===");
  if (o155) {
    console.log(`ID: ${o155.id}, Interno: ${o155.interno}, Archived: ${o155.archived}`);
    (o155.tasks || []).forEach((t, i) => {
      console.log(`  Task #${i+1}: Emp=${t.empleado}, Status=${t.status}, Desc=${t.descripcion}`);
    });
  } else {
    console.log("Order 155 not found in local db.json");
  }

  console.log("\n=== LOCAL DB ORDER 119 ===");
  if (o119) {
    console.log(`ID: ${o119.id}, Interno: ${o119.interno}, Archived: ${o119.archived}`);
    (o119.tasks || []).forEach((t, i) => {
      console.log(`  Task #${i+1}: Emp=${t.empleado}, Status=${t.status}, Desc=${t.descripcion}`);
    });
  } else {
    console.log("Order 119 not found in local db.json");
  }
}
