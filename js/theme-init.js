// Applica subito il tema scelto con il pulsante in alto (chiaro o scuro), prima che la pagina si disegni.
// Senza una scelta salvata vale il tema del telefono.
try {
  var t = localStorage.getItem('finanze-tema');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* memoria del browser non disponibile: si usa il tema del telefono */ }
