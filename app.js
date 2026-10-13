'use strict';

// ====== Ajustes del negocio (editables) ======
const CONFIG = {
  archivo: 'ticket_80mm.pdf',
  qrDesdeCufe: true, // si no se lee el QR del PDF, se genera con el CUFE (URL de la DIAN)
  notas: [
    'Favor consignar en las siguientes cuentas:',
    '- Banco Caja Social Corriente N° 21004444661',
    '- Bancolombia Ahorros N° 54700001288',
    'A nombre de COMESTIBLES LA VILLA S.A.S.'
  ]
};

const $ = (s) => document.querySelector(s);
const fmt = (n) => n.toLocaleString('es-CO');
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const KEY = 'lavilla-pos-v2';
const S = { m: 1, cat: 'Todos', q: '', cart: [], cliente: '' };
let toastT;

function toast(msg, tipo = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + tipo;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2800);
}

// ====== Persistencia (la venta no se pierde al recargar) ======
function guardar() {
  try { localStorage.setItem(KEY, JSON.stringify({ m: S.m, cart: S.cart, cliente: S.cliente })); } catch (e) { /* sin almacenamiento */ }
}
function cargar() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || '{}');
    S.m = d.m === 2 ? 2 : 1;
    S.cliente = typeof d.cliente === 'string' ? d.cliente : '';
    S.cart = Array.isArray(d.cart) ? d.cart.filter((i) => i && i.n && i.p > 0 && i.q > 0) : [];
  } catch (e) { S.cart = []; }
}

// ====== Venta manual ======
const precio = (p) => (S.m === 1 ? p.p1 : p.p2);
const enCarrito = (n, p) => S.cart.find((i) => i.n === n && i.p === p);
const totalVenta = () => S.cart.reduce((a, i) => a + i.q * i.p, 0);

function pintarCats() {
  const cats = ['Todos', ...new Set(PRODUCTOS.map((p) => p.c))];
  $('#cats').innerHTML = cats.map((c) => `<button class="chip${c === S.cat ? ' on' : ''}" data-c="${c}">${c}</button>`).join('');
}

function pintarGrid() {
  const q = norm(S.q.trim());
  const lista = PRODUCTOS.map((p, i) => ({ p, i }))
    .filter(({ p }) => (S.cat === 'Todos' || p.c === S.cat) && norm(p.n).includes(q));
  $('#grid').innerHTML = lista.length
    ? lista.map(({ p, i }) => {
        const it = enCarrito(p.n, precio(p));
        return `<button class="item${it ? ' in' : ''}" data-i="${i}">${it ? `<span class="b">${it.q}</span>` : ''}<span class="n">${p.n}</span><span class="p">$${fmt(precio(p))}</span></button>`;
      }).join('')
    : '<p class="sin">No hay productos con ese filtro.</p>';
}

function pintarCarrito() {
  $('#lista').innerHTML = S.cart.map((it, i) => `
    <li class="li">
      <span class="n">${it.n}</span><span class="s">$${fmt(it.q * it.p)}</span>
      <span class="u">$${fmt(it.p)} c/u</span>
      <span class="step">
        <button data-a="menos" data-i="${i}" aria-label="Quitar uno">−</button>
        <input type="number" min="1" inputmode="numeric" value="${it.q}" data-i="${i}" aria-label="Cantidad">
        <button data-a="mas" data-i="${i}" aria-label="Agregar uno">+</button>
        <button class="x" data-a="del" data-i="${i}" aria-label="Eliminar">✕</button>
      </span>
    </li>`).join('');
  const vacio = !S.cart.length;
  $('#vacio').hidden = !vacio;
  const t = '$' + fmt(totalVenta());
  $('#total').textContent = t;
  $('#barTotal').textContent = t;
  const un = S.cart.reduce((a, i) => a + i.q, 0);
  $('#barCount').textContent = vacio ? 'Sin productos' : `${un} ${un === 1 ? 'producto' : 'productos'} ▴`;
  $('#generar').disabled = $('#barBtn').disabled = vacio;
  $('#cliente').value = S.cliente;
  document.querySelectorAll('#precios button').forEach((b) => b.classList.toggle('on', +b.dataset.m === S.m));
}

function refrescar() { pintarGrid(); pintarCarrito(); guardar(); }

function agregar(idx) {
  const p = PRODUCTOS[idx];
  const it = enCarrito(p.n, precio(p));
  if (it) it.q += 1; else S.cart.push({ n: p.n, p: precio(p), q: 1 });
  refrescar();
}

// Ticket manual → vista previa → descargar / compartir
let dlgBlob = null, dlgName = '';
const dlg = $('#dlg');
function abrirDialogo() {
  $('#dlgVisor').innerHTML = '<p class="cargando">Generando vista previa…</p>';
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); // iOS < 15.4 no trae <dialog>
  bloquear();
}
function cerrarDialogo() {
  if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  $('#dlgVisor').innerHTML = '';
  bloquear();
}

// En celulares la venta actual es un panel que sube desde abajo
const panel = $('#cart');
const movil = window.matchMedia('(max-width: 860px)');
function bloquear() { // evita que la página de fondo se desplace mientras hay un panel abierto
  document.body.classList.toggle('lock', panel.classList.contains('open') || dlg.hasAttribute('open'));
}
function abrirCarrito() {
  if (!movil.matches) return;
  panel.classList.add('open');
  $('#sheetBg').classList.add('on');
  $('#barVer').setAttribute('aria-expanded', 'true');
  bloquear();
}
function cerrarCarrito() {
  panel.classList.remove('open');
  $('#sheetBg').classList.remove('on');
  $('#barVer').setAttribute('aria-expanded', 'false');
  bloquear();
}
function generarTicket() {
  if (!S.cart.length) return;
  const ahora = new Date();
  const items = S.cart.map((i) => ({ name: i.n, qty: String(i.q), unit: '$' + fmt(i.p), total: '$' + fmt(i.q * i.p) }));
  const meta = [];
  if (S.cliente.trim()) meta.push(['Cliente', S.cliente.trim()]);
  meta.push(['Fecha', `${ahora.toLocaleDateString('es-CO')} ${ahora.toLocaleTimeString('es-CO')}`]);
  try {
    dlgBlob = Tirilla.fromManual({ head: [], title: 'TICKET', meta, items, total: '$' + fmt(totalVenta()) });
    dlgName = `ticket_${ahora.toISOString().slice(0, 10)}.pdf`;
  } catch (e) { toast('No se pudo generar el ticket: ' + e.message, 'error'); return; }
  abrirDialogo();
  $('#dlgCompartir').hidden = !Tirilla.puedeCompartir(dlgBlob, dlgName);
  Tirilla.preview(dlgBlob, $('#dlgVisor')).catch(() => {
    $('#dlgVisor').innerHTML = '<p class="cargando">No se pudo mostrar la vista previa, pero puedes descargar el ticket.</p>';
  });
}
function descargarTicket() {
  if (!dlgBlob) return;
  try {
    Tirilla.saveBlob(dlgBlob, dlgName);
    cerrarDialogo();
    cerrarCarrito();
    S.cart = []; S.cliente = '';
    refrescar();
    toast('Ticket descargado. Venta reiniciada ✅');
  } catch (e) { toast('Error al descargar: ' + e.message, 'error'); }
}
async function compartir(blob, name) {
  try { await Tirilla.compartir(blob, name); }
  catch (e) { if (e.name !== 'AbortError') toast('No se pudo compartir: ' + e.message, 'error'); }
}

// ====== Factura Siigo ======
const sg = { ocupado: false, blob: null };
function estado(msg, tipo = '') { const e = $('#estado'); e.textContent = msg; e.className = 'estado ' + tipo; }
function limpiarSiigo() {
  sg.blob = null;
  $('#visor').innerHTML = '';
  $('#resultado').hidden = true;
}
async function procesarPDF(file) {
  if (sg.ocupado) { estado('Ya hay un archivo en proceso. Espera a que termine.', 'error'); return; }
  if (!file) { estado('Selecciona un PDF.', 'error'); return; }
  sg.ocupado = true;
  limpiarSiigo();
  try {
    const r = await Tirilla.fromPdfFile(file, { notas: CONFIG.notas, qrDesdeCufe: CONFIG.qrDesdeCufe }, (m) => estado(m, 'busy'));
    sg.blob = r.blob;
    $('#resultado').hidden = false;
    $('#btnCompartir').hidden = !Tirilla.puedeCompartir(r.blob, CONFIG.archivo);
    Tirilla.preview(r.blob, $('#visor')).catch(() => {
      $('#visor').innerHTML = '<p class="cargando">No se pudo mostrar la vista previa, pero puedes descargar la tirilla.</p>';
    });
    const qr = { pdf: 'QR leído del PDF.', cufe: 'QR generado con el CUFE (no se pudo leer el del PDF).' }[r.qrSource] || 'Sin QR.';
    estado([`Tirilla lista: ${r.inv.items.length} productos.`, qr, ...r.warnings].join(' '), r.warnings.length ? 'warn' : 'ok');
  } catch (e) {
    limpiarSiigo();
    estado(e.message || 'Error inesperado.', 'error');
  } finally {
    sg.ocupado = false;
    $('#pdfInput').value = ''; // permite volver a elegir el mismo archivo
  }
}
function descargarSiigo() {
  if (!sg.blob) return;
  try { Tirilla.saveBlob(sg.blob, CONFIG.archivo); } catch (e) { estado('Error al descargar: ' + e.message, 'error'); }
}

// ====== Eventos ======
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === b));
  $('#pos').hidden = b.dataset.tab !== 'pos';
  $('#siigo').hidden = b.dataset.tab !== 'siigo';
  $('#bar').classList.toggle('on', b.dataset.tab === 'pos');
}));
$('#buscar').addEventListener('input', (e) => { S.q = e.target.value; pintarGrid(); });
$('#cats').addEventListener('click', (e) => { const c = e.target.closest('[data-c]'); if (c) { S.cat = c.dataset.c; pintarCats(); pintarGrid(); } });
$('#precios').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) { S.m = +b.dataset.m; refrescar(); } });
$('#grid').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) agregar(+b.dataset.i); });
$('#lista').addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const i = +b.dataset.i;
  if (b.dataset.a === 'mas') S.cart[i].q += 1;
  else if (b.dataset.a === 'menos') S.cart[i].q = Math.max(1, S.cart[i].q - 1);
  else S.cart.splice(i, 1);
  refrescar();
});
$('#lista').addEventListener('change', (e) => {
  if (e.target.matches('input[data-i]')) {
    const n = parseInt(e.target.value, 10);
    if (n > 0) S.cart[+e.target.dataset.i].q = n; else toast('Cantidad no válida.', 'error');
    refrescar();
  }
});
$('#cliente').addEventListener('input', (e) => { S.cliente = e.target.value; guardar(); });
$('#limpiar').addEventListener('click', () => {
  if (S.cart.length && confirm('¿Vaciar la venta actual?')) { S.cart = []; refrescar(); }
});
$('#generar').addEventListener('click', generarTicket);
$('#barBtn').addEventListener('click', generarTicket);
$('#dlgCerrar').addEventListener('click', cerrarDialogo);
$('#dlgCompartir').addEventListener('click', () => compartir(dlgBlob, dlgName));
$('#dlgDescargar').addEventListener('click', descargarTicket);
$('#barVer').addEventListener('click', abrirCarrito);
$('#cartCerrar').addEventListener('click', cerrarCarrito);
$('#sheetBg').addEventListener('click', cerrarCarrito);
dlg.addEventListener('click', (e) => { if (e.target === dlg) cerrarDialogo(); }); // toque fuera del diálogo
dlg.addEventListener('close', () => { $('#dlgVisor').innerHTML = ''; bloquear(); }); // también cubre la tecla Esc
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dlg.hasAttribute('open')) cerrarCarrito(); });
if (movil.addEventListener) movil.addEventListener('change', cerrarCarrito); else movil.addListener(cerrarCarrito); // al girar o ampliar la pantalla

$('#pdfInput').addEventListener('change', (e) => procesarPDF(e.target.files[0]));
$('#btnDescargar').addEventListener('click', descargarSiigo);
$('#btnCompartir').addEventListener('click', () => compartir(sg.blob, CONFIG.archivo));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => procesarPDF(e.dataTransfer.files[0]));

// ====== Inicio ======
cargar();
pintarCats();
refrescar();
$('#bar').classList.add('on');
