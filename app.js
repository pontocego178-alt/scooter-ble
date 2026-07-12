'use strict';
/* =========================================================================
   DNTOO Scooter BLE — app.js
   Protocolo AT-A5 · GATT FFE5/FFE9 (TX) · FFE0/FFE4 (RX)
   ========================================================================= */

const SERVICE_TX = 0xffe5, CHAR_TX = 0xffe9;   // app -> patinete
const SERVICE_RX = 0xffe0, CHAR_RX = 0xffe4;   // patinete -> app

// --- Slot de temperatura -------------------------------------------------
// O pacote de status (15 bytes) não tem, até hoje, nenhum byte de
// temperatura confirmado. Quando você identificar o offset real, preencha
// aqui — o resto do app já está pronto para consumir isso.
//   offset: índice do byte no pacote (0-14)
//   read:   function(rawByteValue) -> °C
const DEVICE_TEMP_BYTE = {
  offset: null,          // ex: 2
  read: (b) => b,        // ex: (b) => b - 40   ou   (b) => b / 10
};

// Modos de condução — combinam bits já confirmados (speedlimit + mode)
const RIDING_MODES = [
  { key: 'eco',    label: 'Eco',    sub: '15 km/h',    speedlimit: 0, mode: 0 },
  { key: 'normal', label: 'Normal', sub: '20 km/h',    speedlimit: 1, mode: 0 },
  { key: 'sport',  label: 'Sport',  sub: '25 km/h',    speedlimit: 2, mode: 1 },
  { key: 'livre',  label: 'Livre*', sub: 'sem limite', speedlimit: 3, mode: 1 },
];

const PENDING_WINDOW_MS = 1200;
const HOLD_INTERVAL_MS = 400;
const STORAGE_KEY_TRIPS = 'scooterble_trips_v1';
const STORAGE_KEY_LASTPOS = 'scooterble_lastpos_v1';

let device, server, txChar, rxChar;
let state = {
  battery: null, speed: null, totalDist: null, tripDist: null, rideTime: null,
  lock: 0, kmMph: 1, light: 0, speedlimit: 0, mode: 0, xh: 0, gear: 0, fault: 0,
  brakeLevel: 0, deviceTempC: null,
};
let pollTimer = null;
let pollPaused = true;
let prevStatusByte = null, prevFaultByte = null;
let notifyCount = 0, firstNotifyAt = null;
let holdTimer = null;
let pendingChange = null; // { fields:{k:v,...}, sentAt }

// --- Diagnóstico de desbloqueio -----------------------------------------
const sessionModeMax = {}; // maior velocidade observada por modo, na sessão atual
RIDING_MODES.forEach(m => sessionModeMax[m.key] = 0);
let autoHoldOnLivre = (localStorage.getItem('scooterble_autohold_livre') ?? '1') === '1';
let sweepRunning = false;

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------- */
/* Log / console                                                          */
/* ---------------------------------------------------------------------- */
const logEl = () => $('console');
const logHistory = [];

function log(msg, cls) {
  const el = logEl();
  if (!el) return;
  const line = document.createElement('div');
  line.className = 'line ' + (cls || 'sys');
  const now = new Date();
  const t = now.toLocaleTimeString('pt-BR', { hour12: false });
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  logHistory.push({ t: now, cls: cls || 'sys', msg });
}

function downloadLog() {
  if (logHistory.length === 0) { log('nada pra salvar ainda.', 'sys'); return; }
  const header = `DNTOO Scooter BLE — log de sessão\nGerado em ${new Date().toLocaleString('pt-BR')}\nDispositivo: ${device ? (device.name || device.id) : '(não conectado)'}\n${'='.repeat(50)}\n`;
  const body = logHistory.map(({ t, cls, msg }) => `[${t.toISOString()}] [${cls.toUpperCase()}] ${msg}`).join('\n');
  const blob = new Blob([header + body], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url; a.download = `scooter-ble-log_${stamp}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  log(`log salvo (${logHistory.length} linhas).`, 'sys');
}

/* ---------------------------------------------------------------------- */
/* Helpers binários                                                        */
/* ---------------------------------------------------------------------- */
function toHex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase(); }
function checksum(bytes) { let s = 0; for (const b of bytes) s = (s + b) & 0xFF; return s; }

/* ---------------------------------------------------------------------- */
/* Conexão BLE                                                             */
/* ---------------------------------------------------------------------- */
function setConnected(isConnected) {
  $('dot').className = 'dot' + (isConnected ? ' on' : '');
  $('statusText').textContent = isConnected ? 'conectado' : 'desconectado';
  $('connectBtn').textContent = isConnected ? 'Desconectar' : 'Conectar';
  $('connectBtn').classList.toggle('off', isConnected);
  ['unlockBtn', 'holdBtn', 'pausePollBtn', 'tripRecBtn', 'sweepBtn'].forEach(id => { const e = $(id); if (e) e.disabled = !isConnected; });
  document.querySelectorAll('.seg-btn').forEach(b => b.disabled = !isConnected);
  document.querySelectorAll('.switch').forEach(s => s.style.pointerEvents = isConnected ? 'auto' : 'none');
}

async function connect() {
  try {
    log('solicitando dispositivo (nRF/DNTOO)…');
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'DNTOO' }],
      optionalServices: [SERVICE_TX, SERVICE_RX, 0x1800, 0x180a]
    });
    device.addEventListener('gattserverdisconnected', onDisconnected);

    log(`conectando a ${device.name || device.id}…`);
    server = await device.gatt.connect();

    const svcTx = await server.getPrimaryService(SERVICE_TX);
    txChar = await svcTx.getCharacteristic(CHAR_TX);
    const svcRx = await server.getPrimaryService(SERVICE_RX);
    rxChar = await svcRx.getCharacteristic(CHAR_RX);

    await rxChar.startNotifications();
    rxChar.addEventListener('characteristicvaluechanged', onNotify);

    setConnected(true);
    RIDING_MODES.forEach(m => sessionModeMax[m.key] = 0);
    renderModeMaxTable();
    log('conectado. notificações chegam sozinhas — leitura automática desativada por padrão.', 'sys');
    requestStatus();
    pollPaused = true;
    $('pausePollBtn').textContent = 'Ativar leitura automática (não recomendado)';
  } catch (err) {
    log('erro ao conectar: ' + err.message, 'err');
  }
}

function disconnect() {
  if (pollTimer) clearInterval(pollTimer);
  if (device && device.gatt.connected) device.gatt.disconnect();
}

function onDisconnected() {
  setConnected(false);
  if (pollTimer) clearInterval(pollTimer);
  stopHold();
  if (tripState.active) stopTrip(true);
  log('dispositivo desconectado.', 'err');
}

async function writeBytes(bytes) {
  const buf = Uint8Array.from(bytes);
  log('TX  ' + toHex(buf), 'tx');
  try {
    if (txChar.writeValueWithoutResponse) await txChar.writeValueWithoutResponse(buf);
    else await txChar.writeValue(buf);
  } catch (err) {
    log('erro ao escrever: ' + err.message, 'err');
  }
}

function requestStatus() { writeBytes([0xA5, 0x04, 0x01, 0xAA]); }

/* ---------------------------------------------------------------------- */
/* Pacotes de comando                                                      */
/* ---------------------------------------------------------------------- */
function buildFlagsByte() {
  let flags = 0x80;
  flags |= (state.speedlimit & 0b11) << 5;
  flags |= (state.kmMph & 1) << 4;
  flags |= (state.mode & 1) << 3;
  flags |= (state.xh & 1) << 2;
  flags |= (state.lock & 1) << 1;
  flags |= (state.light & 1);
  return flags;
}

function buildSettingCommand() {
  const header = [0xA5, 0x05, 0x02, buildFlagsByte()];
  return [...header, checksum(header)];
}

// EXPERIMENTAL — não documentado. Segue o mesmo padrão dos outros comandos
// (byte[1] = tamanho total do pacote, byte[2] = opcode, checksum = soma dos
// bytes anteriores). Acrescenta 1 byte de nível de freio motor (0-3) depois
// do byte de flags. Pode não ter efeito nenhum, ou o controlador pode
// simplesmente ignorar o byte extra — é uma hipótese para testar.
function buildExperimentalBrakeCommand(level) {
  const header = [0xA5, 0x06, 0x02, buildFlagsByte(), level & 0b11];
  return [...header, checksum(header)];
}

function sendExperimentalBrake(level) {
  state.brakeLevel = level;
  renderState();
  log(`🧪 EXPERIMENTAL: testando nível de freio motor = ${level}. Observe o patinete e o console.`, 'sys');
  writeBytes(buildExperimentalBrakeCommand(level));
}

let holdBrakeInterval = null;

/* ---------------------------------------------------------------------- */
/* Recepção / decodificação                                                */
/* ---------------------------------------------------------------------- */
function decodeStatus(b) {
  return {
    lock: (b >> 7) & 1, kmMph: (b >> 6) & 1, light: (b >> 5) & 1,
    speedlimitBit: (b >> 4) & 1, mode: (b >> 3) & 1, xh: (b >> 2) & 1, gear: b & 0b11
  };
}

function onNotify(event) {
  const dv = event.target.value;
  const bytes = new Uint8Array(dv.buffer);
  notifyCount++;
  const now = performance.now();
  if (firstNotifyAt === null) firstNotifyAt = now;
  const msSinceFirst = Math.round(now - firstNotifyAt);

  log(`RX #${notifyCount} (+${msSinceFirst}ms)  ` + toHex(bytes), 'rx');
  if (bytes.length < 15) return;

  const battery = Math.min(100, dv.getUint8(3));
  const speed = dv.getUint16(4, false) / 10;
  const totalDist = dv.getUint16(6, false) / 10;
  const tripDist = dv.getUint16(8, false) / 10;
  const rideSeconds = dv.getUint16(10, false);
  const statusByte = dv.getUint8(12);
  const faultByte = dv.getUint8(13);
  const checksumByte = dv.getUint8(14);

  let sum = 0;
  for (let i = 0; i <= 13; i++) sum = (sum + dv.getUint8(i)) & 0xFF;
  if (sum !== checksumByte) log(`⚠ checksum não bate: calculado 0x${sum.toString(16)} vs recebido 0x${checksumByte.toString(16)}`, 'err');

  if (prevStatusByte !== null && prevStatusByte !== statusByte) {
    const before = decodeStatus(prevStatusByte), after = decodeStatus(statusByte);
    const changes = Object.keys(after).filter(k => before[k] !== after[k]).map(k => `${k}: ${before[k]} → ${after[k]}`);
    log(`🔄 status byte mudou (0x${prevStatusByte.toString(16)} → 0x${statusByte.toString(16)}) — ${changes.join(', ')}`, 'sys');
  }
  if (prevFaultByte !== null && prevFaultByte !== faultByte) log(`🔄 fault byte mudou (0x${prevFaultByte.toString(16)} → 0x${faultByte.toString(16)})`, 'err');
  prevStatusByte = statusByte; prevFaultByte = faultByte;

  const decoded = {
    lock: (statusByte >> 7) & 1, kmMph: (statusByte >> 6) & 1, light: (statusByte >> 5) & 1,
    mode: (statusByte >> 3) & 1, xh: (statusByte >> 2) & 1,
    gear: statusByte & 0b11, speedlimit: statusByte & 0b11
  };

  state.battery = battery; state.speed = speed; state.totalDist = totalDist;
  state.tripDist = tripDist; state.rideTime = rideSeconds; state.fault = faultByte;

  if (DEVICE_TEMP_BYTE.offset !== null && bytes.length > DEVICE_TEMP_BYTE.offset) {
    state.deviceTempC = DEVICE_TEMP_BYTE.read(dv.getUint8(DEVICE_TEMP_BYTE.offset));
  }

  if (pendingChange) {
    const elapsed = performance.now() - pendingChange.sentAt;
    const fields = pendingChange.fields;
    const allMatch = Object.keys(fields).every(k => decoded[k] === fields[k]);
    if (allMatch) {
      log(`✅ controlador confirmou ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')} (${Math.round(elapsed)}ms)`, 'sys');
      if ('speedlimit' in fields) showUnlockBanner('ok', `Confirmado: speedlimit=${fields.speedlimit}`);
      pendingChange = null;
      Object.assign(state, decoded);
    } else if (elapsed > PENDING_WINDOW_MS) {
      log(`⚠ comando não confirmado após ${PENDING_WINDOW_MS}ms — controlador reporta speedlimit=${decoded.speedlimit}, mode=${decoded.mode}. Sincronizando com o real.`, 'err');
      if ('speedlimit' in fields) showUnlockBanner('warn', `Rejeitado: pedi speedlimit=${fields.speedlimit}, controlador ficou em ${decoded.speedlimit}`);
      pendingChange = null;
      Object.assign(state, decoded);
    } else {
      for (const k of Object.keys(decoded)) if (!(k in fields)) state[k] = decoded[k];
    }
  } else {
    Object.assign(state, decoded);
  }

  trackModeMax();
  onTripSample();
  renderState();
}

/* ---------------------------------------------------------------------- */
/* Diagnóstico de desbloqueio                                             */
/* ---------------------------------------------------------------------- */
function showUnlockBanner(kind, text) {
  const el = $('unlockBanner');
  if (!el) return;
  el.textContent = text;
  el.className = 'panel-note unlock-banner ' + kind;
}

function trackModeMax() {
  const mk = currentModeKey();
  if (mk && state.speed !== null) {
    sessionModeMax[mk] = Math.max(sessionModeMax[mk] || 0, state.speed);
    renderModeMaxTable();
  }
}

function renderModeMaxTable() {
  const el = $('modeMaxTable');
  if (!el) return;
  el.innerHTML = RIDING_MODES.map(m =>
    `<div class="map-stat"><div class="v">${sessionModeMax[m.key].toFixed(1)}</div><div class="l">${m.label}</div></div>`
  ).join('');
}

// Varia mode/xh mantendo speedlimit=3 (Livre), pra descobrir se algum bit
// vizinho realmente afeta o limite físico de velocidade. Só usa bits já
// mapeados — nenhum byte/opcode novo é inventado aqui.
async function runModeSweep() {
  if (sweepRunning || !txChar) return;
  sweepRunning = true;
  const combos = [
    { mode: 0, xh: 0 }, { mode: 1, xh: 0 }, { mode: 0, xh: 1 }, { mode: 1, xh: 1 },
  ];
  log('🧪 iniciando varredura: speedlimit=3 fixo, variando mode/xh. Ande em local seguro e observe a velocidade máxima real em cada etapa.', 'sys');
  for (let i = 0; i < combos.length; i++) {
    if (!device || !device.gatt.connected) break;
    state.speedlimit = 3; state.mode = combos[i].mode; state.xh = combos[i].xh;
    renderState();
    log(`🧪 combinação ${i + 1}/${combos.length}: mode=${combos[i].mode}, xh=${combos[i].xh} — observe por ~8s.`, 'sys');
    sendSetting(['speedlimit', 'mode', 'xh']);
    await new Promise(r => setTimeout(r, 8000));
  }
  log('🧪 varredura finalizada. Compare a "Vel. máx. na sessão" de cada combinação e me diga qual (se algum) realmente destravou.', 'sys');
  sweepRunning = false;
}

/* ---------------------------------------------------------------------- */
/* Envio de ajustes                                                        */
/* ---------------------------------------------------------------------- */
function sendSetting(changedFields) {
  if (changedFields) {
    const fields = {};
    for (const f of changedFields) fields[f] = state[f];
    pendingChange = { fields, sentAt: performance.now() };
    log(`⏳ segurando sincronização de ${changedFields.join(', ')} por ${PENDING_WINDOW_MS}ms até confirmação`, 'sys');
  }
  writeBytes(buildSettingCommand());
}

function startHold() {
  if (holdTimer) return;
  holdTimer = setInterval(() => {
    const pkt = buildSettingCommand();
    log('🔁 reafirmando  ' + toHex(pkt), 'sys');
    const buf = Uint8Array.from(pkt);
    if (txChar) (txChar.writeValueWithoutResponse ? txChar.writeValueWithoutResponse(buf) : txChar.writeValue(buf)).catch(() => {});
  }, HOLD_INTERVAL_MS);
  log(`🔁 modo "manter comando" ativado (reenvio a cada ${HOLD_INTERVAL_MS}ms)`, 'sys');
  $('holdBtn').textContent = 'Parar de reafirmar';
  $('holdBtn').classList.add('primary');
}
function stopHold() {
  if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  log('🔁 modo "manter comando" desativado', 'sys');
  const b = $('holdBtn');
  if (b) { b.textContent = 'Manter comando (anti auto-revert)'; b.classList.remove('primary'); }
}

/* ---------------------------------------------------------------------- */
/* Render — página Painel                                                  */
/* ---------------------------------------------------------------------- */
function fmtTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function currentModeKey() {
  const m = RIDING_MODES.find(m => m.speedlimit === state.speedlimit && m.mode === state.mode);
  return m ? m.key : null;
}

function renderState() {
  if (state.battery !== null) $('battery').innerHTML = state.battery + '<span class="stat-unit">%</span>';
  if (state.speed !== null) $('speed').innerHTML = state.speed.toFixed(1) + '<span class="stat-unit">' + (state.kmMph ? 'km/h' : 'mph') + '</span>';
  if (state.totalDist !== null) $('totalDist').innerHTML = state.totalDist.toFixed(1) + '<span class="stat-unit">km</span>';
  if (state.tripDist !== null) $('tripDist').innerHTML = state.tripDist.toFixed(1) + '<span class="stat-unit">km</span>';
  if (state.rideTime !== null) $('rideTime').textContent = fmtTime(state.rideTime);
  $('gear').textContent = state.gear;

  document.querySelectorAll('.fault-chip').forEach(chip => {
    chip.classList.toggle('active', !!((state.fault >> Number(chip.dataset.bit)) & 1));
  });

  const modeKey = currentModeKey();
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === modeKey));

  document.querySelectorAll('.brake-btn').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.val) === state.brakeLevel));

  $('tog-kmmph').classList.toggle('on', !!state.kmMph);
  $('tog-light').classList.toggle('on', !!state.light);
  $('tog-xh').classList.toggle('on', !!state.xh);
  $('tog-lock').classList.toggle('on', !!state.lock);

  renderMapLiveStats();
}

/* ---------------------------------------------------------------------- */
/* Temperatura ambiente (Open-Meteo) — claramente rotulada como NÃO sendo  */
/* um sensor do patinete, só um dado de contexto por localização.          */
/* ---------------------------------------------------------------------- */
let lastWeatherFetch = 0;
async function refreshAmbientTemp(force) {
  const now = Date.now();
  if (!force && now - lastWeatherFetch < 10 * 60 * 1000) return;
  if (!navigator.geolocation) { setTempUI(null, 'Geolocalização indisponível'); return; }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    lastWeatherFetch = now;
    const { latitude: lat, longitude: lon } = pos.coords;
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`);
      const data = await res.json();
      const t = data && data.current ? data.current.temperature_2m : null;
      setTempUI(t, 'Open-Meteo · sua localização');
    } catch (e) {
      setTempUI(null, 'falha ao buscar clima');
    }
  }, () => setTempUI(null, 'permissão de localização negada'), { timeout: 8000 });
}
function setTempUI(value, sourceLabel) {
  const ring = $('tempRing'), sub = $('tempSub');
  if (!ring) return;
  ring.textContent = value === null || value === undefined ? '—' : Math.round(value) + '°';
  sub.textContent = sourceLabel;
}

/* ---------------------------------------------------------------------- */
/* Viagens: gravação por GPS + estatísticas                                */
/* ---------------------------------------------------------------------- */
const tripState = { active: false, startedAt: null, route: [], maxSpeed: 0, batteryStart: null, watchId: null };

function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function startTrip() {
  if (tripState.active) return;
  tripState.active = true;
  tripState.startedAt = Date.now();
  tripState.route = [];
  tripState.maxSpeed = 0;
  tripState.batteryStart = state.battery;

  if (navigator.geolocation) {
    tripState.watchId = navigator.geolocation.watchPosition((pos) => {
      const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now() };
      tripState.route.push(pt);
      updateLiveRoute(pt);
    }, (err) => log('GPS: ' + err.message, 'err'), { enableHighAccuracy: true, maximumAge: 2000 });
  } else {
    log('geolocalização não disponível neste navegador — a viagem será gravada sem rota no mapa.', 'err');
  }

  log('🚀 viagem iniciada — gravando rota e estatísticas.', 'sys');
  updateTripButtons();
  renderMapLiveStats();
}

function stopTrip(silent) {
  if (!tripState.active) return;
  tripState.active = false;
  if (tripState.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(tripState.watchId);

  const durationSec = Math.max(1, Math.round((Date.now() - tripState.startedAt) / 1000));
  let distanceKm = 0;
  for (let i = 1; i < tripState.route.length; i++) distanceKm += haversineKm(tripState.route[i - 1], tripState.route[i]);
  if (distanceKm < 0.05 && state.tripDist) distanceKm = state.tripDist; // fallback pro odômetro do patinete

  const batteryStart = tripState.batteryStart;
  const batteryEnd = state.battery;
  const batteryUsedPct = (batteryStart !== null && batteryEnd !== null && batteryStart >= batteryEnd) ? (batteryStart - batteryEnd) : null;
  const avgSpeed = distanceKm / (durationSec / 3600);
  const consumptionKmPerPct = (batteryUsedPct && batteryUsedPct > 0) ? distanceKm / batteryUsedPct : null;

  const trip = {
    id: Date.now(),
    startedAt: tripState.startedAt,
    endedAt: Date.now(),
    durationSec,
    distanceKm: Math.round(distanceKm * 100) / 100,
    avgSpeed: Math.round(avgSpeed * 10) / 10,
    maxSpeed: Math.round(tripState.maxSpeed * 10) / 10,
    batteryStart, batteryEnd, batteryUsedPct,
    consumptionKmPerPct: consumptionKmPerPct ? Math.round(consumptionKmPerPct * 100) / 100 : null,
    route: tripState.route.filter((_, i) => i % 3 === 0), // downsample p/ não pesar o storage
  };

  saveTrip(trip);
  if (!silent) log(`🏁 viagem finalizada — ${trip.distanceKm} km, ${fmtTime(durationSec)}, média ${trip.avgSpeed} km/h.`, 'sys');
  updateTripButtons();
  renderHistorico();
  renderMapLiveStats();
}

function onTripSample() {
  if (!tripState.active) return;
  if (state.speed !== null) tripState.maxSpeed = Math.max(tripState.maxSpeed, state.speed);
}

function updateTripButtons() {
  ['tripRecBtn', 'mapTripRecBtn'].forEach(id => {
    const b = $(id);
    if (!b) return;
    b.textContent = tripState.active ? '⏹ Finalizar viagem' : '● Iniciar viagem';
    b.classList.toggle('recording', tripState.active);
  });
}

function getTrips() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TRIPS)) || []; } catch (e) { return []; }
}
function saveTrip(trip) {
  const trips = getTrips();
  trips.unshift(trip);
  try { localStorage.setItem(STORAGE_KEY_TRIPS, JSON.stringify(trips)); } catch (e) { log('não foi possível salvar a viagem (armazenamento cheio?)', 'err'); }
}
function clearTrips() {
  localStorage.removeItem(STORAGE_KEY_TRIPS);
  renderHistorico();
}

/* ---------------------------------------------------------------------- */
/* Página Histórico                                                       */
/* ---------------------------------------------------------------------- */
function renderHistorico() {
  const trips = getTrips();
  const listEl = $('tripList');
  const summaryEl = $('histSummary');
  if (!listEl) return;

  if (trips.length === 0) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = '<div class="empty-state">Nenhuma viagem registrada ainda.<br>Toque em "Iniciar viagem" no Painel ou no Mapa.</div>';
    return;
  }

  const totalKm = trips.reduce((s, t) => s + t.distanceKm, 0);
  const avgSpeedAll = trips.reduce((s, t) => s + t.avgSpeed, 0) / trips.length;
  const withConsumption = trips.filter(t => t.consumptionKmPerPct);
  const avgConsumption = withConsumption.length ? withConsumption.reduce((s, t) => s + t.consumptionKmPerPct, 0) / withConsumption.length : null;

  summaryEl.innerHTML = `
    <div class="hist-card"><div class="v">${trips.length}</div><div class="l">Viagens</div></div>
    <div class="hist-card"><div class="v">${totalKm.toFixed(1)}<span class="stat-unit">km</span></div><div class="l">Distância total</div></div>
    <div class="hist-card"><div class="v">${avgSpeedAll.toFixed(1)}<span class="stat-unit">km/h</span></div><div class="l">Velocidade média</div></div>
    <div class="hist-card"><div class="v">${avgConsumption ? avgConsumption.toFixed(2) + '<span class="stat-unit">km/%</span>' : '—'}</div><div class="l">Consumo médio</div></div>
  `;

  listEl.innerHTML = trips.map(t => {
    const d = new Date(t.startedAt);
    const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="trip-item" data-id="${t.id}">
        <div class="row1"><span class="date">${dateStr}</span><span class="time">${timeStr} · ${fmtTime(t.durationSec)}</span></div>
        <div class="row2">
          <span><b>${t.distanceKm}</b> km</span>
          <span>méd <b>${t.avgSpeed}</b> km/h</span>
          <span>máx <b>${t.maxSpeed}</b> km/h</span>
          ${t.batteryUsedPct !== null ? `<span>bat <b>-${t.batteryUsedPct}%</b></span>` : ''}
          ${t.consumptionKmPerPct ? `<span><b>${t.consumptionKmPerPct}</b> km/%</span>` : ''}
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.trip-item').forEach(item => {
    item.addEventListener('click', () => {
      const trip = trips.find(t => t.id === Number(item.dataset.id));
      if (trip) { showTripOnMap(trip); goToPage('mapa'); }
    });
  });
}

/* ---------------------------------------------------------------------- */
/* Página Mapa (Leaflet)                                                  */
/* ---------------------------------------------------------------------- */
let map, liveMarker, livePolyline, tripPolylineLayer;

function initMap() {
  if (map || !window.L) return;
  map = L.map('leafletMap', { zoomControl: false, attributionControl: true }).setView([-16.16, -48.28], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 15);
    }, () => {});
  }
}

function updateLiveRoute(pt) {
  if (!map) return;
  const latlng = [pt.lat, pt.lng];
  if (!liveMarker) {
    liveMarker = L.circleMarker(latlng, { radius: 7, color: '#c9ff3d', fillColor: '#c9ff3d', fillOpacity: 1, weight: 2 }).addTo(map);
  } else {
    liveMarker.setLatLng(latlng);
  }
  if (!livePolyline) livePolyline = L.polyline([latlng], { color: '#3dffc9', weight: 4, opacity: 0.85 }).addTo(map);
  else livePolyline.addLatLng(latlng);
  map.panTo(latlng, { animate: true });
}

function showTripOnMap(trip) {
  if (!map) return;
  if (tripPolylineLayer) { map.removeLayer(tripPolylineLayer); tripPolylineLayer = null; }
  if (!trip.route || trip.route.length < 2) { log('essa viagem não tem pontos de rota suficientes pra desenhar.', 'sys'); return; }
  const latlngs = trip.route.map(p => [p.lat, p.lng]);
  tripPolylineLayer = L.polyline(latlngs, { color: '#ffb347', weight: 4, opacity: 0.9 }).addTo(map);
  map.fitBounds(tripPolylineLayer.getBounds(), { padding: [30, 30] });
}

function renderMapLiveStats() {
  const distEl = $('mapDist'), speedEl = $('mapSpeed'), timeEl = $('mapTime');
  if (!distEl) return;
  if (tripState.active) {
    let d = 0;
    for (let i = 1; i < tripState.route.length; i++) d += haversineKm(tripState.route[i - 1], tripState.route[i]);
    distEl.textContent = d.toFixed(2);
    speedEl.textContent = state.speed !== null ? state.speed.toFixed(1) : '—';
    timeEl.textContent = fmtTime(Math.round((Date.now() - tripState.startedAt) / 1000));
  } else {
    distEl.textContent = '—'; speedEl.textContent = '—'; timeEl.textContent = '—:—:—';
  }
}
setInterval(() => { if (tripState.active) renderMapLiveStats(); }, 1000);

/* ---------------------------------------------------------------------- */
/* Navegação entre páginas (SPA)                                          */
/* ---------------------------------------------------------------------- */
function goToPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  if (name === 'mapa') { initMap(); setTimeout(() => map && map.invalidateSize(), 60); }
  if (name === 'historico') renderHistorico();
}

/* ---------------------------------------------------------------------- */
/* Wiring                                                                  */
/* ---------------------------------------------------------------------- */
function wireToggle(id, key) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('click', () => {
    state[key] = state[key] ? 0 : 1;
    renderState();
    sendSetting([key]);
  });
}

function initApp() {
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => goToPage(btn.dataset.page)));

  $('connectBtn').addEventListener('click', () => { if (device && device.gatt.connected) disconnect(); else connect(); });
  $('saveLog').addEventListener('click', downloadLog);
  $('clearLog').addEventListener('click', () => { logEl().innerHTML = ''; logHistory.length = 0; });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = RIDING_MODES.find(m => m.key === btn.dataset.mode);
      if (!m) return;
      state.speedlimit = m.speedlimit; state.mode = m.mode;
      renderState();
      showUnlockBanner('pending', `Enviando speedlimit=${m.speedlimit}, mode=${m.mode}…`);
      sendSetting(['speedlimit', 'mode']);
      if (m.key === 'livre' && autoHoldOnLivre && !holdTimer) {
        log('🔁 modo Livre selecionado — ativando anti-revert automaticamente (o controlador pode reverter o comando sozinho).', 'sys');
        startHold();
      }
    });
  });

  $('unlockBtn').addEventListener('click', () => {
    state.speedlimit = 3; state.lock = 0;
    renderState();
    showUnlockBanner('pending', 'Enviando speedlimit=3, lock=0…');
    sendSetting(['speedlimit', 'lock']);
    if (autoHoldOnLivre && !holdTimer) startHold();
  });

  $('sweepBtn').addEventListener('click', runModeSweep);

  $('tog-autohold').addEventListener('click', () => {
    autoHoldOnLivre = !autoHoldOnLivre;
    localStorage.setItem('scooterble_autohold_livre', autoHoldOnLivre ? '1' : '0');
    $('tog-autohold').classList.toggle('on', autoHoldOnLivre);
  });

  $('holdBtn').addEventListener('click', () => { if (holdTimer) stopHold(); else startHold(); });

  $('pausePollBtn').addEventListener('click', () => {
    pollPaused = !pollPaused;
    if (pollPaused) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      log('⏸ leitura automática pausada.', 'sys');
      $('pausePollBtn').textContent = 'Retomar leitura automática';
      $('pausePollBtn').classList.add('primary');
    } else {
      pollTimer = setInterval(requestStatus, 1500);
      log('▶ leitura automática retomada.', 'sys');
      $('pausePollBtn').textContent = 'Pausar leitura automática';
      $('pausePollBtn').classList.remove('primary');
    }
  });

  wireToggle('tog-kmmph', 'kmMph');
  wireToggle('tog-light', 'light');
  wireToggle('tog-xh', 'xh');
  wireToggle('tog-lock', 'lock');

  document.querySelectorAll('.brake-btn').forEach(btn => {
    btn.addEventListener('click', () => sendExperimentalBrake(Number(btn.dataset.val)));
  });

  ['tripRecBtn', 'mapTripRecBtn'].forEach(id => {
    const b = $(id);
    if (b) b.addEventListener('click', () => { if (tripState.active) stopTrip(); else startTrip(); });
  });

  $('refreshTemp').addEventListener('click', () => refreshAmbientTemp(true));
  $('clearHistBtn').addEventListener('click', () => { if (confirm('Apagar todo o histórico de viagens?')) clearTrips(); });
  $('centerMapBtn').addEventListener('click', () => {
    if (!map || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => map.setView([pos.coords.latitude, pos.coords.longitude], 16));
  });

  if (!navigator.bluetooth) {
    log('Web Bluetooth não disponível neste navegador. Use Chrome/Edge no Android ou desktop.', 'err');
    $('connectBtn').disabled = true;
  }

  renderState();
  renderHistorico();
  renderModeMaxTable();
  $('tog-autohold').classList.toggle('on', autoHoldOnLivre);
  refreshAmbientTemp(true);
  updateTripButtons();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

document.addEventListener('DOMContentLoaded', initApp);
