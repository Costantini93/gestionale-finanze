(function () {
  const STORE_KEY = 'gestionale-abbonamenti-v1';
  const $ = id => document.getElementById(id);
  const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
  const fmtDate = d => d ? d.split('-').reverse().join('/') : '';
  const fmtShort = d => new Date(d + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  const monthLabel = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }); };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayIso = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase());

  // ---------- Stato persistente ----------
  // transactions: tutti i movimenti caricati (l'analisi viene rifatta sempre sull'insieme completo)
  // files:        estratti caricati (nome e periodo), per lo storico
  // overrides:    modifiche dell'utente agli abbonamenti rilevati, per id
  // manual:       abbonamenti aggiunti a mano
  // accepted / ignored: id di suggerimenti promossi o abbonamenti scartati
  // catOverrides: esercente -> categoria scelta dall'utente nella panoramica spese
  const empty = () => ({ transactions: [], files: [], overrides: {}, manual: [], accepted: [], ignored: [], catOverrides: {}, billTypes: {},
    // forecast: saldo inserito dall'utente, giorno dello stipendio, addebiti esclusi dalla previsione
    // reserve: quanto mettere da parte fino al prossimo stipendio (tolto dal budget di oggi)
    forecast: { balance: null, balanceDate: null, balanceAt: null, payDay: null, reserve: 0, excluded: {} },
    // savings: piano di risparmio (obiettivo % di risparmio, fondo di emergenza, obiettivi con scadenza)
    savings: { rateTarget: 10, emergency: { months: 3, saved: 0 }, goals: [] },
    // loans: prestiti inseriti a mano (rata, numero rate, prima scadenza, totale dovuto)
    loans: [],
    // limits: tetti di spesa per categoria ({ cat, period: 'week'|'month', amount })
    // quick:  spese segnate al momento (es. un ordine Glovo) in attesa dell'estratto conto: non sono movimenti
    limits: [], quick: [],
    // pendingTx: spese "non contabilizzate" dell'ultima esportazione Excel; contano solo in "Oggi posso"
    // finché la banca non le contabilizza. pendingAsOf: data dell'esportazione da cui arrivano.
    pendingTx: [], pendingAsOf: null,
    // budgetLog: budget di ogni giorno (data -> euro), per sapere quanto avanza a fine giornata
    // freed: "Soldi liberati" (movedUntil = fino a quando sono già stati messi da parte, hidden = nascosto)
    budgetLog: {}, freed: { movedUntil: null, hidden: false },
    // recapSeen: inizio del periodo di cui il riepilogo è già stato visto o rimandato
    recapSeen: null,
    // invest: operazioni in crypto ({ id, type: 'buy'|'sell', coin, qty, price, fee, date }), prezzi e storico scaricati, monete aggiunte a mano
    invest: { ops: [], prices: {}, hist: {}, custom: {} },
    // excludeDeposits: non contare i versamenti di contanti come entrate (sono già registrati a mano come contanti)
    settings: { remindDays: 2, excludeDeposits: false } });
  // Dal dettaglio prestito nell'app della banca (ottobre 2026): 9 rate mensili ciascuno
  const PRESET_LOANS = [
    { id: 'preset-510', name: 'Prestito 510 €', principal: 510, rate: 58.69, n: 9, first: '2026-12-01', total: 528.22, tan: 8.5, taeg: 8.355 },
    { id: 'preset-259', name: 'Prestito 259 €', principal: 259, rate: 29.80, n: 9, first: '2026-11-01', total: 268.26, tan: 8.5, taeg: 8.012 },
  ];
  const DESC_MAX = 250;
  // Movimenti dell'estratto conto (esclusi quelli inseriti a mano, es. entrate in contanti)
  const bankTx = () => state.transactions.filter(t => !t.manual);
  // Per riconoscere i doppioni bastano i primi 200 caratteri della descrizione (margine per piccole differenze in coda)
  const txKey = t => t.date + '|' + t.amount + '|' + t.desc.slice(0, 200);
  let removedDuplicates = 0, repairedThousands = 0, crossDuplicates = 0, seededLoans = false;
  let state = empty();          // i dati veri arrivano solo dopo aver inserito la password (vedi initLock)

  // Prepara i dati letti dalla cassaforte, correggendo quelli salvati dalle versioni precedenti.
  function parseState(obj) {
    const s = Object.assign(empty(), obj || {});
    s.settings = Object.assign(empty().settings, s.settings);
    s.forecast = Object.assign(empty().forecast, s.forecast);
    s.savings = Object.assign(empty().savings, s.savings);
    s.savings.emergency = Object.assign(empty().savings.emergency, s.savings.emergency);
    s.freed = Object.assign(empty().freed, s.freed);
    s.invest = Object.assign(empty().invest, s.invest);
    // Prestiti registrati una volta sola al primo accesso (poi si possono modificare o eliminare dalla pagina Prestiti)
    if (!s.loansPreset) {
      for (const l of PRESET_LOANS) if (!s.loans.some(x => x.id === l.id || (x.rate === l.rate && x.first === l.first))) s.loans.push(Object.assign({}, l));
      s.loansPreset = seededLoans = true;
    }
    if (!s.limitsPreset) {                       // primo limite consigliato: delivery, 35 € a settimana
      if (!s.limits.some(l => l.cat === 'delivery')) s.limits.push({ id: 'preset-delivery', cat: 'delivery', period: 'week', amount: 35 });
      s.limitsPreset = seededLoans = true;
    }
    repairedThousands = repairThousands(s);
    removedDuplicates = cleanDuplicates(s);
    crossDuplicates = cleanCrossFileDuplicates(s);
    return s;
  }

  // Le versioni precedenti non riconoscevano il separatore delle migliaia dei PDF Intesa (un carattere di controllo):
  // "1.536,00" diventava 536 e il "1" finiva nella descrizione ("disposto da: 1\u0019 MITT…").
  // Qui si ricostruisce l'importo giusto da quella cifra e la si toglie dalla descrizione.
  function repairThousands(s) {
    let n = 0;
    for (const t of s.transactions) {
      const m = t.desc.match(/ (\d{1,3})[\u0000-\u001f](?= |$)/);
      if (!m || Math.abs(t.amount) >= 1000) continue;
      t.amount = Math.sign(t.amount) * (Number(m[1]) * 1000 + Math.abs(t.amount));
      t.amount = Math.round(t.amount * 100) / 100;
      t.desc = t.desc.replace(m[0], '');
      n++;
    }
    return n;
  }

  // Le versioni precedenti salvavano la descrizione completa, quelle nuove la accorciano a DESC_MAX caratteri:
  // ricaricando lo stesso estratto, i movimenti con descrizione lunga finivano in doppio.
  // Qui togliamo le copie accorciate di movimenti già presenti in versione completa.
  function cleanDuplicates(s) {
    const groups = {};
    for (const t of s.transactions) (groups[txKey(t)] = groups[txKey(t)] || []).push(t);
    const drop = new Set();
    for (const g of Object.values(groups)) {
      const full = g.filter(t => t.desc.length > DESC_MAX);
      const short = g.filter(t => t.desc.length <= DESC_MAX);
      short.slice(0, full.length).forEach(t => drop.add(t));
    }
    s.transactions = s.transactions.filter(t => !drop.has(t));
    for (const t of s.transactions) t.desc = t.desc.slice(0, DESC_MAX);
    return drop.size;
  }

  // ---------- Stesso movimento da due file diversi ----------
  // La banca descrive lo stesso movimento in modo diverso nel PDF e nell'Excel
  // (es. "Bonifico a Vostro favore disposto da: …" e "Stipendio O Pensione - COD.DISP. …").
  // Ogni estratto contiene tutti i movimenti dei giorni che copre: se un altro file copre già quel giorno
  // e ha un movimento con stessa data e stesso importo, è lo stesso movimento, anche con un testo diverso.
  const GENERIC_CATS = new Set(['altro', 'bonifici', 'bonifici_in', 'altre_entrate']);
  const descCategory = t => (t.amount > 0 ? Categories.categorizeIncome : Categories.categorize)(Detector.normalize(t.desc));
  // Delle due descrizioni tiene quella che dice di più (es. "Stipendio" invece di un bonifico generico)
  function betterDesc(keep, other) {
    const gk = GENERIC_CATS.has(descCategory(keep)), go = GENERIC_CATS.has(descCategory(other));
    if (gk !== go) return gk ? other.desc : keep.desc;
    return other.desc.length > keep.desc.length ? other.desc : keep.desc;
  }
  function fileCovers(s, src, date) {
    const f = (s.files || []).find(x => x.id === src);
    return !!f && f.from <= date && date <= f.to;
  }
  // Pulizia dei doppioni già salvati: per ogni giorno e importo resta il numero di movimenti
  // del file che ne ha di più; le copie arrivate da altri file vengono tolte.
  function cleanCrossFileDuplicates(s) {
    const groups = {};
    for (const t of s.transactions) {
      if (t.manual || !t.src || !fileCovers(s, t.src, t.date)) continue;
      (groups[t.date + '|' + t.amount] = groups[t.date + '|' + t.amount] || []).push(t);
    }
    const drop = new Set();
    for (const g of Object.values(groups)) {
      const bySrc = {};
      for (const t of g) (bySrc[t.src] = bySrc[t.src] || []).push(t);
      const srcs = Object.keys(bySrc);
      if (srcs.length < 2) continue;
      srcs.sort((a, b) => bySrc[b].length - bySrc[a].length);
      const kept = bySrc[srcs[0]];
      for (const src of srcs.slice(1)) {
        bySrc[src].forEach((t, i) => {
          const k = kept[i];
          if (!k) return;
          k.desc = betterDesc(k, t);
          drop.add(t);
        });
      }
    }
    if (drop.size) s.transactions = s.transactions.filter(t => !drop.has(t));
    return drop.size;
  }
  // Salva lo stato cifrato con la password (js/vault.js). Nulla viene più salvato in chiaro.
  function save() {
    Vault.save(state).catch(e => showStatus('Impossibile salvare i dati: ' + esc(e.message), true));
  }

  // ---------- Identità stabile degli abbonamenti ----------
  // L'id di un abbonamento rilevato è "gruppo|importo arrotondato". Se il prezzo cambia leggermente
  // (es. Spotify 10,99 → 11,99) l'id cambierebbe: lo ricolleghiamo all'id già noto più vicino,
  // così modifiche, disdette ed eliminazioni restano valide.
  function knownIds() {
    return new Set([...Object.keys(state.overrides), ...state.accepted, ...state.ignored]);
  }
  function splitId(id) {
    const i = id.lastIndexOf('|');
    return { group: id.slice(0, i), amount: Number(id.slice(i + 1)) };
  }
  function resolveId(id, known) {
    if (known.has(id) || id.startsWith('manual:')) return id;
    const me = splitId(id);
    let best = null, bestDiff = Infinity;
    for (const k of known) {
      if (k.startsWith('manual:')) continue;
      const o = splitId(k);
      const diff = Math.abs(o.amount - me.amount);
      if (o.group === me.group && diff <= Math.max(1.5, me.amount * 0.15) && diff < bestDiff) { best = k; bestDiff = diff; }
    }
    return best || id;
  }

  // ---------- Calcolo della vista ----------
  function computeView() {
    const result = Detector.analyze(bankTx());
    const known = knownIds();
    for (const s of [...result.subscriptions, ...result.suggestions]) s.id = resolveId(s.id, known);

    const today = todayIso();
    const dataEnd = result.period ? result.period.to : null;
    const apply = s => {
      const v = Object.assign({}, s, state.overrides[s.id] || {});
      if (s.txs) Object.defineProperty(v, 'txs', { value: s.txs, enumerable: false });
      // endDate = "attivo fino al": l'ultimo giorno in cui il servizio è attivo; da quel giorno niente più addebiti
      v.ended = !!v.endDate && v.endDate < today;
      v.stale = !v.manual && !v.cancelled && !v.ended && !v.forceActive && Detector.isStale(v, dataEnd);
      v.active = !v.cancelled && !v.stale && !v.ended;
      v.next = v.active ? Detector.nextChargeDate(v, today) : null;
      if (v.next && v.endDate && v.next >= v.endDate) v.next = null;     // scade prima del prossimo rinnovo
      // Addebiti arrivati dopo che l'abbonamento è stato segnato come disdetto o dopo la scadenza
      v.afterCancel = v.cancelled && v.cancelledAt && v.charges ? v.charges.filter(c => c.date > v.cancelledAt) : [];
      v.afterEnd = v.endDate && v.charges ? v.charges.filter(c => c.date >= v.endDate) : [];
      return v;
    };

    const subs = [
      ...result.subscriptions,
      ...result.suggestions.filter(s => state.accepted.includes(s.id)),
    ].filter(s => !state.ignored.includes(s.id)).map(apply);
    subs.push(...state.manual.map(m => apply(Object.assign({ manual: true }, m))));
    const suggestions = result.suggestions.filter(s => !state.accepted.includes(s.id) && !state.ignored.includes(s.id));
    const deleted = [...result.subscriptions, ...result.suggestions].filter(s => state.ignored.includes(s.id))
      .map(s => Object.assign({}, s, state.overrides[s.id] || {}));

    const rank = s => s.afterCancel.length || s.afterEnd.length ? 0 : s.active ? 1 : s.stale ? 2 : 3;
    subs.sort((a, b) => rank(a) - rank(b) || Detector.monthlyCost(b) - Detector.monthlyCost(a));
    return { subs, suggestions, deleted, period: result.period, count: result.count };
  }

  // ---------- Render: abbonamenti ----------
  const FREQ_LABEL = { settimanale: 'a settimana', mensile: 'al mese', bimestrale: 'ogni 2 mesi', trimestrale: 'ogni 3 mesi', semestrale: 'ogni 6 mesi', annuale: "all'anno" };

  function logoColor(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 48%)`;
  }

  function daysUntil(iso) {
    return Math.round(Detector.daysBetween(todayIso(), iso));
  }
  function whenLabel(iso) {
    const n = daysUntil(iso);
    return n === 0 ? 'oggi' : n === 1 ? 'domani' : `tra ${n} giorni`;
  }

  // Data del prossimo addebito modificabile al volo. Se l'ha scelta l'utente si può tornare a quella calcolata.
  // Sotto ogni abbonamento: data del prossimo addebito e "attivo fino al" (vuota = nessuna scadenza).
  function nextEditor(s) {
    const lastBeforeEnd = s.endDate && !s.next && s.active;
    return `<span class="next-edit">
      ${s.active ? `<label>Prossimo addebito <input type="date" data-next-id="${esc(s.id)}" value="${s.next || ''}"></label>
        ${s.next ? `<span class="next-when${daysUntil(s.next) <= 3 ? ' soon' : ''}">${whenLabel(s.next)}</span>`
          : lastBeforeEnd ? '<span class="muted">nessun altro addebito prima della scadenza</span>' : '<span class="muted">non impostata</span>'}
        ${s.nextDate && !s.manual ? `<button class="link small" data-reset-next="${esc(s.id)}" title="Torna alla data calcolata dagli addebiti passati">usa la data calcolata</button>` : ''}
        <span class="next-sep"></span>` : ''}
      <label>Attivo fino al <input type="date" data-end-id="${esc(s.id)}" value="${s.endDate || ''}" title="Lascia vuoto se non ha scadenza"></label>
      ${s.endDate ? `<button class="link small" data-clear-end="${esc(s.id)}">togli scadenza</button>` : '<span class="muted">nessuna scadenza</span>'}
    </span>`;
  }

  function itemHTML(s, isSuggestion) {
    const monthly = Detector.monthlyCost(s);
    const searchFallback = /google\.com\/search/.test(s.cancelUrl || '');
    const meta = [
      s.category,
      s.charges ? '' : 'aggiunto a mano',
      s.lastDate ? 'ultimo ' + fmtDate(s.lastDate) : '',
    ].filter(Boolean).join(' · ');
    const price = `<div class="price"><b>${eur.format(s.amount)}</b><span>${FREQ_LABEL[s.frequency] || ''}${s.frequency !== 'mensile' ? ' · ' + eur.format(monthly) + '/mese' : ''}</span></div>`;

    let badges = '';
    if (s.cancelled) badges += `<span class="badge">disdetto${s.cancelledAt ? ' il ' + fmtDate(s.cancelledAt) : ''}</span>`;
    if (s.stale) badges += `<span class="badge warn">nessun addebito dal ${fmtDate(s.lastDate)}</span>`;
    if (s.afterCancel && s.afterCancel.length) badges +=`<span class="badge danger">addebitato dopo la disdetta</span>`;
    if (s.ended) badges += `<span class="badge">terminato il ${fmtDate(s.endDate)}</span>`;
    else if (s.endDate && !s.cancelled) badges += `<span class="badge warn">attivo fino al ${fmtDate(s.endDate)}</span>`;
    if (s.afterEnd && s.afterEnd.length) badges += `<span class="badge danger">addebitato dopo la scadenza</span>`;

    let actions;
    if (isSuggestion) {
      actions = `<button class="btn" data-act="accept">Aggiungi</button>
                 <button class="icon" data-act="ignore" title="Non è un abbonamento">✕</button>`;
    } else if (s.ended && !s.cancelled) {
      actions = `<button class="icon" data-act="edit" title="Modifica">✎</button>
                 <button class="icon" data-act="delete" title="Elimina dalla lista">🗑</button>`;
    } else if (s.cancelled) {
      actions = `<button class="btn ghost" data-act="reactivate">Riattiva</button>
                 <button class="icon" data-act="delete" title="Elimina dalla lista">🗑</button>`;
    } else {
      const cancelBtn = `<a class="btn cancel" href="${esc(s.cancelUrl)}" target="_blank" rel="noopener noreferrer"
              title="${searchFallback ? 'Cerca la guida per disdire ' : 'Vai alla pagina di disdetta di '}${esc(s.name)}">Disdici</a>`;
      actions = `${s.stale ? `<button class="btn ghost" data-act="stillActive" title="L'abbonamento è ancora attivo">Ancora attivo</button>` : cancelBtn}
                 <button class="icon" data-act="done" title="Segna come disdetto">✓</button>
                 ${s.next ? `<button class="icon" data-act="ics" title="Promemoria nel calendario">📅</button>` : ''}
                 <button class="icon" data-act="edit" title="Modifica">✎</button>
                 <button class="icon" data-act="delete" title="Elimina: non è un abbonamento">🗑</button>`;
    }
    const cls = ['item', (s.cancelled || s.ended) && 'cancelled', s.stale && 'stale'].filter(Boolean).join(' ');
    return `<div class="${cls}" data-id="${esc(s.id)}" style="--lc:${logoColor(s.name)}" title="${esc(isSuggestion ? s.reason : (s.sampleDesc || ''))}">
      <div class="logo" style="background:${logoColor(s.name)}">${esc(s.name.charAt(0).toUpperCase())}</div>
      <div class="info">
        <div class="name">${esc(s.name)}${badges}</div>
        <div class="meta">${esc(isSuggestion ? s.reason : meta)}</div>
        ${!isSuggestion && (s.active || (s.ended && !s.cancelled)) ? nextEditor(s) : ''}
        ${s.charges ? `<details class="charges"><summary>${s.charges.length} addebit${s.charges.length === 1 ? 'o' : 'i'}</summary>
          <ul>${s.charges.map(c => `<li>${fmtDate(c.date)} — ${eur.format(c.amount)}</li>`).join('')}</ul></details>` : ''}
      </div>
      ${price}
      <div class="actions">${actions}</div>
    </div>`;
  }

  function monthsBetween(from, to) {
    const out = [];
    let [y, m] = from.slice(0, 7).split('-').map(Number);
    const [ty, tm] = to.slice(0, 7).split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      out.push(y + '-' + String(m).padStart(2, '0'));
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }

  function renderSubs(view) {
    const active = view.subs.filter(s => s.active);
    const total = active.reduce((sum, s) => sum + Detector.monthlyCost(s), 0);
    const inactive = view.subs.length - active.length;

    $('totMonth').textContent = eur.format(total);
    $('totYear').textContent = eur.format(total * 12);
    $('countActive').textContent = active.length;
    $('countCancelled').textContent = inactive ? `${inactive} disdett${inactive === 1 ? 'o' : 'i'} o non più addebitat${inactive === 1 ? 'o' : 'i'}` : '\u00a0';

    $('list').innerHTML = view.subs.map(s => itemHTML(s, false)).join('');
    $('empty').hidden = view.subs.length > 0;
    $('suggCard').hidden = view.suggestions.length === 0;
    $('sugg').innerHTML = view.suggestions.map(s => itemHTML(s, true)).join('');
    $('deletedCard').hidden = view.deleted.length === 0;
    $('verifyEmpty').hidden = view.suggestions.length + view.deleted.length > 0;
    $('deletedCount').textContent = view.deleted.length;
    // Contatori nel menu laterale
    $('navSubs').textContent = active.length || '';
    $('navSugg').textContent = view.suggestions.length || '';
    $('deleted').innerHTML = view.deleted.map(s => `
      <div class="item" data-id="${esc(s.id)}">
        <div class="logo" style="background:${logoColor(s.name)}">${esc(s.name.charAt(0).toUpperCase())}</div>
        <div class="info"><div class="name">${esc(s.name)}</div>
          <div class="meta">${esc(s.category)} · ${s.charges.length} addebit${s.charges.length === 1 ? 'o' : 'i'} · ultimo ${fmtDate(s.lastDate)}</div></div>
        <div class="price"><b>${eur.format(s.amount)}</b><span>${FREQ_LABEL[s.frequency] || ''}</span></div>
        <div class="actions"><button class="btn ghost" data-act="restore">Ripristina</button></div>
      </div>`).join('');

    // Avvisi
    const alerts = [];
    // Avvisi che l'utente può chiudere con "Va bene così": la chiave identifica la situazione,
    // così se ne nasce una nuova (altro mese doppio, altro aumento) l'avviso ricompare.
    const okAlert = (s, key, html) => {
      if ((s.okAlerts || []).includes(key)) return;
      alerts.push(`<p>${html} <button class="link" data-ok-id="${esc(s.id)}" data-ok-key="${esc(key)}">Va bene così</button></p>`);
    };
    for (const s of view.subs) {
      if (s.afterEnd && s.afterEnd.length) {
        alerts.push(`<p><b>${esc(s.name)}</b>: doveva essere attivo fino al ${fmtDate(s.endDate)}, ma risultano addebiti successivi
          (${s.afterEnd.map(c => fmtDate(c.date) + ' ' + eur.format(c.amount)).join(', ')}). Controlla che non si sia rinnovato.</p>`);
      }
      if (s.afterCancel.length) {
        alerts.push(`<p><b>${esc(s.name)}</b>: l'hai segnato come disdetto il ${fmtDate(s.cancelledAt)}, ma risultano addebiti successivi
          (${s.afterCancel.map(c => fmtDate(c.date) + ' ' + eur.format(c.amount)).join(', ')}). Controlla che la disdetta sia andata a buon fine.</p>`);
      }
      if (s.charges && s.charges.length >= 2 && !s.cancelled) {
        const first = s.charges[0].amount, last = s.charges[s.charges.length - 1].amount;
        if (last - first >= 0.5) okAlert(s, `inc:${first}>${last}`, `<b>${esc(s.name)}</b> è aumentato da ${eur.format(first)} a ${eur.format(last)}.`);
      }
      if (s.active && s.frequency === 'mensile' && s.charges) {
        const perMonth = {};
        for (const c of s.charges) perMonth[c.date.slice(0, 7)] = (perMonth[c.date.slice(0, 7)] || 0) + 1;
        const dup = Object.entries(perMonth).filter(([, n]) => n > 1).map(([m]) => m);
        if (dup.length) okAlert(s, 'dup:' + dup.join(','), `<b>${esc(s.name)}</b> è stato addebitato più volte nello stesso mese (${dup.map(monthLabel).join(', ')}): potrebbero essere due abbonamenti distinti (in quel caso aggiungi il secondo a mano), oppure un abbonamento disdetto e riattivato.`);
      }
    }
    $('alertsCard').hidden = !alerts.length;
    $('alerts').innerHTML = alerts.join('');

    // Prossimi addebiti (30 giorni)
    const today = todayIso();
    const limit = Detector.addPeriod(today, 'mensile');
    const upcoming = active.filter(s => s.next && s.next <= limit).sort((a, b) => a.next.localeCompare(b.next));
    $('upcomingHint').textContent = upcoming.length
      ? `Nei prossimi 30 giorni: ${eur.format(upcoming.reduce((t, s) => t + s.amount, 0))} in ${upcoming.length} addebit${upcoming.length === 1 ? 'o' : 'i'}.`
      : 'Nessun addebito previsto nei prossimi 30 giorni.';
    const upRow = s => `
      <div class="up-row${daysUntil(s.next) <= 3 ? ' soon' : ''}">
        <span class="up-date"><b>${esc(fmtShort(s.next))}</b><small>${whenLabel(s.next)}</small></span>
        <span class="up-name">${esc(s.name)}</span>
        <span class="up-amt">${eur.format(s.amount)}</span>
      </div>`;
    // Pagina "Prossimi addebiti": tutti gli abbonamenti attivi, con la data modificabile
    const byNext = [...active].sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999'));
    $('upcoming').innerHTML = byNext.map(s => `
      <div class="up-row up-edit${s.next && daysUntil(s.next) <= 3 ? ' soon' : ''}">
        <span class="up-date">
          <input type="date" data-next-id="${esc(s.id)}" value="${s.next || ''}" title="Cambia la data del prossimo addebito">
          <small>${s.next ? whenLabel(s.next) : 'data da impostare'}${s.nextDate && !s.manual ? ` · <button class="link small" data-reset-next="${esc(s.id)}">usa la calcolata</button>` : ''}</small>
        </span>
        <span class="up-name">${esc(s.name)} <small class="muted">${FREQ_LABEL[s.frequency] || ''}${s.endDate ? ' · attivo fino al ' + fmtDate(s.endDate) : ''}</small></span>
        <span class="up-amt">${eur.format(s.amount)}</span>
      </div>`).join('') || '<p class="muted">Nessun abbonamento attivo.</p>';
    $('dashUpcoming').innerHTML = upcoming.slice(0, 5).map(upRow).join('') || '<p class="muted">Nessun addebito nei prossimi 30 giorni.</p>';
    $('remindDays').value = String(state.settings.remindDays);

    // Addebiti reali per mese
    if (view.period && active.some(s => s.charges)) {
      const months = monthsBetween(view.period.from, view.period.to);
      const totals = Object.fromEntries(months.map(m => [m, 0]));
      for (const s of active) for (const c of s.charges || []) {
        const k = c.date.slice(0, 7);
        if (k in totals) totals[k] += c.amount;
      }
      const max = Math.max(...Object.values(totals), 1);
      $('months').innerHTML = months.map(m => `<div class="month"><span>${monthLabel(m)}</span>
          <div><div class="bar" style="width:${(totals[m] / max * 100).toFixed(1)}%"></div></div>
          <span class="amt">${eur.format(totals[m])}</span></div>`).join('');
      $('monthsCard').hidden = false;
    } else $('monthsCard').hidden = true;
  }

  // ---------- Render: storico caricato ----------
  function renderCoverage(view) {
    const el = $('coverage');
    if (!view.period) { el.hidden = true; return; }
    const months = monthsBetween(view.period.from, view.period.to);
    const counts = {};
    for (const t of state.transactions) counts[t.date.slice(0, 7)] = (counts[t.date.slice(0, 7)] || 0) + 1;
    const missing = months.filter(m => !counts[m]);
    el.hidden = false;
    el.innerHTML = `
      <div class="cov-head">📚 Storico: <b>${months.length} mes${months.length === 1 ? 'e' : 'i'}</b>
        dal ${fmtDate(view.period.from)} al ${fmtDate(view.period.to)} · ${state.transactions.length} movimenti</div>
      <div class="chips">${months.map(m => `<span class="chip${counts[m] ? '' : ' missing'}" title="${counts[m] || 0} movimenti">${esc(monthLabel(m))}</span>`).join('')}</div>
      ${missing.length ? `<p class="small warn-text">Mancano i movimenti di: ${missing.map(monthLabel).join(', ')}. Caricali per un'analisi completa.</p>` : ''}
      ${months.length < 12 ? `<p class="small muted">Con almeno 12 mesi di storico riconosco anche gli abbonamenti annuali.</p>` : ''}
      ${state.files.length ? `<h3 class="focus-h">File caricati</h3><div class="files">${state.files.map((f, i) => `
        <div class="file-row">
          <span><b>${esc(f.name)}</b><small>${f.count} movimenti dal ${fmtDate(f.from)} al ${fmtDate(f.to)}${f.added < f.count ? ` · ${f.count - f.added} erano già presenti` : ''}${f.addedAt ? ` · caricato il ${fmtDate(f.addedAt)}` : ''}</small></span>
          <button class="btn ghost small-btn" data-remove-file="${i}">Rimuovi</button>
        </div>`).join('')}</div>` : ''}`;
  }

  // Movimenti che verrebbero tolti rimuovendo un file. I file caricati con le versioni precedenti non
  // avevano l'etichetta di provenienza: per quelli si tolgono i movimenti del suo periodo non coperti da altri file.
  function fileTransactions(idx) {
    const f = state.files[idx];
    if (f.id && state.transactions.some(t => t.src === f.id)) return state.transactions.filter(t => t.src === f.id);
    const others = state.files.filter((_, j) => j !== idx);
    return state.transactions.filter(t => !t.src && t.date >= f.from && t.date <= f.to
      && !others.some(o => t.date >= o.from && t.date <= o.to));
  }

  // ---------- Render: panoramica spese ----------
  // Periodo scelto: 'all' (tutto lo storico), 'current' (mese corrente) o un mese 'YYYY-MM'
  let selectedMonth = 'all';
  const periodMonth = () => selectedMonth === 'all' ? null : selectedMonth === 'current' ? todayIso().slice(0, 7) : selectedMonth;
  const openCats = new Set();

  const openIncCats = new Set();

  // Chi c'è dall'altra parte del movimento: per i bonifici la persona/azienda, altrimenti l'esercente.
  // key: identificativo stabile (usato per spostare di categoria), name: nome da mostrare.
  function party(t) {
    const cp = Detector.counterpartOf(t.desc);
    if (cp) return { key: 'cp:' + Detector.normalize(cp).trim(), name: titleCase(cp.toLowerCase()), search: cp };
    const mk = Detector.merchantKey(t.desc);
    if (mk) return { key: mk, name: titleCase(mk), search: mk };
    const txt = Detector.merchantText(t.desc).slice(0, 40);
    return { key: '', name: txt, search: txt };
  }

  // Le entrate hanno categorie proprie; le scelte dell'utente sono salvate con il prefisso "in:".
  function txCategory(t, subTxs) {
    if (t.manual) return t.cat;                                 // inserito a mano: categoria scelta all'inserimento
    const key = party(t).key;
    if (t.amount > 0) {
      if (key && state.catOverrides['in:' + key]) return state.catOverrides['in:' + key];
      const inc = Categories.categorizeIncome(Detector.normalize(t.desc));
      return inc === 'altre_entrate' ? Categories.fromBank(t.bankCat, true) || inc : inc;
    }
    if (key && state.catOverrides[key]) return state.catOverrides[key];
    const sub = subTxs.get(t);
    // Le utenze ricorrenti restano nelle loro categorie (Bollette, Telefono), non in "Abbonamenti"
    if (sub) return sub.category === 'Utenze' ? 'bollette' : sub.category === 'Telefonia' ? 'telefonia' : 'abbonamenti';
    // Le righe sul cambio valuta ("CTV. DI 39 USD… Commissione di conversione") non dicono cosa si è comprato
    const norm = Detector.normalize(t.desc.replace(/\(ctv\.?[\s\S]*$/i, ''));
    const cat = Categories.categorize(norm);
    if (cat === 'altro' && Detector.matchService(norm, t.amount)) return 'abbonamenti';    // es. un singolo addebito GitHub
    // La descrizione non basta: si usa la categoria scritta dalla banca nell'esportazione, se dice qualcosa
    return cat === 'altro' ? Categories.fromBank(t.bankCat, false) || cat : cat;
  }

  // Gli arrotondamenti del salvadanaio (decine di righe da pochi centesimi) si mostrano come una riga al mese.
  // Solo negli elenchi: i movimenti salvati restano quelli della banca, uno per uno.
  const isRoundup = t => /arrotondament/i.test(t.desc) && /salvadanaio/i.test(t.desc);
  function groupRoundups(items, getT, make) {
    const out = [], groups = {};
    for (const it of items) {
      const t = getT(it);
      if (!isRoundup(t)) { out.push({ it }); continue; }
      const k = t.date.slice(0, 7) + (t.amount < 0 ? '-' : '+');
      if (!groups[k]) out.push(groups[k] = { first: it, n: 0, sum: 0, last: t.date });
      const g = groups[k];
      g.n++; g.sum += t.amount;
      if (t.date > g.last) g.last = t.date;
    }
    return out.map(x => {
      if (x.it !== undefined) return x.it;
      if (x.n === 1) return x.first;
      const month = monthLabel(x.last.slice(0, 7));
      return make(x.first, { date: x.last, amount: Math.round(x.sum * 100) / 100, roundups: x.n,
        desc: `${x.n} arrotondamenti nel salvadanaio a ${month}, ${x.sum < 0 ? 'accantonati' : 'ripresi'} insieme` });
    });
  }
  const roundupName = t => `Arrotondamenti salvadanaio (${t.roundups})`;

  // Riga apribile: in chiusura mostra il riepilogo, aperta elenca i singoli movimenti con la data.
  // search: parola per "Cerca tutti i movimenti" (facoltativa).
  function drow(cls, summary, txs, search) {
    const sorted = groupRoundups([...txs].sort((a, b) => b.date.localeCompare(a.date)), t => t, (t0, t) => t);
    return `<details class="drow ${cls}">
      <summary>${summary}</summary>
      <ul class="tx-mini">${sorted.map(t => `<li>
        <span class="tx-date">${fmtDate(t.date)}</span>
        <span class="tx-what">${esc(t.roundups ? roundupName(t) : Detector.merchantText(t.desc).slice(0, 60))}${t.pending ? ' <small class="muted">in sospeso</small>' : ''}</span>
        <b class="${t.amount < 0 ? 'neg' : 'pos'}">${t.amount < 0 ? '−' : '+'}${eur.format(Math.abs(t.amount))}</b>
      </li>`).join('')}</ul>
      ${search ? `<button class="link small" data-search="${esc(search)}">Cerca tutti i movimenti</button>` : ''}
    </details>`;
  }

  // Elenco a categorie espandibili, con gli esercenti/controparti e il menu per spostarli.
  function renderCatList(el, rows, total, openSet, cats, prefix, emptyText) {
    const groups = {};
    for (const { t, cat } of rows) {
      const g = groups[cat] || (groups[cat] = { total: 0, parties: {} });
      const v = Math.abs(t.amount);
      g.total += v;
      const p = party(t);
      const e = g.parties[p.key || p.name] || (g.parties[p.key || p.name] = Object.assign({ total: 0, n: 0, txs: [] }, p));
      e.total += v; e.n++; e.txs.push(t);
    }
    const sorted = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
    if (!sorted.length) { el.innerHTML = `<p class="empty">${esc(emptyText)}</p>`; return; }
    const max = sorted[0][1].total;
    const options = cats.filter(c => !c.excluded).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    el.innerHTML = sorted.map(([id, g]) => {
      const info = Categories.byId[id] || Categories.byId.altro;
      const list = Object.values(g.parties).sort((a, b) => b.total - a.total);
      return `<div class="cat${openSet.has(id) ? ' open' : ''}" data-cat="${id}">
        <button class="cat-row" data-act="toggleCat">
          <span class="dot" style="background:${info.color}"></span>
          <span class="cat-name">${esc(info.name)}</span>
          <span class="cat-bar"><span style="width:${(g.total / max * 100).toFixed(1)}%;background:${info.color}"></span></span>
          <span class="cat-amt">${eur.format(g.total)}</span>
          <span class="cat-pct">${total ? (g.total / total * 100).toFixed(0) : 0}%</span>
        </button>
        <div class="merchants">${list.map(p => drow('merchant', `
            <span class="m-name">${esc(p.name)}</span>
            <span class="m-n">${p.n}×</span>
            <span class="m-amt">${eur.format(p.total)}</span>
            ${p.key ? `<select data-mk="${esc(prefix + p.key)}" title="Sposta in un'altra categoria">${options.replace(`value="${id}"`, `value="${id}" selected`)}</select>` : '<span></span>'}`,
            p.txs, p.search)).join('')}</div>
      </div>`;
    }).join('');
  }

  // Bonifici ricevuti e inviati, raggruppati per persona/azienda, più le commissioni pagate.
  function renderBonifici(el, rows) {
    const isBonifico = t => /bonifico/i.test(t.desc) && !/costo bonifico/i.test(t.desc);
    const inRows = rows.filter(x => x.t.amount > 0 && isBonifico(x.t));
    const outRows = rows.filter(x => x.t.amount < 0 && isBonifico(x.t));
    const fees = rows.filter(x => x.t.amount < 0 && /costo bonifico|commissione bonifico/i.test(x.t.desc))
      .reduce((s, x) => s - x.t.amount, 0);
    if (!inRows.length && !outRows.length) {
      el.innerHTML = '<h2>🔁 Bonifici</h2><p class="muted">Nessun bonifico in questo periodo.</p>';
      return;
    }
    const group = list => {
      const g = {};
      for (const { t } of list) {
        const p = party(t);
        const e = g[p.key || p.name] || (g[p.key || p.name] = Object.assign({ total: 0, n: 0, txs: [] }, p));
        e.total += Math.abs(t.amount); e.n++; e.txs.push(t);
      }
      return Object.values(g).sort((a, b) => b.total - a.total);
    };
    const sum = list => list.reduce((s, x) => s + Math.abs(x.t.amount), 0);
    const block = (title, list, color) => {
      if (!list.length) return '';
      const groups = group(list);
      const max = groups[0].total;
      return `<h3 class="focus-h">${title}</h3>` + groups.map(p => drow('focus-row', `
          <span class="d-name">${esc(p.name)}</span>
          <span class="cat-bar"><span style="width:${(p.total / max * 100).toFixed(1)}%;background:${color}"></span></span>
          <span class="focus-n">${p.n} bonific${p.n === 1 ? 'o' : 'i'}</span>
          <span class="cat-amt">${eur.format(p.total)}</span>`, p.txs, p.search)).join('');
    };
    el.innerHTML = `
      <h2>🔁 Bonifici</h2>
      <div class="focus-stats">
        <div><span class="label">Ricevuti</span><b class="pos">${eur.format(sum(inRows))}</b></div>
        <div><span class="label">Inviati</span><b class="neg">${eur.format(sum(outRows))}</b></div>
        <div><span class="label">N. bonifici</span><b>${inRows.length + outRows.length}</b></div>
        <div><span class="label">Commissioni</span><b>${eur.format(fees)}</b></div>
      </div>
      ${block('Ricevuti da', inRows, 'var(--ok)')}
      ${block('Inviati a', outRows, 'var(--danger)')}`;
  }

  function renderSpese(view) {
    const subTxs = new Map();          // movimento → abbonamento a cui appartiene
    for (const s of view.subs) for (const t of s.txs || []) subTxs.set(t, s);

    // Movimenti della banca + spese ancora in sospeso (non contabilizzate): sono spese già fatte, contano ovunque
    const everything = [...state.transactions, ...livePending()].map(t => ({ t, cat: txCategory(t, subTxs) }));
    const all = everything.filter(x => !(Categories.byId[x.cat] || {}).excluded
      && !(state.settings.excludeDeposits && x.cat === 'versamenti'));
    searchRows = everything;
    const months = [...new Set(all.map(x => x.t.date.slice(0, 7)))].sort().reverse();

    const sel = $('monthFilter');
    if (!['all', 'current'].includes(selectedMonth) && !months.includes(selectedMonth)) selectedMonth = 'all';
    sel.innerHTML = `<option value="all">Tutto lo storico</option><option value="current">Mese corrente (${monthLabel(todayIso().slice(0, 7))})</option>` + months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    sel.value = selectedMonth;

    const pm = periodMonth();
    const rows = pm ? all.filter(x => x.t.date.startsWith(pm)) : all;
    const inTot = rows.filter(x => x.t.amount > 0).reduce((s, x) => s + x.t.amount, 0);
    const outRows = rows.filter(x => x.t.amount < 0);
    const outTot = outRows.reduce((s, x) => s - x.t.amount, 0);

    const inRows = rows.filter(x => x.t.amount > 0);
    const focusMonths = pm ? 1 : months.length;
    const brandOr = list => x => Categories.brandOf(list, Detector.normalize(x.t.desc)) || party(x.t);
    renderFocus($('focusStipendio'), inRows.filter(x => x.cat === 'stipendio'), focusMonths, {
      title: '💼 Stipendio', cat: 'stipendio', groupOf: x => party(x.t), unit: 'accredito', units: 'accrediti', avgLabel: 'Media per accredito', heading: 'Da chi',
      empty: 'Nessuno stipendio riconosciuto in questo periodo. Se un accredito è il tuo stipendio, spostalo in "Stipendio" dalla lista "Entrate per categoria".',
    });
    renderCompare($('compareCard'), all, months, pm);
    renderBonifici($('bonificiCard'), rows);
    renderBollette($('focusBollette'), outRows.filter(x => x.cat === 'bollette'), focusMonths, all.filter(x => x.t.amount < 0 && x.cat === 'bollette'));
    renderFocus($('focusSpesa'), outRows.filter(x => x.cat === 'spesa'), focusMonths, {
      title: '🛒 Spesa', cat: 'spesa', groupOf: brandOr(Categories.SUPERMARKETS), unit: 'spesa', units: 'spese', avgLabel: 'Scontrino medio',
      empty: 'Nessuna spesa al supermercato in questo periodo. Se un negozio manca, spostalo in "Spesa alimentare" dalla lista delle categorie.',
    });
    renderFocus($('focusDelivery'), outRows.filter(x => x.cat === 'delivery'), focusMonths, {
      title: '🛵 Delivery', cat: 'delivery', groupOf: brandOr(Categories.DELIVERY), unit: 'ordine', units: 'ordini', avgLabel: 'Ordine medio',
      empty: 'Nessun ordine a domicilio (Glovo, Deliveroo, Just Eat, Uber Eats) in questo periodo.',
    });

    renderCatList($('cats'), outRows, outTot, openCats, Categories.ALL, '', 'Nessuna spesa nel periodo selezionato.');

    $('startCard').hidden = state.transactions.length > 0;
    renderCatList($('incCats'), inRows, inTot, openIncCats, Categories.INCOME, 'in:', 'Nessuna entrata nel periodo selezionato.');

    // Andamento mensile
    const byMonth = {};
    for (const { t } of all) {
      const k = t.date.slice(0, 7);
      const b = byMonth[k] || (byMonth[k] = { in: 0, out: 0 });
      if (t.amount > 0) b.in += t.amount; else b.out -= t.amount;
    }
    const ms = Object.keys(byMonth).sort();
    const tmax = Math.max(1, ...ms.map(k => Math.max(byMonth[k].in, byMonth[k].out)));
    $('trendCard').hidden = ms.length === 0;
    $('trend').innerHTML = ms.map(k => `<div class="trow">
        <span>${monthLabel(k)}</span>
        <div class="tbars">
          <div class="tbar pos-bg" style="width:${(byMonth[k].in / tmax * 100).toFixed(1)}%"></div>
          <div class="tbar neg-bg" style="width:${(byMonth[k].out / tmax * 100).toFixed(1)}%"></div>
        </div>
        <span class="tvals"><span class="pos">+${eur.format(byMonth[k].in)}</span><span class="neg">−${eur.format(byMonth[k].out)}</span></span>
      </div>`).join('');

    planRows = everything;
    renderToday(view);
    renderDeliveryVs();
    renderCalendar(view);
    renderSavings(view);
    renderSearch();
  }

  // =====================================================================
  //  Previsione "Quanto posso spendere oggi?" e calendario dei soldi
  // =====================================================================
  let planRows = [];                                  // tutti i movimenti con categoria (da renderSpese)
  // Categorie che non sono "spese variabili" (fisse, interne o movimenti di contanti)
  // investimenti: comprare crypto o azioni sposta i soldi, non li spende (non tocca il budget di oggi)
  const NOT_VARIABLE = new Set(['giroconti', 'affitto', 'finanziamenti', 'bollette', 'telefonia', 'abbonamenti', 'bonifici', 'prelievi', 'banca', 'investimenti']);
  const isVariable = x => x.t.amount < 0 && !NOT_VARIABLE.has(x.cat);
  const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const weekday = iso => new Date(iso + 'T12:00:00').getDay();          // 0 = domenica
  const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

  // Data e ora reali dell'acquisto, quando la banca le scrive nella descrizione
  // ("EFFETTUATO IL 01/07/2026 ALLE ORE 19:16" oppure "05/07- 18:32"); altrimenti la data contabile.
  function realWhen(t) {
    let m = t.desc.match(/effettuato il (\d{2})\/(\d{2})\/(\d{4}) alle ore (\d{2}):(\d{2})/i);
    if (m) return { date: `${m[3]}-${m[2]}-${m[1]}`, hour: +m[4] };
    m = t.desc.match(/(\d{2})\/(\d{2})-\s?(\d{2}):(\d{2})/);
    if (m) {
      let y = +t.date.slice(0, 4);
      if (+m[2] > +t.date.slice(5, 7)) y--;                              // acquisto di dicembre contabilizzato a gennaio
      return { date: `${y}-${m[2]}-${m[1]}`, hour: +m[3] };
    }
    return { date: t.date, hour: null };
  }

  // Stipendio: giorno del mese (scelto dall'utente o dedotto dall'ultimo accredito) e importo medio recente.
  function salaryInfo() {
    const pays = planRows.filter(x => x.cat === 'stipendio' && x.t.amount > 0).map(x => x.t).sort((a, b) => a.date.localeCompare(b.date));
    const last = pays.slice(-3);
    const amount = last.length ? last.reduce((s, t) => s + t.amount, 0) / last.length : 0;
    const day = state.forecast.payDay || (pays.length ? +pays[pays.length - 1].date.slice(8, 10) : 1);
    return { amount, day, dates: pays.map(t => t.date) };
  }
  function nextPayday(day, from) {
    const [y, m, d] = from.split('-').map(Number);
    const clamp = (yy, mm) => Math.min(day, new Date(Date.UTC(yy, mm, 0)).getUTCDate());
    if (d < clamp(y, m)) return `${y}-${String(m).padStart(2, '0')}-${String(clamp(y, m)).padStart(2, '0')}`;
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    return `${ny}-${String(nm).padStart(2, '0')}-${String(clamp(ny, nm)).padStart(2, '0')}`;
  }

  // Spese fisse che il riconoscimento abbonamenti non considera (affitto, rate): stessa persona/causale ogni mese.
  function fixedRecurring() {
    const groups = {};
    for (const x of planRows) {
      if (x.t.amount >= 0 || !['affitto', 'finanziamenti'].includes(x.cat)) continue;
      const p = party(x.t);
      (groups[p.key || p.name] = groups[p.key || p.name] || { p, cat: x.cat, txs: [] }).txs.push(x.t);
    }
    const dataEnd = planRows.reduce((m, x) => !x.t.manual && !x.t.pending && x.t.date > m ? x.t.date : m, '');
    return Object.values(groups).filter(g => new Set(g.txs.map(t => t.date.slice(0, 7))).size >= 2).map(g => {
      const last = g.txs.sort((a, b) => a.date.localeCompare(b.date))[g.txs.length - 1];
      return { key: 'fix:' + (g.p.key || g.p.name), name: g.cat === 'affitto' ? 'Affitto (' + g.p.name + ')' : 'Rata ' + g.p.name, amount: Math.abs(last.amount), lastDate: last.date, frequency: 'mensile' };
    }).filter(f => !Detector.isStale(f, dataEnd))                      // es. un finanziamento già estinto
      .filter(f => !state.loans.some(l => Math.abs(l.rate - f.amount) < 0.05));   // già nei prestiti inseriti a mano
  }

  // Tutti gli addebiti previsti (abbonamenti attivi + spese fisse) fra due date, ripetuti se cadono più volte.
  function plannedCharges(view, from, to) {
    const items = [
      ...view.subs.filter(s => s.active && s.next).map(s => ({ key: 'sub:' + s.id, name: s.name, amount: s.amount, first: s.next, frequency: s.frequency, end: s.endDate })),
      ...fixedRecurring().map(f => ({ key: f.key, name: f.name, amount: f.amount, first: Detector.nextChargeDate(f, from), frequency: 'mensile' })),
    ];
    const out = [];
    for (const it of items) {
      for (let d = it.first, i = 0; d && d < to && (!it.end || d < it.end) && i < 60; d = Detector.addPeriod(d, it.frequency), i++) {
        if (d >= from) out.push({ key: it.key, name: it.name, amount: it.amount, date: d });
      }
    }
    for (const l of state.loans) {
      for (const r of loanSchedule(l)) if (r.date >= from && r.date < to) out.push({ key: 'loan:' + l.id, name: l.name, amount: r.amount, date: r.date });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Spesa variabile media al giorno sugli ultimi 90 giorni di dati.
  function dailyRate() {
    const dates = planRows.filter(x => !x.t.manual && !x.t.pending).map(x => x.t.date).sort();
    if (!dates.length) return 0;
    const end = dates[dates.length - 1], start = addDays(end, -89) > dates[0] ? addDays(end, -89) : dates[0];
    const days = Detector.daysBetween(start, end) + 1;
    const total = planRows.filter(x => isVariable(x) && x.t.date >= start).reduce((s, x) => s - x.t.amount, 0);
    return total / days;
  }

  // =====================================================================
  //  Home "Oggi posso": quanto puoi ancora spendere oggi, fino allo stipendio.
  //  Periodo = dall'ultimo stipendio al giorno prima del prossimo.
  //  Budget di oggi = (saldo a inizio giornata − addebiti previsti − quota da parte) ÷ giorni che mancano.
  //  "Spese di tutti i giorni" = uscite variabili (senza bollette, abbonamenti, rate, bonifici…),
  //  con la data reale dell'acquisto, più le spese aggiunte a mano non ancora nell'estratto conto.
  // =====================================================================
  const NB = ' ', MINUS = '−';
  const num2 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = v => (v < -0.004 ? MINUS : '') + num2.format(Math.abs(v)) + NB + '€';
  const money0 = v => Math.round(v).toLocaleString('it-IT') + NB + '€';
  const dLong = iso => new Date(iso + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  const parseMoney = v => { const n = Parser.parseAmount(String(v ?? '').replace(MINUS, '-')); return n === null || !isFinite(n) ? NaN : n; };
  const toField = n => n === null || n === undefined ? '' : (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
  const catLabel = id => (Categories.byId[id] || {}).name || 'Altro';
  const quickTime = q => parseInt(String(q.id).slice(1), 36) || 0;     // gli id delle spese sono "q" + data in base 36
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Giorno dello stipendio in un mese (se il mese è più corto, l'ultimo giorno)
  function paydayIn(y, m, day) {
    const d = new Date(Date.UTC(y, m - 1, 1)), yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1;
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  }

  // Spese in sospeso non ancora arrivate come movimenti definitivi: lo stesso importo contabilizzato
  // da 1 giorno prima a 6 giorni dopo vuol dire che è arrivata. Dopo 20 giorni si considera superata.
  // Restituisce copie con pending: true, che entrano in tutte le pagine (con la scritta "in sospeso").
  function livePending() {
    const used = new Set(), today = todayIso();
    const booked = bankTx().filter(t => t.amount < 0);
    return (state.pendingTx || []).filter(p => {
      if (p.amount >= 0 || Detector.daysBetween(p.date, today) > 20) return false;
      const hit = booked.find(t => {
        if (used.has(t) || Math.abs(t.amount - p.amount) >= 0.01) return false;
        const d = Detector.daysBetween(p.date, realWhen(t).date);
        return d >= -1 && d <= 6;
      });
      if (hit) { used.add(hit); return false; }
      return true;
    }).map(p => Object.assign({}, p, { pending: true }));
  }

  let tdModel = null;
  function todayModel(view) {
    const f = state.forecast, today = todayIso(), sal = salaryInfo();
    const next = nextPayday(sal.day, today);                            // primo giorno del periodo successivo
    const [ny, nm] = next.split('-').map(Number);
    const start = paydayIn(ny, nm - 1, sal.day);
    const days = [];
    for (let d = start; d < next && days.length < 40; d = addDays(d, 1)) days.push(d);
    const T = Math.max(0, days.indexOf(today));
    const matched = matchQuick();
    const dataEnd = planRows.reduce((m, x) => !x.t.manual && !x.t.pending && x.t.date > m ? x.t.date : m, '');

    // Spese in sospeso in banca (dall'ultimo Excel) e spese aggiunte a mano: se una spesa a mano
    // corrisponde a una in sospeso (importo vicino, da 1 giorno prima a 4 dopo) conta quella della banca.
    const pend = planRows.filter(x => x.t.pending && isVariable(x));
    const usedPend = new Set();
    const quickLeft = state.quick.filter(q => {
      if (matched.has(q.id)) return false;
      const p = pend.find(x => !usedPend.has(x) && Math.abs(-x.t.amount - q.amount) <= Math.max(1, q.amount * 0.15)
        && (d => d >= -1 && d <= 4)(Detector.daysBetween(q.date, x.t.date)));
      if (p) { usedPend.add(p); return false; }
      return true;
    });
    const spends = [
      ...planRows.filter(x => !x.t.manual && isVariable(x)).map(x => ({ date: realWhen(x.t).date, amount: -x.t.amount, cat: x.cat, name: party(x.t).name, pending: !!x.t.pending, order: x.t.pending ? 1 : 0 })),
      ...quickLeft.map(q => ({ date: q.date, amount: q.amount, cat: q.cat, name: q.note, quick: q, order: quickTime(q) })),
    ];
    const byDay = days.map(() => 0), byCat = {}, quickDays = new Set();
    for (const s of spends) {
      const i = days.indexOf(s.date);
      if (i < 0 || i > T) continue;
      byDay[i] += s.amount;
      byCat[s.cat] = (byCat[s.cat] || 0) + s.amount;
      if (s.quick || s.pending) quickDays.add(s.date);
    }
    const spentToday = byDay[T] || 0;
    const daysLeft = days.length - T;
    const m = { today, start, next, days, T, byDay, byCat, quickDays, spends, dataEnd, spentToday, daysLeft, sal,
      balance: null, pool: null, allow: null, remaining: null, planned: [], fixedTot: 0, reserve: f.reserve || 0 };
    if (f.balance === null) return m;

    // Saldo di adesso: quello inserito, più i movimenti arrivati dopo con l'estratto conto,
    // meno le spese aggiunte a mano dopo averlo inserito.
    const bDate = f.balanceDate || today;
    const bAt = f.balanceAt || Date.parse(bDate + 'T23:59:59');
    const bankAfter = state.transactions.filter(t => !t.manual && t.date > bDate).reduce((s, t) => s + t.amount, 0);
    const quickAfter = quickLeft.filter(q => quickTime(q) > bAt).reduce((s, q) => s + q.amount, 0);
    const pendAfter = pend.filter(x => x.t.date > bDate).reduce((s, x) => s - x.t.amount, 0);
    m.balance = f.balance + bankAfter - quickAfter - pendAfter;
    m.balanceDate = bDate;
    m.balanceOld = Detector.daysBetween(bDate, today) >= 3 && !(dataEnd > bDate);
    m.planned = plannedCharges(view, today, next);
    m.fixedTot = m.planned.filter(p => !f.excluded[p.key]).reduce((s, p) => s + p.amount, 0);
    m.pool = m.balance + spentToday - m.fixedTot - m.reserve;           // disponibile da inizio giornata
    m.allow = m.pool / daysLeft;
    m.remaining = m.allow - spentToday;

    // Avanzato: per ogni giorno passato del periodo, budget di quel giorno meno quanto speso.
    // Il budget di oggi resta aggiornato fino a mezzanotte, poi non cambia più.
    const log = state.budgetLog || (state.budgetLog = {});
    if (log[today] === undefined || Math.abs(log[today] - m.allow) >= 0.005) {
      log[today] = Math.round(m.allow * 100) / 100;
      const old = addDays(today, -120);
      for (const d of Object.keys(log)) if (d < old) delete log[d];
      saveSoon();
    }
    let saved = 0, counted = 0, streak = 0, streakOpen = true;
    for (let i = T - 1; i >= 0; i--) {
      const d = days[i];
      if (log[d] === undefined || dayState(m, i) === 'unknown') { streakOpen = false; continue; }
      saved += log[d] - byDay[i]; counted++;
      if (streakOpen && byDay[i] <= log[d] + 0.004) streak++; else streakOpen = false;
    }
    m.saved = counted ? saved : null;
    m.streak = streak;
    return m;
  }

  // La stanza reagisce alla giornata: verde acqua entro il budget, ambra vicino al limite (80% speso), più scura se superato.
  // Il colore da solo non basta: la banda lo dice anche a parole.
  function todayMood(m) {
    if (m.allow === null) return '';
    if (m.remaining < -0.004) return 'over';
    if (m.allow <= 0 || m.spentToday >= m.allow * 0.8) return 'near';
    return 'ok';
  }
  function renderToday(view) {
    const m = tdModel = todayModel(view);
    m.mood = todayMood(m);
    if (m.mood) document.documentElement.dataset.mood = m.mood; else delete document.documentElement.dataset.mood;
    renderTodayBand(m);
    drawTodayChart(m);
    renderTodayTable(m);
    renderTodayChips(m);
    renderTodayCats(m);
    renderTodayList(m);
    renderTodayCheck();
    renderTodaySettings(m);
    renderFreed();
    renderFcPeriod(m);
    renderRecapBanner(m);
  }

  // ---------- Riepilogo del periodo scorso (schede da scorrere) ----------
  // Periodo scorso = dallo stipendio precedente al giorno prima di quello attuale.
  function recapData(m) {
    const [y, mo] = m.start.split('-').map(Number);
    const start = paydayIn(y, mo - 1, m.sal.day), end = addDays(m.start, -1);
    const rows = planRows.filter(x => x.t.date >= start && x.t.date <= end && !(Categories.byId[x.cat] || {}).excluded);
    const bankDays = new Set(rows.filter(x => !x.t.manual && !x.t.pending).map(x => x.t.date));
    if (bankDays.size < 10) return null;                                  // estratto conto troppo scarso per quel periodo
    const out = rows.filter(x => x.t.amount < 0), inc = rows.filter(x => x.t.amount > 0);
    const spent = out.reduce((s, x) => s - x.t.amount, 0), income = inc.reduce((s, x) => s + x.t.amount, 0);
    const byCat = {};
    for (const x of out) byCat[x.cat] = (byCat[x.cat] || 0) - x.t.amount;
    const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const byDay = {};
    for (const x of out.filter(isVariable)) { const d = realWhen(x.t).date; (byDay[d] = byDay[d] || { sum: 0, rows: [] }).sum -= x.t.amount; byDay[d].rows.push(x); }
    const top = Object.entries(byDay).sort((a, b) => b[1].sum - a[1].sum)[0];
    const topWho = top ? top[1].rows.sort((a, b) => a.t.amount - b.t.amount)[0] : null;
    let saved = null;
    const log = state.budgetLog || {};
    const logged = Object.keys(log).filter(d => d >= start && d <= end);
    if (logged.length >= 5) saved = logged.reduce((s, d) => s + log[d] - (byDay[d] ? byDay[d].sum : 0), 0);
    const subs = (view ? view.subs : []).filter(x => x.active);
    const topSub = subs.sort((a, b) => Detector.monthlyCost(b) - Detector.monthlyCost(a))[0];
    return { start, end, spent, income, cats, top, topWho, saved, topSub, freed: freedModel(), n: out.length };
  }
  function recapCards(r, m) {
    const cards = [];
    cards.push(`<p class="rc-kicker">Il tuo periodo</p><h2 id="recapTitle" class="rc-title">Dal ${fmtShort(r.start)} al ${fmtShort(r.end)}</h2><p class="rc-text">Ecco com'è andata, in poche schede.</p>`);
    cards.push(`<p class="rc-kicker">Uscite ed entrate</p><p class="rc-big">${money0(r.spent)}</p><p class="rc-text">spesi in ${r.n} movimenti.</p>
      <p class="rc-text">Sono entrati <b>${money0(r.income)}</b>: ${r.income >= r.spent ? `ti sono rimasti <b>${money0(r.income - r.spent)}</b>.` : `hai speso <b>${money0(r.spent - r.income)}</b> più di quanto è entrato.`}</p>`);
    if (r.cats.length) {
      const max = r.cats[0][1];
      cards.push(`<p class="rc-kicker">Dove sono andati</p><h2 class="rc-title">Le tre voci più grandi</h2>
        <ol class="rc-cats">${r.cats.map(([id, v]) => `<li><div class="rc-cat-h"><span>${esc(catLabel(id))}</span><b>${money0(v)}</b></div><div class="td-track"><span style="width:${(v / max * 100).toFixed(1)}%"></span></div></li>`).join('')}</ol>`);
    }
    if (r.top) cards.push(`<p class="rc-kicker">Il giorno più caro</p><h2 class="rc-title">${esc(dLong(r.top[0]))}</h2><p class="rc-big">${money0(r.top[1].sum)}</p>
      <p class="rc-text">${r.top[1].rows.length} ${r.top[1].rows.length === 1 ? 'spesa' : 'spese'}${r.topWho ? `, la più grande da <b>${esc(party(r.topWho.t).name)}</b> (${money0(-r.topWho.t.amount)})` : ''}.</p>`);
    if (r.saved !== null) cards.push(`<p class="rc-kicker">Il budget di ogni giorno</p><p class="rc-big">${money0(Math.abs(r.saved))}</p>
      <p class="rc-text">${r.saved >= 0 ? 'avanzati rispetto al budget di ogni giorno. Bel lavoro.' : 'oltre il budget di ogni giorno, sommando le giornate.'}</p>`);
    if (r.freed) cards.push(`<p class="rc-kicker">Soldi liberati</p><p class="rc-big">${money0(r.freed.amount)}</p>
      <p class="rc-text">rimasti a te: da ${r.freed.since} giorni niente uscite per giochi e scommesse.</p>`);
    if (r.topSub) cards.push(`<p class="rc-kicker">L'abbonamento più caro</p><h2 class="rc-title">${esc(r.topSub.name)}</h2>
      <p class="rc-big">${money0(Detector.monthlyCost(r.topSub) * 12)}</p><p class="rc-text">all'anno, cioè ${money(Detector.monthlyCost(r.topSub))} al mese. Lo usi ancora?</p>`);
    cards.push(`<p class="rc-kicker">Si riparte</p><h2 class="rc-title">Nuovo periodo fino al ${fmtShort(addDays(m.next, -1))}</h2>
      ${m.allow !== null ? `<p class="rc-big">${money0(m.allow)}</p><p class="rc-text">è il tuo budget di oggi.</p>` : '<p class="rc-text">Scrivi il saldo in "Oggi posso" per avere il budget di ogni giorno.</p>'}`);
    return cards;
  }
  let recap = null;
  function renderRecapBanner(m) {
    const r = recapData(m), b = $('recapBanner');
    recap = r ? { r, cards: recapCards(r, m), i: 0, start: r.start } : null;
    const fresh = r && Detector.daysBetween(m.start, m.today) <= 7 && state.recapSeen !== r.start;
    b.hidden = !fresh;
    if (fresh) $('recapBannerSub').textContent = `Dal ${fmtShort(r.start)} al ${fmtShort(r.end)}: dove sono andati i soldi, il giorno più caro e quanto è avanzato.`;
    $('recapLink').hidden = !r;
  }
  function showRecapCard() {
    const { cards, i } = recap;
    $('recapCard').innerHTML = cards[i];
    $('recapSteps').innerHTML = cards.map((_, k) => `<span class="${k <= i ? 'on' : ''}"></span>`).join('');
    $('recapCount').textContent = `${i + 1} di ${cards.length}`;
    $('recapPrev').disabled = i === 0;
    $('recapNext').textContent = i === cards.length - 1 ? 'Chiudi' : 'Avanti';
    const c = $('recapCard');
    c.classList.remove('rc-in'); void c.offsetWidth; c.classList.add('rc-in');
  }
  function openRecap() {
    if (!recap) return;
    recap.i = 0;
    state.recapSeen = recap.start; save();
    $('recapBanner').hidden = true;
    $('recapDlg').showModal();
    showRecapCard();
    $('recapNext').focus();
  }
  function wireRecap() {
    const step = d => {
      if (!recap) return;
      const n = recap.i + d;
      if (n >= recap.cards.length) return $('recapDlg').close();
      if (n < 0) return;
      recap.i = n; showRecapCard();
    };
    $('recapOpen').onclick = openRecap;
    $('recapLink').onclick = openRecap;
    $('recapLater').onclick = () => { if (recap) { state.recapSeen = recap.start; save(); } $('recapBanner').hidden = true; };
    $('recapNext').onclick = () => step(1);
    $('recapPrev').onclick = () => step(-1);
    $('recapClose').onclick = () => $('recapDlg').close();
    $('recapDlg').addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    });
    // Scorrimento col dito: a sinistra avanti, a destra indietro
    let sx = null;
    const card = $('recapCard');
    card.addEventListener('pointerdown', e => { sx = e.clientX; });
    card.addEventListener('pointerup', e => { if (sx === null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); });
  }

  // ---------- Previsione fino allo stipendio ----------
  // Saldo di fine giornata da oggi al giorno prima dello stipendio: si tolgono la spesa di tutti i giorni
  // (media degli ultimi 3 mesi, modificabile col cursore) e gli addebiti previsti nel loro giorno.
  let fcRate = null;                                    // scelta col cursore; null = media
  function renderFcPeriod(m) {
    const sec = $('tdForecast');
    sec.hidden = m.allow === null;
    if (sec.hidden) return;
    const avg = Math.max(0, Math.round(dailyRate()));
    const rate = fcRate === null ? avg : fcRate;
    const slider = $('tdFcRate');
    slider.max = String(Math.max(50, Math.ceil(Math.max(avg, m.allow > 0 ? m.allow : 0) * 2 / 10) * 10));
    if (document.activeElement !== slider) slider.value = String(rate);
    $('tdFcRateOut').textContent = money0(rate);
    $('tdFcHint').textContent = `La tua media degli ultimi 3 mesi è ${money0(avg)} al giorno; il budget di oggi è ${money(m.allow)}. Sposta il cursore per vedere cosa cambia.`;

    const charges = m.planned.filter(p => !state.forecast.excluded[p.key]);
    const pts = [];
    let bal = m.balance;
    for (let i = 0; i < m.daysLeft; i++) {
      const d = addDays(m.today, i);
      if (i > 0) bal -= rate;                           // oggi le spese fatte sono già nel saldo
      bal -= charges.filter(p => p.date === d).reduce((s, p) => s + p.amount, 0);
      pts.push({ d, bal });
    }
    const end = pts[pts.length - 1].bal, below = pts.find(p => p.bal < 0);
    $('tdFcSum').innerHTML = below
      ? `<b class="fc-neg">Il conto va sotto zero il ${esc(dLong(below.d))}.</b> Al ritmo di ${money0(rate)} al giorno arrivi allo stipendio del ${fmtShort(m.next)} con <b class="fc-neg">${money(end)}</b>.`
      : `Al ritmo di ${money0(rate)} al giorno arrivi allo stipendio del ${fmtShort(m.next)} con <b>${money(end)}</b>${m.reserve ? `, compresi i ${money(m.reserve)} da mettere da parte` : ''}.`;

    // Grafico: linea del saldo, linea dello zero, punti sugli addebiti previsti
    const box = $('tdFcChart'), W = Math.max(300, Math.floor(box.clientWidth || 600)), H = 170, mg = { t: 16, r: 12, b: 26, l: 12 };
    const vals = pts.map(p => p.bal).concat([0, m.balance]);
    const maxV = Math.max(...vals), minV = Math.min(...vals), span = Math.max(1, maxV - minV);
    const x = i => mg.l + i * (W - mg.l - mg.r) / Math.max(1, pts.length - 1);
    const y = v => mg.t + (maxV - v) * (H - mg.t - mg.b) / span;
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.bal).toFixed(1)}`).join(' ');
    const neg = !!below;
    const dots = charges.map(p => {
      const i = pts.findIndex(q => q.d === p.date);
      return i < 0 ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(pts[i].bal).toFixed(1)}" r="4" style="fill:var(--bg);stroke:var(--text)" stroke-width="2"><title>${esc(p.name)} ${money(p.amount)} il ${esc(dLong(p.date))}</title></circle>`;
    }).join('');
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Saldo previsto da oggi allo stipendio: da ${money(m.balance)} a ${money(end)}">
      <polygon points="${x(0).toFixed(1)},${y(Math.max(0, minV)).toFixed(1)} ${line} ${x(pts.length - 1).toFixed(1)},${y(Math.max(0, minV)).toFixed(1)}" style="fill:${neg ? 'var(--warn-mark)' : 'var(--accent)'}" opacity=".14"/>
      <line x1="${mg.l}" x2="${W - mg.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" style="stroke:var(--muted)" stroke-width="1" stroke-dasharray="4 4"/>
      <polyline points="${line}" fill="none" style="stroke:${neg ? 'var(--warn-mark)' : 'var(--accent)'}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      <text class="ax" x="${mg.l}" y="${H - 6}">oggi ${money0(m.balance)}</text>
      <text class="ax" x="${W - mg.r}" y="${H - 6}" text-anchor="end">${fmtShort(addDays(m.next, -1))}: ${money0(end)}</text>
    </svg>`;
  }

  // ---------- Banda con il numero di oggi ----------
  let heroShown = null, heroRaf = 0, meterShown = 0;
  function paintHero(v) {
    const s = num2.format(Math.abs(v)), k = s.lastIndexOf(',');
    const i = $('tdHeroInt'), d = $('tdHeroDec');
    if (i) { i.textContent = s.slice(0, k); d.textContent = s.slice(k); }
  }
  function setHero(v) {
    cancelAnimationFrame(heroRaf);
    if (heroShown === null || reduceMotion() || Math.abs(v - heroShown) < 0.005) { heroShown = v; paintHero(v); return; }
    const from = heroShown, t0 = performance.now(), dur = 450;
    const step = t => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      heroShown = from + (v - from) * e; paintHero(heroShown);
      if (p < 1) heroRaf = requestAnimationFrame(step); else { heroShown = v; paintHero(v); }
    };
    heroRaf = requestAnimationFrame(step);
  }

  function renderTodayBand(m) {
    const el = $('todayBand');
    const period = `<p class="td-period">Periodo dal ${fmtShort(m.start)} al ${fmtShort(addDays(m.next, -1))}</p>`;
    if (m.allow === null) {
      heroShown = null;
      el.innerHTML = `<div class="td-setup">
        ${period}
        <h2 id="tdLabel">Quanto puoi spendere oggi?</h2>
        <p>Scrivi il saldo che vedi nell'app della banca. Tolgo gli addebiti previsti fino allo stipendio e divido quello che resta per i giorni che mancano.</p>
        <form id="tdSetupForm" novalidate>
          <div class="td-set">
            <div><label class="lbl" for="tdSetupBalance">Saldo del conto</label><input class="inp" id="tdSetupBalance" name="balance" inputmode="decimal" autocomplete="off" placeholder="Per esempio: 342,83" aria-describedby="tdSetupErr"></div>
            <div><label class="lbl" for="tdSetupDay">Giorno dello stipendio</label><input class="inp" id="tdSetupDay" name="payDay" inputmode="numeric" autocomplete="off" value="${m.sal.day}"></div>
          </div>
          <p class="err" id="tdSetupErr" hidden></p>
          <button class="btn" type="submit">Calcola il budget di oggi</button>
        </form>
      </div>`;
      return;
    }
    const neg = m.remaining < -0.004;
    const pct = m.allow > 0 ? Math.min(100, m.spentToday / m.allow * 100) : 100;
    const left = m.pool - m.spentToday;
    const payday = fmtShort(m.next);
    const parts = [];
    if (m.fixedTot) parts.push(`gli addebiti previsti (${money(m.fixedTot)})`);
    if (m.reserve) parts.push(`quello che metti da parte (${money(m.reserve)})`);
    const note = m.pool <= 0
      ? `Gli addebiti previsti${m.reserve ? ' e la quota da parte' : ''} superano il saldo: fino allo stipendio del ${payday} non resta budget per le spese di tutti i giorni.`
      : `Fino allo stipendio del ${payday} restano <b>${money(left)}</b> per le spese di tutti i giorni${parts.length ? ', tolti ' + parts.join(' e ') : ''}. Il budget di oggi li divide per i giorni che mancano.`;
    const stale = m.balanceOld
      ? `<p class="td-warn"><svg class="ico" aria-hidden="true"><use href="#i-alert"/></svg><span>Il saldo è del ${fmtShort(m.balanceDate)}. <button type="button" class="link" data-td-balance>Aggiorna il saldo</button> per un numero preciso.</span></p>` : '';
    const firstPaint = !$('tdHeroInt');
    el.innerHTML = `
      <div class="td-band-top"><p class="td-label" id="tdLabel">${neg ? 'Oggi hai superato il budget di' : 'Oggi puoi ancora spendere'}</p>${period}</div>
      <p class="td-hero" aria-live="polite" aria-atomic="true"><span id="tdHeroInt"></span><span class="dec" id="tdHeroDec"></span><span class="cur">€</span></p>
      <div class="td-meter${neg ? ' over' : ''}" role="presentation"><span id="tdMeter" style="transform:scaleX(${meterShown.toFixed(4)})"></span></div>
      <dl class="td-stats">
        <div><dt>Budget di oggi</dt><dd>${money(m.allow)}</dd></div>
        <div><dt>Già speso oggi</dt><dd>${money(m.spentToday)}</dd></div>
        <div><dt>Giorni allo stipendio</dt><dd>${m.daysLeft} ${m.daysLeft === 1 ? 'giorno' : 'giorni'}</dd></div>
        ${m.saved !== null ? `<div><dt>${m.saved < -0.004 ? 'Sforato nel periodo' : 'Avanzato nel periodo'}</dt><dd>${money(Math.abs(m.saved))}</dd></div>` : ''}
      </dl>
      ${m.mood === 'near' && !neg ? `<p class="td-warn"><svg class="ico" aria-hidden="true"><use href="#i-alert"/></svg><span>Sei vicino al limite di oggi: restano ${money(m.remaining)}.</span></p>` : ''}
      <p class="td-note">${note}${m.saved === null ? ' Da domani conto anche quanto ti avanza ogni giorno.'
        : m.streak >= 2 ? ` Sei entro il budget da ${m.streak} giorni di fila.` : ''}</p>${stale}`;
    if (firstPaint) heroShown = heroShown === null || reduceMotion() ? null : 0;
    paintHero(heroShown === null ? Math.abs(m.remaining) : heroShown);
    setHero(Math.abs(m.remaining));
    meterShown = pct / 100;
    requestAnimationFrame(() => requestAnimationFrame(() => { const b = $('tdMeter'); if (b) b.style.transform = `scaleX(${meterShown.toFixed(4)})`; }));
  }

  // ---------- Grafico delle giornate ----------
  let tdGeo = null, tdActive = null;
  function dayState(m, i) {
    const d = m.days[i];
    if (i > m.T) return 'future';
    if (state.transactions.length && m.dataEnd && d > m.dataEnd && !m.quickDays.has(d) && i < m.T) return 'unknown';
    return 'known';
  }
  function drawTodayChart(m) {
    const holder = $('tdChartSvg'), box = $('tdChart');
    const N = m.days.length, W = Math.max(300, Math.floor(holder.clientWidth || box.clientWidth || 360)), H = 196;
    const mg = { t: 22, r: 8, b: 28, l: 40 }, iw = W - mg.l - mg.r, bw = iw / N, ph = H - mg.t - mg.b;
    const ref = m.allow !== null && m.allow > 0 ? m.allow : null;
    let maxV = Math.max(ref ? ref * 2 : 0, ...m.byDay, 10) * 1.05;
    const steps = [10, 20, 25, 50, 100, 200, 500, 1000];
    let step = 1000;
    for (const s of steps) if (maxV / s <= 4) { step = s; break; }
    maxV = Math.ceil(maxV / step) * step;
    const y = v => mg.t + ph * (1 - v / maxV);
    tdGeo = { W, mg, bw };
    let out = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`;
    for (let g = 0; g <= maxV; g += step) {
      out += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${y(g)}" y2="${y(g)}" style="stroke:var(--border)" stroke-width="1"/>`;
      out += `<text class="ax" x="${mg.l - 8}" y="${y(g) + 4}" text-anchor="end">${g}</text>`;
    }
    out += `<rect id="tdHl" x="0" y="${mg.t}" width="${bw}" height="${ph}" style="fill:var(--border)" opacity=".55" visibility="hidden"/>`;
    for (let i = 0; i < N; i++) {
      const x = mg.l + i * bw + 1, w = Math.max(2, bw - 2), base = y(0), v = m.byDay[i], st = dayState(m, i);
      if (st === 'known' && v > 0.004) {
        const h = Math.max(2, base - y(v)), r = Math.min(3, w / 2, h);
        const col = i === m.T ? 'var(--mark-today)' : ref && v > ref ? 'var(--warn-mark)' : 'var(--mark)';
        out += `<path d="M${x} ${base}V${base - h + r}Q${x} ${base - h} ${x + r} ${base - h}H${x + w - r}Q${x + w} ${base - h} ${x + w} ${base - h + r}V${base}Z" style="fill:${col}"/>`;
        if (i === m.T) out += `<text class="ax" x="${x + w / 2}" y="${base - h - 6}" text-anchor="middle" style="fill:var(--text)">oggi</text>`;
      } else {
        out += `<rect x="${x}" y="${base - 2}" width="${w}" height="2" rx="1" style="fill:var(--border)"${st === 'unknown' ? ' opacity=".5"' : ''}/>`;
        if (i === m.T) out += `<text class="ax" x="${x + w / 2}" y="${base - 8}" text-anchor="middle" style="fill:var(--text)">oggi</text>`;
      }
    }
    if (ref) {
      const ry = y(ref);
      out += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${ry}" y2="${ry}" style="stroke:var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
      out += `<text class="ax halo" x="${W - mg.r}" y="${ry - 6}" text-anchor="end">budget di oggi ${money0(ref)}</text>`;
    }
    for (let k = 0; k < N; k++) {
      const d = m.days[k], dn = +d.slice(8, 10);
      let lab = null, anchor = 'middle';
      if (k === 0) { lab = fmtShort(d); anchor = 'start'; }
      else if (dn === 1) lab = fmtShort(d);
      else if (k % 5 === 0 && k < N - 2 && !m.days.slice(Math.max(0, k - 4), k + 5).some(x => x.endsWith('-01'))) lab = String(dn);
      if (lab) out += `<text class="ax" x="${k === 0 ? mg.l : mg.l + k * bw + bw / 2}" y="${H - 8}" text-anchor="${anchor}">${lab}</text>`;
    }
    holder.innerHTML = out + '</svg>';
    const over = ref ? m.byDay.filter((v, i) => i < m.T && v > ref).length : 0;
    box.setAttribute('aria-label', `Spesa per giorno dal ${fmtShort(m.start)}. Oggi ${money(m.spentToday)}.` +
      (ref ? ` ${over} ${over === 1 ? 'giorno' : 'giorni'} sopra il budget di oggi.` : '') + ' Usa le frecce sinistra e destra per scorrere i giorni.');
    if (tdActive !== null) showTodayTip(tdActive);
  }
  function showTodayTip(i) {
    const m = tdModel; if (!m || !tdGeo) return;
    tdActive = i;
    const tip = $('tdTip'), hl = $('tdHl'), st = dayState(m, i), v = m.byDay[i];
    const ref = m.allow !== null && m.allow > 0 ? m.allow : null;
    let body = `<b>${esc(dLong(m.days[i]))}</b>`;
    if (st === 'future') body += 'Giorno non ancora arrivato';
    else if (st === 'unknown') body += 'Estratto conto non ancora caricato';
    else {
      body += `Speso ${money(v)}`;
      if (ref) body += `<br>${v > ref ? 'Sopra' : 'Sotto'} il budget di oggi di ${money(Math.abs(v - ref))}`;
    }
    tip.innerHTML = body; tip.hidden = false;
    const tw = tip.offsetWidth, cx = tdGeo.mg.l + (i + .5) * tdGeo.bw;
    tip.style.left = Math.min(tdGeo.W - tw / 2, Math.max(tw / 2, cx)) + 'px';
    if (hl) { hl.setAttribute('x', tdGeo.mg.l + i * tdGeo.bw); hl.setAttribute('visibility', 'visible'); }
  }
  function hideTodayTip() {
    tdActive = null; $('tdTip').hidden = true;
    const hl = $('tdHl'); if (hl) hl.setAttribute('visibility', 'hidden');
  }
  function renderTodayTable(m) {
    const ref = m.allow !== null && m.allow > 0 ? m.allow : null;
    let rows = '';
    for (let i = m.T; i >= 0; i--) {
      const st = dayState(m, i), v = m.byDay[i];
      const diff = st === 'unknown' ? 'Estratto conto non caricato' : ref ? (v - ref >= 0 ? '+' : MINUS) + num2.format(Math.abs(v - ref)) + NB + '€' : '–';
      rows += `<tr><td>${esc(dLong(m.days[i]))}</td><td>${st === 'unknown' ? '–' : money(v)}</td><td>${diff}</td></tr>`;
    }
    $('tdTbody').innerHTML = rows;
  }

  // ---------- Aggiungi una spesa ----------
  let tdCat = null;
  function renderTodayChips(m) {
    const since = addDays(m.today, -90), count = {};
    for (const s of m.spends) if (s.date >= since) count[s.cat] = (count[s.cat] || 0) + 1;
    const cats = LIMIT_CATS.filter(c => !NOT_VARIABLE.has(c.id) && c.id !== 'abbonamenti').sort((a, b) => (count[b.id] || 0) - (count[a.id] || 0)).slice(0, 8);
    if (!tdCat || !cats.some(c => c.id === tdCat)) tdCat = cats[0] ? cats[0].id : 'altro';
    $('tdChips').innerHTML = cats.map(c => `<label class="td-chip"><input type="radio" name="cat" value="${c.id}"${c.id === tdCat ? ' checked' : ''}><span>${esc(c.name)}</span></label>`).join('');
  }

  // ---------- Categorie e ultime spese ----------
  function renderTodayCats(m) {
    const rows = Object.entries(m.byCat).filter(([, v]) => v > 0.004).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (!rows.length) { $('tdCats').innerHTML = `<p class="td-empty">Nessuna spesa da inizio periodo. Quando ne aggiungi una, compare qui.</p>`; return; }
    const total = Object.values(m.byCat).reduce((s, v) => s + v, 0);
    $('tdCats').innerHTML = rows.map(([id, v]) => `<div class="td-cat">
      <div class="td-cat-h"><span class="td-cat-n">${esc(catLabel(id))}</span><span class="td-cat-v">${money(v)}, ${Math.round(v / total * 100)}%</span></div>
      <div class="td-track"><span style="width:${(v / rows[0][1] * 100).toFixed(1)}%"></span></div></div>`).join('');
  }
  function relDay(iso, today) {
    if (iso === today) return 'oggi';
    if (iso === addDays(today, -1)) return 'ieri';
    return dLong(iso);
  }
  function renderTodayList(m) {
    const arr = m.spends.filter(s => s.date <= m.today).sort((a, b) => b.date.localeCompare(a.date) || b.order - a.order).slice(0, 8);
    if (!arr.length) {
      $('tdList').innerHTML = `<li class="td-empty">Nessuna spesa ancora. Aggiungi la prima con il modulo qui sopra, oppure carica l'estratto conto.</li>`;
      return;
    }
    $('tdList').innerHTML = arr.map(s => {
      const title = esc(s.name || catLabel(s.cat));
      const meta = (s.name ? esc(catLabel(s.cat)) + ', ' : '') + esc(relDay(s.date, m.today)) + (s.quick ? ', in attesa dell\'estratto conto' : s.pending ? ', in sospeso in banca' : '');
      return `<li class="td-row"><div class="td-row-t"><div>${title}</div><div class="td-row-m">${meta}</div></div>
        <span class="td-row-a">${money(s.amount)}</span>
        ${s.quick ? `<button class="td-del" type="button" data-td-del="${esc(s.quick.id)}" aria-label="Elimina ${title}, ${money(s.amount)}">Elimina</button>` : '<span></span>'}</li>`;
    }).join('');
  }

  // ---------- Prima di comprare ----------
  function renderTodayCheck() {
    const m = tdModel, out = $('tdCheckOut'), raw = $('tdPrice').value, p = parseMoney(raw);
    if (!m) return;
    if (m.allow === null) { out.innerHTML = `<p class="td-hint">Scrivi il saldo del conto qui sopra: poi ti dico come cambia il budget se compri qualcosa.</p>`; return; }
    if (!raw.trim() || isNaN(p) || p <= 0) {
      out.innerHTML = `<p class="td-hint">${raw.trim() ? 'Scrivi un prezzo maggiore di zero, per esempio 24,90.' : 'Scrivi un prezzo per vedere come cambia il numero di oggi.'}</p>`;
      return;
    }
    const after = m.remaining - p;
    let html = `<dl class="td-res"><div><dt>Oggi ti resterebbero</dt><dd class="${after < 0 ? 'neg' : ''}">${money(after)}<small>${after < 0 ? 'oltre il budget di oggi' : 'entro il budget di oggi'}</small></dd></div>`;
    if (m.daysLeft > 1) {
      const rest = m.pool - m.spentToday, cur = rest / (m.daysLeft - 1), nw = (rest - p) / (m.daysLeft - 1);
      html += `<div><dt>Budget al giorno da domani</dt><dd>${money(nw)}<small>senza questo acquisto ${money(cur)}</small></dd></div>`;
    }
    if (m.allow > 0) {
      const d = p / m.allow;
      html += `<div><dt>Equivale a</dt><dd>${d.toLocaleString('it-IT', { maximumFractionDigits: 1 })} ${Math.abs(d - 1) < 0.05 ? 'giorno' : 'giorni'}<small>del tuo budget di oggi</small></dd></div>`;
    }
    out.innerHTML = html + '</dl>';
  }

  // ---------- Parametri del periodo ----------
  function renderTodaySettings(m) {
    const f = state.forecast, fill = (id, v) => { const el = $(id); if (document.activeElement !== el && el.getAttribute('aria-invalid') !== 'true') el.value = v; };
    fill('tdBalance', toField(f.balance));
    fill('tdPayDay', String(m.sal.day));
    fill('tdReserve', toField(f.reserve || 0));
    $('tdPool').innerHTML = m.pool === null
      ? 'Scrivi il saldo per calcolare il budget.'
      : `Per le spese di tutti i giorni fino al ${fmtShort(m.next)}: <b>${money(m.pool)}</b>` +
        (m.pool < 0 ? `<br><span class="err">Gli addebiti superano il saldo. Togli quelli che non arriveranno o riduci la quota da parte.</span>` : '');
    const det = $('tdPlanned'), wasOpen = det.open;
    det.hidden = m.allow === null || !m.planned.length;
    if (det.hidden) return;
    const on = m.planned.filter(p => !f.excluded[p.key]);
    det.innerHTML = `<summary>Addebiti previsti prima dello stipendio: ${money(m.fixedTot)} (${on.length})</summary>
      <ul>${m.planned.map((p, i) => `<li class="${f.excluded[p.key] ? 'off' : ''}"><label><input type="checkbox" data-fc-key="${esc(p.key)}"${f.excluded[p.key] ? '' : ' checked'}>
        <span>${fmtShort(p.date)}</span><span>${esc(p.name)}</span><b>${money(p.amount)}</b></label></li>`).join('')}</ul>
      <p class="td-foot">Togli la spunta agli addebiti che non arriveranno prima dello stipendio.</p>`;
    det.open = wasOpen;
  }

  // ---------- Soldi liberati ----------
  // Se prima c'erano uscite per giochi e scommesse e da almeno 7 giorni non ce ne sono più,
  // mostra quanto resta in tasca rispetto alla media di prima. Si può nascondere.
  function freedModel() {
    if (state.freed.hidden) return null;
    const bank = planRows.filter(x => !x.t.manual);
    const bets = bank.filter(x => x.cat === 'scommesse' && x.t.amount < 0);
    if (bets.length < 3) return null;
    const dataStart = bank.reduce((m, x) => !m || x.t.date < m ? x.t.date : m, '');
    const last = bets.reduce((m, x) => { const d = realWhen(x.t).date; return d > m ? d : m; }, '');
    const today = todayIso(), since = Detector.daysBetween(last, today);
    const before = Detector.daysBetween(dataStart, last) + 1;
    if (since < 7 || before < 60) return null;
    const total = bets.reduce((s, x) => s - x.t.amount, 0), perDay = total / before;
    const from = state.freed.movedUntil && state.freed.movedUntil > last ? state.freed.movedUntil : last;
    const days = Detector.daysBetween(from, today);
    return { since, perMonth: perDay * 30.4, amount: Math.round(perDay * days), moved: from !== last };
  }
  function renderFreed() {
    const el = $('tdFreed'), f = freedModel();
    el.hidden = !f;
    if (!f) return;
    const goals = state.savings.goals.filter(g => g.saved < g.target);
    const action = !f.amount ? '' : goals.length
      ? `<form class="td-freed-act" id="tdFreedForm">
          <div><label class="lbl" for="tdFreedGoal">Obiettivo</label>
            <select class="inp" id="tdFreedGoal">${goals.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select></div>
          <button class="btn" type="submit">Aggiungi ${money0(f.amount)} all'obiettivo</button>
        </form>`
      : `<p class="td-foot"><a class="link" href="#/risparmio">Crea un obiettivo nel Piano di risparmio</a> per dare una destinazione a questi soldi.</p>`;
    el.innerHTML = `<div class="td-head"><h2 id="tdFreedH" class="td-ph">Soldi liberati</h2>
        <button class="td-del" type="button" data-freed-hide>Nascondi</button></div>
      <p class="td-sub">Da ${f.since} giorni non ci sono uscite per giochi e scommesse. Prima ne uscivano in media ${money0(f.perMonth)} al mese.</p>
      <p class="td-freed-big"><b>${money0(f.amount)}</b> ${f.moved ? 'in più da quando li hai messi da parte l’ultima volta' : 'rimasti a te in questi giorni'}</p>
      ${action}`;
  }

  // ---------- Domicilio o spesa? (pagina Delivery) ----------
  function renderDeliveryVs() {
    const el = $('deliveryVs');
    const bank = planRows.filter(x => !x.t.manual && x.t.amount < 0);
    const end = bank.reduce((m, x) => x.t.date > m ? x.t.date : m, '');
    if (!end) { el.hidden = true; return; }
    const start = addDays(end, -89);
    const inWin = cat => bank.filter(x => x.cat === cat && x.t.date >= start);
    const orders = inWin('delivery'), grocery = inWin('spesa');
    if (orders.length < 2) { el.hidden = true; return; }
    el.hidden = false;
    const oTot = orders.reduce((s, x) => s - x.t.amount, 0), gTot = grocery.reduce((s, x) => s - x.t.amount, 0);
    const avgOrder = oTot / orders.length, perMonth = oTot / 90 * 30.4, perWeekGrocery = gTot / 90 * 7;
    const cap = Math.max(5, Math.round(perMonth * 0.75 / 5) * 5);
    const lims = state.limits.filter(l => l.cat === 'delivery');
    const same = lims.find(l => l.period === 'month' && Math.abs(l.amount - cap) < 0.5);
    el.innerHTML = `<h2 id="deliveryVsH">Domicilio o spesa?</h2>
      <p class="muted">Negli ultimi 3 mesi di estratto conto, fino al ${fmtShort(end)}.</p>
      <dl class="td-res">
        <div><dt>Ordini a domicilio</dt><dd>${orders.length}<small>circa ${(orders.length / 90 * 30.4).toLocaleString('it-IT', { maximumFractionDigits: 1 })} al mese</small></dd></div>
        <div><dt>Ordine medio</dt><dd>${money(avgOrder)}</dd></div>
        <div><dt>Al mese per il domicilio</dt><dd>${money(perMonth)}<small>${money(perMonth * 12)} all'anno</small></dd></div>
        ${gTot ? `<div><dt>Spesa al supermercato a settimana</dt><dd>${money(perWeekGrocery)}<small>un ordine medio vale ${(avgOrder / perWeekGrocery * 7).toLocaleString('it-IT', { maximumFractionDigits: 1 })} giorni di spesa</small></dd></div>` : ''}
        <div><dt>Ordinando la metà delle volte</dt><dd>${money(perMonth / 2)} in meno al mese<small>${money(perMonth * 6)} all'anno</small></dd></div>
      </dl>
      <p class="td-hint">Limite consigliato: <b>${money0(cap)} al mese</b>, un quarto in meno della tua media.
        ${lims.length ? `Adesso hai ${lims.map(l => `${money0(l.amount)} ${PERIOD_LABEL[l.period]}`).join(' e ')}.` : ''}</p>
      ${same ? '<p class="td-foot">Questo limite è già attivo.</p>' : `<button class="btn" type="button" data-dv-cap="${cap}">Imposta il limite di ${money0(cap)} al mese</button>`}`;
  }

  // =====================================================================
  //  Investimenti in crypto: operazioni (acquisti e vendite), valore di oggi con i prezzi di CoinGecko,
  //  andamento nel tempo e movimenti del conto verso gli exchange.
  //  A CoinGecko si mandano solo gli identificativi delle monete (es. "ripple"), mai quantità o altri dati.
  // =====================================================================
  const INV_COINS = [
    ['bitcoin', 'BTC', 'Bitcoin'], ['ethereum', 'ETH', 'Ethereum'], ['ripple', 'XRP', 'XRP'], ['solana', 'SOL', 'Solana'],
    ['binancecoin', 'BNB', 'BNB'], ['cardano', 'ADA', 'Cardano'], ['dogecoin', 'DOGE', 'Dogecoin'], ['tron', 'TRX', 'TRON'],
    ['the-open-network', 'TON', 'Toncoin'], ['avalanche-2', 'AVAX', 'Avalanche'], ['polkadot', 'DOT', 'Polkadot'], ['chainlink', 'LINK', 'Chainlink'],
    ['litecoin', 'LTC', 'Litecoin'], ['stellar', 'XLM', 'Stellar'], ['shiba-inu', 'SHIB', 'Shiba Inu'], ['pepe', 'PEPE', 'Pepe'],
    ['tether', 'USDT', 'Tether'], ['usd-coin', 'USDC', 'USD Coin'],
  ];
  const CG = 'https://api.coingecko.com/api/v3';
  const CDC = 'https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=';
  const invState = () => state.invest || (state.invest = { ops: [], prices: {}, hist: {}, custom: {} });
  const coinInfo = id => { const c = INV_COINS.find(x => x[0] === id); if (c) return { id, symbol: c[1], name: c[2] }; const k = invState().custom[id]; return k ? Object.assign({ id }, k) : { id, symbol: id.toUpperCase(), name: id }; };
  const qtyFmt = n => n.toLocaleString('it-IT', { maximumFractionDigits: 8 });
  const priceFmt = n => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 }) + NB + '€';
  const opCost = o => o.qty * o.price + (o.fee || 0);

  // Posizioni: per ogni moneta quantità posseduta, costo di carico (con le commissioni) e guadagno già realizzato.
  // Vendita al costo medio: il costo di carico scende in proporzione alla quantità venduta.
  function invPositions(upTo) {
    const pos = {};
    for (const o of [...invState().ops].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
      if (upTo && o.date > upTo) continue;
      const p = pos[o.coin] || (pos[o.coin] = { coin: o.coin, qty: 0, cost: 0, realized: 0, bought: 0 });
      if (o.type === 'buy') { p.qty += o.qty; p.cost += opCost(o); p.bought += opCost(o); }
      else {
        const avg = p.qty > 0 ? p.cost / p.qty : 0, q = Math.min(o.qty, p.qty);
        p.realized += q * o.price - (o.fee || 0) - avg * q;
        p.cost -= avg * q; p.qty -= q;
      }
    }
    return pos;
  }
  async function cgGet(path) {
    const r = await fetch(CG + path, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('CoinGecko ' + r.status);
    return r.json();
  }
  // Ultimo prezzo di una coppia sull'exchange di Crypto.com (API pubblica, nessun dato personale); null se non c'è
  async function cdcLast(pair) {
    try {
      const r = await fetch(CDC + encodeURIComponent(pair), { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json(), t = j && j.code === 0 && j.result && j.result.data && j.result.data[0];
      const v = t ? parseFloat(t.a) : NaN;
      return v > 0 ? v : null;
    } catch (e) { return null; }
  }
  let invFetching = false, invError = '';
  // Prezzi di oggi (al massimo ogni 5 minuti) e storico giornaliero (al massimo ogni 6 ore), solo per le monete possedute
  async function refreshInvest(force) {
    const S = invState(), ids = [...new Set(S.ops.map(o => o.coin))];
    if (!ids.length || invFetching || !navigator.onLine) return;
    const now = Date.now(), stale = id => !S.prices[id] || now - S.prices[id].at > 5 * 60e3;
    invFetching = true; invError = '';
    try {
      if (force || ids.some(stale)) {
        const data = await cgGet(`/simple/price?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=eur,usd`);
        for (const id of ids) if (data[id] && typeof data[id].eur === 'number') S.prices[id] = { eur: data[id].eur, at: now, src: 'cg' };
        // Dove possibile il prezzo viene da Crypto.com (dove sono state comprate le monete): coppia in euro,
        // altrimenti coppia in dollari convertita con il cambio implicito di CoinGecko. Se non risponde resta CoinGecko.
        await Promise.all(ids.map(async id => {
          const sym = coinInfo(id).symbol.toUpperCase(), cg = data[id] || {};
          let eurPrice = await cdcLast(sym + '_EUR');
          if (eurPrice === null && cg.eur > 0 && cg.usd > 0) {
            const usd = await cdcLast(sym + '_USD');
            if (usd !== null) eurPrice = usd * cg.eur / cg.usd;
          }
          if (eurPrice !== null) S.prices[id] = { eur: eurPrice, at: now, src: 'cdc' };
        }));
      }
      const first = S.ops.reduce((m, o) => !m || o.date < m ? o.date : m, '');
      const days = Math.min(365, Math.max(2, Detector.daysBetween(first, todayIso()) + 2));
      for (const id of ids) {
        const h = S.hist[id];
        if (h && now - h.at < 6 * 3600e3 && h.days >= days) continue;
        const data = await cgGet(`/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=${days}&interval=daily`);
        const map = {};
        for (const [ms, price] of data.prices || []) { const d = new Date(ms); map[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = price; }
        S.hist[id] = { at: now, days, prices: map };
      }
      saveSoon();
    } catch (e) {
      invError = 'Non riesco a scaricare i prezzi aggiornati adesso: uso gli ultimi salvati. Riprova tra qualche minuto.';
    } finally {
      invFetching = false;
      if (location.hash === '#/investimenti') renderInvest();
    }
  }

  function renderInvest() {
    const S = invState(), pos = invPositions(), coins = Object.values(pos).filter(p => p.qty > 1e-12 || p.realized);
    const sel = $('invCoin'), keep = sel.value;
    const owned = Object.keys(S.custom).map(id => [id, S.custom[id].symbol, S.custom[id].name]);
    sel.innerHTML = [...INV_COINS, ...owned].map(([id, sym, name]) => `<option value="${esc(id)}">${esc(name)}${sym !== name ? ` (${esc(sym)})` : ''}</option>`).join('') + '<option value="__altra">Altra moneta…</option>';
    sel.value = keep || 'ripple';
    $('invOtherBox').hidden = sel.value !== '__altra';
    if (!$('invDate').value) $('invDate').value = todayIso();
    $('invDate').max = todayIso();
    invTotal();

    let invested = 0, value = 0, realized = 0, missing = 0, oldest = Infinity;
    const rows = coins.map(p => {
      const pr = S.prices[p.coin];
      if (p.qty > 1e-12 && !pr) missing++;
      if (pr) oldest = Math.min(oldest, pr.at);
      const v = pr ? p.qty * pr.eur : null;
      invested += p.cost; realized += p.realized; if (v !== null) value += v;
      return { p, pr, v, gain: v === null ? null : v - p.cost };
    });
    const gain = value - invested, pct = invested > 0 ? gain / invested * 100 : 0;
    const word = g => g >= 0 ? 'Guadagno' : 'Perdita';
    const when = oldest < Infinity ? new Date(oldest).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
    $('invKpis').innerHTML = `
      <div class="kpi"><span class="label">Investito</span><span class="value">${eur.format(invested)}</span><span class="hint">costo di carico, con le commissioni</span></div>
      <div class="kpi"><span class="label">Valore oggi</span><span class="value accent">${missing ? '–' : eur.format(value)}</span><span class="hint">${invFetching ? 'aggiornamento dei prezzi…' : when ? 'prezzi delle ' + when : 'prezzi non ancora scaricati'}</span></div>
      <div class="kpi"><span class="label">${word(gain)}</span><span class="value ${gain >= 0 ? 'pos' : 'neg'}">${missing ? '–' : (gain >= 0 ? '+' : '−') + eur.format(Math.abs(gain))}</span><span class="hint">${missing ? '' : (gain >= 0 ? '+' : '−') + Math.abs(pct).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + '% su quanto investito'}</span></div>
      <div class="kpi"><span class="label">Già realizzato</span><span class="value ${realized >= 0 ? 'pos' : 'neg'}">${(realized >= 0 ? '+' : '−') + eur.format(Math.abs(realized))}</span><span class="hint">guadagno o perdita delle vendite</span></div>`;

    $('invCoins').innerHTML = `<div class="card-head"><h2>Le tue monete</h2><button class="btn ghost small-btn" type="button" id="invRefresh"${invFetching ? ' disabled' : ''}>Aggiorna i prezzi</button></div>
      ${invError ? `<p class="status error">${esc(invError)}</p>` : ''}
      ${rows.length ? `<div class="td-tablewrap"><table class="inv-table">
        <thead><tr><th scope="col">Moneta</th><th scope="col">Quantità</th><th scope="col">Prezzo medio</th><th scope="col">Prezzo oggi</th><th scope="col">Valore</th><th scope="col">Guadagno o perdita</th><th scope="col">Peso</th></tr></thead>
        <tbody>${rows.map(({ p, pr, v, gain: g }) => {
          const c = coinInfo(p.coin);
          return `<tr><th scope="row">${esc(c.name)}${c.symbol !== c.name ? ` <small>${esc(c.symbol)}</small>` : ''}</th>
            <td>${qtyFmt(p.qty)}</td><td>${p.qty > 1e-12 ? priceFmt(p.cost / p.qty) : '–'}</td><td>${pr ? `${priceFmt(pr.eur)}<small class="inv-src">${pr.src === 'cdc' ? 'Crypto.com' : 'CoinGecko'}</small>` : '–'}</td>
            <td><b>${v === null ? '–' : eur.format(v)}</b></td>
            <td class="${g === null ? '' : g >= 0 ? 'pos' : 'neg'}">${g === null ? '–' : `${g >= 0 ? 'guadagno +' : 'perdita −'}${eur.format(Math.abs(g))} (${(p.cost ? Math.abs(g / p.cost * 100) : 0).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%)`}</td>
            <td>${v !== null && value > 0 ? Math.round(v / value * 100) + '%' : '–'}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="muted">Nessun investimento ancora. Aggiungi il primo acquisto con il modulo qui sotto.</p>'}`;

    renderInvestChart(pos);

    const ops = [...S.ops].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    $('invOps').innerHTML = `<h2>Operazioni</h2>${ops.length ? `<ul class="inv-ops">${ops.map(o => { const c = coinInfo(o.coin); return `<li>
        <span class="tx-date">${fmtDate(o.date)}</span>
        <span>${o.type === 'buy' ? 'Acquisto' : 'Vendita'} di <b>${qtyFmt(o.qty)} ${esc(c.symbol)}</b><small>a ${priceFmt(o.price)}${o.fee ? `, commissioni ${eur.format(o.fee)}` : ''}</small></span>
        <b class="${o.type === 'buy' ? '' : 'pos'}">${eur.format(o.type === 'buy' ? opCost(o) : o.qty * o.price - (o.fee || 0))}</b>
        <button class="td-del" type="button" data-inv-del="${esc(o.id)}" aria-label="Elimina ${o.type === 'buy' ? 'acquisto' : 'vendita'} di ${qtyFmt(o.qty)} ${esc(c.symbol)} del ${fmtDate(o.date)}">Elimina</button></li>`; }).join('')}</ul>` : '<p class="muted">Ancora nessuna operazione.</p>'}`;

    // Movimenti del conto verso gli exchange (categoria "Investimenti e crypto")
    const bank = planRows.filter(x => x.cat === 'investimenti').sort((a, b) => b.t.date.localeCompare(a.t.date));
    const out = bank.filter(x => x.t.amount < 0).reduce((s, x) => s - x.t.amount, 0), back = bank.filter(x => x.t.amount > 0).reduce((s, x) => s + x.t.amount, 0);
    const bought = Object.values(pos).reduce((s, p) => s + p.bought, 0);
    $('invBank').innerHTML = `<h2>Dal conto</h2>
      <p class="muted small">Bonifici e pagamenti verso gli exchange (Binance, Coinbase, Young Platform…). Contano come investimento, non come spesa: non toccano il budget di "Oggi posso".</p>
      ${bank.length ? `<p>Dal conto sono partiti <b>${eur.format(out)}</b>${back ? ` e sono tornati <b>${eur.format(back)}</b>` : ''}. Hai registrato acquisti per <b>${eur.format(bought)}</b>.</p>
        <ul class="inv-ops">${bank.slice(0, 12).map(x => `<li><span class="tx-date">${fmtDate(x.t.date)}</span><span>${esc(party(x.t).name)}${x.t.pending ? '<small>in sospeso</small>' : ''}</span>
          <b class="${x.t.amount > 0 ? 'pos' : ''}">${x.t.amount > 0 ? '+' : '−'}${eur.format(Math.abs(x.t.amount))}</b><span></span></li>`).join('')}</ul>`
        : '<p class="muted">Nessun movimento verso un exchange nell’estratto conto. Se un bonifico verso l’exchange è finito in un’altra categoria, spostalo in "Investimenti e crypto" dalla pagina Uscite.</p>'}`;
  }

  function renderInvestChart(pos) {
    const S = invState(), el = $('invChart'), ops = [...S.ops].sort((a, b) => a.date.localeCompare(b.date));
    if (!ops.length) { el.innerHTML = '<p class="muted">Il grafico compare dopo il primo acquisto.</p>'; return; }
    const ids = [...new Set(ops.map(o => o.coin))];
    if (ids.some(id => !S.hist[id])) { el.innerHTML = `<p class="muted">${invFetching ? 'Sto scaricando l’andamento dei prezzi…' : 'Andamento non disponibile: servono i prezzi passati, che si scaricano con la rete attiva.'}</p>`; return; }
    const pts = [];
    const last = {};
    for (let d = ops[0].date; d <= todayIso(); d = addDays(d, 1)) {
      const p = invPositions(d);
      let v = 0, inv = 0;
      for (const id of ids) {
        const pr = (S.hist[id].prices[d] ?? (d === todayIso() && S.prices[id] ? S.prices[id].eur : undefined)) ?? last[id];
        if (pr !== undefined) last[id] = pr;
        if (p[id]) { v += p[id].qty * (last[id] || 0); inv += p[id].cost; }
      }
      pts.push({ d, v, inv });
      if (pts.length > 400) break;
    }
    if (pts.length < 2) pts.unshift(Object.assign({}, pts[0], { d: addDays(pts[0].d, -1) }));
    const W = Math.max(300, Math.floor(el.clientWidth || 600)), H = 190, mg = { t: 14, r: 12, b: 26, l: 12 };
    const vals = pts.flatMap(p => [p.v, p.inv]), maxV = Math.max(...vals) * 1.04, minV = Math.min(...vals) * .96, span = Math.max(1, maxV - minV);
    const x = i => mg.l + i * (W - mg.l - mg.r) / (pts.length - 1), y = v => mg.t + (maxV - v) * (H - mg.t - mg.b) / span;
    const line = k => pts.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
    const end = pts[pts.length - 1], up = end.v >= end.inv;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Valore degli investimenti dal ${fmtShort(pts[0].d)}: oggi ${eur.format(end.v)} contro ${eur.format(end.inv)} investiti">
      <polygon points="${x(0).toFixed(1)},${H - mg.b} ${line('v')} ${x(pts.length - 1).toFixed(1)},${H - mg.b}" style="fill:${up ? 'var(--accent)' : 'var(--warn-mark)'}" opacity=".14"/>
      <polyline points="${line('inv')}" fill="none" style="stroke:var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>
      <polyline points="${line('v')}" fill="none" style="stroke:${up ? 'var(--accent)' : 'var(--warn-mark)'}" stroke-width="2.5" stroke-linejoin="round"/>
      <text class="ax" x="${mg.l}" y="${H - 6}">${fmtShort(pts[0].d)}</text>
      <text class="ax" x="${W - mg.r}" y="${H - 6}" text-anchor="end">oggi ${eur.format(end.v)}</text>
    </svg>
    <p class="td-legend"><span><i style="background:${up ? 'var(--accent)' : 'var(--warn-mark)'}"></i>Valore</span><span><i class="dash"></i>Investito</span></p>`;
  }

  function invTotal() {
    const q = Parser.parseAmount($('invQty').value), pr = Parser.parseAmount($('invPrice').value), fee = Parser.parseAmount($('invFee').value) || 0;
    const buy = $('invForm').querySelector('input[name=type]:checked').value === 'buy';
    $('invTotal').textContent = q > 0 && pr > 0 ? `${buy ? 'Totale pagato' : 'Totale incassato'}: ${eur.format(buy ? q * pr + fee : q * pr - fee)}` : '';
  }

  function wireInvest() {
    const f = $('invForm');
    const err = (input, el, msg) => setFieldErr($(input), $(el), msg);
    f.addEventListener('input', e => {
      invTotal();
      if (e.target.id === 'invQty') err('invQty', 'invQtyErr', '');
      if (e.target.id === 'invPrice') err('invPrice', 'invPriceErr', '');
      if (e.target.id === 'invOther') err('invOther', 'invOtherErr', '');
    });
    f.addEventListener('change', e => { if (e.target.id === 'invCoin') $('invOtherBox').hidden = e.target.value !== '__altra'; invTotal(); });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const S = invState(), type = f.querySelector('input[name=type]:checked').value;
      const qty = Parser.parseAmount($('invQty').value), price = Parser.parseAmount($('invPrice').value), fee = Math.abs(Parser.parseAmount($('invFee').value) || 0);
      const date = $('invDate').value || todayIso();
      let coin = $('invCoin').value, ok = true;
      if (!(qty > 0)) { err('invQty', 'invQtyErr', 'Scrivi la quantità con un numero maggiore di zero, per esempio 565,116.'); ok = false; }
      if (!(price > 0)) { err('invPrice', 'invPriceErr', 'Scrivi il prezzo di una moneta in euro, per esempio 0,85908.'); ok = false; }
      if (coin === '__altra') {
        const sym = $('invOther').value.trim().toUpperCase();
        if (!sym) { err('invOther', 'invOtherErr', 'Scrivi la sigla della moneta, per esempio HBAR.'); ok = false; }
        else if (ok) {
          try {
            const data = await cgGet('/search?query=' + encodeURIComponent(sym));
            const hit = (data.coins || []).filter(c => String(c.symbol).toUpperCase() === sym).sort((a, b) => (a.market_cap_rank || 1e9) - (b.market_cap_rank || 1e9))[0];
            if (!hit) { err('invOther', 'invOtherErr', `Non trovo una moneta con la sigla ${sym}. Controlla come la scrive l'exchange.`); return; }
            S.custom[hit.id] = { symbol: String(hit.symbol).toUpperCase(), name: hit.name };
            coin = hit.id;
          } catch (x) { err('invOther', 'invOtherErr', 'Per cercare una moneta nuova serve la rete. Riprova quando sei online.'); return; }
        }
      }
      if (!ok) { (f.querySelector('[aria-invalid="true"]') || $('invQty')).focus(); return; }
      if (type === 'sell') {
        const held = (invPositions(date)[coin] || { qty: 0 }).qty;
        if (qty > held + 1e-9) { err('invQty', 'invQtyErr', `Al ${fmtDate(date)} hai ${qtyFmt(held)} ${coinInfo(coin).symbol}: non puoi venderne di più.`); $('invQty').focus(); return; }
      }
      const op = { id: 'i' + Date.now().toString(36), type, coin, qty, price, fee, date };
      S.ops.push(op);
      save();
      $('invQty').value = $('invPrice').value = $('invFee').value = ''; $('invOther').value = '';
      renderInvest(); refreshInvest(true);
      toast(`${type === 'buy' ? 'Acquisto' : 'Vendita'} aggiunt${type === 'buy' ? 'o' : 'a'}: ${qtyFmt(qty)} ${coinInfo(coin).symbol}.`, () => { S.ops = S.ops.filter(o => o.id !== op.id); save(); renderInvest(); });
    });
    $('invOps').addEventListener('click', e => {
      const b = e.target.closest('[data-inv-del]'); if (!b) return;
      const S = invState(), op = S.ops.find(o => o.id === b.dataset.invDel); if (!op) return;
      S.ops = S.ops.filter(o => o !== op); save(); renderInvest();
      toast('Operazione eliminata.', () => { S.ops.push(op); save(); renderInvest(); });
    });
    $('invCoins').addEventListener('click', e => { if (e.target.id === 'invRefresh') { refreshInvest(true); renderInvest(); } });
    window.addEventListener('hashchange', () => { if (location.hash === '#/investimenti') { renderInvest(); refreshInvest(); } });
    window.addEventListener('online', () => { if (location.hash === '#/investimenti') refreshInvest(); });
  }

  // ---------- Avviso in basso con "Annulla" ----------
  let toastTimer = 0;
  function toast(msg, undo) {
    const w = $('toastWrap'), t = $('toast');
    t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="link" type="button" id="toastUndo">Annulla</button>' : ''}`;
    w.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { w.hidden = true; }, 6000);
    if (undo) $('toastUndo').onclick = () => { w.hidden = true; undo(); };
  }

  function setFieldErr(input, errEl, msg) {
    if (msg) { errEl.textContent = msg; errEl.hidden = false; input.setAttribute('aria-invalid', 'true'); }
    else { errEl.hidden = true; input.removeAttribute('aria-invalid'); }
  }
  let tdSaveTimer = 0;
  const saveSoon = () => { clearTimeout(tdSaveTimer); tdSaveTimer = setTimeout(save, 600); };

  function wireToday() {
    wireRecap();
    wireInvest();
    // Aggiungi una spesa: vale per oggi; finisce fra le "spese segnate" della pagina I miei limiti
    const amount = $('tdAmount'), amountErr = $('tdAmountErr');
    amount.addEventListener('input', () => { if (!amountErr.hidden) setFieldErr(amount, amountErr, ''); });
    amount.addEventListener('blur', () => {
      const v = parseMoney(amount.value);
      if (amount.value.trim() && (isNaN(v) || v <= 0)) setFieldErr(amount, amountErr, 'Scrivi un importo maggiore di zero, per esempio 12,50.');
    });
    $('tdChips').addEventListener('change', e => { if (e.target.name === 'cat') tdCat = e.target.value; });
    $('tdAddForm').addEventListener('submit', e => {
      e.preventDefault();
      const v = parseMoney(amount.value);
      if (isNaN(v) || v <= 0) { setFieldErr(amount, amountErr, 'Scrivi un importo maggiore di zero, per esempio 12,50.'); amount.focus(); return; }
      const item = { id: 'q' + Date.now().toString(36), cat: tdCat, amount: Math.round(Math.abs(v) * 100) / 100, date: todayIso(), note: $('tdNote').value.trim() };
      state.quick.push(item);
      save();
      amount.value = $('tdNote').value = '';
      setFieldErr(amount, amountErr, '');
      render();
      toast(`Spesa aggiunta: ${money(item.amount)}.`, () => { state.quick = state.quick.filter(q => q.id !== item.id); save(); render(); });
      amount.focus();
    });
    $('tdList').addEventListener('click', e => {
      const b = e.target.closest('[data-td-del]');
      if (!b) return;
      const item = state.quick.find(q => q.id === b.dataset.tdDel);
      if (!item) return;
      state.quick = state.quick.filter(q => q !== item);
      save(); render();
      toast('Spesa eliminata.', () => { state.quick.push(item); save(); render(); });
      $('tdAmount').focus();
    });
    $('tdPrice').addEventListener('input', renderTodayCheck);
    $('tdFcRate').addEventListener('input', e => { fcRate = Number(e.target.value); if (tdModel) renderFcPeriod(tdModel); });

    // Soldi liberati: aggiunti a un obiettivo del Piano di risparmio, oppure nascosti
    $('tdFreed').addEventListener('submit', e => {
      if (e.target.id !== 'tdFreedForm') return;
      e.preventDefault();
      const f = freedModel(), g = state.savings.goals.find(x => x.id === $('tdFreedGoal').value);
      if (!f || !g || !f.amount) return;
      const prev = { saved: g.saved, movedUntil: state.freed.movedUntil };
      g.saved = Math.round((g.saved + f.amount) * 100) / 100;
      state.freed.movedUntil = todayIso();
      save(); renderToday(view); renderSavings(view);
      toast(`Aggiunti ${money0(f.amount)} a "${g.name}".`, () => { g.saved = prev.saved; state.freed.movedUntil = prev.movedUntil; save(); renderToday(view); renderSavings(view); });
    });
    $('tdFreed').addEventListener('click', e => {
      if (!e.target.closest('[data-freed-hide]')) return;
      state.freed.hidden = true; save(); renderFreed(); renderHidden();
      toast('Soldi liberati nascosto.', () => { state.freed.hidden = false; save(); renderFreed(); });
      $('tdAmount').focus();
    });

    // Domicilio o spesa: imposta il limite consigliato (sostituisce un limite mensile già esistente)
    $('deliveryVs').addEventListener('click', e => {
      const b = e.target.closest('[data-dv-cap]');
      if (!b) return;
      const cap = Number(b.dataset.dvCap), old = state.limits.find(l => l.cat === 'delivery' && l.period === 'month');
      const before = old ? old.amount : null;
      if (old) old.amount = cap; else state.limits.push({ id: 'lim' + Date.now().toString(36), cat: 'delivery', period: 'month', amount: cap });
      save(); render();
      toast(`Limite impostato: ${money0(cap)} al mese per il cibo a domicilio.`, () => {
        if (before !== null) state.limits.find(l => l.cat === 'delivery' && l.period === 'month').amount = before;
        else state.limits = state.limits.filter(l => !(l.cat === 'delivery' && l.period === 'month' && l.amount === cap));
        save(); render();
      });
    });

    // Prima volta: saldo e giorno dello stipendio dentro la banda
    $('todayBand').addEventListener('submit', e => {
      if (e.target.id !== 'tdSetupForm') return;
      e.preventDefault();
      const f = e.target, bal = parseMoney(f.balance.value), day = parseInt(f.payDay.value, 10);
      const err = $('tdSetupErr');
      if (isNaN(bal)) { setFieldErr(f.balance, err, 'Scrivi il saldo in euro, per esempio 342,83. Se il conto è in rosso, metti il meno davanti.'); f.balance.focus(); return; }
      if (!(day >= 1 && day <= 31)) { setFieldErr(f.payDay, err, 'Scrivi il giorno dello stipendio con un numero da 1 a 31.'); f.payDay.focus(); return; }
      Object.assign(state.forecast, { balance: bal, balanceDate: todayIso(), balanceAt: Date.now(), payDay: day });
      save();
      renderToday(view);
      $('tdLabel').setAttribute('tabindex', '-1');
      $('tdLabel').focus();
    });
    $('todayBand').addEventListener('input', e => {
      const err = $('tdSetupErr');
      if (err && !err.hidden && e.target.getAttribute('aria-invalid') === 'true') setFieldErr(e.target, err, '');
    });
    $('todayBand').addEventListener('click', e => {
      if (!e.target.closest('[data-td-balance]')) return;
      $('tdBalance').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
      $('tdBalance').focus({ preventScroll: true });
      $('tdBalance').select();
    });

    // Parametri: ogni valore valido ricalcola subito; gli errori compaiono quando lasci il campo
    const rules = {
      tdBalance: { err: 'tdBalanceErr', parse: v => parseMoney(v), ok: n => !isNaN(n), msg: 'Scrivi il saldo in euro, per esempio 342,83. Se il conto è in rosso, metti il meno davanti.',
        set: n => Object.assign(state.forecast, { balance: n, balanceDate: todayIso(), balanceAt: Date.now() }) },
      tdPayDay: { err: 'tdPayDayErr', parse: v => Number(String(v).trim()), ok: n => Number.isInteger(n) && n >= 1 && n <= 31, msg: 'Scrivi un giorno da 1 a 31.',
        set: n => { state.forecast.payDay = n; } },
      tdReserve: { err: 'tdReserveErr', parse: v => String(v).trim() === '' ? 0 : parseMoney(v), ok: n => !isNaN(n) && n >= 0, msg: 'Scrivi una cifra uguale o maggiore di zero, per esempio 50.',
        set: n => { state.forecast.reserve = Math.round(n * 100) / 100; } },
    };
    const sf = $('tdSetForm');
    sf.addEventListener('submit', e => e.preventDefault());
    sf.addEventListener('input', e => {
      const r = rules[e.target.id]; if (!r) return;
      const n = r.parse(e.target.value);
      if (!r.ok(n)) return;
      setFieldErr(e.target, $(r.err), '');
      r.set(n); saveSoon(); renderToday(view);
    });
    sf.addEventListener('focusout', e => {
      const r = rules[e.target.id]; if (!r) return;
      if (e.target.id === 'tdBalance' && !e.target.value.trim() && state.forecast.balance === null) return;
      const ok = r.ok(r.parse(e.target.value));
      setFieldErr(e.target, $(r.err), ok ? '' : r.msg);
      if (ok) renderToday(view);
    });
    $('tdPlanned').addEventListener('change', e => {
      const box = e.target.closest('[data-fc-key]');
      if (!box) return;
      if (box.checked) delete state.forecast.excluded[box.dataset.fcKey];
      else state.forecast.excluded[box.dataset.fcKey] = true;
      save();
      renderToday(view);
      const again = document.querySelector(`[data-fc-key="${CSS.escape(box.dataset.fcKey)}"]`);
      if (again) again.focus();
    });

    // Grafico: tocco, mouse e frecce della tastiera
    const ch = $('tdChart');
    const idxFromX = x => { const r = $('tdChartSvg').getBoundingClientRect(); return Math.max(0, Math.min(tdModel.days.length - 1, Math.floor((x - r.left - tdGeo.mg.l) / tdGeo.bw))); };
    ch.addEventListener('pointermove', e => { if (tdGeo && tdModel) showTodayTip(idxFromX(e.clientX)); });
    ch.addEventListener('pointerdown', e => { if (tdGeo && tdModel) showTodayTip(idxFromX(e.clientX)); });
    ch.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTodayTip(); });
    ch.addEventListener('blur', hideTodayTip);
    ch.addEventListener('keydown', e => {
      if (!tdModel) return;
      let i = tdActive === null ? tdModel.T : tdActive;
      if (e.key === 'ArrowRight') i = Math.min(tdModel.days.length - 1, i + 1);
      else if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
      else if (e.key === 'Escape') { hideTodayTip(); return; }
      else return;
      e.preventDefault(); showTodayTip(i);
    });
    let lastW = 0, rt = 0;
    if (window.ResizeObserver) new ResizeObserver(() => {
      const w = Math.floor(ch.clientWidth);
      if (!w || w === lastW || !tdModel) return;
      lastW = w; clearTimeout(rt); rt = setTimeout(() => drawTodayChart(tdModel), 60);
    }).observe(ch);
  }

  // Calendario del mese: entrate, uscite, addebiti previsti, intensità di spesa e abitudini.
  let calMonth = todayIso().slice(0, 7);
  let calDay = null;
  function renderCalendar(view) {
    const el = $('calendar');
    const [y, m] = calMonth.split('-').map(Number);
    const first = `${calMonth}-01`;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const today = todayIso();

    const byDay = {};
    for (const x of planRows) {
      if ((Categories.byId[x.cat] || {}).excluded) continue;
      const w = realWhen(x.t);
      if (!w.date.startsWith(calMonth)) continue;
      const d = byDay[w.date] || (byDay[w.date] = { in: 0, out: 0, rows: [] });
      if (x.t.amount > 0) d.in += x.t.amount; else d.out -= x.t.amount;
      d.rows.push(Object.assign({ hour: w.hour }, x));
    }
    const lastDay = `${calMonth}-${String(daysInMonth).padStart(2, '0')}`;
    const future = today <= lastDay ? plannedCharges(view, today > first ? today : first, addDays(lastDay, 1)) : [];
    const sal = salaryInfo();
    const payday = state.transactions.length ? nextPayday(sal.day, addDays(first, -1)) : null;
    const maxOut = Math.max(1, ...Object.values(byDay).map(d => d.out));

    let cells = '';
    const lead = (weekday(first) + 6) % 7;                        // il calendario parte dal lunedì
    for (let i = 0; i < lead; i++) cells += '<div class="cal-cell empty"></div>';
    for (let n = 1; n <= daysInMonth; n++) {
      const d = `${calMonth}-${String(n).padStart(2, '0')}`;
      const info = byDay[d];
      const plan = future.filter(p => p.date === d);
      const isPay = payday === d && d >= today;
      const heat = info && info.out ? Math.min(0.85, 0.12 + 0.73 * info.out / maxOut) : 0;
      cells += `<button class="cal-cell${d === today ? ' today' : ''}${d === calDay ? ' sel' : ''}" data-day="${d}"
          style="${heat ? `--heat:${heat.toFixed(2)}` : ''}">
        <span class="cal-n">${n}</span>
        ${info && info.in ? `<span class="cal-in">+${eur.format(info.in)}</span>` : ''}
        ${info && info.out ? `<span class="cal-out">−${eur.format(info.out)}</span>` : ''}
        ${isPay ? `<span class="cal-plan pay">Stipendio${sal.amount ? ' ~' + eur.format(sal.amount) : ''}</span>` : ''}
        ${plan.slice(0, 2).map(p => `<span class="cal-plan">${esc(p.name)} ${eur.format(p.amount)}</span>`).join('')}
        ${plan.length > 2 ? `<span class="cal-plan more">+${plan.length - 2} altri</span>` : ''}
      </button>`;
    }
    const monthIn = Object.values(byDay).reduce((s, d) => s + d.in, 0);
    const monthOut = Object.values(byDay).reduce((s, d) => s + d.out, 0);
    const plannedTot = future.reduce((s, p) => s + p.amount, 0);

    // Dettaglio del giorno selezionato
    let detail = '';
    if (calDay && calDay.startsWith(calMonth)) {
      const info = byDay[calDay];
      const plan = future.filter(p => p.date === calDay);
      const rows = info ? groupRoundups([...info.rows].sort((a, b) => (a.hour ?? 99) - (b.hour ?? 99)), x => x.t, (x, t) => ({ t, hour: null })) : [];
      detail = `<div class="cal-detail"><h3>${new Date(calDay + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
        ${rows.length || plan.length ? `<ul class="tx-mini">${rows.map(x => `<li>
            <span class="tx-date">${x.hour !== null ? String(x.hour).padStart(2, '0') + ':00' : '—'}</span>
            <span class="tx-what">${esc(x.t.roundups ? roundupName(x.t) : party(x.t).name)}</span>
            <b class="${x.t.amount < 0 ? 'neg' : 'pos'}">${x.t.amount < 0 ? '−' : '+'}${eur.format(Math.abs(x.t.amount))}</b></li>`).join('')}
          ${plan.map(p => `<li class="planned"><span class="tx-date">previsto</span><span class="tx-what">${esc(p.name)}</span><b>−${eur.format(p.amount)}</b></li>`).join('')}</ul>`
          : '<p class="muted small">Nessun movimento in questo giorno.</p>'}</div>`;
    }

    el.innerHTML = `
      <div class="cal-head">
        <button class="btn ghost" data-cal="-1" aria-label="Mese precedente">‹</button>
        <h2>${monthLabel(calMonth)}</h2>
        <button class="btn ghost" data-cal="1" aria-label="Mese successivo">›</button>
        <span class="cal-sum">${monthIn ? `<span class="pos">+${eur.format(monthIn)}</span>` : ''} ${monthOut ? `<span class="neg">−${eur.format(monthOut)}</span>` : ''}
          ${plannedTot ? `<span class="muted">· previsti −${eur.format(plannedTot)}</span>` : ''}</span>
      </div>
      <div class="cal-grid">
        ${['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(w => `<div class="cal-wd">${w}</div>`).join('')}
        ${cells}
      </div>
      <div class="cal-legend"><span class="sw heat"></span>più è rosso, più hai speso · <span class="sw plan"></span>addebito previsto · <span class="sw pay"></span>stipendio previsto
        <br><span class="small muted">I pagamenti con carta sono nel giorno reale dell'acquisto, non in quello di contabilizzazione.</span></div>
      ${detail}`;

    $('habits').innerHTML = habitsHTML();
  }

  // Abitudini di spesa calcolate su tutto lo storico (solo spese variabili).
  function habitsHTML() {
    const rows = planRows.filter(isVariable).map(x => Object.assign({ w: realWhen(x.t), v: -x.t.amount }, x));
    if (rows.length < 15) return '<p class="muted">Servono più movimenti per riconoscere le tue abitudini.</p>';
    const dates = planRows.filter(x => !x.t.manual).map(x => x.t.date).sort();
    const totalDays = Detector.daysBetween(dates[0], dates[dates.length - 1]) + 1;
    const out = [];

    // Giorni della settimana: media al giorno (somma / numero di quei giorni nel periodo)
    const perWd = Array(7).fill(0);
    for (const r of rows) perWd[weekday(r.w.date)] += r.v;
    const nWd = Array(7).fill(0);
    for (let d = dates[0]; d <= dates[dates.length - 1]; d = addDays(d, 1)) nWd[weekday(d)]++;
    const avgWd = perWd.map((v, i) => v / Math.max(1, nWd[i]));
    const weekend = (avgWd[0] + avgWd[6]) / 2, weekdays = [1, 2, 3, 4, 5].reduce((s, i) => s + avgWd[i], 0) / 5;
    const top = avgWd.indexOf(Math.max(...avgWd));
    if (weekdays > 0) {
      const ratio = weekend / weekdays;
      out.push(ratio >= 1.15
        ? `Nel <b>weekend</b> spendi in media <b>${eur.format(weekend)}</b> al giorno, ${ratio >= 1.95 ? '<b>' + ratio.toFixed(1).replace('.', ',') + ' volte</b>' : '<b>+' + ((ratio - 1) * 100).toFixed(0) + '%</b>'} rispetto ai giorni feriali (${eur.format(weekdays)}).`
        : `Spendi in modo simile durante la settimana e nel weekend (circa ${eur.format((weekend + weekdays) / 2)} al giorno).`);
    }
    out.push(`Il giorno in cui spendi di più è il <b>${WEEKDAYS[top]}</b>: in media <b>${eur.format(avgWd[top])}</b>.`);

    // Delivery: sera e weekend
    const del = rows.filter(r => r.cat === 'delivery');
    const delH = del.filter(r => r.w.hour !== null);
    if (del.length >= 5) {
      const evening = delH.filter(r => r.w.hour >= 18 || r.w.hour < 4).length;
      const wkend = del.filter(r => [0, 5, 6].includes(weekday(r.w.date))).length;
      out.push(`Delivery: ${delH.length ? `il <b>${Math.round(evening / delH.length * 100)}%</b> degli ordini è di sera (dopo le 18)` : ''}${delH.length ? ' e ' : ''}il <b>${Math.round(wkend / del.length * 100)}%</b> da venerdì a domenica.`);
    }

    // Fascia oraria
    const withH = rows.filter(r => r.w.hour !== null);
    if (withH.length >= 15) {
      const bands = [['mattina (6–12)', 6, 12], ['pomeriggio (12–18)', 12, 18], ['sera (18–24)', 18, 24], ['notte (0–6)', 0, 6]];
      const sums = bands.map(([, a, b]) => withH.filter(r => r.w.hour >= a && r.w.hour < b).reduce((s, r) => s + r.v, 0));
      const tot = sums.reduce((a, b) => a + b, 0);
      const bi = sums.indexOf(Math.max(...sums));
      out.push(`La fascia in cui spendi di più è la <b>${bands[bi][0]}</b>: il ${Math.round(sums[bi] / tot * 100)}% della spesa con carta.`);
    }

    // Dopo lo stipendio
    const pays = salaryInfo().dates;
    if (pays.length) {
      const after = new Set();
      for (const p of pays) for (let i = 0; i < 3; i++) after.add(addDays(p, i));
      const inAfter = rows.filter(r => after.has(r.w.date)).reduce((s, r) => s + r.v, 0) / after.size;
      const restDays = totalDays - after.size;
      const inRest = rows.filter(r => !after.has(r.w.date)).reduce((s, r) => s + r.v, 0) / Math.max(1, restDays);
      if (inRest > 0) {
        const ratio = inAfter / inRest;
        out.push(ratio >= 1.3
          ? `Nei <b>3 giorni dopo lo stipendio</b> spendi in media ${eur.format(inAfter)} al giorno: <b>${ratio.toFixed(1).replace('.', ',')} volte</b> il resto del mese.`
          : `Dopo lo stipendio non spendi più del solito (${eur.format(inAfter)} contro ${eur.format(inRest)} al giorno).`);
      }
    }
    return `<ul class="habits">${out.map(s => `<li>${s}</li>`).join('')}</ul>
      <p class="small muted">Calcolato sulle spese variabili (spesa, delivery, ristoranti, shopping…), esclusi affitto, rate, bollette e abbonamenti.</p>`;
  }

  // ---------- Confronto con i mesi precedenti ----------
  // Confronta un mese (quello scelto nel filtro, altrimenti l'ultimo con dati) con la media degli altri mesi,
  // categoria per categoria. I mesi senza spese in una categoria contano come zero nella media.
  function renderCompare(el, all, months, pm) {
    const title = '<h2>📊 Confronto con gli altri mesi</h2>';
    if (months.length < 2) {
      el.innerHTML = title + '<p class="muted">Servono almeno due mesi di movimenti: carica un altro estratto conto per attivare il confronto.</p>';
      return;
    }
    const target = pm && months.includes(pm) ? pm : months[0];          // months è ordinato dal più recente
    const others = months.filter(m => m !== target);
    const byCat = {};
    let inT = 0, inO = 0;
    for (const { t, cat } of all) {
      const m = t.date.slice(0, 7);
      if (t.amount > 0) { if (m === target) inT += t.amount; else inO += t.amount; continue; }
      const c = byCat[cat] || (byCat[cat] = { now: 0, other: 0 });
      if (m === target) c.now -= t.amount; else c.other -= t.amount;
    }
    const rows = Object.entries(byCat).map(([id, c]) => {
      const avg = c.other / others.length;
      return { id, info: Categories.byId[id] || Categories.byId.altro, now: c.now, avg, diff: c.now - avg, pct: avg ? (c.now - avg) / avg * 100 : null };
    }).filter(r => r.now >= 0.5 || r.avg >= 0.5);
    const outNow = rows.reduce((s, r) => s + r.now, 0), outAvg = rows.reduce((s, r) => s + r.avg, 0);
    const inAvg = inO / others.length;

    const pctText = (now, avg) => avg ? `${now >= avg ? '+' : '−'}${Math.abs((now - avg) / avg * 100).toFixed(0)}%` : 'nuova';
    // Per le uscite salire è "male" (rosso), per le entrate è "bene" (verde)
    const badge = (now, avg, goodWhenUp) => {
      const up = now > avg;
      const cls = Math.abs(now - avg) < 1 ? '' : (up === goodWhenUp ? 'pos' : 'neg');
      return `<span class="delta ${cls}">${pctText(now, avg)}</span>`;
    };
    const top = [...rows].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).filter(r => Math.abs(r.diff) >= 5).slice(0, 3);
    const isCurrent = target === todayIso().slice(0, 7);

    el.innerHTML = `${title}
      <p class="muted">${monthLabel(target)} confrontato con la media di ${others.length === 1 ? monthLabel(others[0]) : `${others.length} altri mesi`}.
        ${pm ? '' : 'Per confrontare un altro mese, sceglilo nel filtro "Periodo".'}</p>
      ${isCurrent ? '<p class="small warn-text">Il mese è ancora in corso: le cifre cresceranno fino a fine mese.</p>' : ''}
      <div class="focus-stats cmp-stats">
        <div><span class="label">Uscite</span><b>${eur.format(outNow)}</b><small>media ${eur.format(outAvg)} ${badge(outNow, outAvg, false)}</small></div>
        <div><span class="label">Entrate</span><b>${eur.format(inT)}</b><small>media ${eur.format(inAvg)} ${badge(inT, inAvg, true)}</small></div>
      </div>
      ${top.length ? `<h3 class="focus-h">Le variazioni più grandi</h3>
        <ul class="cmp-top">${top.map(r => `<li><span class="dot" style="background:${r.info.color}"></span>
          <b>${esc(r.info.name)}</b>: ${r.avg ? `${pctText(r.now, r.avg)} (${r.diff >= 0 ? '+' : '−'}${eur.format(Math.abs(r.diff))})` : `${eur.format(r.now)}, di solito zero`}
          — ${eur.format(r.now)} contro una media di ${eur.format(r.avg)}</li>`).join('')}</ul>` : ''}
      <h3 class="focus-h">Tutte le categorie</h3>
      <div class="cmp-head"><span></span><span>${esc(monthLabel(target))}</span><span>Media</span><span>Differenza</span></div>
      ${rows.sort((a, b) => b.now - a.now || b.avg - a.avg).map(r => `<div class="cmp-row">
        <span><span class="dot" style="background:${r.info.color}"></span> ${esc(r.info.name)}</span>
        <span class="num">${eur.format(r.now)}</span>
        <span class="num muted">${eur.format(r.avg)}</span>
        <span class="num">${r.diff >= 0 ? '+' : '−'}${eur.format(Math.abs(r.diff))} ${badge(r.now, r.avg, false)}</span>
      </div>`).join('')}`;
  }

  // ---------- Bollette (luce, gas, acqua) ----------
  const BILL_TYPES = { luce: '⚡ Luce', gas: '🔥 Gas', acqua: '💧 Acqua', luce_gas: '⚡🔥 Luce e gas' };
  let billFilter = 'all';

  // Tipo di bolletta: scelto dall'utente per quel fornitore, altrimenti dedotto dalla descrizione.
  // Molti fornitori (Magis, AGSM, Enel…) fanno sia luce che gas e la banca non lo indica: in quel caso "luce e gas".
  function billType(t, key) {
    if (key && state.billTypes[key]) return state.billTypes[key];
    const n = Detector.normalize(t.desc);
    if (/ (acqua|acque|acquedotto|idric\w*) /.test(n)) return 'acqua';
    const gas = / (gas|metano) /.test(n), luce = / (luce|elettric\w*) /.test(n);
    if (gas && !luce) return 'gas';
    if (luce && !gas) return 'luce';
    return 'luce_gas';
  }

  // Ogni quanto arriva una bolletta, dalla distanza media fra un addebito e il successivo dello stesso fornitore
  function billEvery(days) {
    if (!days) return '–';
    if (days < 45) return 'ogni mese';
    if (days < 75) return 'ogni 2 mesi';
    if (days < 110) return 'ogni 3 mesi';
    if (days < 150) return 'ogni 4 mesi';
    if (days < 220) return 'ogni 6 mesi';
    return 'una volta all’anno';
  }
  let billPeriod = 'quarter';                       // raggruppamento della tabella "Nei vari periodi"
  const BILL_PERIODS = { month: 'Mese', quarter: 'Trimestre', year: 'Anno' };
  const billPeriodKey = (iso, p) => p === 'year' ? iso.slice(0, 4) : p === 'month' ? iso.slice(0, 7) : `${iso.slice(0, 4)}-T${Math.floor((+iso.slice(5, 7) - 1) / 3) + 1}`;
  const billPeriodName = (k, p) => p === 'year' ? k : p === 'month' ? monthLabel(k) : `${['gen–mar', 'apr–giu', 'lug–set', 'ott–dic'][+k.slice(-1) - 1]} ${k.slice(0, 4)}`;
  function billNextPeriod(k, p) {
    if (p === 'year') return String(+k + 1);
    if (p === 'month') { const [y, m] = k.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }
    const y = +k.slice(0, 4), q = +k.slice(-1);
    return q === 4 ? `${y + 1}-T1` : `${y}-T${q + 1}`;
  }

  // rows: bollette del periodo scelto in alto; allRows: tutte le bollette dello storico (per medie e periodi)
  function renderBollette(el, rows, monthsCount, allRows) {
    const info = Categories.byId.bollette;
    if (!allRows.length) {
      el.innerHTML = '<h2>Bollette</h2><p class="muted">Nessuna bolletta trovata. Carica l’estratto conto; se un fornitore manca, spostalo in "Bollette" dalla pagina Uscite.</p>';
      return;
    }
    // Lo stesso fornitore può essere scritto in modi diversi ("S.c.a" / "S.c. A R.l."): si raggruppa per la prima parola del nome
    const provGroup = p => (Detector.normalize(p.name).trim().split(/\s+/).find(w => w.length > 2) || p.name).toLowerCase();
    const typeOf = x => { const p = party(x.t); return Object.assign({ p, g: provGroup(p), type: billType(x.t, p.key) }, x); };
    const typed = rows.map(typeOf), typedAll = allRows.map(typeOf);
    const present = Object.keys(BILL_TYPES).filter(k => typedAll.some(x => x.type === k));
    if (billFilter !== 'all' && !present.includes(billFilter)) billFilter = 'all';
    const keep = x => billFilter === 'all' || x.type === billFilter;
    const sel = typed.filter(keep), selAll = typedAll.filter(keep);
    const total = sel.reduce((s, x) => s - x.t.amount, 0);

    // Mesi coperti dall'estratto conto (per le medie al mese anche nei mesi senza bollette)
    const bank = bankTx();
    const dStart = bank.reduce((m, t) => !m || t.date < m ? t.date : m, ''), dEnd = bank.reduce((m, t) => t.date > m ? t.date : m, '');
    const coveredMonths = dStart ? Math.max(1, (Detector.daysBetween(dStart, dEnd) + 1) / 30.44) : 1;

    // Media per tipo, su tutto lo storico
    const byType = present.map(k => {
      const list = typedAll.filter(x => x.type === k), sum = list.reduce((s, x) => s - x.t.amount, 0);
      const gaps = [];
      const byProv = {};
      for (const x of list) (byProv[x.g] = byProv[x.g] || []).push(x.t.date);
      for (const ds of Object.values(byProv)) { ds.sort(); for (let i = 1; i < ds.length; i++) gaps.push(Detector.daysBetween(ds[i - 1], ds[i])); }
      const gap = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
      return { k, n: list.length, sum, avg: sum / list.length, perMonth: sum / coveredMonths, every: billEvery(gap) };
    });

    // Nei vari periodi: tabella periodi × tipi, con la media per periodo in fondo
    const cols = billFilter === 'all' ? present : [billFilter];
    const cells = {};
    for (const x of selAll) { const pk = billPeriodKey(x.t.date, billPeriod); (cells[pk] = cells[pk] || {})[x.type] = ((cells[pk] || {})[x.type] || 0) - x.t.amount; }
    const first = billPeriodKey(dStart || selAll[0].t.date, billPeriod), last = billPeriodKey(dEnd || selAll[selAll.length - 1].t.date, billPeriod);
    const periods = [];
    for (let k = first; k <= last && periods.length < 120; k = billNextPeriod(k, billPeriod)) periods.push(k);
    const colTot = Object.fromEntries(cols.map(c => [c, periods.reduce((s, k) => s + ((cells[k] || {})[c] || 0), 0)]));
    const money = v => v ? eur.format(v) : '–';
    const table = `<div class="td-tablewrap bill-table"><table>
        <caption class="sr-only">Bollette per ${BILL_PERIODS[billPeriod].toLowerCase()} e per tipo</caption>
        <thead><tr><th scope="col">${BILL_PERIODS[billPeriod]}</th>${cols.map(c => `<th scope="col">${BILL_TYPES[c]}</th>`).join('')}${cols.length > 1 ? '<th scope="col">Totale</th>' : ''}</tr></thead>
        <tbody>${[...periods].reverse().map(k => {
          const row = cells[k] || {}, tot = cols.reduce((s, c) => s + (row[c] || 0), 0);
          return `<tr><th scope="row">${esc(billPeriodName(k, billPeriod))}</th>${cols.map(c => `<td>${money(row[c])}</td>`).join('')}${cols.length > 1 ? `<td><b>${money(tot)}</b></td>` : ''}</tr>`;
        }).join('')}</tbody>
        <tfoot><tr><th scope="row">Media per ${BILL_PERIODS[billPeriod].toLowerCase()}</th>${cols.map(c => `<td>${eur.format(colTot[c] / periods.length)}</td>`).join('')}${cols.length > 1 ? `<td><b>${eur.format(cols.reduce((s, c) => s + colTot[c], 0) / periods.length)}</b></td>` : ''}</tr></tfoot>
      </table></div>`;

    // Fornitori (con il tipo da scegliere) e bollette pagate, nel periodo scelto in alto
    const providers = {};
    for (const x of typed) {
      const e = providers[x.g] || (providers[x.g] = Object.assign({ total: 0, n: 0, type: x.type, txs: [], keys: new Set() }, x.p));
      if (x.p.key) e.keys.add(x.p.key);
      if (x.p.name.length < e.name.length) e.name = x.p.name;                 // il nome più corto è di solito il più pulito
      if (keep(x)) { e.total -= x.t.amount; e.n++; e.txs.push(x.t); }
    }
    const list = Object.values(providers).filter(p => p.n).sort((a, b) => b.total - a.total);
    const typeSelect = p => p.keys.size ? `<label class="bill-type"><span class="sr-only">Tipo di bolletta di ${esc(p.name)}</span><select data-bill-key="${esc([...p.keys].join('\n'))}">${Object.entries(BILL_TYPES)
      .map(([k, v]) => `<option value="${k}"${k === p.type ? ' selected' : ''}>${v}</option>`).join('')}</select></label>` : '<span></span>';
    const paid = [...sel].sort((a, b) => b.t.date.localeCompare(a.t.date));

    el.innerHTML = `
      <h2>Bollette</h2>
      <div class="chips bill-filter" role="group" aria-label="Tipo di bolletta">
        <button class="chip${billFilter === 'all' ? ' on' : ''}" data-bill="all" aria-pressed="${billFilter === 'all'}">Tutte</button>
        ${present.map(k => `<button class="chip${billFilter === k ? ' on' : ''}" data-bill="${k}" aria-pressed="${billFilter === k}">${BILL_TYPES[k]}</button>`).join('')}
      </div>
      <div class="focus-stats">
        <div><span class="label">Totale nel periodo</span><b style="color:${info.color}">${eur.format(total)}</b></div>
        <div><span class="label">Bollette</span><b>${sel.length}</b></div>
        <div><span class="label">Bolletta media</span><b>${eur.format(sel.length ? total / sel.length : 0)}</b></div>
        <div><span class="label">Media al mese</span><b>${eur.format(total / Math.max(1, monthsCount))}</b></div>
      </div>

      <h3 class="focus-h">Media per tipo</h3>
      <p class="small muted">Su tutto lo storico caricato (${Math.round(coveredMonths)} mesi). La media al mese conta anche i mesi senza bolletta.</p>
      <div class="td-tablewrap bill-table"><table>
        <thead><tr><th scope="col">Tipo</th><th scope="col">Arriva</th><th scope="col">Bollette</th><th scope="col">Bolletta media</th><th scope="col">Al mese</th><th scope="col">All’anno</th></tr></thead>
        <tbody>${byType.map(r => `<tr><th scope="row">${BILL_TYPES[r.k]}</th><td>${r.every}</td><td>${r.n}</td><td>${eur.format(r.avg)}</td><td>${eur.format(r.perMonth)}</td><td><b>${eur.format(r.perMonth * 12)}</b></td></tr>`).join('')}</tbody>
      </table></div>

      <div class="bill-head">
        <h3 class="focus-h">Nei vari periodi</h3>
        <div class="seg" role="group" aria-label="Raggruppa per">
          ${Object.entries(BILL_PERIODS).map(([k, v]) => `<button type="button" data-bill-period="${k}" aria-pressed="${billPeriod === k}">${v}</button>`).join('')}
        </div>
      </div>
      ${table}
      <p class="small muted">Le bollette arrivano spesso ogni 2 o 3 mesi: per confrontare i periodi è più utile il trimestre o l’anno.</p>

      <h3 class="focus-h">Fornitori</h3>
      <p class="small muted">Se il tipo è sbagliato (es. Magis o AGSM possono essere luce, gas o tutti e due), sceglilo dal menu: vale per tutte le bollette di quel fornitore.</p>
      ${list.map(p => drow('focus-row bill-row', `
          <span class="d-name">${esc(p.name)}</span>
          <span class="focus-n">${p.n} bollett${p.n === 1 ? 'a' : 'e'}, media ${eur.format(p.total / p.n)}</span>
          <span class="cat-amt">${eur.format(p.total)}</span>
          ${typeSelect(p)}`, p.txs, p.search)).join('')}

      <h3 class="focus-h">Bollette pagate</h3>
      <ul class="bill-paid">${paid.map(x => `<li>
        <span class="tx-date">${fmtDate(x.t.date)}</span>
        <span class="bill-who">${esc((providers[x.g] || x.p).name)}<small>${BILL_TYPES[x.type]}</small></span>
        <b>${eur.format(-x.t.amount)}</b></li>`).join('') || '<li class="muted">Nessuna bolletta nel periodo scelto in alto.</li>'}</ul>`;
  }

  // ---------- Sezioni dedicate (Stipendio, Spesa, Delivery) ----------
  // Totale, numero di movimenti, media, dettaglio per insegna/controparte e andamento mensile.
  // rows: movimenti già filtrati; cfg.groupOf(x) → { name, search } per raggrupparli.
  function renderFocus(el, rows, monthsCount, cfg) {
    const info = Categories.byId[cfg.cat];
    if (!rows.length) {
      el.innerHTML = `<h2>${cfg.title}</h2><p class="muted">${esc(cfg.empty)}</p>`;
      return;
    }
    const total = rows.reduce((s, x) => s + Math.abs(x.t.amount), 0);

    const brands = {};
    for (const x of rows) {
      const b = cfg.groupOf(x);
      const e = brands[b.name] || (brands[b.name] = { name: b.name, search: b.search, total: 0, n: 0, txs: [] });
      e.total += Math.abs(x.t.amount); e.n++; e.txs.push(x.t);
    }
    const list = Object.values(brands).sort((a, b) => b.total - a.total);
    const bmax = list[0].total;

    const byMonth = {};
    for (const { t } of rows) {
      const k = t.date.slice(0, 7);
      const m = byMonth[k] || (byMonth[k] = { total: 0, n: 0, txs: [] });
      m.total += Math.abs(t.amount); m.n++; m.txs.push(t);
    }
    const ms = Object.keys(byMonth).sort();
    const mmax = Math.max(...ms.map(k => byMonth[k].total));

    el.innerHTML = `
      <h2>${cfg.title}</h2>
      <div class="focus-stats">
        <div><span class="label">Totale</span><b style="color:${info.color}">${eur.format(total)}</b></div>
        <div><span class="label">${cfg.units[0].toUpperCase() + cfg.units.slice(1)}</span><b>${rows.length}</b></div>
        <div><span class="label">${cfg.avgLabel}</span><b>${eur.format(total / rows.length)}</b></div>
        <div><span class="label">${monthsCount > 1 ? 'Media al mese' : 'Media a settimana'}</span>
          <b>${eur.format(monthsCount > 1 ? total / monthsCount : total / 4.33)}</b></div>
      </div>
      <h3 class="focus-h">${cfg.heading || 'Dove'}</h3>
      ${list.map(b => drow('focus-row', `
          <span class="d-name">${esc(b.name)}</span>
          <span class="cat-bar"><span style="width:${(b.total / bmax * 100).toFixed(1)}%;background:${info.color}"></span></span>
          <span class="focus-n">${b.n} ${b.n === 1 ? cfg.unit : cfg.units}</span>
          <span class="cat-amt">${eur.format(b.total)}</span>`, b.txs, b.search)).join('')}
      ${ms.length > 1 ? `<h3 class="focus-h">Mese per mese</h3>
        ${ms.map(k => drow('focus-row', `
          <span class="d-name">${monthLabel(k)}</span>
          <span class="cat-bar"><span style="width:${(byMonth[k].total / mmax * 100).toFixed(1)}%;background:${info.color}"></span></span>
          <span class="focus-n">${byMonth[k].n} ${byMonth[k].n === 1 ? cfg.unit : cfg.units}</span>
          <span class="cat-amt">${eur.format(byMonth[k].total)}</span>`, byMonth[k].txs)).join('')}` : ''}`;
  }

  // ---------- Ricerca nei movimenti ----------
  let searchRows = [];          // tutti i movimenti con la loro categoria (aggiornato da renderSpese)
  let searchLimit = 100;
  const amountText = n => Math.abs(n).toFixed(2).replace('.', ',');

  // Ogni parola cercata deve comparire nella descrizione, nel nome dell'esercente, nella categoria
  // o nell'importo ("19,99", "19.99" e "19" trovano un addebito di 19,99 €). Maiuscole e accenti non contano.
  function matchesQuery(x, terms) {
    const info = Categories.byId[x.cat] || Categories.byId.altro;
    const text = Detector.normalize(x.t.desc + ' ' + Detector.merchantKey(x.t.desc) + ' ' + info.name);
    const amt = amountText(x.t.amount);
    return terms.every(term => {
      if (/^\d+([.,]\d{1,2})?$/.test(term)) {
        const q = term.replace('.', ',');
        if (q.includes(',') ? amt === (q.split(',')[1].length === 1 ? q + '0' : q) : amt.split(',')[0] === q) return true;
      }
      return text.includes(' ' + Detector.normalize(term).trim());
    });
  }

  function renderSearch() {
    const q = $('searchInput').value.trim();
    const type = $('searchType').value;
    const box = $('searchResults');
    if (!q && type === 'all') { box.innerHTML = '<p class="muted small">Scrivi un esercente (es. "Amazon"), una parola della descrizione o un importo (es. "19,99").</p>'; return; }

    const terms = q.split(/\s+/).filter(Boolean);
    const rows = searchRows
      .filter(x => !periodMonth() || x.t.date.startsWith(periodMonth()))
      .filter(x => type === 'all' || (type === 'out' ? x.t.amount < 0 : x.t.amount > 0))
      .filter(x => matchesQuery(x, terms))
      .sort((a, b) => b.t.date.localeCompare(a.t.date));

    const out = rows.filter(x => x.t.amount < 0).reduce((s, x) => s - x.t.amount, 0);
    const inc = rows.filter(x => x.t.amount > 0).reduce((s, x) => s + x.t.amount, 0);
    const grouped = groupRoundups(rows, x => x.t, (x, t) => ({ t, cat: x.cat }));
    const shown = grouped.slice(0, searchLimit);
    box.innerHTML = `
      <p class="search-sum"><b>${rows.length}</b> moviment${rows.length === 1 ? 'o' : 'i'}
        ${out ? ` · uscite <b class="neg">${eur.format(out)}</b>` : ''}${inc ? ` · entrate <b class="pos">${eur.format(inc)}</b>` : ''}
        ${periodMonth() ? ` · ${monthLabel(periodMonth())}` : ''}</p>
      <div class="tx-list">${shown.map(({ t, cat }) => {
        const info = Categories.byId[cat] || Categories.byId.altro;
        const mk = Detector.merchantKey(t.desc);
        return `<details class="tx">
          <summary>
            <span class="tx-date">${fmtDate(t.date)}</span>
            <span class="tx-name">${esc(t.roundups ? roundupName(t) : mk ? titleCase(mk) : Detector.merchantText(t.desc).slice(0, 40))}
              <small><span class="dot" style="background:${info.color}"></span>${esc(info.name)}${t.pending ? ', in sospeso' : ''}</small></span>
            <span class="tx-amt ${t.amount < 0 ? 'neg' : 'pos'}">${t.amount < 0 ? '−' : '+'}${eur.format(Math.abs(t.amount))}</span>
          </summary>
          <p class="tx-desc">${esc(t.desc)}</p>
        </details>`;
      }).join('')}</div>
      ${grouped.length > shown.length ? `<button class="btn ghost" id="searchMore">Mostra tutti (${grouped.length})</button>` : ''}`;
  }

  // =====================================================================
  //  Piano di risparmio
  // =====================================================================
  const FIXED_CATS = ['affitto', 'finanziamenti', 'bollette', 'telefonia', 'abbonamenti', 'banca', 'tasse'];
  const sim = { cuts: {}, subs: {} };                 // scelte del simulatore (non salvate: servono solo a ragionare)

  // Entrate e uscite mese per mese, solo per i mesi coperti dall'estratto conto.
  // Investimenti e crypto contano come risparmio; TFR e una tantum sono tenuti a parte.
  function monthStats() {
    const months = [...new Set(planRows.filter(x => !x.t.manual).map(x => x.t.date.slice(0, 7)))].sort();
    const stats = Object.fromEntries(months.map(m => [m, { in: 0, oneOff: 0, out: 0, invest: 0, cats: {} }]));
    for (const x of planRows) {
      const s = stats[x.t.date.slice(0, 7)];
      if (!s || (Categories.byId[x.cat] || {}).excluded) continue;
      if (state.settings.excludeDeposits && x.cat === 'versamenti') continue;
      if (x.t.amount > 0) { if (x.cat === 'tfr') s.oneOff += x.t.amount; else s.in += x.t.amount; continue; }
      if (x.cat === 'investimenti') { s.invest -= x.t.amount; continue; }
      s.out -= x.t.amount;
      s.cats[x.cat] = (s.cats[x.cat] || 0) - x.t.amount;
    }
    return { months, stats };
  }

  // Movimenti del Salvadanaio letti dal lato del conto (nel PDF compaiono due volte: conto e Salvadanaio).
  // Uscita dal conto = messo da parte; entrata sul conto = ripreso (da te, o in automatico perché il conto era a zero).
  function piggyFlows(months) {
    const res = Object.fromEntries(months.map(m => [m, { saved: 0, taken: 0, auto: 0 }]));
    for (const { t } of planRows) {
      if ((t.desc.match(/salvadanaio/gi) || []).length < 2) continue;
      const r = res[t.date.slice(0, 7)];
      if (!r) continue;
      if (t.amount < 0) r.saved -= t.amount;
      else if (/ripristino/i.test(t.desc)) r.auto += t.amount;
      else r.taken += t.amount;
    }
    return res;
  }

  function savingsModel() {
    const { months, stats } = monthStats();
    const last = months.slice(-3);
    const avg = f => last.length ? last.reduce((s, m) => s + f(stats[m]), 0) / last.length : 0;
    const fixed = avg(s => FIXED_CATS.reduce((t, c) => t + (s.cats[c] || 0), 0));
    const variable = avg(s => s.out) - fixed;
    const income = avg(s => s.in);
    const catAvg = {};
    for (const m of last) for (const [c, v] of Object.entries(stats[m].cats)) catAvg[c] = (catAvg[c] || 0) + v / last.length;
    // Rate dei prestiti iniziati dopo l'ultimo estratto conto: non sono ancora nelle medie, si aggiungono alle spese fisse
    const today = todayIso();
    const newLoans = state.loans.filter(l => l.first.slice(0, 7) > months[months.length - 1] && loanSchedule(l).some(r => r.date >= today))
      .reduce((t, l) => t + l.rate, 0);
    return { months, stats, last, fixed: fixed + newLoans, newLoans, variable, income, capacity: income - fixed - newLoans - variable, catAvg };
  }

  const monthsUntil = ym => {             // mesi da questo mese alla scadenza (inclusa), minimo 1
    const [y, m] = todayIso().slice(0, 7).split('-').map(Number), [ty, tm] = ym.split('-').map(Number);
    return Math.max(1, (ty - y) * 12 + (tm - m) + 1);
  };
  const bar = (pct, color) => `<span class="cat-bar sav-bar"><span style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%;background:${color}"></span></span>`;

  function renderSavings(view) {
    const S = state.savings;
    if (!state.transactions.some(t => !t.manual)) {
      $('savKpis').innerHTML = '';
      ['savRate', 'savPiggy', 'savEmergency', 'savGoals', 'savSim'].forEach(id => { $(id).innerHTML = ''; });
      $('savRate').innerHTML = '<p class="muted">Carica un estratto conto per costruire il piano di risparmio.</p>';
      return;
    }
    const M = savingsModel();
    const rate = m => { const s = M.stats[m]; return s.in ? (s.in - s.out) / s.in * 100 : null; };
    const pct = r => r === null ? '—' : (Math.round(r) || 0) + '%';            // evita il "-0%"
    const lastM = M.months[M.months.length - 1];
    const avgRate = M.income ? M.capacity / M.income * 100 : 0;
    const flows = piggyFlows(M.months);
    const net = M.months.reduce((t, m) => t + flows[m].saved - flows[m].taken - flows[m].auto, 0);

    // 1. Riquadri
    $('savKpis').innerHTML = `
      <div class="kpi"><span class="label">Tasso di risparmio</span><span class="value ${rate(lastM) >= S.rateTarget ? 'pos' : 'neg'}">${pct(rate(lastM))}</span><span class="hint">${monthLabel(lastM)} · obiettivo ${S.rateTarget}%</span></div>
      <div class="kpi"><span class="label">Puoi mettere da parte</span><span class="value ${M.capacity >= 0 ? 'accent' : 'neg'}">${eur.format(M.capacity)}</span><span class="hint">al mese, in media (ultimi ${M.last.length} mesi)</span></div>
      <div class="kpi"><span class="label">Spese fisse</span><span class="value">${eur.format(M.fixed)}</span><span class="hint">${M.newLoans ? `al mese, di cui ${eur.format(M.newLoans)} di <a class="link" href="#/prestiti">nuove rate</a>` : 'affitto, abbonamenti, bollette, rate… al mese'}</span></div>
      <div class="kpi"><span class="label">Salvadanaio nel periodo</span><span class="value ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${eur.format(Math.abs(net))}</span><span class="hint">messo da parte meno ripreso</span></div>`;

    // 2. Tasso di risparmio mese per mese
    $('savRate').innerHTML = `<div class="card-head"><h2>Tasso di risparmio</h2>
        <label class="inline">Obiettivo <input type="number" id="rateTarget" min="0" max="80" step="1" value="${S.rateTarget}" class="num-in"> %</label></div>
      <p class="muted small">Quanto ti resta ogni mese rispetto alle entrate (TFR escluso, investimenti e crypto contati come risparmio).</p>
      ${M.months.map(m => {
        const r = rate(m), s = M.stats[m];
        return `<div class="sav-row"><span>${monthLabel(m)}</span>
          <span class="sav-track">${bar(r === null ? 0 : Math.abs(r) * 2, r >= S.rateTarget ? 'var(--ok)' : r >= 0 ? '#f59e0b' : 'var(--danger)')}<i style="left:${Math.min(100, S.rateTarget * 2)}%"></i></span>
          <b class="${r >= 0 ? 'pos' : 'neg'}">${pct(r)}</b>
          <small class="muted">${s.in - s.out >= 0 ? '+' : '−'}${eur.format(Math.abs(s.in - s.out))}${s.invest ? ` · ${eur.format(s.invest)} investiti` : ''}</small></div>`;
      }).join('')}
      <p class="small muted">La tacca grigia indica l'obiettivo. Una barra rossa vuol dire che quel mese hai speso più di quanto è entrato.</p>`;

    // 3. Salvadanaio: messo da parte e ripreso
    const lastF = flows[lastM];
    $('savPiggy').innerHTML = `<h2>Salvadanaio</h2>
      <p class="muted small">Quanto metti da parte nel Salvadanaio e quanto riprendi. Il risparmio funziona solo se quello che metti da parte resta lì.</p>
      ${lastF.taken + lastF.auto > 0 ? `<div class="sav-alert">⚠ A ${monthLabel(lastM)} hai ripreso <b>${eur.format(lastF.taken + lastF.auto)}</b> dal Salvadanaio
        ${lastF.auto ? `(di cui ${eur.format(lastF.auto)} in automatico perché il conto era a zero)` : ''}.</div>` : ''}
      <div class="sav-table"><div class="sav-th"><span></span><span>Messo da parte</span><span>Ripreso da te</span><span>Ripreso in automatico</span><span>Netto</span></div>
      ${M.months.map(m => { const f = flows[m], n = f.saved - f.taken - f.auto; return `<div class="sav-tr"><span>${monthLabel(m)}</span>
        <span class="pos">+${eur.format(f.saved)}</span><span class="neg">${f.taken ? '−' + eur.format(f.taken) : '—'}</span>
        <span class="neg">${f.auto ? '−' + eur.format(f.auto) : '—'}</span><b class="${n >= 0 ? 'pos' : 'neg'}">${n >= 0 ? '+' : '−'}${eur.format(Math.abs(n))}</b></div>`; }).join('')}</div>
      <p class="small muted">Consiglio: imposta l'accantonamento automatico il giorno dopo lo stipendio (${salaryInfo().day + 1 > 28 ? 1 : salaryInfo().day + 1} del mese), non a metà mese.</p>`;

    // 4. Fondo di emergenza
    const E = S.emergency;
    const eTarget = Math.round(M.fixed * E.months / 50) * 50;
    const eLeft = Math.max(0, eTarget - E.saved);
    const eMonths = M.capacity > 0 ? Math.ceil(eLeft / M.capacity) : null;
    $('savEmergency').innerHTML = `<h2>Fondo di emergenza</h2>
      <p class="muted small">Una riserva da non toccare per gli imprevisti, pari a qualche mese di spese fisse (${eur.format(M.fixed)} al mese). Va costruita prima degli altri obiettivi.</p>
      <div class="sav-goal">
        <div class="sav-goal-head"><b>Obiettivo ${eur.format(eTarget)}</b>
          <label class="inline">Mesi di spese fisse <select id="emMonths">${[3, 4, 6].map(n => `<option${n === E.months ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="inline">Già da parte € <input id="emSaved" inputmode="decimal" class="num-in" value="${String(E.saved).replace('.', ',')}"></label></div>
        ${bar(eTarget ? E.saved / eTarget * 100 : 0, 'var(--ok)')}
        <p class="small">${eLeft === 0 ? '✅ Fondo completo!' : `Mancano <b>${eur.format(eLeft)}</b>${eMonths ? ` · mettendo da parte ${eur.format(M.capacity)} al mese lo completi in <b>${eMonths} mes${eMonths === 1 ? 'e' : 'i'}</b>` : ' · al ritmo attuale non riesci a mettere da parte niente: guarda il simulatore qui sotto'}.`}</p>
      </div>`;

    // 5. Obiettivi
    const goalRows = S.goals.map(g => {
      const left = Math.max(0, g.target - g.saved), n = monthsUntil(g.deadline), quota = left / n;
      return { g, left, n, quota, late: g.deadline < todayIso().slice(0, 7) && left > 0 };
    });
    // Totale mensile: quote degli obiettivi + fondo di emergenza completato in 12 mesi
    const quotaTot = goalRows.reduce((t, r) => t + r.quota, 0) + eLeft / 12;
    $('savGoals').innerHTML = `<h2>Obiettivi</h2>
      <p class="muted small">Dai un nome e una scadenza a quello per cui risparmi: l'app calcola quanto mettere da parte ogni mese.</p>
      ${goalRows.map(({ g, left, n, quota, late }) => `<div class="sav-goal" data-goal="${esc(g.id)}">
        <div class="sav-goal-head"><b>${esc(g.name)}</b><span class="muted small">${eur.format(g.target)} entro ${monthLabel(g.deadline)}</span>
          <label class="inline">Già da parte € <input inputmode="decimal" class="num-in" data-goal-saved="${esc(g.id)}" value="${String(g.saved).replace('.', ',')}"></label>
          <button class="icon" data-goal-del="${esc(g.id)}" title="Elimina obiettivo">🗑</button></div>
        ${bar(g.target ? g.saved / g.target * 100 : 0, 'var(--accent)')}
        <p class="small">${left === 0 ? '✅ Raggiunto!' : late ? `<span class="neg">Scadenza passata: mancano ${eur.format(left)}.</span>`
          : `Metti da parte <b>${eur.format(quota)} al mese</b> per ${n} mes${n === 1 ? 'e' : 'i'}.`}</p>
      </div>`).join('') || '<p class="muted">Nessun obiettivo ancora.</p>'}
      ${goalRows.length ? `<p class="sav-sum ${quotaTot > M.capacity ? 'neg' : 'pos'}">Totale da mettere da parte (obiettivi${eLeft ? ' + fondo di emergenza in 12 mesi' : ''}): <b>${eur.format(quotaTot)} al mese</b>, contro una disponibilità di ${eur.format(M.capacity)}.
        ${quotaTot > M.capacity ? 'Non basta: allunga una scadenza o usa il simulatore per trovare i soldi che mancano.' : 'Ce la fai.'}</p>` : ''}
      <form id="goalForm" class="cash-form">
        <label class="grow">Obiettivo <input name="name" placeholder="es. Vacanza" required></label>
        <label>Cifra € <input name="target" inputmode="decimal" placeholder="800" required></label>
        <label>Entro <input name="deadline" type="month" required min="${todayIso().slice(0, 7)}"></label>
        <button class="btn" type="submit">Aggiungi obiettivo</button>
      </form>`;

    // 6. Simulatore "E se…"
    const VAR_CATS = Object.entries(M.catAvg).filter(([c, v]) => !FIXED_CATS.includes(c) && v >= 10).sort((a, b) => b[1] - a[1]).slice(0, 7);
    const activeSubs = view.subs.filter(s => s.active);
    const extraCuts = VAR_CATS.reduce((t, [c, v]) => t + v * (sim.cuts[c] || 0) / 100, 0);
    const extraSubs = activeSubs.filter(s => sim.subs[s.id]).reduce((t, s) => t + Detector.monthlyCost(s), 0);
    const extra = extraCuts + extraSubs;
    const newCap = M.capacity + extra;
    const eMonthsNew = newCap > 0 ? Math.ceil(eLeft / newCap) : null;
    $('savSim').innerHTML = `<h2>Simulatore "E se…"</h2>
      <p class="muted small">Prova a ridurre alcune spese o a disdire qualche abbonamento e guarda quanto cambia. È solo una simulazione: non modifica niente.</p>
      <div class="sim-grid">
        <div>${VAR_CATS.map(([c, v]) => { const info = Categories.byId[c] || Categories.byId.altro, p = sim.cuts[c] || 0; return `<div class="sim-row">
          <span><span class="dot" style="background:${info.color}"></span> ${esc(info.name)} <small class="muted">${eur.format(v)}/mese</small></span>
          <input type="range" min="0" max="100" step="10" value="${p}" data-sim-cut="${c}">
          <b>${p ? '−' + p + '%' : '—'}</b></div>`; }).join('')}</div>
        <div class="sim-subs"><b class="small">Disdico:</b>${activeSubs.map(s => `<label class="check"><input type="checkbox" data-sim-sub="${esc(s.id)}"${sim.subs[s.id] ? ' checked' : ''}> ${esc(s.name)} <small class="muted">${eur.format(Detector.monthlyCost(s))}/mese</small></label>`).join('')}</div>
      </div>
      <div class="sim-result">
        <div><span class="label">Risparmi in più</span><b class="pos">+${eur.format(extra)} al mese</b><small>${eur.format(extra * 12)} all'anno</small></div>
        <div><span class="label">Potresti mettere da parte</span><b>${eur.format(newCap)} al mese</b><small>invece di ${eur.format(M.capacity)}</small></div>
        <div><span class="label">Fondo di emergenza</span><b>${eLeft === 0 ? 'già completo' : eMonthsNew ? `in ${eMonthsNew} mes${eMonthsNew === 1 ? 'e' : 'i'}` : 'non raggiungibile'}</b>
          <small>${eLeft && eMonths && eMonthsNew && eMonthsNew < eMonths ? `invece di ${eMonths}` : '&nbsp;'}</small></div>
      </div>`;

    // Avviso in dashboard: prelievi dal Salvadanaio nell'ultimo mese
    if (lastF.taken + lastF.auto > 0) {
      $('alerts').insertAdjacentHTML('beforeend', `<p><b>Salvadanaio</b>: a ${monthLabel(lastM)} hai ripreso ${eur.format(lastF.taken + lastF.auto)} di quanto avevi messo da parte.
        <a class="link" href="#/risparmio">Vedi il piano di risparmio</a></p>`);
      $('alertsCard').hidden = false;
    }
  }

  // ---------- Entrate in contanti (inserite a mano) ----------
  function renderCash() {
    const cash = state.transactions.filter(t => t.manual && t.cash).sort((a, b) => b.date.localeCompare(a.date));
    const f = $('cashForm');
    if (!f.date.value) f.date.value = todayIso();
    f.date.max = todayIso();                                   // date passate sì, future no
    $('excludeDeposits').checked = !!state.settings.excludeDeposits;
    $('cashDescs').innerHTML = [...new Set(cash.map(t => t.label))].map(d => `<option value="${esc(d)}">`).join('');
    if (!cash.length) { $('cashList').innerHTML = '<h2>Registrate</h2><p class="muted">Nessuna entrata in contanti registrata.</p>'; return; }
    const byMonth = {};
    for (const t of cash) (byMonth[t.date.slice(0, 7)] = byMonth[t.date.slice(0, 7)] || []).push(t);
    const year = todayIso().slice(0, 4);
    const yearTot = cash.filter(t => t.date.startsWith(year)).reduce((s, t) => s + t.amount, 0);
    $('cashList').innerHTML = `<div class="card-head"><h2>Registrate</h2><span class="muted small">Totale ${year}: <b class="pos">${eur.format(yearTot)}</b></span></div>
      ${Object.entries(byMonth).map(([m, list]) => `
        <h3 class="focus-h">${monthLabel(m)} · <span class="pos">${eur.format(list.reduce((s, t) => s + t.amount, 0))}</span></h3>
        ${list.map(t => `<div class="cash-row">
          <span class="tx-date">${fmtDate(t.date)}</span>
          <span>${esc(t.label)}</span>
          <b class="pos">+${eur.format(t.amount)}</b>
          <button class="icon" data-del-cash="${esc(t.id)}" title="Elimina">🗑</button>
        </div>`).join('')}`).join('')}`;
  }

  // ---------- Prestiti e rate (inseriti a mano) ----------
  // Scadenze mensili dalla prima rata; l'ultima assorbe gli arrotondamenti (totale dovuto − rate precedenti).
  function loanSchedule(l) {
    const [y, m, d] = l.first.split('-').map(Number);
    return Array.from({ length: l.n }, (_, i) => {
      const lastDay = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate();
      const date = new Date(Date.UTC(y, m - 1 + i, Math.min(d, lastDay))).toISOString().slice(0, 10);
      return { date, amount: i === l.n - 1 ? Math.round((l.total - l.rate * (l.n - 1)) * 100) / 100 : l.rate };
    });
  }

  function renderLoans() {
    const today = todayIso();
    const rows = state.loans.map(l => {
      const sch = loanSchedule(l), paid = sch.filter(r => r.date < today).length;
      return { l, sch, paid, left: sch.slice(paid).reduce((s, r) => s + r.amount, 0), next: sch[paid] };
    }).sort((a, b) => (a.next ? a.next.date : '9').localeCompare(b.next ? b.next.date : '9'));
    const active = rows.filter(r => r.next);
    const leftTot = active.reduce((s, r) => s + r.left, 0);
    const interest = state.loans.reduce((s, l) => s + l.total - l.principal, 0);
    const end = rows.reduce((m, r) => r.sch[r.sch.length - 1].date > m ? r.sch[r.sch.length - 1].date : m, '');

    // Rate mese per mese, da questo mese all'ultima scadenza
    const byMonth = {};
    for (const r of active) for (const s of r.sch.slice(r.paid)) byMonth[s.date.slice(0, 7)] = (byMonth[s.date.slice(0, 7)] || 0) + s.amount;
    const months = Object.keys(byMonth).sort();
    const peak = Math.max(1, ...Object.values(byMonth));

    $('loanKpis').hidden = !state.loans.length;
    $('loanKpis').innerHTML = state.loans.length ? `
      <div class="kpi"><span class="label">Debito residuo</span><span class="value neg">${eur.format(leftTot)}</span><span class="hint">${active.length} prestit${active.length === 1 ? 'o' : 'i'} in corso</span></div>
      <div class="kpi"><span class="label">Rate al mese</span><span class="value">${eur.format(months.length ? peak : 0)}</span><span class="hint">nel mese più pesante</span></div>
      <div class="kpi"><span class="label">Interessi e costi</span><span class="value">${eur.format(interest)}</span><span class="hint">totale dovuto meno importo ricevuto</span></div>
      <div class="kpi"><span class="label">Libero dalle rate</span><span class="value accent">${end ? monthLabel(end.slice(0, 7)) : '—'}</span><span class="hint">ultima scadenza ${end ? fmtDate(end) : ''}</span></div>` : '';

    $('loanList').innerHTML = `<h2>I tuoi prestiti</h2>
      ${rows.map(({ l, sch, paid, left, next }) => `<div class="sav-goal">
        <div class="sav-goal-head"><b>${esc(l.name)}</b>
          <span class="muted small">${eur.format(l.rate)} × ${l.n} rate${l.tan !== null ? ` · TAN ${String(l.tan).replace('.', ',')}%` : ''}${l.taeg !== null ? ` · TAEG ${String(l.taeg).replace('.', ',')}%` : ''}</span>
          <button class="icon" data-loan-del="${esc(l.id)}" title="Elimina prestito">🗑</button></div>
        ${bar(paid / l.n * 100, 'var(--accent)')}
        <p class="small">Rata ${paid} di ${l.n} · ${next
          ? `prossima <b>${eur.format(next.amount)}</b> il <b>${fmtDate(next.date)}</b> · restano ${eur.format(left)}, ultima rata il ${fmtDate(sch[sch.length - 1].date)}`
          : '✅ Estinto'}</p>
        <p class="small muted">Ricevuti ${eur.format(l.principal)}, da restituire ${eur.format(l.total)}: costo del prestito ${eur.format(l.total - l.principal)}.</p>
      </div>`).join('') || '<p class="muted">Nessun prestito inserito.</p>'}`;

    $('loanMonths').hidden = !months.length;
    $('loanMonths').innerHTML = `<h2>Rate mese per mese</h2>
      ${months.map(m => `<div class="sav-row"><span>${monthLabel(m)}</span>
        <span class="sav-track">${bar(byMonth[m] / peak * 100, '#6366f1')}</span>
        <b>${eur.format(byMonth[m])}</b><small></small></div>`).join('')}
      <p class="small muted">Le rate sono già nella previsione "Quanto posso spendere oggi?", nel calendario e nelle spese fisse del piano di risparmio.</p>`;
  }

  // ---------- Limiti di spesa ----------
  const LIMIT_CATS = Categories.ALL.filter(c => !c.excluded && !['altro', 'bonifici', 'prelievi', 'banca', 'tasse', 'affitto', 'finanziamenti', 'investimenti'].includes(c.id));
  const PERIOD_LABEL = { week: 'a settimana', month: 'al mese' };

  // Periodo (settimana da lunedì a domenica, o mese) che contiene la data
  function periodRange(period, iso) {
    if (period === 'week') { const start = addDays(iso, -((weekday(iso) + 6) % 7)); return { start, end: addDays(start, 6) }; }
    const [y, m] = iso.split('-').map(Number);
    const start = iso.slice(0, 7) + '-01';
    return { start, end: addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1) };
  }
  const periodName = (period, r) => period === 'week' ? `${fmtShort(r.start)} – ${fmtShort(r.end)}` : monthLabel(r.start.slice(0, 7));

  // Abbina ogni spesa segnata a mano al movimento dell'estratto conto corrispondente, così non conta due volte:
  // stessa categoria, data reale dell'acquisto da 1 giorno prima a 4 giorni dopo, importo vicino (mance, supplementi).
  function matchQuick() {
    const used = new Set(), res = new Map();
    const bank = planRows.filter(x => !x.t.manual && x.t.amount < 0);
    for (const q of [...state.quick].sort((a, b) => a.date.localeCompare(b.date))) {
      let best = null, bestScore = Infinity;
      for (const x of bank) {
        if (used.has(x.t) || x.cat !== q.cat) continue;
        const days = Detector.daysBetween(q.date, realWhen(x.t).date), diff = Math.abs(-x.t.amount - q.amount);
        if (days < -1 || days > 4 || diff > Math.max(1, q.amount * 0.15)) continue;
        const score = diff + Math.abs(days) * 0.01;
        if (score < bestScore) { best = x; bestScore = score; }
      }
      if (best) { used.add(best.t); res.set(q.id, best.t); }
    }
    return res;
  }

  // Spese di una categoria con la data reale: movimenti della banca + spese segnate non ancora arrivate
  function catSpending(cat, matched) {
    return [
      ...planRows.filter(x => !x.t.manual && x.t.amount < 0 && x.cat === cat).map(x => ({ date: realWhen(x.t).date, amount: -x.t.amount })),
      ...state.quick.filter(q => q.cat === cat && !matched.has(q.id)).map(q => ({ date: q.date, amount: q.amount })),
    ];
  }
  const sumIn = (rows, r) => rows.filter(x => x.date >= r.start && x.date <= r.end).reduce((s, x) => s + x.amount, 0);

  // Media per settimana o per mese sui periodi coperti dall'estratto conto
  function catAverage(cat, period) {
    const dates = planRows.filter(x => !x.t.manual).map(x => x.t.date).sort();
    if (!dates.length) return null;
    const days = Detector.daysBetween(dates[0], dates[dates.length - 1]) + 1;
    const tot = planRows.filter(x => !x.t.manual && x.t.amount < 0 && x.cat === cat).reduce((s, x) => s - x.t.amount, 0);
    return tot / days * (period === 'week' ? 7 : 30.4);
  }

  function renderLimits() {
    const today = todayIso(), matched = matchQuick();
    const dataEnd = planRows.reduce((m, x) => !x.t.manual && !x.t.pending && x.t.date > m ? x.t.date : m, '');
    const dataStart = planRows.reduce((m, x) => !x.t.manual && !x.t.pending && (!m || x.t.date < m) ? x.t.date : m, '');
    const catName = id => (Categories.byId[id] || {}).name || id;
    const catColor = id => (Categories.byId[id] || {}).color || '#9ca3af';

    // Menu delle categorie: prima quelle con un limite
    const limited = state.limits.map(l => l.cat);
    const opts = [...LIMIT_CATS].sort((a, b) => (limited.includes(b.id) - limited.includes(a.id)));
    const qc = $('quickCat'), keep = qc.value;
    qc.innerHTML = opts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    qc.value = keep || limited[0] || 'delivery';
    const lc = $('limitCat'), keepL = lc.value;
    lc.innerHTML = LIMIT_CATS.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    lc.value = keepL || 'ristoranti';
    const qf = $('quickForm');
    if (!qf.date.value) qf.date.value = today;
    qf.date.max = today;
    limitHint();

    // Riquadri dei limiti
    let over = 0;
    const alerts = [];
    $('limitCards').innerHTML = state.limits.map(l => {
      const rows = catSpending(l.cat, matched);
      const cur = periodRange(l.period, today);
      const spent = sumIn(rows, cur), left = l.amount - spent, pct = spent / l.amount;
      const totalDays = Detector.daysBetween(cur.start, cur.end) + 1, daysLeft = Detector.daysBetween(today, cur.end) + 1;
      const elapsed = (totalDays - daysLeft + 1) / totalDays;
      const cls = pct > 1 ? 'over' : pct >= .8 ? 'warn' : 'ok';
      if (pct > 1) { over++; alerts.push(`<p><b>${esc(catName(l.cat))}</b>: hai superato il limite ${PERIOD_LABEL[l.period]} di ${eur.format(-left)}. <a class="link" href="#/limiti">Vedi i limiti</a></p>`); }
      else if (pct >= .8) alerts.push(`<p><b>${esc(catName(l.cat))}</b>: hai usato il ${Math.round(pct * 100)}% del limite ${PERIOD_LABEL[l.period]} (restano ${eur.format(left)}). <a class="link" href="#/limiti">Vedi i limiti</a></p>`);
      const R = 54, C = 2 * Math.PI * R;
      // Periodi precedenti (solo quelli coperti dall'estratto conto)
      const hist = [];
      for (let i = 1, d = addDays(cur.start, -1); i <= 8; i++) {
        const r = periodRange(l.period, d);
        if (!dataStart || r.end < dataStart) break;
        hist.unshift({ r, spent: sumIn(rows, r), partial: r.end > dataEnd });
        d = addDays(r.start, -1);
      }
      const kept = hist.filter(h => !h.partial && h.spent <= l.amount).length, full = hist.filter(h => !h.partial).length;
      const pace = l.period === 'month' && pct > elapsed + .15 && pct <= 1 ? `<p class="limit-pace warn-text">Stai andando più veloce del previsto: hai usato il ${Math.round(pct * 100)}% del limite e il periodo è al ${Math.round(elapsed * 100)}%.</p>` : '';
      return `<section class="card limit-card ${cls}" style="--lc:${catColor(l.cat)}">
        <div class="limit-head">
          <span class="dot" style="background:${catColor(l.cat)}"></span><b>${esc(catName(l.cat))}</b>
          <label class="inline">Limite € <input class="num-in" inputmode="decimal" data-limit-amount="${esc(l.id)}" value="${String(l.amount).replace('.', ',')}"></label>
          <span class="muted small">${PERIOD_LABEL[l.period]}</span>
          <button class="icon" data-limit-del="${esc(l.id)}" title="Elimina limite">🗑</button>
        </div>
        <div class="limit-body">
          <svg class="limit-ring" viewBox="0 0 128 128" aria-hidden="true">
            <circle class="ring-bg" cx="64" cy="64" r="${R}"/>
            <circle class="ring-fg" cx="64" cy="64" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - Math.min(1, pct))).toFixed(1)}"/>
          </svg>
          <div class="limit-center"><b>${eur.format(spent)}</b><small>di ${eur.format(l.amount)}</small></div>
          <div class="limit-info">
            <span class="limit-left">${left >= 0 ? `Restano <b>${eur.format(left)}</b>` : `Superato di <b>${eur.format(-left)}</b>`}</span>
            <span class="muted small">${l.period === 'week' ? 'Settimana' : 'Mese'} ${periodName(l.period, cur)} · ${daysLeft === 1 ? 'ultimo giorno' : `mancano ${daysLeft} giorni`}</span>
            ${left > 0 && daysLeft > 1 ? `<span class="muted small">Circa ${eur.format(left / daysLeft)} al giorno fino a fine ${l.period === 'week' ? 'settimana' : 'mese'}</span>` : ''}
          </div>
        </div>
        ${pace}
        ${hist.length ? `<div class="limit-hist">${hist.map(h => {
          const p = Math.min(1, h.spent / (l.amount * 1.5));
          return `<div class="lh ${h.partial ? 'partial' : h.spent > l.amount ? 'over' : 'ok'}" title="${esc(periodName(l.period, h.r))}: ${eur.format(h.spent)}${h.partial ? ' (estratto conto incompleto)' : ''}">
            <span class="lh-bar"><i style="height:${Math.max(4, p * 100).toFixed(0)}%"></i><em style="bottom:${(100 / 1.5).toFixed(1)}%"></em></span>
            <small>${l.period === 'week' ? fmtShort(h.r.start).replace(/\s.*/, '') + '/' + (+h.r.start.slice(5, 7)) : monthLabel(h.r.start.slice(0, 7)).slice(0, 3)}</small></div>`;
        }).join('')}</div>
        <p class="small muted">${full ? `Con questo limite saresti rimasto nei limiti <b>${kept} ${l.period === 'week' ? 'settimane' : 'mesi'} su ${full}</b>.` : ''} La linea indica il limite.</p>` : ''}
      </section>`;
    }).join('') || '<section class="card"><p class="muted">Nessun limite: aggiungine uno qui sotto.</p></section>';

    $('navLimits').textContent = over || '';
    if (alerts.length) { $('alerts').insertAdjacentHTML('beforeend', alerts.join('')); $('alertsCard').hidden = false; }

    // Spese segnate a mano
    const list = [...state.quick].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    $('quickList').innerHTML = `<div class="card-head"><h2>Spese segnate</h2>${dataEnd ? `<span class="muted small">Estratto conto caricato fino al ${fmtDate(dataEnd)}</span>` : ''}</div>
      ${list.length ? list.slice(0, 40).map(q => {
        const t = matched.get(q.id);
        return `<div class="quick-row${t ? ' done' : ''}">
          <span class="tx-date">${fmtDate(q.date)}</span>
          <span><span class="dot" style="background:${catColor(q.cat)}"></span> ${esc(catName(q.cat))}${q.note ? ` <small class="muted">· ${esc(q.note)}</small>` : ''}</span>
          <span class="badge ${t ? '' : 'warn'}">${t ? `✓ ${t.pending ? 'in banca, in sospeso' : 'nell\'estratto conto'}${Math.abs(-t.amount - q.amount) >= .01 ? ` (${eur.format(-t.amount)})` : ''}` : 'in attesa dell\'estratto conto'}</span>
          <b>${eur.format(q.amount)}</b>
          <button class="icon" data-quick-del="${esc(q.id)}" title="Elimina">🗑</button>
        </div>`;
      }).join('') : '<p class="muted">Nessuna spesa segnata. Quando ordini, segnala qui sopra.</p>'}
      <p class="small muted">Le spese "in attesa" contano nei limiti finché non arriva l'estratto conto; poi conta il movimento della banca al loro posto. Non compaiono nelle altre pagine, quindi non raddoppiano nulla.</p>`;
  }

  function limitHint() {
    const f = $('limitForm'), avg = catAverage(f.cat.value, f.period.value);
    $('limitHint').textContent = avg === null ? '' : `In media spendi ${eur.format(avg)} ${PERIOD_LABEL[f.period.value]} in questa categoria.`;
  }

  let view;
  function render() {
    view = computeView();
    renderCoverage(view);
    renderSubs(view);
    renderLoans();
    renderSpese(view);
    renderLimits();
    renderCash();
    renderHidden();
    if (location.hash === '#/investimenti') { renderInvest(); refreshInvest(); }
  }

  // ---------- Promemoria calendario (.ics) ----------
  const RRULE = { settimanale: 'FREQ=WEEKLY', mensile: 'FREQ=MONTHLY', bimestrale: 'FREQ=MONTHLY;INTERVAL=2', trimestrale: 'FREQ=MONTHLY;INTERVAL=3', semestrale: 'FREQ=MONTHLY;INTERVAL=6', annuale: 'FREQ=YEARLY' };
  const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const fold = line => { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); };

  function icsEvent(s) {
    const d = s.next.replace(/-/g, '');
    // Evento di giornata intera: DTEND è il giorno successivo
    const endDay = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + 1)).toISOString().slice(0, 10).replace(/-/g, '');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const days = state.settings.remindDays;
    const uid = s.id.replace(/[^a-z0-9]/gi, '-') + '@gestionale-abbonamenti';
    return [
      'BEGIN:VEVENT',
      'UID:' + uid,
      'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + d,
      'DTEND;VALUE=DATE:' + endDay,
      'RRULE:' + (RRULE[s.frequency] || RRULE.mensile),
      'SUMMARY:' + icsText(`Rinnovo ${s.name} – ${eur.format(s.amount)}`),
      'DESCRIPTION:' + icsText(`Addebito previsto di ${eur.format(s.amount)} (${FREQ_LABEL[s.frequency] || ''}).\nPer disdire: ${s.cancelUrl}`),
      'URL:' + s.cancelUrl,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:-P${days}D`,
      'DESCRIPTION:' + icsText(`Tra ${days} giorn${days === 1 ? 'o' : 'i'} rinnova ${s.name} (${eur.format(s.amount)})`),
      'END:VALARM',
      'END:VEVENT',
    ].map(fold).join('\r\n');
  }

  function downloadIcs(subs, filename) {
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gestionale finanze//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      ...subs.map(icsEvent), 'END:VCALENDAR'].join('\r\n');
    downloadFile(new Blob([body], { type: 'text/calendar;charset=utf-8' }), filename);
  }

  function downloadFile(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Lettura file ----------
  function showStatus(msg, isError) {
    const el = $('status');
    el.hidden = false;
    el.className = 'status' + (isError ? ' error' : '');
    el.innerHTML = msg;
  }

  function readAs(file, kind, encoding) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      kind === 'text' ? r.readAsText(file, encoding) : r.readAsArrayBuffer(file);
    });
  }

  // Le librerie per Excel e PDF sono nella cartella lib/ e vengono caricate solo quando servono.
  const loaded = {};
  function loadScript(src) {
    return loaded[src] || (loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('impossibile caricare ' + src)); };
      document.head.appendChild(s);
    }));
  }

  async function loadPdfJs() {
    await loadScript('lib/pdf.min.js');
    if (location.protocol === 'file:') {
      // Aperto con doppio clic: il browser non permette i worker da file locali,
      // quindi carichiamo il worker nella pagina e pdf.js lo usa direttamente.
      await loadScript('lib/pdf.worker.min.js');
    } else {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    }
  }

  // Un'esportazione che dichiara N movimenti ma ne contiene molti meno \u00E8 incompleta: meglio non importarla a met\u00E0.
  function checkComplete(tx) {
    const found = tx.length + (tx.pending || 0);
    if (tx.declared && found < tx.declared * 0.9) {
      throw Object.assign(new Error('esportazione incompleta'), { html:
        `il file dichiara <b>${tx.declared} movimenti</b> ma ne contiene solo <b>${found}</b>: l'esportazione \u00E8 incompleta, quindi non l'ho importato.
        Di solito l'app della banca esporta solo i movimenti gi\u00E0 caricati sullo schermo. Prova a esportare dal <b>sito</b> della banca (da computer),
        oppure scarica gli <b>estratti conto trimestrali in PDF</b>.` });
    }
    return tx;
  }

  async function parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv' || ext === 'txt') {
      let text = await readAs(file, 'text', 'utf-8');
      if (text.includes('\uFFFD')) text = await readAs(file, 'text', 'windows-1252');
      return checkComplete(Parser.rowsToTransactions(Parser.parseCSV(text)));
    }
    if (ext === 'xls' || ext === 'xlsx') {
      await loadScript('lib/xlsx.full.min.js');
      const wb = XLSX.read(await readAs(file, 'buffer'), { type: 'array' });
      let best = [];
      for (const name of wb.SheetNames) {
        Parser.fixSheetRange(wb.Sheets[name], XLSX.utils);
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
        const tx = Parser.rowsToTransactions(rows);
        if (tx.length + tx.pending > best.length + (best.pending || 0)) best = tx;
      }
      return checkComplete(best);
    }
    if (ext === 'pdf') {
      await loadPdfJs();
      const pdf = await pdfjsLib.getDocument({ data: await readAs(file, 'buffer') }).promise;
      const lines = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const content = await (await pdf.getPage(p)).getTextContent();
        const rows = [];
        for (const it of content.items) {
          if (!it.str || !it.str.trim()) continue;
          const x = it.transform[4], y = it.transform[5];
          let row = rows.find(r => Math.abs(r.y - y) < 3);
          if (!row) rows.push(row = { y, items: [] });
          row.items.push({ str: it.str, x });
        }
        rows.sort((a, b) => b.y - a.y).forEach(r => { r.items.sort((a, b) => a.x - b.x); lines.push(r); });
      }
      // La "Lista movimenti" dell'app Intesa non è un estratto conto: contiene solo gli ultimi movimenti
      // (anche non contabilizzati) e senza il nome degli esercenti. Importarla creerebbe doppioni poco leggibili.
      const head = lines.slice(0, 40).map(r => r.items.map(i => i.str).join(' ')).join(' ');
      if (/lista movimenti/i.test(head) && /movimenti selezionati/i.test(head)) {
        const n = (head.match(/movimenti selezionati sono:?\s*(\d+)/i) || [])[1];
        throw Object.assign(new Error('lista movimenti'), { html:
          `questo file è la <b>"Lista movimenti"</b> dell'app${n ? ` (solo ${n} movimenti)` : ''}, non un estratto conto: non ha il nome degli esercenti
          e include movimenti non ancora contabilizzati, quindi non l'ho importato. Scarica invece gli <b>estratti conto</b> in PDF
          (in Intesa: <i>Archivio → Rendiconti ed estratti conto</i>), uno per ogni trimestre.` });
      }
      const tx = Parser.pdfLinesToTransactions(lines);
      if (!tx.length) {
        // Per la diagnostica: il testo estratto, con la posizione orizzontale di ogni pezzo
        tx.pdfText = lines.map(r => r.items.map(i => `[${Math.round(i.x)}] ${i.str}`).join('  ')).join('\n');
      }
      return tx;
    }
    throw new Error('formato non supportato (usa CSV, Excel o PDF)');
  }

  // Due movimenti con stessa data e importo sono lo stesso movimento se la descrizione coincide, se una è
  // l'inizio dell'altra (descrizione troncata da un cambio pagina) o se hanno lo stesso esercente/controparte
  // (lo stesso movimento scritto in formati diversi, es. estratto PDF ed esportazione Excel).
  function sameMovement(a, b) {
    const na = Detector.normalize(a.desc).trim(), nb = Detector.normalize(b.desc).trim();
    if (na === nb) return true;
    if (Math.min(na.length, nb.length) >= 12 && (na.startsWith(nb) || nb.startsWith(na))) return true;
    const pa = party(a).key, pb = party(b).key;
    return !!pa && pa === pb;
  }

  // Aggiunge i movimenti evitando doppioni se si ricarica lo stesso periodo (anche da un file diverso).
  // Ogni movimento già salvato può fare da "gemello" una volta sola: tre addebiti uguali nello stesso giorno restano tre.
  let fixedAmounts = 0;
  function mergeTransactions(newTx) {
    const slots = {};
    for (const t of state.transactions) (slots[t.date + '|' + t.amount] = slots[t.date + '|' + t.amount] || []).push({ t, used: false });
    // Le versioni precedenti leggevano male gli importi sopra i 1.000 € di alcuni PDF (1.536 → 536):
    // se arriva lo stesso movimento con l'importo corretto, si corregge quello salvato invece di aggiungerne un altro.
    const sameDesc = {};
    for (const t of state.transactions) (sameDesc[t.date + '|' + t.desc] = sameDesc[t.date + '|' + t.desc] || []).push(t);
    let added = 0;
    fixedAmounts = 0;
    for (const t of newTx) {
      const group = slots[t.date + '|' + t.amount] || [];
      const twin = group.find(s => !s.used && s.t.desc === t.desc) || group.find(s => !s.used && sameMovement(s.t, t));
      if (twin) {
        twin.used = true;
        if (t.desc.length > twin.t.desc.length) twin.t.desc = t.desc;       // tiene la descrizione più completa
        continue;
      }
      // Stesso giorno e importo in un altro estratto che copre quel giorno: è lo stesso movimento scritto diversamente
      const other = group.find(s => !s.used && !s.t.manual && s.t.src && s.t.src !== t.src && fileCovers(state, s.t.src, t.date));
      if (other) {
        other.used = true;
        other.t.desc = betterDesc(other.t, t);
        continue;
      }
      const old = (sameDesc[t.date + '|' + t.desc] || []).find(o => Math.sign(o.amount) === Math.sign(t.amount)
        && Math.abs(t.amount) >= 1000 && Math.abs(o.amount) < Math.abs(t.amount)
        && Math.abs(((Math.abs(t.amount) - Math.abs(o.amount)) / 1000) % 1) < 0.00001);
      if (old) { old.amount = t.amount; fixedAmounts++; continue; }
      state.transactions.push(t); added++;
    }
    state.transactions.sort((a, b) => a.date.localeCompare(b.date));
    return added;
  }

  async function handleFiles(files) {
    if (!files.length) return;
    showStatus('Analisi in corso…');
    const before = computeView().subs.length;
    const msgs = [];
    let ok = false;
    for (const f of files) {
      try {
        const tx = await parseFile(f);
        if (!tx.length) {
          if (tx.pdfText === '') {
            msgs.push(`<b>${esc(f.name)}</b>: il PDF non contiene testo (probabilmente è una scansione/immagine). Scarica dall'home banking l'estratto conto in PDF "digitale", oppure in CSV o Excel.`);
          } else {
            msgs.push(`<b>${esc(f.name)}</b>: nessun movimento riconosciuto. Prova a esportare l'estratto conto in formato CSV o Excel dall'home banking.` +
              (tx.pdfText ? `<details><summary>Mostra il testo letto dal PDF (per la diagnosi)</summary><pre class="pdf-text">${esc(tx.pdfText)}</pre></details>` : ''));
          }
          continue;
        }
        // Descrizioni accorciate: bastano per riconoscere l'esercente e lo storico resta leggero
        // Ogni movimento ricorda da quale file arriva, così il file si può rimuovere in seguito
        const fileId = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        for (const t of tx) { t.desc = t.desc.slice(0, DESC_MAX); t.src = fileId; }
        const added = mergeTransactions(tx);
        // Spese in sospeso: valgono quelle dell'esportazione più recente (le vecchie nel frattempo sono state contabilizzate)
        if (tx.hasStatus) {
          const asOf = [...tx, ...tx.pendingTx].reduce((m, t) => t.date > m ? t.date : m, '');
          if (!state.pendingAsOf || asOf >= state.pendingAsOf) {
            state.pendingTx = tx.pendingTx.map((t, i) => Object.assign(t, { desc: t.desc.slice(0, DESC_MAX), id: fileId + 'p' + i }));
            state.pendingAsOf = asOf;
          }
        }
        const dates = tx.map(t => t.date).sort();
        state.files.push({ id: fileId, name: f.name, from: dates[0], to: dates[dates.length - 1], count: tx.length, added, addedAt: todayIso() });
        msgs.push(`<b>${esc(f.name)}</b>: ${tx.length} movimenti dal ${fmtDate(dates[0])} al ${fmtDate(dates[dates.length - 1])}` +
          (added < tx.length ? ` (${tx.length - added - fixedAmounts} già presenti, ignorati)` : '') +
          (fixedAmounts ? `. <b>Corretti ${fixedAmounts} importi</b> letti male in precedenza (es. stipendi sopra i 1.000 €).` : '') +
          (tx.pending ? `. ${tx.pending} ${tx.pending === 1 ? 'spesa è ancora in sospeso' : 'spese sono ancora in sospeso'} in banca: ${tx.pending === 1 ? 'la conto' : 'le conto'} già in tutte le pagine, con la scritta "in sospeso", finché non ${tx.pending === 1 ? 'arriva definitiva' : 'arrivano definitive'}.` : ''));
        ok = true;
      } catch (e) {
        msgs.push(`<b>${esc(f.name)}</b>: ${e.html || 'errore — ' + esc(e.message)}`);
      }
    }
    save();
    render();
    if (ok) {
      const after = view.subs.length;
      msgs.push(`Abbonamenti in lista: <b>${after}</b>${after > before ? ` (${after - before} nuovi)` : ''}.`);
    }
    showStatus(msgs.join('<br>'), !ok);
  }

  // ---------- Eventi ----------
  const drop = $('drop');
  $('pick').onclick = () => $('file').click();
  $('file').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFiles([...e.dataTransfer.files]); });

  // ---------- Navigazione tra le pagine (menu laterale) ----------
  // Ogni pagina è una <section class="page" data-page="…">; l'indirizzo è #/nome-pagina.
  function showPage() {
    const pages = [...document.querySelectorAll('.page')];
    const wanted = location.hash.replace(/^#\/?/, '');
    const page = pages.find(p => p.dataset.page === wanted) || pages[0];
    pages.forEach(p => { p.hidden = p !== page; });
    document.querySelectorAll('.sidebar a[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === page.dataset.page));
    $('pageTitle').textContent = page.dataset.title;
    $('crumbs').textContent = page.dataset.group ? page.dataset.group + ' ›' : '';
    $('periodBox').hidden = !page.hasAttribute('data-period');
    document.title = page.dataset.title + ' · Gestionale finanze';
    document.body.classList.remove('nav-open');
    $('menuBtn').setAttribute('aria-expanded', 'false');
    $('tabMenu').setAttribute('aria-expanded', 'false');
    document.querySelectorAll('.tabbar [data-tab]').forEach(a => {
      if (a.dataset.tab === page.dataset.page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    countUp(page);
  }

  // I numeri grandi dei riquadri "salgono" fino al valore quando si apre la pagina.
  // Si ferma da solo se nel frattempo la pagina viene ridisegnata con un valore nuovo.
  function countUp(page) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const el of page.querySelectorAll('.kpi .value')) {
      const final = el.textContent.trim();
      const m = final.match(/^([−-]?)([\d.]+(?:,\d+)?)\s*(€|%)?$/);
      if (!m) continue;
      const target = Number(m[2].replace(/\./g, '').replace(',', '.'));
      if (!target) continue;
      const decimals = m[2].includes(',') ? 2 : 0;
      const fmt = v => m[1] + (m[3] === '€' ? eur.format(v) : v.toLocaleString('it-IT', { maximumFractionDigits: decimals }) + (m[3] || ''));
      const t0 = performance.now(), dur = 900;
      let shown = fmt(0);
      el.textContent = shown;
      const step = now => {
        if (el.textContent !== shown) return;                       // ridisegnato nel frattempo
        const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        shown = k < 1 ? fmt(target * e) : final;
        el.textContent = shown;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }
  window.addEventListener('hashchange', showPage);
  showPage();

  // Menu a scomparsa su schermi piccoli
  const setNav = open => {
    document.body.classList.toggle('nav-open', open);
    $('menuBtn').setAttribute('aria-expanded', String(open));
    $('tabMenu').setAttribute('aria-expanded', String(open));
  };
  // Barra in basso (telefono): "Menu" apre il cassetto, "+" porta al modulo per aggiungere una spesa
  $('tabMenu').onclick = () => setNav(!document.body.classList.contains('nav-open'));
  $('tabAdd').onclick = () => {
    setNav(false);
    if (location.hash !== '#/dashboard') location.hash = '#/dashboard';
    setTimeout(() => {
      const f = $('tdAddForm');
      f.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      $('tdAmount').focus({ preventScroll: true });
    }, 60);
  };
  $('menuBtn').onclick = () => setNav(!document.body.classList.contains('nav-open'));
  $('navShade').onclick = () => setNav(false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { setNav(false); ($('tabMenu').offsetParent ? $('tabMenu') : $('menuBtn')).focus(); } });

  // Menu sul computer: barra di sole icone (il nome compare passandoci sopra) oppure con i nomi.
  // La scelta resta salvata su questo dispositivo. Sul telefono il menu resta il cassetto con i nomi.
  const navWide = on => {
    document.body.classList.toggle('nav-wide', on);
    $('navToggle').setAttribute('aria-pressed', String(on));
    $('navToggle').querySelector('.nav-label').textContent = on ? 'Nascondi i nomi' : 'Mostra i nomi';
    try { localStorage.setItem('finanze-menu', on ? 'nomi' : 'icone'); } catch (e) { /* vale fino alla chiusura */ }
  };
  try { navWide(localStorage.getItem('finanze-menu') === 'nomi'); } catch (e) { navWide(false); }
  $('navToggle').onclick = () => { navWide(!document.body.classList.contains('nav-wide')); hideNavTip(); };
  const railMode = () => !document.body.classList.contains('nav-wide') && matchMedia('(min-width: 901px)').matches;
  function showNavTip(el) {
    const label = el.querySelector('.nav-label');
    if (!railMode() || !label) return;
    const tip = $('navTip'), r = el.getBoundingClientRect();
    tip.textContent = label.textContent;
    tip.hidden = false;
    tip.style.left = (r.right + 12) + 'px';
    tip.style.top = (r.top + r.height / 2 - tip.offsetHeight / 2) + 'px';
  }
  function hideNavTip() { $('navTip').hidden = true; }
  const side = $('sidebar');
  side.addEventListener('mouseover', e => { const el = e.target.closest('a, .nav-toggle'); if (el) showNavTip(el); });
  side.addEventListener('mouseleave', hideNavTip);
  side.addEventListener('focusin', e => { const el = e.target.closest('a, .nav-toggle'); if (el && el.matches(':focus-visible')) showNavTip(el); });
  side.addEventListener('focusout', hideNavTip);
  side.addEventListener('scroll', hideNavTip, { passive: true });
  window.addEventListener('resize', hideNavTip);
  window.addEventListener('hashchange', hideNavTip);

  wireToday();

  // Calendario: cambio mese e giorno selezionato
  $('calendar').addEventListener('click', e => {
    const nav = e.target.closest('[data-cal]');
    if (nav) {
      const [y, m] = calMonth.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + Number(nav.dataset.cal), 1));
      calMonth = d.toISOString().slice(0, 7);
      calDay = null;
      return renderCalendar(view);
    }
    const cell = e.target.closest('[data-day]');
    if (cell) { calDay = cell.dataset.day === calDay ? null : cell.dataset.day; renderCalendar(view); }
  });

  const findSub = id => view.subs.find(s => s.id === id) || view.suggestions.find(s => s.id === id);
  const setOverride = (id, patch) => { state.overrides[id] = Object.assign(state.overrides[id] || {}, patch); };
  const isManual = id => state.manual.some(m => m.id === id);
  const fileSafe = s => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

  // Data del prossimo addebito scelta dall'utente (lista abbonamenti e pagina "Prossimi addebiti")
  function onNextChange(e) {
    const inp = e.target.closest('input[data-next-id]');
    if (!inp) return;
    setOverride(inp.dataset.nextId, { nextDate: inp.value || null });
    save();
    render();
  }
  function onResetNext(e) {
    const b = e.target.closest('[data-reset-next]');
    if (!b) return false;
    setOverride(b.dataset.resetNext, { nextDate: null });
    save();
    render();
    return true;
  }
  function onEndChange(e) {
    const inp = e.target.closest('input[data-end-id]');
    if (!inp) return;
    setOverride(inp.dataset.endId, { endDate: inp.value || null });
    save();
    render();
  }
  function onClearEnd(e) {
    const b = e.target.closest('[data-clear-end]');
    if (!b) return;
    setOverride(b.dataset.clearEnd, { endDate: null });
    save();
    render();
  }
  $('list').addEventListener('change', onEndChange);
  $('list').addEventListener('click', onClearEnd);
  for (const id of ['list', 'upcoming']) {
    $(id).addEventListener('change', onNextChange);
    $(id).addEventListener('click', onResetNext);
  }

  function onListClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.item').dataset.id;
    const act = btn.dataset.act;
    if (act === 'accept') state.accepted.push(id);
    else if (act === 'ignore') state.ignored.push(id);
    else if (act === 'done') setOverride(id, { cancelled: true, cancelledAt: todayIso() });
    else if (act === 'reactivate') setOverride(id, { cancelled: false, cancelledAt: null });
    else if (act === 'stillActive') setOverride(id, { forceActive: true });
    else if (act === 'restore') state.ignored = state.ignored.filter(x => x !== id);
    else if (act === 'ics') { const s = findSub(id); return downloadIcs([s], 'promemoria-' + fileSafe(s.name) + '.ics'); }
    else if (act === 'delete') {
      if (!confirm('Eliminare questo elemento dalla lista? Usa "Elimina" per ciò che NON è un abbonamento; se invece l\'hai disdetto, usa ✓.')) return;
      if (isManual(id)) state.manual = state.manual.filter(m => m.id !== id);
      else state.ignored.push(id);
      delete state.overrides[id];
    } else if (act === 'edit') return openEdit(findSub(id));
    save();
    render();
  }
  $('list').onclick = onListClick;
  $('sugg').onclick = onListClick;
  $('deleted').onclick = onListClick;
  $('alerts').onclick = e => {
    const btn = e.target.closest('[data-ok-id]');
    if (!btn) return;
    const id = btn.dataset.okId;
    const prev = (state.overrides[id] && state.overrides[id].okAlerts) || [];
    setOverride(id, { okAlerts: [...prev, btn.dataset.okKey] });
    save();
    render();
  };

  $('icsAll').onclick = () => {
    const subs = view.subs.filter(s => s.active && s.next);
    if (subs.length) downloadIcs(subs, 'promemoria-abbonamenti.ics');
  };
  $('remindDays').onchange = e => { state.settings.remindDays = Number(e.target.value); save(); };

  function openEdit(s) {
    const f = $('editForm');
    f.name.value = s.name;
    f.amount.value = String(s.amount).replace('.', ',');
    f.frequency.value = s.frequency;
    f.nextDate.value = s.next || s.nextDate || '';
    f.endDate.value = s.endDate || '';
    f.url.value = s.cancelUrl || '';
    $('editDlg').returnValue = '';
    $('editDlg').onclose = () => {
      if ($('editDlg').returnValue !== 'ok') return;
      const amount = Parser.parseAmount(f.amount.value);
      const patch = {
        name: f.name.value.trim() || s.name,
        amount: amount !== null ? Math.abs(amount) : s.amount,
        frequency: f.frequency.value,
        cancelUrl: f.url.value.trim() || Services.cancelUrl(null, f.name.value.trim() || s.name),
      };
      // La data viene salvata solo se l'utente l'ha cambiata rispetto a quella calcolata
      if (f.nextDate.value && f.nextDate.value !== s.next) patch.nextDate = f.nextDate.value;
      patch.endDate = f.endDate.value || null;
      setOverride(s.id, patch);
      save();
      render();
    };
    $('editDlg').showModal();
  }

  $('addBtn').onclick = () => { $('addForm').hidden = !$('addForm').hidden; };
  $('addForm').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    const amount = Parser.parseAmount(f.amount.value);
    if (amount === null) return alert('Importo non valido');
    const name = f.name.value.trim();
    const svc = Detector.matchService(Detector.normalize(name));
    state.manual.push({
      id: 'manual:' + Date.now(),
      name,
      category: svc ? svc.cat : 'Altro',
      amount: Math.abs(amount),
      frequency: f.frequency.value,
      nextDate: f.nextDate.value || null,
      cancelUrl: f.url.value.trim() || Services.cancelUrl(svc, name),
    });
    f.reset();
    f.hidden = true;
    save();
    render();
  };

  // Panoramica spese
  $('monthFilter').onchange = e => { selectedMonth = e.target.value; renderSpese(view); };
  $('searchInput').addEventListener('input', () => { searchLimit = 100; renderSearch(); });
  $('searchType').onchange = () => { searchLimit = 100; renderSearch(); };
  $('searchResults').addEventListener('click', e => {
    if (e.target.id === 'searchMore') { searchLimit = Infinity; renderSearch(); }
  });
  // Clic sul nome di un esercente (categorie, Spesa, Delivery): lo cerca nei movimenti
  function searchFromClick(e) {
    const m = e.target.closest('[data-search]');
    if (!m || !m.dataset.search) return false;
    $('searchInput').value = m.dataset.search;
    searchLimit = 100;
    renderSearch();
    location.hash = '#/cerca';
    return true;
  }
  for (const id of ['focusStipendio', 'bonificiCard', 'focusSpesa', 'focusDelivery']) $(id).addEventListener('click', searchFromClick);

  // Bollette: filtro per tipo e scelta del tipo per ogni fornitore
  $('focusBollette').addEventListener('click', e => {
    if (searchFromClick(e)) return;
    const chip = e.target.closest('[data-bill]');
    if (chip) { billFilter = chip.dataset.bill; renderSpese(view); return; }
    const per = e.target.closest('[data-bill-period]');
    if (per) {
      billPeriod = per.dataset.billPeriod; renderSpese(view);
      const again = $('focusBollette').querySelector(`[data-bill-period="${billPeriod}"]`); if (again) again.focus();
    }
  });
  $('focusBollette').addEventListener('change', e => {
    const sel = e.target.closest('select[data-bill-key]');
    if (!sel) return;
    for (const k of sel.dataset.billKey.split('\n')) state.billTypes[k] = sel.value;
    save();
    renderSpese(view);
  });

  // Liste a categorie (uscite ed entrate): apri/chiudi, cerca esercente, sposta di categoria
  function wireCatList(el, openSet) {
    el.addEventListener('click', e => {
      if (searchFromClick(e)) return;
      const row = e.target.closest('[data-act="toggleCat"]');
      if (!row) return;
      const cat = row.closest('.cat');
      const id = cat.dataset.cat;
      openSet.has(id) ? openSet.delete(id) : openSet.add(id);
      cat.classList.toggle('open');
    });
    el.addEventListener('change', e => {
      const sel = e.target.closest('select[data-mk]');
      if (!sel) return;
      state.catOverrides[sel.dataset.mk] = sel.value;
      openSet.add(sel.value);
      save();
      renderSpese(view);
    });
  }
  wireCatList($('cats'), openCats);
  wireCatList($('incCats'), openIncCats);

  // Backup
  $('exportBtn').onclick = () => {
    if (!confirm('Il file di backup NON è protetto da password: contiene tutti i tuoi movimenti in chiaro.\nConservalo in un posto sicuro. Continuare?')) return;
    downloadFile(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
      'backup-finanze-' + todayIso() + '.json');
  };
  // Piano di risparmio: tutte le modifiche passano da qui (le sezioni vengono ridisegnate a ogni cambio)
  const savPage = document.querySelector('.page[data-page="risparmio"]');
  const rerenderSavings = () => { save(); renderSavings(view); };
  savPage.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'rateTarget') state.savings.rateTarget = Math.max(0, Math.min(80, Number(el.value) || 0));
    else if (el.id === 'emMonths') state.savings.emergency.months = Number(el.value);
    else if (el.id === 'emSaved') state.savings.emergency.saved = Math.abs(Parser.parseAmount(el.value) || 0);
    else if (el.dataset.goalSaved) {
      const g = state.savings.goals.find(x => x.id === el.dataset.goalSaved);
      if (g) g.saved = Math.abs(Parser.parseAmount(el.value) || 0);
    } else if (el.dataset.simSub) { sim.subs[el.dataset.simSub] = el.checked; return renderSavings(view); }
    else return;
    rerenderSavings();
  });
  savPage.addEventListener('input', e => {
    // Cursori del simulatore: aggiornamento immediato, senza salvare
    if (e.target.dataset.simCut) {
      sim.cuts[e.target.dataset.simCut] = Number(e.target.value);
      const keep = e.target.dataset.simCut;
      renderSavings(view);
      const again = savPage.querySelector(`[data-sim-cut="${keep}"]`);
      if (again) again.focus();
    }
  });
  savPage.addEventListener('click', e => {
    const del = e.target.closest('[data-goal-del]');
    if (del && confirm('Eliminare questo obiettivo?')) {
      state.savings.goals = state.savings.goals.filter(g => g.id !== del.dataset.goalDel);
      rerenderSavings();
    }
  });
  savPage.addEventListener('submit', e => {
    if (e.target.id !== 'goalForm') return;
    e.preventDefault();
    const f = e.target, target = Parser.parseAmount(f.target.value);
    if (!target) return alert('Cifra non valida');
    state.savings.goals.push({ id: 'g' + Date.now().toString(36), name: f.name.value.trim(), target: Math.abs(target), deadline: f.deadline.value, saved: 0 });
    rerenderSavings();
  });

  // Prestiti: aggiunta ed eliminazione (le rate cambiano previsione, calendario e piano di risparmio: si ridisegna tutto)
  $('loanForm').onsubmit = e => {
    e.preventDefault();
    const f = e.target, num = v => v.trim() ? Math.abs(Parser.parseAmount(v)) : null;
    const pctIn = v => { const p = parseFloat(v.replace('%', '').replace(',', '.')); return isFinite(p) ? p : null; };   // "8,355" o "8.355"
    const principal = num(f.principal.value), rate = num(f.rate.value), n = Math.round(Number(f.n.value));
    if (!principal || !rate || !(n >= 1) || !f.first.value) return alert('Controlla importo, rata, numero di rate e data della prima rata.');
    state.loans.push({ id: 'l' + Date.now().toString(36), name: f.name.value.trim(), principal, rate, n, first: f.first.value,
      total: num(f.total.value) || Math.round(rate * n * 100) / 100, tan: pctIn(f.tan.value), taeg: pctIn(f.taeg.value) });
    f.reset();
    save();
    try { render(); } catch (err) { alert("Prestito salvato, ma c'è stato un errore nel ridisegnare la pagina:\n" + err.message); }
  };
  $('loanList').addEventListener('click', e => {
    const del = e.target.closest('[data-loan-del]');
    if (!del || !confirm('Eliminare questo prestito?')) return;
    state.loans = state.loans.filter(l => l.id !== del.dataset.loanDel);
    save();
    render();
  });

  // Limiti di spesa e spese segnate a mano
  $('quickForm').onsubmit = e => {
    e.preventDefault();
    const f = e.target, amount = Math.abs(Parser.parseAmount(f.amount.value) || 0);
    if (!amount) return alert('Importo non valido');
    if (f.date.value > todayIso()) return alert('La data non può essere nel futuro');
    state.quick.push({ id: 'q' + Date.now().toString(36), cat: f.cat.value, amount, date: f.date.value, note: f.note.value.trim() });
    f.amount.value = f.note.value = '';
    f.date.value = todayIso();
    save();
    render();
    showStatus(`Segnata: ${eur.format(amount)} in ${(Categories.byId[f.cat.value] || {}).name || ''}.`);
  };
  $('limitForm').onsubmit = e => {
    e.preventDefault();
    const f = e.target, amount = Math.abs(Parser.parseAmount(f.amount.value) || 0);
    if (!amount) return alert('Limite non valido');
    const same = state.limits.find(l => l.cat === f.cat.value && l.period === f.period.value);
    if (same) same.amount = amount;
    else state.limits.push({ id: 'lim' + Date.now().toString(36), cat: f.cat.value, period: f.period.value, amount });
    f.amount.value = '';
    save();
    render();
  };
  $('limitForm').addEventListener('change', e => { if (e.target.name !== 'amount') limitHint(); });
  const limPage = document.querySelector('.page[data-page="limiti"]');
  limPage.addEventListener('change', e => {
    const id = e.target.dataset.limitAmount;
    if (!id) return;
    const l = state.limits.find(x => x.id === id), v = Math.abs(Parser.parseAmount(e.target.value) || 0);
    if (l && v) { l.amount = v; save(); }
    render();
  });
  limPage.addEventListener('click', e => {
    const dl = e.target.closest('[data-limit-del]'), dq = e.target.closest('[data-quick-del]');
    if (dl && confirm('Eliminare questo limite?')) state.limits = state.limits.filter(l => l.id !== dl.dataset.limitDel);
    else if (dq && confirm('Eliminare questa spesa segnata?')) state.quick = state.quick.filter(q => q.id !== dq.dataset.quickDel);
    else return;
    save();
    render();
  });

  // Entrate in contanti: aggiunta, eliminazione, opzione sui versamenti
  $('cashForm').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    const amount = Parser.parseAmount(f.amount.value);
    if (amount === null || amount === 0) return alert('Importo non valido');
    if (f.date.value > todayIso()) return alert('La data non può essere nel futuro.');
    const label = f.desc.value.trim();
    state.transactions.push({
      id: 'cash' + Date.now().toString(36), date: f.date.value, amount: Math.abs(amount),
      desc: 'Contanti: ' + label, label, manual: true, cash: true, cat: 'extra', src: 'manual',
    });
    state.transactions.sort((a, b) => a.date.localeCompare(b.date));
    save();
    f.amount.value = '';                                       // data e descrizione restano, per inserirne altre di fila
    render();
    showStatus(`Aggiunti <b>${eur.format(Math.abs(amount))}</b> in contanti il ${fmtDate(f.date.value)}.`);
  };
  $('cashList').addEventListener('click', e => {
    const b = e.target.closest('[data-del-cash]');
    if (!b || !confirm('Eliminare questa entrata in contanti?')) return;
    state.transactions = state.transactions.filter(t => t.id !== b.dataset.delCash);
    save();
    render();
  });
  $('excludeDeposits').onchange = e => { state.settings.excludeDeposits = e.target.checked; save(); render(); };

  // Rimozione di un file caricato (e dei suoi movimenti)
  $('coverage').addEventListener('click', e => {
    const b = e.target.closest('[data-remove-file]');
    if (!b) return;
    const idx = Number(b.dataset.removeFile);
    const f = state.files[idx];
    const txs = new Set(fileTransactions(idx));
    if (!confirm(`Rimuovere "${f.name}" e i suoi ${txs.size} movimenti (${fmtDate(f.from)} – ${fmtDate(f.to)})?`)) return;
    state.transactions = state.transactions.filter(t => !txs.has(t));
    state.files.splice(idx, 1);
    save();
    render();
    showStatus(`Rimosso <b>${esc(f.name)}</b>: tolti ${txs.size} movimenti.`);
  });

  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      state = Object.assign(empty(), JSON.parse(await readAs(file, 'text', 'utf-8')));
      state.settings = Object.assign(empty().settings, state.settings);
      save();
      render();
      showStatus('Backup importato.');
    } catch (err) { showStatus('Backup non valido: ' + esc(err.message), true); }
  };
  // Sezioni nascoste: "Soldi liberati" si può far ricomparire da qui
  function renderHidden() {
    const hidden = !!(state.freed && state.freed.hidden);
    $('showFreedBtn').hidden = !hidden;
    $('hiddenText').textContent = hidden ? 'Hai nascosto "Soldi liberati" dalla Home.' : 'Nessuna sezione nascosta.';
  }
  $('showFreedBtn').onclick = () => {
    state.freed.hidden = false; save(); render(); renderHidden();
    toast('"Soldi liberati" è di nuovo in Home.');
  };
  window.addEventListener('hashchange', () => { if (location.hash === '#/impostazioni') renderHidden(); });

  $('resetBtn').onclick = () => {
    if (!confirm('Cancellare tutti i movimenti e gli abbonamenti salvati?')) return;
    state = empty();
    save();
    render();
    $('status').hidden = true;
  };

  // App installabile e utilizzabile offline (solo quando servita via http/https, non da file locale)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* l'app funziona comunque online */ });
  }

  // ---------- Accesso con password ----------
  const AUTO_LOCK_MS = 10 * 60 * 1000;      // blocco automatico dopo 10 minuti di inattività
  const MIN_PW = 6;

  // Bloccare = ricaricare la pagina: i dati in chiaro spariscono dalla memoria e si torna alla schermata di accesso.
  const lockNow = () => location.reload();

  // ---------- Lampada della schermata di accesso ----------
  // La cordicella si tira trascinandola verso il basso (oltre 28 px), con un tocco o con Invio/Spazio.
  // Accesa: luce calda e modulo della password. Spenta: resta solo la lampada.
  function setLamp(on) {
    const scene = $('lampScene'), form = $('lockForm'), cord = $('lampCord');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    scene.classList.toggle('on', on);
    cord.setAttribute('aria-pressed', String(on));
    cord.setAttribute('aria-label', on ? 'Spegni la lampada' : 'Accendi la lampada per accedere');
    $('lampHint').textContent = on ? 'Tira di nuovo per spegnere' : 'Tira la cordicella per accedere';
    clearTimeout(setLamp.t);
    if (on) {
      form.hidden = false;
      form.classList.remove('leaving');
      setLamp.t = setTimeout(() => $('lockPw').focus(), still ? 0 : 350);
    } else {
      form.classList.add('leaving');
      setLamp.t = setTimeout(() => { form.hidden = true; form.classList.remove('leaving'); }, still ? 0 : 260);
    }
  }
  function wireLamp() {
    const cord = $('lampCord');
    let startY = null, dy = 0, suppress = false;
    // Il filo resta attaccato al paralume e si allunga; scende solo la pallina (variabile --pull)
    const release = () => {
      cord.style.removeProperty('--pull');
      cord.classList.remove('pulling');
      cord.classList.add('swing');
      setTimeout(() => cord.classList.remove('swing'), 700);
    };
    cord.addEventListener('pointerdown', e => {
      startY = e.clientY; dy = 0; cord.setPointerCapture(e.pointerId); cord.classList.add('pulling');
    });
    cord.addEventListener('pointermove', e => {
      if (startY === null) return;
      dy = Math.max(0, Math.min(72, e.clientY - startY));
      cord.style.setProperty('--pull', dy + 'px');
    });
    const end = () => {
      if (startY === null) return;
      startY = null;
      if (dy > 28) { suppress = true; setLamp(!$('lampScene').classList.contains('on')); }
      else if (dy >= 6) suppress = true;                       // trascinata poco: non cambia niente
      release();
    };
    cord.addEventListener('pointerup', end);
    cord.addEventListener('pointercancel', end);
    cord.addEventListener('click', () => {                    // tocco o tastiera
      if (suppress) { suppress = false; return; }
      setLamp(!$('lampScene').classList.contains('on'));
      release();
    });
  }

  function lockError(msg) {
    $('lockErr').textContent = msg;
    $('lockErr').hidden = !msg;
  }

  function initLock() {
    if (!Vault.supported) {
      $('lockHint').textContent = 'Questo browser non permette di cifrare i dati. Apri l\'app con Chrome, Edge, Firefox o Safari aggiornati.';
      $('lockForm').querySelectorAll('input, button').forEach(el => { el.hidden = true; });
      wireLamp();
      return;
    }
    const setup = !Vault.exists();
    const legacy = localStorage.getItem(STORE_KEY);          // dati salvati in chiaro dalle versioni precedenti
    $('lockTitle').textContent = setup ? 'Crea la tua password.' : 'Eccoti di nuovo.';
    $('lockHint').innerHTML = setup
      ? `Scegli una password (almeno ${MIN_PW} caratteri) per proteggere i tuoi dati: verranno cifrati e serviranno a ogni accesso.
         <b>Se la dimentichi non potrai recuperarli</b>: non è salvata da nessuna parte.`
      : 'La luce è accesa: scrivi la password per entrare.';
    $('lockPw2').hidden = $('lockPw2Label').hidden = !setup;
    $('lockPw').autocomplete = setup ? 'new-password' : 'current-password';
    $('lockBtn').textContent = setup ? 'Crea password ed entra' : 'Entra';
    $('forgotBtn').hidden = setup;
    wireLamp();

    $('lockForm').onsubmit = async e => {
      e.preventDefault();
      const pw = $('lockPw').value;
      lockError('');
      if (setup) {
        if (pw.length < MIN_PW) return lockError(`La password deve avere almeno ${MIN_PW} caratteri.`);
        if (pw !== $('lockPw2').value) return lockError('Le due password non coincidono.');
      }
      $('lockBtn').disabled = true;
      $('lockBtn').textContent = setup ? 'Cifratura dei dati…' : 'Verifica…';
      try {
        if (setup) {
          let data = empty();
          try { if (legacy) data = JSON.parse(legacy); } catch { /* dati vecchi illeggibili: si parte vuoti */ }
          await Vault.create(pw, data);
          localStorage.removeItem(STORE_KEY);               // da ora in poi niente più copie in chiaro
          state = parseState(data);
        } else {
          state = parseState(await Vault.open(pw));
        }
        unlock();
      } catch (err) {
        $('lockBtn').disabled = false;
        $('lockBtn').textContent = setup ? 'Crea password ed entra' : 'Entra';
        $('lockPw').value = '';
        $('lockPw').focus();
        lockError(err.message === 'Password errata' ? 'Password errata, riprova.' : 'Errore: ' + err.message);
      }
    };

    $('forgotBtn').onclick = () => {
      if (!confirm('Senza password i dati non si possono recuperare.\nVuoi CANCELLARE tutti i dati e ricominciare da zero con una nuova password?')) return;
      if (!confirm('Confermi? Movimenti, abbonamenti e impostazioni verranno eliminati definitivamente.')) return;
      Vault.destroy();
      localStorage.removeItem(STORE_KEY);
      location.reload();
    };
  }

  function unlock() {
    $('lockPw').value = $('lockPw2').value = '';
    $('lock').hidden = true;
    document.body.classList.remove('locked');
    if (removedDuplicates || repairedThousands || crossDuplicates || seededLoans) save();
    render();
    showPage();                                                     // riparte l'animazione d'ingresso con i dati veri
    if (crossDuplicates) {
      showStatus(`Ho tolto ${crossDuplicates} moviment${crossDuplicates === 1 ? 'o doppio' : 'i doppi'}: erano lo stesso movimento caricato da due estratti diversi
        (per esempio il PDF e l'Excel dello stesso mese), scritto dalla banca con parole diverse. Non serve ricaricare niente.`);
    } else if (repairedThousands) {
      showStatus(`Ho corretto ${repairedThousands} importi sopra i 1.000 € letti male in precedenza (es. gli stipendi). Non serve ricaricare l'estratto conto.`);
    } else if (removedDuplicates) {
      showStatus(`Ho trovato e rimosso ${removedDuplicates} moviment${removedDuplicates === 1 ? 'o duplicato' : 'i duplicati'}
        (lo stesso estratto caricato due volte con versioni diverse dell'app).`);
    }
    startAutoLock();
  }

  function startAutoLock() {
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    ['click', 'keydown', 'touchstart', 'scroll', 'mousemove'].forEach(ev => window.addEventListener(ev, touch, { passive: true }));
    const check = () => { if (Date.now() - last > AUTO_LOCK_MS) lockNow(); };
    setInterval(check, 30 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }

  $('lockNowBtn').onclick = lockNow;

  // Cambio password: serve quella attuale, così nessuno può cambiarla approfittando dell'app lasciata aperta.
  $('pwBtn').onclick = () => {
    const f = $('pwForm');
    f.reset();
    $('pwErr').hidden = true;
    $('pwDlg').showModal();
  };
  $('pwCancel').onclick = () => $('pwDlg').close();
  $('pwForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const err = msg => { $('pwErr').textContent = msg; $('pwErr').hidden = false; };
    if (f.newPw.value.length < MIN_PW) return err(`La nuova password deve avere almeno ${MIN_PW} caratteri.`);
    if (f.newPw.value !== f.newPw2.value) return err('Le due nuove password non coincidono.');
    try { await Vault.open(f.oldPw.value); } catch { return err('La password attuale è sbagliata.'); }
    await Vault.create(f.newPw.value, state);
    $('pwDlg').close();
    showStatus('Password cambiata.');
  };

  initLock();
})();
