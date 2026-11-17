// Prova dell'app vera nel browser (Playwright): accesso con la lampada, caricamento dell'estratto conto,
// doppioni scartati, budget di oggi, pagine senza scorrimento orizzontale sul telefono.
// Uso: servire la cartella del progetto su http://localhost:8765 e poi "node tests/e2e/app.mjs".
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const csv = path.join(here, '..', 'fixtures', 'estratto-esempio.csv');
const U = process.env.APP_URL || 'http://localhost:8765/index.html';
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'NO  '} ${msg}`); if (!ok) failed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(U);
check(await page.isHidden('#lockForm'), 'all\'apertura la lampada è spenta e il modulo nascosto');
await page.click('#lampCord');
await page.waitForTimeout(400);
check(await page.isVisible('#lockForm'), 'tirando la cordicella compare il modulo della password');
await page.fill('#lockPw', 'provaprova1');
await page.fill('#lockPw2', 'provaprova1');
await page.click('#lockBtn');
await page.waitForSelector('body:not(.locked)', { timeout: 30000 });
check(true, 'password creata, si entra nell\'app');

await page.goto(U + '#/carica');
await page.setInputFiles('#file', csv);
await page.waitForFunction(() => /movimenti/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
const first = await page.textContent('#status');
check(/46 movimenti/.test(first), `primo caricamento: 46 movimenti (${first.replace(/\s+/g, ' ').slice(0, 80)})`);
await page.setInputFiles('#file', csv);
await page.waitForFunction(() => /già presenti/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
const second = await page.textContent('#status');
check(/46 già presenti, ignorati/.test(second), 'stesso file caricato di nuovo: 46 già presenti, ignorati');

await page.goto(U + '#/dashboard');
await page.fill('#tdSetupBalance', '842,30');
await page.click('#tdSetupForm button');
await page.waitForSelector('.td-hero', { timeout: 5000 });
check(/€/.test(await page.textContent('.td-hero')), 'con il saldo compare il numero di oggi');
check(await page.isVisible('#tdForecast'), 'compare la previsione fino allo stipendio');

const pages = await page.$$eval('.page', ps => ps.map(p => p.dataset.page));
const wide = [];
for (const p of pages) {
  await page.goto(U + '#/' + p);
  await page.waitForTimeout(120);
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 390) wide.push(`${p} (${w}px)`);
}
check(!wide.length, `nessuna pagina scorre di lato a 390px${wide.length ? ': ' + wide.join(', ') : ''}`);
check(!errors.length, `nessun errore nella console${errors.length ? ': ' + errors.join(' | ') : ''}`);

await browser.close();
console.log(failed ? `\n${failed} controlli non superati` : '\nTutti i controlli superati');
process.exit(failed ? 1 : 0);
