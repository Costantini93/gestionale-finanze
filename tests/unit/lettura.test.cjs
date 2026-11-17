// Controlli automatici sulla lettura dei file e sulle categorie (node --test tests/unit/).
// Girano in Node senza installare niente: usano gli stessi file js/ dell'app.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const Parser = require(path.join(root, 'js/parser.js'));
const Categories = require(path.join(root, 'js/categories.js'));
const Detector = require(path.join(root, 'js/detector.js'));
const XLSX = require(path.join(root, 'lib/xlsx.full.min.js'));

test('importi in formato italiano', () => {
  assert.equal(Parser.parseAmount('1.234,56'), 1234.56);
  assert.equal(Parser.parseAmount('-19,99'), -19.99);
  assert.equal(Parser.parseAmount('19,99 €'), 19.99);
  assert.equal(Parser.parseAmount(-20), -20);
  assert.equal(Parser.parseAmount('abc'), null);
});

test('date: testo italiano, ISO e numero di serie di Excel', () => {
  assert.equal(Parser.parseDate('14/11/2026'), '2026-11-14');
  assert.equal(Parser.parseDate('2026-11-14'), '2026-11-14');
  assert.equal(Parser.parseDate(46340), '2026-11-14');
});

// Righe come nell'esportazione "Lista movimenti" di Intesa: intestazione, stato e categoria della banca
const intesa = [
  ['', 'I movimenti selezionati sono:', 3],
  ['Data', 'Operazione', 'Dettagli', 'Conto o carta', 'Contabilizzazione', 'Categoria ', 'Valuta', 'Importo'],
  [46340, 'Pagamento Pos', 'Glovo Vemlcxqd1', 'Conto', 'NON CONTABILIZZATO', 'Altre uscite', 'EUR', -9.53],
  [46339, 'Pagamento Pos', 'Farmacia Centrale', 'Conto', 'CONTABILIZZATO', 'Spese mediche', 'EUR', -12.4],
  [46338, 'Bonifico A Vostro Favore', 'Stipendio Ottobre', 'Conto', 'CONTABILIZZATO', 'Stipendi e pensioni', 'EUR', 1850],
];

test('esportazione Intesa: definitivi, spese in sospeso e categoria della banca', () => {
  const tx = Parser.rowsToTransactions(intesa);
  assert.equal(tx.declared, 3);
  assert.equal(tx.hasStatus, true);
  assert.equal(tx.length, 2, 'due movimenti contabilizzati');
  assert.equal(tx.pending, 1, 'una spesa in sospeso');
  assert.equal(tx.pendingTx[0].amount, -9.53);
  assert.match(tx.pendingTx[0].desc, /Glovo/);
  assert.equal(tx[0].bankCat, 'Spese mediche');
  assert.equal(tx[1].amount, 1850);
});

test('Excel che dichiara un\'area più piccola di quella reale: si leggono tutte le righe', () => {
  const rows = [['Data', 'Descrizione', 'Importo']];
  for (let i = 0; i < 50; i++) rows.push([`${String(i % 28 + 1).padStart(2, '0')}/10/2026`, 'Spesa ' + i, -(i + 1)]);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!ref'] = 'A1:C3';                                     // come la "Lista movimenti" di Intesa (A1:J33)
  assert.equal(XLSX.utils.sheet_to_json(ws, { header: 1 }).length, 3, 'senza correzione la libreria si ferma');
  Parser.fixSheetRange(ws, XLSX.utils);
  const tx = Parser.rowsToTransactions(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }));
  assert.equal(tx.length, 50);
});

test('CSV di esempio: 46 movimenti', () => {
  const fs = require('node:fs');
  const text = fs.readFileSync(path.join(root, 'tests/fixtures/estratto-esempio.csv'), 'utf8');
  const tx = Parser.rowsToTransactions(Parser.parseCSV(text));
  assert.equal(tx.length, 46);
  assert.ok(tx.every(t => /^\d{4}-\d{2}-\d{2}$/.test(t.date) && typeof t.amount === 'number' && t.desc));
});

test('categorie: esercenti conosciuti', () => {
  const cat = d => Categories.categorize(Detector.normalize(d));
  assert.equal(cat('Pagamento Pos - Glovo Vemlcxqd1'), 'delivery');
  assert.equal(cat('Addebito Diretto - Nome Acque Veronesi S.c.a'), 'bollette');
  assert.equal(cat('Addebito Diretto - Nome Magis Energia S P A'), 'bollette');
});

test('categoria della banca usata solo quando serve', () => {
  assert.equal(Categories.fromBank('Spese mediche', false), 'salute');
  assert.equal(Categories.fromBank('Tabaccai e simili', false), 'tabacchi');
  assert.equal(Categories.fromBank('Carburanti', false), 'trasporti');
  assert.equal(Categories.fromBank('Altre uscite', false), null, 'le voci generiche non cambiano niente');
  assert.equal(Categories.fromBank('Domiciliazioni e Utenze', false), null);
  assert.equal(Categories.fromBank('Stipendi e pensioni', true), 'stipendio');
});

test('giorni fra due date', () => {
  assert.equal(Detector.daysBetween('2026-11-10', '2026-11-17'), 7);
  assert.equal(Detector.daysBetween('2026-02-27', '2026-03-01'), 2);
});
