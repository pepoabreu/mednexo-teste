'use strict';
// Monitor IAVTech: painel privado (um único dono) que acompanha, somente leitura, tudo o que está na conta Hostinger:
// servidores VPS (estado, CPU, memória, disco, rede), projetos Docker e containers, backups, domínios, assinaturas e sites;
// e verifica de fora se os endereços públicos respondem. Nunca chama operações de escrita na Hostinger.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env, PORT = +E.PORT || 8090, API = E.HOSTINGER_API_BASE || 'https://developers.hostinger.com', TOKEN = E.HOSTINGER_API_TOKEN || '';
const DADOS = E.MONITOR_DADOS || '/dados'; try { fs.mkdirSync(DADOS, { recursive: true }); } catch {}
const URLS = (E.MONITOR_URLS || 'https://mednexo.iavtech.com.br/|https://mednexo.iavtech.com.br/sistema/|https://mednexo.iavtech.com.br/portal|https://mednexo.iavtech.com.br/health').split('|').map(s => s.trim()).filter(Boolean);
const INTERVALO = Math.max(60, +E.MONITOR_INTERVALO_S || 300) * 1000;

// ---------------- autenticação: senha + código do autenticador (TOTP), sessão curta, bloqueio por tentativas
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const deb32 = s => { let b = ''; for (const c of String(s).replace(/[\s=]/g, '').toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) b += v.toString(2).padStart(5, '0'); } const o = []; for (let i = 0; i + 8 <= b.length; i += 8) o.push(parseInt(b.slice(i, i + 8), 2)); return Buffer.from(o); };
const hotp = (k, n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); const h = crypto.createHmac('sha1', k).update(b).digest(), o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0'); };
let ultimoPasso = 0;
function totpOk(c) { if (!E.MONITOR_TOTP || !/^\d{6}$/.test(String(c || ''))) return false; const k = deb32(E.MONITOR_TOTP), p = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) { const n = p + d; if (n > ultimoPasso && crypto.timingSafeEqual(Buffer.from(hotp(k, n)), Buffer.from(String(c)))) { ultimoPasso = n; return true; } } return false; }
function senhaOk(s) { const h = String(E.MONITOR_SENHA_HASH || '').replace(/^['"]|['"]$/g, ''); const [, salt, dig] = h.split(/[$:]/); if (!salt || !dig) return false;
  const x = crypto.scryptSync(String(s || ''), Buffer.from(salt, 'hex'), 32, { N: 16384 }); return crypto.timingSafeEqual(x, Buffer.from(dig, 'hex')); }
const sessoes = new Map(), falhas = { n: 0, ate: 0 };
const cookie = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]));
const logado = req => { const t = cookie(req).mon, s = t && sessoes.get(t); if (!s || s.exp < Date.now()) { if (t) sessoes.delete(t); return false; } s.exp = Math.min(s.exp, Date.now() + 2 * 3600e3); return true; };

// ---------------- coleta (somente GET)
async function hg(p) {
  const r = await fetch(API + p, { method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json', 'User-Agent': 'iavtech-monitor' }, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${r.status} ${typeof j === 'object' ? (j.message || j.error || JSON.stringify(j).slice(0, 160)) : String(j).slice(0, 160)}`); return j;
}
const tenta = async (f) => { try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, erro: e.message }; } };
const ultimo = o => { if (!o || !o.usage) return null; const k = Object.keys(o.usage).sort().pop(); return k ? { t: +k * 1000, v: o.usage[k] } : null; };
const serie = o => o && o.usage ? Object.entries(o.usage).sort((a, b) => a[0] - b[0]).map(([t, v]) => [+t * 1000, v]) : [];
async function checaUrl(u) { const t0 = Date.now(); try { const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'iavtech-monitor' } });
    let corpo = null; if (/\/health$/.test(u)) corpo = await r.json().catch(() => null); return { url: u, status: r.status, ok: r.status < 400, ms: Date.now() - t0, corpo }; }
  catch (e) { return { url: u, status: 0, ok: false, ms: Date.now() - t0, erro: e.cause && e.cause.code || e.message }; } }

let estado = { coletado_em: null, vms: [], dominios: null, assinaturas: null, sites: null, urls: [], alertas: [], erro: null };
const historico = (() => { try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'historico.json'), 'utf8')); } catch { return { urls: {}, alertas: [] }; } })();
const salva = () => fs.promises.writeFile(path.join(DADOS, 'historico.json'), JSON.stringify(historico)).catch(() => {});
async function coletar() {
  const novo = { coletado_em: new Date().toISOString(), vms: [], urls: [], alertas: [] };
  if (!TOKEN) novo.erro = 'HOSTINGER_API_TOKEN não configurado.';
  else {
    const vl = await tenta(() => hg('/api/vps/v1/virtual-machines'));
    if (!vl.ok) novo.erro = 'Hostinger: ' + vl.erro;
    for (const vm of vl.ok ? vl.v : []) {
      const agora = new Date(), de = new Date(agora - 24 * 3600e3);
      const [met, dock, bk] = await Promise.all([
        tenta(() => hg(`/api/vps/v1/virtual-machines/${vm.id}/metrics?date_from=${de.toISOString()}&date_to=${agora.toISOString()}`)),
        tenta(() => hg(`/api/vps/v1/virtual-machines/${vm.id}/docker`)),
        tenta(() => hg(`/api/vps/v1/virtual-machines/${vm.id}/backups`))]);
      const m = met.ok ? met.v : {};
      const projetos = [];
      for (const p of dock.ok && Array.isArray(dock.v) ? dock.v : []) {
        const c = p.containers ? { ok: true, v: p.containers } : await tenta(() => hg(`/api/vps/v1/virtual-machines/${vm.id}/docker/${encodeURIComponent(p.name)}/containers`));
        projetos.push({ nome: p.name, estado: p.state, status: p.status, containers: (c.ok ? c.v : []).map(x => ({ nome: x.name, imagem: x.image, estado: x.state, status: x.status, cpu: x.stats && x.stats.cpu_percentage, mem: x.stats && x.stats.memory_used,
          portas: (x.ports || []).filter(q => q.type === 'published').map(q => `${q.host_ip === '0.0.0.0' || q.host_ip === '::' ? 'pública' : q.host_ip}:${q.host_port}`).filter((v, i, a) => a.indexOf(v) === i) })), erro: c.ok ? null : c.erro });
      }
      const bks = bk.ok ? (bk.v.data || bk.v || []) : [];
      novo.vms.push({ id: vm.id, nome: vm.hostname, plano: vm.plan, estado: vm.state, ip: (vm.ipv4 || [])[0] && vm.ipv4[0].address, cpus: vm.cpus, memoria_mb: vm.memory, disco_mb: vm.disk, so: vm.template && vm.template.name,
        cpu: ultimo(m.cpu_usage), ram: ultimo(m.ram_usage), disco: ultimo(m.disk_space), uptime: ultimo(m.uptime),
        series: { cpu: serie(m.cpu_usage), ram: serie(m.ram_usage), entrada: serie(m.incoming_traffic), saida: serie(m.outgoing_traffic) },
        projetos, backups: Array.isArray(bks) ? bks.slice(0, 5).map(b => ({ criado_em: b.created_at, local: b.location })) : [],
        erros: [met, dock, bk].filter(x => !x.ok).map(x => x.erro) });
    }
    const [dom, ass, sit] = await Promise.all([tenta(() => hg('/api/domains/v1/portfolio')), tenta(() => hg('/api/billing/v1/subscriptions')), tenta(() => hg('/api/hosting/v1/websites?per_page=100'))]);
    novo.dominios = dom.ok ? (dom.v.data || dom.v).map(d => ({ dominio: d.domain, status: d.status, expira_em: d.expires_at, tipo: d.type })) : { erro: dom.erro };
    novo.assinaturas = ass.ok ? (ass.v.data || ass.v).map(s => ({ nome: s.name, status: s.status, renova: s.is_auto_renewed, expira_em: s.expires_at || s.next_billing_at, valor: s.renewal_price != null ? s.renewal_price / 100 : null, moeda: s.currency_code })) : { erro: ass.erro };
    novo.sites = sit.ok ? (sit.v.data || []).map(w => ({ dominio: w.domain, tipo: w.website_type, ativo: w.is_enabled })) : { erro: sit.erro };
  }
  novo.urls = await Promise.all(URLS.map(checaUrl));
  for (const u of novo.urls) { const h = historico.urls[u.url] = (historico.urls[u.url] || []); h.push([Date.now(), u.ok ? u.ms : -1]); while (h.length && h[0][0] < Date.now() - 7 * 864e5) h.shift(); }
  novo.alertas = alertas(novo);
  const antes = new Set((estado.alertas || []).map(a => a.chave));
  const novos = novo.alertas.filter(a => !antes.has(a.chave));
  if (novos.length) { for (const a of novos) historico.alertas.unshift({ t: Date.now(), ...a }); historico.alertas = historico.alertas.slice(0, 200); avisa(novos).catch(() => {}); }
  estado = novo; salva();
}
function alertas(s) {
  const l = [], add = (nivel, chave, texto) => l.push({ nivel, chave, texto });
  if (s.erro) add('critico', 'api', s.erro);
  for (const v of s.vms) {
    if (v.estado !== 'running') add('critico', 'vm:' + v.id, `Servidor ${v.nome} está "${v.estado}".`);
    if (v.disco && v.disco_mb) { const p = v.disco.v / (v.disco_mb * 1048576) * 100; if (p > 85) add(p > 93 ? 'critico' : 'atencao', 'disco:' + v.id, `Disco do ${v.nome} em ${p.toFixed(0)}%.`); }
    if (v.ram && v.memoria_mb) { const p = v.ram.v / (v.memoria_mb * 1048576) * 100; if (p > 90) add('atencao', 'ram:' + v.id, `Memória do ${v.nome} em ${p.toFixed(0)}%.`); }
    if (v.cpu && v.cpu.v > 90) add('atencao', 'cpu:' + v.id, `CPU do ${v.nome} em ${v.cpu.v.toFixed(0)}%.`);
    for (const p of v.projetos) for (const c of p.containers) {
      if (['restarting', 'exited', 'dead'].includes(c.estado)) add(c.estado === 'restarting' ? 'critico' : 'atencao', 'ct:' + c.nome, `Container ${c.nome} (${p.nome}) está ${c.estado}: ${c.status}.`);
      if (c.portas.some(x => x.startsWith('pública'))) add('info', 'porta:' + c.nome, `Container ${c.nome} tem porta aberta para a internet (${c.portas.join(', ')}).`);
    }
  }
  for (const u of s.urls) {
    if (!u.ok) add('critico', 'url:' + u.url, `${u.url} não respondeu (${u.status || u.erro}).`);
    else if (u.ms > 4000) add('atencao', 'lenta:' + u.url, `${u.url} lenta: ${u.ms} ms.`);
    const h = u.corpo; if (h && typeof h === 'object') {
      if (h.backup && h.backup.atrasado) add('critico', 'bk:' + u.url, `Backup atrasado em ${u.url}.`);
      if (h.backup && h.backup.status && h.backup.status !== 'ok') add('critico', 'bkf:' + u.url, `Último backup com falha (${h.backup.status}).`);
      if (h.backup === 'nenhum') add('atencao', 'bk0:' + u.url, `Nenhum backup registrado em ${u.url}.`);
      if (h.asaas === 'falha') add('critico', 'asaas:' + u.url, 'Conexão com o Asaas falhando.');
      if (h.webhook_asaas === false) add('atencao', 'wh:' + u.url, 'Webhook do Asaas não registrado' + (h.webhook_erro ? `: ${h.webhook_erro}` : '.'));
    }
  }
  const dias = d => d ? (new Date(d) - Date.now()) / 864e5 : Infinity;
  if (Array.isArray(s.dominios)) for (const d of s.dominios) if (dias(d.expira_em) < 30) add(dias(d.expira_em) < 7 ? 'critico' : 'atencao', 'dom:' + d.dominio, `Domínio ${d.dominio} expira em ${Math.ceil(dias(d.expira_em))} dia(s).`);
  if (Array.isArray(s.assinaturas)) for (const a of s.assinaturas) if (!a.renova && dias(a.expira_em) < 15) add('atencao', 'ass:' + a.nome, `Assinatura "${a.nome}" vence em ${Math.ceil(dias(a.expira_em))} dia(s) sem renovação automática.`);
  return l;
}
// aviso opcional no Telegram (somente quando um alerta novo aparece)
async function avisa(novos) {
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHAT_ID) return; const imp = novos.filter(a => a.nivel !== 'info'); if (!imp.length) return;
  await fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text: '⚠️ Monitor IAVTech\n' + imp.map(a => (a.nivel === 'critico' ? '🔴 ' : '🟡 ') + a.texto).join('\n') }) });
}

// ---------------- HTTP
const send = (res, c, o, h = {}) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h }); res.end(JSON.stringify(o)); };
const body = req => new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 4096) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), k = req.method + ' ' + u.pathname, sec = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  try {
    if (k === 'GET /' || k === 'GET /index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
    if (k === 'GET /saude') return send(res, 200, { ok: true });
    if (k === 'POST /entrar') {
      if (falhas.ate > Date.now()) return send(res, 429, { erro: 'Bloqueado por tentativas erradas. Aguarde 15 minutos.' });
      const b = await body(req);
      if (!senhaOk(b.senha) || !totpOk(b.codigo)) { if (++falhas.n >= 5) { falhas.ate = Date.now() + 15 * 60e3; falhas.n = 0; } await new Promise(r => setTimeout(r, 800)); return send(res, 401, { erro: 'Senha ou código incorretos.' }); }
      falhas.n = 0; const t = crypto.randomBytes(32).toString('hex'); sessoes.set(t, { exp: Date.now() + 2 * 3600e3 });
      return send(res, 200, { ok: true }, { 'Set-Cookie': `mon=${t}; HttpOnly; SameSite=Strict; Path=/monitor/; Max-Age=7200${sec}` });
    }
    if (!logado(req)) return send(res, 401, { erro: 'Entre para continuar.' });
    if (k === 'POST /sair') { sessoes.delete(cookie(req).mon); return send(res, 200, { ok: true }, { 'Set-Cookie': 'mon=; Max-Age=0; Path=/monitor/' }); }
    if (k === 'GET /estado') return send(res, 200, { ...estado, historico_urls: historico.urls, historico_alertas: historico.alertas.slice(0, 50), intervalo_s: INTERVALO / 1000 });
    if (k === 'POST /atualizar') { if (!estado.coletado_em || Date.now() - new Date(estado.coletado_em) > 30000) await coletar(); return send(res, 200, { ok: true }); }
    send(res, 404, { erro: 'não encontrado' });
  } catch (e) { console.error(e); send(res, 500, { erro: 'erro interno' }); }
}).listen(PORT, () => { console.log('monitor ouvindo em', PORT, '· token', TOKEN ? 'configurado' : 'AUSENTE', '· senha', E.MONITOR_SENHA_HASH ? 'ok' : 'AUSENTE', '· 2FA', E.MONITOR_TOTP ? 'ok' : 'AUSENTE');
  coletar().catch(e => console.error('coleta:', e.message)); setInterval(() => coletar().catch(e => console.error('coleta:', e.message)), INTERVALO); });
