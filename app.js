/**
 * ============================================================
 * MULTIMILLONARIOS FINANCE — FRONTEND COMPLETO CON OPTIMISTIC UI (app.js)
 * Motor Diario (Vista Micro) + Proyección Mensual (Vista Macro)
 * ============================================================
 */

// ============================================================
// CONFIGURACIÓN DE CONEXIÓN AL BACKEND & SERVICE WORKER
// ============================================================
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbwXrTj_gDl5Pc72Ay6gnWxypF3JJhrZIMk93SMOy7dEnHZG-15kuppMfH1nGmctCpTjBw/exec';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW Error:', err));
}

// ============================================================
// ESTADO GLOBAL Y SINCRONIZACIÓN EN SEGUNDO PLANO
// ============================================================

const appState = {
  activeUser: 'Brian',
  currentView: 'micro',
  homeBankingTotal: 0,
  bolsaTotal: 0,
  diaCobro: null,
  diasRestantes: [],
  movimientos: [],
  lastProcessedDate: null,
  
  currentMacroYear: new Date().getFullYear(),
  currentMacroMonth: new Date().getMonth(),
  macroData: null
};

let txModalSubtype = 'single';
let editingMovimientoId = null;
let cierreDiaPendiente = null;
let limpiarColaCandidatos = [];

let hbModalState = { hb: 0, objetivo: 0, bolsa: 0, diasCount: 0, lastEdited: 'objetivo' };
let macroDraft = null;
let currentEditingValueTarget = null;
let currentEditingServiceId = null;
let currentEditingFixedExpenseId = null;
let currentEditingFixedExpenseUser = 'Brian';
let pendingSyncCount = 0;

// ============================================================
// CLIENTE DE API (Apps Script) & BACKGROUND SYNC SEGURO
// ============================================================

async function callBackend(action, payload) {
  const res = await fetch(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload || {} })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Error HTTP ' + res.status + ': ' + text.substring(0, 100));
  }
  
  const contentType = res.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    throw new Error('Respuesta no JSON del servidor. Puede ser un error de permisos en Apps Script.');
  }

  const json = await res.json();
  if (!json.ok) throw new Error(json.error || ('Error en ' + action));
  return json.data;
}

async function callBackendConSync(action, payload) {
  mostrarSyncToast_();
  try {
    return await callBackend(action, payload);
  } finally {
    ocultarSyncToast_();
  }
}

async function callBackendBackground(action, payload) {
  pendingSyncCount++;
  mostrarSyncToast_();
  try {
    const res = await callBackend(action, payload);
    return res;
  } catch (err) {
    console.error('Error en sync background (' + action + '):', err);
    alert('Error de sincronización con la base de datos: ' + err.message);
    if (appState.currentView === 'macro') recargarEstadoMensual_();
    else recargarEstadoDiario_(false);
    throw err;
  } finally {
    pendingSyncCount--;
    if (pendingSyncCount <= 0) {
      pendingSyncCount = 0;
      ocultarSyncToast_();
    }
  }
}

function mostrarSyncToast_() {
  const el = document.getElementById('sync-toast');
  if (el) el.classList.add('active');
}

function ocultarSyncToast_() {
  if (pendingSyncCount > 0) return;
  const el = document.getElementById('sync-toast');
  if (el) el.classList.remove('active');
}

// ============================================================
// FORMATEADOR DE MONEDA Y MANEJO DE INPUTS
// ============================================================

const moneyStates = {};

function renderMoneyInput(id) {
  const el = document.getElementById(id);
  const st = moneyStates[id];
  if (!el || !st) return;
  if (st.int === '' && !st.isDec) { el.value = ''; return; }
  const displayInt = st.int.replace(/^0+/, '') || '0';
  const formattedInt = displayInt.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  el.value = st.isDec ? (formattedInt + ',' + st.dec) : formattedInt;
  if (typeof el.selectionStart === 'number') el.selectionStart = el.selectionEnd = el.value.length;
}

function getMoneyValue(id) {
  const st = moneyStates[id];
  if (!st) return 0;
  return parseFloat((st.int || '0') + '.' + (st.dec || '').padEnd(2, '0')) || 0;
}

function setMoneyValue(id, num) {
  if (!moneyStates[id]) moneyStates[id] = { int: '', dec: '', isDec: false };
  const totalStr = Math.max(Number(num) || 0, 0).toFixed(2);
  const parts = totalStr.split('.');
  moneyStates[id].int = parts[0];
  moneyStates[id].dec = parts[1];
  moneyStates[id].isDec = true;
  renderMoneyInput(id);
}

function attachMoneyInput(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!moneyStates[id]) moneyStates[id] = { int: '', dec: '', isDec: false, onChange: null };
  moneyStates[id].onChange = onChange;

  if (el.dataset.moneyAttached === 'true') return;
  el.dataset.moneyAttached = 'true';

  el.addEventListener('focus', () => { if (el.select) el.select(); });

  el.addEventListener('beforeinput', (e) => {
    const st = moneyStates[id];
    const isAllSelected = typeof el.selectionStart === 'number' &&
      el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0;

    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward' || e.inputType === 'deleteByCut') {
      e.preventDefault();
      if (isAllSelected || e.inputType === 'deleteByCut') {
        st.int = ''; st.dec = ''; st.isDec = false;
      } else if (st.isDec) {
        if (st.dec.length > 0) st.dec = st.dec.slice(0, -1); else st.isDec = false;
      } else {
        st.int = st.int.slice(0, -1);
      }
      renderMoneyInput(id); if (st.onChange) st.onChange(id);
      return;
    }

    if (e.data === ',' || e.data === '.') {
      e.preventDefault();
      if (!st.isDec) { if (st.int === '') st.int = '0'; st.isDec = true; }
      renderMoneyInput(id);
      return;
    }

    if (e.data && /^[0-9]$/.test(e.data)) {
      e.preventDefault();
      if (isAllSelected) { st.int = ''; st.dec = ''; st.isDec = false; }
      if (st.isDec) { if (st.dec.length < 2) st.dec += e.data; }
      else { if (st.int.length < 10) st.int += e.data; }
      renderMoneyInput(id); if (st.onChange) st.onChange(id);
      return;
    }

    e.preventDefault();
  });
}

// ============================================================
// UTILIDADES DE FECHA Y FORMATO
// ============================================================

function normalizarFechas_(fechas) {
  if (Array.isArray(fechas)) return fechas;
  if (typeof fechas === 'string') {
    try {
      const parsed = JSON.parse(fechas);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {}
    if (fechas.trim()) return [fechas.trim()];
  }
  return [];
}

function formatearMoneda_(n) {
  const num = Number(n) || 0;
  return '$ ' + num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatearFechaISOLocal_(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function hoyISO_() {
  return formatearFechaISOLocal_(new Date());
}

function sumarDiasLocal_(fecha, dias) {
  const f = new Date(fecha.getTime());
  f.setDate(f.getDate() + dias);
  return f;
}

function formatearFechaLegible_(iso) {
  if (!iso) return '--';
  const partes = iso.split('-').map(Number);
  const f = new Date(partes[0], partes[1] - 1, partes[2]);
  return f.toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
}

function capitalizeInput(el) {
  if (el.value.length === 1) el.value = el.value.toUpperCase();
}

function handleOverlayClick(event) {
  if (event.target === event.currentTarget) {
    event.currentTarget.classList.remove('active');
  }
}

// ============================================================
// HEADER, NAVEGACIÓN Y DOCK FLOTANTE
// ============================================================

function cargarUsuarioYColorLocal_() {
  appState.activeUser = localStorage.getItem('userActive') || 'Brian';
  const colorLocal = localStorage.getItem('accentColor_' + appState.activeUser) || '#18181b';
  document.documentElement.style.setProperty('--accent-color', colorLocal);
  pintarBotonesUsuario_();
}

function pintarBotonesUsuario_() {
  const brianBtn = document.getElementById('user-btn-brian');
  const virginiaBtn = document.getElementById('user-btn-virginia');
  if (!brianBtn || !virginiaBtn) return;
  const activo = appState.activeUser === 'Brian' ? brianBtn : virginiaBtn;
  const inactivo = appState.activeUser === 'Brian' ? virginiaBtn : brianBtn;

  activo.classList.add('bg-zinc-900', 'text-white', 'shadow-sm');
  activo.classList.remove('text-zinc-500', 'hover:text-zinc-900');
  inactivo.classList.remove('bg-zinc-900', 'text-white', 'shadow-sm');
  inactivo.classList.add('text-zinc-500', 'hover:text-zinc-900');
}

function setActiveUser(user) {
  appState.activeUser = user;
  localStorage.setItem('userActive', user);
  pintarBotonesUsuario_();
  const color = localStorage.getItem('accentColor_' + user) || '#18181b';
  document.documentElement.style.setProperty('--accent-color', color);
  const label = document.getElementById('modal-user-label');
  if (label) label.textContent = user;
  
  if (appState.currentView === 'micro') {
    renderMicroView();
  } else {
    renderMacroView();
  }
}

async function setAccent(color) {
  document.documentElement.style.setProperty('--accent-color', color);
  localStorage.setItem('accentColor_' + appState.activeUser, color);
  const cambios = {};
  cambios['accentColor' + appState.activeUser] = color;
  callBackendBackground('actualizarConfig', cambios);
}

function switchView(view) {
  appState.currentView = view;
  const viewMicro = document.getElementById('view-micro');
  const viewMacro = document.getElementById('view-macro');
  const btnMicro = document.getElementById('dock-btn-micro');
  const btnMacro = document.getElementById('dock-btn-macro');
  const indicator = document.getElementById('dock-indicator');

  if (view === 'micro') {
    viewMicro.classList.remove('hidden');
    viewMacro.classList.add('hidden');
    btnMicro.classList.add('active', 'font-bold');
    btnMicro.classList.remove('font-medium');
    btnMacro.classList.remove('active', 'font-bold');
    btnMacro.classList.add('font-medium');
    if (indicator) {
      indicator.style.left = '6px';
      indicator.style.width = (btnMicro.offsetWidth + 8) + 'px';
    }
    renderMicroView();
  } else {
    viewMacro.classList.remove('hidden');
    viewMicro.classList.add('hidden');
    btnMacro.classList.add('active', 'font-bold');
    btnMacro.classList.remove('font-medium');
    btnMicro.classList.remove('active', 'font-bold');
    btnMicro.classList.add('font-medium');
    if (indicator && btnMacro) {
      indicator.style.left = (btnMacro.offsetLeft - 4) + 'px';
      indicator.style.width = (btnMacro.offsetWidth + 8) + 'px';
    }
    recargarEstadoMensual_();
  }
}

function handleDockAdd() {
  if (appState.currentView === 'micro') {
    toggleModal(true);
  } else {
    toggleQuickAddModal(true);
  }
}

// ============================================================
// VISTA MICRO (MOTOR DIARIO)
// ============================================================

function calcularComposicion_() {
  const dias = appState.diasRestantes;
  const liquidHB = appState.homeBankingTotal - appState.bolsaTotal;
  const gastosPorFecha = {};
  dias.forEach(f => { gastosPorFecha[f] = 0; });

  let gastosEnPeriodo = 0;
  appState.movimientos.forEach(m => {
    if (m.fromBag) return;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    fechas.forEach(f => {
      if (Object.prototype.hasOwnProperty.call(gastosPorFecha, f)) {
        gastosPorFecha[f] += m.montoPorFecha;
        gastosEnPeriodo += m.montoPorFecha;
      }
    });
  });

  let objetivoBase = dias.length > 0 ? ((liquidHB + gastosEnPeriodo) / dias.length) : 0;
  objetivoBase = Math.round(objetivoBase * 100) / 100;
  
  return { objetivoBase: objetivoBase, gastosPorFecha: gastosPorFecha };
}

function presupuestoParaFecha_(fechaISO) {
  const comp = calcularComposicion_();
  return comp.objetivoBase - (comp.gastosPorFecha[fechaISO] || 0);
}

function renderMicroView() {
  const hbEl = document.getElementById('hb-total-display');
  const bolsaEl = document.getElementById('savings-bag-display');
  if (hbEl) hbEl.textContent = formatearMoneda_(appState.homeBankingTotal);
  if (bolsaEl) bolsaEl.textContent = formatearMoneda_(appState.bolsaTotal);

  const hoyStr = hoyISO_();
  const mananaStr = formatearFechaISOLocal_(sumarDiasLocal_(new Date(), 1));

  const presupuestoHoy = presupuestoParaFecha_(hoyStr);
  const presupuestoManana = presupuestoParaFecha_(mananaStr);

  const hoyEl = document.getElementById('today-budget-display');
  const mananaEl = document.getElementById('tomorrow-budget-display');
  const diasLabel = document.getElementById('days-remaining-label');
  if (hoyEl) hoyEl.textContent = formatearMoneda_(presupuestoHoy);
  if (mananaEl) mananaEl.textContent = formatearMoneda_(presupuestoManana);
  if (diasLabel) {
    diasLabel.textContent = 'Días restantes hasta cobro: ' + appState.diasRestantes.length +
      ' (cobrás el ' + formatearFechaLegible_(appState.diaCobro) + ')';
  }

  renderTransactionList_();
}

function renderTransactionList_() {
  const cont = document.getElementById('transaction-list');
  if (!cont) return;
  const hoyStr = hoyISO_();
  const diasPeriodo = appState.diasRestantes || [];

  const delPeriodo = appState.movimientos.filter(m => {
    const fechas = normalizarFechas_(m.fechasAfectadas);
    return fechas.some(f => diasPeriodo.includes(f) || f >= hoyStr);
  });

  if (!delPeriodo.length) {
    cont.innerHTML = '<p class="text-[11px] text-zinc-400 text-center py-3">Sin movimientos registrados</p>';
    return;
  }

  cont.innerHTML = delPeriodo.map(m => {
    const titulo = m.descripcion || (m.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único');
    const fechas = normalizarFechas_(m.fechasAfectadas);
    
    let textoFechas = '';
    if (fechas.length === 1 && fechas[0] === hoyStr) {
      textoFechas = 'Hoy';
    } else {
      textoFechas = fechas.map(f => {
        const p = f.split('-').map(Number);
        return p[2] + '/' + p[1];
      }).join(', ');
    }

    const sub = m.usuario + ' · ' + textoFechas + (m.fromBag ? ' · de la Bolsa' : '');
    return '<button onclick="toggleModal(true, \'' + m.id + '\')" class="bento-card w-full p-3 flex items-center justify-between text-left hover:bg-zinc-50 transition-colors">' +
      '<div><p class="text-xs font-semibold text-zinc-800">' + titulo + '</p>' +
      '<p class="text-[10px] text-zinc-400">' + sub + '</p></div>' +
      '<span class="text-xs font-bold text-zinc-900">' + formatearMoneda_(m.monto) + '</span></button>';
  }).join('');
}

// ============================================================
// MODAL "ACTUALIZAR HOME BANKING" Y SIMULADOR
// ============================================================

function toggleHbModal(show) {
  if (show) prepararHbModal_();
  document.getElementById('hb-modal').classList.toggle('active', show);
}

function prepararHbModal_() {
  const comp = calcularComposicion_();
  hbModalState = {
    hb: appState.homeBankingTotal,
    objetivo: Math.round(comp.objetivoBase),
    bolsa: appState.bolsaTotal,
    diasCount: appState.diasRestantes.length,
    lastEdited: 'objetivo'
  };

  const diasLabel = document.getElementById('hb-days-label');
  if (diasLabel) diasLabel.textContent = hbModalState.diasCount + ' días hasta el próximo cobro';

  setMoneyValue('hb-update-amount', hbModalState.hb);
  setMoneyValue('hb-objetivo-input', hbModalState.objetivo);
  setMoneyValue('hb-bolsa-input', hbModalState.bolsa);
  renderHbModal_();
}

function recomputeHbModal_(origen) {
  const dias = hbModalState.diasCount || 1;
  if (origen === 'objetivo') {
    hbModalState.bolsa = hbModalState.hb - (hbModalState.objetivo * dias);
  } else if (origen === 'bolsa') {
    hbModalState.objetivo = (hbModalState.hb - hbModalState.bolsa) / dias;
  } else if (hbModalState.lastEdited === 'objetivo') {
    hbModalState.bolsa = hbModalState.hb - (hbModalState.objetivo * dias);
  } else {
    hbModalState.objetivo = (hbModalState.hb - hbModalState.bolsa) / dias;
  }
  renderHbModal_();
}

function renderHbModal_() {
  const hintObjetivo = document.getElementById('hb-hint-objetivo');
  const hintBolsa = document.getElementById('hb-hint-bolsa');
  if (hintObjetivo) {
    hintObjetivo.innerHTML = hbModalState.lastEdited === 'bolsa'
      ? '↳ con esta Bolsa, el objetivo queda en <b class="text-[13px] font-bold text-zinc-700">' + formatearMoneda_(hbModalState.objetivo) + '/día</b>'
      : '';
  }
  if (hintBolsa) {
    hintBolsa.innerHTML = hbModalState.lastEdited === 'objetivo'
      ? '↳ con este objetivo, la Bolsa quedaría en <b class="text-[13px] font-bold text-zinc-700">' + formatearMoneda_(hbModalState.bolsa) + '</b>'
      : '';
  }

  const warnEl = document.getElementById('hb-warn-banner');
  const guardarBtn = document.getElementById('btn-guardar-hb');
  if (!warnEl || !guardarBtn) return;

  if (hbModalState.bolsa < 0) {
    const maxObjetivo = hbModalState.hb / (hbModalState.diasCount || 1);
    warnEl.textContent = 'Con este objetivo no alcanza — la Bolsa quedaría en ' +
      formatearMoneda_(hbModalState.bolsa) + '. El máximo sostenible ronda ' +
      formatearMoneda_(maxObjetivo) + '/día.';
    warnEl.classList.remove('hidden');
    guardarBtn.setAttribute('disabled', 'true');
  } else {
    warnEl.classList.add('hidden');
    guardarBtn.removeAttribute('disabled');
  }
}

attachMoneyInput('hb-update-amount', (id) => { hbModalState.hb = getMoneyValue(id); recomputeHbModal_(); });
attachMoneyInput('hb-objetivo-input', (id) => { hbModalState.lastEdited = 'objetivo'; hbModalState.objetivo = getMoneyValue(id); recomputeHbModal_('objetivo'); });
attachMoneyInput('hb-bolsa-input', (id) => { hbModalState.lastEdited = 'bolsa'; hbModalState.bolsa = getMoneyValue(id); recomputeHbModal_('bolsa'); });
attachMoneyInput('tx-amount', () => {});

async function saveHbAmount() {
  if (hbModalState.bolsa < 0) return;
  toggleHbModal(false);
  
  appState.homeBankingTotal = hbModalState.hb;
  appState.bolsaTotal = hbModalState.bolsa;
  renderMicroView();

  callBackendBackground('actualizarHB', {
    homeBankingTotal: hbModalState.hb,
    bolsaTotal: hbModalState.bolsa
  });
}

// ============================================================
// "LIMPIAR MOVIMIENTOS PENDIENTES"
// ============================================================

async function handleLimpiarPendientes() {
  toggleHbModal(false);
  mostrarSyncToast_();
  try {
    const resultado = await callBackend('limpiarMovimientosPendientes', {});
    await recargarEstadoDiario_(false);
    limpiarColaCandidatos = (resultado.candidatos || []).slice();
    procesarSiguienteCandidato_();
  } catch (e) {
    alert('Error al limpiar movimientos: ' + e.message);
  } finally {
    ocultarSyncToast_();
  }
}

function procesarSiguienteCandidato_() {
  if (!limpiarColaCandidatos.length) {
    const comp = calcularComposicion_();
    hbModalState.hb = appState.homeBankingTotal;
    hbModalState.bolsa = appState.bolsaTotal;
    hbModalState.objetivo = Math.round(comp.objetivoBase);
    hbModalState.diasCount = appState.diasRestantes.length;
    setMoneyValue('hb-objetivo-input', hbModalState.objetivo);
    setMoneyValue('hb-bolsa-input', hbModalState.bolsa);
    recomputeHbModal_();
    return;
  }
  const candidato = limpiarColaCandidatos[0];
  const desc = document.getElementById('limpiar-candidato-desc');
  if (desc) {
    desc.textContent = (candidato.descripcion || 'Gasto divisible') + ' — ' +
      formatearMoneda_(candidato.monto) + ' en total';
  }
  document.getElementById('limpiar-candidato-modal').classList.add('active');
}

async function resolverCandidatoLimpiar(accion) {
  const candidato = limpiarColaCandidatos.shift();
  document.getElementById('limpiar-candidato-modal').classList.remove('active');

  mostrarSyncToast_();
  try {
    let res;
    if (accion === 'borrar') {
      res = await callBackend('eliminarMovimiento', { id: candidato.id });
    } else if (accion === 'single') {
      res = await callBackend('guardarMovimiento', {
        id: candidato.id,
        tipo: 'single',
        fechasAfectadas: [hoyISO_()],
        monto: candidato.montoPorFecha,
        descripcion: candidato.descripcion,
        usuario: candidato.usuario,
        fromBag: candidato.fromBag
      });
    }

    appState.movimientos = appState.movimientos.filter(m => String(m.id) !== String(candidato.id));
    if (res && res.movimiento) appState.movimientos.push(res.movimiento);
    if (res && res.homeBankingTotal !== undefined) {
      appState.homeBankingTotal = res.homeBankingTotal;
      appState.bolsaTotal = res.bolsaTotal;
    }
    renderMicroView();
  } catch (e) {
    alert('Error al procesar candidato: ' + e.message);
  } finally {
    ocultarSyncToast_();
    procesarSiguienteCandidato_();
  }
}

// ============================================================
// CIERRE DE DÍA
// ============================================================

function mostrarModalCierreDia_(info) {
  const esDeficit = info.tipo === 'deficit';
  document.getElementById('day-change-title').textContent = esDeficit ? '📉 Día anterior en rojo' : '☀️ ¡Nuevo Día Detectado!';
  document.getElementById('day-change-desc').innerHTML = esDeficit
    ? 'Ayer te pasaste por <strong class="text-zinc-800">' + formatearMoneda_(info.monto) + '</strong>. ¿Cómo lo cubrimos?'
    : 'Ayer te sobraron <strong class="text-zinc-800">' + formatearMoneda_(info.monto) + '</strong>. ¿Qué hacemos?';
  document.getElementById('day-change-btn-bag').textContent = esDeficit ? 'Descontar de la Bolsa' : 'Mover a la Bolsa de Ahorro';
  document.getElementById('day-change-btn-distribute').textContent = 'Repartir entre los días que quedan';
  document.getElementById('day-change-modal').classList.add('active');
}

async function resolveDayChange(decision) {
  const info = cierreDiaPendiente;
  if (!info) return;
  document.getElementById('day-change-modal').classList.remove('active');

  mostrarSyncToast_();
  try {
    const resultado = await callBackend('resolverCierreDia', {
      decision: decision === 'bag' ? 'bolsa' : 'redistribuir'
    });

    appState.bolsaTotal = resultado.bolsaTotal;
    appState.lastProcessedDate = resultado.lastProcessedDate;
    cierreDiaPendiente = null;
    renderMicroView();
  } catch (e) {
    alert('Error al cerrar día: ' + e.message);
  } finally {
    ocultarSyncToast_();
  }
}

// ============================================================
// MODAL "REGISTRAR MOVIMIENTO" (ÚNICO / DIVISIBLE)
// ============================================================

function setTxSubtype(tipo) {
  txModalSubtype = tipo;

  const tabSingle = document.getElementById('tab-single');
  const tabDivisible = document.getElementById('tab-divisible');
  [['single', tabSingle], ['divisible', tabDivisible]].forEach(([t, btn]) => {
    const activo = t === tipo;
    btn.classList.toggle('bg-white', activo);
    btn.classList.toggle('text-zinc-900', activo);
    btn.classList.toggle('shadow-sm', activo);
    btn.classList.toggle('text-zinc-500', !activo);
  });

  document.getElementById('tx-assigned-date-container').classList.toggle('hidden', tipo === 'divisible');
  document.getElementById('divisible-options').classList.toggle('hidden', tipo !== 'divisible');
}

function handleBagCheckbox(el) {
  if (el.checked && txModalSubtype === 'divisible') {
    setTxSubtype('single');
    const fechaEl = document.getElementById('tx-assigned-date');
    fechaEl.value = hoyISO_();
    fechaEl.setAttribute('disabled', 'true');
  }
}

function resetTxForm_() {
  document.getElementById('tx-form').reset();
  const fechaEl = document.getElementById('tx-assigned-date');
  fechaEl.removeAttribute('disabled');
  fechaEl.value = hoyISO_();
  setMoneyValue('tx-amount', 0);
  setTxSubtype('single');
  editingMovimientoId = null;
  document.getElementById('btn-delete-tx').classList.add('hidden');
}

function resetCurrentTabOnly() {
  document.getElementById('tx-desc').value = '';
  setMoneyValue('tx-amount', 0);
  document.getElementById('tx-assigned-date').value = hoyISO_();
  document.getElementById('chk-from-bag').checked = false;
  document.getElementById('tx-days-count').value = '';
  document.getElementById('tx-divisible-start-date').value = '';
  document.getElementById('tx-custom-days').value = '';
}

function toggleModal(show, movimientoId) {
  if (show) {
    if (movimientoId) {
      prepararTxModalEdicion_(movimientoId);
    } else {
      resetTxForm_();
    }
    const label = document.getElementById('modal-user-label');
    if (label) label.textContent = appState.activeUser;
  }
  document.getElementById('tx-modal').classList.toggle('active', show);
}

function prepararTxModalEdicion_(movimientoId) {
  const m = appState.movimientos.find(x => String(x.id).trim() === String(movimientoId).trim());
  if (!m) { resetTxForm_(); return; }
  editingMovimientoId = m.id;
  setTxSubtype(m.tipo);
  setMoneyValue('tx-amount', m.monto);
  document.getElementById('tx-desc').value = m.descripcion || '';

  const fechas = normalizarFechas_(m.fechasAfectadas);
  document.getElementById('tx-assigned-date').value = fechas[0] || hoyISO_();

  if (m.tipo === 'divisible') {
    document.getElementById('tx-days-count').value = fechas.length || '';
    document.getElementById('tx-divisible-start-date').value = fechas[0] || hoyISO_();
    const customDaysStr = fechas.map(f => {
      const p = f.split('-').map(Number);
      return p[2];
    }).join(', ');
    document.getElementById('tx-custom-days').value = customDaysStr;
  }

  document.getElementById('chk-from-bag').checked = !!m.fromBag;
  document.getElementById('btn-delete-tx').classList.remove('hidden');
}

async function handleFormSubmit() {
  const monto = getMoneyValue('tx-amount');
  if (!monto || monto <= 0) { alert('Ingresá un monto válido'); return; }

  const descripcion = document.getElementById('tx-desc').value.trim();
  const fromBag = document.getElementById('chk-from-bag').checked;
  let fechasAfectadas = [];

  try {
    if (txModalSubtype === 'single') {
      const fecha = document.getElementById('tx-assigned-date').value || hoyISO_();
      fechasAfectadas = [fecha];
    } else {
      const diasCount = parseInt(document.getElementById('tx-days-count').value, 10);
      const fechaInicio = document.getElementById('tx-divisible-start-date').value;
      const customDaysRaw = document.getElementById('tx-custom-days').value.trim();

      if (customDaysRaw) {
        const base = fechaInicio ? new Date(fechaInicio + 'T00:00:00') : new Date();
        let currentMonth = base.getMonth();
        let currentYear = base.getFullYear();
        let lastDay = 0;

        const rawDays = customDaysRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(dia => !isNaN(dia));

        fechasAfectadas = rawDays.map(dia => {
          if (dia < 1 || dia > 31) throw new Error(`El día ${dia} es inválido. Debe estar entre 1 y 31.`);

          if (dia < lastDay || (lastDay === 0 && dia < base.getDate())) {
            currentMonth++;
            if (currentMonth > 11) {
              currentMonth = 0;
              currentYear++;
            }
          }

          const maxDays = new Date(currentYear, currentMonth + 1, 0).getDate();
          if (dia > maxDays) throw new Error(`El mes ${currentMonth + 1} no tiene ${dia} días.`);

          lastDay = dia;
          return formatearFechaISOLocal_(new Date(currentYear, currentMonth, dia));
        });
      } else if (diasCount && fechaInicio) {
        const base = new Date(fechaInicio + 'T00:00:00');
        for (let i = 0; i < diasCount; i++) {
          fechasAfectadas.push(formatearFechaISOLocal_(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
        }
      } else {
        fechasAfectadas = appState.diasRestantes.slice();
      }
    }
  } catch (err) {
    alert(err.message);
    return;
  }

  if (!fechasAfectadas.length) { alert('Faltan fechas para este gasto'); return; }

  toggleModal(false);
  
  const idMov = editingMovimientoId || ('tx_' + Date.now());
  const nuevoMov = {
    id: idMov,
    tipo: txModalSubtype,
    fechasAfectadas: fechasAfectadas,
    monto: monto,
    montoPorFecha: Math.round((monto / fechasAfectadas.length) * 100) / 100,
    descripcion: descripcion,
    usuario: appState.activeUser,
    fromBag: fromBag
  };

  const idx = appState.movimientos.findIndex(x => String(x.id) === String(idMov));
  if (idx !== -1) {
    const movAnterior = appState.movimientos[idx];
    appState.homeBankingTotal += movAnterior.monto;
    if (movAnterior.fromBag) appState.bolsaTotal += movAnterior.monto;
    appState.movimientos[idx] = nuevoMov;
  } else {
    appState.movimientos.push(nuevoMov);
  }

  appState.homeBankingTotal -= monto;
  if (fromBag) appState.bolsaTotal -= monto;

  renderMicroView();

  callBackendBackground('guardarMovimiento', {
    id: editingMovimientoId,
    tipo: txModalSubtype,
    fechasAfectadas: fechasAfectadas,
    monto: monto,
    descripcion: descripcion,
    usuario: appState.activeUser,
    fromBag: fromBag
  }).then(res => {
    if (res && res.movimiento && !editingMovimientoId) {
      const idx = appState.movimientos.findIndex(x => String(x.id) === String(idMov));
      if (idx !== -1) appState.movimientos[idx].id = res.movimiento.id;
    }
    if (res && res.homeBankingTotal !== undefined) {
      appState.homeBankingTotal = res.homeBankingTotal;
      appState.bolsaTotal = res.bolsaTotal;
      renderMicroView();
    }
  });
}

async function deleteCurrentEditingTransaction() {
  if (!editingMovimientoId) return;
  toggleModal(false);
  
  const movExistente = appState.movimientos.find(x => String(x.id) === String(editingMovimientoId));
  if (movExistente) {
    appState.homeBankingTotal += movExistente.monto;
    if (movExistente.fromBag) appState.bolsaTotal += movExistente.monto;
    appState.movimientos = appState.movimientos.filter(x => String(x.id) !== String(editingMovimientoId));
    renderMicroView();
  }

  callBackendBackground('eliminarMovimiento', { id: editingMovimientoId }).then(res => {
    if (res && res.homeBankingTotal !== undefined) {
      appState.homeBankingTotal = res.homeBankingTotal;
      appState.bolsaTotal = res.bolsaTotal;
      renderMicroView();
    }
  });
}

// ============================================================
// AUDITORÍA Y FUTUROS DÍAS (DIARIO)
// ============================================================

async function triggerSyncReload() {
  mostrarSyncToast_();
  try {
    await recargarEstadoDiario_(false);
  } catch (e) {
    alert('Error de sincronización: ' + e.message);
  } finally {
    ocultarSyncToast_();
  }
}

function openBudgetAuditModal(targetDay) {
  const fecha = targetDay === 'tomorrow' ? formatearFechaISOLocal_(sumarDiasLocal_(new Date(), 1)) : hoyISO_();
  const comp = calcularComposicion_();
  const gastoDelDia = comp.gastosPorFecha[fecha] || 0;
  const disponible = comp.objetivoBase - gastoDelDia;

  document.getElementById('audit-title').textContent = targetDay === 'tomorrow' ? 'Presupuesto de Mañana' : 'Presupuesto de Hoy';
  document.getElementById('audit-subtitle').textContent = formatearFechaLegible_(fecha);

  const movimientosDelDia = appState.movimientos.filter(m => {
    if (m.fromBag) return false;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    return fechas.includes(fecha);
  });

  let html = '<div class="flex justify-between items-center p-2.5 bg-blue-50/60 rounded-xl border border-blue-100">' +
    '<div><p class="font-bold text-blue-900">Objetivo Diario</p>' +
    '<p class="text-[9px] text-blue-700/80 font-medium">(HB − Bolsa + gastos del período) ÷ ' + appState.diasRestantes.length + ' días</p></div>' +
    '<span class="font-black text-blue-950">+' + formatearMoneda_(comp.objetivoBase) + '</span></div>';

  if (movimientosDelDia.length) {
    html += movimientosDelDia.map(m => (
      '<div class="flex justify-between items-center p-2.5 bg-rose-50/60 rounded-xl border border-rose-100 cursor-pointer hover:bg-rose-100/80 transition-colors" onclick="toggleBudgetAuditModal(false); toggleModal(true, \'' + m.id + '\')">' +
      '<div><p class="font-bold text-rose-900">' + (m.descripcion || (m.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único')) + '</p>' +
      '<p class="text-[9px] text-rose-700/80 font-medium">' + m.usuario + '</p></div>' +
      '<span class="font-black text-rose-950">-' + formatearMoneda_(m.montoPorFecha) + '</span></div>'
    )).join('');
  } else {
    html += '<p class="text-[10px] text-zinc-400 text-center py-1">Sin egresos descontados del presupuesto asignado</p>';
  }

  document.getElementById('audit-content-list').innerHTML = html;
  document.getElementById('audit-total-display').textContent = formatearMoneda_(disponible);
  document.getElementById('budget-audit-modal').classList.add('active');
}

function toggleBudgetAuditModal(show) {
  document.getElementById('budget-audit-modal').classList.toggle('active', show);
}

function toggleFutureDaysModal(show) {
  if (show) renderFutureDaysList_();
  document.getElementById('future-days-modal').classList.toggle('active', show);
}

function renderFutureDaysList_() {
  const cont = document.getElementById('future-days-list');
  if (!cont) return;
  const comp = calcularComposicion_();
  const hoyStr = hoyISO_();
  const futuros = appState.diasRestantes.filter(f => f > hoyStr);

  if (!futuros.length) {
    cont.innerHTML = '<p class="text-[11px] text-zinc-400 text-center py-2">No quedan más días en este período</p>';
    return;
  }

  cont.innerHTML = futuros.map(fecha => {
    const gasto = comp.gastosPorFecha[fecha] || 0;
    const disponible = comp.objetivoBase - gasto;
    const movs = appState.movimientos.filter(m => {
      if (m.fromBag) return false;
      const fechas = normalizarFechas_(m.fechasAfectadas);
      return fechas.includes(fecha);
    });
    let detalle = '';
    if (movs.length) {
      detalle = '<div class="mt-1 pt-1 border-t border-zinc-200/60 space-y-1">' +
        movs.map(m => '<button onclick="event.stopPropagation(); toggleFutureDaysModal(false); toggleModal(true, \'' + m.id + '\')" class="w-full flex justify-between text-[10px] text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 p-1 rounded transition-colors text-left"><span>• ' +
          (m.descripcion || 'Gasto') + '</span><span class="font-semibold">-' + formatearMoneda_(m.montoPorFecha) + '</span></button>').join('') +
        '</div>';
    }
    return '<div class="p-2.5 bg-zinc-50 rounded-xl border border-zinc-200/60 space-y-1">' +
      '<div class="flex justify-between items-center">' +
      '<div><span class="font-bold text-zinc-800 capitalize text-xs block">' + formatearFechaLegible_(fecha) + '</span>' +
      '<span class="text-[9px] text-zinc-400 font-medium">' + (gasto > 0 ? 'Gastado: ' + formatearMoneda_(gasto) : 'Sin consumos asignados') + '</span></div>' +
      '<span class="font-black text-xs text-zinc-900">' + formatearMoneda_(disponible) + '</span></div>' + detalle + '</div>';
  }).join('');
}

// ============================================================
// VISTA MACRO (PROYECCIÓN MENSUAL & UI OPTIMISTA)
// ============================================================

const NOMBRES_MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

async function recargarEstadoMensual_() {
  mostrarSyncToast_();
  try {
    const data = await callBackend('getEstadoMensual', {
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth
    });
    appState.macroData = data;
    renderMacroView();
  } catch (e) {
    alert('Error al cargar la proyección mensual: ' + e.message);
  } finally {
    ocultarSyncToast_();
  }
}

function changeMonth(delta) {
  let m = appState.currentMacroMonth + delta;
  let y = appState.currentMacroYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  appState.currentMacroMonth = m;
  appState.currentMacroYear = y;
  recargarEstadoMensual_();
}

function renderMacroView() {
  const data = appState.macroData;
  if (!data) return;

  const monthDisplay = document.getElementById('current-month-display');
  if (monthDisplay) {
    monthDisplay.textContent = NOMBRES_MESES[data.month] + ' ' + data.year;
  }

  const esSacMonth = (data.month === 5 || data.month === 11);
  const esPrizeMonth = (data.month === 1 || data.month === 4 || data.month === 7 || data.month === 10);

  const sacBadge = document.getElementById('sac-badge');
  const prizeBadge = document.getElementById('prize-badge');
  const sacCard = document.getElementById('view-macro-sac-card');
  const prizeCard = document.getElementById('view-macro-prize-card');
  const prizeLabel = document.getElementById('macro-prize-label');

  if (sacBadge) sacBadge.classList.toggle('hidden', !esSacMonth);
  if (sacCard) sacCard.classList.toggle('hidden', !esSacMonth);

  if (prizeCard) prizeCard.classList.remove('hidden');
  if (prizeLabel) {
    prizeLabel.textContent = esPrizeMonth ? '✦ PREMIO VARIABLE Y AJUSTES' : '✦ AJUSTE DE SUELDO';
  }
  if (prizeBadge) {
    prizeBadge.textContent = esPrizeMonth ? 'Mes con Premio' : 'Ajuste de Sueldo';
    prizeBadge.classList.toggle('hidden', !esPrizeMonth && !data.premio);
  }

  const usdRate = data.usdRate || 1;

  let sacCalculado = 0;
  if (esSacMonth) {
    const sacB = data.sacBrian !== null ? data.sacBrian : (data.salaryBrian / 2);
    const sacV = data.sacVirginia !== null ? data.sacVirginia : (data.salaryVirginia / 2);
    sacCalculado = sacB + sacV;
    const sacDisplay = document.getElementById('macro-sac-display');
    if (sacDisplay) sacDisplay.textContent = formatearMoneda_(sacCalculado);
  }

  let premioCalculado = data.premio || 0;
  const prizeDisplay = document.getElementById('macro-prize-display');
  if (prizeDisplay) prizeDisplay.textContent = formatearMoneda_(premioCalculado);

  const deudas = (data.gastosFijos || []).filter(g => g.tipo === 'deuda');
  let totalDeudasARS = 0;
  deudas.forEach(d => {
    totalDeudasARS += d.moneda === 'USD' ? (d.monto * usdRate) : d.monto;
  });

  const totalIngresos = data.salaryBrian + data.salaryVirginia + sacCalculado + premioCalculado + totalDeudasARS;
  const incomeTotalEl = document.getElementById('macro-income-total');
  if (incomeTotalEl) incomeTotalEl.textContent = formatearMoneda_(totalIngresos);

  const gastosFijos = (data.gastosFijos || []).filter(g => g.tipo === 'gasto');
  let totalGastosFijosARS = 0;
  gastosFijos.forEach(g => {
    totalGastosFijosARS += g.moneda === 'USD' ? (g.monto * usdRate) : g.monto;
  });

  const deshabilitados = data.serviciosDeshabilitadosEsteMes || [];
  const serviciosHabilitados = (data.serviciosFijos || []).filter(s => !deshabilitados.includes(s.id));
  let totalServiciosARS = 0;
  serviciosHabilitados.forEach(s => {
    totalServiciosARS += s.moneda === 'USD' ? (s.monto * usdRate) : s.monto;
  });

  const totalGastos = totalGastosFijosARS + totalServiciosARS;
  const expensesTotalEl = document.getElementById('macro-expenses-total');
  if (expensesTotalEl) expensesTotalEl.textContent = formatearMoneda_(totalGastos);

  const restoNeto = totalIngresos - totalGastos;
  const balanceDisplay = document.getElementById('macro-net-balance-display');
  const statusBadge = document.getElementById('macro-net-status-badge');

  if (balanceDisplay) balanceDisplay.textContent = formatearMoneda_(restoNeto);
  if (statusBadge) {
    if (restoNeto >= 0) {
      statusBadge.textContent = 'Resto Operativo';
      statusBadge.className = 'text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider bg-emerald-100 text-emerald-800 whitespace-nowrap shrink-0';
    } else {
      statusBadge.textContent = 'Déficit Proyectado';
      statusBadge.className = 'text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider bg-rose-100 text-rose-800 whitespace-nowrap shrink-0';
    }
  }

  renderMacroIncomesList_(data, sacCalculado, premioCalculado, deudas, usdRate);
  renderMacroExpensesList_(gastosFijos, serviciosHabilitados, usdRate);
  renderMacroServicesToggleList_(data.serviciosFijos || [], deshabilitados, usdRate);
  renderMacroDebtsList_(deudas, usdRate);
  renderMacroFixedExpensesLists_(data.gastosFijos || [], usdRate);
}

function renderMacroIncomesList_(data, sac, premio, deudas, usdRate) {
  const cont = document.getElementById('incomes-list');
  if (!cont) return;
  const esPrizeMonth = (data.month === 1 || data.month === 4 || data.month === 7 || data.month === 10);
  const premioNombre = esPrizeMonth ? 'Premio Variable y Ajustes' : 'Ajuste de Sueldo';

  let html = '';
  html += '<div class="flex justify-between"><span>Sueldo Brian</span><span class="font-bold">' + formatearMoneda_(data.salaryBrian) + '</span></div>';
  html += '<div class="flex justify-between"><span>Sueldo Virginia</span><span class="font-bold">' + formatearMoneda_(data.salaryVirginia) + '</span></div>';
  if (sac > 0) html += '<div class="flex justify-between text-amber-800 font-medium"><span>SAC (Aguinaldo)</span><span class="font-bold">' + formatearMoneda_(sac) + '</span></div>';
  if (premio !== 0) html += '<div class="flex justify-between text-emerald-800 font-medium"><span>' + premioNombre + '</span><span class="font-bold">' + formatearMoneda_(premio) + '</span></div>';
  
  deudas.forEach(d => {
    const montoARS = d.moneda === 'USD' ? (d.monto * usdRate) : d.monto;
    html += '<div class="flex justify-between text-emerald-700"><span>Deuda: ' + d.descripcion + '</span><span class="font-bold">' + formatearMoneda_(montoARS) + '</span></div>';
  });

  cont.innerHTML = html;
}

function renderMacroExpensesList_(gastosFijos, serviciosHabilitados, usdRate) {
  const cont = document.getElementById('expenses-list');
  if (!cont) return;
  let html = '';

  gastosFijos.forEach(g => {
    const montoARS = g.moneda === 'USD' ? (g.monto * usdRate) : g.monto;
    html += '<div class="flex justify-between"><span>' + g.descripcion + ' (' + g.usuario + ')</span><span class="font-bold">' + formatearMoneda_(montoARS) + '</span></div>';
  });

  serviciosHabilitados.forEach(s => {
    const montoARS = s.moneda === 'USD' ? (s.monto * usdRate) : s.monto;
    html += '<div class="flex justify-between text-zinc-500"><span>Servicio: ' + s.descripcion + '</span><span class="font-bold">' + formatearMoneda_(montoARS) + '</span></div>';
  });

  cont.innerHTML = html || '<p class="text-[10px] text-zinc-400">Sin gastos fijos proyectados</p>';
}

function renderMacroServicesToggleList_(servicios, deshabilitados, usdRate) {
  const cont = document.getElementById('macro-services-toggle-list');
  const servicesTotalDisplay = document.getElementById('macro-services-total-display');
  if (!cont) return;

  let totalServiciosHab = 0;

  cont.innerHTML = servicios.map(s => {
    const isEnabled = !deshabilitados.includes(s.id);
    const montoARS = s.moneda === 'USD' ? (s.monto * usdRate) : s.monto;
    if (isEnabled) totalServiciosHab += montoARS;

    return '<label class="flex items-center justify-between p-2 bg-zinc-50 rounded-xl cursor-pointer border border-zinc-100 hover:bg-zinc-100 transition-colors">' +
      '<div class="flex items-center gap-2">' +
      '<input type="checkbox" ' + (isEnabled ? 'checked' : '') + ' onchange="toggleServicioStatus(\'' + s.id + '\', this.checked)" class="rounded border-zinc-300 accent-zinc-900 w-4 h-4">' +
      '<span class="text-xs font-semibold text-zinc-800">' + s.descripcion + '</span></div>' +
      '<span class="text-xs font-bold text-zinc-900">' + formatearMoneda_(montoARS) + '</span></label>';
  }).join('');

  if (servicesTotalDisplay) servicesTotalDisplay.textContent = formatearMoneda_(totalServiciosHab);
}

function renderMacroDebtsList_(deudas, usdRate) {
  const cont = document.getElementById('debts-list');
  const sumEl = document.getElementById('debts-total-sum');
  if (!cont) return;

  let totalSum = 0;
  if (!deudas.length) {
    cont.innerHTML = '<p class="text-[10px] text-zinc-400 text-center py-1">Sin deudas a favor registradas</p>';
    if (sumEl) sumEl.textContent = '+$ 0,00';
    return;
  }

  cont.innerHTML = deudas.map(d => {
    const montoARS = d.moneda === 'USD' ? (d.monto * usdRate) : d.monto;
    totalSum += montoARS;
    return '<div class="flex justify-between items-center p-2 bg-emerald-50/50 rounded-xl border border-emerald-100">' +
      '<div><span class="font-bold text-emerald-950 block">' + d.descripcion + '</span>' +
      '<span class="text-[9px] text-emerald-700/80 font-medium">' + d.usuario + '</span></div>' +
      '<span class="font-black text-emerald-800">+' + formatearMoneda_(montoARS) + '</span></div>';
  }).join('');

  if (sumEl) sumEl.textContent = '+' + formatearMoneda_(totalSum);
}

function renderMacroFixedExpensesLists_(gastosFijos, usdRate) {
  const brianCont = document.getElementById('brian-fixed-list');
  const virginiaCont = document.getElementById('virginia-fixed-list');

  const brianItems = gastosFijos.filter(g => g.usuario === 'Brian');
  const virginiaItems = gastosFijos.filter(g => g.usuario === 'Virginia');

  const renderItem = (g) => {
    const montoARS = g.moneda === 'USD' ? (g.monto * usdRate) : g.monto;
    const esDeuda = (g.tipo === 'deuda' || g.tipo === 'debt');
    const esDeshabilitado = (g.monto === 0 || g.esPausado);

    let subTexto = esDeuda ? 'Deuda a favor (+)' : 'Gasto fijo (-)';
    if (g.esPausado) {
      subTexto = 'Pausado de acá en adelante';
    } else if (esDeshabilitado) {
      subTexto = 'Deshabilitado este mes';
    } else if (g.tieneExcepcionEsteMes) {
      subTexto += ' · Ajuste este mes';
    }

    return '<div onclick="openFixedExpenseModal(\'' + g.usuario + '\', \'' + g.id + '\')" class="flex justify-between items-center p-2 bg-zinc-50 hover:bg-zinc-100 rounded-xl border border-zinc-200/60 cursor-pointer transition-colors">' +
      '<div><span class="font-bold text-zinc-800 block ' + (esDeshabilitado ? 'line-through text-zinc-400' : '') + '">' + g.descripcion + '</span>' +
      '<span class="text-[9px] ' + (esDeshabilitado ? 'text-amber-600 font-semibold' : 'text-zinc-400 font-medium') + '">' + subTexto + '</span></div>' +
      '<span class="font-black ' + (esDeshabilitado ? 'text-zinc-400' : (esDeuda ? 'text-emerald-600' : 'text-zinc-900')) + '">' + (esDeshabilitado ? '$ 0,00' : ((esDeuda ? '+' : '-') + formatearMoneda_(montoARS))) + '</span></div>';
  };

  if (brianCont) {
    brianCont.innerHTML = brianItems.length ? brianItems.map(renderItem).join('') : '<p class="text-[10px] text-zinc-400 py-1">Sin gastos fijos cargados</p>';
  }

  if (virginiaCont) {
    virginiaCont.innerHTML = virginiaItems.length ? virginiaItems.map(renderItem).join('') : '<p class="text-[10px] text-zinc-400 py-1">Sin gastos fijos cargados</p>';
  }
}

function toggleIncomesCollapse() {
  const content = document.getElementById('incomes-collapse-content');
  const arrow = document.getElementById('incomes-collapse-arrow');
  if (content) content.classList.toggle('hidden');
  if (arrow) arrow.classList.toggle('rotate-180');
}

function toggleExpensesCollapse() {
  const content = document.getElementById('expenses-collapse-content');
  const arrow = document.getElementById('expenses-collapse-arrow');
  if (content) content.classList.toggle('hidden');
  if (arrow) arrow.classList.toggle('rotate-180');
}

function toggleServicesCollapse() {
  const content = document.getElementById('services-collapse-content');
  const arrow = document.getElementById('services-collapse-arrow');
  if (content) content.classList.toggle('hidden');
  if (arrow) arrow.classList.toggle('rotate-180');
}

function toggleDebtsCollapse() {
  const content = document.getElementById('debts-collapse-content');
  const arrow = document.getElementById('debts-collapse-arrow');
  if (content) content.classList.toggle('hidden');
  if (arrow) arrow.classList.toggle('rotate-180');
}

function toggleServicioStatus(servicioId, habilitado) {
  if (!appState.macroData) return;

  let deshabilitados = appState.macroData.serviciosDeshabilitadosEsteMes || [];
  if (habilitado) {
    deshabilitados = deshabilitados.filter(id => String(id) !== String(servicioId));
  } else {
    if (!deshabilitados.includes(servicioId)) {
      deshabilitados.push(servicioId);
    }
  }
  appState.macroData.serviciosDeshabilitadosEsteMes = deshabilitados;
  renderMacroView();

  callBackendBackground('toggleServicio', {
    servicioId: servicioId,
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    habilitado: habilitado
  });
}

function toggleAllServicesCheckboxes(e) {
  e.stopPropagation();
  const data = appState.macroData;
  if (!data || !data.serviciosFijos) return;

  const deshabilitados = data.serviciosDeshabilitadosEsteMes || [];
  const hayHabilitados = data.serviciosFijos.some(s => !deshabilitados.includes(s.id));
  const nuevoEstadoHabilitar = !hayHabilitados;

  if (nuevoEstadoHabilitar) {
    data.serviciosDeshabilitadosEsteMes = [];
  } else {
    data.serviciosDeshabilitadosEsteMes = data.serviciosFijos.map(s => s.id);
  }
  renderMacroView();

  callBackendBackground('toggleAllServiciosBatch', {
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    habilitarTodos: nuevoEstadoHabilitar
  });
}

// ============================================================
// MODALES Y ACCIONES MACRO
// ============================================================

function toggleMacroConfigModal(show) {
  if (show) {
    const data = appState.macroData || {};
    macroDraft = {
      usdRate: data.usdRate || 0,
      salaryBrian: data.salaryBrian || 0,
      salaryVirginia: data.salaryVirginia || 0,
      serviciosFijos: JSON.parse(JSON.stringify(data.serviciosFijos || [])),
      serviciosEliminados: []
    };
    renderMacroConfigDraft_();
  } else {
    macroDraft = null;
  }
  document.getElementById('macro-config-modal').classList.toggle('active', show);
}

function renderMacroConfigDraft_() {
  if (!macroDraft) return;
  const usdEl = document.getElementById('display-usd-rate');
  const brianEl = document.getElementById('display-salary-brian');
  const virginiaEl = document.getElementById('display-salary-virginia');

  if (usdEl) usdEl.textContent = formatearMoneda_(macroDraft.usdRate);
  if (brianEl) brianEl.textContent = formatearMoneda_(macroDraft.salaryBrian);
  if (virginiaEl) virginiaEl.textContent = formatearMoneda_(macroDraft.salaryVirginia);

  renderMacroServicesConfigList_(macroDraft.serviciosFijos || []);
}

function renderMacroServicesConfigList_(servicios) {
  const cont = document.getElementById('macro-services-list');
  if (!cont) return;

  if (!servicios.length) {
    cont.innerHTML = '<p class="text-[10px] text-zinc-400 py-1">Sin servicios fijos creados</p>';
    return;
  }

  const rate = (macroDraft && macroDraft.usdRate) ? macroDraft.usdRate : (appState.macroData ? appState.macroData.usdRate : 1);

  cont.innerHTML = servicios.map(s => {
    let displayMonto = formatearMoneda_(s.monto) + ' ' + (s.moneda || 'ARS');
    if (s.moneda === 'USD') {
      displayMonto = formatearMoneda_(s.monto) + ' USD (≈ ' + formatearMoneda_(s.monto * rate) + ')';
    }
    return '<div onclick="openServiceEditModal(\'' + s.id + '\')" class="flex justify-between items-center p-2 bg-zinc-50 hover:bg-zinc-100 rounded-xl cursor-pointer border border-zinc-200/80 transition-colors">' +
      '<span class="text-xs font-bold text-zinc-800">' + s.descripcion + '</span>' +
      '<span class="text-xs font-black text-zinc-900">' + displayMonto + '</span></div>';
  }).join('');
}

function openValueEditModal(target) {
  currentEditingValueTarget = target;
  const modal = document.getElementById('value-edit-modal');
  const title = document.getElementById('value-edit-modal-title');
  const label = document.getElementById('value-edit-input-label');
  const helper = document.getElementById('value-edit-helper');
  const inputId = 'generic-value-input';

  let valorActual = 0;
  const data = (macroDraft && (target === 'usd' || target === 'salary-brian' || target === 'salary-virginia'))
    ? macroDraft
    : (appState.macroData || {});

  if (helper) helper.classList.add('hidden');

  if (target === 'usd') {
    title.textContent = 'Editar Cotización Dólar';
    label.textContent = 'Dólar Oficial (ARS)';
    valorActual = data.usdRate || 0;
  } else if (target === 'salary-brian') {
    title.textContent = 'Editar Sueldo Brian';
    label.textContent = 'Sueldo Fijo Mensual ($)';
    valorActual = data.salaryBrian || 0;
  } else if (target === 'salary-virginia') {
    title.textContent = 'Editar Sueldo Virginia';
    label.textContent = 'Sueldo Fijo Mensual ($)';
    valorActual = data.salaryVirginia || 0;
  } else if (target === 'prize-brian') {
    const esPrizeMonth = (data.month === 1 || data.month === 4 || data.month === 7 || data.month === 10);
    title.textContent = esPrizeMonth ? 'Calcular Premio y Ajustes' : 'Calcular Ajuste de Sueldo';
    label.textContent = 'Total Cobrado en Bolsillo ($)';
    
    const sueldoBase = data.salaryBrian || 0;
    const extraPrevio = data.premio || 0;
    valorActual = extraPrevio !== 0 ? (sueldoBase + extraPrevio) : sueldoBase;

    if (helper) {
      helper.textContent = 'Sueldo base de Brian: ' + formatearMoneda_(sueldoBase) + '. Se calculará la diferencia automáticamente.';
      helper.classList.remove('hidden');
    }
  } else if (target === 'sac-value') {
    title.textContent = 'Editar SAC (Aguinaldo)';
    label.textContent = 'Monto Aguinaldo Este Mes ($)';
    valorActual = (data.sacBrian || 0) + (data.sacVirginia || 0);
  }

  attachMoneyInput(inputId, () => {});
  setMoneyValue(inputId, valorActual);
  modal.classList.add('active');
}

function toggleValueEditModal(show) {
  document.getElementById('value-edit-modal').classList.toggle('active', show);
}

function handleValueSubmit() {
  const monto = getMoneyValue('generic-value-input');
  toggleValueEditModal(false);

  if (macroDraft && (currentEditingValueTarget === 'usd' || currentEditingValueTarget === 'salary-brian' || currentEditingValueTarget === 'salary-virginia')) {
    if (currentEditingValueTarget === 'usd') {
      macroDraft.usdRate = monto;
    } else if (currentEditingValueTarget === 'salary-brian') {
      macroDraft.salaryBrian = monto;
    } else if (currentEditingValueTarget === 'salary-virginia') {
      macroDraft.salaryVirginia = monto;
    }
    renderMacroConfigDraft_();
    return;
  }

  if (currentEditingValueTarget === 'prize-brian') {
    const data = appState.macroData || {};
    const sueldoBase = data.salaryBrian || 0;
    let diferencia = 0;
    if (monto > 0) {
      diferencia = monto - sueldoBase;
    }

    data.premio = diferencia;
    renderMacroView();

    callBackendBackground('guardarPremio', {
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth,
      monto: diferencia
    });
  } else if (currentEditingValueTarget === 'sac-value') {
    const data = appState.macroData || {};
    data.sacBrian = monto / 2;
    data.sacVirginia = monto / 2;
    renderMacroView();

    callBackendBackground('guardarSacOverride', {
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth,
      usuario: 'Brian',
      monto: monto / 2
    }).then(() => {
      callBackendBackground('guardarSacOverride', {
        year: appState.currentMacroYear,
        month: appState.currentMacroMonth,
        usuario: 'Virginia',
        monto: monto / 2
      });
    });
  }
}

function openServiceEditModal(serviceId) {
  currentEditingServiceId = serviceId;
  const form = document.getElementById('srv-edit-form');
  const btnDelete = document.getElementById('btn-delete-service');
  form.reset();

  attachMoneyInput('srv-modal-amount', () => {});
  attachMoneyInput('srv-modal-unit-price', () => updateServiceModalTotalFromUnits());

  const chkDirect = document.getElementById('chk-srv-is-direct');
  if (chkDirect) {
    chkDirect.checked = true;
    toggleServiceModalMode(true);
  }

  const list = (macroDraft && macroDraft.serviciosFijos)
    ? macroDraft.serviciosFijos
    : (appState.macroData ? appState.macroData.serviciosFijos : []);

  if (serviceId) {
    const s = list.find(x => String(x.id) === String(serviceId));
    if (s) {
      document.getElementById('srv-modal-name').value = s.descripcion;
      setMoneyValue('srv-modal-amount', s.monto);
      document.getElementById('srv-modal-currency').value = s.moneda || 'ARS';
      if (btnDelete) btnDelete.classList.remove('hidden');
    }
  } else {
    setMoneyValue('srv-modal-amount', 0);
    setMoneyValue('srv-modal-unit-price', 0);
    document.getElementById('srv-modal-units').value = 1;
    document.getElementById('srv-modal-currency').value = 'ARS';
    if (btnDelete) btnDelete.classList.add('hidden');
  }

  document.getElementById('service-edit-modal').classList.add('active');
}

function toggleServiceEditModal(show) {
  document.getElementById('service-edit-modal').classList.toggle('active', show);
}

function toggleServiceModalMode(isDirect) {
  const container = document.getElementById('srv-modal-units-container');
  if (container) container.classList.toggle('hidden', isDirect);
}

function updateServiceModalTotalFromUnits() {
  const units = parseInt(document.getElementById('srv-modal-units').value, 10) || 1;
  const unitPrice = getMoneyValue('srv-modal-unit-price');
  setMoneyValue('srv-modal-amount', units * unitPrice);
}

async function handleServiceSubmit() {
  const descripcion = document.getElementById('srv-modal-name').value.trim();
  const monto = getMoneyValue('srv-modal-amount');
  const moneda = document.getElementById('srv-modal-currency').value;

  if (!descripcion) { alert('Ingresá el nombre del servicio'); return; }
  if (monto <= 0) { alert('Ingresá un monto válido'); return; }

  toggleServiceEditModal(false);

  if (macroDraft) {
    if (currentEditingServiceId) {
      const s = (macroDraft.serviciosFijos || []).find(x => String(x.id) === String(currentEditingServiceId));
      if (s) {
        s.descripcion = descripcion;
        s.monto = monto;
        s.moneda = moneda;
      }
    } else {
      macroDraft.serviciosFijos.push({
        id: 'srv_' + Date.now(),
        descripcion: descripcion,
        monto: monto,
        moneda: moneda
      });
    }
    renderMacroConfigDraft_();
  }
}

async function deleteCurrentEditingService() {
  if (!currentEditingServiceId) return;
  toggleServiceEditModal(false);

  if (macroDraft) {
    if (!currentEditingServiceId.startsWith('srv_')) {
      macroDraft.serviciosEliminados.push(currentEditingServiceId);
    }
    macroDraft.serviciosFijos = macroDraft.serviciosFijos.filter(x => String(x.id) !== String(currentEditingServiceId));
    renderMacroConfigDraft_();
  }
}

function openFixedExpenseModal(user, expenseId) {
  currentEditingFixedExpenseUser = user;
  currentEditingFixedExpenseId = expenseId;
  document.getElementById('fixed-user-label').textContent = user;

  const form = document.getElementById('fixed-expense-form');
  form.reset();

  const chkDirect = document.getElementById('chk-fixed-is-direct');
  if (chkDirect) {
    chkDirect.checked = true;
    toggleFixedMode(true);
  }

  attachMoneyInput('fixed-amount', () => {});
  attachMoneyInput('fixed-unit-price', () => updateFixedTotalFromUnits());

  const btnDelete = document.getElementById('btn-delete-fixed');
  const btnDisable = document.getElementById('btn-disable-fixed');
  const btnPause = document.getElementById('btn-pause-fixed');

  if (expenseId) {
    const g = (appState.macroData && appState.macroData.gastosFijos || []).find(x => String(x.id) === String(expenseId));
    if (g) {
      const tipoVal = (g.tipo === 'debt' || g.tipo === 'deuda') ? 'deuda' : 'gasto';
      document.getElementById('fixed-type-select').value = tipoVal;
      document.getElementById('fixed-desc').value = g.descripcion || '';
      document.getElementById('fixed-currency').value = g.moneda || 'ARS';

      const isDirect = (g.isDirect !== undefined) ? g.isDirect : true;
      if (chkDirect) chkDirect.checked = isDirect;
      toggleFixedMode(isDirect);

      if (!isDirect) {
        document.getElementById('fixed-units').value = g.units || 1;
        setMoneyValue('fixed-unit-price', g.unitPrice || 0);
      }
      setMoneyValue('fixed-amount', g.monto || 0);

      if (btnDelete) btnDelete.classList.remove('hidden');
      
      if (btnDisable) {
        btnDisable.classList.remove('hidden');
        if (g.tieneExcepcionEsteMes && g.monto === 0) {
          btnDisable.textContent = 'Habilitar para este mes';
          btnDisable.onclick = enableFixedExpenseThisMonth;
        } else {
          btnDisable.textContent = 'Deshabilitar solo este mes ($ 0)';
          btnDisable.onclick = disableFixedExpenseThisMonth;
        }
      }

      if (btnPause) {
        btnPause.classList.remove('hidden');
        if (g.esPausado) {
          btnPause.textContent = 'Reactivar de acá en adelante';
          btnPause.onclick = reactivateFixedExpenseFuture;
        } else {
          btnPause.textContent = 'Pausar de acá en adelante';
          btnPause.onclick = pauseFixedExpenseFuture;
        }
      }
    }
  } else {
    setMoneyValue('fixed-amount', 0);
    setMoneyValue('fixed-unit-price', 0);
    document.getElementById('fixed-units').value = 1;
    if (btnDelete) btnDelete.classList.add('hidden');
    if (btnDisable) btnDisable.classList.add('hidden');
    if (btnPause) btnPause.classList.add('hidden');
  }

  document.getElementById('fixed-expense-modal').classList.add('active');
}

function toggleFixedExpenseModal(show) {
  document.getElementById('fixed-expense-modal').classList.toggle('active', show);
}

function toggleFixedMode(isDirect) {
  const container = document.getElementById('fixed-units-container');
  if (container) container.classList.toggle('hidden', isDirect);
}

function updateFixedTotalFromUnits() {
  const units = parseInt(document.getElementById('fixed-units').value, 10) || 1;
  const unitPrice = getMoneyValue('fixed-unit-price');
  setMoneyValue('fixed-amount', units * unitPrice);
}

function handleFixedExpenseSubmit() {
  const tipo = document.getElementById('fixed-type-select').value;
  const descripcion = document.getElementById('fixed-desc').value.trim();
  const isDirect = document.getElementById('chk-fixed-is-direct').checked;
  const units = parseInt(document.getElementById('fixed-units').value, 10) || 1;
  const unitPrice = getMoneyValue('fixed-unit-price');
  const monto = getMoneyValue('fixed-amount');
  const moneda = document.getElementById('fixed-currency').value;
  const replicate = document.getElementById('chk-replicate-12-months').checked;

  if (!descripcion) { alert('Ingresá una descripción'); return; }
  if (monto < 0) { alert('Ingresá un monto válido'); return; }

  toggleFixedExpenseModal(false);

  const tempId = currentEditingFixedExpenseId || ('temp_fe_' + Date.now());

  if (appState.macroData && appState.macroData.gastosFijos) {
    const list = appState.macroData.gastosFijos;
    let item = list.find(x => String(x.id) === String(currentEditingFixedExpenseId));

    if (!item) {
      item = {
        id: tempId,
        usuario: currentEditingFixedExpenseUser,
        descripcion: descripcion,
        tipo: (tipo === 'debt' || tipo === 'deuda') ? 'deuda' : 'gasto',
        isDirect: isDirect,
        units: isDirect ? 1 : units,
        unitPrice: isDirect ? monto : unitPrice,
        monto: monto,
        montoBase: monto,
        moneda: moneda,
        activoDesdeYear: appState.currentMacroYear,
        activoDesdeMonth: appState.currentMacroMonth,
        hastaYear: null,
        hastaMonth: null,
        esPausado: false,
        tieneExcepcionEsteMes: !replicate
      };
      list.push(item);
    } else {
      item.descripcion = descripcion;
      item.tipo = (tipo === 'debt' || tipo === 'deuda') ? 'deuda' : 'gasto';
      item.isDirect = isDirect;
      item.units = isDirect ? 1 : units;
      item.unitPrice = isDirect ? monto : unitPrice;
      item.monto = monto;
      item.moneda = moneda;
      if (!replicate) item.tieneExcepcionEsteMes = true;
    }
    renderMacroView();
  }

  if (replicate) {
    callBackendBackground('guardarGastoFijo', {
      id: currentEditingFixedExpenseId,
      usuario: currentEditingFixedExpenseUser,
      descripcion: descripcion,
      tipo: tipo,
      isDirect: isDirect,
      units: isDirect ? 1 : units,
      unitPrice: isDirect ? monto : unitPrice,
      monto: monto,
      moneda: moneda,
      activoDesdeYear: appState.currentMacroYear,
      activoDesdeMonth: appState.currentMacroMonth,
      hastaYear: null,
      hastaMonth: null
    }).then(result => {
      if (result && result.id && appState.macroData) {
        const item = appState.macroData.gastosFijos.find(x => String(x.id) === String(tempId));
        if (item) {
          item.id = result.id;
          renderMacroView();
        }
      }
    });
  } else {
    callBackendBackground('guardarExcepcionGastoFijo', {
      groupId: currentEditingFixedExpenseId,
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth,
      unitsOverride: isDirect ? null : units,
      montoOverride: monto
    });
  }
}

function disableFixedExpenseThisMonth() {
  if (!currentEditingFixedExpenseId) return;
  toggleFixedExpenseModal(false);

  if (appState.macroData && appState.macroData.gastosFijos) {
    const item = appState.macroData.gastosFijos.find(x => String(x.id) === String(currentEditingFixedExpenseId));
    if (item) {
      item.monto = 0;
      item.tieneExcepcionEsteMes = true;
    }
    renderMacroView();
  }

  callBackendBackground('guardarExcepcionGastoFijo', {
    groupId: currentEditingFixedExpenseId,
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    montoOverride: 0
  });
}

function enableFixedExpenseThisMonth() {
  if (!currentEditingFixedExpenseId) return;
  toggleFixedExpenseModal(false);

  if (appState.macroData && appState.macroData.gastosFijos) {
    const item = appState.macroData.gastosFijos.find(x => String(x.id) === String(currentEditingFixedExpenseId));
    if (item) {
      item.monto = item.montoBase !== undefined ? item.montoBase : item.monto;
      item.tieneExcepcionEsteMes = false;
    }
    renderMacroView();
  }

  callBackendBackground('guardarExcepcionGastoFijo', {
    groupId: currentEditingFixedExpenseId,
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    montoOverride: null
  });
}

function pauseFixedExpenseFuture() {
  if (!currentEditingFixedExpenseId) return;
  const g = (appState.macroData && appState.macroData.gastosFijos || []).find(x => String(x.id) === String(currentEditingFixedExpenseId));
  if (!g) return;

  toggleFixedExpenseModal(false);

  let targetMonth = appState.currentMacroMonth - 1;
  let targetYear = appState.currentMacroYear;
  if (targetMonth < 0) {
    targetMonth = 11;
    targetYear--;
  }

  g.esPausado = true;
  g.monto = 0;
  g.hastaYear = targetYear;
  g.hastaMonth = targetMonth;
  renderMacroView();

  callBackendBackground('guardarGastoFijo', {
    id: g.id,
    usuario: g.usuario,
    descripcion: g.descripcion,
    tipo: g.tipo,
    isDirect: g.isDirect,
    units: g.units,
    unitPrice: g.unitPrice,
    monto: g.montoBase !== undefined ? g.montoBase : g.monto,
    moneda: g.moneda,
    activoDesdeYear: g.activoDesdeYear || appState.currentMacroYear,
    activoDesdeMonth: (g.activoDesdeMonth !== undefined && g.activoDesdeMonth !== null) ? g.activoDesdeMonth : 0,
    hastaYear: targetYear,
    hastaMonth: targetMonth
  });
}

function reactivateFixedExpenseFuture() {
  if (!currentEditingFixedExpenseId) return;
  const g = (appState.macroData && appState.macroData.gastosFijos || []).find(x => String(x.id) === String(currentEditingFixedExpenseId));
  if (!g) return;

  toggleFixedExpenseModal(false);

  g.esPausado = false;
  g.monto = g.montoBase !== undefined ? g.montoBase : g.monto;
  g.hastaYear = null;
  g.hastaMonth = null;
  renderMacroView();

  callBackendBackground('guardarGastoFijo', {
    id: g.id,
    usuario: g.usuario,
    descripcion: g.descripcion,
    tipo: g.tipo,
    isDirect: g.isDirect,
    units: g.units,
    unitPrice: g.unitPrice,
    monto: g.montoBase !== undefined ? g.montoBase : g.monto,
    moneda: g.moneda,
    activoDesdeYear: g.activoDesdeYear || appState.currentMacroYear,
    activoDesdeMonth: (g.activoDesdeMonth !== undefined && g.activoDesdeMonth !== null) ? g.activoDesdeMonth : 0,
    hastaYear: null,
    hastaMonth: null
  });
}

function deleteCurrentEditingFixedExpense() {
  if (!currentEditingFixedExpenseId) return;
  toggleFixedExpenseModal(false);

  if (appState.macroData && appState.macroData.gastosFijos) {
    appState.macroData.gastosFijos = appState.macroData.gastosFijos.filter(x => String(x.id) !== String(currentEditingFixedExpenseId));
    renderMacroView();
  }

  callBackendBackground('eliminarGastoFijo', { id: currentEditingFixedExpenseId });
}

function saveMacroConfig() {
  if (!macroDraft) {
    document.getElementById('macro-config-modal').classList.remove('active');
    return;
  }

  const draft = macroDraft;
  document.getElementById('macro-config-modal').classList.remove('active');

  if (appState.macroData) {
    appState.macroData.usdRate = draft.usdRate;
    appState.macroData.salaryBrian = draft.salaryBrian;
    appState.macroData.salaryVirginia = draft.salaryVirginia;
    appState.macroData.serviciosFijos = draft.serviciosFijos;
    renderMacroView();
  }

  callBackendBackground('guardarConfiguracionMacroBatch', {
    usdRate: draft.usdRate,
    salaryBrian: draft.salaryBrian,
    salaryVirginia: draft.salaryVirginia,
    serviciosFijos: draft.serviciosFijos,
    serviciosEliminados: draft.serviciosEliminados,
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth
  }).then(newMacroData => {
    if (newMacroData) {
      appState.macroData = newMacroData;
      renderMacroView();
    }
  });

  macroDraft = null;
}

function toggleQuickAddModal(show) {
  document.getElementById('quick-add-modal').classList.toggle('active', show);
}

function quickAddService() {
  toggleQuickAddModal(false);
  openServiceEditModal(null);
}

function quickAddFixedExpense(user) {
  toggleQuickAddModal(false);
  openFixedExpenseModal(user, null);
}

// ============================================================
// CARGA DE ESTADO Y BOOTSTRAP
// ============================================================

async function recargarEstadoDiario_(conToast) {
  const data = conToast === false ? await callBackend('getEstadoDiario', {}) : await callBackendConSync('getEstadoDiario', {});
  appState.homeBankingTotal = data.homeBankingTotal;
  appState.bolsaTotal = data.bolsaTotal;
  appState.diaCobro = data.diaCobro;
  appState.diasRestantes = data.diasRestantes;
  appState.movimientos = (data.movimientos || []).map(m => {
    m.fechasAfectadas = normalizarFechas_(m.fechasAfectadas);
    return m;
  });
  appState.lastProcessedDate = data.lastProcessedDate;
  if (appState.currentView === 'micro') renderMicroView();

  if (data.cierrePendiente) {
    cierreDiaPendiente = data.cierrePendiente;
    mostrarModalCierreDia_(cierreDiaPendiente);
  }
}

async function bootstrapEstado_() {
  const data = await callBackendConSync('getEstadoDiario', {});

  appState.homeBankingTotal = data.homeBankingTotal;
  appState.bolsaTotal = data.bolsaTotal;
  appState.diaCobro = data.diaCobro;
  appState.diasRestantes = data.diasRestantes;
  appState.movimientos = (data.movimientos || []).map(m => {
    m.fechasAfectadas = normalizarFechas_(m.fechasAfectadas);
    return m;
  });
  appState.lastProcessedDate = data.lastProcessedDate;

  localStorage.setItem('accentColor_Brian', data.accentColorBrian);
  localStorage.setItem('accentColor_Virginia', data.accentColorVirginia);
  const colorActivo = appState.activeUser === 'Brian' ? data.accentColorBrian : data.accentColorVirginia;
  document.documentElement.style.setProperty('--accent-color', colorActivo);

  switchView(appState.currentView);

  if (data.cierrePendiente) {
    cierreDiaPendiente = data.cierrePendiente;
    mostrarModalCierreDia_(cierreDiaPendiente);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  cargarUsuarioYColorLocal_();
  bootstrapEstado_();
});
