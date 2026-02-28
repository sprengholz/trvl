/* trvl — Travel Route Mapper
 * Pure vanilla JS · No build tools · Works offline
 */

// ── State ───────────────────────────────────────────────────────
const state = {
  locations: [],   // [{ id, name, lat, lng, accuracy, timestamp }]
  nextId: 1,
  markers: [],     // L.marker instances (parallel to locations)
  polyline: null,  // L.polyline connecting the route
  clickMode: false,
  pendingCoords: null,  // coords waiting for name input
};

// ── Map setup ───────────────────────────────────────────────────
const map = L.map('map', {
  zoomControl: true,
  attributionControl: true,
}).setView([20, 0], 2);

// Custom pane BELOW tile layer (z-index 150 < tile-pane 200)
map.createPane('geoJsonBase');
map.getPane('geoJsonBase').style.zIndex = 150;
map.getPane('geoJsonBase').style.pointerEvents = 'none';

// OSM tile layer (online base map)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
  crossOrigin: true,
}).addTo(map);

// Natural Earth 110m countries as offline fallback base layer
fetch('./data/countries-110m.json')
  .then(r => r.json())
  .then(topo => {
    const geojson = topojson.feature(topo, topo.objects.countries);
    L.geoJSON(geojson, {
      pane: 'geoJsonBase',
      style: {
        color: '#3a4455',
        weight: 0.8,
        fillColor: '#1e2d1f',
        fillOpacity: 1,
      },
    }).addTo(map);
  })
  .catch(() => {/* silently skip if data not available */});

// ── Helpers ─────────────────────────────────────────────────────
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(x));
}

function totalDistanceKm() {
  let total = 0;
  for (let i = 1; i < state.locations.length; i++) {
    total += haversineKm(state.locations[i - 1], state.locations[i]);
  }
  return total;
}

function formatDeg(val, pos, neg) {
  return Math.abs(val).toFixed(5) + '°' + (val >= 0 ? pos : neg);
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Marker creation ─────────────────────────────────────────────
function createIcon(number) {
  return L.divIcon({
    className: '',
    iconSize: [36, 45],
    iconAnchor: [18, 45],
    popupAnchor: [0, -46],
    html: `<div class="trvl-pin"><span>${number}</span></div>`,
  });
}

function buildPopupHtml(loc) {
  return `
    <div class="popup-title">${escapeHtml(loc.name)}</div>
    <div class="popup-meta">
      ${formatDeg(loc.lat, 'N', 'S')} · ${formatDeg(loc.lng, 'E', 'W')}<br>
      ${formatTime(loc.timestamp)}
      ${loc.accuracy ? ` · ±${loc.accuracy}m` : ''}
    </div>
    <div class="popup-actions">
      <button class="popup-btn edit" onclick="startEdit(${loc.id})">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Edit
      </button>
      <button class="popup-btn delete" onclick="deleteLocation(${loc.id})">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
        Delete
      </button>
    </div>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Core location operations ────────────────────────────────────
function addMarkerToMap(loc, index) {
  const marker = L.marker([loc.lat, loc.lng], { icon: createIcon(index + 1) })
    .bindPopup(buildPopupHtml(loc), { maxWidth: 220, minWidth: 180 })
    .addTo(map);
  state.markers.push(marker);
}

function addLocation(coords, name) {
  const loc = {
    id: state.nextId++,
    name: name.trim() || `Stop ${state.locations.length + 1}`,
    lat: coords.latitude ?? coords.lat,
    lng: coords.longitude ?? coords.lng,
    accuracy: coords.accuracy ? Math.round(coords.accuracy) : null,
    timestamp: new Date().toISOString(),
  };
  state.locations.push(loc);
  addMarkerToMap(loc, state.locations.length - 1);
  updatePolyline();
  fitBounds();
  renderStopList();
  updateStats();
  saveToStorage();
}

function deleteLocation(id) {
  const idx = state.locations.findIndex(l => l.id === id);
  if (idx === -1) return;

  map.closePopup();
  map.removeLayer(state.markers[idx]);
  state.markers.splice(idx, 1);
  state.locations.splice(idx, 1);

  // Renumber remaining markers
  state.markers.forEach((m, i) => m.setIcon(createIcon(i + 1)));

  // Update popups
  state.locations.forEach((loc, i) => {
    state.markers[i].setPopupContent(buildPopupHtml(loc));
  });

  updatePolyline();
  fitBounds();
  renderStopList();
  updateStats();
  saveToStorage();
  showToast('Stop removed');
}

function renameLocation(id, name) {
  const loc = state.locations.find(l => l.id === id);
  if (!loc) return;
  loc.name = name.trim() || loc.name;
  const idx = state.locations.indexOf(loc);
  state.markers[idx].setPopupContent(buildPopupHtml(loc));
  renderStopList();
  saveToStorage();
}

// ── Map rendering ───────────────────────────────────────────────
function updatePolyline() {
  if (state.polyline) { map.removeLayer(state.polyline); state.polyline = null; }
  if (state.locations.length < 2) return;
  state.polyline = L.polyline(
    state.locations.map(l => [l.lat, l.lng]),
    { color: '#f7694f', weight: 3, opacity: 0.85, lineCap: 'round', lineJoin: 'round', dashArray: '8, 6' }
  ).addTo(map);
}

function fitBounds() {
  if (state.locations.length === 0) return;
  if (state.locations.length === 1) {
    map.setView([state.locations[0].lat, state.locations[0].lng], 14, { animate: true });
    return;
  }
  const group = L.featureGroup(state.markers);
  map.fitBounds(group.getBounds().pad(0.2), { animate: true, maxZoom: 16 });
}

// ── Stop list rendering ─────────────────────────────────────────
function renderStopList() {
  const list = document.getElementById('stops-list');
  const empty = document.getElementById('stops-empty');

  if (state.locations.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = state.locations.map((loc, i) => `
    <li class="stop-item" data-id="${loc.id}">
      <div class="stop-num">${i + 1}</div>
      <div class="stop-info">
        <div class="stop-name" id="name-${loc.id}">${escapeHtml(loc.name)}</div>
        <div class="stop-meta">${formatTime(loc.timestamp)}${loc.accuracy ? ` · ±${loc.accuracy}m` : ''}</div>
      </div>
      <div class="stop-actions">
        <button class="stop-btn edit" onclick="startEdit(${loc.id})" title="Rename">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="stop-btn delete" onclick="deleteLocation(${loc.id})" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          </svg>
        </button>
      </div>
    </li>
  `).join('');
}

// ── Inline edit ─────────────────────────────────────────────────
function startEdit(id) {
  map.closePopup();
  const loc = state.locations.find(l => l.id === id);
  if (!loc) return;
  const nameEl = document.getElementById(`name-${id}`);
  if (!nameEl) return;

  const input = document.createElement('input');
  input.className = 'stop-name-input';
  input.type = 'text';
  input.value = loc.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim() || loc.name;
    renameLocation(id, newName);
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = loc.name; input.blur(); }
  });
}
window.startEdit = startEdit;
window.deleteLocation = deleteLocation;

// ── Stats bar ───────────────────────────────────────────────────
function updateStats() {
  document.getElementById('stat-stops').textContent = state.locations.length;
  const distWrap = document.getElementById('stat-dist-wrap');
  if (state.locations.length > 1) {
    const km = totalDistanceKm();
    document.getElementById('stat-dist').textContent = km >= 100
      ? Math.round(km).toLocaleString()
      : km.toFixed(1);
    distWrap.style.display = '';
  } else {
    distWrap.style.display = 'none';
  }
}

// ── Modal ───────────────────────────────────────────────────────
function openModal(coords, title = 'Location Captured', subtitle = '') {
  state.pendingCoords = coords;
  const lat = coords.latitude ?? coords.lat;
  const lng = coords.longitude ?? coords.lng;
  const acc = coords.accuracy;

  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-subtitle').textContent = subtitle;
  document.getElementById('modal-lat').textContent = formatDeg(lat, 'N', 'S');
  document.getElementById('modal-lon').textContent = formatDeg(lng, 'E', 'W');
  document.getElementById('modal-accuracy').innerHTML = acc
    ? `GPS accuracy: <span>±${Math.round(acc)} m</span>`
    : '';
  document.getElementById('input-name').value = '';
  document.getElementById('modal-overlay').classList.add('visible');

  // Auto-focus name input after animation
  setTimeout(() => document.getElementById('input-name').focus(), 350);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('visible');
  state.pendingCoords = null;
}

document.getElementById('btn-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

document.getElementById('btn-save').addEventListener('click', () => {
  if (!state.pendingCoords) return;
  const name = document.getElementById('input-name').value;
  addLocation(state.pendingCoords, name);
  closeModal();
  showToast('Location saved!');
});

document.getElementById('input-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-save').click();
  if (e.key === 'Escape') closeModal();
});

// ── GPS capture ─────────────────────────────────────────────────
const btnAdd = document.getElementById('btn-add');
btnAdd.addEventListener('click', captureGPS);

function captureGPS() {
  if (!navigator.geolocation) {
    showToast('GPS not available in this browser');
    return;
  }
  btnAdd.disabled = true;
  btnAdd.classList.add('loading');
  btnAdd.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
    Acquiring GPS…`;
  const style = document.createElement('style');
  style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);

  navigator.geolocation.getCurrentPosition(
    pos => {
      resetAddBtn();
      openModal(pos.coords, 'Location Captured', 'From GPS');
    },
    err => {
      resetAddBtn();
      const messages = {
        1: 'Location access denied. Please allow in browser settings.',
        2: 'Location unavailable. Try again outdoors.',
        3: 'GPS timed out. Try again.',
      };
      showToast(messages[err.code] || 'GPS error: ' + err.message, 4000);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function resetAddBtn() {
  btnAdd.disabled = false;
  btnAdd.classList.remove('loading');
  btnAdd.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/>
      <line x1="12" y1="8" x2="12" y2="14"/>
      <line x1="9" y1="11" x2="15" y2="11"/>
    </svg>
    Add Current Location`;
}

// ── Map-click mode ──────────────────────────────────────────────
const fabClickMode = document.getElementById('fab-click-mode');
fabClickMode.addEventListener('click', () => {
  state.clickMode = !state.clickMode;
  fabClickMode.classList.toggle('active', state.clickMode);
  document.getElementById('map').classList.toggle('click-mode', state.clickMode);
  showToast(state.clickMode ? 'Click map to add a stop' : 'Map-click mode off');
});

map.on('click', e => {
  if (!state.clickMode) return;
  const coords = { latitude: e.latlng.lat, longitude: e.latlng.lng, accuracy: null };
  openModal(coords, 'Map Location', 'Added by map click');
});

// ── Export ──────────────────────────────────────────────────────
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJSON() {
  if (state.locations.length === 0) { showToast('No stops to export'); return; }
  const data = {
    name: 'trvl route',
    created: new Date().toISOString(),
    stops: state.locations.map(l => ({
      name: l.name,
      lat: l.lat,
      lng: l.lng,
      accuracy: l.accuracy,
      timestamp: l.timestamp,
    })),
    totalDistanceKm: state.locations.length > 1 ? +totalDistanceKm().toFixed(2) : 0,
  };
  downloadFile(JSON.stringify(data, null, 2), 'trvl-route.json', 'application/json');
  showToast('JSON exported');
}

function exportGPX() {
  if (state.locations.length === 0) { showToast('No stops to export'); return; }
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const wpts = state.locations.map(l => `
  <wpt lat="${l.lat}" lon="${l.lng}">
    <name>${esc(l.name)}</name>
    <time>${l.timestamp}</time>
    ${l.accuracy ? `<hdop>${(l.accuracy / 5).toFixed(1)}</hdop>` : ''}
  </wpt>`).join('');
  const trkpts = state.locations.map(l =>
    `      <trkpt lat="${l.lat}" lon="${l.lng}"><time>${l.timestamp}</time></trkpt>`
  ).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="trvl" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>trvl route</name>
    <time>${new Date().toISOString()}</time>
  </metadata>${wpts}
  <trk>
    <name>trvl route</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  downloadFile(gpx, 'trvl-route.gpx', 'application/gpx+xml');
  showToast('GPX exported');
}

// Wire up export buttons
document.getElementById('btn-export-json').addEventListener('click', exportJSON);
document.getElementById('btn-export-gpx').addEventListener('click', exportGPX);

// ── Clear all ───────────────────────────────────────────────────
document.getElementById('btn-clear-all').addEventListener('click', () => {
  if (state.locations.length === 0) { showToast('Nothing to clear'); return; }
  if (!confirm(`Delete all ${state.locations.length} stop${state.locations.length > 1 ? 's' : ''}?`)) return;
  state.markers.forEach(m => map.removeLayer(m));
  state.markers = [];
  state.locations = [];
  if (state.polyline) { map.removeLayer(state.polyline); state.polyline = null; }
  map.setView([20, 0], 2, { animate: true });
  renderStopList();
  updateStats();
  saveToStorage();
  showToast('All stops cleared');
});

// ── Persistence (localStorage) ──────────────────────────────────
function saveToStorage() {
  try {
    localStorage.setItem('trvl-locations', JSON.stringify(state.locations));
    localStorage.setItem('trvl-next-id', String(state.nextId));
  } catch (e) { /* storage full or unavailable */ }
}

function loadFromStorage() {
  try {
    const saved = localStorage.getItem('trvl-locations');
    if (!saved) return;
    const locs = JSON.parse(saved);
    state.nextId = parseInt(localStorage.getItem('trvl-next-id') || '1');
    locs.forEach((loc, i) => {
      state.locations.push(loc);
      addMarkerToMap(loc, i);
    });
    updatePolyline();
    fitBounds();
    renderStopList();
    updateStats();
  } catch (e) { /* corrupted data, start fresh */ }
}

// ── Online / offline indicator ──────────────────────────────────
function updateOnlineStatus() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (navigator.onLine) {
    dot.className = 'online';
    text.textContent = 'Online';
  } else {
    dot.className = 'offline';
    text.textContent = 'Offline';
  }
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ── Keyboard shortcuts ──────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (document.getElementById('modal-overlay').classList.contains('visible')) return;
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'a' || e.key === 'A') captureGPS();
  if (e.key === 'Escape' && state.clickMode) {
    state.clickMode = false;
    fabClickMode.classList.remove('active');
    document.getElementById('map').classList.remove('click-mode');
  }
});

// ── Init ────────────────────────────────────────────────────────
loadFromStorage();
