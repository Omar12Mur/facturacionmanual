'use strict';

// Núcleo compartido: PDF Siigo → tirilla 80 mm (PDF.js + jsPDF) y tickets manuales.
(() => {
  const PAGE_W = 80, M = 3, USABLE = PAGE_W - 2 * M;
  const WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';

  // Patrones numéricos (acepta 10.000,00 / 10,000.00 / sin separadores) — se conservan como texto original
  const NUM = '\\d[\\d.,]*', TAX = '\\d{1,2}(?:[.,]\\d+)?';
  const RE_ROW = new RegExp(`^(.*?)\\s*(${NUM})\\s+(${TAX})\\s*%\\s+(${NUM})\\s+(${NUM})$`);
  const RE_P1 = new RegExp(`^(.*?)\\s*(${NUM})\\s+(${TAX})\\s*%$`);     // nombre? + cant + %
  const RE_P2 = new RegExp(`^(${NUM})\\s+(${NUM})$`);                    // unitario + total
  const RE_LABEL_NUM = new RegExp(`^(.+?)\\s+(${NUM})$`);
  const RE_HDR = /nombre\s+producto|\bcant\.?(?=\s|$)|\bimpto\.?|\bcargo\b|vr\.?\s*unitario|vr\.?\s*total/gi;
  const RE_META = /^(Fecha|Vendedor|Cliente|Nit\s*\/\s*C\.?C\.?|Direcci[oó]n|Tel[eé]fono|Forma de pago)\s*:?\s*(.*)$/i;


  // ---------- Parseo numérico (solo para verificación) ----------
  function parseNum(s) {
    let t = String(s).replace(/[^\d.,-]/g, '');
    const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
    if (lc >= 0 && ld >= 0) {
      const dec = lc > ld ? ',' : '.';
      t = dec === ',' ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    } else if (lc >= 0 || ld >= 0) {
      const sep = lc >= 0 ? ',' : '.';
      const parts = t.split(sep);
      if (parts.length > 2 || parts[1].length === 3) t = parts.join('');
      else t = parts.join('.');
    }
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : NaN;
  }

  // ---------- 1. Extracción con posiciones ----------
  async function extractLines(buf) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const lines = [], rotated = [];
    let chars = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const its = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        chars += it.str.trim().length;
        const [a, b, , , x, y] = it.transform;
        if (Math.abs(b) > 0.01 && Math.abs(a) < 0.01) { rotated.push(it.str.trim()); continue; } // texto vertical
        its.push({ x, y, w: it.width, s: it.str });
      }
      its.sort((m, n) => n.y - m.y || m.x - n.x);
      const groups = [];
      for (const it of its) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(g.y - it.y) <= 3) g.items.push(it);
        else groups.push({ y: it.y, items: [it] });
      }
      for (const g of groups) {
        g.items.sort((m, n) => m.x - n.x);
        let s = '', end = null;
        for (const it of g.items) {
          if (end !== null && it.x - end > 1.5 && !s.endsWith(' ') && !it.s.startsWith(' ')) s += ' ';
          s += it.s;
          end = it.x + it.w;
        }
        s = s.replace(/\s+/g, ' ').trim();
        if (s) lines.push(s);
      }
    }
    return { lines, rotated, chars, pdf };
  }

  // Lee el QR del PDF original: renderiza la página y lo decodifica con jsQR
  async function findQr(pdf) {
    if (typeof jsQR === 'undefined' || typeof qrcode === 'undefined') return null;
    for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 3 });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height); // fondo blanco: sin él los píxeles transparentes se leen como negro
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (r && r.data) return r.data;
    }
    return null;
  }

  // ---------- 2. Clasificación ----------
  function parse(raw, rotated) {
    const L = raw.flatMap((l) => l.replace(/(\d)(Forma de Pago)/gi, '$1\n$2').split('\n')).map((l) => l.trim()).filter(Boolean);
    const inv = { head: [], title: '', number: '', meta: [], items: [], totals: [], taxes: [], taxRows: [],
                  pay: [], legal: [], cufe: null, extra: [], total: null, notes: [] };
    const idx = (re, from = 0) => { for (let i = from; i < L.length; i++) if (re.test(L[i])) return i; return -1; };

    const iT = idx(/factura\s+(electr[oó]nica|de\s+venta)/i);
    const iH = idx(/nombre\s+producto|descripci[oó]n/i);
    let i = 0;
    if (iT > 0) {
      inv.head = L.slice(0, iT);
      i = iT;
      inv.title = L[i++];
      if (/^No\.?\s/i.test(L[i] || '')) inv.number = L[i++].replace(/^No\.?\s*/i, '');
    }
    const metaEnd = iH >= 0 ? iH : L.length;
    for (; i < metaEnd; i++) {
      const m = RE_META.exec(L[i]);
      if (m) inv.meta.push([m[1].replace(/\s+/g, ' '), m[2]]);
      else inv.extra.push(L[i]);
    }

    // Productos
    let iEnd = L.length;
    if (iH >= 0) {
      let s = iH + 1;
      const isVrTotal = (t) => /vr\.?\s*total/i.test(t || '');
      if (!isVrTotal(L[iH]) && isVrTotal(L[iH + 1])) s = iH + 2;
      iEnd = idx(/^(sub)?total\b|^IVA\s*\d|^descuento/i, s);
      if (iEnd < 0) iEnd = L.length;

      let buf = [], pend = null;
      const add = (pre, q, t, u, v) => {
        let name = [...buf, pre].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        let code = '';
        const cm = name.match(/^([A-Z]{0,3}\d{4,})\s+(.+)$/);
        if (cm) { code = cm[1]; name = cm[2]; }
        inv.items.push({ name, code, qty: q, tax: t.replace(/\s/g, ''), unit: u, total: v });
        buf = []; pend = null;
      };
      for (let k = s; k < iEnd; k++) {
        let m;
        // Quita fragmentos del encabezado repetido en otra página, aunque vengan pegados a un producto
        const line = L[k].replace(RE_HDR, ' ').replace(/\s+/g, ' ').trim();
        if (!line || /^p[aá]g(ina)?\.?\s*\d+/i.test(line)) continue;
        if ((m = RE_ROW.exec(line))) add(m[1], m[2], m[3], m[4], m[5]);
        else if ((m = RE_P1.exec(line))) pend = { pre: m[1], q: m[2], t: m[3] };
        else if (pend && (m = RE_P2.exec(line))) add(pend.pre, pend.q, pend.t, m[1], m[2]);
        else buf.push(line);
      }
      buf.forEach((b) => inv.extra.push(b));
      if (pend) inv.extra.push(`${pend.pre} ${pend.q} ${pend.t}%`.trim());
    }

    // Totales, impuestos, pago, legal
    let sec = 'tot', cufeParts = [], cufeLabel = 'CUFE';
    for (let k = iEnd; k < L.length; k++) {
      const s = L[k];
      let m;
      if (/^resumen\s+impuestos/i.test(s)) { sec = 'tax'; continue; }
      if (/^forma\s+de\s+pago/i.test(s)) { sec = 'pay'; continue; }
      if (/^(CUFE|CUDE)\b/i.test(s)) { sec = 'cufe'; cufeLabel = s.slice(0, 4).toUpperCase(); }

      if (sec === 'cufe') {
        const rest = s.replace(/^(CUFE|CUDE)\s*:?\s*/i, '');
        const len = cufeParts.join('').replace(/\s+/g, '').length;
        if (len < 96 && (rest === '' || /^[0-9a-f\s]+$/i.test(rest))) { cufeParts.push(rest); continue; }
        sec = 'post'; // texto posterior al CUFE (p. ej. cuentas bancarias)
      }
      if (sec === 'post') { inv.notes.push(s); continue; }
      if (sec === 'tot') {
        if ((m = /^total(?:\s+a\s+pagar)?\s+(\d[\d.,]*)$/i.exec(s))) { inv.total = m[1]; continue; }
        if ((m = new RegExp(`^IVA\\s*(${TAX})\\s*%\\s+(${NUM})$`, 'i').exec(s))) { inv.taxes.push([`IVA ${m[1]}%`, m[2]]); continue; }
        if ((m = RE_LABEL_NUM.exec(s)) && /^(sub\s*total|descuentos?|base|retenci|rete|propina|ico)/i.test(m[1])) { inv.totals.push([m[1], m[2]]); continue; }
        inv.extra.push(s);
      } else if (sec === 'tax') {
        if (/^tarifa/i.test(s)) continue;
        if ((m = new RegExp(`^(${TAX})\\s*%\\s+(${NUM})\\s+(${NUM})$`).exec(s))) inv.taxRows.push([m[1], m[2], m[3]]);
        else inv.extra.push(s);
      } else if (sec === 'pay') {
        if (RE_LABEL_NUM.test(s)) { const q = RE_LABEL_NUM.exec(s); inv.pay.push([q[1], q[2]]); }
        else { sec = 'legal'; inv.legal.push(s); }
      } else {
        inv.legal.push(s);
      }
    }
    if (cufeParts.length) inv.cufe = [cufeLabel, cufeParts.join('').replace(/\s+/g, '')];

    if (!inv.items.length) inv.extra = L.slice(); // conservar todo el texto original
    if (rotated.length) inv.extra.push(rotated.join(' '));
    return inv;
  }

  // Verificación (no sustituye valores)
  function checkTotals(inv) {
    if (!inv.items.length || !inv.total) return null;
    const sum = inv.items.reduce((a, it) => a + parseNum(it.total), 0);
    const tot = parseNum(inv.total);
    if (Number.isNaN(sum) || Number.isNaN(tot)) return null;
    return Math.abs(sum - tot) > 1 ? 'La suma de las líneas no coincide con el total de la factura; revisa los productos.' : null;
  }

  // ---------- 3. Diseño (layout monoespaciado) ----------
  function wrapStr(t, n) {
    const out = [];
    let cur = '';
    for (let w of String(t).split(/\s+/).filter(Boolean)) {
      while (w.length > n) {
        if (cur) { out.push(cur); cur = ''; }
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= n) cur += ' ' + w;
      else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  }

  function buildOps(inv) {
    const ops = [];
    let y = M;
    const cols = (s) => Math.floor(USABLE / (s * 0.6 * 0.35278)); // Courier: 0.6 em por carácter
    const lh = (s) => s * 0.35278 * 1.22;
    const text = (t, s, b = false, a = 'left') => { y += lh(s); ops.push({ txt: t, s, b, a, y }); };
    const wrap = (t, s, b = false, a = 'left') => wrapStr(t, cols(s)).forEach((l) => text(l, s, b, a));
    const row = (l, r, s = 8, b = false) => {
      const ls = wrapStr(l, Math.max(cols(s) - String(r).length - 1, 8));
      ls.forEach((ln, i) => {
        text(ln, s, b);
        if (i === ls.length - 1 && r) ops.push({ txt: String(r), s, b, a: 'right', y });
      });
    };
    const sep = (c = '-') => { y += 0.8; text(c.repeat(cols(8)), 8); y += 0.4; };
    const gap = (v = 1.5) => { y += v; };

    inv.head.forEach((l, i) => (i === 0 ? wrap(l, 11, true, 'center') : wrap(l, 8, false, 'center')));
    if (inv.head.length) sep('=');
    if (inv.title) wrap(inv.title, 10, true, 'center');
    if (inv.number) wrap('No. ' + inv.number, 10, true, 'center');
    if (inv.title || inv.number) sep('=');

    inv.meta.forEach(([k, v]) => wrap(`${k}: ${v}`, 8));
    if (inv.meta.length) sep();

    if (inv.items.length) {
      text('PRODUCTOS', 8, true, 'center');
      sep();
      inv.items.forEach((it) => {
        wrap((it.code ? it.code + ' ' : '') + it.name, 8, true);
        row(`${it.qty} x ${it.unit}${it.tax ? '  IVA ' + it.tax + '%' : ''}`, it.total, 8);
        gap(1.2);
      });
      sep();
    }

    inv.totals.forEach(([k, v]) => row(k, v, 8));
    inv.taxes.forEach(([k, v]) => row(k, v, 8));
    if (inv.total) { gap(1); row('TOTAL A PAGAR', inv.total, 11, true); sep('='); }

    if (inv.taxRows.length) {
      text('RESUMEN IMPUESTOS', 8, true, 'center');
      inv.taxRows.forEach(([r, base, val]) => row(`${r}% Base ${base}`, `IVA ${val}`, 8));
      sep();
    }
    if (inv.pay.length) {
      text('FORMA DE PAGO', 8, true, 'center');
      inv.pay.forEach(([k, v]) => row(k, v, 8));
      sep();
    }
    if (inv.notes && inv.notes.length) { inv.notes.forEach((l) => wrap(l, 7)); sep(); }
    if (inv.legal.length) { wrap(inv.legal.join(' '), 7, false, 'left'); gap(); }
    if (inv.cufe) { wrap(`${inv.cufe[0]}: ${inv.cufe[1]}`, 7, true); gap(); }
    if (inv.qr) {
      const q = qrcode(0, 'M');
      q.addData(inv.qr);
      q.make();
      const n = q.getModuleCount(), dark = [];
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) dark.push([r, c]);
      const size = 42;
      gap(2);
      ops.push({ qr: true, n, dark, size, y });
      y += size + 2;
    }
    if (inv.extra.length) {
      sep();
      text('INFORMACION ADICIONAL', 7, true, 'center');
      inv.extra.forEach((l) => wrap(l, 7));
    }
    sep();
    text('Gracias por su compra', 9, true, 'center');
    return { ops, height: Math.max(y + M + 4, 90) };
  }

  // ---------- 4. Render PDF (única implementación: jsPDF) ----------
  function renderPdf({ ops, height }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: [PAGE_W, height], orientation: 'portrait', compress: true });
    for (const o of ops) {
      if (o.qr) {
        const cell = o.size / (o.n + 8); // zona de silencio de 4 módulos por lado
        const x0 = (PAGE_W - o.size) / 2;
        doc.setFillColor(0, 0, 0);
        for (const [r, c] of o.dark) doc.rect(x0 + (c + 4) * cell, o.y + (r + 4) * cell, cell + 0.02, cell + 0.02, 'F');
        continue;
      }
      doc.setFont('courier', o.b ? 'bold' : 'normal');
      doc.setFontSize(o.s);
      const x = o.a === 'center' ? PAGE_W / 2 : o.a === 'right' ? PAGE_W - M : M;
      doc.text(o.txt, x, o.y, { align: o.a });
    }
    return doc.output('blob');
  }


  // ---------- API pública ----------
  const DIAN_QR = 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentKey=';

  function checkLibs(needPdf = true) {
    if (needPdf && typeof pdfjsLib === 'undefined') return 'No se cargó PDF.js. Revisa tu conexión y recarga la página.';
    if (!window.jspdf || !window.jspdf.jsPDF) return 'No se cargó jsPDF. Revisa tu conexión y recarga la página.';
    return null;
  }

  // Factura Siigo (PDF) → tirilla 80 mm.  opts: { notas: [], qrDesdeCufe: true }
  async function fromPdfFile(file, opts = {}, progress = () => {}) {
    const libErr = checkLibs();
    if (libErr) throw new Error(libErr);
    if (!file) throw new Error('No se seleccionó ningún archivo.');
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) throw new Error('El archivo no es un PDF.');
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;

    progress('Leyendo el PDF…');
    const buf = await file.arrayBuffer();
    let data;
    try { data = await extractLines(buf); }
    catch (e) {
      throw new Error(e && e.name === 'PasswordException'
        ? 'El PDF está protegido con contraseña.'
        : 'No se pudo leer el PDF (archivo corrupto o ilegible).');
    }
    if (data.chars === 0) throw new Error('El PDF no tiene texto seleccionable (parece escaneado). Se necesita OCR; esta app no lo incluye.');

    progress('Analizando la factura…');
    const inv = parse(data.lines, data.rotated);
    if (!inv.notes.length) inv.notes = opts.notas || [];

    progress('Buscando el código QR…');
    let qrSource = null;
    try { inv.qr = await findQr(data.pdf); } catch (e) { inv.qr = null; }
    if (inv.qr) qrSource = 'pdf';
    else if (opts.qrDesdeCufe !== false && inv.cufe) { inv.qr = DIAN_QR + inv.cufe[1]; qrSource = 'cufe'; }

    progress('Generando la tirilla…');
    let blob;
    try { blob = renderPdf(buildOps(inv)); }
    catch (e) { throw new Error('Error al generar el PDF: ' + e.message); }

    const warnings = [];
    if (!inv.items.length) warnings.push('La detección automática no identificó productos; se conservó el texto original.');
    const c = checkTotals(inv);
    if (c) warnings.push(c);
    return { blob, inv, warnings, qrSource };
  }

  // Ticket manual (POS). d: { head:[], title, meta:[[k,v]], items:[{name,qty,unit,total}], total, notes:[] }
  function fromManual(d) {
    const libErr = checkLibs(false);
    if (libErr) throw new Error(libErr);
    const inv = { head: [], title: '', number: '', meta: [], items: [], totals: [], taxes: [], taxRows: [],
                  pay: [], legal: [], cufe: null, extra: [], total: null, notes: [], qr: null, ...d };
    return renderPdf(buildOps(inv));
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Vista previa con canvas (funciona en Android e iOS; el <iframe> con PDF no)
  async function preview(blob, box) {
    if (typeof pdfjsLib === 'undefined') throw new Error('No se cargó PDF.js.');
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    box.innerHTML = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let scale = ((box.clientWidth || 320) * dpr) / base.width;
      const area = base.width * base.height * scale * scale;
      if (area > 12e6) scale *= Math.sqrt(12e6 / area); // límite de canvas en iOS
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      box.appendChild(c);
    }
  }

  // Compartir / imprimir con la hoja nativa del celular (Web Share)
  const archivo = (blob, name) => new File([blob], name, { type: 'application/pdf' });
  function puedeCompartir(blob, name) {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [archivo(blob, name)] })); }
    catch (e) { return false; }
  }
  async function compartir(blob, name) {
    await navigator.share({ files: [archivo(blob, name)], title: name });
  }

  window.Tirilla = { fromPdfFile, fromManual, saveBlob, preview, puedeCompartir, compartir, checkLibs, parse, buildOps, parseNum };
})();
