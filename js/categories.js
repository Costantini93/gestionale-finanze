// Categorie per la panoramica di tutte le spese.
// Ogni movimento viene assegnato alla prima categoria le cui parole chiave compaiono nella descrizione
// (stessa sintassi di Services.IGNORE_KEYS: parola intera, '*' finale = prefisso).
// L'utente può poi spostare un esercente in un'altra categoria dall'interfaccia.
(function (root) {
  // Catene di supermercati: servono sia per la categoria "Spesa alimentare" sia per raggruppare la spesa per insegna.
  const SUPERMARKETS = [
    { name: 'Esselunga', keys: ['esselunga'] },
    { name: 'Conad', keys: ['conad', 'spazio conad'] },
    { name: 'Coop', keys: ['coop', 'ipercoop', 'unicoop', 'novacoop', 'coop alleanza'] },
    { name: 'Lidl', keys: ['lidl'] },
    { name: 'Aldi', keys: ['aldi'] },
    { name: 'Eurospin', keys: ['eurospin'] },
    { name: 'Carrefour', keys: ['carrefour'] },
    { name: 'Pam / Panorama', keys: ['pam', 'panorama', 'pam local'] },
    { name: 'Despar / Interspar', keys: ['despar', 'eurospar', 'interspar', 'spar'] },
    { name: 'Famila', keys: ['famila'] },
    { name: 'MD', keys: ['md', 'md spa', 'md discount'] },
    { name: 'Penny Market', keys: ['penny'] },
    { name: 'Migross', keys: ['migross'] },
    { name: 'Tosano', keys: ['tosano'] },
    { name: 'Cadoro', keys: ['cadoro'] },
    { name: 'Alì / Aliper', keys: ['aliper', 'ali supermercati'] },
    { name: 'Bennet', keys: ['bennet'] },
    { name: 'Il Gigante', keys: ['il gigante'] },
    { name: 'Iper', keys: ['iper', 'iper la grande'] },
    { name: 'Iperal', keys: ['iperal'] },
    { name: 'Tigre', keys: ['tigre'] },
    { name: 'Crai', keys: ['crai'] },
    { name: 'Sigma', keys: ['sigma'] },
    { name: 'Unes', keys: ['unes'] },
    { name: 'Basko', keys: ['basko'] },
    { name: 'Todis', keys: ['todis'] },
    { name: 'Ekom', keys: ['ekom'] },
    { name: 'Prix', keys: ['prix', 'prix quality'] },
    { name: "In's Mercato", keys: ['ins mercato'] },
    { name: 'Dpiù', keys: ['dpiu'] },
    { name: 'Sole 365', keys: ['sole 365', 'sole365'] },
    { name: 'Emisfero', keys: ['emisfero'] },
    { name: 'Simply', keys: ['simply'] },
    { name: 'NaturaSì', keys: ['naturasi'] },
    { name: 'Everli', keys: ['everli'] },
    { name: 'Amazon Fresh', keys: ['amazon fresh'] },
  ];
  // Servizi di consegna a domicilio. Prefissi ('*') perché alcune banche attaccano la data al nome ("GLOVO11JUL").
  const DELIVERY = [
    { name: 'Glovo', keys: ['glovo*', 'foodinho'] },
    { name: 'Deliveroo', keys: ['deliveroo*'] },
    { name: 'Just Eat', keys: ['just eat', 'justeat*'] },
    { name: 'Uber Eats', keys: ['uber eats', 'ubereats*'] },
  ];
  // Negozi alimentari generici (non catene): finiscono nella spesa con il nome dell'esercente.
  const GROCERY_GENERIC = ['supermercat*', 'ipermercat*', 'alimentar*', 'minimarket', 'market', 'discount',
    'panificio', 'macelleria', 'salumeria', 'pescheria', 'ortofrutta', 'frutta', 'forno'];

  const CATEGORIES = [
    { id: 'giroconti', name: 'Risparmi e giroconti', color: '#94a3b8', excluded: true, keys: ['salvadanaio', 'giroconto'] },
    { id: 'prelievi', name: 'Prelievi contanti', color: '#64748b', keys: ['prelievo', 'prelevamento'] },
    { id: 'investimenti', name: 'Investimenti e crypto', color: '#0f766e', keys: ['crypto', 'binance', 'coinbase', 'bitpanda', 'kraken', 'young platform', 'trade republic', 'scalable', 'directa', 'degiro', 'etoro'] },
    { id: 'tasse', name: 'Tasse e pagoPA', color: '#7c3aed', keys: ['pagopa', 'f24', 'agenzia entrate', 'agenzia delle entrate', 'bollo auto', 'multa', 'comune di'] },
    { id: 'affitto', name: 'Casa e affitto', color: '#8b5cf6', keys: ['affitto', 'condominio', 'canone locazione'] },
    { id: 'finanziamenti', name: 'Finanziamenti e rate', color: '#6366f1', keys: ['finanziamento', 'mutuo', 'rata', 'prestito'] },
    { id: 'bollette', name: 'Bollette', color: '#0ea5e9', keys: ['enel', 'magis', 'agsm', 'agsm aim', 'aim energy', 'plenitude', 'a2a', 'hera', 'iren', 'edison', 'acque', 'acquedotto', 'gas', 'energia', 'tari'] },
    { id: 'telefonia', name: 'Telefono e internet', color: '#06b6d4', keys: ['fastweb', 'tim', 'telecom', 'vodafone', 'windtre', 'wind', 'iliad', 'ho mobile', 'very mobile', 'kena'] },
    { id: 'spesa', name: 'Spesa alimentare', color: '#22c55e', keys: [...SUPERMARKETS.flatMap(s => s.keys), ...GROCERY_GENERIC] },
    { id: 'delivery', name: 'Cibo a domicilio', color: '#f97316', keys: DELIVERY.flatMap(d => d.keys) },
    { id: 'ristoranti', name: 'Ristoranti e bar', color: '#f59e0b', keys: ['bar', 'caffe', 'caffetteria', 'ristorant*', 'pizzeri*', 'trattoria', 'osteria', 'locanda', 'bistro', 'bistrot', 'pub', 'sushi', 'pasticceria', 'gelateria', 'mcdonald*', 'burger', 'kebab', 'attico', 'oishii', 'pagoda'] },
    { id: 'scommesse', name: 'Scommesse e giochi', color: '#ef4444', keys: ['eurobet', 'bet365', 'betflag', 'snai', 'sisal', 'lottomatica', 'goldbet', 'pokerstars', 'william hill', 'starcasino', 'better', 'planetwin'] },
    { id: 'trasporti', name: 'Trasporti e carburante', color: '#14b8a6', keys: ['eni', 'enilive', 'q8', 'ip', 'tamoil', 'esso', 'carburant*', 'autostrad*', 'telepass', 'trenitalia', 'italo', 'uber', 'flixbus', 'ryanair', 'parcheggi*', 'bmove', 'motauto', 'officina', 'gommista'] },
    { id: 'shopping', name: 'Shopping', color: '#ec4899', keys: ['amazon', 'zalando', 'temu', 'shein', 'tiktok', 'zara', 'h m', 'carhartt', 'aw lab', 'way', 'decathlon', 'ecovacs', 'mediaworld', 'unieuro', 'ikea', 'primark', 'nike', 'adidas', 'pinalli', 'global e', 'sephora', 'douglas'] },
    { id: 'salute', name: 'Salute', color: '#10b981', keys: ['farmaci*', 'lafarmacia', 'dentist*', 'ospedal*', 'ottica', 'parafarmacia'] },
    { id: 'tabacchi', name: 'Tabacchi e svapo', color: '#a16207', keys: ['tabacch*', 'vape', 'svapo'] },
    { id: 'sport', name: 'Sport e tempo libero', color: '#84cc16', keys: ['tennis', 'palestra', 'padel', 'piscina', 'mcfit', 'virgin active', 'cinema', 'teatro', 'ticketone'] },
    { id: 'banca', name: 'Banca e commissioni', color: '#475569', keys: ['canone', 'commission*', 'comm', 'costo bonifico', 'imposta', 'bollo', 'competenze', 'interessi'] },
    { id: 'bonifici', name: 'Bonifici inviati', color: '#a855f7', keys: ['bonifico'] },
    { id: 'altro', name: 'Altro', color: '#9ca3af', keys: [] },
  ];
  const ABBONAMENTI = { id: 'abbonamenti', name: 'Abbonamenti', color: '#2563eb', keys: [] };
  const ALL = [ABBONAMENTI, ...CATEGORIES];

  // Categorie delle entrate (movimenti positivi). L'ordine conta come per le uscite.
  const INCOME = [
    { id: 'giroconti', name: 'Risparmi e giroconti', color: '#94a3b8', excluded: true, keys: ['salvadanaio', 'giroconto'] },
    { id: 'tfr', name: 'TFR e una tantum', color: '#15803d', keys: ['tfr', 'liquidazione', 'trattamento fine rapporto', 'buonuscita'] },
    { id: 'stipendio', name: 'Stipendio', color: '#16a34a', keys: ['stipendio', 'busta paga', 'cedolino', 'emolument*', 'retribuzion*', 'salario', 'mensilita', 'tredicesima', 'quattordicesima', 'pensione', 'inps'] },
    { id: 'rimborsi', name: 'Rimborsi e storni', color: '#0d9488', keys: ['rimborso', 'rimborsi', 'storno', 'irpef', 'mod 730', 'cashback', 'reso'] },
    { id: 'prestiti', name: 'Prestiti e finanziamenti', color: '#6366f1', keys: ['erogazione', 'finanziamento', 'prestito', 'mutuo'] },
    { id: 'versamenti', name: 'Versamenti contanti', color: '#64748b', keys: ['versamento', 'versamenti'] },
    { id: 'extra', name: 'Lavoro extra (contanti)', color: '#65a30d', keys: [] },          // solo inserimenti a mano
    { id: 'bonifici_in', name: 'Bonifici ricevuti', color: '#22c55e', keys: ['bonifico', 'bonifici', 'satispay', 'paypal'] },
    { id: 'altre_entrate', name: 'Altre entrate', color: '#9ca3af', keys: [] },
  ];
  const byId = Object.fromEntries([...ALL, ...INCOME].map(c => [c.id, c]));

  function matches(norm, key) {
    return key.endsWith('*') ? norm.includes(' ' + key.slice(0, -1)) : norm.includes(' ' + key + ' ');
  }

  // norm: descrizione normalizzata (Detector.normalize). Restituisce l'id della categoria.
  function categorize(norm) {
    for (const c of CATEGORIES) if (c.keys.some(k => matches(norm, k))) return c.id;
    return 'altro';
  }

  function categorizeIncome(norm) {
    for (const c of INCOME) if (c.keys.some(k => matches(norm, k))) return c.id;
    return 'altre_entrate';
  }

  // Insegna (supermercato o servizio di delivery) del movimento, o null se non è tra quelle conosciute.
  // Restituisce anche la parola da usare per cercare i suoi movimenti.
  function brandOf(list, norm) {
    const b = list.find(x => x.keys.some(k => matches(norm, k)));
    return b ? { name: b.name, search: b.keys[0].replace('*', '') } : null;
  }

  const api = { ALL, INCOME, byId, categorize, categorizeIncome, brandOf, SUPERMARKETS, DELIVERY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Categories = api;
})(this);
