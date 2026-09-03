/*
 * financiero.js
 * =============================================================================
 * Panel de Finanzas — página de SOLO LECTURA.
 *
 * Flujo:
 *   1) Al cargar la página, pide los datos a Express: GET /api/lentes
 *   2) Calcula stock, unidades vendidas y ganancia por armazón
 *   3) Pinta: tarjetas de estadísticas, tabla de registros (con búsqueda y
 *      filtros) y la lista de movimientos recientes
 *
 * Este archivo NO guarda ni edita nada — toda la escritura vive en tu Express.
 *
 * Índice:
 *   1. Referencias al DOM
 *   2. Estado en memoria (lo que llega de la API)
 *   3. Formato de texto (dinero, fechas, escape de HTML)
 *   4. Cálculos (stock, ventas, ganancia)
 *   5. Carga de datos desde la API
 *   6. Pintado de cada sección
 *   7. Arranque
 * =============================================================================
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Referencias al DOM
  //    Se cargan una sola vez en init(), para no repetir getElementById por
  //    todo el archivo. Las funciones checkan si el elemento existe antes de
  //    acceder a sus propiedades, para evitar errores si falta el HTML.
  // ---------------------------------------------------------------------------
  let dom = {};

  function cacheDomReferences() {
    // Función helper: obtén el elemento, pero devuelve null si no existe.
    const getEl = (id) => document.getElementById(id);

    dom = {
      loadError: getEl('load-error'),
      statModelos: getEl('stat-modelos'),
      statStock: getEl('stat-stock'),
      statVendidos: getEl('stat-vendidos'),
      statGanancia: getEl('stat-ganancia'),
      searchInput: getEl('records-search'),
      filterMarca: getEl('records-filter-marca'),
      filterSucursal: getEl('records-filter-sucursal'),
      recordsBody: getEl('records-tbody'),
      recordsFoot: getEl('records-tfoot'),
      recordsEmpty: getEl('records-empty'),
      movimientosList: getEl('movimientos-list'),
      movimientosEmpty: getEl('movimientos-empty')
    };

    // Log qué IDs faltaban, para ayudarte a debuguear.
    const missing = Object.entries(dom)
      .filter(([key, el]) => !el)
      .map(([key]) => key);
    if (missing.length > 0) {
      console.warn('[financiero.js] IDs que faltaban en el HTML:', missing);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Estado en memoria
  // ---------------------------------------------------------------------------
  let catalog = [];      // armazones registrados (compartidos entre cuentas)
  let movimientos = [];  // compras/ventas (el servidor ya las filtra por cuenta)

  const RECORDS_TABLE_COLUMNS = 9;  // debe coincidir con las <th> de financiero.html
  const MAX_MOVIMIENTOS_MOSTRADOS = 20;

  // ---------------------------------------------------------------------------
  // 3. Formato de texto
  // ---------------------------------------------------------------------------

  /** 1234.5 -> "$1,234.50" */
  function formatMoney(amount) {
    const value = Number(amount) || 0;
    return '$' + value.toLocaleString('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  /** "2026-08-30" -> "30 ago 2026" */
  function formatDate(isoDate) {
    if (!isoDate) return '—';
    const date = new Date(isoDate + 'T00:00:00');
    if (isNaN(date.getTime())) return isoDate;
    return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /** Evita inyección de HTML al insertar texto de la API con innerHTML. */
  function escapeHtml(text) {
    const charsToEscape = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(text).replace(/[&<>"']/g, (char) => charsToEscape[char]);
  }

  // ---------------------------------------------------------------------------
  // 4. Cálculos
  // ---------------------------------------------------------------------------

  function sumBy(items, getValue) {
    return items.reduce((total, item) => total + Number(getValue(item)), 0);
  }

  /**
   * Compras, ventas, stock y ganancia de UN armazón.
   * La ganancia usa el costo PROMEDIO de sus compras (no el precio de
   * catálogo), para que salga bien aunque el costo haya cambiado con el tiempo.
   */
  function computeFrameStats(frame) {
    const compras = movimientos.filter((m) => m.frameId === frame.id && m.tipo === 'compra');
    const ventas = movimientos.filter((m) => m.frameId === frame.id && m.tipo === 'venta');

    const unidadesCompradas = sumBy(compras, (m) => m.cantidad);
    const unidadesVendidas = sumBy(ventas, (m) => m.cantidad);
    const costoTotalComprado = sumBy(compras, (m) => m.cantidad * m.precioUnitario);
    const ingresosPorVentas = sumBy(ventas, (m) => m.cantidad * m.precioUnitario);

    const costoPromedio = unidadesCompradas > 0
      ? costoTotalComprado / unidadesCompradas
      : Number(frame.precioComprado) || 0;

    return {
      comprados: unidadesCompradas,
      vendidos: unidadesVendidas,
      stock: unidadesCompradas - unidadesVendidas,
      ganancia: ingresosPorVentas - unidadesVendidas * costoPromedio
    };
  }

  /** Estadísticas sumadas de todo el catálogo, para las tarjetas superiores. */
  function computeGlobalStats() {
    let stockTotal = 0;
    let vendidosTotal = 0;
    let gananciaTotal = 0;

    catalog.forEach((frame) => {
      const stats = computeFrameStats(frame);
      stockTotal += stats.stock;
      vendidosTotal += stats.vendidos;
      gananciaTotal += stats.ganancia;
    });

    return { modelos: catalog.length, stock: stockTotal, vendidos: vendidosTotal, ganancia: gananciaTotal };
  }

  /** Valores distintos y no vacíos de un campo del catálogo (para llenar los filtros). */
  function getUniqueValues(field) {
    const values = new Set();
    catalog.forEach((frame) => {
      const value = (frame[field] || '').trim();
      if (value) values.add(value);
    });
    return Array.from(values).sort((a, b) => a.localeCompare(b, 'es'));
  }

  // ---------------------------------------------------------------------------
  // 5. Carga de datos desde la API
  // ---------------------------------------------------------------------------

  /** GET /api/lentes -> { catalog, movimientos }. Repinta todo al terminar. */
  async function loadDataFromServer() {
    try {
      const response = await fetch('/api/lentes');
      const data = await response.json();

      catalog = Array.isArray(data.catalog) ? data.catalog : [];
      movimientos = Array.isArray(data.movimientos) ? data.movimientos : [];
      if (dom.loadError) dom.loadError.hidden = true;
    } catch (error) {
      console.error('Error obteniendo los datos:', error);
      if (dom.loadError) dom.loadError.hidden = false;
    }
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // 6. Pintado de cada sección
  // ---------------------------------------------------------------------------

  function renderAll() {
    renderStats();
    renderFilterOptions();
    renderRecordsTable();
    renderMovimientosList();
  }

  function renderStats() {
    const stats = computeGlobalStats();
    if (dom.statModelos) dom.statModelos.textContent = stats.modelos;
    if (dom.statStock) dom.statStock.textContent = stats.stock;
    if (dom.statVendidos) dom.statVendidos.textContent = stats.vendidos;
    if (dom.statGanancia) dom.statGanancia.textContent = formatMoney(stats.ganancia);
  }

  /** Llena los <select> de Marca y Sucursal con los valores que hay en el catálogo. */
  function renderFilterOptions() {
    if (dom.filterMarca) fillSelect(dom.filterMarca, getUniqueValues('marca'), 'Todas las marcas');
    if (dom.filterSucursal) fillSelect(dom.filterSucursal, getUniqueValues('sucursal'), 'Todas las sucursales');
  }

  function fillSelect(select, values, placeholderLabel) {
    const previousValue = select.value;
    const optionsHtml = values
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join('');
    select.innerHTML = `<option value="">${placeholderLabel}</option>${optionsHtml}`;

    // Si el valor que tenía seleccionado sigue existiendo, lo conservamos.
    if (values.includes(previousValue)) select.value = previousValue;
  }

  /** Catálogo filtrado según el texto buscado y los <select> de marca/sucursal. */
  function getFilteredCatalog() {
    const searchTerm = dom.searchInput.value.trim().toLowerCase();
    const marcaFilter = dom.filterMarca.value;
    const sucursalFilter = dom.filterSucursal.value;

    return catalog.filter((frame) => {
      const matchesSearch = !searchTerm
        || frame.nombre.toLowerCase().includes(searchTerm)
        || frame.marca.toLowerCase().includes(searchTerm);
      const matchesMarca = !marcaFilter || frame.marca === marcaFilter;
      const matchesSucursal = !sucursalFilter || frame.sucursal === sucursalFilter;
      return matchesSearch && matchesMarca && matchesSucursal;
    });
  }

  function renderRecordsTable() {
    if (!dom.recordsBody || !dom.recordsFoot || !dom.recordsEmpty) return;

    if (catalog.length === 0) {
      dom.recordsBody.innerHTML = '';
      dom.recordsFoot.innerHTML = '';
      dom.recordsEmpty.hidden = false;
      return;
    }
    dom.recordsEmpty.hidden = true;

    const filteredCatalog = getFilteredCatalog();
    if (filteredCatalog.length === 0) {
      dom.recordsBody.innerHTML =
        `<tr><td colspan="${RECORDS_TABLE_COLUMNS}" class="empty-note">Ningún armazón coincide con los filtros.</td></tr>`;
      dom.recordsFoot.innerHTML = '';
      return;
    }

    const totals = { comprados: 0, vendidos: 0, stock: 0, ganancia: 0 };
    const rowsHtml = filteredCatalog.map((frame) => {
      const stats = computeFrameStats(frame);
      totals.comprados += stats.comprados;
      totals.vendidos += stats.vendidos;
      totals.stock += stats.stock;
      totals.ganancia += stats.ganancia;
      return buildRecordRow(frame, stats);
    }).join('');

    dom.recordsBody.innerHTML = rowsHtml;
    dom.recordsFoot.innerHTML = buildRecordsFooter(totals);
  }

  function buildRecordRow(frame, stats) {
    const stockClass = stats.stock <= 0 ? 'stock-low' : '';
    const gananciaClass = stats.ganancia > 0 ? 'profit-pos' : 'profit-zero';

    return `
      <tr>
        <td>${escapeHtml(frame.nombre)}</td>
        <td>${escapeHtml(frame.marca)}</td>
        <td>${escapeHtml(frame.sucursal || '—')}</td>
        <td class="num">${stats.comprados}</td>
        <td class="num">${stats.vendidos}</td>
        <td class="num ${stockClass}">${stats.stock}</td>
        <td class="num">${formatMoney(frame.precioComprado)}</td>
        <td class="num">${formatMoney(frame.precioPublico)}</td>
        <td class="num ${gananciaClass}">${formatMoney(stats.ganancia)}</td>
      </tr>`;
  }

  function buildRecordsFooter(totals) {
    return `
      <tr>
        <td>Total</td><td></td><td></td>
        <td class="num">${totals.comprados}</td>
        <td class="num">${totals.vendidos}</td>
        <td class="num">${totals.stock}</td>
        <td></td><td></td>
        <td class="num">${formatMoney(totals.ganancia)}</td>
      </tr>`;
  }

  function renderMovimientosList() {
    if (!dom.movimientosList || !dom.movimientosEmpty) return;

    const recentMovements = movimientos
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, MAX_MOVIMIENTOS_MOSTRADOS);

    if (recentMovements.length === 0) {
      dom.movimientosList.innerHTML = '';
      dom.movimientosEmpty.hidden = false;
      return;
    }
    dom.movimientosEmpty.hidden = true;
    dom.movimientosList.innerHTML = recentMovements.map(buildMovimientoItem).join('');
  }

  function buildMovimientoItem(movimiento) {
    const frame = catalog.find((f) => f.id === movimiento.frameId);
    const nombre = frame ? frame.nombre : 'Armazón eliminado';
    const marca = frame ? frame.marca : '';
    const sucursal = frame && frame.sucursal ? ` · ${escapeHtml(frame.sucursal)}` : '';
    const label = movimiento.tipo === 'compra' ? 'Compra' : 'Venta';
    const monto = formatMoney(movimiento.cantidad * movimiento.precioUnitario);

    return `
      <div class="mini-item">
        <span class="dot dot-${movimiento.tipo}"></span>
        <div class="mini-item-main">
          <div class="mini-item-title">${label} · ${movimiento.cantidad} ${escapeHtml(nombre)}</div>
          <div class="mini-item-sub">${escapeHtml(marca)}${sucursal} · ${monto} · ${formatDate(movimiento.fecha)}</div>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // 7. Arranque
  // ---------------------------------------------------------------------------

  function init() {
    cacheDomReferences();

    if (dom.searchInput) dom.searchInput.addEventListener('input', renderRecordsTable);
    if (dom.filterMarca) dom.filterMarca.addEventListener('change', renderRecordsTable);
    if (dom.filterSucursal) dom.filterSucursal.addEventListener('change', renderRecordsTable);

    loadDataFromServer();
  }

  // Ejecutar cuando el DOM está listo.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Si el script se ejecuta después de que el DOM ya esté listo, llamar directamente.
    init();
  }
})();