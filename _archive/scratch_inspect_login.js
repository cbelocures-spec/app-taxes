const puppeteer = require('puppeteer-core');

(async () => {
  console.log("Launching Chrome...");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox']
  });

  try {
    const page = await browser.newPage();
    console.log("Navigating to https://taxes.com.ar/login ...");
    await page.goto('https://taxes.com.ar/login', { waitUntil: 'networkidle2' });

    console.log("Inspecting inputs on login page:");
    const inputsInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map((el, i) => ({
        index: i,
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        className: el.className,
        outerHTML: el.outerHTML
      }));
    });

    console.log(JSON.stringify(inputsInfo, null, 2));

  } catch (err) {
    console.error("Error inspecting:", err);
  } finally {
    await browser.close();
  }
})();
