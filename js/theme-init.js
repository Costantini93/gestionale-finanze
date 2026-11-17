// Il gestionale è sempre in tema scuro (vetro scuro trasparente): si applica prima che la pagina si disegni.
document.documentElement.setAttribute('data-theme', 'dark');
try { localStorage.removeItem('finanze-tema'); } catch (e) { /* niente da pulire */ }
