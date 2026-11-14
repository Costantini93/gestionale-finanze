// Analizza i movimenti e individua gli abbonamenti (spese ricorrenti).
(function (root) {
  const S = (typeof module !== 'undefined' && module.exports) ? require('./services.js') : root.Services;

  function normalize(s) {
    return ' ' + String(s || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  }

  // amount (facoltativo): importo del movimento, per le voci valide solo per un certo prezzo.
  function matchService(norm, amount) {
    for (const svc of S.SERVICES) {
      if (svc.amount !== undefined && (amount === undefined || Math.abs(Math.abs(amount) - svc.amount) > 0.005)) continue;
      if (svc.ranges && amount !== undefined && !svc.ranges.some(([min, max]) => Math.abs(amount) >= min && Math.abs(amount) <= max)) continue;
      if (svc.keys.some(k => norm.includes(' ' + k + ' '))) return svc;
    }
    return null;
  }

  function isIgnored(norm) {
    return S.IGNORE_KEYS.some(k => k.endsWith('*')
      ? norm.includes(' ' + k.slice(0, -1))
      : norm.includes(' ' + k + ' '));
  }

  // Parole "di servizio" che le banche aggiungono alla descrizione e che non identificano l'esercente.
  const NOISE = new Set(('pagamento pagam pag pos carta carte n nr num addebito addebiti sdd diretto core b2b mandato presso acquisto ' +
    'operazione op del dell della ore it ita italia eur euro contactless apple google pay debit credit visa mastercard maestro ' +
    'circuito online internet web ecommerce e commerce rif cro trn id cod disp bonifico sepa favore a di da per il la lo le ' +
    'in con su srl spa s r l p ltd inc llc bv gmbh sa com www http https data valuta utilizzo tramite su vs v num numero ' +
    'debito prepagata contanti periodico permanente ordine ricorrente ricorr fattura ft cliente clienti codice cc conto ' +
    'adue nome effettuato alle mediante presso xxxx pagina abi voi vostro disposto istantaneo').split(' '));

  // Dove la banca indica esplicitamente l'esercente ("PRESSO Netflix.com", "NOME: FASTWEB S.p.A. MANDATO: ...")
  // usa solo quella parte della descrizione.
  function merchantText(desc) {
    let m = String(desc).match(/\bpresso\s+(.+)/i);
    if (m) return m[1];
    m = String(desc).match(/\bnome:\s*(.+?)(\bmandato\b|$)/i);
    if (m) return m[1];
    return desc;
  }

  // Controparte di un bonifico: a chi l'hai mandato o chi te l'ha mandato.
  // Es. "Bonifico da Voi disposto a favore di: ANDREA PRODOMI 0126..." → "ANDREA PRODOMI"
  //     "Bonifico a Vostro favore ... MITT.: A.M.A. MEDICAL MUSHROOMS SOCIETA' COD. DISP." → "A.M.A. MEDICAL MUSHROOMS SOCIETA'"
  function counterpartOf(desc) {
    const s = String(desc);
    const m = s.match(/\bmitt(?:ente)?\.?:\s*(.+)/i) || s.match(/\bordinante:?\s*(.+)/i)
      || s.match(/\ba favore di:?\s*(.+)/i) || s.match(/\bbeneficiario:?\s*(.+)/i)
      || s.match(/\bbonifico (?:sepa )?(?:da|a)\s+(?!voi\b|vostro\b)(.+)/i);
    if (!m) return null;
    const words = [];
    for (const w of m[1].split(/\s+/)) {
      // Ci si ferma a codici, sigle bancarie e parole tipiche della causale ("Affitto", "Busta paga"…)
      if (/\d/.test(w) || /^(cod|benef|bic|iban|causale|rif|notprovided|cro|trn|affitto|busta|cedolino|pag|stipendio|rimborso|regalo|saldo|acconto|fattura|quota|rata)\b/i.test(w)) break;
      words.push(w);
      if (words.length === 5) break;
    }
    return words.length ? words.join(' ') : null;
  }

  function merchantKey(desc) {
    const toks = normalize(merchantText(desc)).trim().split(' ')
      .filter(t => t && !/\d/.test(t) && !NOISE.has(t) && t.length > 1);
    return toks.slice(0, 3).join(' ');
  }

  const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase());

  const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
  const median = arr => { const s = [...arr].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Divide un gruppo in sotto-gruppi con importi simili (es. Apple 0,99 e Apple 9,99 sono due abbonamenti diversi).
  // Le bollette (luce, gas, telefono) variano di più da un mese all'altro: tolleranza più ampia.
  function clusterByAmount(txs, tolerance) {
    const sorted = [...txs].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
    const clusters = [];
    for (const t of sorted) {
      const v = Math.abs(t.amount);
      const c = clusters[clusters.length - 1];
      if (c && v <= c.base * tolerance + 0.01) c.items.push(t);
      else clusters.push({ base: v, items: [t] });
    }
    return clusters.map(c => c.items.sort((a, b) => a.date.localeCompare(b.date)));
  }

  // Intervalli (in giorni) tra due addebiti consecutivi per ogni frequenza.
  const FREQ_RANGES = [
    ['settimanale', 5, 9], ['mensile', 24, 37], ['bimestrale', 55, 70],
    ['trimestrale', 80, 100], ['semestrale', 170, 200], ['annuale', 330, 400],
  ];
  const medianGap = items => {
    const gaps = [];
    for (let i = 1; i < items.length; i++) gaps.push(daysBetween(items[i - 1].date, items[i].date));
    return median(gaps);
  };

  function frequencyOf(items) {
    if (items.length < 2) return 'mensile';
    const g = medianGap(items);
    const hit = FREQ_RANGES.find(([, min, max]) => g >= min && g <= max);
    return hit ? hit[0] : 'mensile';
  }

  function isRegular(items) {
    if (items.length < 2) return false;
    const months = new Set(items.map(t => t.date.slice(0, 7)));
    const perMonth = items.length / months.size;
    const g = medianGap(items);
    const freq = FREQ_RANGES.find(([, min, max]) => g >= min && g <= max);
    if (!freq) return false;
    if (freq[0] === 'settimanale') return items.length >= 4;
    return perMonth <= 1.5;
  }

  function analyze(transactions) {
    const expenses = transactions.filter(t => t.amount < 0);
    const groups = new Map();
    for (const t of expenses) {
      const norm = normalize(t.desc);
      const svc = matchService(norm, t.amount);
      let key, name;
      if (svc) { key = 'svc:' + svc.name; name = svc.name; }
      else {
        if (isIgnored(norm)) continue;
        // Pagamenti fatti di persona alla cassa ("Pagamento Tramite POS", "Pagamento su POS"): spesa ripetuta
        // nello stesso bar o tabaccheria, non un abbonamento (quelli passano da addebito diretto o pagamento online)
        if (/pagamento (tramite|su) pos\b/i.test(t.desc)) continue;
        const mk = merchantKey(t.desc);
        if (!mk) continue;
        key = 'mk:' + mk; name = titleCase(mk);
      }
      if (!groups.has(key)) groups.set(key, { key, name, svc, items: [] });
      groups.get(key).items.push(t);
    }

    const subscriptions = [], suggestions = [];
    for (const g of groups.values()) {
      // Bollette: importi molto variabili (conguagli), si tengono tutte insieme e si usa la mediana come importo tipico
      const isBill = g.svc && g.svc.cat === 'Utenze';
      const tolerance = isBill ? Infinity : g.svc && g.svc.cat === 'Telefonia' ? 1.35 : 1.1;
      for (const items of clusterByAmount(g.items, tolerance)) {
        const lastItem = items[items.length - 1];
        const amount = isBill ? Math.round(median(items.map(t => Math.abs(t.amount))) * 100) / 100 : Math.abs(lastItem.amount);
        const sub = {
          id: g.key + '|' + Math.round(median(items.map(t => Math.abs(t.amount)))),
          groupKey: g.key,
          name: g.name,
          category: g.svc ? g.svc.cat : 'Altro',
          amount,
          // Con addebiti irregolari (es. acquisti singoli ravvicinati) non si deduce la frequenza: si assume mensile
          frequency: (g.svc && g.svc.frequency) || (isRegular(items) ? frequencyOf(items) : 'mensile'),
          cancelUrl: S.cancelUrl(g.svc, g.name),
          knownService: !!g.svc,
          lastDate: lastItem.date,
          sampleDesc: merchantText(lastItem.desc).slice(0, 120),
          charges: items.map(t => ({ date: t.date, amount: Math.abs(t.amount) })),
        };
        // Riferimento ai movimenti originali (non salvato): serve alla panoramica spese
        Object.defineProperty(sub, 'txs', { value: items, enumerable: false });
        const regular = isRegular(items);
        if (g.svc) {
          if (regular || items.length >= 2) subscriptions.push(sub);
          else suggestions.push(Object.assign(sub, { reason: 'Servizio in abbonamento, addebitato una sola volta (potrebbe essere annuale)' }));
        } else if (regular) {
          if (items.length >= 3) subscriptions.push(sub);
          else suggestions.push(Object.assign(sub, { reason: `Stesso importo addebitato 2 volte, con cadenza ${sub.frequency}` }));
        }
      }
    }

    const dates = transactions.map(t => t.date).sort();
    return {
      subscriptions: subscriptions.sort((a, b) => b.amount - a.amount),
      suggestions: suggestions.sort((a, b) => b.amount - a.amount),
      period: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      count: transactions.length,
    };
  }

  const MONTHLY_FACTOR = { settimanale: 52 / 12, mensile: 1, bimestrale: 1 / 2, trimestrale: 1 / 3, semestrale: 1 / 6, annuale: 1 / 12 };
  const monthlyCost = sub => sub.amount * (MONTHLY_FACTOR[sub.frequency] || 1);
  const STEP_MONTHS = { mensile: 1, bimestrale: 2, trimestrale: 3, semestrale: 6, annuale: 12 };

  // Aggiunge un periodo alla data ISO; per i mesi mantiene il giorno (31 gen + 1 mese = 28/29 feb).
  function addPeriod(iso, frequency) {
    const [y, m, d] = iso.split('-').map(Number);
    if (frequency === 'settimanale') {
      const t = new Date(Date.UTC(y, m - 1, d + 7));
      return t.toISOString().slice(0, 10);
    }
    const step = STEP_MONTHS[frequency] || 1;
    const total = (m - 1) + step;
    const ny = y + Math.floor(total / 12), nm = total % 12;
    const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return ny + '-' + String(nm + 1).padStart(2, '0') + '-' + String(Math.min(d, lastDay)).padStart(2, '0');
  }

  // Prossima data di addebito prevista, a partire dall'ultimo addebito (o da quella impostata a mano).
  function nextChargeDate(sub, todayIso) {
    let d = sub.nextDate || sub.lastDate;
    if (!d) return null;
    for (let i = 0; d < todayIso && i < 600; i++) d = addPeriod(d, sub.frequency);
    return d;
  }

  // Vero se nell'estratto conto più recente l'abbonamento non risulta più addebitato
  // (nessun addebito da più di 1,5 periodi prima della fine dei dati caricati).
  function isStale(sub, dataEndIso) {
    if (!sub.lastDate || !dataEndIso) return false;
    const expected = addPeriod(sub.lastDate, sub.frequency);
    const grace = Math.max(10, daysBetween(sub.lastDate, expected) * 0.5);
    return daysBetween(expected, dataEndIso) > grace;
  }

  const api = { analyze, normalize, matchService, merchantKey, merchantText, counterpartOf, monthlyCost, MONTHLY_FACTOR, addPeriod, nextChargeDate, isStale, daysBetween };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Detector = api;
})(this);
