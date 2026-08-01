const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

const username = db.settings.username;
const password = db.settings.password;
const portalUrl = db.settings.portalUrl;

console.log("Credentials read from db.json:");
console.log(`- Portal: ${portalUrl}`);
console.log(`- Username: ${username}`);
console.log(`- Password length: ${password ? password.length : 0}`);

if (!username || !password) {
  console.error("Missing credentials in db.json");
  process.exit(1);
}

(async () => {
  console.log("Launching Chrome...");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`Navigating to ${portalUrl}/admin ...`);
    await page.goto(`${portalUrl}/admin`, { waitUntil: 'networkidle2' });

    console.log("Current URL after goto:", page.url());

    // Check if password input is visible
    const hasPassword = await page.$('input[type="password"]');
    if (hasPassword) {
      console.log("Password input found, attempting login...");
      
      const inputs = await page.$$('input');
      let usernameFilled = false;
      let passwordFilled = false;

      for (const input of inputs) {
        const type = await page.evaluate(el => el.type, input);
        const name = await page.evaluate(el => el.name || '', input);
        
        if ((type === 'text' || type === 'email' || name.includes('email') || name.includes('user')) && !usernameFilled) {
          await input.focus();
          await page.evaluate(el => el.value = '', input);
          await input.type(username);
          usernameFilled = true;
          console.log(`Filled username: ${username}`);
        } else if ((type === 'password' || name.includes('pass')) && !passwordFilled) {
          await input.focus();
          await page.evaluate(el => el.value = '', input);
          await input.type(password);
          passwordFilled = true;
          console.log("Filled password.");
        }
      }

      console.log("Clicking submit button...");
      const submitClicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const t = b.textContent.toLowerCase();
          return t.includes('iniciar') || t.includes('ingresar') || t.includes('login');
        });
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!submitClicked) {
        console.log("Submit button not found, pressing Enter key...");
        await page.keyboard.press('Enter');
      }

      console.log("Waiting for navigation after click/enter...");
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => console.log("Navigation wait finished/timeout:", e.message));

      console.log("Current URL after login:", page.url());
      
      // Take screenshot of current page
      const screenshotPath = path.join(__dirname, 'login_result.png');
      await page.screenshot({ path: screenshotPath });
      console.log(`Screenshot saved to ${screenshotPath}`);

      const bodyText = await page.evaluate(() => document.body.textContent.toLowerCase());
      const hasError = bodyText.includes('credenciales inv') ||
                       bodyText.includes('credenciales incorrecta') ||
                       bodyText.includes('usuario o contrase') ||
                       bodyText.includes('datos incorrectos');

      if (hasError) {
        console.log("Login failed: error text found on page.");
      } else {
        console.log("Login seems successful!");
      }

    } else {
      console.log("No password input found, check page content:");
      const bodyHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 500));
      console.log(bodyHTML);
    }

  } catch (err) {
    console.error("Error running login script:", err);
  } finally {
    await browser.close();
  }
})();
