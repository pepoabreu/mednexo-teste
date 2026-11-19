'use strict';
// Área do Cliente: contas de paciente (fora das organizações), vitrine de médicos de telemedicina aprovados pelo gestor,
// agenda semanal com bloqueios, reserva de horário por 15 min com pagamento (Asaas) e "Minhas consultas".
// O prontuário continua sendo da organização do médico: ao agendar, o paciente é cadastrado (ou reaproveitado pelo CPF) nela.
const crypto = require('crypto');

const MIGRACAO = `
CREATE TABLE IF NOT EXISTS mednexo.paciente_conta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL, senha_hash text NOT NULL, nome text NOT NULL, cpf char(11) UNIQUE NOT NULL,
  nascimento date NOT NULL, celular text NOT NULL, consentimento_em timestamptz NOT NULL, ativo boolean NOT NULL DEFAULT true,
  tentativas int NOT NULL DEFAULT 0, bloqueado_ate timestamptz, criado_em timestamptz NOT NULL DEFAULT now(), ultimo_login_em timestamptz);
CREATE TABLE IF NOT EXISTS mednexo.medico_vitrine (
  usuario_id uuid PRIMARY KEY REFERENCES mednexo.usuario(id), organizacao_id uuid NOT NULL REFERENCES mednexo.organizacao(id),
  ativo boolean NOT NULL DEFAULT false, aprovado_em timestamptz, aprovado_por uuid REFERENCES mednexo.usuario(id),
  especialidade text, rqe text, apresentacao text CHECK (length(apresentacao) <= 600),
  duracao_min int NOT NULL DEFAULT 30 CHECK (duracao_min BETWEEN 10 AND 120), antecedencia_horas int NOT NULL DEFAULT 2 CHECK (antecedencia_horas BETWEEN 0 AND 168),
  janela_dias int NOT NULL DEFAULT 30 CHECK (janela_dias BETWEEN 1 AND 120), atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mednexo.agenda_regra (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid NOT NULL REFERENCES mednexo.usuario(id),
  dia_semana int NOT NULL CHECK (dia_semana BETWEEN 0 AND 6), inicio time NOT NULL, fim time NOT NULL, CHECK (fim > inicio));
CREATE TABLE IF NOT EXISTS mednexo.agenda_bloqueio (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid NOT NULL REFERENCES mednexo.usuario(id),
  inicio timestamptz NOT NULL, fim timestamptz NOT NULL, motivo text, CHECK (fim > inicio));
CREATE TABLE IF NOT EXISTS mednexo.agendamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), medico_usuario_id uuid NOT NULL REFERENCES mednexo.usuario(id), organizacao_id uuid NOT NULL REFERENCES mednexo.organizacao(id),
  paciente_conta_id uuid NOT NULL REFERENCES mednexo.paciente_conta(id), paciente_id uuid, teleconsulta_id uuid REFERENCES mednexo.teleconsulta(id),
  inicio timestamptz NOT NULL, fim timestamptz NOT NULL, valor numeric(12,2) NOT NULL,
  status text NOT NULL CHECK (status IN ('reservado','confirmado','expirado','cancelado_paciente','cancelado_medico','erro')),
  reservado_ate timestamptz, chave_cifrada text, criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS ux_agendamento_horario ON mednexo.agendamento (medico_usuario_id, inicio) WHERE status IN ('reservado','confirmado');
CREATE INDEX IF NOT EXISTS ix_agendamento_conta ON mednexo.agendamento (paciente_conta_id, inicio DESC);
ALTER TABLE mednexo.paciente_conta ENABLE ROW LEVEL SECURITY; ALTER TABLE mednexo.medico_vitrine ENABLE ROW LEVEL SECURITY;
ALTER TABLE mednexo.agenda_regra ENABLE ROW LEVEL SECURITY; ALTER TABLE mednexo.agenda_bloqueio ENABLE ROW LEVEL SECURITY; ALTER TABLE mednexo.agendamento ENABLE ROW LEVEL SECURITY;
`;
const TZ = '-03:00'; // Brasília (sem horário de verão)
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function cpfValido(c) { c = String(c || '').replace(/\D/g, ''); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const d = (s * 10) % 11 % 10; if (d !== +c[n]) return false; } return true; }

module.exports = function (pool, { need, uuid, routes, asaas, hashSenha, confereSenha, lgpd }) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const sessoes = new Map(); // token -> { id, exp }
  const tentativas = new Map();
  const limite = (ip, n = 10) => { const a = Date.now(), l = (tentativas.get(ip) || []).filter(t => a - t < 3600e3); if (l.length >= n) throw err('Muitas tentativas. Tente novamente mais tarde.', 429); l.push(a); tentativas.set(ip, l); };
  const ipDe = req => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  const cookie = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]));
  const segura = req => req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  function conta(req) { const t = cookie(req).psid, s = t && sessoes.get(t); if (!s || s.exp < Date.now()) { if (t) sessoes.delete(t); throw err('Entre na sua conta para continuar.', 401); } return s.id; }

  // ---- horários livres de um médico
  async function vitrineMedico(uid) {
    return (await pool.query(`SELECT v.*, u.nome_completo AS nome, p.numero_registro AS crm, p.uf, r.preco_teleconsulta AS valor
      FROM mednexo.medico_vitrine v JOIN mednexo.usuario u ON u.id = v.usuario_id JOIN mednexo.profissional p ON p.usuario_id = u.id
      JOIN mednexo.medico_recebimento r ON r.usuario_id = u.id JOIN mednexo.organizacao_membro m ON m.usuario_id = u.id AND m.organizacao_id = v.organizacao_id AND m.ativo
      WHERE v.usuario_id = $1 AND v.ativo AND v.aprovado_em IS NOT NULL AND r.preco_teleconsulta > 0`, [uid])).rows[0];
  }
  async function horarios(uid, dias) {
    const v = await vitrineMedico(uid); if (!v) throw err('Médico indisponível para agendamento.', 404);
    if ((await asaas.situacao(v.organizacao_id)).bloqueada) return { medico: v, horarios: [] };
    const regras = (await pool.query(`SELECT dia_semana, to_char(inicio,'HH24:MI') AS i, to_char(fim,'HH24:MI') AS f FROM mednexo.agenda_regra WHERE usuario_id = $1`, [uid])).rows;
    const bloq = (await pool.query(`SELECT inicio, fim FROM mednexo.agenda_bloqueio WHERE usuario_id = $1 AND fim > now()`, [uid])).rows.map(b => [new Date(b.inicio).getTime(), new Date(b.fim).getTime()]);
    const ocup = new Set((await pool.query(`SELECT inicio FROM mednexo.agendamento WHERE medico_usuario_id = $1 AND inicio > now() AND (status = 'confirmado' OR (status = 'reservado' AND reservado_ate > now()))`, [uid])).rows.map(r => new Date(r.inicio).getTime()));
    const dur = v.duracao_min * 60000, min = Date.now() + v.antecedencia_horas * 3600e3, total = Math.min(dias || v.janela_dias, v.janela_dias), out = [];
    const base = new Date(Date.now() - 3 * 3600e3); // "agora" em Brasília
    for (let d = 0; d <= total; d++) {
      const dia = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + d)); const ds = dia.toISOString().slice(0, 10), dw = dia.getUTCDay();
      for (const r of regras.filter(x => x.dia_semana === dw)) {
        let t = new Date(`${ds}T${r.i}:00${TZ}`).getTime(); const fim = new Date(`${ds}T${r.f}:00${TZ}`).getTime();
        for (; t + dur <= fim; t += dur) { if (t < min || ocup.has(t) || bloq.some(([a, b]) => t < b && t + dur > a)) continue; out.push(new Date(t).toISOString()); }
      }
    }
    return { medico: v, horarios: [...new Set(out)].sort() };
  }
  const publicoMedico = v => ({ id: v.usuario_id, nome: v.nome, crm: `CRM ${v.crm}/${v.uf}`, especialidade: v.rqe && v.especialidade ? v.especialidade : null, rqe: v.rqe && v.especialidade ? v.rqe : null,
    apresentacao: v.apresentacao || '', valor: Number(v.valor), duracao_min: v.duracao_min });

  // ---- expira reservas não pagas e libera o horário
  async function expirar() {
    const l = (await pool.query(`UPDATE mednexo.agendamento SET status = 'expirado', atualizado_em = now() WHERE status = 'reservado' AND reservado_ate < now() RETURNING teleconsulta_id`)).rows;
    for (const r of l) if (r.teleconsulta_id) { await asaas.cancelarCobrancaTele(r.teleconsulta_id).catch(() => {}); await pool.query(`UPDATE mednexo.teleconsulta SET status = 'encerrada', encerrada_em = now() WHERE id = $1 AND status <> 'encerrada'`, [r.teleconsulta_id]); }
  }
  setInterval(() => expirar().catch(e => console.error('expirar agendamentos:', e.message)), 60000).unref();
  // pagamento confirmado → agendamento confirmado (se o horário foi perdido por atraso, estorna)
  asaas.aoPagar(async teleId => {
    const a = (await pool.query(`SELECT * FROM mednexo.agendamento WHERE teleconsulta_id = $1`, [teleId])).rows[0]; if (!a || a.status === 'confirmado') return;
    try { await pool.query(`UPDATE mednexo.agendamento SET status = 'confirmado', atualizado_em = now() WHERE id = $1`, [a.id]); }
    catch (e) { const t = (await pool.query(`SELECT * FROM mednexo.teleconsulta WHERE id = $1`, [teleId])).rows[0]; await asaas.reembolsarTele(t).catch(x => console.error('estorno automático:', x.message));
      await pool.query(`UPDATE mednexo.agendamento SET status = 'cancelado_medico', atualizado_em = now() WHERE id = $1`, [a.id]); }
  });

  // ---- sessão do médico para reaproveitar as rotas do sistema (mesmas regras, RLS e auditoria)
  async function comoMedico(uid, org, ip) {
    const m = (await pool.query(`SELECT m.papel, u.nome_completo FROM mednexo.organizacao_membro m JOIN mednexo.usuario u ON u.id = m.usuario_id WHERE m.usuario_id = $1 AND m.organizacao_id = $2 AND m.ativo`, [uid, org])).rows[0];
    if (!m) throw err('Médico indisponível.', 409);
    const s = { uid, org, papel: m.papel, nome: m.nome_completo }, ctx = { org, uid, ip: ip || null, ua: 'area-do-cliente', rid: crypto.randomUUID() };
    return (k, b) => pool.tx(c => routes[k](s, c, {}, b, ctx), ctx);
  }

  async function publico(req, res, key, url, readBody, send) {
    if (!key.includes(' /api/portal/')) return false;
    const q = Object.fromEntries(url.searchParams);
    // ---------- sem login
    if (key === 'GET /api/portal/especialidades') {
      const l = (await pool.query(`SELECT CASE WHEN v.rqe IS NOT NULL AND v.especialidade IS NOT NULL THEN v.especialidade ELSE 'Clínica médica (sem especialidade declarada)' END AS e, count(*)::int AS n
        FROM mednexo.medico_vitrine v JOIN mednexo.medico_recebimento r ON r.usuario_id = v.usuario_id WHERE v.ativo AND v.aprovado_em IS NOT NULL AND r.preco_teleconsulta > 0
        AND EXISTS (SELECT 1 FROM mednexo.agenda_regra g WHERE g.usuario_id = v.usuario_id) GROUP BY 1 ORDER BY 1`)).rows;
      send(res, 200, l); return true;
    }
    if (key === 'GET /api/portal/medicos') {
      const ids = (await pool.query(`SELECT v.usuario_id FROM mednexo.medico_vitrine v JOIN mednexo.medico_recebimento r ON r.usuario_id = v.usuario_id WHERE v.ativo AND v.aprovado_em IS NOT NULL AND r.preco_teleconsulta > 0
        AND EXISTS (SELECT 1 FROM mednexo.agenda_regra g WHERE g.usuario_id = v.usuario_id)`)).rows.map(r => r.usuario_id);
      const out = [];
      for (const id of ids) { const h = await horarios(id, 14).catch(() => null); if (!h) continue; const m = publicoMedico(h.medico);
        const esp = m.especialidade || 'Clínica médica (sem especialidade declarada)'; if (q.especialidade && q.especialidade !== esp) continue;
        if (q.busca && !(m.nome + ' ' + esp).toLowerCase().includes(String(q.busca).toLowerCase())) continue;
        out.push({ ...m, proximo: h.horarios[0] || null, livres_14d: h.horarios.length }); }
      send(res, 200, out.sort((a, b) => (a.proximo || 'z').localeCompare(b.proximo || 'z'))); return true;
    }
    if (key === 'GET /api/portal/horarios') { const h = await horarios(uuid(q.medico), Number(q.dias) || null); send(res, 200, { medico: publicoMedico(h.medico), horarios: h.horarios }); return true; }
    if (key === 'POST /api/portal/cadastro') {
      limite('c' + ipDe(req), 5); const b = await readBody(req);
      const nome = need(b.nome, 'Informe seu nome completo.').slice(0, 120), email = need(b.email, 'Informe seu e-mail.').trim().toLowerCase().slice(0, 160), cpf = String(b.cpf || '').replace(/\D/g, '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('E-mail inválido.'); if (!cpfValido(cpf)) throw err('CPF inválido.');
      const nasc = need(b.nascimento, 'Informe a data de nascimento.'); if (!(new Date(nasc) < new Date())) throw err('Data de nascimento inválida.');
      const idade = (Date.now() - new Date(nasc)) / (365.25 * 864e5); if (idade < 18) throw err('A conta deve ser criada por maior de 18 anos. Menores são atendidos com o responsável, que cria a conta.');
      const cel = String(b.celular || '').replace(/\D/g, ''); if (cel.length < 10) throw err('Informe um celular com DDD.');
      if (String(b.senha || '').length < 10) throw err('A senha precisa ter 10 ou mais caracteres.'); if (b.aceite !== true) throw err('É necessário aceitar os Termos de Uso e a Política de Privacidade.');
      if ((await pool.query(`SELECT 1 FROM mednexo.paciente_conta WHERE email = $1 OR cpf = $2`, [email, cpf])).rows.length) throw err('Já existe uma conta com este e-mail ou CPF. Entre com sua senha.', 409);
      const id = (await pool.query(`INSERT INTO mednexo.paciente_conta (email, senha_hash, nome, cpf, nascimento, celular, consentimento_em) VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING id`, [email, hashSenha(b.senha), nome, cpf, nasc, cel])).rows[0].id;
      const tok = crypto.randomBytes(32).toString('hex'); sessoes.set(tok, { id, exp: Date.now() + 8 * 3600e3 });
      send(res, 200, { ok: true }, { 'Set-Cookie': `psid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${segura(req)}` }); return true;
    }
    if (key === 'POST /api/portal/login') {
      limite('l' + ipDe(req), 20); const b = await readBody(req); const email = String(b.email || '').trim().toLowerCase();
      const u = (await pool.query(`SELECT id, senha_hash, ativo, tentativas, bloqueado_ate FROM mednexo.paciente_conta WHERE email = $1`, [email])).rows[0];
      if (u && u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) throw err('Conta bloqueada temporariamente por tentativas erradas. Tente em 15 minutos.', 429);
      if (!u || !u.ativo || !confereSenha(String(b.senha || ''), u.senha_hash)) {
        if (u) await pool.query(`UPDATE mednexo.paciente_conta SET tentativas = tentativas + 1, bloqueado_ate = CASE WHEN tentativas + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END WHERE id = $1`, [u.id]);
        throw err('E-mail ou senha incorretos.', 401); }
      await pool.query(`UPDATE mednexo.paciente_conta SET tentativas = 0, bloqueado_ate = NULL, ultimo_login_em = now() WHERE id = $1`, [u.id]);
      const tok = crypto.randomBytes(32).toString('hex'); sessoes.set(tok, { id: u.id, exp: Date.now() + 8 * 3600e3 });
      send(res, 200, { ok: true }, { 'Set-Cookie': `psid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${segura(req)}` }); return true;
    }
    if (key === 'POST /api/portal/sair') { const t = cookie(req).psid; if (t) sessoes.delete(t); send(res, 200, { ok: true }, { 'Set-Cookie': 'psid=; Max-Age=0; Path=/' }); return true; }
    // ---------- com login
    const pid = conta(req);
    if (lgpd && key === 'GET /api/portal/lgpd') { send(res, 200, await lgpd.portalListar(pid)); return true; }
    if (lgpd && key === 'POST /api/portal/lgpd') { limite('g' + pid, 10); send(res, 200, await lgpd.portalAbrir(pid, await readBody(req))); return true; }
    if (lgpd && key === 'GET /api/portal/meus-dados') { const d = await lgpd.portalExportar(pid); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="meus-dados-mednexo.json"', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(d, null, 2)); return true; }
    if (key === 'GET /api/portal/eu') { const u = (await pool.query(`SELECT nome, email, cpf, nascimento, celular, criado_em FROM mednexo.paciente_conta WHERE id = $1`, [pid])).rows[0];
      send(res, 200, { ...u, cpf: '•••.•••.' + u.cpf.slice(6, 9) + '-' + u.cpf.slice(9) }); return true; }
    if (key === 'POST /api/portal/eu') { const b = await readBody(req); const cel = String(b.celular || '').replace(/\D/g, '');
      if (cel && cel.length < 10) throw err('Celular inválido.'); if (cel) await pool.query(`UPDATE mednexo.paciente_conta SET celular = $2 WHERE id = $1`, [pid, cel]);
      if (b.nova_senha) { if (String(b.nova_senha).length < 10) throw err('A nova senha precisa ter 10 ou mais caracteres.');
        const u = (await pool.query(`SELECT senha_hash FROM mednexo.paciente_conta WHERE id = $1`, [pid])).rows[0]; if (!confereSenha(String(b.senha_atual || ''), u.senha_hash)) throw err('Senha atual incorreta.', 403);
        await pool.query(`UPDATE mednexo.paciente_conta SET senha_hash = $2 WHERE id = $1`, [pid, hashSenha(b.nova_senha)]); }
      send(res, 200, { ok: true }); return true; }
    if (key === 'POST /api/portal/agendar') {
      limite('a' + pid, 15); const b = await readBody(req); const mid = uuid(b.medico); const ini = new Date(need(b.inicio, 'Escolha o horário.'));
      await expirar();
      const h = await horarios(mid); if (!h.horarios.includes(ini.toISOString())) throw err('Este horário acabou de ficar indisponível. Escolha outro.', 409);
      const v = h.medico, u = (await pool.query(`SELECT * FROM mednexo.paciente_conta WHERE id = $1`, [pid])).rows[0];
      let ag;
      try { ag = (await pool.query(`INSERT INTO mednexo.agendamento (medico_usuario_id, organizacao_id, paciente_conta_id, inicio, fim, valor, status, reservado_ate) VALUES ($1,$2,$3,$4,$5,$6,'reservado', now() + interval '15 minutes') RETURNING *`,
        [mid, v.organizacao_id, pid, ini.toISOString(), new Date(ini.getTime() + v.duracao_min * 60000).toISOString(), v.valor])).rows[0]; }
      catch (e) { throw err('Este horário acabou de ser reservado por outra pessoa. Escolha outro.', 409); }
      try {
        const call = await comoMedico(mid, v.organizacao_id, ipDe(req));
        let pac = (await pool.query(`SELECT id FROM mednexo.paciente WHERE organizacao_id = $1 AND cpf = $2 LIMIT 1`, [v.organizacao_id, u.cpf])).rows[0];
        if (!pac) pac = await call('POST /api/pacientes', { nome_completo: u.nome, cpf: u.cpf, data_nascimento: new Date(u.nascimento).toISOString().slice(0, 10) });
        const tc = await call('POST /api/tele/criar', { paciente_id: pac.id, valor: v.valor });
        await pool.query(`UPDATE mednexo.teleconsulta SET expira_em = $2::timestamptz + interval '3 hours' WHERE id = $1`, [tc.id, ag.fim]);
        await pool.query(`UPDATE mednexo.agendamento SET paciente_id = $2, teleconsulta_id = $3, chave_cifrada = $4, atualizado_em = now() WHERE id = $1`, [ag.id, pac.id, tc.id, asaas.cifra(tc.chave)]);
        const t = (await pool.query(`SELECT t.*, us.nome_completo AS medico, p.nome_completo AS paciente_nome FROM mednexo.teleconsulta t JOIN mednexo.usuario us ON us.id = t.medico_usuario_id JOIN mednexo.paciente p ON p.id = t.paciente_id WHERE t.id = $1`, [tc.id])).rows[0];
        const pg = await asaas.cobrarTele(t, { nome: u.nome, cpf: u.cpf, email: u.email });
        send(res, 200, { id: ag.id, reservado_ate: ag.reservado_ate, pagamento: pg }); return true;
      } catch (e) { await pool.query(`UPDATE mednexo.agendamento SET status = 'erro', atualizado_em = now() WHERE id = $1`, [ag.id]); throw e; }
    }
    const meu = async id => { const a = (await pool.query(`SELECT * FROM mednexo.agendamento WHERE id = $1 AND paciente_conta_id = $2`, [uuid(id), pid])).rows[0]; if (!a) throw err('Agendamento não encontrado.', 404); return a; };
    if (key === 'GET /api/portal/consultas') {
      await expirar();
      const l = (await pool.query(`SELECT a.id, a.inicio, a.fim, a.valor, a.status, a.reservado_ate, u.nome_completo AS medico, v.especialidade, v.rqe, p.numero_registro AS crm, p.uf,
          t.status AS tele_status, t.pago_em, t.reembolsado_em, (SELECT n.pdf_url FROM mednexo.nota_fiscal n WHERE n.teleconsulta_id = a.teleconsulta_id AND n.status = 'AUTHORIZED' ORDER BY n.criado_em DESC LIMIT 1) AS nota_pdf,
          (SELECT json_agg(json_build_object('id', x.id, 'nome', x.nome, 'categoria', x.categoria, 'criado_em', x.criado_em) ORDER BY x.criado_em) FROM mednexo.tele_anexo x WHERE x.teleconsulta_id = a.teleconsulta_id AND x.enviado_por = 'medico') AS documentos
        FROM mednexo.agendamento a JOIN mednexo.usuario u ON u.id = a.medico_usuario_id LEFT JOIN mednexo.medico_vitrine v ON v.usuario_id = a.medico_usuario_id LEFT JOIN mednexo.profissional p ON p.usuario_id = a.medico_usuario_id LEFT JOIN mednexo.teleconsulta t ON t.id = a.teleconsulta_id
        WHERE a.paciente_conta_id = $1 AND a.status <> 'erro' ORDER BY a.inicio DESC LIMIT 100`, [pid])).rows;
      send(res, 200, l.map(x => ({ ...x, especialidade: x.rqe ? x.especialidade : null, documentos: x.documentos || [] }))); return true;
    }
    if (key === 'GET /api/portal/pagamento') { const a = await meu(q.id); if (a.status !== 'reservado') { send(res, 200, { status: a.status }); return true; }
      const t = (await pool.query(`SELECT t.*, us.nome_completo AS medico, p.nome_completo AS paciente_nome FROM mednexo.teleconsulta t JOIN mednexo.usuario us ON us.id = t.medico_usuario_id JOIN mednexo.paciente p ON p.id = t.paciente_id WHERE t.id = $1`, [a.teleconsulta_id])).rows[0];
      const st = await asaas.statusTele(t); const ag = (await pool.query(`SELECT status FROM mednexo.agendamento WHERE id = $1`, [a.id])).rows[0];
      send(res, 200, { status: ag.status, pago: st.pago, pagamento: st.pago ? null : await asaas.cobrarTele(t, {}) }); return true; }
    if (key === 'GET /api/portal/sala') { const a = await meu(q.id); if (a.status !== 'confirmado') throw err('A consulta ainda não está confirmada.', 409);
      send(res, 200, { link: '/tele#' + asaas.decifra(a.chave_cifrada) }); return true; }
    if (key === 'GET /api/portal/documento') { const a = await meu(q.id);
      const d = (await pool.query(`SELECT nome, mime, encode(conteudo,'base64') AS b64 FROM mednexo.tele_anexo WHERE id = $1 AND teleconsulta_id = $2 AND enviado_por = 'medico'`, [uuid(q.doc), a.teleconsulta_id])).rows[0];
      if (!d) throw err('Documento não encontrado.', 404); const buf = Buffer.from(d.b64, 'base64');
      res.writeHead(200, { 'Content-Type': d.mime, 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename="${encodeURIComponent(d.nome)}"`, 'Cache-Control': 'private, no-store' }); res.end(buf); return true; }
    if (key === 'POST /api/portal/cancelar') { const b = await readBody(req); const a = await meu(b.id);
      if (a.status !== 'reservado') throw err('Consultas já pagas não podem ser canceladas por aqui. Fale com o consultório do médico.', 409);
      await pool.query(`UPDATE mednexo.agendamento SET status = 'cancelado_paciente', atualizado_em = now() WHERE id = $1`, [a.id]);
      if (a.teleconsulta_id) { await asaas.cancelarCobrancaTele(a.teleconsulta_id).catch(() => {}); await pool.query(`UPDATE mednexo.teleconsulta SET status = 'encerrada', encerrada_em = now() WHERE id = $1`, [a.teleconsulta_id]); }
      send(res, 200, { ok: true }); return true; }
    send(res, 404, { erro: 'rota inexistente' }); return true;
  }

  // =================== ROTAS DO MÉDICO E DO GESTOR (sessão do sistema) ===================
  const medico = s => { if (!['medico_administrador', 'medico_assistente'].includes(s.papel)) throw err('Somente médicos têm agenda pública.', 403); };
  const hm = v => { const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/); if (!m || +m[1] > 23 || +m[2] > 59) throw err('Horário inválido (use HH:MM).'); return `${m[1].padStart(2, '0')}:${m[2]}`; };
  const R = {
    'GET /api/agenda': async (s) => { medico(s);
      const v = (await pool.query(`SELECT * FROM mednexo.medico_vitrine WHERE usuario_id = $1`, [s.uid])).rows[0] || null;
      const regras = (await pool.query(`SELECT id, dia_semana, to_char(inicio,'HH24:MI') AS inicio, to_char(fim,'HH24:MI') AS fim FROM mednexo.agenda_regra WHERE usuario_id = $1 ORDER BY dia_semana, inicio`, [s.uid])).rows;
      const bloqueios = (await pool.query(`SELECT id, inicio, fim, motivo FROM mednexo.agenda_bloqueio WHERE usuario_id = $1 AND fim > now() ORDER BY inicio`, [s.uid])).rows;
      const agendamentos = (await pool.query(`SELECT a.id, a.inicio, a.status, a.valor, c.nome AS paciente, a.teleconsulta_id FROM mednexo.agendamento a JOIN mednexo.paciente_conta c ON c.id = a.paciente_conta_id WHERE a.medico_usuario_id = $1 AND a.inicio > now() - interval '1 day' AND a.status IN ('reservado','confirmado') ORDER BY a.inicio LIMIT 100`, [s.uid])).rows;
      const rec = (await pool.query(`SELECT preco_teleconsulta FROM mednexo.medico_recebimento WHERE usuario_id = $1`, [s.uid])).rows[0];
      const prof = (await pool.query(`SELECT especialidade FROM mednexo.profissional WHERE usuario_id = $1`, [s.uid])).rows[0];
      return { vitrine: v, regras, bloqueios, agendamentos, preco: rec ? rec.preco_teleconsulta : null, tem_recebimento: !!rec, tem_crm: !!prof, especialidade_cadastro: prof && prof.especialidade, dias: DIAS };
    },
    'POST /api/agenda/vitrine': async (s, c, q, b) => { medico(s);
      if (!(await pool.query(`SELECT 1 FROM mednexo.profissional WHERE usuario_id = $1`, [s.uid])).rows.length) throw err('Registre seu CRM em Meu perfil antes de abrir a agenda.', 409);
      const esp = String(b.especialidade || '').trim().slice(0, 80) || null, rqe = String(b.rqe || '').replace(/[^\dA-Za-z-]/g, '').slice(0, 20) || null;
      if (esp && !rqe) throw err('Pelas regras do CFM, para divulgar uma especialidade é obrigatório informar o RQE. Sem RQE, deixe a especialidade em branco.');
      const dur = parseInt(b.duracao_min, 10) || 30, ant = parseInt(b.antecedencia_horas, 10); const jan = parseInt(b.janela_dias, 10) || 30;
      await pool.query(`INSERT INTO mednexo.medico_vitrine (usuario_id, organizacao_id, ativo, especialidade, rqe, apresentacao, duracao_min, antecedencia_horas, janela_dias) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (usuario_id) DO UPDATE SET ativo = EXCLUDED.ativo, especialidade = EXCLUDED.especialidade, rqe = EXCLUDED.rqe, apresentacao = EXCLUDED.apresentacao, duracao_min = EXCLUDED.duracao_min,
          antecedencia_horas = EXCLUDED.antecedencia_horas, janela_dias = EXCLUDED.janela_dias, atualizado_em = now(),
          aprovado_em = CASE WHEN mednexo.medico_vitrine.especialidade IS DISTINCT FROM EXCLUDED.especialidade OR mednexo.medico_vitrine.rqe IS DISTINCT FROM EXCLUDED.rqe OR mednexo.medico_vitrine.apresentacao IS DISTINCT FROM EXCLUDED.apresentacao THEN NULL ELSE mednexo.medico_vitrine.aprovado_em END`,
        [s.uid, s.org, b.ativo === true, esp, rqe, String(b.apresentacao || '').trim().slice(0, 600) || null, dur, Number.isFinite(ant) ? ant : 2, jan]);
      return { ok: true };
    },
    'POST /api/agenda/regras': async (s, c, q, b) => { medico(s); const l = Array.isArray(b.regras) ? b.regras : [];
      const rs = l.map(r => { const d = parseInt(r.dia_semana, 10); if (!(d >= 0 && d <= 6)) throw err('Dia da semana inválido.'); const i = hm(r.inicio), f = hm(r.fim); if (f <= i) throw err(`No ${DIAS[d]}, o fim precisa ser depois do início.`); return [d, i, f]; });
      await pool.tx(async c2 => { await c2.query(`DELETE FROM mednexo.agenda_regra WHERE usuario_id = $1`, [s.uid]); for (const [d, i, f] of rs) await c2.query(`INSERT INTO mednexo.agenda_regra (usuario_id, dia_semana, inicio, fim) VALUES ($1,$2,$3,$4)`, [s.uid, d, i, f]); });
      return { ok: true }; },
    'POST /api/agenda/bloqueio': async (s, c, q, b) => { medico(s); const i = new Date(need(b.inicio, 'Informe o início.')), f = new Date(need(b.fim, 'Informe o fim.'));
      if (!(f > i)) throw err('O fim do bloqueio precisa ser depois do início.');
      await pool.query(`INSERT INTO mednexo.agenda_bloqueio (usuario_id, inicio, fim, motivo) VALUES ($1,$2,$3,$4)`, [s.uid, i.toISOString(), f.toISOString(), String(b.motivo || '').slice(0, 120) || null]); return { ok: true }; },
    'POST /api/agenda/bloqueio/remover': async (s, c, q, b) => { medico(s); await pool.query(`DELETE FROM mednexo.agenda_bloqueio WHERE id = $1 AND usuario_id = $2`, [uuid(b.id), s.uid]); return { ok: true }; },
    'POST /api/agenda/cancelar': async (s, c, q, b) => { medico(s);
      const a = (await pool.query(`SELECT * FROM mednexo.agendamento WHERE id = $1 AND (medico_usuario_id = $2 OR ($3 = 'medico_administrador' AND organizacao_id = $4))`, [uuid(b.id), s.uid, s.papel, s.org])).rows[0];
      if (!a || !['reservado', 'confirmado'].includes(a.status)) throw err('Agendamento não encontrado ou já encerrado.', 404);
      const t = a.teleconsulta_id && (await pool.query(`SELECT * FROM mednexo.teleconsulta WHERE id = $1`, [a.teleconsulta_id])).rows[0];
      if (a.status === 'confirmado' && t) { if (t.iniciada_em) throw err('A consulta já foi iniciada.', 409); await asaas.reembolsarTele(t); }
      else if (t) await asaas.cancelarCobrancaTele(t.id).catch(() => {});
      await pool.query(`UPDATE mednexo.agendamento SET status = 'cancelado_medico', atualizado_em = now() WHERE id = $1`, [a.id]);
      if (t) await pool.query(`UPDATE mednexo.teleconsulta SET status = 'encerrada', encerrada_em = coalesce(encerrada_em, now()) WHERE id = $1`, [t.id]);
      await c.query(`SELECT mednexo.auditar_acesso('agenda_cancelar','agendamento',$1,NULL,NULL,'{}'::jsonb)`, [a.id]); return { ok: true }; },
    // gestor: aprovação da vitrine
    'GET /api/equipe/vitrine': async (s) => { if (s.papel !== 'medico_administrador') throw err('Somente o gestor.', 403);
      return (await pool.query(`SELECT v.usuario_id, u.nome_completo, v.ativo, v.aprovado_em, v.especialidade, v.rqe, v.apresentacao, v.duracao_min FROM mednexo.medico_vitrine v JOIN mednexo.usuario u ON u.id = v.usuario_id WHERE v.organizacao_id = $1 ORDER BY u.nome_completo`, [s.org])).rows; },
    'POST /api/equipe/vitrine': async (s, c, q, b) => { if (s.papel !== 'medico_administrador') throw err('Somente o gestor aprova a agenda pública.', 403);
      const r = await pool.query(`UPDATE mednexo.medico_vitrine SET aprovado_em = CASE WHEN $3 THEN now() ELSE NULL END, aprovado_por = CASE WHEN $3 THEN $4::uuid ELSE NULL END WHERE usuario_id = $1 AND organizacao_id = $2 RETURNING usuario_id`, [uuid(b.usuario_id), s.org, b.aprovado === true, s.uid]);
      if (!r.rows.length) throw err('Médico não encontrado.', 404);
      await c.query(`SELECT mednexo.auditar_acesso($1,'medico_vitrine',$2,NULL,NULL,'{}'::jsonb)`, [b.aprovado === true ? 'vitrine_aprovar' : 'vitrine_suspender', uuid(b.usuario_id)]); return { ok: true }; },
  };
  return { routes: R, publico, migrar: () => pool.raw(MIGRACAO) };
};
