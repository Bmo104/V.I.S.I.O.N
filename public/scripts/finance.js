/*
 * financiero.js
 * =============================================================================
 * Panel de Finanzas — página de SOLO LECTURA.
 *
 * Flujo:
 *   1) Al cargar la página, pide los datos a Express: GET /api/lentes
 *   2) Calcula stock, unidades vendidas y ganancia por armazón
 *   3) Pinta: tarjetas de estadísticas, tabla de registros (con búsqueda,
 *      filtros de marca/sucursal y filtro de fechas) y los movimientos
 *
 * Este archivo NO guarda ni edita nada — toda la escritura vive en tu Express.
 *
 * CÓMO FUNCIONA EL FILTRO DE FECHAS (importante):
 *   - "Comprados", "Vendidos" y "Ganancia" solo cuentan lo que pasó DENTRO
 *     del rango [desde, hasta] que elige el usuario.
 *   - "Stock" es distinto: SIEMPRE es la cantidad disponible acumulada hasta
 *     la fecha "hasta" (no depende de "desde"), porque el stock es algo que
 *     existe en un momento dado, no algo que "pasa" en un rango. Por eso, con
 *     el filtro activo, la tarjeta se relabela a "Stock disponible el <fecha>".
 *   - El costo promedio (para calcular ganancia) siempre usa TODAS las
 *     compras hasta "hasta", no solo las del rango — así la ganancia sale
 *     bien aunque lo vendido se haya comprado antes del rango elegido.
 *
 * Índice:
 *   1. Referencias al DOM
 *   2. Estado en memoria (datos + filtro de fechas activo)
 *   3. Formato de texto (dinero, fechas, escape de HTML)
 *   4. Utilidades de fecha
 *   5. Cálculos (stock, ventas, ganancia)
 *   6. Carga de datos desde la API
 *   7. Filtro de fechas (abrir/cerrar panel, límites, aplicar, limpiar)
 *   8. Pintado de cada sección
 *   9. Arranque
 * =============================================================================
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Referencias al DOM
  //    Se cargan una sola vez en init(). Las funciones chequean si el
  //    elemento existe antes de usarlo, por si algún ID falta en el HTML.
  // ---------------------------------------------------------------------------
  let dom = {};

  function cacheDomReferences() {
    const getEl = (id) => document.getElementById(id);

    dom = {
      loadError: getEl('load-error'),
      filterStatus: getEl('filter-status'),

      statModelos: getEl('stat-modelos'),
      statStock: getEl('stat-stock'),
      statStockLabel: getEl('stat-stock-label'),
      statVendidos: getEl('stat-vendidos'),
      statVendidosLabel: getEl('stat-vendidos-label'),
      statGanancia: getEl('stat-ganancia'),
      statGananciaLabel: getEl('stat-ganancia-label'),

      searchInput: getEl('records-search'),
      filterMarca: getEl('records-filter-marca'),
      filterSucursal: getEl('records-filter-sucursal'),

      btnFiltrarFecha: getEl('btn-filtrar-fecha'),
      dateFilterPanel: getEl('date-filter-panel'),
      filtroDesdeInput: getEl('filtro-desde'),
      filtroHastaInput: getEl('filtro-hasta'),
      btnLimpiarFecha: getEl('btn-limpiar-fecha'),

      recordsBody: getEl('records-tbody'),
      recordsFoot: getEl('records-tfoot'),
      recordsEmpty: getEl('records-empty'),

      movimientosList: getEl('movimientos-list'),
      movimientosEmpty: getEl('movimientos-empty')
    };

    const missing = Object.entries(dom).filter(([, el]) => !el).map(([key]) => key);
    if (missing.length > 0) {
      console.warn('[financiero.js] IDs que faltaban en el HTML:', missing);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Estado en memoria
  // ---------------------------------------------------------------------------
  let catalog = [];      // armazones registrados (compartidos entre cuentas)
  let movimientos = [];  // compras/ventas (el servidor ya las filtra por cuenta)

  // Filtro de fechas: '' significa "sin límite" en ese extremo.
  let filtroDesde = '';
  let filtroHasta = '';

  const RECORDS_TABLE_COLUMNS = 9;  // debe coincidir con las <th> de financiero.html
  const MAX_MOVIMIENTOS_MOSTRADOS = 20;  // solo aplica cuando NO hay filtro de fechas

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
  // 4. Utilidades de fecha
  // ---------------------------------------------------------------------------

  /** Hoy, en formato "YYYY-MM-DD" — el día en que se está consultando. */
  function getTodayISO() {
    return new Date().toISOString().split('T')[0];
  }

  /** La fecha del movimiento más antiguo registrado (o null si no hay ninguno). */
  function getEarliestMovimientoDate() {
    return movimientos.reduce((min, m) => (!min || m.fecha < min ? m.fecha : min), null);
  }

  /** ¿fecha está dentro de [desde, hasta]? Un extremo vacío significa "sin límite". */
  function isDateInRange(fecha, desde, hasta) {
    if (desde && fecha < desde) return false;
    if (hasta && fecha > hasta) return false;
    return true;
  }

  /** ¿Hay un filtro de fechas activo (al menos un extremo elegido)? */
  function isDateFilterActive() {
    return Boolean(filtroDesde || filtroHasta);
  }

  function sumBy(items, getValue) {
    return items.reduce((total, item) => total + Number(getValue(item)), 0);
  }

  // ---------------------------------------------------------------------------
  // 5. Cálculos
  // ---------------------------------------------------------------------------

  /**
   * Compras, ventas, stock y ganancia de UN armazón.
   *
   * - "stock" siempre es la cantidad acumulada disponible hasta el final del
   *   rango (o hasta hoy, si no hay filtro) — no depende de "desde".
   * - "comprados"/"vendidos"/"ganancia" solo cuentan movimientos dentro del
   *   rango cuando el filtro está activo; si no hay filtro, cuentan todo el
   *   historial (mismo comportamiento de siempre).
   * - El costo promedio para la ganancia siempre se calcula con TODAS las
   *   compras hasta el final del rango, no solo las que caen dentro de él.
   */
  function computeFrameStats(frame) {
    const hasta = filtroHasta || getTodayISO();
    const desde = isDateFilterActive() ? (filtroDesde || getEarliestMovimientoDate() || hasta) : null;

    const todasLasCompras = movimientos.filter((m) => m.frameId === frame.id && m.tipo === 'compra');
    const todasLasVentas = movimientos.filter((m) => m.frameId === frame.id && m.tipo === 'venta');

    // Stock disponible al final del rango (acumulado, sin importar "desde").
    const compradasHastaFin = todasLasCompras.filter((m) => m.fecha <= hasta);
    const vendidasHastaFin = todasLasVentas.filter((m) => m.fecha <= hasta);
    const stock = sumBy(compradasHastaFin, (m) => m.cantidad) - sumBy(vendidasHastaFin, (m) => m.cantidad);

    // Movimientos "del período" para comprados/vendidos/ganancia.
    const comprasEnRango = isDateFilterActive()
      ? todasLasCompras.filter((m) => isDateInRange(m.fecha, desde, hasta))
      : todasLasCompras;
    const ventasEnRango = isDateFilterActive()
      ? todasLasVentas.filter((m) => isDateInRange(m.fecha, desde, hasta))
      : todasLasVentas;

    const comprados = sumBy(comprasEnRango, (m) => m.cantidad);
    const vendidos = sumBy(ventasEnRango, (m) => m.cantidad);
    const ingresos = sumBy(ventasEnRango, (m) => m.cantidad * m.precioUnitario);

    const unidadesCompradasHastaFin = sumBy(compradasHastaFin, (m) => m.cantidad);
    const costoTotalHastaFin = sumBy(compradasHastaFin, (m) => m.cantidad * m.precioUnitario);
    const costoPromedio = unidadesCompradasHastaFin > 0
      ? costoTotalHastaFin / unidadesCompradasHastaFin
      : Number(frame.precioComprado) || 0;

    const ganancia = ingresos - vendidos * costoPromedio;

    return { comprados, vendidos, stock, ganancia };
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
  // 6. Carga de datos desde la API
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
    updateDateFilterBounds();
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // 7. Filtro de fechas
  // ---------------------------------------------------------------------------

  /** Muestra u oculta el panel con los dos calendarios. */
  function toggleDateFilterPanel() {
    if (!dom.dateFilterPanel) return;
    dom.dateFilterPanel.hidden = !dom.dateFilterPanel.hidden;
  }

  /**
   * Limita lo que se puede elegir en los dos calendarios:
   *   - Nunca antes del primer movimiento registrado.
   *   - Nunca después de hoy.
   *   - "Hasta" nunca antes de lo que ya esté puesto en "Desde" (y viceversa),
   *     para que seleccionar un solo día (mismo valor en ambos) siempre sea válido.
   * Si todavía no hay ningún movimiento, no hay rango posible: se deshabilita el botón.
   */
  function updateDateFilterBounds() {
    const earliest = getEarliestMovimientoDate();
    const today = getTodayISO();

    if (dom.btnFiltrarFecha) {
      dom.btnFiltrarFecha.disabled = !earliest;
      dom.btnFiltrarFecha.title = earliest ? '' : 'Todavía no hay movimientos registrados';
    }
    if (!earliest) return;

    if (dom.filtroDesdeInput) {
      dom.filtroDesdeInput.min = earliest;
      dom.filtroDesdeInput.max = dom.filtroHastaInput.value || today;
    }
    if (dom.filtroHastaInput) {
      dom.filtroHastaInput.min = dom.filtroDesdeInput.value || earliest;
      dom.filtroHastaInput.max = today;
    }
  }

  /** Se llama cuando el usuario cambia cualquiera de los dos calendarios. */
  function handleDateFilterChange() {
    filtroDesde = dom.filtroDesdeInput ? dom.filtroDesdeInput.value : '';
    filtroHasta = dom.filtroHastaInput ? dom.filtroHastaInput.value : '';
    updateDateFilterBounds();  // recalcula los límites cruzados (desde <= hasta)
    renderAll();
  }

  /** Botón "Limpiar filtro": vuelve a mostrar todo el historial. */
  function clearDateFilter() {
    filtroDesde = '';
    filtroHasta = '';
    if (dom.filtroDesdeInput) dom.filtroDesdeInput.value = '';
    if (dom.filtroHastaInput) dom.filtroHastaInput.value = '';
    updateDateFilterBounds();
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // 8. Pintado de cada sección
  // ---------------------------------------------------------------------------

  function renderAll() {
    renderStats();
    renderFilterStatus();
    renderFilterOptions();
    renderRecordsTable();
    renderMovimientosList();
  }

  function renderStats() {
    const stats = computeGlobalStats();
    const activo = isDateFilterActive();

    if (dom.statModelos) dom.statModelos.textContent = stats.modelos;

    if (dom.statStock) dom.statStock.textContent = stats.stock;
    if (dom.statStockLabel) {
      dom.statStockLabel.textContent = activo
        ? `Stock disponible el ${formatDate(filtroHasta || getTodayISO())}`
        : 'Unidades en stock';
    }

    if (dom.statVendidos) dom.statVendidos.textContent = stats.vendidos;
    if (dom.statVendidosLabel) {
      dom.statVendidosLabel.textContent = activo ? 'Vendidas en el período' : 'Unidades vendidas';
    }

    if (dom.statGanancia) dom.statGanancia.textContent = formatMoney(stats.ganancia);
    if (dom.statGananciaLabel) {
      dom.statGananciaLabel.textContent = activo ? 'Ganancia del período' : 'Ganancia total';
    }
  }

  /** Línea de texto que deja explícito qué rango se está mostrando ahora mismo. */
  function renderFilterStatus() {
    const activo = isDateFilterActive();
    if (dom.btnFiltrarFecha) dom.btnFiltrarFecha.classList.toggle('active', activo);
    if (!dom.filterStatus) return;

    if (!activo) {
      dom.filterStatus.textContent = 'Mostrando: todo el historial';
      return;
    }

    const desdeTexto = formatDate(filtroDesde || getEarliestMovimientoDate());
    const hastaTexto = formatDate(filtroHasta || getTodayISO());
    const mismoDia = filtroDesde && filtroHasta && filtroDesde === filtroHasta;

    dom.filterStatus.textContent = mismoDia
      ? `Mostrando: ${desdeTexto}`
      : `Mostrando: del ${desdeTexto} al ${hastaTexto}`;
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
    const searchTerm = dom.searchInput ? dom.searchInput.value.trim().toLowerCase() : '';
    const marcaFilter = dom.filterMarca ? dom.filterMarca.value : '';
    const sucursalFilter = dom.filterSucursal ? dom.filterSucursal.value : '';

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

    let lista = movimientos.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (isDateFilterActive()) {
      const desde = filtroDesde || getEarliestMovimientoDate();
      const hasta = filtroHasta || getTodayISO();
      lista = lista.filter((m) => isDateInRange(m.fecha, desde, hasta));
    } else {
      lista = lista.slice(0, MAX_MOVIMIENTOS_MOSTRADOS);
    }

    if (lista.length === 0) {
      dom.movimientosList.innerHTML = '';
      dom.movimientosEmpty.textContent = isDateFilterActive()
        ? 'No hay movimientos en el rango de fechas seleccionado.'
        : 'Todavía no hay compras ni ventas registradas.';
      dom.movimientosEmpty.hidden = false;
      return;
    }
    dom.movimientosEmpty.hidden = true;
    dom.movimientosList.innerHTML = lista.map(buildMovimientoItem).join('');
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

  const toggleBtn = document.querySelector('.btn-date-toggle');
  const filterPanel = document.querySelector('.date-filter-panel');
  
  toggleBtn.addEventListener('click', () => {
    toggleBtn.classList.toggle('active');
    filterPanel.classList.toggle('open');
  });

  // ---------------------------------------------------------------------------
  // 9. Arranque
  // ---------------------------------------------------------------------------

  function init() {
    cacheDomReferences();

    if (dom.searchInput) dom.searchInput.addEventListener('input', renderRecordsTable);
    if (dom.filterMarca) dom.filterMarca.addEventListener('change', renderRecordsTable);
    if (dom.filterSucursal) dom.filterSucursal.addEventListener('change', renderRecordsTable);

    if (dom.btnFiltrarFecha) dom.btnFiltrarFecha.addEventListener('click', toggleDateFilterPanel);
    if (dom.filtroDesdeInput) dom.filtroDesdeInput.addEventListener('change', handleDateFilterChange);
    if (dom.filtroHastaInput) dom.filtroHastaInput.addEventListener('change', handleDateFilterChange);
    if (dom.btnLimpiarFecha) dom.btnLimpiarFecha.addEventListener('click', clearDateFilter);

    loadDataFromServer();
  }

  // Ejecutar cuando el DOM está listo (o de inmediato si ya lo está).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();