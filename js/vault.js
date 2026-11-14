// Cassaforte dei dati: tutto lo stato dell'app viene salvato cifrato con la password dell'utente.
// - Chiave: PBKDF2-SHA256 (310.000 iterazioni) dalla password + un "sale" casuale
// - Cifratura: AES-GCM 256 bit, con un vettore casuale nuovo a ogni salvataggio
// La password non viene mai salvata: senza di essa i dati non si possono leggere (né recuperare).
(function (root) {
  const KEY = 'gestionale-abbonamenti-v1-enc';
  const ITERATIONS = 310000;
  const subtle = root.crypto && root.crypto.subtle;
  let cryptoKey = null, salt = null;
  let queue = Promise.resolve();

  // Conversione a blocchi: passare tutti i byte insieme a fromCharCode supera i limiti del browser con molti dati
  const toB64 = buf => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function deriveKey(password, saltBytes) {
    const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt: saltBytes, iterations: ITERATIONS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function write(obj) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(JSON.stringify(obj)));
    localStorage.setItem(KEY, JSON.stringify({ v: 1, salt: toB64(salt), iv: toB64(iv), data: toB64(data) }));
  }

  const Vault = {
    supported: !!subtle,
    exists: () => !!localStorage.getItem(KEY),

    // Crea la cassaforte con una nuova password (o cambia la password) e ci salva dentro obj.
    async create(password, obj) {
      salt = root.crypto.getRandomValues(new Uint8Array(16));
      cryptoKey = await deriveKey(password, salt);
      await write(obj);
    },

    // Apre la cassaforte: restituisce i dati, oppure lancia un errore se la password è sbagliata.
    async open(password) {
      const box = JSON.parse(localStorage.getItem(KEY));
      const s = fromB64(box.salt);
      const key = await deriveKey(password, s);
      let plain;
      try {
        plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data));
      } catch {
        throw new Error('Password errata');
      }
      cryptoKey = key; salt = s;
      return JSON.parse(new TextDecoder().decode(plain));
    },

    // Salvataggi in coda: arrivano su disco nello stesso ordine in cui sono stati richiesti.
    save(obj) {
      if (!cryptoKey) return Promise.reject(new Error('Cassaforte chiusa'));
      const snapshot = JSON.parse(JSON.stringify(obj));
      const job = queue.catch(() => {}).then(() => write(snapshot));   // un errore non blocca i salvataggi successivi
      queue = job;
      return job;
    },

    // Cancella i dati cifrati (password dimenticata).
    destroy() {
      localStorage.removeItem(KEY);
      cryptoKey = null; salt = null;
    },
  };

  root.Vault = Vault;
})(this);
