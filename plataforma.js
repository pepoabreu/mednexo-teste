'use strict';
// Administração da plataforma (dono do MedNexo): clientes, planos com preço e limites, assinaturas, inadimplência,
// período de teste, suspensão/reativação e indicadores. Exposta SOMENTE por funções do esquema "plataforma",
// executadas pelo papel de banco mednexo_plataforma, que não tem acesso a nenhuma tabela clínica (nem ao esquema mednexo).
// A suspensão deixa a organização em somente leitura: os prontuários continuam acessíveis para a continuidade do cuidado.
const MIGRACAO = `
CREATE TABLE IF NOT EXISTS mednexo.plano (
  id text PRIMARY KEY, nome text NOT NULL, preco numeric(12,2) CHECK (preco IS NULL OR preco > 0), periodicidade text NOT NULL DEFAULT 'mensal',
  limite_medicos int CHECK (limite_medicos IS NULL OR limite_medicos > 0), limite_hospitais int CHECK (limite_hospitais IS NULL OR limite_hospitais > 0),
  recursos jsonb NOT NULL DEFAULT '[]', ativo boolean NOT NULL DEFAULT true, ordem int NOT NULL DEFAULT 0, atualizado_em timestamptz NOT NULL DEFAULT now());
INSERT INTO mednexo.plano (id, nome, limite_medicos, limite_hospitais, ordem, recursos) VALUES
  ('individual','Individual',1,NULL,1,'["Prontuário multi-hospital","Telemedicina","Repasse"]'),
  ('equipe','Equipe',5,NULL,2,'["Tudo do Individual","Gestão de equipe","Prontuário compartilhado"]'),
  ('clinica','Clínica',NULL,NULL,3,'["Tudo do Equipe","Médicos ilimitados","Suporte prioritário"]')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE mednexo.plano ENABLE ROW LEVEL SECURITY;
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS suspensa_em timestamptz;
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS suspensao_motivo text;
CREATE TABLE IF NOT EXISTS mednexo.plataforma_registro (id bigserial PRIMARY KEY, criado_em timestamptz NOT NULL DEFAULT now(), autor text NOT NULL, acao text NOT NULL, organizacao_id uuid, detalhes jsonb NOT NULL DEFAULT '{}');
ALTER TABLE mednexo.plataforma_registro ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION mednexo.trg_registro_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registro da plataforma é imutável'; END $$;
DROP TRIGGER IF EXISTS trg_plat_reg_imut ON mednexo.plataforma_registro;
CREATE TRIGGER trg_plat_reg_imut BEFORE UPDATE OR DELETE ON mednexo.plataforma_registro FOR EACH ROW EXECUTE FUNCTION mednexo.trg_registro_imutavel();

CREATE SCHEMA IF NOT EXISTS plataforma;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mednexo_plataforma') THEN CREATE ROLE mednexo_plataforma LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$;
REVOKE ALL ON SCHEMA plataforma FROM PUBLIC;
GRANT USAGE ON SCHEMA plataforma TO mednexo_plataforma;

CREATE OR REPLACE FUNCTION plataforma.clientes() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'criada_em' DESC), '[]') FROM (
    SELECT jsonb_build_object('id', o.id, 'nome', o.nome, 'cnpj', o.cnpj, 'criada_em', o.criada_em, 'plano', o.plano, 'teste_ate', o.teste_ate,
      'contato_email', o.contato_email, 'contato_telefone', o.contato_telefone, 'assinatura_plano', o.assinatura_plano, 'assinatura_valor', o.assinatura_valor,
      'assinatura_status', o.assinatura_status, 'suspensa_em', o.suspensa_em, 'suspensao_motivo', o.suspensao_motivo,
      'membros', (SELECT count(*) FROM organizacao_membro m WHERE m.organizacao_id = o.id AND m.ativo),
      'medicos', (SELECT count(*) FROM organizacao_membro m WHERE m.organizacao_id = o.id AND m.ativo AND m.papel::text LIKE 'medico%'),
      'hospitais', (SELECT count(*) FROM hospital h WHERE h.organizacao_id = o.id AND h.ativo),
      'pacientes', (SELECT count(*) FROM paciente p WHERE p.organizacao_id = o.id),
      'ultimo_acesso', (SELECT max(u.ultimo_login_em) FROM organizacao_membro m JOIN usuario u ON u.id = m.usuario_id WHERE m.organizacao_id = o.id),
      'atraso_desde', (SELECT min(c.vencimento) FROM cobranca c WHERE c.organizacao_id = o.id AND c.tipo = 'assinatura' AND c.status = 'OVERDUE'),
      'teleconsultas_pagas', (SELECT count(*) FROM cobranca c WHERE c.organizacao_id = o.id AND c.tipo = 'teleconsulta' AND c.status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH'))) AS x
    FROM organizacao o) t $$;

CREATE OR REPLACE FUNCTION plataforma.indicadores(p_taxa numeric) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'mrr', (SELECT coalesce(sum(assinatura_valor), 0) FROM organizacao WHERE assinatura_status = 'ativa' AND suspensa_em IS NULL),
    'clientes_pagantes', (SELECT count(*) FROM organizacao WHERE assinatura_status = 'ativa'),
    'em_teste', (SELECT count(*) FROM organizacao WHERE plano = 'teste' AND teste_ate >= current_date AND asaas_subscription_id IS NULL),
    'teste_vencido', (SELECT count(*) FROM organizacao WHERE plano = 'teste' AND teste_ate < current_date AND asaas_subscription_id IS NULL),
    'inadimplentes', (SELECT count(DISTINCT organizacao_id) FROM cobranca WHERE tipo = 'assinatura' AND status = 'OVERDUE'),
    'suspensos', (SELECT count(*) FROM organizacao WHERE suspensa_em IS NOT NULL),
    'organizacoes', (SELECT count(*) FROM organizacao),
    'usuarios_ativos', (SELECT count(DISTINCT usuario_id) FROM organizacao_membro WHERE ativo),
    'usuarios_30d', (SELECT count(*) FROM usuario WHERE ultimo_login_em > now() - interval '30 days'),
    'teleconsultas_pagas_mes', (SELECT count(*) FROM cobranca WHERE tipo = 'teleconsulta' AND status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') AND pago_em >= date_trunc('month', now())),
    'receita_teleconsulta_mes', (SELECT count(*) * p_taxa FROM cobranca WHERE tipo = 'teleconsulta' AND status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') AND pago_em >= date_trunc('month', now())),
    'pacientes_portal', (SELECT count(*) FROM paciente_conta),
    'meses', (SELECT jsonb_agg(jsonb_build_object('mes', to_char(m, 'YYYY-MM'),
        'novos', (SELECT count(*) FROM organizacao o WHERE date_trunc('month', o.criada_em) = m),
        'recebido_assinaturas', (SELECT coalesce(sum(valor), 0) FROM cobranca c WHERE c.tipo = 'assinatura' AND c.status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') AND date_trunc('month', c.pago_em) = m),
        'teleconsultas', (SELECT count(*) FROM cobranca c WHERE c.tipo = 'teleconsulta' AND c.status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') AND date_trunc('month', c.pago_em) = m)) ORDER BY m)
      FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m)) $$;

CREATE OR REPLACE FUNCTION plataforma.cobrancas(p_lim int) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(x), '[]') FROM (SELECT jsonb_build_object('organizacao', o.nome, 'organizacao_id', o.id, 'valor', c.valor, 'status', c.status, 'vencimento', c.vencimento, 'pago_em', c.pago_em, 'criado_em', c.criado_em) AS x
    FROM cobranca c JOIN organizacao o ON o.id = c.organizacao_id WHERE c.tipo = 'assinatura' ORDER BY c.criado_em DESC LIMIT least(p_lim, 500)) t $$;

CREATE OR REPLACE FUNCTION plataforma.planos() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('clientes', (SELECT count(*) FROM organizacao o WHERE o.assinatura_plano = p.id AND o.assinatura_status = 'ativa')) ORDER BY p.ordem), '[]') FROM plano p $$;

CREATE OR REPLACE FUNCTION plataforma.salvar_plano(p_id text, p_nome text, p_preco numeric, p_lim_med int, p_lim_hosp int, p_ativo boolean, p_autor text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
BEGIN
  IF p_id !~ '^[a-z_]{3,30}$' THEN RAISE EXCEPTION 'identificador de plano inválido'; END IF;
  INSERT INTO plano (id, nome, preco, limite_medicos, limite_hospitais, ativo, ordem) VALUES (p_id, p_nome, p_preco, p_lim_med, p_lim_hosp, p_ativo, (SELECT coalesce(max(ordem),0)+1 FROM plano))
  ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, preco = EXCLUDED.preco, limite_medicos = EXCLUDED.limite_medicos, limite_hospitais = EXCLUDED.limite_hospitais, ativo = EXCLUDED.ativo, atualizado_em = now();
  INSERT INTO plataforma_registro (autor, acao, detalhes) VALUES (p_autor, 'plano_salvar', jsonb_build_object('plano', p_id, 'preco', p_preco, 'limite_medicos', p_lim_med, 'limite_hospitais', p_lim_hosp, 'ativo', p_ativo));
END $$;

CREATE OR REPLACE FUNCTION plataforma.estender_teste(p_org uuid, p_dias int, p_autor text) RETURNS date LANGUAGE plpgsql SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE v date;
BEGIN
  IF p_dias NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'prorrogue entre 1 e 90 dias'; END IF;
  UPDATE organizacao SET teste_ate = greatest(coalesce(teste_ate, current_date), current_date) + p_dias WHERE id = p_org AND plano = 'teste' RETURNING teste_ate INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'organização não está em período de teste'; END IF;
  INSERT INTO plataforma_registro (autor, acao, organizacao_id, detalhes) VALUES (p_autor, 'teste_prorrogar', p_org, jsonb_build_object('dias', p_dias, 'ate', v));
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION plataforma.suspender(p_org uuid, p_motivo text, p_autor text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
BEGIN
  IF length(coalesce(p_motivo, '')) < 5 THEN RAISE EXCEPTION 'informe o motivo da suspensão'; END IF;
  UPDATE organizacao SET suspensa_em = now(), suspensao_motivo = p_motivo WHERE id = p_org AND suspensa_em IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'organização não encontrada ou já suspensa'; END IF;
  INSERT INTO plataforma_registro (autor, acao, organizacao_id, detalhes) VALUES (p_autor, 'suspender', p_org, jsonb_build_object('motivo', p_motivo));
END $$;

CREATE OR REPLACE FUNCTION plataforma.reativar(p_org uuid, p_autor text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
BEGIN
  UPDATE organizacao SET suspensa_em = NULL, suspensao_motivo = NULL WHERE id = p_org AND suspensa_em IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'organização não está suspensa'; END IF;
  INSERT INTO plataforma_registro (autor, acao, organizacao_id) VALUES (p_autor, 'reativar', p_org);
END $$;

CREATE OR REPLACE FUNCTION plataforma.registro(p_lim int) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(x), '[]') FROM (SELECT jsonb_build_object('criado_em', r.criado_em, 'autor', r.autor, 'acao', r.acao, 'organizacao', o.nome, 'detalhes', r.detalhes) AS x
    FROM plataforma_registro r LEFT JOIN organizacao o ON o.id = r.organizacao_id ORDER BY r.id DESC LIMIT least(p_lim, 500)) t $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA plataforma FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA plataforma TO mednexo_plataforma;
`;

module.exports = function (pool, env = process.env) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  let planos = {};
  async function carregar() { try { for (const p of (await pool.query(`SELECT id, nome, preco, limite_medicos, limite_hospitais, ativo FROM mednexo.plano ORDER BY ordem`)).rows) planos[p.id] = p; } catch (e) { console.error('planos:', e.message); } }
  setInterval(carregar, 60e3).unref();
  // preço do plano: o definido no painel da plataforma; se vazio, o da variável de ambiente (compatibilidade)
  const preco = id => { const p = planos[id]; const v = p && p.preco != null ? Number(p.preco) : Number(env['PRECO_' + String(id).toUpperCase()] || 0); return v > 0 ? v : null; };
  const lista = () => Object.values(planos).filter(p => p.ativo !== false && p.ativo !== 'f').map(p => ({ id: p.id, nome: p.nome, valor: preco(p.id), limite_medicos: p.limite_medicos == null ? null : +p.limite_medicos, limite_hospitais: p.limite_hospitais == null ? null : +p.limite_hospitais }));
  // limites do plano contratado (em teste não há limite)
  async function confereLimite(org, recurso) {
    const o = (await pool.query(`SELECT assinatura_plano, assinatura_status, plano FROM mednexo.organizacao WHERE id = $1`, [org])).rows[0]; if (!o || !o.assinatura_plano) return;
    const p = planos[o.assinatura_plano]; if (!p) return;
    if (recurso === 'medicos' && p.limite_medicos != null) { const n = +(await pool.query(`SELECT count(*) AS n FROM mednexo.organizacao_membro WHERE organizacao_id = $1 AND ativo AND papel::text LIKE 'medico%'`, [org])).rows[0].n;
      if (n >= +p.limite_medicos) throw err(`O plano ${p.nome} permite até ${p.limite_medicos} médico(s). Para cadastrar mais, mude de plano em Equipe → Assinatura.`, 402); }
    if (recurso === 'hospitais' && p.limite_hospitais != null) { const n = +(await pool.query(`SELECT count(*) AS n FROM mednexo.hospital WHERE organizacao_id = $1 AND ativo`, [org])).rows[0].n;
      if (n >= +p.limite_hospitais) throw err(`O plano ${p.nome} permite até ${p.limite_hospitais} hospital(is). Para cadastrar mais, mude de plano.`, 402); }
  }
  return { migrar: async () => { await pool.raw(MIGRACAO); await carregar(); }, preco, lista, confereLimite, carregar };
};
