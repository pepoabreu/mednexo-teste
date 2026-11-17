'use strict';
// Análise de exames por IA (apoio à decisão): envia o arquivo do exame + dados clínicos SEM identificação direta
// (sem nome, CPF, nome da mãe, contatos). Cada chamada fica registrada em ia_interacao. O médico revisa; nada vai ao prontuário sem ação dele.
const crypto = require('crypto');
const MIME_IA = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image', 'application/pdf': 'document' };
const MIGRACAO = `
CREATE TABLE IF NOT EXISTS mednexo.paciente_medida (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizacao_id uuid NOT NULL, paciente_id uuid NOT NULL,
  peso_kg numeric(5,1) CHECK (peso_kg BETWEEN 0.5 AND 500), altura_cm numeric(4,1) CHECK (altura_cm BETWEEN 30 AND 250),
  medido_em date NOT NULL DEFAULT CURRENT_DATE, observacao text,
  registrado_por uuid NOT NULL REFERENCES mednexo.usuario(id), registrado_em timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES mednexo.paciente (id, organizacao_id),
  CHECK (peso_kg IS NOT NULL OR altura_cm IS NOT NULL));
ALTER TABLE mednexo.paciente_medida ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_sel ON mednexo.paciente_medida; DROP POLICY IF EXISTS p_ins ON mednexo.paciente_medida;
CREATE POLICY p_sel ON mednexo.paciente_medida FOR SELECT USING (organizacao_id = mednexo.ctx_org() AND mednexo.pode_ler_clinico_paciente(paciente_id));
CREATE POLICY p_ins ON mednexo.paciente_medida FOR INSERT WITH CHECK (organizacao_id = mednexo.ctx_org() AND registrado_por = mednexo.ctx_usuario() AND mednexo.pode_escrever_clinico_paciente(paciente_id));
GRANT SELECT, INSERT ON mednexo.paciente_medida TO mednexo_app;
CREATE TABLE IF NOT EXISTS mednexo.ia_config (organizacao_id uuid PRIMARY KEY REFERENCES mednexo.organizacao(id), referencia text NOT NULL, aceito_por uuid NOT NULL REFERENCES mednexo.usuario(id), aceito_em timestamptz NOT NULL DEFAULT now());
ALTER TABLE mednexo.ia_interacao ADD COLUMN IF NOT EXISTS exame_id uuid;
`;
const SISTEMA = `Você é um assistente de apoio à decisão clínica para médicos psiquiatras que acompanham pacientes internados. Você NÃO diagnostica, NÃO prescreve e NÃO substitui o julgamento do médico; o médico revisa tudo.
Regras:
- Responda em português do Brasil, de forma objetiva, para um médico.
- Baseie-se SOMENTE no exame enviado e nos dados do paciente fornecidos. Nunca invente valores. Se algo estiver ilegível, ausente ou ambíguo, diga explicitamente.
- Ao julgar se um valor está alterado, use as faixas de referência impressas no próprio laudo quando existirem; se não existirem, diga que usou faixas gerais para adulto/criança conforme a idade e sexo informados e que podem variar por laboratório/método.
- Correlacione achados com idade, sexo, peso/altura/IMC, diagnósticos, alergias e medicações em uso (ex.: monitorização de lítio, valproato, carbamazepina, clozapina, antipsicóticos — função renal/hepática/tireoidiana, hemograma, perfil metabólico, QT/ECG, interações), sem afirmar causalidade.
- Se houver sinal de gravidade/urgência (valores críticos), destaque no topo.
- Não repita nem tente deduzir a identidade do paciente. Ignore dados de identificação que apareçam no documento.
Formato da resposta (markdown simples, curto):
1. **Resumo** (2–3 linhas; urgências primeiro)
2. **Achados do exame** (valor, unidade, referência, situação: normal/alterado/ilegível)
3. **Correlação com o paciente** (idade, sexo, IMC, diagnósticos, medicações, alergias)
4. **Pontos de atenção e sugestões de acompanhamento** (como sugestões ao médico)
5. **Limitações** (qualidade da imagem, dados ausentes, necessidade de confirmar com o laudo original)`;

module.exports = function (pool, { need, uuid }, clin) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const txt = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
  const R = {};
  const key = () => process.env.ANTHROPIC_API_KEY || '';
  const modelo = () => process.env.IA_MODELO || 'claude-sonnet-5-5';
  const base = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const num = (v, min, max, m) => { if (txt(v) === null) return null; const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < min || n > max) throw err(m); return n; };

  // ---- medidas (peso/altura) do paciente
  R['POST /api/pacientes/medidas'] = async (s, c, q, b, ctx) => {
    const peso = num(b.peso_kg, 0.5, 500, 'Peso inválido (0,5 a 500 kg).'), alt = num(b.altura_cm, 30, 250, 'Altura inválida (30 a 250 cm).');
    if (peso === null && alt === null) throw err('Informe peso e/ou altura.');
    const pid = uuid(b.paciente_id);
    await c.query(`INSERT INTO mednexo.paciente_medida (organizacao_id, paciente_id, peso_kg, altura_cm, medido_em, observacao, registrado_por) VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7)`,
      [ctx.org, pid, peso, alt, txt(b.medido_em), txt(b.observacao), ctx.uid]);
    return { ok: true };
  };
  R['GET /api/pacientes/medidas'] = async (s, c, q) => (await c.query(`SELECT peso_kg, altura_cm, medido_em, observacao FROM mednexo.paciente_medida WHERE paciente_id = $1 ORDER BY medido_em DESC, registrado_em DESC LIMIT 20`, [uuid(q.paciente_id)])).rows;

  // ---- configuração / status
  async function config(ctx) { return (await pool.query('SELECT referencia, aceito_em FROM mednexo.ia_config WHERE organizacao_id = $1', [ctx.org])).rows[0] || null; }
  R['GET /api/ia/status'] = async (s, c, q, b, ctx) => {
    const cf = await config(ctx);
    return { chave_configurada: !!key(), termo_aceito: !!cf, referencia: cf && cf.referencia, modelo: modelo(), pode_configurar: s.papel === 'medico_administrador', pronto: !!key() && !!cf };
  };
  R['POST /api/ia/config'] = async (s, c, q, b, ctx) => {
    if (s.papel !== 'medico_administrador') throw err('Somente o médico administrador aceita o termo de uso da IA.', 403);
    const ref = need(b.referencia, 'Informe a referência do termo/avaliação de segurança (LGPD).'); if (ref.length < 10) throw err('Referência muito curta (mín. 10 caracteres).');
    if (b.aceito !== true) throw err('É necessário confirmar o aceite.');
    await pool.query(`INSERT INTO mednexo.ia_config (organizacao_id, referencia, aceito_por) VALUES ($1,$2,$3) ON CONFLICT (organizacao_id) DO UPDATE SET referencia = EXCLUDED.referencia, aceito_por = EXCLUDED.aceito_por, aceito_em = now()`, [ctx.org, ref.slice(0, 300), ctx.uid]);
    return { ok: true };
  };

  // ---- contexto clínico SEM identificação direta
  async function contextoPaciente(c, ex) {
    const p = (await c.query(`SELECT p.data_nascimento, p.sexo_registrado, p.alergias_status FROM mednexo.paciente p WHERE p.id = $1`, [ex.paciente_id])).rows[0];
    const m = (await c.query(`SELECT peso_kg, altura_cm, medido_em FROM mednexo.paciente_medida WHERE paciente_id = $1 ORDER BY medido_em DESC, registrado_em DESC LIMIT 5`, [ex.paciente_id])).rows;
    const peso = m.find(x => x.peso_kg !== null), alt = m.find(x => x.altura_cm !== null);
    const nasc = new Date(String(p.data_nascimento).slice(0, 10)), hoje = new Date(); let idade = hoje.getFullYear() - nasc.getFullYear(); if (hoje < new Date(hoje.getFullYear(), nasc.getMonth(), nasc.getDate())) idade--;
    const imc = peso && alt ? (Number(peso.peso_kg) / Math.pow(Number(alt.altura_cm) / 100, 2)).toFixed(1) : null;
    const al = (await c.query(`SELECT agente, categoria, gravidade, reacao FROM mednexo.paciente_alergia WHERE paciente_id = $1 AND situacao = 'ativa'`, [ex.paciente_id])).rows;
    const dg = (await c.query(`SELECT cid.codigo, cid.descricao, d.situacao, d.principal FROM mednexo.diagnostico d JOIN mednexo.cid ON cid.id = d.cid_id WHERE d.paciente_id = $1 AND d.encerrado_em IS NULL AND d.situacao IN ('hipotese','confirmado') ORDER BY d.principal DESC`, [ex.paciente_id])).rows;
    const pv = (await c.query(`SELECT rc.id FROM mednexo.registro_clinico rc WHERE rc.internacao_id = $1 AND rc.tipo = 'prescricao' AND rc.status = 'assinado' ORDER BY rc.assinado_em DESC LIMIT 1`, [ex.internacao_id])).rows[0];
    const meds = pv ? await clin.itensPresc(c, pv.id) : [];
    const outros = (await c.query(`SELECT nome_exame, tipo, resultado_em, resultado_texto, resultado_alterado FROM mednexo.exame WHERE internacao_id = $1 AND id <> $2 AND resultado_texto IS NOT NULL ORDER BY resultado_em DESC LIMIT 10`, [ex.internacao_id, ex.id])).rows;
    const L = [`Idade: ${idade} anos`, `Sexo registrado: ${p.sexo_registrado}`, `Peso: ${peso ? Number(peso.peso_kg) + ' kg (medido em ' + String(peso.medido_em).slice(0, 10) + ')' : 'não informado'}`, `Altura: ${alt ? Number(alt.altura_cm) + ' cm' : 'não informada'}`, `IMC: ${imc || 'não calculável'}`,
      `Alergias: ${p.alergias_status === 'possui_alergias' ? al.map(a => `${a.agente} (${a.categoria}, ${a.gravidade}${a.reacao ? ', ' + a.reacao : ''})`).join('; ') || 'constam, sem detalhe' : p.alergias_status === 'sem_alergias_conhecidas' ? 'sem alergias conhecidas' : 'NÃO AVALIADAS'}`,
      `Diagnósticos em curso: ${dg.length ? dg.map(d => `${d.codigo} ${d.descricao} (${d.situacao}${d.principal ? ', principal' : ''})`).join('; ') : 'nenhum registrado'}`,
      `Medicações em uso (prescrição vigente): ${meds.length ? meds.map(i => `${i.principio}${i.concentracao_valor ? ' ' + Number(i.concentracao_valor) + (i.concentracao_unidade || '') : ''} ${Number(i.dose_valor)}${i.dose_unidade} ${i.via}`).join('; ') : 'nenhuma prescrição vigente assinada'}`];
    if (outros.length) L.push('Outros exames desta internação (texto): ' + outros.map(o => `${o.nome_exame} (${String(o.resultado_em).slice(0, 10)}): ${String(o.resultado_texto).slice(0, 200)}${o.resultado_alterado ? ' [alterado]' : ''}`).join(' | '));
    return { texto: L.join('\n'), idade, imc };
  }

  async function chamarIA(partes, sistema = SISTEMA, maxTok = 3000) {
    if (!key()) throw err('IA não configurada neste servidor (falta a chave do provedor).', 503);
    let r;
    try {
      r = await fetch(base() + '/v1/messages', { method: 'POST', signal: AbortSignal.timeout(240000), headers: { 'content-type': 'application/json', 'x-api-key': key(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo(), max_tokens: maxTok, system: sistema, messages: [{ role: 'user', content: partes }] }) });
    } catch (e) { throw err('Não foi possível falar com o provedor de IA agora (' + (e.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede') + '). Tente novamente.', 502); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.log('ia: erro provedor', r.status, JSON.stringify(j).slice(0, 300)); throw err(r.status === 401 ? 'Chave da IA inválida no servidor.' : r.status === 429 ? 'Limite de uso da IA atingido; tente mais tarde.' : 'O provedor de IA recusou o pedido' + (j.error && j.error.message ? ': ' + String(j.error.message).slice(0, 200) : '.'), 502); }
    const t = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    if (!t) throw err('A IA não devolveu texto.', 502); return t;
  }

  R['POST /api/exames/analisar'] = async (s, c, q, b, ctx) => {
    if (b.confirmou_envio !== true) throw err('Confirme o envio do exame e dos dados clínicos (sem identificação direta) ao provedor de IA.');
    const cf = await config(ctx); if (!cf) throw err('A IA ainda não foi habilitada: o médico administrador precisa aceitar o termo de uso (aba Exames → Configurar IA).', 403);
    if (!key()) throw err('IA não configurada neste servidor (falta a chave do provedor). Peça ao administrador do sistema.', 503);
    const ex = (await c.query(`SELECT e.id, e.paciente_id, e.internacao_id, e.nome_exame, e.tipo, e.coletado_em, e.resultado_em, e.resultado_texto, e.resultado_arquivo_id FROM mednexo.exame e WHERE e.id = $1`, [uuid(b.exame_id)])).rows[0];
    if (!ex) throw err('Exame não encontrado ou sem permissão.', 404);
    const partes = []; let arqSha = '';
    if (ex.resultado_arquivo_id) {
      const a = (await c.query(`SELECT a.mime_type, a.invalidado_em, a.nome_original, encode(k.conteudo,'base64') AS b64, encode(a.sha256,'hex') AS sha FROM mednexo.arquivo a JOIN mednexo.arquivo_conteudo k ON k.arquivo_id = a.id WHERE a.id = $1`, [ex.resultado_arquivo_id])).rows[0];
      if (!a) throw err('Arquivo do exame não encontrado.', 404);
      if (a.invalidado_em) throw err('O arquivo deste exame foi invalidado.', 409);
      const kind = MIME_IA[a.mime_type]; if (!kind) throw err('Este tipo de arquivo não pode ser analisado pela IA (use PDF ou imagem JPG/PNG/WEBP/GIF).', 415);
      partes.push({ type: kind, source: { type: 'base64', media_type: a.mime_type, data: a.b64 } }); arqSha = a.sha;
    } else if (!txt(ex.resultado_texto)) throw err('Este exame não tem arquivo nem resultado em texto para analisar.');
    const ctxp = await contextoPaciente(c, ex);
    const pergunta = txt(b.pergunta) ? String(b.pergunta).slice(0, 600) : null;
    const prompt = `Exame: ${ex.nome_exame} (${ex.tipo})${ex.coletado_em ? ' — coletado em ' + new Date(ex.coletado_em).toISOString().slice(0, 10) : ''}\n${txt(ex.resultado_texto) ? 'Resultado/observação em texto: ' + ex.resultado_texto + '\n' : ''}\nDADOS DO PACIENTE (sem identificação direta):\n${ctxp.texto}\n${pergunta ? '\nPergunta específica do médico: ' + pergunta + '\n' : ''}\nAnalise o exame ${partes.length ? 'anexado ' : ''}conforme as regras.`;
    partes.push({ type: 'text', text: prompt });
    const resposta = await chamarIA(partes);
    const sha = crypto.createHash('sha256').update(prompt + '|' + arqSha).digest('hex');
    const r = (await c.query(`INSERT INTO mednexo.ia_interacao (organizacao_id, usuario_id, paciente_id, internacao_id, finalidade, provedor, modelo, avaliacao_seguranca_ref, registros_origem, prompt_sha256, resposta, exame_id)
      VALUES ($1,$2,$3,$4,'analise_exame','anthropic',$5,$6,'{}',decode($7,'hex'),$8,$9) RETURNING id, criado_em`, [ctx.org, ctx.uid, ex.paciente_id, ex.internacao_id, modelo(), cf.referencia, sha, resposta, ex.id])).rows[0];
    await c.query(`SELECT mednexo.auditar_acesso('ia_analise','exame',$1,$2::uuid,$3::uuid,$4::jsonb)`, [ex.id, ex.paciente_id, ex.internacao_id, JSON.stringify({ ia_interacao: r.id, modelo: modelo(), arquivo_enviado: !!arqSha })]);
    return { id: r.id, criado_em: r.criado_em, modelo: modelo(), resposta, dados_enviados: ctxp.texto };
  };
  R['GET /api/exames/analises'] = async (s, c, q) => (await c.query(`SELECT i.id, i.criado_em, i.modelo, i.resposta, i.resultado, i.revisado_em, u.nome_completo AS solicitante FROM mednexo.ia_interacao i JOIN mednexo.usuario u ON u.id = i.usuario_id WHERE i.exame_id = $1 AND i.finalidade = 'analise_exame' ORDER BY i.criado_em DESC`, [uuid(q.exame_id)])).rows;
  // o médico decide o destino da análise: descartar ou copiar para um RASCUNHO de evolução (nunca assina sozinho)
  R['POST /api/ia/revisar'] = async (s, c, q, b, ctx) => {
    const i = (await c.query(`SELECT id, resposta, internacao_id, exame_id, resultado, finalidade FROM mednexo.ia_interacao WHERE id = $1`, [uuid(b.id)])).rows[0];
    if (!i) throw err('Análise não encontrada.', 404); if (i.resultado) throw err('Esta análise já foi revisada.', 409);
    if (b.acao === 'descartar') { await c.query(`UPDATE mednexo.ia_interacao SET resultado = 'descartado', revisado_por = $2, revisado_em = now() WHERE id = $1`, [i.id, ctx.uid]); return { ok: true }; }
    if (b.acao !== 'rascunho') throw err('Ação inválida.');
    const it = await clin.internacao(c, i.internacao_id);
    const r = (await c.query(`INSERT INTO mednexo.registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES ($1,$2,$3,$4,'evolucao',$5) RETURNING id`, [ctx.org, it.paciente_id, it.hospital_id, it.id, ctx.uid])).rows[0];
    await c.query(`INSERT INTO mednexo.evolucao (registro_id, motivo, texto_livre) VALUES ($1,'outro',$2)`, [r.id, `[Rascunho a partir de ${i.finalidade === 'resumo_clinico' ? 'resumo clínico' : 'análise de exame'} assistido por IA — REVISAR, CORRIGIR E VALIDAR antes de assinar]\n\n${i.resposta}`]);
    await c.query(`UPDATE mednexo.ia_interacao SET resultado = 'usado_como_rascunho', revisado_por = $2, revisado_em = now() WHERE id = $1`, [i.id, ctx.uid]);
    return { ok: true, registro_id: r.id };
  };

  // ================= RESUMO CLÍNICO CRÍTICO DA INTERNAÇÃO (apoio à decisão; o médico valida) =================
  const SISTEMA_RESUMO = `Você atua como um médico psiquiatra sênior, revisor e preceptor, analisando o prontuário de um paciente internado para o médico assistente. Seja tecnicamente rigoroso e CRÍTICO: seu valor está em apontar o que está errado, incoerente, ausente ou arriscado, não em elogiar ou repetir o prontuário.
Regras inegociáveis:
- Português do Brasil, linguagem médica, objetiva. Escreva para um médico.
- Use SOMENTE os dados fornecidos (prontuário em texto e exames anexados). Nunca invente valores, datas, sintomas ou condutas. Quando faltar informação, diga "não documentado".
- Cite a data/fonte ao afirmar algo (ex.: "evolução de 12/11", "hemograma de 10/11").
- Você NÃO assina, NÃO prescreve e NÃO decide: toda conduta é formulada como sugestão para o médico avaliar. O médico assistente valida tudo.
- Seja crítico: aponte inconsistências entre registros, lacunas de documentação (ex.: risco não reavaliado, alergias não avaliadas, exame do estado mental incompleto), monitorização laboratorial pendente para os fármacos em uso (lítio, valproato, carbamazepina, clozapina, antipsicóticos: função renal/hepática/tireoidiana, hemograma/neutrófilos, perfil metabólico, ECG/QTc, níveis séricos), interações e efeitos adversos plausíveis, sinais de piora ou de risco (suicídio, agressividade, evasão, recusa alimentar, clínico), e hipóteses diagnósticas alternativas que os dados sustentem ou não descartem.
- Não tente identificar o paciente e ignore dados de identificação que apareçam em laudos.
Formato (markdown simples, títulos em negrito, frases curtas):
**1. Alertas críticos** (o que exige atenção hoje; se não houver, escreva "Nenhum alerta crítico identificado nos dados")
**2. Síntese do estado clínico atual** (4 a 6 linhas)
**3. Evolução e tendência** (melhora, piora ou estabilidade, com evidências e datas)
**4. História da doença atual (síntese)**
**5. Exames: achados relevantes** (alterados primeiro, com valor, data e referência quando houver)
**6. Tratamento em uso: segurança e monitorização**
**7. Análise crítica** (inconsistências, lacunas, diagnósticos diferenciais, o que não fecha)
**8. Sugestões para o médico considerar**
**9. Limitações desta análise**`;
  const t1 = (v, n = 1500) => txt(v) ? String(v).trim().slice(0, n) : null;
  const dt = v => v ? new Date(v).toISOString().slice(0, 10).split('-').reverse().join('/') : '?';
  async function prontuarioTexto(c, iid) {
    const it = (await c.query(`SELECT i.id, i.paciente_id, i.data_admissao, i.modalidade, i.status, ic.motivo_internacao, ic.observacoes_admissao
      FROM mednexo.internacao i LEFT JOIN mednexo.internacao_clinico ic ON ic.internacao_id = i.id WHERE i.id = $1`, [iid])).rows[0];
    if (!it) throw err('Internação não encontrada ou sem permissão.', 404);
    const L = [], origem = [];
    const dias = Math.max(0, Math.round((Date.now() - new Date(it.data_admissao)) / 864e5));
    L.push(`INTERNAÇÃO: admissão em ${dt(it.data_admissao)} (${dias} dia(s) de internação), modalidade ${it.modalidade}, situação ${it.status}.`);
    if (t1(it.motivo_internacao)) L.push(`Motivo da internação: ${t1(it.motivo_internacao)}`);
    if (t1(it.observacoes_admissao)) L.push(`Observações da admissão: ${t1(it.observacoes_admissao)}`);
    const reg = async (tipo, extra, lim) => (await c.query(`SELECT rc.id, rc.ocorrido_em, rc.status ${extra.cols} FROM mednexo.registro_clinico rc ${extra.join}
      WHERE rc.internacao_id = $1 AND rc.tipo = '${tipo}' AND rc.status = 'assinado' ORDER BY rc.ocorrido_em DESC LIMIT ${lim}`, [iid])).rows;
    const an = await reg('anamnese', { cols: ', a.*', join: 'JOIN mednexo.anamnese a ON a.registro_id = rc.id' }, 1);
    if (an[0]) { const a = an[0]; origem.push(a.id);
      const campos = [['Queixa principal', a.queixa_principal], ['Início dos sintomas', a.hda_inicio_sintomas], ['Tempo de evolução', a.hda_tempo_evolucao], ['Fatores desencadeantes', a.hda_fatores_desencadeantes], ['Sintomas predominantes', a.hda_sintomas_predominantes], ['Evolução recente', a.hda_evolucao_recente], ['Tratamentos realizados', a.hda_tratamentos_realizados], ['Resposta aos tratamentos', a.hda_resposta_tratamentos], ['Impacto funcional', a.hda_impacto_funcional], ['Complemento', a.hda_complementar], ['Contexto da internação', a.contexto_internacao], ['Fonte/confiabilidade', [a.fonte_informacao, a.confiabilidade_relato].filter(Boolean).join(' / ')]];
      L.push(`\nANAMNESE / HISTÓRIA DA DOENÇA ATUAL (assinada em ${dt(a.ocorrido_em)}):`);
      campos.forEach(([k, v]) => { if (t1(v)) L.push(`- ${k}: ${t1(v)}`); });
      for (const [k, v] of [['Antecedentes psiquiátricos', a.antecedentes_psiquiatricos], ['Antecedentes pessoais', a.antecedentes_pessoais], ['Antecedentes familiares', a.antecedentes_familiares], ['Contexto psicossocial', a.contexto_psicossocial]])
        if (v && Object.keys(v).length) L.push(`- ${k}: ${JSON.stringify(v).slice(0, 1200)}`);
    } else L.push('\nANAMNESE: nenhuma anamnese assinada nesta internação.');
    const eem = await reg('exame_estado_mental', { cols: ', e.observacoes_gerais', join: 'JOIN mednexo.exame_estado_mental e ON e.registro_id = rc.id' }, 2);
    for (const e of eem) { origem.push(e.id);
      const d = (await c.query(`SELECT d.dominio, d.avaliado, d.observacao, coalesce(string_agg(i.codigo, ', '), '') AS itens FROM mednexo.eem_dominio d LEFT JOIN mednexo.eem_item i ON i.registro_id = d.registro_id AND i.dominio = d.dominio WHERE d.registro_id = $1 GROUP BY 1,2,3`, [e.id])).rows;
      L.push(`\nEXAME DO ESTADO MENTAL (${dt(e.ocorrido_em)}): ${d.map(x => `${x.dominio}: ${x.avaliado ? (x.itens || '') + (x.observacao ? ' (' + t1(x.observacao, 200) + ')' : '') : 'não avaliado — ' + t1(x.observacao, 120)}`).join('; ')}${t1(e.observacoes_gerais) ? ' | Obs.: ' + t1(e.observacoes_gerais) : ''}`); }
    const rk = await reg('avaliacao_risco', { cols: ', r.*', join: 'JOIN mednexo.avaliacao_risco r ON r.registro_id = rc.id' }, 3);
    for (const r of rk) { origem.push(r.id);
      const its = (await c.query(`SELECT dimensao, situacao, observacao FROM mednexo.avaliacao_risco_item WHERE registro_id = $1`, [r.id])).rows;
      L.push(`\nAVALIAÇÃO DE RISCO (${dt(r.ocorrido_em)}): nível definido pelo médico: ${r.nivel_risco_profissional || 'não definido'}${t1(r.justificativa_nivel) ? ' — ' + t1(r.justificativa_nivel, 400) : ''}. Itens: ${its.map(x => `${x.dimensao}=${x.situacao}${x.observacao ? ' (' + t1(x.observacao, 120) + ')' : ''}`).join('; ')}. Fatores de risco: ${t1(r.fatores_risco, 400) || '—'}. Protetores: ${t1(r.fatores_protetores, 300) || '—'}. Conduta: ${t1(r.conduta, 300) || '—'}.${r.reavaliar_em ? ' Reavaliar em ' + dt(r.reavaliar_em) + '.' : ''}`); }
    const ev = (await reg('evolucao', { cols: ', e.*', join: 'JOIN mednexo.evolucao e ON e.registro_id = rc.id' }, 15)).reverse();
    L.push(`\nEVOLUÇÕES ASSINADAS (${ev.length}, da mais antiga para a mais recente):`);
    for (const e of ev) { origem.push(e.id);
      const f = [['S', e.subjetivo], ['O', e.objetivo], ['Estado mental', e.estado_mental], ['Sono', e.sono], ['Apetite', e.apetite], ['Comportamento', e.comportamento], ['Adesão', e.adesao], ['Efeitos adversos', e.efeitos_adversos], ['Impressão', e.impressao_diagnostica], ['Conduta', e.conduta], ['Texto', e.texto_livre]].filter(x => t1(x[1])).map(x => `${x[0]}: ${t1(x[1], 600)}`);
      L.push(`- ${dt(e.ocorrido_em)} [${e.motivo}] ${f.join(' | ') || '(sem conteúdo)'}`); }
    const ic = await reg('intercorrencia', { cols: ', x.tipo AS tipo_int, x.descricao, x.conduta, x.contencao_fisica, x.contencao_quimica', join: 'JOIN mednexo.intercorrencia x ON x.registro_id = rc.id' }, 10);
    if (ic.length) { L.push('\nINTERCORRÊNCIAS:'); ic.reverse().forEach(x => { origem.push(x.id); L.push(`- ${dt(x.ocorrido_em)} ${x.tipo_int}: ${t1(x.descricao, 400) || ''}${x.contencao_fisica ? ' [contenção física]' : ''}${x.contencao_quimica ? ' [contenção química]' : ''} Conduta: ${t1(x.conduta, 300) || '—'}`); }); }
    return { it, texto: L.join('\n'), origem };
  }

  R['POST /api/ia/resumo-clinico'] = async (s, c, q, b, ctx) => {
    if (!['medico_administrador', 'medico_assistente'].includes(s.papel)) throw err('Somente médicos podem gerar o resumo clínico por IA.', 403);
    if (b.confirmou_envio !== true) throw err('Confirme o envio dos dados clínicos (sem identificação direta) ao provedor de IA.');
    const cf = await config(ctx); if (!cf) throw err('A IA ainda não foi habilitada: o médico administrador precisa aceitar o termo de uso (aba Exames → Habilitar análise por IA).', 403);
    if (!key()) throw err('IA não configurada neste servidor (falta a chave do provedor).', 503);
    const iid = uuid(b.internacao_id);
    const pr = await prontuarioTexto(c, iid);
    const ctxp = await contextoPaciente(c, { paciente_id: pr.it.paciente_id, internacao_id: iid, id: '00000000-0000-0000-0000-000000000000' });
    const exs = (await c.query(`SELECT e.id, e.nome_exame, e.tipo, e.coletado_em, e.resultado_em, e.resultado_texto, e.resultado_alterado, e.resultado_arquivo_id,
        a.mime_type, a.tamanho_bytes, a.invalidado_em,
        (SELECT i.resposta FROM mednexo.ia_interacao i WHERE i.exame_id = e.id AND i.finalidade = 'analise_exame' ORDER BY i.criado_em DESC LIMIT 1) AS analise
      FROM mednexo.exame e LEFT JOIN mednexo.arquivo a ON a.id = e.resultado_arquivo_id WHERE e.internacao_id = $1 ORDER BY coalesce(e.resultado_em, e.coletado_em) DESC NULLS LAST LIMIT 30`, [iid])).rows;
    const partes = []; const LE = []; let anexos = 0, bytes = 0; const shaArq = [];
    for (const e of exs) {
      LE.push(`- ${e.nome_exame} (${e.tipo}, ${dt(e.resultado_em || e.coletado_em)})${e.resultado_alterado === true ? ' [marcado como ALTERADO]' : e.resultado_alterado === false ? ' [sem alteração]' : ''}${t1(e.resultado_texto) ? ': ' + t1(e.resultado_texto, 500) : ''}${e.analise ? '\n  Leitura prévia por IA (não validada): ' + t1(e.analise, 800) : ''}`);
      if (e.resultado_arquivo_id && !e.invalidado_em && MIME_IA[e.mime_type] && anexos < 4 && Number(e.tamanho_bytes) <= 5e6 && bytes + Number(e.tamanho_bytes) <= 15e6) {
        const k = (await c.query(`SELECT encode(k.conteudo,'base64') AS b64, encode(a.sha256,'hex') AS sha FROM mednexo.arquivo a JOIN mednexo.arquivo_conteudo k ON k.arquivo_id = a.id WHERE a.id = $1`, [e.resultado_arquivo_id])).rows[0];
        if (k) { partes.push({ type: 'text', text: `Anexo ${anexos + 1}: ${e.nome_exame} (${dt(e.resultado_em || e.coletado_em)})` }); partes.push({ type: MIME_IA[e.mime_type], source: { type: 'base64', media_type: e.mime_type, data: k.b64 } }); anexos++; bytes += Number(e.tamanho_bytes); shaArq.push(k.sha); }
      }
    }
    const pergunta = t1(b.pergunta, 600);
    const prompt = `DADOS DO PACIENTE (sem identificação direta):\n${ctxp.texto}\n\n${pr.texto}\n\nEXAMES DESTA INTERNAÇÃO (${exs.length}; ${anexos} arquivo(s) anexado(s) acima):\n${LE.join('\n') || 'nenhum exame registrado'}\n${pergunta ? '\nPergunta específica do médico: ' + pergunta + '\n' : ''}\nProduza o resumo clínico crítico conforme as regras e o formato.`;
    partes.push({ type: 'text', text: prompt });
    const resposta = await chamarIA(partes, SISTEMA_RESUMO, 4000);
    const sha = crypto.createHash('sha256').update(prompt + '|' + shaArq.join(',')).digest('hex');
    const r = (await c.query(`INSERT INTO mednexo.ia_interacao (organizacao_id, usuario_id, paciente_id, internacao_id, finalidade, provedor, modelo, avaliacao_seguranca_ref, registros_origem, prompt_sha256, resposta)
      VALUES ($1,$2,$3,$4,'resumo_clinico','anthropic',$5,$6,$7::uuid[],decode($8,'hex'),$9) RETURNING id, criado_em`, [ctx.org, ctx.uid, pr.it.paciente_id, iid, modelo(), cf.referencia, '{' + pr.origem.join(',') + '}', sha, resposta])).rows[0];
    await c.query(`SELECT mednexo.auditar_acesso('ia_resumo_clinico','internacao',$1,$2::uuid,$3::uuid,$4::jsonb)`, [iid, pr.it.paciente_id, iid, JSON.stringify({ ia_interacao: r.id, modelo: modelo(), registros: pr.origem.length, exames: exs.length, anexos })]);
    return { id: r.id, criado_em: r.criado_em, modelo: modelo(), resposta, fontes: { registros: pr.origem.length, exames: exs.length, anexos } };
  };
  R['GET /api/ia/resumos'] = async (s, c, q) => (await c.query(`SELECT i.id, i.criado_em, i.modelo, i.resposta, i.resultado, i.revisado_em, u.nome_completo AS solicitante FROM mednexo.ia_interacao i JOIN mednexo.usuario u ON u.id = i.usuario_id WHERE i.internacao_id = $1 AND i.finalidade = 'resumo_clinico' ORDER BY i.criado_em DESC LIMIT 20`, [uuid(q.internacao_id)])).rows;
  return { routes: R, migrar: () => pool.raw(MIGRACAO) };
};
