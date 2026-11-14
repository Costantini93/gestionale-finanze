// Trasforma il contenuto di un estratto conto (CSV / Excel / PDF) in una lista di movimenti:
//   { date: 'YYYY-MM-DD', desc: 'testo', amount: -19.99 }   (negativo = uscita)
(function (root) {
  // ---------- Importi e date ----------

  // Accetta "1.234,56", "-19,99", "19,99 €", "19.99", "+5,00", "19,99-", numeri veri.
  function parseAmount(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/\s|€|eur/gi, '');
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    else if (s.startsWith('+')) s = s.slice(1);
    if (!/^[\d.,']+$/.test(s)) return null;
    s = s.replace(/'/g, '');
    const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');      // formato italiano
    else if (lastDot > lastComma) {
      // "1.234" senza decimali = migliaia; "19.99" = decimali
      if (lastComma === -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
      else s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  const MONTHS_IT = {
    gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12,
    jan: 1, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, dec: 12,
  };

  function iso(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) {                       // numero seriale Excel
        const d = new Date(Math.round((v - 25569) * 86400000));
        return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      }
      return null;
    }
    const s = String(v).trim().toLowerCase();
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/);
    if (m) return iso(+m[3], +m[2], +m[1]);
    m = s.match(/^(\d{1,2})[\s\-\/]+([a-z]{3})[a-z]*[\s\-\/]+(\d{2,4})/);
    if (m && MONTHS_IT[m[2]]) return iso(+m[3], MONTHS_IT[m[2]], +m[1]);
    return null;
  }

  // ---------- CSV ----------

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    // Sceglie il separatore che dà un numero di colonne più costante tra le righe
    // (la virgola decimale italiana falserebbe un semplice conteggio).
    const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 50);
    let delim = ';', best = -1;
    for (const d of [';', '\t', '|', ',']) {
      const counts = {};
      for (const l of lines) { const c = l.split(d).length - 1; if (c) counts[c] = (counts[c] || 0) + 1; }
      for (const [c, n] of Object.entries(counts)) {
        const score = n * Math.min(+c, 6);
        if (score > best) { best = score; delim = d; }
      }
    }
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  // ---------- Tabelle (CSV / Excel) ----------

  const H = {
    date: [/^data( |$)/, /data operazione/, /data contabile/, /data movimento/, /^date/, /data registrazione/],
    valuta: [/valuta/],
    desc: [/descrizion/, /causale/, /dettagl/, /operazione$/, /beneficiar/, /esercente/, /^description/, /merchant/, /controparte/, /^note/, /^motivo/],
    amount: [/^importo/, /^amount/, /ammontare/, /^valore/, /importo eur/],
    debit: [/uscit/, /addebit/, /^dare/, /^debit/, /^pagamenti/],
    credit: [/entrat/, /accredit/, /^avere/, /^credit/, /^incassi/],
  };
  const matchAny = (s, list) => list.some(r => r.test(s));

  function findHeader(rows) {
    let bestIdx = -1, bestScore = 0;
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const cells = rows[i].map(c => String(c || '').trim().toLowerCase());
      let score = 0;
      if (cells.some(c => matchAny(c, H.date))) score++;
      if (cells.some(c => matchAny(c, H.desc))) score++;
      if (cells.some(c => matchAny(c, H.amount) || matchAny(c, H.debit) || matchAny(c, H.credit))) score++;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
      if (score === 3) break;
    }
    return bestScore >= 2 ? bestIdx : -1;
  }

  function mapColumns(header) {
    const cols = { date: -1, desc: [], amount: -1, debit: -1, credit: -1, status: -1, cat: -1 };
    let valuta = -1;
    header.forEach((raw, i) => {
      const c = String(raw || '').trim().toLowerCase();
      if (!c) return;
      if (/contabilizz/.test(c)) return void (cols.status = i);        // es. "Contabilizzazione" (Intesa)
      if (/^categori/.test(c) && cols.cat < 0) return void (cols.cat = i);  // categoria data dalla banca (es. Intesa)
      if (matchAny(c, H.valuta) && /data/.test(c)) { if (valuta < 0) valuta = i; return; }
      if (matchAny(c, H.date) && cols.date < 0) return void (cols.date = i);
      if (matchAny(c, H.debit) && cols.debit < 0) return void (cols.debit = i);
      if (matchAny(c, H.credit) && cols.credit < 0) return void (cols.credit = i);
      if (matchAny(c, H.amount) && cols.amount < 0) return void (cols.amount = i);
      if (matchAny(c, H.desc)) cols.desc.push(i);
    });
    if (cols.date < 0) cols.date = valuta;
    return cols;
  }

  // Se non c'è un'intestazione riconoscibile, deduce le colonne dal contenuto.
  function guessColumns(rows) {
    const n = Math.max(...rows.map(r => r.length));
    const stats = Array.from({ length: n }, () => ({ dates: 0, amounts: 0, textLen: 0 }));
    rows.slice(0, 200).forEach(r => r.forEach((c, i) => {
      if (parseDate(c)) stats[i].dates++;
      else if (parseAmount(c) !== null) stats[i].amounts++;
      else stats[i].textLen += String(c || '').length;
    }));
    const pick = key => stats.reduce((b, s, i) => (s[key] > (b < 0 ? 0 : stats[b][key]) ? i : b), -1);
    return { date: pick('dates'), desc: [pick('textLen')].filter(i => i >= 0), amount: pick('amounts'), debit: -1, credit: -1 };
  }

  function rowsToTransactions(rows) {
    const h = findHeader(rows);
    const cols = h >= 0 ? mapColumns(rows[h]) : guessColumns(rows);
    const body = h >= 0 ? rows.slice(h + 1) : rows;
    const out = [];
    // Alcune esportazioni (es. "Lista movimenti" Intesa) dichiarano in testa quanti movimenti dovrebbero contenere:
    // serve a capire se il file è stato esportato solo in parte.
    out.declared = null;
    out.pending = 0;
    out.pendingTx = [];                       // movimenti non ancora contabilizzati (spese appena fatte)
    out.hasStatus = cols.status >= 0;
    for (const r of rows.slice(0, h >= 0 ? h : 30)) {
      const i = r.findIndex(c => /movimenti selezionati/i.test(String(c)));
      if (i >= 0) { const n = r.slice(i + 1).map(Number).find(x => Number.isFinite(x) && x > 0); if (n) out.declared = n; }
    }
    for (const r of body) {
      const date = parseDate(r[cols.date]);
      if (!date) continue;
      // Movimenti ancora in sospeso: arriveranno con l'estratto successivo, con la data definitiva
      const pending = cols.status >= 0 && /non\s*contabilizz/i.test(String(r[cols.status]));
      let amount = null;
      if (cols.amount >= 0) amount = parseAmount(r[cols.amount]);
      if (amount === null || amount === 0) {
        const d = cols.debit >= 0 ? parseAmount(r[cols.debit]) : null;
        const c = cols.credit >= 0 ? parseAmount(r[cols.credit]) : null;
        if (d) amount = -Math.abs(d);
        else if (c) amount = Math.abs(c);
      }
      if (amount === null || amount === 0) continue;
      const desc = cols.desc.map(i => String(r[i] || '').trim()).filter(Boolean).join(' - ');
      if (!desc || /^saldo/i.test(desc)) continue;
      const t = { date, desc, amount: Math.round(amount * 100) / 100 };
      const bankCat = cols.cat >= 0 ? String(r[cols.cat] || '').trim() : '';
      if (bankCat) t.bankCat = bankCat;
      if (pending) { out.pending++; out.pendingTx.push(t); continue; }
      out.push(t);
    }
    return out;
  }

  // ---------- PDF (best effort) ----------
  // lines: [{ items: [{ str, x }] }] già ordinate dall'alto verso il basso.

  const AMOUNT_RE = /^[+-]?\d{1,3}(?:\.\d{3})*,\d{2}-?$|^[+-]?\d+,\d{2}-?$/;
  const DATE_RE = /^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/;
  const INCOME_RE = /accredito|stipendio|bonifico a (vostro|tuo) favore|bonifico ricevuto|rimborso|emolumenti|versamento/i;
  const DEBIT_HDR = /^(uscite|addebiti|dare)/, CREDIT_HDR = /^(entrate|accrediti|avere)/;

  // Divide la riga in token, togliendo i simboli di valuta e ricomponendo gli importi
  // che alcune banche stampano con spazi ("74, 20", "1 536, 00", "1. 536, 00").
  function tokenize(line) {
    const toks = [];
    for (const it of line.items) {
      // Alcuni PDF (es. Intesa Sanpaolo) codificano il punto delle migliaia con un carattere di controllo
      // ("1\u0019 536, 00"): dopo una cifra diventa un punto, altrove uno spazio.
      const str = String(it.str).replace(/(\d)[\u0000-\u001f]/g, '$1.').replace(/[\u0000-\u001f]/g, ' ');
      for (let part of str.split(/\s+/).filter(Boolean)) {
        part = part.replace(/€/g, '');
        if (!part || /^eur$/i.test(part)) continue;
        toks.push({ s: part, x: it.x });
      }
    }
    // Unisce i pezzi finché non cambia più niente. Casi gestiti (tutti diventano "1.536,00"):
    //   "1." "536," "00"   ·   "1" "." "536" "," "00"   ·   "1" "536," "00"   ·   "1" "536,00"
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < toks.length - 1; i++) {
        const a = toks[i].s, b = toks[i + 1].s, c = toks[i + 2] && toks[i + 2].s;
        if (/^[.,]$/.test(b) && /\d$/.test(a) && c && /^\d/.test(c)) {                 // separatore isolato: "1" "." "536"
          toks[i].s = a + b + c; toks.splice(i + 1, 2); changed = true; break;
        }
        if (/^[+-]?[\d.]*\d[.,]$/.test(a) && /^\d{2,3}([.,]\d*)?-?$/.test(b)) {        // "74," + "20", "1." + "536,00"
          toks[i].s = a + b; toks.splice(i + 1, 1); changed = true; break;
        }
        if (/^[+-]?\d{1,3}$/.test(a) && /^\d{3}[.,]/.test(b)) {                         // migliaia separate da spazio: "1" + "536,00"
          toks[i].s = a + '.' + b; toks.splice(i + 1, 1); changed = true; break;
        }
      }
    }
    return toks;
  }

  // Cerca la data all'inizio della riga (eventualmente dopo un numero di operazione).
  function takeDate(toks) {
    for (let i = 0; i < Math.min(3, toks.length); i++) {
      if (i > 0 && !/^\d+$/.test(toks[i - 1].s)) break;
      if (DATE_RE.test(toks[i].s)) {
        const d = parseDate(toks[i].s);
        if (d) return { date: d, rest: toks.slice(i + 1) };
      } else if (i + 2 < toks.length && /^\d{1,2}$/.test(toks[i].s) && /^\d{4}$/.test(toks[i + 2].s)) {
        const d = parseDate(toks.slice(i, i + 3).map(t => t.s).join(' '));
        if (d) return { date: d, rest: toks.slice(i + 3) };
      }
    }
    return null;
  }

  function parsePdfLines(lines, requireHeader) {
    let debitX = null, creditX = null, saldoX = null;
    let inTable = !requireHeader;
    const out = [];
    let last = null;
    // Cambio pagina: dopo "Pagina N di M" si saltano le righe d'intestazione della pagina successiva,
    // ma la descrizione del movimento in corso continua (altrimenti verrebbe troncata a metà).
    let pageBreak = false;

    for (const line of lines) {
      const toks = tokenize(line);
      if (!toks.length) continue;
      const text = toks.map(t => t.s).join(' ').toLowerCase();

      // Intestazione della tabella movimenti: memorizza le posizioni di uscite/entrate/saldo
      const hasDebit = toks.some(t => DEBIT_HDR.test(t.s.toLowerCase()));
      const hasCredit = toks.some(t => CREDIT_HDR.test(t.s.toLowerCase()));
      if ((hasDebit && hasCredit) || (/\bdata\b/.test(text) && /descrizione/.test(text) && /(importo|addebit|uscit)/.test(text))) {
        for (const t of toks) {
          const s = t.s.toLowerCase();
          if (DEBIT_HDR.test(s)) debitX = t.x;
          else if (CREDIT_HDR.test(s)) creditX = t.x;
          else if (/^saldo/.test(s)) saldoX = t.x;
        }
        inTable = true;
        if (!pageBreak) last = null;
        pageBreak = false;
        continue;
      }
      // Fine tabella (totali / saldo finale): ignora tutto fino alla prossima intestazione
      if (requireHeader && /^(totali|totale movimenti|saldo finale|saldo contabile)/.test(text)) {
        inTable = false; last = null; pageBreak = false; continue;
      }
      if (!inTable) continue;
      if (/^pagina \d+/.test(text)) { pageBreak = true; continue; }
      if (pageBreak) {
        // Righe d'intestazione della nuova pagina; se la banca non ripete la tabella, si riprende al primo movimento
        if (!takeDate(toks)) continue;
        pageBreak = false;
      }

      const found = takeDate(toks);
      if (!found) {
        // Riga di continuazione della descrizione (es. "PRESSO Netflix.com")
        if (last && last.desc.length < 400) last.desc += ' ' + toks.map(t => t.s).join(' ');
        continue;
      }

      const rest = found.rest;
      const amounts = rest.filter(t => AMOUNT_RE.test(t.s));
      const desc = rest.filter(t => !AMOUNT_RE.test(t.s) && !DATE_RE.test(t.s)).map(t => t.s).join(' ').trim();
      if (!amounts.length || !desc || /^saldo/i.test(desc)) { last = null; continue; }

      let pick = amounts[0];
      if (saldoX !== null && amounts.length > 1) {
        const notSaldo = amounts.filter(a => Math.abs(a.x - saldoX) > 25);
        if (notSaldo.length) pick = notSaldo[0];
      }
      let value = parseAmount(pick.s);
      if (value === null || value === 0) { last = null; continue; }

      if (!/^[+-]|-$/.test(pick.s)) {
        if (debitX !== null && creditX !== null) {
          value = Math.abs(pick.x - creditX) < Math.abs(pick.x - debitX) ? Math.abs(value) : -Math.abs(value);
        } else value = INCOME_RE.test(desc) ? Math.abs(value) : -Math.abs(value);
      }
      last = { date: found.date, desc, amount: Math.round(value * 100) / 100 };
      out.push(last);
    }
    return out;
  }

  // Prima prova a leggere solo dentro le tabelle movimenti; se non ne trova, legge tutto il documento.
  function pdfLinesToTransactions(lines) {
    const tx = parsePdfLines(lines, true);
    return tx.length ? tx : parsePdfLines(lines, false);
  }

  const api = { parseAmount, parseDate, parseCSV, rowsToTransactions, pdfLinesToTransactions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Parser = api;
})(this);
