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

  async function chamarIA(partes) {
    if (!key()) throw err('IA não configurada neste servidor (falta a chave do provedor).', 503);
    let r;
    try {
      r = await fetch(base() + '/v1/messages', { method: 'POST', signal: AbortSignal.timeout(150000), headers: { 'content-type': 'application/json', 'x-api-key': key(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo(), max_tokens: 3000, system: SISTEMA, messages: [{ role: 'user', content: partes }] }) });
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
    const i = (await c.query(`SELECT id, resposta, internacao_id, exame_id, resultado FROM mednexo.ia_interacao WHERE id = $1`, [uuid(b.id)])).rows[0];
    if (!i) throw err('Análise não encontrada.', 404); if (i.resultado) throw err('Esta análise já foi revisada.', 409);
    if (b.acao === 'descartar') { await c.query(`UPDATE mednexo.ia_interacao SET resultado = 'descartado', revisado_por = $2, revisado_em = now() WHERE id = $1`, [i.id, ctx.uid]); return { ok: true }; }
    if (b.acao !== 'rascunho') throw err('Ação inválida.');
    const it = await clin.internacao(c, i.internacao_id);
    const r = (await c.query(`INSERT INTO mednexo.registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES ($1,$2,$3,$4,'evolucao',$5) RETURNING id`, [ctx.org, it.paciente_id, it.hospital_id, it.id, ctx.uid])).rows[0];
    await c.query(`INSERT INTO mednexo.evolucao (registro_id, motivo, texto_livre) VALUES ($1,'outro',$2)`, [r.id, `[Rascunho a partir de análise assistida por IA — REVISAR E EDITAR antes de assinar]\n\n${i.resposta}`]);
    await c.query(`UPDATE mednexo.ia_interacao SET resultado = 'usado_como_rascunho', revisado_por = $2, revisado_em = now() WHERE id = $1`, [i.id, ctx.uid]);
    return { ok: true, registro_id: r.id };
  };
  return { routes: R, migrar: () => pool.raw(MIGRACAO) };
};
