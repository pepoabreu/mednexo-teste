'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Pool } = require('./pgmini');
const { seed, hashSenha, confereSenha } = require('./seed');

const PORT = +process.env.PORT || 8080;
const DBO = process.env.PGSOCKET
  ? { path: process.env.PGSOCKET, user: process.env.PGUSER || 'postgres', database: process.env.PGDATABASE || 'mednexo' }
  : { host: process.env.PGHOST || 'db', port: +process.env.PGPORT || 5432, user: process.env.PGUSER || 'postgres', database: process.env.PGDATABASE || 'mednexo' };
const pool = new Pool(DBO);
const sessions = new Map();       // token -> {uid, org, papel, nome, exp}
const HTML = () => fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const send = (res, code, obj, headers = {}) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(b); };
const readBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) { no(new Error('corpo grande')); req.destroy(); } }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new Error('JSON inválido')); } }); });
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need = (v, m) => { if (v === undefined || v === null || String(v).trim() === '') throw Object.assign(new Error(m), { http: 422 }); return typeof v === 'string' ? v.trim() : v; };
const uuid = (v, m) => { if (!UUID.test(v || '')) throw Object.assign(new Error(m || 'identificador inválido'), { http: 422 }); return v; };

async function login(req, res, b) {
  const email = need(b.email, 'e-mail obrigatório').toLowerCase(), senha = need(b.senha, 'senha obrigatória');
  const r = await pool.query(`SELECT u.id, u.nome_completo, u.senha_hash, u.ativo, u.tentativas_falhas, u.bloqueado_ate, m.organizacao_id, m.papel
     FROM mednexo.usuario u JOIN mednexo.organizacao_membro m ON m.usuario_id = u.id AND m.ativo WHERE u.email = $1 LIMIT 1`, [email]);
  const u = r.rows[0];
  if (u && u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) return send(res, 429, { erro: 'Conta temporariamente bloqueada por tentativas falhas. Tente em 15 minutos.' });
  if (!u || !u.ativo || !confereSenha(senha, u.senha_hash)) {
    if (u) await pool.query(`UPDATE mednexo.usuario SET tentativas_falhas = tentativas_falhas + 1, bloqueado_ate = CASE WHEN tentativas_falhas + 1 >= 5 THEN now() + interval '15 minutes' END WHERE id = $1`, [u.id]);
    return send(res, 401, { erro: 'E-mail ou senha inválidos.' });
  }
  await pool.query('UPDATE mednexo.usuario SET tentativas_falhas = 0, bloqueado_ate = NULL, ultimo_login_em = now() WHERE id = $1', [u.id]);
  const tok = crypto.randomBytes(32).toString('hex');
  sessions.set(tok, { uid: u.id, org: u.organizacao_id, papel: u.papel, nome: u.nome_completo, exp: Date.now() + 8 * 3600e3 });
  send(res, 200, { ok: true, nome: u.nome_completo, papel: u.papel }, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
}

const routes = {
  'GET /api/me': async (s, c) => ({ nome: s.nome, papel: s.papel,
    hospitais: (await c.query('SELECT id, nome_fantasia FROM mednexo.hospital ORDER BY nome_fantasia')).rows }),
  'GET /api/hospitais': async (s, c) => (await c.query(`SELECT h.id, h.nome_fantasia,
      (SELECT count(*)::int FROM mednexo.leito l WHERE l.hospital_id = h.id AND l.ativo) AS leitos,
      (SELECT count(*)::int FROM mednexo.internacao_movimentacao m WHERE m.hospital_id = h.id AND m.fim IS NULL) AS ocupados
     FROM mednexo.hospital h ORDER BY h.nome_fantasia`)).rows,
  'GET /api/leitos': async (s, c, q) => (await c.query(`SELECT l.id, l.identificacao, u.nome AS unidade FROM mednexo.leito l JOIN mednexo.unidade_internacao u ON u.id = l.unidade_id
     WHERE l.hospital_id = $1 AND l.ativo AND NOT EXISTS (SELECT 1 FROM mednexo.internacao_movimentacao m WHERE m.leito_id = l.id AND m.fim IS NULL) ORDER BY u.nome, l.identificacao`, [uuid(q.hospital_id)])).rows,
  'GET /api/pacientes': async (s, c, q) => (await c.query(`SELECT id, codigo, nome_completo, data_nascimento, alergias_status,
      (SELECT count(*)::int FROM mednexo.vw_paciente_episodios e WHERE e.paciente_id = p.id) AS episodios
     FROM mednexo.paciente p WHERE ($1 = '' OR nome_normalizado LIKE '%' || mednexo.f_norm($1) || '%' OR codigo ILIKE $1 || '%') ORDER BY nome_completo LIMIT 50`, [(q.q || '').slice(0, 80)])).rows,
  'POST /api/pacientes': async (s, c, q, b, ctx) => (await c.query(`INSERT INTO mednexo.paciente (organizacao_id, nome_completo, nome_mae, cpf, data_nascimento, sexo_registrado)
     VALUES ($1, $2, $3, NULLIF($4,''), $5::date, COALESCE(NULLIF($6,''),'nao_informado')::mednexo.sexo_registrado) RETURNING id, codigo`,
     [ctx.org, need(b.nome_completo, 'nome obrigatório'), b.nome_mae || null, (b.cpf || '').replace(/\D/g, ''), need(b.data_nascimento, 'nascimento obrigatório'), b.sexo || ''])).rows[0],
  'POST /api/pacientes/alergias': async (s, c, q, b) => { await c.query(`UPDATE mednexo.paciente SET alergias_status = $2::mednexo.alergias_status WHERE id = $1`, [uuid(b.paciente_id), need(b.status, 'status obrigatório')]); return { ok: true }; },
  'GET /api/paciente': async (s, c, q) => ({ episodios: (await c.query('SELECT * FROM mednexo.vw_paciente_episodios WHERE paciente_id = $1', [uuid(q.id)])).rows,
     linha: (await c.query('SELECT * FROM mednexo.vw_linha_do_tempo WHERE paciente_id = $1 ORDER BY ocorrido_em DESC LIMIT 100', [q.id])).rows }),
  'GET /api/painel': async (s, c) => (await c.query('SELECT * FROM mednexo.vw_painel_internados ORDER BY hospital, nome_completo')).rows,
  'POST /api/internacoes': async (s, c, q, b, ctx) => {
    const prof = (await c.query('SELECT id FROM mednexo.profissional WHERE usuario_id = $1', [ctx.uid])).rows[0];
    if (!prof) throw Object.assign(new Error('Somente médicos com cadastro profissional (CRM) admitem pacientes.'), { http: 403 });
    const i = (await c.query(`INSERT INTO mednexo.internacao (organizacao_id, paciente_id, hospital_id, modalidade, profissional_responsavel_id, data_admissao)
      VALUES ($1,$2,$3,$4::mednexo.modalidade_internacao,$5, now()) RETURNING id, codigo`, [ctx.org, uuid(b.paciente_id), uuid(b.hospital_id), need(b.modalidade, 'modalidade obrigatória'), prof.id])).rows[0];
    await c.query('INSERT INTO mednexo.internacao_clinico (internacao_id, organizacao_id, motivo_internacao) VALUES ($1,$2,$3)', [i.id, ctx.org, need(b.motivo, 'motivo da internação obrigatório')]);
    if (b.leito_id) await c.query(`INSERT INTO mednexo.internacao_movimentacao (organizacao_id, internacao_id, hospital_id, leito_id, tipo, inicio) VALUES ($1,$2,$3,$4,'admissao', now())`, [ctx.org, i.id, b.hospital_id, uuid(b.leito_id)]);
    return i;
  },
  'GET /api/internacao': async (s, c, q) => {
    const id = uuid(q.id);
    const cab = (await c.query('SELECT * FROM mednexo.vw_paciente_cabecalho WHERE internacao_id = $1', [id])).rows[0];
    if (!cab) throw Object.assign(new Error('Internação não encontrada ou sem permissão.'), { http: 404 });
    await c.query(`SELECT mednexo.auditar_acesso('leitura','internacao',$1,$2::uuid,$1::uuid,'{"origem":"tela"}'::jsonb)`, [id, cab.paciente_id]);
    const registros = (await c.query(`SELECT rc.id, rc.tipo, rc.status, rc.ocorrido_em, u.nome_completo AS autor,
        CASE WHEN rc.status = 'assinado' THEN mednexo.verificar_integridade_registro(rc.id) END AS integro
      FROM mednexo.registro_clinico rc JOIN mednexo.usuario u ON u.id = rc.autor_usuario_id WHERE rc.internacao_id = $1 ORDER BY rc.ocorrido_em DESC`, [id])).rows;
    const pendencias = (await c.query('SELECT tipo, detalhe FROM mednexo.vw_pendencias WHERE internacao_id = $1', [id])).rows;
    return { cab, registros, pendencias };
  },
  'GET /api/registro': async (s, c, q) => {
    const id = uuid(q.id);
    const r = (await c.query(`SELECT rc.id, rc.tipo, rc.status, rc.ocorrido_em, rc.assinado_em, encode(rc.hash_conteudo,'hex') AS hash, rc.motivo_anulacao, e.*
      FROM mednexo.registro_clinico rc LEFT JOIN mednexo.evolucao e ON e.registro_id = rc.id WHERE rc.id = $1`, [id])).rows[0];
    if (!r) throw Object.assign(new Error('Registro não encontrado ou sem permissão.'), { http: 404 });
    r.adendos = (await c.query('SELECT tipo, justificativa, conteudo, criado_em FROM mednexo.registro_adendo WHERE registro_id = $1 ORDER BY criado_em', [id])).rows;
    return r;
  },
  'POST /api/evolucoes': async (s, c, q, b, ctx) => {
    const it = (await c.query('SELECT id, paciente_id, hospital_id FROM mednexo.internacao WHERE id = $1', [uuid(b.internacao_id)])).rows[0];
    if (!it) throw Object.assign(new Error('Internação não encontrada ou sem permissão.'), { http: 404 });
    const r = (await c.query(`INSERT INTO mednexo.registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
      VALUES ($1,$2,$3,$4,'evolucao',$5) RETURNING id`, [ctx.org, it.paciente_id, it.hospital_id, it.id, ctx.uid])).rows[0];
    await c.query('INSERT INTO mednexo.evolucao (registro_id, subjetivo, objetivo, conduta) VALUES ($1,$2,$3,$4)', [r.id, b.subjetivo || null, b.objetivo || null, b.conduta || null]);
    if (b.assinar) await c.query('SELECT mednexo.assinar_registro($1)', [r.id]);
    return { id: r.id, assinado: !!b.assinar };
  },
  'POST /api/registros/assinar': async (s, c, q, b) => { await c.query('SELECT mednexo.assinar_registro($1)', [uuid(b.id)]); return { ok: true }; },
  'POST /api/registros/adendo': async (s, c, q, b, ctx) => { await c.query(`INSERT INTO mednexo.registro_adendo (organizacao_id, registro_id, tipo, justificativa, conteudo) VALUES ($1,$2,'complemento',$3,$4)`,
      [ctx.org, uuid(b.id), need(b.justificativa, 'justificativa obrigatória'), need(b.conteudo, 'conteúdo obrigatório')]); return { ok: true }; },
  'GET /api/auditoria': async (s, c, q, b, ctx) => ({
    quebras: (await c.query('SELECT * FROM mednexo.verificar_cadeia_auditoria($1)', [ctx.org])).rows,
    eventos: (await c.query(`SELECT a.seq, a.ocorrido_em, a.acao, a.entidade, u.nome_completo AS usuario FROM mednexo.auditoria_evento a LEFT JOIN mednexo.usuario u ON u.id = a.usuario_id ORDER BY a.seq DESC LIMIT 60`)).rows }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const key = `${req.method} ${url.pathname}`;
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML()); }
    if (key === 'GET /health') { await pool.query('SELECT 1'); return send(res, 200, { ok: true }); }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { erro: 'não encontrado' });
    if (req.method === 'POST' && req.headers['content-type'] && !/json/.test(req.headers['content-type'])) return send(res, 415, { erro: 'use JSON' });
    if (key === 'POST /api/login') return await login(req, res, await readBody(req));
    const tok = cookie(req).sid; const s = tok && sessions.get(tok);
    if (!s || s.exp < Date.now()) { if (tok) sessions.delete(tok); return send(res, 401, { erro: 'sessão expirada' }); }
    if (key === 'POST /api/logout') { sessions.delete(tok); return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' }); }
    const h = routes[key]; if (!h) return send(res, 404, { erro: 'rota inexistente' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    const ctx = { org: s.org, uid: s.uid, ip: req.socket.remoteAddress, ua: req.headers['user-agent'], rid: crypto.randomUUID() };
    const out = await pool.tx(c => h(s, c, Object.fromEntries(url.searchParams), body, ctx), ctx);
    send(res, 200, out);
  } catch (e) {
    const code = e.http || (e.code === '42501' ? 403 : e.code ? 400 : 500);
    if (code === 500) console.error(e);
    send(res, code, { erro: code === 500 ? 'Erro interno.' : e.message });
  }
});

(async () => {
  for (let i = 0; ; i++) { try { await pool.query('SELECT 1'); break; } catch (e) { if (i > 60) throw e; await new Promise(r => setTimeout(r, 2000)); } }
  const tem = (await pool.query(`SELECT to_regnamespace('mednexo') IS NOT NULL AS ok`)).rows[0].ok;
  if (!tem) { console.log('Aplicando schema MEDNEXO...'); await pool.raw(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')); console.log('Schema aplicado.'); }
  await seed(pool, process.env);
  server.listen(PORT, '0.0.0.0', () => console.log('MEDNEXO ouvindo em', PORT));
})().catch(e => { console.error(e); process.exit(1); });
