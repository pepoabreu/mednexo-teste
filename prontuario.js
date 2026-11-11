'use strict';
// Anamnese, exame do estado mental, avaliação de risco, diagnósticos/CID e evoluções anteriores.
module.exports = function (pool, { need, uuid }, { internacao, tentarAssinar, txt, ts }) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const mapa = o => { const r = {}; for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) { const t = txt(v); if (t && /^[a-z_]{2,40}$/.test(k)) r[k] = t.slice(0, 2000); } return r; };
  const cab = async (c, ctx, it, tipo, b) => (await c.query(`INSERT INTO mednexo.registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id, ocorrido_em, justificativa_retroativo)
      VALUES ($1,$2,$3,$4,$5::mednexo.tipo_registro,$6,COALESCE($7::timestamptz, clock_timestamp()),$8) RETURNING id`, [ctx.org, it.paciente_id, it.hospital_id, it.id, tipo, ctx.uid, ts(b.ocorrido_em), txt(b.justificativa_retroativo)])).rows[0].id;
  const fim = async (c, b, id) => { const erro = b.assinar ? await tentarAssinar(c, id) : null; return { id, assinado: !!b.assinar && !erro, erro_assinatura: erro }; };
  const SUBST = ['alcool', 'tabaco', 'cannabis', 'cocaina', 'crack', 'opioides', 'benzodiazepinicos', 'outra'];
  const PADRAO = ['nunca', 'experimentacao', 'uso_atual', 'uso_pregresso', 'nao_informado'];
  const DIM = ['ideacao_suicida', 'intencao_suicida', 'planejamento_suicida', 'acesso_meios', 'tentativas_anteriores', 'automutilacao', 'agressividade_terceiros', 'agitacao_psicomotora', 'sintomas_psicoticos_relevantes', 'vulnerabilidade', 'risco_fuga_evasao', 'risco_abstinencia', 'prejuizo_autocuidado'];
  const DOM = ['aparencia', 'atitude', 'consciencia', 'orientacao', 'atencao', 'psicomotricidade', 'humor', 'afeto', 'pensamento', 'sensopercepcao', 'memoria', 'linguagem', 'juizo_critico', 'insight', 'cognicao'];
  const A = ['fonte_informacao', 'acompanhante', 'motivo_avaliacao', 'procedencia', 'contexto_internacao', 'queixa_principal', 'hda_inicio_sintomas', 'hda_tempo_evolucao', 'hda_fatores_desencadeantes', 'hda_sintomas_predominantes', 'hda_evolucao_recente', 'hda_tratamentos_realizados', 'hda_resposta_tratamentos', 'hda_impacto_funcional', 'hda_complementar'];
  const R = {
    'POST /api/anamneses': async (s, c, q, b, ctx) => {
      const it = await internacao(c, b.internacao_id); const id = await cab(c, ctx, it, 'anamnese', b);
      const conf = ['boa', 'regular', 'ruim', 'nao_avaliavel'].includes(b.confiabilidade_relato) ? b.confiabilidade_relato : null;
      await c.query(`INSERT INTO mednexo.anamnese (registro_id, ${A.join(',')}, confiabilidade_relato, antecedentes_psiquiatricos, antecedentes_pessoais, antecedentes_familiares, contexto_psicossocial)
        VALUES ($1,${A.map((_, i) => '$' + (i + 2)).join(',')},$${A.length + 2}::mednexo.confiabilidade_relato,$${A.length + 3}::jsonb,$${A.length + 4}::jsonb,$${A.length + 5}::jsonb,$${A.length + 6}::jsonb)`,
        [id, ...A.map(k => txt(b[k])), conf, JSON.stringify(mapa(b.antecedentes_psiquiatricos)), JSON.stringify(mapa(b.antecedentes_pessoais)), JSON.stringify(mapa(b.antecedentes_familiares)), JSON.stringify(mapa(b.contexto_psicossocial))]);
      for (const sb of (Array.isArray(b.substancias) ? b.substancias : [])) {
        if (!SUBST.includes(sb.substancia) || !PADRAO.includes(sb.padrao)) continue;
        await c.query(`INSERT INTO mednexo.anamnese_substancia (registro_id, substancia, outra_descricao, padrao, frequencia, quantidade, ultimo_consumo, historico_abstinencia) VALUES ($1,$2::mednexo.substancia,$3,$4::mednexo.padrao_uso,$5,$6,$7,$8)`,
          [id, sb.substancia, sb.substancia === 'outra' ? need(sb.outra_descricao, 'descreva a outra substância') : null, sb.padrao, txt(sb.frequencia), txt(sb.quantidade), txt(sb.ultimo_consumo), txt(sb.historico_abstinencia)]);
      }
      return fim(c, b, id);
    },
    'GET /api/eem/catalogo': async (s, c) => (await c.query('SELECT dominio, codigo, descricao FROM mednexo.eem_catalogo ORDER BY dominio, ordem')).rows,
    'POST /api/eem': async (s, c, q, b, ctx) => {
      const it = await internacao(c, b.internacao_id); const doms = Array.isArray(b.dominios) ? b.dominios : [];
      const id = await cab(c, ctx, it, 'exame_estado_mental', b);
      await c.query('INSERT INTO mednexo.exame_estado_mental (registro_id, observacoes_gerais) VALUES ($1,$2)', [id, txt(b.observacoes_gerais)]);
      for (const d of DOM) {
        const x = doms.find(y => y.dominio === d) || {}; const av = x.avaliado !== false && (x.itens || []).length + (txt(x.observacao) ? 1 : 0) > 0 ? true : x.avaliado === true;
        if (!av && !txt(x.observacao)) throw err(`Domínio "${d}": marque achados ou, se não avaliado, justifique.`);
        await c.query('INSERT INTO mednexo.eem_dominio (registro_id, dominio, avaliado, observacao) VALUES ($1,$2::mednexo.dominio_eem,$3,$4)', [id, d, av, txt(x.observacao)]);
        if (av) for (const cod of (x.itens || [])) await c.query('INSERT INTO mednexo.eem_item (registro_id, dominio, codigo) VALUES ($1,$2::mednexo.dominio_eem,$3)', [id, d, String(cod)]);
      }
      return fim(c, b, id);
    },
    'POST /api/riscos': async (s, c, q, b, ctx) => {
      const it = await internacao(c, b.internacao_id); const id = await cab(c, ctx, it, 'avaliacao_risco', b);
      const nivel = ['baixo', 'moderado', 'alto', 'iminente'].includes(b.nivel_risco) ? b.nivel_risco : null;
      await c.query(`INSERT INTO mednexo.avaliacao_risco (registro_id, achados_clinicos, fatores_risco, fatores_protetores, rede_apoio, avaliacao_clinica, nivel_risco_profissional, justificativa_nivel, conduta, necessita_reavaliacao, reavaliar_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7::mednexo.nivel_risco,$8,$9,$10,$11)`, [id, txt(b.achados_clinicos), txt(b.fatores_risco), txt(b.fatores_protetores), txt(b.rede_apoio), txt(b.avaliacao_clinica), nivel, txt(b.justificativa_nivel), txt(b.conduta),
        b.necessita_reavaliacao === true ? true : b.necessita_reavaliacao === false ? false : null, ts(b.reavaliar_em)]);
      const itens = Array.isArray(b.itens) ? b.itens : [];
      for (const d of DIM) {
        const x = itens.find(y => y.dimensao === d) || {}; const sit = ['ausente', 'presente', 'nao_avaliado'].includes(x.situacao) ? x.situacao : 'nao_avaliado';
        if (sit === 'nao_avaliado' && !txt(x.observacao)) throw err(`Dimensão "${d.replace(/_/g, ' ')}": marque ausente/presente ou justifique "não avaliado".`);
        await c.query('INSERT INTO mednexo.avaliacao_risco_item (registro_id, dimensao, situacao, observacao) VALUES ($1,$2::mednexo.dimensao_risco,$3::mednexo.situacao_risco,$4)', [id, d, sit, txt(x.observacao)]);
      }
      return fim(c, b, id);
    },
    // ---- CID e diagnósticos
    'GET /api/cid': async (s, c, q) => (await c.query(`SELECT id, versao, codigo, descricao FROM mednexo.cid WHERE ativo AND ($1 = '' OR codigo ILIKE $1 || '%' OR descricao ILIKE '%' || $1 || '%') ORDER BY codigo LIMIT 40`, [(q.q || '').slice(0, 60)])).rows,
    'POST /api/cid': async (s, c, q, b) => {
      if (s.papel !== 'medico_administrador') throw err('Somente o médico administrador cadastra CID.', 403);
      const v = b.versao === 'CID-11' ? 'CID-11' : 'CID-10';
      const r = (await pool.query(`INSERT INTO mednexo.cid (versao, codigo, descricao) VALUES ($1::mednexo.versao_cid,$2,$3) ON CONFLICT (versao, codigo) DO UPDATE SET descricao = EXCLUDED.descricao RETURNING id`, [v, need(b.codigo, 'código obrigatório').toUpperCase().slice(0, 12), need(b.descricao, 'descrição obrigatória').slice(0, 300)])).rows[0];
      return { id: r.id };
    },
    'GET /api/diagnosticos': async (s, c, q) => (await c.query(`SELECT d.id, d.situacao, d.momento, d.principal, d.observacao, d.registrado_em, d.encerrado_em, cid.codigo, cid.descricao, cid.versao, u.nome_completo AS por
      FROM mednexo.diagnostico d JOIN mednexo.cid ON cid.id = d.cid_id JOIN mednexo.usuario u ON u.id = d.registrado_por WHERE d.internacao_id = $1 ORDER BY d.encerrado_em NULLS FIRST, d.registrado_em DESC`, [uuid(q.internacao_id)])).rows,
    'POST /api/diagnosticos': async (s, c, q, b, ctx) => {
      const it = await internacao(c, b.internacao_id);
      const sit = ['hipotese', 'confirmado', 'descartado', 'resolvido'].includes(b.situacao) ? b.situacao : null; if (!sit) throw err('Situação do diagnóstico obrigatória.');
      const mom = ['admissao', 'curso', 'alta', 'historico'].includes(b.momento) ? b.momento : 'curso';
      if (b.principal) await c.query('UPDATE mednexo.diagnostico SET principal = false WHERE internacao_id = $1 AND principal AND encerrado_em IS NULL', [it.id]);
      const r = (await c.query(`INSERT INTO mednexo.diagnostico (organizacao_id, paciente_id, internacao_id, hospital_id, cid_id, situacao, momento, principal, observacao, registrado_por)
        VALUES ($1,$2,$3,$4,$5,$6::mednexo.situacao_diagnostico,$7::mednexo.momento_diagnostico,$8,$9,$10) RETURNING id`, [ctx.org, it.paciente_id, it.id, it.hospital_id, parseInt(b.cid_id, 10), sit, mom, !!b.principal, txt(b.observacao), ctx.uid])).rows[0];
      return { id: r.id };
    },
    'POST /api/diagnosticos/encerrar': async (s, c, q, b) => { await c.query('UPDATE mednexo.diagnostico SET encerrado_em = now(), principal = false WHERE id = $1 AND encerrado_em IS NULL', [uuid(b.id)]); return { ok: true }; },
    // ---- apoio ao preenchimento da evolução
    'GET /api/evolucoes/recentes': async (s, c, q) => (await c.query(`SELECT rc.id, rc.ocorrido_em, rc.status, u.nome_completo AS autor, e.motivo, e.subjetivo, e.objetivo, e.estado_mental, e.conduta, e.texto_livre
      FROM mednexo.registro_clinico rc JOIN mednexo.evolucao e ON e.registro_id = rc.id JOIN mednexo.usuario u ON u.id = rc.autor_usuario_id
      WHERE rc.internacao_id = $1 AND rc.tipo = 'evolucao' AND rc.status = 'assinado' ORDER BY rc.ocorrido_em DESC LIMIT 5`, [uuid(q.internacao_id)])).rows,
  };
  async function detalhe(c, r) {
    if (r.tipo === 'anamnese') {
      r.anamnese = (await c.query('SELECT * FROM mednexo.anamnese WHERE registro_id = $1', [r.id])).rows[0];
      r.substancias = (await c.query('SELECT * FROM mednexo.anamnese_substancia WHERE registro_id = $1', [r.id])).rows;
    } else if (r.tipo === 'exame_estado_mental') {
      r.eem = (await c.query('SELECT observacoes_gerais FROM mednexo.exame_estado_mental WHERE registro_id = $1', [r.id])).rows[0];
      r.dominios = (await c.query(`SELECT d.dominio, d.avaliado, d.observacao, COALESCE((SELECT array_agg(cat.descricao ORDER BY cat.ordem) FROM mednexo.eem_item i JOIN mednexo.eem_catalogo cat ON cat.dominio = i.dominio AND cat.codigo = i.codigo
        WHERE i.registro_id = d.registro_id AND i.dominio = d.dominio), '{}') AS itens FROM mednexo.eem_dominio d WHERE d.registro_id = $1 ORDER BY d.dominio`, [r.id])).rows;
    } else if (r.tipo === 'avaliacao_risco') {
      r.risco = (await c.query('SELECT * FROM mednexo.avaliacao_risco WHERE registro_id = $1', [r.id])).rows[0];
      r.itens_risco = (await c.query('SELECT dimensao, situacao, observacao FROM mednexo.avaliacao_risco_item WHERE registro_id = $1 ORDER BY dimensao', [r.id])).rows;
    }
  }
  return { routes: R, detalhe };
};
