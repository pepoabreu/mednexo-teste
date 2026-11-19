'use strict';
// Governança LGPD de cada organização (controladora dos dados dos seus pacientes) e pedidos dos titulares.
// - Encarregado (DPO) e canal de contato (art. 41)
// - Registro das operações de tratamento – ROPA (art. 37), com finalidade, hipótese legal (arts. 7 e 11), retenção e medidas (art. 46)
// - Pedidos dos titulares (art. 18) com prazo, histórico e resposta; o paciente abre pela Área do Paciente
// - Incidentes de segurança (art. 48; Resolução CD/ANPD nº 15/2024: comunicação em 3 dias úteis quando houver risco ou dano relevante)
// O MedNexo é operador: pedidos sobre a conta da Área do Paciente (sem clínica escolhida) vão para a plataforma.
const MIGRACAO = `
CREATE TABLE IF NOT EXISTS mednexo.lgpd_encarregado (organizacao_id uuid PRIMARY KEY REFERENCES mednexo.organizacao(id), nome text NOT NULL, email text NOT NULL, telefone text, canal text, atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mednexo.lgpd_ropa (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizacao_id uuid NOT NULL REFERENCES mednexo.organizacao(id), processo text NOT NULL, finalidade text NOT NULL,
  base_legal text NOT NULL, categorias_dados text, titulares text, compartilhamento text, retencao text, medidas text, ordem int NOT NULL DEFAULT 0, atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mednexo.lgpd_solicitacao (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), protocolo text UNIQUE NOT NULL, organizacao_id uuid REFERENCES mednexo.organizacao(id), paciente_conta_id uuid REFERENCES mednexo.paciente_conta(id),
  titular_nome text NOT NULL, contato text NOT NULL, tipo text NOT NULL, descricao text, status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','em_analise','respondida','indeferida')),
  prazo_em date NOT NULL, criado_em timestamptz NOT NULL DEFAULT now(), respondida_em timestamptz, resposta text, respondido_por text);
CREATE TABLE IF NOT EXISTS mednexo.lgpd_solicitacao_hist (id bigserial PRIMARY KEY, solicitacao_id uuid NOT NULL REFERENCES mednexo.lgpd_solicitacao(id), criado_em timestamptz NOT NULL DEFAULT now(), autor text NOT NULL, evento text NOT NULL, texto text);
CREATE TABLE IF NOT EXISTS mednexo.lgpd_incidente (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizacao_id uuid REFERENCES mednexo.organizacao(id), titulo text NOT NULL, descricao text NOT NULL,
  conhecimento_em timestamptz NOT NULL, classificacao text NOT NULL CHECK (classificacao IN ('baixo','medio','alto','critico')), dados_afetados text, titulares_afetados int,
  contencao text, investigacao text, evidencias text, risco_relevante boolean, avaliacao_risco text, prazo_comunicacao date,
  comunicado_controlador_em timestamptz, comunicado_anpd_em timestamptz, comunicado_titulares_em timestamptz, status text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','contido','encerrado')),
  criado_por text NOT NULL, criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now());
DO $$ BEGIN FOR i IN 1..1 LOOP
  EXECUTE 'ALTER TABLE mednexo.lgpd_encarregado ENABLE ROW LEVEL SECURITY'; EXECUTE 'ALTER TABLE mednexo.lgpd_ropa ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mednexo.lgpd_solicitacao ENABLE ROW LEVEL SECURITY'; EXECUTE 'ALTER TABLE mednexo.lgpd_solicitacao_hist ENABLE ROW LEVEL SECURITY'; EXECUTE 'ALTER TABLE mednexo.lgpd_incidente ENABLE ROW LEVEL SECURITY';
END LOOP; END $$;
`;
const TIPOS = { confirmacao: 'Confirmação de que meus dados são tratados', acesso: 'Acesso aos meus dados (cópia)', correcao: 'Correção de dados incompletos ou errados',
  compartilhamento: 'Com quem meus dados foram compartilhados', portabilidade: 'Portabilidade dos dados', revisao_automatizada: 'Revisão de decisão automatizada',
  eliminacao: 'Eliminação ou anonimização de dados', revogacao: 'Revogação de consentimento', outro: 'Outro pedido' };
// ROPA inicial: modelo para a clínica revisar com o jurídico (não é parecer jurídico)
const ROPA_PADRAO = [
  ['Prontuário eletrônico (internação e acompanhamento)', 'Registrar a assistência à saúde do paciente e garantir a continuidade do cuidado', 'Art. 11, II, "f" (tutela da saúde) e "a" (obrigação legal: Res. CFM 1.638/2002, Lei 13.787/2018)', 'Identificação, dados de saúde, diagnósticos (CID), prescrições, evoluções, exames', 'Pacientes e responsáveis', 'Equipe assistencial da organização; operador MedNexo (hospedagem na Hostinger, rede Cloudflare)', 'Mínimo de 20 anos após o último registro (Lei 13.787/2018)', 'Isolamento por organização no banco (RLS), perfis de acesso, verificação em duas etapas, auditoria com cadeia de hash, backup cifrado, antivírus'],
  ['Telemedicina (teleconsulta por vídeo e chat)', 'Prestar atendimento a distância conforme Res. CFM 2.314/2022', 'Art. 11, II, "f" (tutela da saúde)', 'Identificação, imagem e voz (não gravadas), mensagens, arquivos enviados', 'Pacientes', 'Médico responsável; operador MedNexo', 'Mensagens e arquivos junto ao prontuário (20 anos); vídeo não é gravado', 'Link de sala com chave única, termo de consentimento do atendimento, auditoria'],
  ['Agendamento e cobrança da consulta online', 'Agendar e cobrar a consulta e emitir nota fiscal', 'Art. 7º, V (execução de contrato) e II (obrigação legal fiscal)', 'Nome, CPF, e-mail, celular, dados do pagamento (sem dados de cartão no MedNexo)', 'Pacientes da Área do Paciente', 'Asaas (instituição de pagamento) e prefeitura (NFS-e)', '5 anos (obrigações fiscais)', 'Pagamento processado pelo Asaas; chaves cifradas; acesso restrito'],
  ['Repasse e gestão financeira do médico', 'Calcular e acompanhar repasses de hospitais e convênios', 'Art. 7º, V (execução de contrato) e IX (legítimo interesse)', 'Produção médica, valores, hospital e convênio', 'Médicos e pacientes atendidos (referência)', 'Somente a organização', '5 anos', 'Acesso restrito ao médico e ao gestor'],
  ['Trilha de auditoria e segurança', 'Rastrear acessos e alterações e prevenir fraudes e incidentes', 'Art. 7º, II (obrigação legal) e IX (legítimo interesse); art. 46', 'Usuário, data e hora, IP, ação, registro acessado', 'Usuários do sistema', 'Somente a organização (auditor e gestor)', 'Junto ao prontuário (20 anos)', 'Registros imutáveis com cadeia de hash'],
  ['Resumo clínico com inteligência artificial (quando usado)', 'Apoiar o médico com um resumo crítico, sempre revisado e validado por ele', 'Art. 11, II, "f" (tutela da saúde)', 'Dados de saúde do paciente enviados no momento do uso', 'Pacientes', 'Anthropic (processamento da IA), somente após confirmação do médico', 'O texto aprovado fica no prontuário; o provedor não guarda para treino conforme contrato de API', 'Envio só com confirmação do médico; revisão humana obrigatória (art. 20)'],
];
function diasUteis(inicio, n) { const d = new Date(inicio); let k = 0; while (k < n) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) k++; } return d.toISOString().slice(0, 10); }
const protocolo = () => 'LGPD-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();

module.exports = function (pool, { uuid }) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const ger = s => { if (s.papel !== 'medico_administrador') throw err('Somente o médico gestor (controlador) gerencia a LGPD da organização.', 403); };
  const ler = s => { if (!['medico_administrador', 'auditor'].includes(s.papel)) throw err('Somente o gestor ou o auditor.', 403); };
  const t = (v, n = 2000) => { const x = String(v ?? '').trim(); return x ? x.slice(0, n) : null; };
  const hist = (id, autor, evento, texto) => pool.query(`INSERT INTO mednexo.lgpd_solicitacao_hist (solicitacao_id, autor, evento, texto) VALUES ($1,$2,$3,$4)`, [id, autor, evento, texto || null]);
  async function audita(c, acao, id, det = {}) { await c.query(`SELECT mednexo.auditar_acesso($1,'lgpd',$2,NULL,NULL,$3::jsonb)`, [acao, id ? String(id) : null, JSON.stringify(det)]); }

  const R = {
    'GET /api/lgpd': async (s) => { ler(s);
      if (!(await pool.query(`SELECT 1 FROM mednexo.lgpd_ropa WHERE organizacao_id = $1 LIMIT 1`, [s.org])).rows.length)
        for (const [i, r] of ROPA_PADRAO.entries()) await pool.query(`INSERT INTO mednexo.lgpd_ropa (organizacao_id, processo, finalidade, base_legal, categorias_dados, titulares, compartilhamento, retencao, medidas, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [s.org, ...r, i]);
      const [enc, ropa, sol, inc] = await Promise.all([
        pool.query(`SELECT nome, email, telefone, canal, atualizado_em FROM mednexo.lgpd_encarregado WHERE organizacao_id = $1`, [s.org]),
        pool.query(`SELECT * FROM mednexo.lgpd_ropa WHERE organizacao_id = $1 ORDER BY ordem, processo`, [s.org]),
        pool.query(`SELECT s.*, (SELECT json_agg(json_build_object('criado_em', h.criado_em, 'autor', h.autor, 'evento', h.evento, 'texto', h.texto) ORDER BY h.id) FROM mednexo.lgpd_solicitacao_hist h WHERE h.solicitacao_id = s.id) AS historico
          FROM mednexo.lgpd_solicitacao s WHERE s.organizacao_id = $1 ORDER BY (s.status IN ('aberta','em_analise')) DESC, s.prazo_em, s.criado_em DESC LIMIT 200`, [s.org]),
        pool.query(`SELECT * FROM mednexo.lgpd_incidente WHERE organizacao_id = $1 ORDER BY (status <> 'encerrado') DESC, conhecimento_em DESC LIMIT 100`, [s.org])]);
      return { encarregado: enc.rows[0] || null, ropa: ropa.rows, solicitacoes: sol.rows, incidentes: inc.rows, tipos: TIPOS };
    },
    'POST /api/lgpd/encarregado': async (s, c, q, b, ctx) => { ger(s);
      const nome = t(b.nome, 120), email = t(b.email, 160); if (!nome || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('Informe nome e e-mail válidos do encarregado.');
      await pool.query(`INSERT INTO mednexo.lgpd_encarregado (organizacao_id, nome, email, telefone, canal) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organizacao_id) DO UPDATE SET nome = EXCLUDED.nome, email = EXCLUDED.email, telefone = EXCLUDED.telefone, canal = EXCLUDED.canal, atualizado_em = now()`, [s.org, nome, email, t(b.telefone, 40), t(b.canal, 300)]);
      await audita(c, 'lgpd_encarregado', null, { nome }); return { ok: true }; },
    'POST /api/lgpd/ropa': async (s, c, q, b, ctx) => { ger(s);
      const v = [t(b.processo, 200), t(b.finalidade), t(b.base_legal, 500), t(b.categorias_dados), t(b.titulares, 500), t(b.compartilhamento), t(b.retencao, 500), t(b.medidas)];
      if (!v[0] || !v[1] || !v[2]) throw err('Processo, finalidade e hipótese legal são obrigatórios.');
      let id;
      if (b.id) { const r = await pool.query(`UPDATE mednexo.lgpd_ropa SET processo=$3, finalidade=$4, base_legal=$5, categorias_dados=$6, titulares=$7, compartilhamento=$8, retencao=$9, medidas=$10, atualizado_em = now() WHERE id = $1 AND organizacao_id = $2 RETURNING id`, [uuid(b.id), s.org, ...v]); if (!r.rows.length) throw err('Item não encontrado.', 404); id = b.id; }
      else id = (await pool.query(`INSERT INTO mednexo.lgpd_ropa (organizacao_id, processo, finalidade, base_legal, categorias_dados, titulares, compartilhamento, retencao, medidas, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,99) RETURNING id`, [s.org, ...v])).rows[0].id;
      await audita(c, 'lgpd_ropa_salvar', id, { processo: v[0] }); return { ok: true, id }; },
    'POST /api/lgpd/ropa/remover': async (s, c, q, b) => { ger(s); await pool.query(`DELETE FROM mednexo.lgpd_ropa WHERE id = $1 AND organizacao_id = $2`, [uuid(b.id), s.org]); await audita(c, 'lgpd_ropa_remover', b.id); return { ok: true }; },
    'POST /api/lgpd/solicitacao': async (s, c, q, b) => { ger(s);
      const st = ['em_analise', 'respondida', 'indeferida'].includes(b.status) ? b.status : null; if (!st) throw err('Situação inválida.');
      const resp = t(b.resposta, 5000); if (st !== 'em_analise' && (!resp || resp.length < 10)) throw err('Escreva a resposta ao titular (ela aparece para ele na Área do Paciente).');
      const r = await pool.query(`UPDATE mednexo.lgpd_solicitacao SET status = $3, resposta = coalesce($4, resposta), respondida_em = CASE WHEN $3 IN ('respondida','indeferida') THEN now() ELSE respondida_em END, respondido_por = $5 WHERE id = $1 AND organizacao_id = $2 RETURNING id`, [uuid(b.id), s.org, st, resp, s.nome]);
      if (!r.rows.length) throw err('Pedido não encontrado.', 404); await hist(b.id, s.nome, st, resp); await audita(c, 'lgpd_pedido_' + st, b.id); return { ok: true }; },
    'POST /api/lgpd/incidente': async (s, c, q, b) => { ger(s);
      const cls = ['baixo', 'medio', 'alto', 'critico'].includes(b.classificacao) ? b.classificacao : null; if (!cls) throw err('Classifique o incidente.');
      const dt = v => v ? new Date(v).toISOString() : null;
      const vals = [t(b.titulo, 200), t(b.descricao, 5000), dt(b.conhecimento_em) || new Date().toISOString(), cls, t(b.dados_afetados), b.titulares_afetados === '' || b.titulares_afetados == null ? null : parseInt(b.titulares_afetados, 10),
        t(b.contencao, 5000), t(b.investigacao, 5000), t(b.evidencias, 5000), b.risco_relevante === true ? true : b.risco_relevante === false ? false : null, t(b.avaliacao_risco, 5000),
        dt(b.comunicado_controlador_em), dt(b.comunicado_anpd_em), dt(b.comunicado_titulares_em), ['aberto', 'contido', 'encerrado'].includes(b.status) ? b.status : 'aberto'];
      if (!vals[0] || !vals[1]) throw err('Informe título e descrição do incidente.');
      const prazo = diasUteis(vals[2], 3);
      let id;
      if (b.id) { const r = await pool.query(`UPDATE mednexo.lgpd_incidente SET titulo=$3, descricao=$4, conhecimento_em=$5, classificacao=$6, dados_afetados=$7, titulares_afetados=$8, contencao=$9, investigacao=$10, evidencias=$11, risco_relevante=$12, avaliacao_risco=$13,
          comunicado_controlador_em=$14, comunicado_anpd_em=$15, comunicado_titulares_em=$16, status=$17, prazo_comunicacao=$18, atualizado_em=now() WHERE id=$1 AND organizacao_id=$2 RETURNING id`, [uuid(b.id), s.org, ...vals, prazo]); if (!r.rows.length) throw err('Incidente não encontrado.', 404); id = b.id; }
      else id = (await pool.query(`INSERT INTO mednexo.lgpd_incidente (organizacao_id, titulo, descricao, conhecimento_em, classificacao, dados_afetados, titulares_afetados, contencao, investigacao, evidencias, risco_relevante, avaliacao_risco,
          comunicado_controlador_em, comunicado_anpd_em, comunicado_titulares_em, status, prazo_comunicacao, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [s.org, ...vals, prazo, s.nome])).rows[0].id;
      await audita(c, b.id ? 'lgpd_incidente_atualizar' : 'lgpd_incidente_registrar', id, { classificacao: cls }); return { ok: true, id, prazo_comunicacao: prazo }; },
  };
  const pendentes = async (s) => ['medico_administrador', 'auditor'].includes(s.papel) ? +(await pool.query(`SELECT count(*) AS n FROM mednexo.lgpd_solicitacao WHERE organizacao_id = $1 AND status IN ('aberta','em_analise')`, [s.org])).rows[0].n : 0;

  // ---- Área do Paciente (sessão do paciente, chamado pelo portal.js)
  async function portalListar(pid) {
    const pedidos = (await pool.query(`SELECT s.id, s.protocolo, s.tipo, s.descricao, s.status, s.prazo_em, s.criado_em, s.respondida_em, s.resposta, o.nome AS organizacao FROM mednexo.lgpd_solicitacao s LEFT JOIN mednexo.organizacao o ON o.id = s.organizacao_id WHERE s.paciente_conta_id = $1 ORDER BY s.criado_em DESC`, [pid])).rows;
    const clinicas = (await pool.query(`SELECT DISTINCT o.id, o.nome, e.nome AS encarregado, e.email AS encarregado_email, e.canal FROM mednexo.agendamento a JOIN mednexo.organizacao o ON o.id = a.organizacao_id LEFT JOIN mednexo.lgpd_encarregado e ON e.organizacao_id = o.id WHERE a.paciente_conta_id = $1 AND a.status IN ('confirmado','cancelado_medico','expirado','cancelado_paciente')`, [pid])).rows;
    return { pedidos, clinicas, tipos: TIPOS, encarregado_plataforma: process.env.DPO_EMAIL || null };
  }
  async function portalAbrir(pid, b) {
    const tipo = TIPOS[b.tipo] ? b.tipo : null; if (!tipo) throw err('Escolha o tipo de pedido.');
    const u = (await pool.query(`SELECT nome, email, celular FROM mednexo.paciente_conta WHERE id = $1`, [pid])).rows[0];
    let org = null; if (b.organizacao_id) { org = (await pool.query(`SELECT DISTINCT a.organizacao_id FROM mednexo.agendamento a WHERE a.paciente_conta_id = $1 AND a.organizacao_id = $2`, [pid, uuid(b.organizacao_id)])).rows[0]; if (!org) throw err('Clínica não encontrada entre as suas consultas.', 404); org = org.organizacao_id; }
    const desc = t(b.descricao, 3000); if (['correcao', 'outro', 'revisao_automatizada'].includes(tipo) && (!desc || desc.length < 10)) throw err('Descreva o seu pedido.');
    const prazo = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10); // art. 19, II: até 15 dias
    const p = protocolo();
    const id = (await pool.query(`INSERT INTO mednexo.lgpd_solicitacao (protocolo, organizacao_id, paciente_conta_id, titular_nome, contato, tipo, descricao, prazo_em) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [p, org, pid, u.nome, `${u.email} · ${u.celular}`, tipo, desc, prazo])).rows[0].id;
    await hist(id, 'titular', 'aberta', desc); return { ok: true, protocolo: p, prazo_em: prazo };
  }
  // cópia dos dados da conta da Área do Paciente (acesso e portabilidade, art. 18, II e V)
  async function portalExportar(pid) {
    const conta = (await pool.query(`SELECT nome, email, cpf, nascimento, celular, criado_em, consentimento_em, ultimo_login_em FROM mednexo.paciente_conta WHERE id = $1`, [pid])).rows[0];
    const consultas = (await pool.query(`SELECT a.inicio, a.fim, a.valor, a.status, u.nome_completo AS medico, o.nome AS organizacao FROM mednexo.agendamento a JOIN mednexo.usuario u ON u.id = a.medico_usuario_id JOIN mednexo.organizacao o ON o.id = a.organizacao_id WHERE a.paciente_conta_id = $1 ORDER BY a.inicio`, [pid])).rows;
    const pedidos = (await pool.query(`SELECT protocolo, tipo, status, criado_em, respondida_em, resposta FROM mednexo.lgpd_solicitacao WHERE paciente_conta_id = $1 ORDER BY criado_em`, [pid])).rows;
    return { gerado_em: new Date().toISOString(), observacao: 'Dados da sua conta na Área do Paciente do MedNexo. O prontuário clínico é guardado pela clínica que atendeu você: peça a cópia a ela em "Meus pedidos LGPD".', conta, consultas, pedidos_lgpd: pedidos,
      compartilhamentos: [{ com: 'Clínica e médico que você escolheu', motivo: 'atendimento e prontuário' }, { com: 'Asaas', motivo: 'processamento do pagamento' }, { com: 'Hostinger e Cloudflare', motivo: 'hospedagem e rede (operadores)' }] };
  }
  return { routes: R, migrar: () => pool.raw(MIGRACAO), pendentes, portalListar, portalAbrir, portalExportar, TIPOS, diasUteis };
};
