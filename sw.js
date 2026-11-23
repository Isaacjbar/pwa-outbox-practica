// Import the IndexedDB mini-wrapper inside the Service Worker context
importScripts('./db-helper.js');

const CACHE_STATIC_NAME = 'static-outbox-v3';
const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const API_ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME).then((cache) => cache.addAll(STATIC_FILES))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((nombres) => {
        return Promise.all(
          nombres.map((nombre) => {
            if (nombre !== CACHE_STATIC_NAME) {
              console.log('[SW] Purgando caché obsoleta:', nombre);
              return caches.delete(nombre);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// App Shell: cache first for same-origin GET, network for everything else
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cacheada) => {
      return cacheada || fetch(req);
    })
  );
});

function notificarClientesActualizacion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientes) => {
      clientes.forEach((cliente) => {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
    });
}

function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(API_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        }).then((respuesta) => {
          if (!respuesta.ok) {
            throw new Error('Error HTTP ' + respuesta.status + ' al sincronizar ID ' + item.id);
          }
          return actualizarEstadoRegistro(item.id, 'sincronizado');
        });
      });

      return Promise.all(promesasDeEnvio)
        .then(() => notificarClientesActualizacion());
    });
}

self.addEventListener('sync', (event) => {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === 'sync-reportes') {
    event.waitUntil(
      sincronizarPendientesSW().catch((error) => {
        console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
        // Rethrow so the browser schedules an automatic retry
        throw error;
      })
    );
  }
});
