async function test() {
  const url = 'https://script.google.com/macros/s/AKfycbyoHEhogBxWcSIdDtzzUIV9mhzO25TNAChgBlCCJbuHPIylXNpIpX8LKM6qc4DQjij8/exec?accion=get_state';
  try {
    console.log("Fetching URL de Parte Taller:", url);
    const res = await fetch(url);
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response text start:", text.substring(0, 1000));
  } catch (err) {
    console.error("Fetch error:", err);
  }
}
test();
