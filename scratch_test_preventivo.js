async function test() {
  const url = 'https://script.google.com/a/macros/contenedoreshugo.com.ar/s/AKfycbwuPIslBnq77dG5bhk19h2H2s9TlOeB6XrCpqCMDX-8dvO8uisNRdx7P43lyJtT1sZIgQ/exec?accion=getFleetData';
  try {
    console.log("Fetching url:", url);
    const res = await fetch(url);
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response text start:", text.substring(0, 1000));
  } catch (err) {
    console.error("Fetch error:", err);
  }
}
test();
