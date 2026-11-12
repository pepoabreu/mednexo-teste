'use strict';
// Repasse médico por paciente acompanhado + contas a receber. Valores em centavos (inteiros).
const MIGRACAO = `
CREATE TABLE IF NOT EXISTS mednexo.repasse_regra (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizacao_id uuid NOT NULL, hospital_id uuid NOT NULL, medico_usuario_id uuid NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('visita','parecer','plantao','procedimento','outro')), descricao text,
  valor_centavos bigint NOT NULL CHECK (valor_centavos > 0), prazo_pagamento_dias integer NOT NULL DEFAULT 30 CHECK (prazo_pagamento_dias BETWEEN 0 AND 365),
  fonte_pagadora text, ativo boolean NOT NULL DEFAULT true, criado_em timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS ux_repasse_regra ON mednexo.repasse_regra (hospital_id, medico_usuario_id, tipo) WHERE ativo;
CREATE TABLE IF NOT EXISTS mednexo.repasse_lancamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizacao_id uuid NOT NULL, medico_usuario_id uuid NOT NULL,
  paciente_id uuid NOT NULL, internacao_id uuid NOT NULL, hospital_id uuid NOT NULL,
  data_servico date NOT NULL, tipo text NOT NULL CHECK (tipo IN ('visita','parecer','plantao','procedimento','outro')), descricao text,
  valor_centavos bigint NOT NULL CHECK (valor_centavos > 0), fonte_pagadora text, vencimento date,
  status text NOT NULL DEFAULT 'previsto' CHECK (status IN ('previsto','faturado','cancelado')), faturado_em date,
  glosa_centavos bigint NOT NULL DEFAULT 0 CHECK (glosa_centavos >= 0), glosa_motivo text, motivo_cancelamento text,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','evolucao')), criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (glosa_centavos <= valor_centavos));
CREATE UNIQUE INDEX IF NOT EXISTS ux_repasse_visita_auto ON mednexo.repasse_lancamento (internacao_id, data_servico, tipo, medico_usuario_id) WHERE origem = 'evolucao' AND status <> 'cancelado';
CREATE INDEX IF NOT EXISTS ix_repasse_lanc ON mednexo.repasse_lancamento (organizacao_id, medico_usuario_id, data_servico);
CREATE TABLE IF NOT EXISTS mednexo.repasse_recebimento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizacao_id uuid NOT NULL, medico_usuario_id uuid NOT NULL,
  lancamento_id uuid NOT NULL REFERENCES mednexo.repasse_lancamento(id), valor_centavos bigint NOT NULL CHECK (valor_centavos > 0),
  recebido_em date NOT NULL, forma text, observacao text, criado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mednexo.repasse_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizacao_id uuid NOT NULL, lancamento_id uuid, usuario_id uuid NOT NULL,
  acao text NOT NULL, detalhe jsonb NOT NULL DEFAULT '{}', em timestamptz NOT NULL DEFAULT now());
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['repasse_regra','repasse_lancamento','repasse_recebimento','repasse_historico'] LOOP
  EXECUTE format('ALTER TABLE mednexo.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS p_sel ON mednexo.%I', t); EXECUTE format('DROP POLICY IF EXISTS p_ins ON mednexo.%I', t); EXECUTE format('DROP POLICY IF EXISTS p_upd ON mednexo.%I', t);
  IF t = 'repasse_historico' THEN
   EXECUTE format($f$CREATE POLICY p_sel ON mednexo.%I FOR SELECT USING (organizacao_id = mednexo.ctx_org() AND mednexo.ctx_papel()::text LIKE 'medico%%' AND usuario_id = mednexo.ctx_usuario())$f$, t);
   EXECUTE format($f$CREATE POLICY p_ins ON mednexo.%I FOR INSERT WITH CHECK (organizacao_id = mednexo.ctx_org() AND usuario_id = mednexo.ctx_usuario())$f$, t);
  ELSE
   EXECUTE format($f$CREATE POLICY p_sel ON mednexo.%I FOR SELECT USING (organizacao_id = mednexo.ctx_org() AND mednexo.ctx_papel()::text LIKE 'medico%%' AND medico_usuario_id = mednexo.ctx_usuario())$f$, t);
   EXECUTE format($f$CREATE POLICY p_ins ON mednexo.%I FOR INSERT WITH CHECK (organizacao_id = mednexo.ctx_org() AND mednexo.ctx_papel()::text LIKE 'medico%%' AND medico_usuario_id = mednexo.ctx_usuario())$f$, t);
  END IF;
 END LOOP;
 CREATE POLICY p_upd ON mednexo.repasse_lancamento FOR UPDATE USING (organizacao_id = mednexo.ctx_org() AND medico_usuario_id = mednexo.ctx_usuario()) WITH CHECK (organizacao_id = mednexo.ctx_org() AND medico_usuario_id = mednexo.ctx_usuario());
 CREATE POLICY p_upd ON mednexo.repasse_regra FOR UPDATE USING (organizacao_id = mednexo.ctx_org() AND medico_usuario_id = mednexo.ctx_usuario()) WITH CHECK (organizacao_id = mednexo.ctx_org() AND medico_usuario_id = mednexo.ctx_usuario());
END $$;
GRANT SELECT, INSERT ON mednexo.repasse_recebimento, mednexo.repasse_historico TO mednexo_app;
GRANT SELECT, INSERT, UPDATE ON mednexo.repasse_regra, mednexo.repasse_lancamento TO mednexo_app;
`;
// situação derivada: o que está salvo é só previsto/faturado/cancelado; recebimento, glosa e atraso são calculados
const VIEW = `
SELECT l.id, l.paciente_id, p.nome_completo AS paciente, p.codigo AS paciente_codigo, l.internacao_id, l.hospital_id, h.nome_fantasia AS hospital,
  l.data_servico, to_char(l.data_servico,'YYYY-MM') AS competencia, l.tipo, l.descricao, l.valor_centavos, l.glosa_centavos, l.glosa_motivo,
  COALESCE(r.rec,0) AS recebido_centavos, l.valor_centavos - l.glosa_centavos - COALESCE(r.rec,0) AS saldo_centavos,
  l.fonte_pagadora, l.vencimento, l.status AS status_base, l.faturado_em, l.origem, l.motivo_cancelamento,
  CASE WHEN l.status = 'cancelado' THEN 'cancelado'
       WHEN l.valor_centavos - l.glosa_centavos - COALESCE(r.rec,0) <= 0 THEN CASE WHEN COALESCE(r.rec,0) = 0 THEN 'glosado' ELSE 'recebido' END
       WHEN COALESCE(r.rec,0) > 0 THEN CASE WHEN l.vencimento < current_date THEN 'parcial_vencido' ELSE 'parcial' END
       WHEN l.status = 'faturado' THEN CASE WHEN l.vencimento < current_date THEN 'vencido' ELSE 'faturado' END
       ELSE 'previsto' END AS situacao,
  CASE WHEN l.status <> 'cancelado' AND l.vencimento < current_date THEN current_date - l.vencimento END AS dias_atraso
FROM mednexo.repasse_lancamento l JOIN mednexo.paciente p ON p.id = l.paciente_id JOIN mednexo.hospital h ON h.id = l.hospital_id
LEFT JOIN (SELECT lancamento_id, sum(valor_centavos) AS rec FROM mednexo.repasse_recebimento GROUP BY 1) r ON r.lancamento_id = l.id`;

module.exports = function (pool, { need, uuid }) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const cents = (v, m) => { const n = Math.round(Number(String(v).replace(/\./g, '').replace(',', '.')) * 100); if (!Number.isFinite(n) || n <= 0) throw err(m || 'valor inválido'); return n; };
  const dia = (v, m) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) throw err(m || 'data inválida (use AAAA-MM-DD)'); return v; };
  const comp = v => { if (!/^\d{4}-\d{2}$/.test(String(v || ''))) throw err('competência inválida (AAAA-MM)'); return v; };
  const TIPOS = ['visita', 'parecer', 'plantao', 'procedimento', 'outro'];
  const medico = s => { if (!String(s.papel).startsWith('medico')) throw err('Gestão de repasse é exclusiva do médico.', 403); };
  const hist = (c, ctx, id, acao, d) => c.query('INSERT INTO mednexo.repasse_historico (organizacao_id, lancamento_id, usuario_id, acao, detalhe) VALUES ($1,$2,$3,$4,$5::jsonb)', [ctx.org, id, ctx.uid, acao, JSON.stringify(d || {})]);
  const lanc = async (c, id) => { const r = (await c.query(`SELECT * FROM (${VIEW}) x WHERE x.id = $1`, [uuid(id)])).rows[0]; if (!r) throw err('Lançamento não encontrado.', 404); return r; };
  const filtro = q => { const w = [], p = []; if (q.competencia) { p.push(comp(q.competencia)); w.push(`x.competencia = $${p.length}`); } if (q.hospital_id) { p.push(uuid(q.hospital_id)); w.push(`x.hospital_id = $${p.length}`); }
    if (q.internacao_id) { p.push(uuid(q.internacao_id)); w.push(`x.internacao_id = $${p.length}`); } if (q.paciente_id) { p.push(uuid(q.paciente_id)); w.push(`x.paciente_id = $${p.length}`); } return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', p }; };
  const R = {
    'GET /api/repasse/regras': async (s, c) => { medico(s); return (await c.query(`SELECT r.id, r.hospital_id, h.nome_fantasia AS hospital, r.tipo, r.descricao, r.valor_centavos, r.prazo_pagamento_dias, r.fonte_pagadora FROM mednexo.repasse_regra r JOIN mednexo.hospital h ON h.id = r.hospital_id WHERE r.ativo ORDER BY h.nome_fantasia, r.tipo`)).rows; },
    'POST /api/repasse/regras': async (s, c, q, b, ctx) => {
      medico(s); const tipo = TIPOS.includes(b.tipo) ? b.tipo : null; if (!tipo) throw err('tipo inválido');
      await c.query('UPDATE mednexo.repasse_regra SET ativo = false WHERE hospital_id = $1 AND medico_usuario_id = $2 AND tipo = $3 AND ativo', [uuid(b.hospital_id), ctx.uid, tipo]);
      const r = (await c.query(`INSERT INTO mednexo.repasse_regra (organizacao_id, hospital_id, medico_usuario_id, tipo, descricao, valor_centavos, prazo_pagamento_dias, fonte_pagadora) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.org, uuid(b.hospital_id), ctx.uid, tipo, (b.descricao || '').trim() || null, cents(b.valor, 'valor da regra inválido'), Math.min(365, Math.max(0, parseInt(b.prazo_pagamento_dias, 10) || 30)), (b.fonte_pagadora || '').trim() || null])).rows[0];
      await hist(c, ctx, null, 'regra_definida', { hospital_id: b.hospital_id, tipo, valor: b.valor }); return { id: r.id }; },
    'GET /api/repasse': async (s, c, q) => {
      medico(s); const f = filtro(q);
      const itens = (await c.query(`SELECT * FROM (${VIEW}) x ${f.where} ORDER BY x.paciente, x.data_servico DESC`, f.p)).rows;
      const tot = { previsto: 0, a_receber: 0, vencido: 0, recebido: 0, glosado: 0 };
      for (const i of itens) { if (i.situacao === 'cancelado') continue; const sd = Number(i.saldo_centavos);
        tot.recebido += Number(i.recebido_centavos); tot.glosado += Number(i.glosa_centavos);
        if (i.situacao === 'previsto') tot.previsto += sd; else if (sd > 0) { tot.a_receber += sd; if (i.dias_atraso > 0) tot.vencido += sd; } }
      return { itens, totais: tot }; },
    'GET /api/repasse/receber': async (s, c, q) => { // contas a receber com aging
      medico(s); const itens = (await c.query(`SELECT * FROM (${VIEW}) x WHERE x.situacao IN ('faturado','vencido','parcial','parcial_vencido') ORDER BY x.vencimento NULLS LAST, x.paciente`)).rows;
      const faixas = { a_vencer: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_mais: 0 };
      for (const i of itens) { const sd = Number(i.saldo_centavos), d = i.dias_atraso; if (!(d > 0)) faixas.a_vencer += sd; else if (d <= 30) faixas.d1_30 += sd; else if (d <= 60) faixas.d31_60 += sd; else if (d <= 90) faixas.d61_90 += sd; else faixas.d90_mais += sd; }
      const porFonte = {}; for (const i of itens) { const k = i.fonte_pagadora || i.hospital; porFonte[k] = (porFonte[k] || 0) + Number(i.saldo_centavos); }
      return { itens, faixas, por_fonte: Object.entries(porFonte).map(([fonte, saldo]) => ({ fonte, saldo })).sort((a, b) => b.saldo - a.saldo) }; },
    'POST /api/repasse/lancar': async (s, c, q, b, ctx) => {
      medico(s); const it = (await c.query('SELECT id, paciente_id, hospital_id FROM mednexo.internacao WHERE id = $1', [uuid(b.internacao_id)])).rows[0]; if (!it) throw err('Internação não encontrada.', 404);
      const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'visita'; const d = dia(b.data_servico);
      if (new Date(d) > new Date(Date.now() + 864e5)) throw err('Data do serviço no futuro.');
      const r = (await c.query(`INSERT INTO mednexo.repasse_lancamento (organizacao_id, medico_usuario_id, paciente_id, internacao_id, hospital_id, data_servico, tipo, descricao, valor_centavos, fonte_pagadora, vencimento)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [ctx.org, ctx.uid, it.paciente_id, it.id, it.hospital_id, d, tipo, (b.descricao || '').trim() || null, cents(b.valor), (b.fonte_pagadora || '').trim() || null, b.vencimento ? dia(b.vencimento) : null])).rows[0];
      await hist(c, ctx, r.id, 'lancado', { valor: b.valor, tipo, data: d }); return { id: r.id }; },
    // gera 1 visita por internação/dia a partir das evoluções assinadas do próprio médico, usando a regra do hospital
    'POST /api/repasse/gerar': async (s, c, q, b, ctx) => {
      medico(s); const cp = comp(b.competencia);
      const regras = (await c.query(`SELECT hospital_id, valor_centavos, prazo_pagamento_dias, fonte_pagadora FROM mednexo.repasse_regra WHERE ativo AND tipo = 'visita' AND medico_usuario_id = $1`, [ctx.uid])).rows;
      const evs = (await c.query(`SELECT DISTINCT ON (rc.internacao_id, (rc.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date) rc.internacao_id, rc.paciente_id, rc.hospital_id, (rc.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia
        FROM mednexo.registro_clinico rc WHERE rc.tipo = 'evolucao' AND rc.status = 'assinado' AND rc.autor_usuario_id = $1 AND to_char(rc.ocorrido_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $2`, [ctx.uid, cp])).rows;
      let criados = 0, existentes = 0; const semRegra = new Set();
      for (const e of evs) { const rg = regras.find(x => x.hospital_id === e.hospital_id); if (!rg) { semRegra.add(e.hospital_id); continue; }
        const r = await c.query(`INSERT INTO mednexo.repasse_lancamento (organizacao_id, medico_usuario_id, paciente_id, internacao_id, hospital_id, data_servico, tipo, descricao, valor_centavos, fonte_pagadora, vencimento, origem)
          VALUES ($1,$2,$3,$4,$5,$6,'visita','Visita (gerada das evoluções)',$7,$8,($6::date + $9::int),'evolucao') ON CONFLICT DO NOTHING RETURNING id`, [ctx.org, ctx.uid, e.paciente_id, e.internacao_id, e.hospital_id, e.dia, rg.valor_centavos, rg.fonte_pagadora, rg.prazo_pagamento_dias]);
        if (r.rows.length) { criados++; await hist(c, ctx, r.rows[0].id, 'gerado_de_evolucao', { dia: e.dia }); } else existentes++; }
      const hs = semRegra.size ? (await c.query('SELECT nome_fantasia FROM mednexo.hospital WHERE id = ANY($1::uuid[])', ['{' + [...semRegra].join(',') + '}'])).rows.map(x => x.nome_fantasia) : [];
      return { criados, ja_existentes: existentes, hospitais_sem_regra: hs }; },
    'POST /api/repasse/faturar': async (s, c, q, b, ctx) => {
      medico(s); const ids = (Array.isArray(b.ids) ? b.ids : []).map(i => uuid(i)); if (!ids.length) throw err('Selecione lançamentos.');
      const dt = b.faturado_em ? dia(b.faturado_em) : new Date().toISOString().slice(0, 10); let n = 0;
      for (const id of ids) { const l = await lanc(c, id); if (l.status_base !== 'previsto') continue;
        const venc = b.vencimento ? dia(b.vencimento) : (l.vencimento ? String(l.vencimento).slice(0, 10) : null);
        await c.query(`UPDATE mednexo.repasse_lancamento SET status = 'faturado', faturado_em = $2, vencimento = COALESCE($3::date, $2::date + 30) WHERE id = $1`, [id, dt, venc]); await hist(c, ctx, id, 'faturado', { faturado_em: dt, vencimento: venc }); n++; }
      return { faturados: n }; },
    'POST /api/repasse/receber': async (s, c, q, b, ctx) => {
      medico(s); const l = await lanc(c, b.lancamento_id); if (l.status_base === 'cancelado') throw err('Lançamento cancelado.', 409);
      const v = cents(b.valor, 'valor recebido inválido'); if (v > Number(l.saldo_centavos)) throw err('Valor maior que o saldo em aberto.');
      await c.query('INSERT INTO mednexo.repasse_recebimento (organizacao_id, medico_usuario_id, lancamento_id, valor_centavos, recebido_em, forma, observacao) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [ctx.org, ctx.uid, l.id, v, dia(b.recebido_em), (b.forma || '').trim() || null, (b.observacao || '').trim() || null]);
      if (l.status_base === 'previsto') await c.query(`UPDATE mednexo.repasse_lancamento SET status = 'faturado', faturado_em = COALESCE(faturado_em, $2) WHERE id = $1`, [l.id, dia(b.recebido_em)]);
      await hist(c, ctx, l.id, 'recebimento', { valor_centavos: v, em: b.recebido_em, forma: b.forma }); return { ok: true }; },
    'POST /api/repasse/glosa': async (s, c, q, b, ctx) => {
      medico(s); const l = await lanc(c, b.id); const v = cents(b.valor, 'valor da glosa inválido'); const m = (b.motivo || '').trim(); if (m.length < 5) throw err('Informe o motivo da glosa.');
      if (v > Number(l.saldo_centavos)) throw err('Glosa maior que o saldo em aberto.');
      await c.query('UPDATE mednexo.repasse_lancamento SET glosa_centavos = glosa_centavos + $2, glosa_motivo = $3 WHERE id = $1', [l.id, v, m]); await hist(c, ctx, l.id, 'glosa', { valor_centavos: v, motivo: m }); return { ok: true }; },
    'POST /api/repasse/cancelar': async (s, c, q, b, ctx) => {
      medico(s); const l = await lanc(c, b.id); const m = (b.motivo || '').trim(); if (m.length < 5) throw err('Informe o motivo do cancelamento.');
      if (Number(l.recebido_centavos) > 0) throw err('Há recebimentos lançados; não é possível cancelar.', 409);
      await c.query(`UPDATE mednexo.repasse_lancamento SET status = 'cancelado', motivo_cancelamento = $2 WHERE id = $1`, [l.id, m]); await hist(c, ctx, l.id, 'cancelado', { motivo: m }); return { ok: true }; },
    'GET /api/repasse/historico': async (s, c, q) => { medico(s); return (await c.query('SELECT acao, detalhe, em FROM mednexo.repasse_historico WHERE lancamento_id = $1 ORDER BY em', [uuid(q.id)])).rows; },
    'GET /api/repasse/csv': async (s, c, q) => {
      medico(s); const f = filtro(q); const rows = (await c.query(`SELECT * FROM (${VIEW}) x ${f.where} ORDER BY x.hospital, x.paciente, x.data_servico`, f.p)).rows;
      const e = v => { v = v == null ? '' : String(v); return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }; const m = n => (Number(n) / 100).toFixed(2).replace('.', ',');
      const csv = '﻿Hospital;Paciente;Código;Data;Tipo;Fonte pagadora;Valor;Glosa;Recebido;Saldo;Vencimento;Situação\n' + rows.map(r => [r.hospital, r.paciente, r.paciente_codigo, String(r.data_servico).slice(0, 10), r.tipo, r.fonte_pagadora, m(r.valor_centavos), m(r.glosa_centavos), m(r.recebido_centavos), m(r.saldo_centavos), r.vencimento ? String(r.vencimento).slice(0, 10) : '', r.situacao].map(e).join(';')).join('\n');
      return { __raw: { mime: 'text/csv; charset=utf-8', nome: 'repasse.csv', buf: Buffer.from(csv, 'utf8') } }; },
  };
  return { routes: R, migrar: () => pool.raw(MIGRACAO) };
};
