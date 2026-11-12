'use strict';
// Cadastro de hospitais (dados reais), unidades e leitos pelo médico administrador.
const MIGRACAO = `
GRANT INSERT, UPDATE ON mednexo.hospital, mednexo.unidade_internacao, mednexo.leito TO mednexo_app;
GRANT INSERT ON mednexo.membro_hospital TO mednexo_app;
`;
module.exports = function (pool, { need, uuid }) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const txt = (v, max = 200) => { const t = (v === undefined || v === null) ? '' : String(v).trim(); return t ? t.slice(0, max) : null; };
  const dig = (v, n, nome) => { const d = String(v || '').replace(/\D/g, ''); if (!d) return null; if (d.length !== n) throw err(`${nome} deve ter ${n} dígitos.`); return d; };
  const TIPOS = ['hospital_psiquiatrico', 'hospital_geral', 'clinica', 'caps', 'outro'];
  const gerir = s => { if (!['medico_administrador', 'administrativo', 'admin_plataforma'].includes(s.papel)) throw err('Sem permissão para cadastrar hospitais.', 403); };
  const campos = b => {
    const uf = txt(b.uf, 2); if (uf && !/^[A-Za-z]{2}$/.test(uf)) throw err('UF inválida.');
    const dtuf = txt(b.diretor_tecnico_crm_uf, 2); if (dtuf && !/^[A-Za-z]{2}$/.test(dtuf)) throw err('UF do CRM inválida.');
    return [need(b.nome_fantasia, 'Nome do hospital obrigatório').trim().slice(0, 200), txt(b.razao_social), dig(b.cnpj, 14, 'CNPJ'), dig(b.cnes, 7, 'CNES'), TIPOS.includes(b.tipo) ? b.tipo : 'hospital_psiquiatrico',
      txt(b.diretor_tecnico_nome), txt(b.diretor_tecnico_crm, 20), dtuf && dtuf.toUpperCase(), txt(b.telefone, 30), txt(b.email, 200), dig(b.cep, 8, 'CEP'), txt(b.logradouro), txt(b.numero, 20), txt(b.complemento, 100), txt(b.bairro, 100), txt(b.cidade, 100), uf && uf.toUpperCase(), txt(b.cabecalho_documento, 1000)];
  };
  const COLS = ['nome_fantasia', 'razao_social', 'cnpj', 'cnes', 'tipo', 'diretor_tecnico_nome', 'diretor_tecnico_crm', 'diretor_tecnico_crm_uf', 'telefone', 'email', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'cabecalho_documento'];
  const amigavel = e => { const m = String(e.message || ''); if (/cnpj_valido|hospital_cnpj_check/.test(m)) return err('CNPJ inválido (dígitos verificadores não conferem).'); if (/duplicate key/.test(m)) return err('Já existe um registro com esses dados (CNPJ, CNES ou nome).', 409); if (/row-level security/.test(m)) return err('Sem permissão para esta operação.', 403); return e; };
  const R = {
    'GET /api/hospitais/detalhe': async (s, c) => (await c.query(`SELECT h.*, (SELECT count(*)::int FROM mednexo.unidade_internacao u WHERE u.hospital_id = h.id AND u.ativa) AS unidades,
        (SELECT count(*)::int FROM mednexo.leito l WHERE l.hospital_id = h.id AND l.ativo) AS leitos,
        (SELECT count(*)::int FROM mednexo.internacao i WHERE i.hospital_id = h.id AND i.status = 'internado') AS internados FROM mednexo.hospital h ORDER BY h.ativo DESC, h.nome_fantasia`)).rows,
    'POST /api/hospitais': async (s, c, q, b, ctx) => { gerir(s); const v = campos(b);
      try {
        const h = (await c.query(`INSERT INTO mednexo.hospital (organizacao_id, ${COLS.join(',')}) VALUES ($1,${COLS.map((_, i) => '$' + (i + 2) + (COLS[i] === 'tipo' ? '::mednexo.tipo_instituicao' : '')).join(',')}) RETURNING id`, [ctx.org, ...v])).rows[0];
        const m = (await c.query('SELECT id FROM mednexo.organizacao_membro WHERE usuario_id = $1 AND organizacao_id = $2', [ctx.uid, ctx.org])).rows[0];
        if (m) await c.query('INSERT INTO mednexo.membro_hospital (organizacao_id, membro_id, hospital_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ctx.org, m.id, h.id]);
        return { id: h.id };
      } catch (e) { throw amigavel(e); } },
    'POST /api/hospitais/atualizar': async (s, c, q, b) => { gerir(s); const v = campos(b);
      try { const r = await c.query(`UPDATE mednexo.hospital SET ${COLS.map((k, i) => `${k} = $${i + 2}${k === 'tipo' ? '::mednexo.tipo_instituicao' : ''}`).join(', ')} WHERE id = $1 RETURNING id`, [uuid(b.id), ...v]);
        if (!r.rows.length) throw err('Hospital não encontrado.', 404); return { ok: true }; } catch (e) { throw amigavel(e); } },
    'POST /api/hospitais/ativo': async (s, c, q, b) => { gerir(s); const id = uuid(b.id), ativo = b.ativo !== false;
      if (!ativo) { const n = (await c.query(`SELECT count(*)::int AS n FROM mednexo.internacao WHERE hospital_id = $1 AND status = 'internado'`, [id])).rows[0].n; if (n) throw err(`Há ${n} paciente(s) internado(s) neste hospital; dê alta ou transfira antes de desativar.`, 409); }
      await c.query('UPDATE mednexo.hospital SET ativo = $2 WHERE id = $1', [id, ativo]); return { ok: true }; },
    'GET /api/hospitais/estrutura': async (s, c, q) => { const id = uuid(q.id);
      const us = (await c.query('SELECT id, nome, tipo, ativa FROM mednexo.unidade_internacao WHERE hospital_id = $1 ORDER BY nome', [id])).rows;
      const ls = (await c.query(`SELECT l.id, l.unidade_id, l.identificacao, l.tipo_acomodacao, l.ativo, EXISTS (SELECT 1 FROM mednexo.internacao_movimentacao m WHERE m.leito_id = l.id AND m.fim IS NULL) AS ocupado FROM mednexo.leito l WHERE l.hospital_id = $1 ORDER BY l.identificacao`, [id])).rows;
      return us.map(u => ({ ...u, leitos: ls.filter(l => l.unidade_id === u.id) })); },
    'POST /api/unidades': async (s, c, q, b, ctx) => { gerir(s);
      try { return { id: (await c.query('INSERT INTO mednexo.unidade_internacao (organizacao_id, hospital_id, nome, tipo) VALUES ($1,$2,$3,$4) RETURNING id', [ctx.org, uuid(b.hospital_id), need(b.nome, 'Nome da unidade obrigatório').trim().slice(0, 100), txt(b.tipo, 60)])).rows[0].id }; } catch (e) { throw amigavel(e); } },
    // cria um ou vários leitos: identificacao única, ou prefixo + quantidade (ex.: "Leito " x 10 => Leito 01..Leito 10)
    'POST /api/leitos': async (s, c, q, b, ctx) => { gerir(s);
      const u = (await c.query('SELECT id, hospital_id FROM mednexo.unidade_internacao WHERE id = $1', [uuid(b.unidade_id)])).rows[0]; if (!u) throw err('Unidade não encontrada.', 404);
      const qtd = Math.min(200, Math.max(1, parseInt(b.quantidade, 10) || 1)); const pre = txt(b.identificacao, 40); if (!pre) throw err('Identificação do leito obrigatória.');
      const nomes = qtd === 1 ? [pre] : Array.from({ length: qtd }, (_, i) => pre + String(i + 1).padStart(2, '0'));
      try { for (const n of nomes) await c.query('INSERT INTO mednexo.leito (organizacao_id, hospital_id, unidade_id, identificacao, tipo_acomodacao) VALUES ($1,$2,$3,$4,$5)', [ctx.org, u.hospital_id, u.id, n, txt(b.tipo_acomodacao, 60)]); } catch (e) { throw amigavel(e); }
      return { criados: nomes.length }; },
    'POST /api/leitos/ativo': async (s, c, q, b) => { gerir(s); const id = uuid(b.id), ativo = b.ativo !== false;
      if (!ativo && (await c.query('SELECT 1 FROM mednexo.internacao_movimentacao WHERE leito_id = $1 AND fim IS NULL', [id])).rows.length) throw err('Leito ocupado.', 409);
      await c.query('UPDATE mednexo.leito SET ativo = $2 WHERE id = $1', [id, ativo]); return { ok: true }; },
  };
  return { routes: R, migrar: () => pool.raw(MIGRACAO) };
};
