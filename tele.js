'use strict';
// Telemedicina: sala por consulta com vídeo (WebRTC, ponto a ponto com STUN/TURN), chat e anexos.
// Médico acessa autenticado (RLS da organização); paciente acessa SEM conta, por link com token de uso único por consulta
// (guardamos só o hash do token). Sinalização WebRTC e chat chegam por long-poll; mensagens e anexos ficam gravados.
const crypto = require('crypto');

const MIGRACAO = `
CREATE TABLE IF NOT EXISTS mednexo.teleconsulta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL,
  paciente_id uuid NOT NULL,
  internacao_id uuid,
  medico_usuario_id uuid NOT NULL REFERENCES mednexo.usuario(id),
  token_sha256 bytea NOT NULL,
  status text NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando','em_andamento','encerrada')),
  criada_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  iniciada_em timestamptz,
  encerrada_em timestamptz,
  consentimento_em timestamptz,
  consentimento_ip text,
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES mednexo.paciente (id, organizacao_id));
CREATE TABLE IF NOT EXISTS mednexo.tele_mensagem (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teleconsulta_id uuid NOT NULL REFERENCES mednexo.teleconsulta(id),
  autor text NOT NULL CHECK (autor IN ('medico','paciente','sistema')),
  texto text NOT NULL CHECK (length(texto) BETWEEN 1 AND 4000),
  anexo_id uuid,
  criado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mednexo.tele_anexo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teleconsulta_id uuid NOT NULL REFERENCES mednexo.teleconsulta(id),
  enviado_por text NOT NULL CHECK (enviado_por IN ('medico','paciente')),
  categoria text NOT NULL DEFAULT 'outro' CHECK (categoria IN ('exame','receita','laudo','outro')),
  nome text NOT NULL, mime text NOT NULL, tamanho int NOT NULL, sha256 bytea NOT NULL, conteudo bytea NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ix_tele_int ON mednexo.teleconsulta (internacao_id, criada_em DESC);
CREATE INDEX IF NOT EXISTS ix_tele_msg ON mednexo.tele_mensagem (teleconsulta_id, criado_em);
ALTER TABLE mednexo.teleconsulta ENABLE ROW LEVEL SECURITY;
ALTER TABLE mednexo.tele_mensagem ENABLE ROW LEVEL SECURITY;
ALTER TABLE mednexo.tele_anexo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_sel ON mednexo.teleconsulta; DROP POLICY IF EXISTS p_ins ON mednexo.teleconsulta; DROP POLICY IF EXISTS p_upd ON mednexo.teleconsulta;
CREATE POLICY p_sel ON mednexo.teleconsulta FOR SELECT USING (organizacao_id = mednexo.ctx_org() AND mednexo.pode_ler_clinico_paciente(paciente_id));
CREATE POLICY p_ins ON mednexo.teleconsulta FOR INSERT WITH CHECK (organizacao_id = mednexo.ctx_org() AND medico_usuario_id = mednexo.ctx_usuario() AND mednexo.pode_escrever_clinico_paciente(paciente_id));
CREATE POLICY p_upd ON mednexo.teleconsulta FOR UPDATE USING (organizacao_id = mednexo.ctx_org() AND mednexo.pode_escrever_clinico_paciente(paciente_id));
DROP POLICY IF EXISTS p_sel ON mednexo.tele_mensagem; DROP POLICY IF EXISTS p_ins ON mednexo.tele_mensagem;
CREATE POLICY p_sel ON mednexo.tele_mensagem FOR SELECT USING (EXISTS (SELECT 1 FROM mednexo.teleconsulta t WHERE t.id = teleconsulta_id));
CREATE POLICY p_ins ON mednexo.tele_mensagem FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM mednexo.teleconsulta t WHERE t.id = teleconsulta_id));
DROP POLICY IF EXISTS p_sel ON mednexo.tele_anexo; DROP POLICY IF EXISTS p_ins ON mednexo.tele_anexo;
CREATE POLICY p_sel ON mednexo.tele_anexo FOR SELECT USING (EXISTS (SELECT 1 FROM mednexo.teleconsulta t WHERE t.id = teleconsulta_id));
CREATE POLICY p_ins ON mednexo.tele_anexo FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM mednexo.teleconsulta t WHERE t.id = teleconsulta_id));
GRANT SELECT, INSERT, UPDATE ON mednexo.teleconsulta TO mednexo_app;
GRANT SELECT, INSERT ON mednexo.tele_mensagem, mednexo.tele_anexo TO mednexo_app;
`;

const MIMES = { 'application/pdf': 1, 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/heic': 1, 'image/heif': 1 };
const MAX_ANEXO = 10 * 1024 * 1024;

module.exports = function (pool, { uuid }) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const sha = t => crypto.createHash('sha256').update(t).digest();
  // ---- eventos em memória por sala (sinalização WebRTC + avisos de chat/anexo/estado), com long-poll
  const salas = new Map(); // id -> { seq, ev: [{seq, de, tipo, dados}], esperando: Set<fn>, visto: {medico, paciente} }
  const sala = id => { let s = salas.get(id); if (!s) { s = { seq: 0, ev: [], esperando: new Set(), visto: {} }; salas.set(id, s); } return s; };
  function publicar(id, de, tipo, dados) {
    const s = sala(id); s.seq++; s.ev.push({ seq: s.seq, de, tipo, dados, em: Date.now() });
    if (s.ev.length > 400) s.ev.splice(0, s.ev.length - 400);
    for (const f of s.esperando) f(); s.esperando.clear();
  }
  function esperar(id, quem, desde, ms = 25000) {
    const s = sala(id); s.visto[quem] = Date.now();
    const pega = () => s.ev.filter(e => e.seq > desde && e.de !== quem);
    const ja = pega(); if (ja.length) return Promise.resolve({ seq: s.seq, eventos: ja, online: online(id, quem) });
    return new Promise(res => { const f = () => { clearTimeout(t); res({ seq: s.seq, eventos: pega(), online: online(id, quem) }); };
      const t = setTimeout(() => { s.esperando.delete(f); res({ seq: s.seq, eventos: [], online: online(id, quem) }); }, ms); s.esperando.add(f); });
  }
  const online = (id, quem) => { const o = quem === 'medico' ? 'paciente' : 'medico'; const v = sala(id).visto[o]; return !!v && Date.now() - v < 40000; };
  setInterval(() => { const lim = Date.now() - 6 * 3600e3; for (const [id, s] of salas) if (!s.esperando.size && (!s.ev.length || s.ev[s.ev.length - 1].em < lim)) salas.delete(id); }, 600000).unref();

  // ---- servidores ICE (STUN público + TURN próprio com credencial temporária, se configurado)
  function iceServers() {
    const l = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
    const seg = process.env.TURN_SECRET, host = process.env.TURN_HOST;
    if (seg && host) {
      const username = `${Math.floor(Date.now() / 1000) + 6 * 3600}:mednexo`;
      const credential = crypto.createHmac('sha1', seg).update(username).digest('base64');
      l.push({ urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential });
    }
    return l;
  }

  // ---- dados da sala (para médico e paciente)
  async function conteudo(q, id) {
    const msgs = (await q.query(`SELECT id, autor, texto, anexo_id, criado_em FROM mednexo.tele_mensagem WHERE teleconsulta_id = $1 ORDER BY criado_em LIMIT 500`, [id])).rows;
    const anexos = (await q.query(`SELECT id, enviado_por, categoria, nome, mime, tamanho, criado_em FROM mednexo.tele_anexo WHERE teleconsulta_id = $1 ORDER BY criado_em`, [id])).rows;
    return { mensagens: msgs, anexos, seq: sala(id).seq, ice: iceServers() };
  }
  async function gravarMsg(q, id, autor, texto, anexoId) {
    const t = String(texto || '').trim().slice(0, 4000); if (!t) throw err('Mensagem vazia.');
    const m = (await q.query(`INSERT INTO mednexo.tele_mensagem (teleconsulta_id, autor, texto, anexo_id) VALUES ($1,$2,$3,$4) RETURNING id, autor, texto, anexo_id, criado_em`, [id, autor, t, anexoId || null])).rows[0];
    publicar(id, autor, 'msg', m); return m;
  }
  async function gravarAnexo(q, id, quem, b) {
    const mime = String(b.mime || '').toLowerCase(); if (!MIMES[mime]) throw err('Envie PDF ou foto (JPG, PNG, WEBP ou HEIC).', 415);
    const buf = Buffer.from(String(b.base64 || ''), 'base64'); if (!buf.length) throw err('Arquivo vazio.'); if (buf.length > MAX_ANEXO) throw err('Arquivo acima de 10 MB.', 413);
    const cat = ['exame', 'receita', 'laudo', 'outro'].includes(b.categoria) ? b.categoria : 'outro';
    const nome = String(b.nome || 'arquivo').replace(/[\\/\0]/g, '_').slice(0, 150);
    const a = (await q.query(`INSERT INTO mednexo.tele_anexo (teleconsulta_id, enviado_por, categoria, nome, mime, tamanho, sha256, conteudo) VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),decode($8,'base64')) RETURNING id, enviado_por, categoria, nome, mime, tamanho, criado_em`,
      [id, quem, cat, nome, mime, buf.length, sha(buf).toString('hex'), buf.toString('base64')])).rows[0];
    const rot = { exame: 'Exame', receita: 'Receita', laudo: 'Laudo', outro: 'Arquivo' }[cat];
    const m = await gravarMsg(q, id, quem, `📎 ${rot} enviado: ${nome}`, a.id);
    publicar(id, quem, 'anexo', a); return { ...a, msg: m };
  }
  const lerAnexo = async (q, id, aid) => { const a = (await q.query(`SELECT nome, mime, encode(conteudo,'base64') AS b64 FROM mednexo.tele_anexo WHERE id = $1 AND teleconsulta_id = $2`, [uuid(aid), id])).rows[0]; if (!a) throw err('Anexo não encontrado.', 404); return { __raw: { mime: a.mime, nome: a.nome, buf: Buffer.from(a.b64, 'base64') } }; };
  function sinal(id, quem, b) {
    if (!['offer', 'answer', 'ice', 'hangup', 'pronto'].includes(b.tipo)) throw err('Sinal inválido.');
    const d = JSON.stringify(b.dados || null); if (d.length > 60000) throw err('Sinal grande demais.', 413);
    publicar(id, quem, 'sinal', { tipo: b.tipo, dados: b.dados || null }); return { ok: true };
  }

  // =================== ROTAS DO MÉDICO (sessão + RLS) ===================
  const R = {};
  const ehMedico = s => ['medico_administrador', 'medico_assistente'].includes(s.papel);
  async function minha(c, id) { const t = (await c.query(`SELECT * FROM mednexo.teleconsulta WHERE id = $1`, [uuid(id)])).rows[0]; if (!t) throw err('Teleconsulta não encontrada.', 404); return t; }
  R['POST /api/tele/criar'] = async (s, c, q, b, ctx) => {
    if (!ehMedico(s)) throw err('Somente médicos iniciam teleconsultas.', 403);
    const it = (await c.query(`SELECT id, paciente_id, status FROM mednexo.internacao WHERE id = $1`, [uuid(b.internacao_id)])).rows[0];
    if (!it) throw err('Internação não encontrada.', 404);
    const token = crypto.randomBytes(24).toString('base64url');
    const t = (await c.query(`INSERT INTO mednexo.teleconsulta (organizacao_id, paciente_id, internacao_id, medico_usuario_id, token_sha256, expira_em) VALUES ($1,$2,$3,$4,decode($5,'hex'), now() + interval '24 hours') RETURNING id, criada_em, expira_em`,
      [ctx.org, it.paciente_id, it.id, ctx.uid, sha(token).toString('hex')])).rows[0];
    await c.query(`SELECT mednexo.auditar_acesso('tele_criar','teleconsulta',$1,$2::uuid,$3::uuid,'{}'::jsonb)`, [t.id, it.paciente_id, it.id]);
    return { id: t.id, chave: `${t.id}.${token}`, expira_em: t.expira_em };
  };
  R['GET /api/tele/lista'] = async (s, c, q) => (await c.query(`SELECT t.id, t.status, t.criada_em, t.expira_em, t.iniciada_em, t.encerrada_em, t.consentimento_em, u.nome_completo AS medico,
      (SELECT count(*) FROM mednexo.tele_anexo a WHERE a.teleconsulta_id = t.id)::int AS anexos, (SELECT count(*) FROM mednexo.tele_mensagem m WHERE m.teleconsulta_id = t.id)::int AS mensagens
      FROM mednexo.teleconsulta t JOIN mednexo.usuario u ON u.id = t.medico_usuario_id WHERE t.internacao_id = $1 ORDER BY t.criada_em DESC LIMIT 30`, [uuid(q.internacao_id)])).rows;
  R['GET /api/tele/sala'] = async (s, c, q) => { const t = await minha(c, q.id); return { tele: { id: t.id, status: t.status, consentimento_em: t.consentimento_em, expira_em: t.expira_em, internacao_id: t.internacao_id }, ...(await conteudo(c, t.id)) }; };
  R['POST /api/tele/msg'] = async (s, c, q, b) => { const t = await minha(c, b.id); if (t.status === 'encerrada') throw err('Teleconsulta encerrada.', 409); return gravarMsg(c, t.id, 'medico', b.texto); };
  R['POST /api/tele/sinal'] = async (s, c, q, b) => { const t = await minha(c, b.id); if (t.status === 'encerrada') throw err('Teleconsulta encerrada.', 409);
    if (b.tipo === 'offer' && t.status === 'aguardando') await c.query(`UPDATE mednexo.teleconsulta SET status = 'em_andamento', iniciada_em = coalesce(iniciada_em, now()) WHERE id = $1`, [t.id]);
    return sinal(t.id, 'medico', b); };
  R['POST /api/tele/anexo'] = async (s, c, q, b) => { const t = await minha(c, b.id); if (t.status === 'encerrada') throw err('Teleconsulta encerrada.', 409); return gravarAnexo(c, t.id, 'medico', b); };
  R['GET /api/tele/anexo'] = async (s, c, q) => { const t = await minha(c, q.id); return lerAnexo(c, t.id, q.aid); };
  R['POST /api/tele/encerrar'] = async (s, c, q, b, ctx) => { const t = await minha(c, b.id);
    await c.query(`UPDATE mednexo.teleconsulta SET status = 'encerrada', encerrada_em = coalesce(encerrada_em, now()) WHERE id = $1`, [t.id]);
    await c.query(`INSERT INTO mednexo.tele_mensagem (teleconsulta_id, autor, texto) VALUES ($1,'sistema','Teleconsulta encerrada pelo médico.')`, [t.id]);
    await c.query(`SELECT mednexo.auditar_acesso('tele_encerrar','teleconsulta',$1,$2::uuid,$3::uuid,'{}'::jsonb)`, [t.id, t.paciente_id, t.internacao_id]);
    publicar(t.id, 'medico', 'estado', { status: 'encerrada' }); return { ok: true }; };
  // long-poll do médico: valida acesso numa transação curta e espera FORA dela (não segura conexão do banco)
  async function eventosMedico(ctx, q) { const id = uuid(q.id); await pool.tx(c => minha(c, id), ctx); return esperar(id, 'medico', Number(q.desde) || 0); }

  // =================== ROTAS DO PACIENTE (sem conta; token da consulta) ===================
  async function autenticaPaciente(req) {
    const k = String(req.headers['x-tele-chave'] || ''); const [id, tok] = k.split('.');
    if (!id || !tok || !/^[0-9a-f-]{36}$/.test(id)) throw err('Link de teleconsulta inválido.', 401);
    const t = (await pool.query(`SELECT t.id, t.status, t.expira_em, t.consentimento_em, u.nome_completo AS medico, p.nome_social, p.nome_completo AS paciente_nome FROM mednexo.teleconsulta t JOIN mednexo.usuario u ON u.id = t.medico_usuario_id JOIN mednexo.paciente p ON p.id = t.paciente_id WHERE t.id = $1 AND t.token_sha256 = decode($2,'hex')`, [id, sha(tok).toString('hex')])).rows[0];
    if (!t) throw err('Link de teleconsulta inválido.', 401);
    if (t.status === 'encerrada') throw err('Esta teleconsulta foi encerrada pelo médico.', 410);
    if (new Date(t.expira_em) < new Date()) throw err('Este link expirou. Peça um novo link ao seu médico.', 410);
    return t;
  }
  const exigeConsent = t => { if (!t.consentimento_em) throw err('Aceite o termo de teleconsulta para continuar.', 403); };
  async function publico(req, res, key, url, readBody, send) {
    if (!key.includes(' /api/tele-p/')) return false;
    const t = await autenticaPaciente(req);
    const q = Object.fromEntries(url.searchParams);
    if (key === 'GET /api/tele-p/sala') {
      const primeiro = String(t.nome_social || t.paciente_nome || '').trim().split(/\s+/)[0] || '';
      send(res, 200, { tele: { status: t.status, medico: t.medico, paciente_primeiro_nome: primeiro, consentimento_em: t.consentimento_em, expira_em: t.expira_em }, ...(t.consentimento_em ? await conteudo(pool, t.id) : { mensagens: [], anexos: [], seq: 0, ice: [] }) }); return true;
    }
    if (key === 'POST /api/tele-p/consentir') { const b = await readBody(req); if (b.aceito !== true) throw err('É necessário aceitar o termo.');
      const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
      await pool.query(`UPDATE mednexo.teleconsulta SET consentimento_em = coalesce(consentimento_em, now()), consentimento_ip = coalesce(consentimento_ip, $2) WHERE id = $1`, [t.id, ip]);
      await pool.query(`INSERT INTO mednexo.tele_mensagem (teleconsulta_id, autor, texto) VALUES ($1,'sistema','Paciente aceitou o termo de teleconsulta.')`, [t.id]);
      publicar(t.id, 'paciente', 'estado', { consentimento: true }); send(res, 200, { ok: true }); return true; }
    exigeConsent(t);
    if (key === 'GET /api/tele-p/eventos') { send(res, 200, await esperar(t.id, 'paciente', Number(q.desde) || 0)); return true; }
    if (key === 'POST /api/tele-p/msg') { const b = await readBody(req); send(res, 200, await gravarMsg(pool, t.id, 'paciente', b.texto)); return true; }
    if (key === 'POST /api/tele-p/sinal') { const b = await readBody(req); send(res, 200, sinal(t.id, 'paciente', b)); return true; }
    if (key === 'POST /api/tele-p/anexo') { const b = await readBody(req, 15e6); send(res, 200, await gravarAnexo(pool, t.id, 'paciente', b)); return true; }
    if (key === 'GET /api/tele-p/anexo') { const r = await lerAnexo(pool, t.id, q.aid); res.writeHead(200, { 'Content-Type': r.__raw.mime, 'Content-Length': r.__raw.buf.length, 'Content-Disposition': `inline; filename="${encodeURIComponent(r.__raw.nome)}"`, 'Cache-Control': 'private, no-store' }); res.end(r.__raw.buf); return true; }
    send(res, 404, { erro: 'rota inexistente' }); return true;
  }
  return { routes: R, publico, eventosMedico, migrar: () => pool.raw(MIGRACAO) };
};
