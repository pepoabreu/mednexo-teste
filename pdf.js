'use strict';
// Gerador de PDF mínimo, sem dependências: A4, Helvetica (WinAnsi), quebra de linha, vários blocos, marca d'água, rodapé e paginação.
const zlib = require('zlib');
const W = 595.28, H = 841.89, M = 48;
const WR = '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584'.split(' ').map(Number);
const WB = '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584'.split(' ').map(Number);
const CP = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const enc = s => { const o = []; for (const ch of String(s).replace(/\t/g, '    ')) { const c = ch.codePointAt(0); o.push(c < 256 && c >= 32 ? c : CP[ch] || (c === 0x2714 ? 0x2a : c === 0x25cf ? 0x95 : 0x3f)); } return Buffer.from(o); };
const baseCh = ch => { const c = ch.codePointAt(0); if (c >= 32 && c <= 126) return c; const d = ch.normalize('NFD')[0].codePointAt(0); return d >= 32 && d <= 126 ? d : 0x6e; };
const tw = (s, size, bold) => { let w = 0; for (const ch of s) { const k = baseCh(ch) - 32; w += (bold ? WB : WR)[k] || 556; } return w * size / 1000; };
const esc = b => Buffer.from(b.toString('latin1').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'), 'latin1');
function wrap(text, size, bold, maxw) {
  const out = [];
  for (const par of String(text).split(/\r?\n/)) {
    if (!par.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of par.split(/\s+/)) {
      if (!word) continue; let cand = line ? line + ' ' + word : word;
      if (tw(cand, size, bold) <= maxw) { line = cand; continue; }
      if (line) { out.push(line); line = ''; }
      if (tw(word, size, bold) <= maxw) { line = word; continue; }
      let part = ''; for (const ch of word) { if (tw(part + ch, size, bold) > maxw) { out.push(part); part = ch; } else part += ch; } line = part;
    }
    out.push(line);
  }
  return out;
}
// doc: { titulo, cabecalho:[{t,bold,size}], ident:[[k,v]], blocos:[{t:'h'|'p'|'kv'|'li'|'sp'|'sig', ...}], marca, rodape }
function build(doc) {
  const pages = []; let cur = null, y = 0;
  const novaPagina = () => { cur = []; pages.push(cur); y = H - M; };
  const need = h => { if (y - h < M + 34) novaPagina(); };
  const txt = (s, x, size, bold, gray) => { cur.push(Buffer.concat([Buffer.from(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${gray != null ? gray + ' g' : '0 g'} ${x.toFixed(2)} ${y.toFixed(2)} Td (`), esc(enc(s)), Buffer.from(') Tj ET\n')])); };
  const linha = (x1, x2, g = 0.75) => cur.push(Buffer.from(`${g} G 0.6 w ${x1} ${y.toFixed(2)} m ${x2} ${y.toFixed(2)} l S\n`));
  const par = (s, { size = 10, bold = false, x = M, gap = 3, gray, indent = 0, lead = 1.32 } = {}) => { for (const l of wrap(s, size, bold, W - M - x - indent)) { need(size * lead); y -= size * lead; if (l) txt(l, x + indent, size, bold, gray); } y -= gap; };
  novaPagina();
  for (const c of doc.cabecalho || []) par(c.t, { size: c.size || 10, bold: !!c.bold, gap: 1, gray: c.gray });
  y -= 4; linha(M, W - M, 0.3); y -= 6;
  par(doc.titulo, { size: 15, bold: true, gap: 6 });
  if (doc.ident && doc.ident.length) { // caixa de identificação
    const lines = doc.ident.map(([k, v]) => [k, String(v == null || v === '' ? '—' : v)]); const h = lines.length * 14 + 10; need(h);
    cur.push(Buffer.from(`0.96 g ${M} ${(y - h).toFixed(2)} ${W - 2 * M} ${h} re f\n`)); y -= 6;
    for (const [k, v] of lines) { y -= 13; txt(k + ':', M + 8, 9, true); const kw = tw(k + ': ', 9, true) + 8; txt(v.slice(0, 120), M + kw + 6, 9, false); }
    y -= 8;
  }
  for (const b of doc.blocos || []) {
    if (b.t === 'h') { y -= 6; need(24); par(b.v, { size: 11, bold: true, gap: 2 }); linha(M, W - M, 0.85); y -= 2; }
    else if (b.t === 'p') par(b.v, { size: b.size || 10, gap: 4, gray: b.gray });
    else if (b.t === 'kv') par(`${b.k}: ${b.v}`, { size: 10, gap: 2 });
    else if (b.t === 'li') par('•  ' + b.v, { size: 10, gap: 3, indent: 8 });
    else if (b.t === 'sp') y -= b.h || 8;
    else if (b.t === 'sig') { need(86); y -= 10; linha(M, M + 250, 0.3); y -= 12; par(b.nome, { size: 10, bold: true, gap: 0 }); par(b.linha2, { size: 9, gap: 4 }); for (const l of b.extra || []) par(l, { size: 7.5, gap: 1, gray: 0.35 }); }
  }
  // páginas -> objetos
  const N = pages.length, objs = []; const add = b => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add(''); // 2 = Pages (preenchido depois)
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  pages.forEach((cont, i) => {
    let extra = [];
    if (doc.marca) extra.push(Buffer.from(`q 0.88 g BT /F2 64 Tf ${Math.cos(0.7854).toFixed(4)} ${Math.sin(0.7854).toFixed(4)} ${(-Math.sin(0.7854)).toFixed(4)} ${Math.cos(0.7854).toFixed(4)} 110 250 Tm (${doc.marca}) Tj ET Q\n`));
    const rod = `${doc.rodape || ''}  ·  Página ${i + 1} de ${N}`;
    extra.push(Buffer.concat([Buffer.from(`0.5 G 0.5 w ${M} 40 m ${W - M} 40 l S BT /F1 7.5 Tf 0.35 g ${M} 29 Td (`), esc(enc(rod)), Buffer.from(') Tj ET\n')]));
    const data = zlib.deflateSync(Buffer.concat([...extra, ...cont]));
    const cid = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from('\nendstream')]));
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`));
  });
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${N} >>`, 'latin1');
  const info = add(Buffer.concat([Buffer.from('<< /Title ('), esc(enc(doc.titulo.slice(0, 120))), Buffer.from(') /Producer (MEDNEXO) /CreationDate (D:' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z) >>')]));
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const off = []; let pos = parts[0].length;
  objs.forEach((o, i) => { off.push(pos); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]); parts.push(b); pos += b.length; });
  let xr = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  parts.push(Buffer.from(xr + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}
module.exports = { build };
