'use strict';
// Segurança de acesso: autenticação em dois fatores (TOTP, RFC 6238) com códigos de recuperação,
// trilha de auditoria de login/logout, e acesso emergencial ("quebra de vidro") com justificativa, prazo, alerta ao gestor e revisão.
const crypto = require('crypto');
const QR = require('./vendor/QRCode'), QRL = require('./vendor/QRCode/QRErrorCorrectLevel');

const MIGRACAO = `
CREATE TABLE IF NOT EXISTS mednexo.usuario_mfa (
  usuario_id uuid PRIMARY KEY REFERENCES mednexo.usuario(id), segredo_cifrado text NOT NULL, ativado_em timestamptz,
  recuperacao text[] NOT NULL DEFAULT '{}', ultimo_passo bigint NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now());
ALTER TABLE mednexo.usuario_mfa ENABLE ROW LEVEL SECURITY;
`;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = buf => { let bits = '', o = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) o += B32[parseInt(bits.slice(i, i + 5), 2)]; return o; };
const deb32 = s => { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); } const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); };
function hotp(seg, passo) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(passo)); const h = crypto.createHmac('sha1', seg).update(b).digest(); const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0'); }
const passoAtual = () => Math.floor(Date.now() / 30000);
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function qrSvg(texto) {
  const q = new QR(-1, QRL.M); q.addData(texto); q.make(); const n = q.getModuleCount(), m = 4; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const PAPEIS_MEDICOS = ['medico_administrador', 'medico_assistente'];

module.exports = function (pool, { need, uuid, cifra, decifra, confereSenha, sessions, env = process.env }) {
  const err = (m, http = 422, extra = {}) => Object.assign(new Error(m), { http }, extra);
  const desafios = new Map(); // token -> { u, exp, n }
  // papéis com 2FA obrigatório: MFA_OBRIGATORIO=medicos | todos | lista de papéis separada por vírgula (vazio = opcional)
  const obrigatorio = papel => { const v = String(env.MFA_OBRIGATORIO || '').trim(); if (!v) return false; if (v === 'todos') return true;
    if (v === 'medicos') return PAPEIS_MEDICOS.includes(papel); return v.split(',').map(x => x.trim()).includes(papel); };

  // ---- auditoria com o contexto do usuário (mesma cadeia de hash do restante do sistema)
  async function auditar(ctx, acao, entidade, id, detalhes = {}) {
    if (!ctx.org || !ctx.uid) return;
    await pool.tx(c => c.query(`SELECT mednexo.auditar_acesso($1,$2,$3,NULL,NULL,$4::jsonb)`, [acao, entidade, id ? String(id) : null, JSON.stringify(detalhes)]), ctx).catch(e => console.error('auditoria:', e.message));
  }
  const mfa = async uid => (await pool.query(`SELECT segredo_cifrado, ativado_em, coalesce(recuperacao, '{}') AS recuperacao, cardinality(recuperacao) AS n_rec, ultimo_passo FROM mednexo.usuario_mfa WHERE usuario_id = $1`, [uid])).rows[0] || null;
  // confere TOTP (janela de ±1 passo, sem reuso) ou um código de recuperação (uso único)
  async function confere(uid, codigo, pendente = false) {
    const m = await mfa(uid); if (!m || (!pendente && !m.ativado_em)) return false;
    const c = String(codigo || '').replace(/\s|-/g, '');
    if (/^\d{6}$/.test(c)) { const seg = deb32(decifra(m.segredo_cifrado)), p = passoAtual();
      for (const d of [0, -1, 1]) { const passo = p + d; if (passo <= Number(m.ultimo_passo)) continue;
        if (crypto.timingSafeEqual(Buffer.from(hotp(seg, passo)), Buffer.from(c))) { await pool.query(`UPDATE mednexo.usuario_mfa SET ultimo_passo = $2 WHERE usuario_id = $1`, [uid, passo]); return 'totp'; } }
      return false; }
    if (!pendente && /^[a-z0-9]{10}$/i.test(c)) { const h = sha(c.toLowerCase()); if ((await pool.query(`SELECT $2 = ANY(recuperacao) AS ok FROM mednexo.usuario_mfa WHERE usuario_id = $1`, [uid, h])).rows[0].ok) { await pool.query(`UPDATE mednexo.usuario_mfa SET recuperacao = array_remove(recuperacao, $2) WHERE usuario_id = $1`, [uid, h]); return 'recuperacao'; } }
    return false;
  }
  // ---- login em duas etapas: chamado pelo server.js depois que a senha confere
  async function aposSenha(u, ctx) {
    const m = await mfa(u.id);
    if (m && m.ativado_em) { const t = crypto.randomBytes(24).toString('hex'); desafios.set(t, { u, exp: Date.now() + 5 * 60e3, n: 0 }); await auditar(ctx, 'login_senha_ok_aguardando_2fa', 'usuario', u.id); return { desafio: t }; }
    return { sessao: { mfa_pendente: obrigatorio(u.papel) } };
  }
  async function segundaEtapa(b, ctx) {
    const d = desafios.get(String(b.desafio || '')); if (!d || d.exp < Date.now()) { desafios.delete(b.desafio); throw err('O tempo para digitar o código acabou. Entre de novo com e-mail e senha.', 401); }
    const tipo = await confere(d.u.id, b.codigo); const c2 = { ...ctx, org: d.u.organizacao_id, uid: d.u.id };
    if (!tipo) { d.n++; await auditar(c2, 'login_2fa_falha', 'usuario', d.u.id); if (d.n >= 5) { desafios.delete(b.desafio); throw err('Muitas tentativas com código errado. Entre de novo com e-mail e senha.', 429); } throw err('Código inválido. Confira o horário do celular e tente o código atual.', 401); }
    desafios.delete(b.desafio); await auditar(c2, tipo === 'recuperacao' ? 'login_2fa_recuperacao' : 'login', 'usuario', d.u.id, { fator: tipo });
    return d.u;
  }
  setInterval(() => { const a = Date.now(); for (const [k, v] of desafios) if (v.exp < a) desafios.delete(k); }, 60e3).unref();

  // ---- rotas permitidas enquanto o 2FA obrigatório não foi configurado
  const LIVRES_MFA = new Set(['GET /api/me', 'GET /api/mfa', 'POST /api/mfa/iniciar', 'POST /api/mfa/ativar', 'POST /api/logout', 'GET /api/perfil']);
  const gestor = s => { if (s.papel !== 'medico_administrador') throw err('Somente o médico gestor.', 403); };

  const R = {
    'GET /api/mfa': async (s) => { const m = await mfa(s.uid); return { ativo: !!(m && m.ativado_em), obrigatorio: obrigatorio(s.papel), codigos_restantes: m && m.ativado_em ? Number(m.n_rec) : 0 }; },
    'POST /api/mfa/iniciar': async (s) => {
      const m = await mfa(s.uid); if (m && m.ativado_em) throw err('A verificação em duas etapas já está ativa. Para trocar de celular, desative e ative de novo.', 409);
      const seg = b32(crypto.randomBytes(20)), email = (await pool.query(`SELECT email FROM mednexo.usuario WHERE id = $1`, [s.uid])).rows[0].email;
      await pool.query(`INSERT INTO mednexo.usuario_mfa (usuario_id, segredo_cifrado) VALUES ($1,$2) ON CONFLICT (usuario_id) DO UPDATE SET segredo_cifrado = EXCLUDED.segredo_cifrado, ativado_em = NULL, recuperacao = '{}', ultimo_passo = 0`, [s.uid, cifra(seg)]);
      const uri = `otpauth://totp/MedNexo:${encodeURIComponent(email)}?secret=${seg}&issuer=MedNexo&algorithm=SHA1&digits=6&period=30`;
      return { qr_svg: qrSvg(uri), segredo: seg.match(/.{1,4}/g).join(' ') };
    },
    'POST /api/mfa/ativar': async (s, c, q, b, ctx) => {
      if (!(await confere(s.uid, b.codigo, true))) throw err('Código inválido. Digite o código de 6 dígitos que aparece agora no aplicativo.');
      const cods = Array.from({ length: 10 }, () => crypto.randomBytes(8).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(10, '7').slice(0, 10));
      await pool.query(`UPDATE mednexo.usuario_mfa SET ativado_em = now(), recuperacao = $2 WHERE usuario_id = $1`, [s.uid, '{' + cods.map(sha).join(',') + '}']);
      s.mfa_pendente = false; for (const v of sessions.values()) if (v.uid === s.uid) v.mfa_pendente = false;
      await auditar(ctx, 'mfa_ativar', 'usuario', s.uid); return { ok: true, codigos_recuperacao: cods };
    },
    'POST /api/mfa/desativar': async (s, c, q, b, ctx) => {
      if (obrigatorio(s.papel)) throw err('Para o seu perfil a verificação em duas etapas é obrigatória. Para trocar de celular, peça ao gestor para reiniciá-la.', 403);
      const h = (await pool.query(`SELECT senha_hash FROM mednexo.usuario WHERE id = $1`, [s.uid])).rows[0].senha_hash;
      if (!confereSenha(String(b.senha || ''), h)) throw err('Senha incorreta.', 403);
      if (!(await confere(s.uid, b.codigo))) throw err('Código inválido.', 403);
      await pool.query(`DELETE FROM mednexo.usuario_mfa WHERE usuario_id = $1`, [s.uid]); await auditar(ctx, 'mfa_desativar', 'usuario', s.uid); return { ok: true };
    },
    'POST /api/equipe/mfa-reiniciar': async (s, c, q, b, ctx) => { gestor(s);
      const m = (await pool.query(`SELECT usuario_id FROM mednexo.organizacao_membro WHERE id = $1 AND organizacao_id = $2`, [uuid(b.membro_id), s.org])).rows[0]; if (!m) throw err('Membro não encontrado.', 404);
      if (m.usuario_id === s.uid) throw err('Você não pode reiniciar a sua própria verificação.', 403);
      await pool.query(`DELETE FROM mednexo.usuario_mfa WHERE usuario_id = $1`, [m.usuario_id]); for (const [k, v] of sessions) if (v.uid === m.usuario_id) sessions.delete(k);
      await auditar(ctx, 'mfa_reiniciar_pelo_gestor', 'usuario', m.usuario_id); return { ok: true };
    },

    // ---------- acesso emergencial (quebra de vidro)
    'GET /api/emergencia/buscar': async (s, c, q) => {
      if (!PAPEIS_MEDICOS.includes(s.papel)) throw err('Somente médicos podem pedir acesso emergencial.', 403);
      const t = String(q.q || '').trim(); if (t.length < 3) throw err('Digite ao menos 3 letras do nome ou o CPF.');
      const cpf = t.replace(/\D/g, '');
      return (await pool.query(`SELECT p.id, p.nome_completo, to_char(p.data_nascimento,'YYYY') AS ano_nascimento,
          (SELECT string_agg(DISTINCT h.nome_fantasia, ', ') FROM mednexo.internacao i JOIN mednexo.hospital h ON h.id = i.hospital_id WHERE i.paciente_id = p.id) AS hospitais
        FROM mednexo.paciente p WHERE p.organizacao_id = $1 AND (p.nome_completo ILIKE '%' || $2 || '%' OR ($3 <> '' AND p.cpf = $3)) ORDER BY p.nome_completo LIMIT 15`, [s.org, t, cpf.length === 11 ? cpf : ''])).rows;
    },
    'POST /api/emergencia': async (s, c, q, b, ctx) => {
      if (!PAPEIS_MEDICOS.includes(s.papel)) throw err('Somente médicos podem pedir acesso emergencial.', 403);
      const pac = (await pool.query(`SELECT id, nome_completo FROM mednexo.paciente WHERE id = $1 AND organizacao_id = $2`, [uuid(b.paciente_id), s.org])).rows[0]; if (!pac) throw err('Paciente não encontrado.', 404);
      const just = String(b.justificativa || '').trim(); if (just.length < 30) throw err('Descreva a emergência com pelo menos 30 caracteres: o que aconteceu e por que você precisa do prontuário agora.');
      const motivo = ['urgencia_clinica', 'intercorrencia', 'plantao_cobertura', 'outro'].includes(b.motivo) ? b.motivo : 'outro';
      const r = (await pool.query(`INSERT INTO mednexo.acesso_emergencia (organizacao_id, usuario_id, paciente_id, motivo, justificativa, expira_em) VALUES ($1,$2,$3,$4,$5, now() + interval '4 hours') RETURNING id, expira_em`, [s.org, s.uid, pac.id, motivo, just.slice(0, 2000)])).rows[0];
      await pool.tx(c2 => c2.query(`SELECT mednexo.auditar_acesso('acesso_emergencial','paciente',$1,$1::uuid,NULL,$2::jsonb)`, [pac.id, JSON.stringify({ acesso_id: r.id, motivo, justificativa: just.slice(0, 500) })]), ctx);
      return { ok: true, id: r.id, expira_em: r.expira_em, paciente: pac.nome_completo };
    },
    'POST /api/emergencia/encerrar': async (s, c, q, b, ctx) => {
      const r = await pool.query(`UPDATE mednexo.acesso_emergencia SET encerrado_em = now() WHERE id = $1 AND usuario_id = $2 AND encerrado_em IS NULL RETURNING id`, [uuid(b.id), s.uid]);
      if (!r.rows.length) throw err('Acesso não encontrado.', 404); await auditar(ctx, 'acesso_emergencial_encerrado', 'acesso_emergencia', b.id); return { ok: true };
    },
    'GET /api/emergencia': async (s) => {
      const meus = (await pool.query(`SELECT a.id, a.paciente_id, p.nome_completo AS paciente, a.criado_em, a.expira_em, a.encerrado_em, a.revisado_em, a.parecer,
          (a.encerrado_em IS NULL AND a.expira_em > now()) AS ativo FROM mednexo.acesso_emergencia a JOIN mednexo.paciente p ON p.id = a.paciente_id
          WHERE a.usuario_id = $1 ORDER BY a.criado_em DESC LIMIT 30`, [s.uid])).rows;
      const revisar = ['medico_administrador', 'auditor'].includes(s.papel) ? (await pool.query(`SELECT a.id, u.nome_completo AS medico, p.nome_completo AS paciente, a.motivo, a.conclusao, a.justificativa, a.criado_em, a.expira_em, a.encerrado_em, a.revisado_em, a.parecer, ru.nome_completo AS revisado_por,
          (SELECT count(*)::int FROM mednexo.auditoria_evento e WHERE e.organizacao_id = a.organizacao_id AND e.usuario_id = a.usuario_id AND e.paciente_id = a.paciente_id AND e.ocorrido_em BETWEEN a.criado_em AND coalesce(a.encerrado_em, a.expira_em)) AS acoes
          FROM mednexo.acesso_emergencia a JOIN mednexo.usuario u ON u.id = a.usuario_id JOIN mednexo.paciente p ON p.id = a.paciente_id LEFT JOIN mednexo.usuario ru ON ru.id = a.revisado_por
          WHERE a.organizacao_id = $1 ORDER BY (a.revisado_em IS NULL) DESC, a.criado_em DESC LIMIT 100`, [s.org])).rows : [];
      return { meus, revisar };
    },
    'POST /api/emergencia/revisar': async (s, c, q, b, ctx) => {
      if (!['medico_administrador', 'auditor'].includes(s.papel)) throw err('Somente o gestor ou o auditor revisam acessos emergenciais.', 403);
      const par = String(b.parecer || '').trim(); if (par.length < 5) throw err('Escreva o parecer da revisão.');
      const conc = b.conclusao === 'indevido' ? 'indevido' : 'justificado';
      const r = await pool.query(`UPDATE mednexo.acesso_emergencia SET revisado_em = now(), revisado_por = $3, parecer = $4, conclusao = $5, encerrado_em = coalesce(encerrado_em, CASE WHEN $5 = 'indevido' THEN now() END)
        WHERE id = $1 AND organizacao_id = $2 AND usuario_id <> $3 RETURNING id`, [uuid(b.id), s.org, s.uid, par.slice(0, 1000), conc]);
      if (!r.rows.length) throw err('Acesso não encontrado (ou é seu: outra pessoa precisa revisar).', 404);
      await auditar(ctx, 'acesso_emergencial_revisado', 'acesso_emergencia', b.id, { conclusao: conc }); return { ok: true };
    },
  };
  const pendentesRevisao = async (s) => ['medico_administrador', 'auditor'].includes(s.papel)
    ? (await pool.query(`SELECT count(*)::int AS n FROM mednexo.acesso_emergencia WHERE organizacao_id = $1 AND revisado_em IS NULL AND usuario_id <> $2`, [s.org, s.uid])).rows[0].n : 0;
  return { routes: R, migrar: () => pool.raw(MIGRACAO), aposSenha, segundaEtapa, auditar, LIVRES_MFA, obrigatorio, pendentesRevisao, mfa, _totp: { hotp, deb32, passoAtual } };
};
