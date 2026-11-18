'use strict';
// Verificação antimalware dos arquivos enviados (exames, laudos, anexos da teleconsulta) pelo ClamAV (clamd, protocolo INSTREAM).
// CLAMAV_HOST/CLAMAV_PORT definem o serviço. Sem CLAMAV_HOST a verificação fica desligada (ambiente local).
// ANTIVIRUS=obrigatorio (padrão quando há CLAMAV_HOST): se o antivírus estiver fora do ar, o envio é recusado (falha fechada).
const net = require('net');
const HOST = process.env.CLAMAV_HOST || '', PORT = +process.env.CLAMAV_PORT || 3310;
const OBRIG = (process.env.ANTIVIRUS || (HOST ? 'obrigatorio' : 'desligado')) === 'obrigatorio';
const estado = { ativo: !!HOST, ultimo_ok: null, ultimo_erro: null, verificados: 0, bloqueados: 0 };
const err = (m, http) => Object.assign(new Error(m), { http });
function instream(buf, timeout = 30000) {
  return new Promise((ok, no) => {
    const s = net.connect(PORT, HOST); let resp = ''; const t = setTimeout(() => { s.destroy(); no(new Error('tempo esgotado')); }, timeout);
    s.on('connect', () => { s.write('zINSTREAM\0'); for (let i = 0; i < buf.length; i += 65536) { const c = buf.subarray(i, i + 65536), h = Buffer.alloc(4); h.writeUInt32BE(c.length); s.write(h); s.write(c); } s.write(Buffer.alloc(4)); });
    s.on('data', d => { resp += d.toString(); if (resp.includes('\0')) { clearTimeout(t); s.end(); ok(resp.replace(/\0.*$/s, '').trim()); } });
    s.on('error', e => { clearTimeout(t); no(e); });
    s.on('end', () => { clearTimeout(t); if (!resp.includes('\0')) resp ? ok(resp.trim()) : no(new Error('sem resposta')); });
  });
}
async function verificar(buf, nome = 'arquivo') {
  if (!HOST) return { verificado: false };
  let r;
  try { r = await instream(buf); }
  catch (e) { estado.ultimo_erro = e.message; if (OBRIG) throw err('A verificação antivírus está indisponível no momento. Tente enviar o arquivo de novo em alguns minutos.', 503); return { verificado: false }; }
  estado.verificados++;
  if (/FOUND$/.test(r)) { estado.bloqueados++; const v = r.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''); console.warn('antivírus bloqueou', nome, v); throw err(`O arquivo "${nome}" foi bloqueado pelo antivírus (${v}). Ele não foi salvo.`, 422); }
  if (!/OK$/.test(r)) { estado.ultimo_erro = r; if (OBRIG) throw err('O antivírus não conseguiu verificar o arquivo. Tente de novo.', 503); return { verificado: false }; }
  estado.ultimo_ok = new Date().toISOString(); return { verificado: true };
}
async function saude() { if (!HOST) return 'desligado'; try { await new Promise((ok, no) => { const s = net.connect(PORT, HOST); let r = ''; const t = setTimeout(() => { s.destroy(); no(new Error('tempo')); }, 3000);
  s.on('connect', () => s.write('zPING\0')); s.on('data', d => { r += d; if (r.includes('PONG')) { clearTimeout(t); s.end(); ok(); } }); s.on('error', e => { clearTimeout(t); no(e); }); }); return 'ok'; } catch { return 'fora do ar'; } }
module.exports = { verificar, saude, estado };
