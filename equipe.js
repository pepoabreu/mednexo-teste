'use strict';
// Gestão da equipe pelo médico administrador (dono da organização) e perfil do próprio usuário.
// "Prontuário compartilhado": quando ligado, todos os médicos da organização vinculados ao hospital veem e atendem
// todos os pacientes daquele hospital (e os pacientes externos da organização), sem precisar entrar na equipe de cada internação.
const MIGRACAO = `
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS prontuario_compartilhado boolean NOT NULL DEFAULT false;
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS compartilhado_definido_em timestamptz;
CREATE OR REPLACE FUNCTION mednexo.org_compartilhada() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT coalesce((SELECT prontuario_compartilhado FROM organizacao WHERE id = ctx_org()), false)
     AND ctx_papel() IN ('medico_administrador','medico_assistente') $$;
CREATE OR REPLACE FUNCTION mednexo.acesso_internacao(p_int uuid, p_escrita boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE v_h uuid; v_o uuid;
BEGIN
  SELECT hospital_id, organizacao_id INTO v_h, v_o FROM internacao WHERE id = p_int;
  IF NOT FOUND OR v_o IS DISTINCT FROM ctx_org() THEN RETURN false; END IF;
  IF NOT tem_vinculo_hospital(v_h) THEN RETURN false; END IF;
  IF na_equipe(p_int) THEN RETURN true; END IF;
  IF org_compartilhada() THEN RETURN true; END IF;
  IF NOT p_escrita AND ctx_papel() IN ('medico_administrador','auditor') THEN RETURN true; END IF;
  RETURN false;
END $$;
CREATE OR REPLACE FUNCTION mednexo.paciente_vinculado_a_meus_hospitais(p_pac uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM paciente_hospital ph WHERE ph.paciente_id = p_pac AND tem_vinculo_hospital(ph.hospital_id))
      OR (org_compartilhada() AND EXISTS (SELECT 1 FROM paciente p WHERE p.id = p_pac AND p.organizacao_id = ctx_org())) $$;
ALTER POLICY p_sel ON mednexo.internacao USING (organizacao_id = mednexo.ctx_org() AND mednexo.tem_vinculo_hospital(hospital_id) AND (criado_por = mednexo.ctx_usuario() OR mednexo.na_equipe(id) OR mednexo.ctx_papel() IN ('administrativo','medico_administrador','auditor') OR mednexo.org_compartilhada()));
ALTER POLICY p_upd ON mednexo.internacao USING ((organizacao_id = mednexo.ctx_org() AND mednexo.tem_vinculo_hospital(hospital_id) AND (criado_por = mednexo.ctx_usuario() OR mednexo.na_equipe(id) OR mednexo.ctx_papel() IN ('administrativo','medico_administrador','auditor') OR mednexo.org_compartilhada())) AND (organizacao_id = mednexo.ctx_org() AND mednexo.tem_vinculo_hospital(hospital_id) AND mednexo.tem_permissao('internacao.escrever')));
`;
const PAPEIS = { medico_assistente: 'Médico(a)', medico_administrador: 'Médico(a) gestor(a)', enfermagem: 'Enfermagem', administrativo: 'Administrativo', auditor: 'Auditor(a)' };

module.exports = function (pool, { need, uuid }, { hashSenha, confereSenha, encerrarSessoes }) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const gestor = s => { if (s.papel !== 'medico_administrador') throw err('Somente o médico gestor gerencia a equipe.', 403); };
  const senhaOk = v => { const t = String(v || ''); if (t.length < 10) throw err('A senha precisa ter 10 ou mais caracteres.'); return t; };
  const crmOk = (crm, uf) => { const c = String(crm || '').replace(/\D/g, ''), u = String(uf || '').trim().toUpperCase();
    if (!/^\d{3,9}$/.test(c)) throw err('CRM inválido (somente números).'); if (!/^[A-Z]{2}$/.test(u)) throw err('UF do CRM inválida.'); return [c, u]; };
  const amigavel = e => { const m = String(e.message || ''); if (/usuario_email|email.*unique|duplicate key.*email/i.test(m)) return err('Este e-mail já está cadastrado no MedNexo.', 409);
    if (/profissional/.test(m) && /duplicate/.test(m)) return err('Este CRM já está cadastrado no MedNexo.', 409); return e; };
  // escrita como dono do banco, sempre restrita à organização da sessão (validada aqui) e com contexto para a auditoria
  const comoOrg = (s, fn) => pool.tx(async c => { await c.query(`SELECT set_config('app.usuario_id',$1,true), set_config('app.organizacao_id',$2,true)`, [s.uid, s.org]); return fn(c); });
  const doMembro = async (c, s, membroId) => { const m = (await c.query('SELECT id, usuario_id, papel FROM mednexo.organizacao_membro WHERE id = $1 AND organizacao_id = $2', [uuid(membroId), s.org])).rows[0]; if (!m) throw err('Membro não encontrado.', 404); return m; };

  const R = {
    'GET /api/equipe': async (s, c, q, b, ctx) => { gestor(s);
      const org = (await pool.query('SELECT nome, prontuario_compartilhado FROM mednexo.organizacao WHERE id = $1', [s.org])).rows[0];
      const membros = (await pool.query(`SELECT m.id, m.papel, m.ativo, m.desde, u.id AS usuario_id, u.nome_completo, u.email, u.ultimo_login_em, p.numero_registro AS crm, p.uf, p.especialidade,
          coalesce((SELECT json_agg(mh.hospital_id) FROM mednexo.membro_hospital mh WHERE mh.membro_id = m.id AND mh.ativo), '[]') AS hospitais
        FROM mednexo.organizacao_membro m JOIN mednexo.usuario u ON u.id = m.usuario_id LEFT JOIN mednexo.profissional p ON p.usuario_id = u.id
        WHERE m.organizacao_id = $1 ORDER BY m.ativo DESC, u.nome_completo`, [s.org])).rows;
      const hospitais = (await pool.query('SELECT id, nome_fantasia FROM mednexo.hospital WHERE organizacao_id = $1 AND ativo ORDER BY nome_fantasia', [s.org])).rows;
      return { organizacao: org, membros, hospitais, papeis: PAPEIS, eu: s.uid };
    },
    'POST /api/equipe/membro': async (s, c, q, b) => { gestor(s);
      const nome = need(b.nome, 'Informe o nome completo.').slice(0, 120), email = need(b.email, 'Informe o e-mail de acesso.').toLowerCase().slice(0, 160), senha = senhaOk(b.senha);
      const papel = PAPEIS[b.papel] ? b.papel : null; if (!papel) throw err('Escolha a função.');
      const medico = papel.startsWith('medico'); const [crm, uf] = medico ? crmOk(b.crm, b.uf) : [null, null];
      if ((await pool.query('SELECT 1 FROM mednexo.usuario WHERE email = $1', [email])).rows.length) throw err('Este e-mail já está cadastrado no MedNexo.', 409);
      if (medico && (await pool.query(`SELECT 1 FROM mednexo.profissional WHERE conselho = 'CRM' AND numero_registro = $1 AND uf = $2`, [crm, uf])).rows.length) throw err('Este CRM já está cadastrado no MedNexo.', 409);
      const hosp = Array.isArray(b.hospitais) ? b.hospitais.map(h => uuid(h)) : null;
      try { return await comoOrg(s, async c => {
        const id = (await c.query('INSERT INTO mednexo.usuario (email, nome_completo, senha_hash) VALUES ($1,$2,$3) RETURNING id', [email, nome, hashSenha(senha)])).rows[0].id;
        if (medico) await c.query(`INSERT INTO mednexo.profissional (usuario_id, conselho, numero_registro, uf, especialidade) VALUES ($1,'CRM',$2,$3,$4)`, [id, crm, uf, String(b.especialidade || '').trim().slice(0, 80) || null]);
        const m = (await c.query(`INSERT INTO mednexo.organizacao_membro (organizacao_id, usuario_id, papel) VALUES ($1,$2,$3::mednexo.papel_usuario) RETURNING id`, [s.org, id, papel])).rows[0].id;
        await c.query(`INSERT INTO mednexo.membro_hospital (organizacao_id, membro_id, hospital_id) SELECT $1, $2, h.id FROM mednexo.hospital h WHERE h.organizacao_id = $1 AND h.ativo AND ($3::uuid[] IS NULL OR h.id = ANY($3::uuid[]))`, [s.org, m, hosp ? '{' + hosp.join(',') + '}' : null]);
        await c.query(`SELECT mednexo.auditar_acesso('equipe_incluir','organizacao_membro',$1,NULL,NULL,$2::jsonb)`, [m, JSON.stringify({ papel, email })]);
        return { ok: true, membro_id: m };
      }); } catch (e) { throw amigavel(e); }
    },
    'POST /api/equipe/ativo': async (s, c, q, b) => { gestor(s);
      return comoOrg(s, async c => { const m = await doMembro(c, s, b.membro_id); if (m.usuario_id === s.uid) throw err('Você não pode desativar o próprio acesso.');
        const ativo = b.ativo !== false; await c.query('UPDATE mednexo.organizacao_membro SET ativo = $2 WHERE id = $1', [m.id, ativo]);
        await c.query(`SELECT mednexo.auditar_acesso($1,'organizacao_membro',$2,NULL,NULL,'{}'::jsonb)`, [ativo ? 'equipe_reativar' : 'equipe_desativar', m.id]);
        if (!ativo) encerrarSessoes(m.usuario_id); return { ok: true }; }); },
    'POST /api/equipe/senha': async (s, c, q, b) => { gestor(s); const senha = senhaOk(b.senha);
      return comoOrg(s, async c => { const m = await doMembro(c, s, b.membro_id);
        await c.query('UPDATE mednexo.usuario SET senha_hash = $2, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1', [m.usuario_id, hashSenha(senha)]);
        await c.query(`SELECT mednexo.auditar_acesso('equipe_redefinir_senha','organizacao_membro',$1,NULL,NULL,'{}'::jsonb)`, [m.id]);
        if (m.usuario_id !== s.uid) encerrarSessoes(m.usuario_id); return { ok: true }; }); },
    'POST /api/equipe/hospitais': async (s, c, q, b) => { gestor(s); const hosp = (Array.isArray(b.hospitais) ? b.hospitais : []).map(h => uuid(h));
      return comoOrg(s, async c => { const m = await doMembro(c, s, b.membro_id);
        await c.query('UPDATE mednexo.membro_hospital SET ativo = (hospital_id = ANY($2::uuid[])) WHERE membro_id = $1', [m.id, '{' + hosp.join(',') + '}']);
        await c.query(`INSERT INTO mednexo.membro_hospital (organizacao_id, membro_id, hospital_id) SELECT $1, $2, h.id FROM mednexo.hospital h WHERE h.organizacao_id = $1 AND h.id = ANY($3::uuid[]) AND NOT EXISTS (SELECT 1 FROM mednexo.membro_hospital x WHERE x.membro_id = $2 AND x.hospital_id = h.id)`, [s.org, m.id, '{' + hosp.join(',') + '}']);
        return { ok: true }; }); },
    'POST /api/equipe/compartilhado': async (s, c, q, b) => { gestor(s);
      return comoOrg(s, async c => { await c.query('UPDATE mednexo.organizacao SET prontuario_compartilhado = $2, compartilhado_definido_em = now() WHERE id = $1', [s.org, b.ativo === true]);
        await c.query(`SELECT mednexo.auditar_acesso('org_prontuario_compartilhado','organizacao',$1,NULL,NULL,$2::jsonb)`, [s.org, JSON.stringify({ ativo: b.ativo === true })]); return { ok: true }; }); },
    // ---- perfil do próprio usuário
    'GET /api/perfil': async (s) => (await pool.query(`SELECT u.nome_completo, u.email, p.numero_registro AS crm, p.uf, p.especialidade, o.nome AS organizacao FROM mednexo.usuario u LEFT JOIN mednexo.profissional p ON p.usuario_id = u.id JOIN mednexo.organizacao o ON o.id = $2 WHERE u.id = $1`, [s.uid, s.org])).rows[0],
    'POST /api/perfil/senha': async (s, c, q, b) => { const nova = senhaOk(b.nova);
      const u = (await pool.query('SELECT senha_hash FROM mednexo.usuario WHERE id = $1', [s.uid])).rows[0];
      if (!u || !confereSenha(String(b.atual || ''), u.senha_hash)) throw err('Senha atual incorreta.', 403);
      return comoOrg(s, async c => { await c.query('UPDATE mednexo.usuario SET senha_hash = $2 WHERE id = $1', [s.uid, hashSenha(nova)]);
        await c.query(`SELECT mednexo.auditar_acesso('perfil_trocar_senha','usuario',$1,NULL,NULL,'{}'::jsonb)`, [s.uid]); return { ok: true }; }); },
    'POST /api/perfil/crm': async (s, c, q, b) => { if (!s.papel.startsWith('medico')) throw err('Somente médicos registram CRM.', 403);
      const [crm, uf] = crmOk(b.crm, b.uf);
      if ((await pool.query('SELECT 1 FROM mednexo.profissional WHERE usuario_id = $1', [s.uid])).rows.length) throw err('Seu CRM já está registrado. Para corrigir, fale com o suporte.', 409);
      try { return await comoOrg(s, async c => { await c.query(`INSERT INTO mednexo.profissional (usuario_id, conselho, numero_registro, uf, especialidade) VALUES ($1,'CRM',$2,$3,$4)`, [s.uid, crm, uf, String(b.especialidade || '').trim().slice(0, 80) || null]);
        await c.query(`SELECT mednexo.auditar_acesso('perfil_registrar_crm','usuario',$1,NULL,NULL,$2::jsonb)`, [s.uid, JSON.stringify({ crm, uf })]); return { ok: true }; }); } catch (e) { throw amigavel(e); }
    },
  };
  return { routes: R, migrar: () => pool.raw(MIGRACAO) };
};
