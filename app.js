const API_ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

// ---- Service Worker registration + messages from the SW (postMessage bridge) ----
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('[SW] Registrado con scope:', reg.scope))
      .catch((err) => console.error('[SW] Falla de registro:', err));
  });
}

// ---- Network indicator ----
function actualizarIndicadorRed() {
  const badge = document.getElementById('badge-red');
  if (navigator.onLine) {
    badge.textContent = 'En Línea';
    badge.className = 'badge online';
  } else {
    badge.textContent = 'Sin Conexión';
    badge.className = 'badge offline';
  }
}

// ---- READ: draw the outbox ----
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros().then((registros) => {
    const lista = document.getElementById('lista-outbox');
    lista.innerHTML = '';

    if (registros.length === 0) {
      const vacio = document.createElement('li');
      vacio.className = 'vacio';
      vacio.textContent = 'Bandeja vacía';
      lista.appendChild(vacio);
      return;
    }

    registros.forEach((item) => {
      const li = document.createElement('li');

      const info = document.createElement('div');
      const titulo = document.createElement('strong');
      titulo.textContent = item.titulo;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = new Date(item.fechaCreacion).toLocaleString('es-MX');
      info.appendChild(titulo);
      info.appendChild(meta);

      const estado = document.createElement('span');
      estado.className = 'estado ' + item.estado;
      estado.textContent = item.estado;

      li.appendChild(info);
      li.appendChild(estado);
      lista.appendChild(li);
    });
  });
}

// ---- CREATE: resilient send, fallback to IndexedDB + Background Sync ----
function procesarEnvioReporte(datosFormulario) {
  return fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: datosFormulario.titulo, body: datosFormulario.descripcion })
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      }).then(() => {
        if ('serviceWorker' in navigator && 'SyncManager' in window) {
          return navigator.serviceWorker.ready.then((registro) => {
            console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
            return registro.sync.register('sync-reportes');
          });
        }
      });
    })
    .then(() => renderizarColaOutbox());
}

// ---- UPDATE (fallback for browsers without SyncManager, e.g. Safari/iOS) ----
function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(API_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        }).then((res) => {
          if (!res.ok) throw new Error('Falla al reintentar envío');
          return actualizarEstadoRegistro(item.id, 'sincronizado');
        });
      });

      return Promise.all(promesasDeEnvio);
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    });
}

window.addEventListener('online', () => {
  actualizarIndicadorRed();

  // Graceful degradation: only sync from the UI when Background Sync is unavailable
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

// ---- Form submit ----
document.getElementById('form-incidencia').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const datos = {
    titulo: document.getElementById('titulo').value.trim(),
    descripcion: document.getElementById('descripcion').value.trim()
  };

  procesarEnvioReporte(datos)
    .then(() => form.reset())
    .catch((err) => console.error('[Outbox] Error al procesar el reporte:', err));
});

// ---- DELETE: purge synced records ----
document.getElementById('btn-purgar').addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(sincronizados.map((item) => eliminarRegistro(item.id)));
    })
    .then(() => renderizarColaOutbox())
    .catch((err) => console.error('[Outbox] Error al purgar:', err));
});

// ---- Init: READ on page load ----
actualizarIndicadorRed();
renderizarColaOutbox().catch((err) => console.error('[Outbox] Error al leer IndexedDB:', err));
// If the page opens online with leftover pendientes and no SyncManager, flush them
if (navigator.onLine && !('SyncManager' in window)) {
  sincronizarPendientesFallback();
}
