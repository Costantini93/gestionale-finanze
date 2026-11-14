// Database dei servizi in abbonamento conosciuti.
// - keys: parole chiave cercate nella descrizione del movimento (già normalizzata: minuscolo, senza punteggiatura)
// - url:  pagina per disdire (null = ricerca guidata su Google)
// L'ordine conta: le voci più specifiche vanno prima di quelle generiche.
// Campi facoltativi:
// - amount:    la voce vale solo per addebiti di esattamente questo importo (es. un'app pagata tramite Apple)
// - frequency: frequenza fissa, invece di quella dedotta dagli intervalli tra gli addebiti
// - ranges:    fasce di importo [min, max] plausibili per l'abbonamento (per esercenti che vendono anche altro)
(function (root) {
  const SERVICES = [
    // --- Regole personali: abbonamenti pagati tramite un intermediario (Apple, Google, PayPal) ---
    { name: 'Claude (tramite Apple)', cat: 'Software', keys: ['apple com bill', 'applecombill', 'apple com'], amount: 22.00, frequency: 'mensile', url: 'https://apps.apple.com/account/subscriptions' },

    // --- Streaming video ---
    { name: 'Netflix', cat: 'Streaming', keys: ['netflix'], url: 'https://www.netflix.com/cancelplan' },
    { name: 'Disney+', cat: 'Streaming', keys: ['disney plus', 'disneyplus', 'disney'], url: 'https://www.disneyplus.com/account/subscription' },
    { name: 'Prime Video Channels', cat: 'Streaming', keys: ['prime video channels', 'primevideo channel'], url: 'https://www.primevideo.com/settings/channels' },
    { name: 'Amazon Prime', cat: 'Shopping', keys: ['amazon prime', 'prime video', 'primevideo', 'amzn prime', 'amazonprime', 'amazon eu'],
      // "AMAZON EU" addebita anche gli acquisti: è Prime solo con importi da abbonamento (mensile o annuale)
      ranges: [[2, 10], [35, 60]], url: 'https://www.amazon.it/gp/primecentral' },
    { name: 'Kindle Unlimited', cat: 'Lettura', keys: ['kindle unlimited', 'kindle svcs', 'kindle'], url: 'https://www.amazon.it/kindle-dbs/ku/ku-central' },
    { name: 'Audible', cat: 'Lettura', keys: ['audible'], url: 'https://www.audible.it/account/overview' },
    { name: 'Amazon Music', cat: 'Musica', keys: ['amazon music', 'amzn music', 'amazon digital music'], url: 'https://www.amazon.it/music/settings' },
    { name: 'DAZN', cat: 'Streaming', keys: ['dazn'], url: 'https://www.dazn.com/myaccount' },
    { name: 'NOW', cat: 'Streaming', keys: ['nowtv', 'now tv', 'presso now'], url: 'https://www.nowtv.it/myaccount' },
    { name: 'Sky', cat: 'Streaming', keys: ['sky italia', 'sky it', 'sky'], url: 'https://www.sky.it/assistenza/disdetta' },
    { name: 'Paramount+', cat: 'Streaming', keys: ['paramount'], url: 'https://www.paramountplus.com/it/account/' },
    { name: 'Crunchyroll', cat: 'Streaming', keys: ['crunchyroll'], url: 'https://www.crunchyroll.com/account/membership' },
    { name: 'Discovery+', cat: 'Streaming', keys: ['discovery plus', 'discoveryplus'], url: null },
    { name: 'TIMVISION', cat: 'Streaming', keys: ['timvision'], url: null },
    { name: 'Mediaset Infinity', cat: 'Streaming', keys: ['infinity', 'mediaset'], url: null },
    { name: 'Apple TV+', cat: 'Streaming', keys: ['apple tv'], url: 'https://apps.apple.com/account/subscriptions' },
    { name: 'Twitch', cat: 'Streaming', keys: ['twitch'], url: 'https://www.twitch.tv/subscriptions' },

    // --- YouTube / Google ---
    { name: 'YouTube Premium', cat: 'Streaming', keys: ['youtube', 'google youtube', 'yt premium'], url: 'https://www.youtube.com/paid_memberships' },
    { name: 'Google One', cat: 'Cloud', keys: ['google one', 'googleone', 'google storage'], url: 'https://one.google.com/settings' },
    { name: 'Google Play', cat: 'App', keys: ['google play', 'googleplay', 'google services'], url: 'https://play.google.com/store/account/subscriptions' },

    // --- Musica ---
    { name: 'Spotify', cat: 'Musica', keys: ['spotify'], url: 'https://www.spotify.com/it/account/subscription/' },
    { name: 'Deezer', cat: 'Musica', keys: ['deezer'], url: 'https://www.deezer.com/account/subscription' },
    { name: 'Tidal', cat: 'Musica', keys: ['tidal'], url: 'https://account.tidal.com/subscription' },

    // --- Apple ---
    { name: 'Apple (iCloud / App Store)', cat: 'App', keys: ['apple com bill', 'applecombill', 'itunes', 'icloud', 'apple services', 'apple com'], url: 'https://apps.apple.com/account/subscriptions' },

    // --- Software / cloud / AI ---
    { name: 'Microsoft 365 / Xbox', cat: 'Software', keys: ['microsoft', 'msft', 'xbox', 'office 365'], url: 'https://account.microsoft.com/services' },
    { name: 'Adobe', cat: 'Software', keys: ['adobe'], url: 'https://account.adobe.com/plans' },
    { name: 'Dropbox', cat: 'Cloud', keys: ['dropbox'], url: 'https://www.dropbox.com/account/plan' },
    { name: 'ChatGPT', cat: 'Software', keys: ['openai', 'chatgpt'], url: 'https://chatgpt.com/#settings/Subscription' },
    { name: 'Claude', cat: 'Software', keys: ['anthropic', 'claude ai'], url: 'https://claude.ai/settings/billing' },
    { name: 'Canva', cat: 'Software', keys: ['canva'], url: 'https://www.canva.com/settings/billing-and-teams' },
    { name: 'GitHub', cat: 'Software', keys: ['github'], url: 'https://github.com/settings/billing' },
    { name: 'Notion', cat: 'Software', keys: ['notion'], url: null },
    { name: 'NordVPN', cat: 'Software', keys: ['nordvpn', 'nord vpn', 'nordsec'], url: 'https://my.nordaccount.com/' },
    { name: 'ExpressVPN', cat: 'Software', keys: ['expressvpn'], url: null },
    { name: 'LinkedIn Premium', cat: 'Software', keys: ['linkedin'], url: 'https://www.linkedin.com/premium/manage/' },
    { name: 'Duolingo', cat: 'App', keys: ['duolingo'], url: 'https://www.duolingo.com/settings/super' },
    { name: 'Storytel', cat: 'Lettura', keys: ['storytel'], url: 'https://www.storytel.com/it/account' },
    { name: 'Patreon', cat: 'Altro', keys: ['patreon'], url: 'https://www.patreon.com/settings/memberships' },

    // --- Gaming ---
    { name: 'PlayStation Plus', cat: 'Gaming', keys: ['playstation', 'sony interactive', 'psn'], url: 'https://www.playstation.com/it-it/support/subscriptions/cancel-playstation-subscription/' },
    { name: 'Nintendo Switch Online', cat: 'Gaming', keys: ['nintendo'], url: null },

    // --- Telefonia / internet / utenze ---
    { name: 'TIM', cat: 'Telefonia', keys: ['telecom italia', 'tim spa', 'tim'], url: null },
    { name: 'Vodafone', cat: 'Telefonia', keys: ['vodafone'], url: null },
    { name: 'WindTre', cat: 'Telefonia', keys: ['windtre', 'wind tre', 'wind'], url: null },
    { name: 'Iliad', cat: 'Telefonia', keys: ['iliad'], url: null },
    { name: 'Fastweb', cat: 'Telefonia', keys: ['fastweb'], url: null },
    { name: 'ho. Mobile', cat: 'Telefonia', keys: ['ho mobile', 'homobile'], url: null },
    { name: 'Very Mobile', cat: 'Telefonia', keys: ['very mobile'], url: null },
    { name: 'Kena Mobile', cat: 'Telefonia', keys: ['kena'], url: null },
    { name: 'Enel Energia', cat: 'Utenze', keys: ['enel'], url: null },
    { name: 'Eni Plenitude', cat: 'Utenze', keys: ['plenitude', 'eni gas'], url: null },
    { name: 'A2A', cat: 'Utenze', keys: ['a2a'], url: null },
    { name: 'Hera', cat: 'Utenze', keys: ['hera comm', 'hera'], url: null },
    { name: 'Edison', cat: 'Utenze', keys: ['edison'], url: null },
    { name: 'Iren', cat: 'Utenze', keys: ['iren'], url: null },
    { name: 'AGSM AIM Energia', cat: 'Utenze', keys: ['agsm aim', 'agsm', 'aim energy'], url: null },
    { name: 'Magis Energia', cat: 'Utenze', keys: ['magis energia', 'magis'], url: null },
    { name: 'Acque Veronesi', cat: 'Utenze', keys: ['acque veronesi'], url: null },
    { name: 'Hetzner', cat: 'Cloud', keys: ['hetzner'], url: 'https://accounts.hetzner.com/' },
    { name: 'Wix', cat: 'Software', keys: ['wix com', 'wix'], url: 'https://manage.wix.com/account/subscriptions' },

    // --- Palestre / altro ---
    { name: 'McFIT', cat: 'Palestra', keys: ['mcfit'], url: null },
    { name: 'Virgin Active', cat: 'Palestra', keys: ['virgin active'], url: null },
    { name: 'Deliveroo Plus', cat: 'Altro', keys: ['deliveroo plus'], url: null },
    { name: 'Uber One', cat: 'Altro', keys: ['uber one'], url: null },

    // --- Intermediari (il vero servizio è nascosto) ---
    { name: 'PayPal (pagamento ricorrente)', cat: 'Altro', keys: ['paypal'], url: 'https://www.paypal.com/myaccount/autopay/' },
  ];

  // Movimenti che si ripetono ma NON sono abbonamenti: esclusi dal rilevamento automatico
  // (solo per i movimenti non riconosciuti nel database). Parola intera; '*' finale = prefisso.
  const IGNORE_KEYS = [
    'stipendio', 'emolument*', 'accredit*', 'prelievo', 'prelevamento', 'giroconto',
    'imposta di bollo', 'imposta bollo', 'bollo', 'ricarica', 'interessi', 'competenze',
    'rimborso', 'storno', 'versamento', 'bonifico a vostro favore', 'commission*',
    'supermercat*', 'carburant*', 'esselunga', 'conad', 'coop', 'ipercoop', 'lidl', 'eurospin',
    'carrefour', 'pam', 'md spa', 'aldi', 'despar', 'tabacch*', 'farmaci*', 'autostrad*',
    'eni station', 'enilive', 'q8', 'tamoil', 'esso', 'bar', 'ristorant*', 'pizzeri*',
    'mcdonald*', 'burger king', 'trattoria', 'panificio', 'macelleria',
    'salvadanaio', 'bonifico', 'finanziamento', 'mutuo', 'erogazione', 'glovo*', 'deliveroo*', 'just eat', 'justeat*', 'eurobet', 'bet365',
  ];

  function cancelUrl(service, name) {
    if (service && service.url) return service.url;
    const q = encodeURIComponent('come disdire abbonamento ' + name);
    return 'https://www.google.com/search?q=' + q;
  }

  const api = { SERVICES, IGNORE_KEYS, cancelUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Services = api;
})(this);
