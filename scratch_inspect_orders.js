async function inspect() {
  try {
    const res = await fetch('https://app-taxes-production.up.railway.app/api/orders');
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Orders count:", data.length);
    if (data.length > 0) {
      console.log("First order:", JSON.stringify(data[0], null, 2));
    }
  } catch (err) {
    console.error("Error:", err);
  }
}
inspect();
