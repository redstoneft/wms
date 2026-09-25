// Diagnóstico del handheld (/diag.html). Script externo: la CSP (script-src 'self') no permite JS inline.
(function () {
  var ua = navigator.userAgent;
  var m = ua.match(/Chrome\/(\d+)/);
  var chrome = m ? parseInt(m[1], 10) : 0;
  var rows = [];
  function add(k, v, ok) { rows.push({ k: k, v: v, ok: ok }); }
  add('Navegador', ua.replace(/^Mozilla\/5\.0 /, ''), chrome >= 111);
  add('Versión de Chrome', chrome ? chrome : 'no es Chrome', chrome >= 111);
  add('Requisito', 'Chrome 111 o más nuevo', true);
  var sup = window.CSS && CSS.supports;
  add('Colores modernos (oklch)', sup ? (CSS.supports('color', 'oklch(50% 0.1 200)') ? 'sí' : 'NO') : 'no se puede saber', sup && CSS.supports('color', 'oklch(50% 0.1 200)'));
  add('color-mix', sup ? (CSS.supports('color', 'color-mix(in oklab, red, blue)') ? 'sí' : 'NO') : '?', sup && CSS.supports('color', 'color-mix(in oklab, red, blue)'));
  add('Cookies', navigator.cookieEnabled ? 'habilitadas' : 'DESHABILITADAS', navigator.cookieEnabled);
  add('Conexión segura (https)', location.protocol === 'https:' ? 'sí' : 'NO', location.protocol === 'https:');
  add('crypto.randomUUID', (window.crypto && typeof crypto.randomUUID === 'function') ? 'sí' : 'NO', !!(window.crypto && crypto.randomUUID));
  add('BigInt', typeof BigInt === 'function' ? 'sí' : 'NO', typeof BigInt === 'function');
  add('Modo app (pantalla completa)', (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ? 'sí' : 'no (abierto en Chrome)', true);
  add('Pantalla', screen.width + '×' + screen.height + ' @' + (window.devicePixelRatio || 1), true);
  add('Hora del equipo', new Date().toString(), true);
  add('Idioma', navigator.language, true);
  var html = '';
  rows.forEach(function (r) { html += '<div class="row"><span class="k">' + r.k + '</span><span class="v ' + (r.ok ? 'ok' : 'bad') + '">' + r.v + '</span></div>'; });
  document.getElementById('rows').innerHTML = html;
  document.getElementById('copy').addEventListener('click', function () {
    if (!navigator.clipboard) { alert('No se pudo copiar; toma captura de pantalla.'); return; }
    navigator.clipboard.writeText(document.getElementById('rows').innerText).then(function () { alert('Copiado. Pégalo en un mensaje.'); }, function () { alert('No se pudo copiar; toma captura de pantalla.'); });
  });
  var api = document.getElementById('api');
  var t0 = Date.now();
  fetch('/api/health/live', { credentials: 'include' }).then(function (r) {
    api.textContent = (r.ok ? 'OK' : 'ERROR ' + r.status) + ' · ' + (Date.now() - t0) + ' ms';
    api.className = 'v ' + (r.ok ? 'ok' : 'bad');
  }).catch(function (e) { api.textContent = 'SIN CONEXIÓN: ' + e; api.className = 'v bad'; });
})();
