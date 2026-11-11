'use strict';
// Rotas clínicas ampliadas: evolução completa, prescrição, catálogo de medicamentos e importação de exames/arquivos.
const crypto = require('crypto');

const MIGRACAO = `
CREATE TABLE IF NOT EXISTS mednexo.arquivo_conteudo (
  arquivo_id uuid PRIMARY KEY REFERENCES mednexo.arquivo(id),
  organizacao_id uuid NOT NULL,
  conteudo bytea NOT NULL
);
ALTER TABLE mednexo.arquivo_conteudo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_sel ON mednexo.arquivo_conteudo;
DROP POLICY IF EXISTS p_ins ON mednexo.arquivo_conteudo;
CREATE POLICY p_sel ON mednexo.arquivo_conteudo FOR SELECT USING (organizacao_id = mednexo.ctx_org() AND EXISTS (SELECT 1 FROM mednexo.arquivo a WHERE a.id = arquivo_id));
CREATE POLICY p_ins ON mednexo.arquivo_conteudo FOR INSERT WITH CHECK (organizacao_id = mednexo.ctx_org());
GRANT SELECT, INSERT ON mednexo.arquivo_conteudo TO mednexo_app;
`;

const MAX_ARQ = 8 * 1024 * 1024;
const TIPOS = { 'application/pdf': b => b.subarray(0, 4).toString() === '%PDF',
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/webp': b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'image/gif': b => b.subarray(0, 3).toString() === 'GIF',
  'application/dicom': b => b.length > 132 && b.subarray(128, 132).toString() === 'DICM' };
const EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', dcm: 'application/dicom' };

module.exports = function (pool, { need, uuid }) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const txt = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
  const num = (v, m) => { const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n <= 0) throw err(m); return n; };
  const ts = (v, m) => { if (!v) return null; const d = new Date(v); if (isNaN(d)) throw err(m || 'data/hora inválida'); return d.toISOString(); };

  async function internacao(c, id) {
    const it = (await c.query('SELECT id, paciente_id, hospital_id FROM mednexo.internacao WHERE id = $1', [uuid(id)])).rows[0];
    if (!it) throw err('Internação não encontrada ou sem permissão.', 404);
    return it;
  }
  async function salvarArquivo(c, ctx, it, categoria, f) {
    f = f || {}; const nome = need(f.nome, 'nome do arquivo obrigatório').replace(/[\\/\0]/g, '_').slice(0, 200);
    const ext = (nome.split('.').pop() || '').toLowerCase();
    const mime = TIPOS[f.mime] ? f.mime : EXT[ext];
    if (!mime || !TIPOS[mime]) throw err('Tipo de arquivo não permitido. Use PDF, JPG, PNG, WEBP, GIF ou DICOM.', 415);
    const buf = Buffer.from(need(f.base64, 'conteúdo do arquivo obrigatório'), 'base64');
    if (!buf.length) throw err('Arquivo vazio.');
    if (buf.length > MAX_ARQ) throw err('Arquivo maior que 8 MB.', 413);
    if (!TIPOS[mime](buf)) throw err(`O conteúdo de "${nome}" não corresponde ao tipo ${mime}.`, 415);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const a = (await c.query(`INSERT INTO mednexo.arquivo (organizacao_id, paciente_id, internacao_id, categoria, nome_original, mime_type, tamanho_bytes, sha256, storage_chave, criado_por)
      VALUES ($1,$2,$3,$4::mednexo.categoria_arquivo,$5,$6,$7,decode($8,'hex'),$9,$10) RETURNING id`,
      [ctx.org, it.paciente_id, it.id, categoria, nome, mime, buf.length, sha, 'db/' + crypto.randomUUID(), ctx.uid])).rows[0];
    await c.query(`INSERT INTO mednexo.arquivo_conteudo (arquivo_id, organizacao_id, conteudo) VALUES ($1,$2,decode($3,'hex'))`, [a.id, ctx.org, buf.toString('hex')]);
    await c.query(`SELECT mednexo.auditar_acesso('criacao','arquivo',$1,$2::uuid,$3::uuid,$4::jsonb)`, [a.id, it.paciente_id, it.id, JSON.stringify({ nome, mime, sha256: sha })]);
    return { id: a.id, nome, mime, sha256: sha };
  }
  // tenta assinar sem perder o rascunho: em falha, volta ao savepoint e devolve o motivo
  async function tentarAssinar(c, id) {
    await c.query('SAVEPOINT assin');
    try { await c.query('SELECT mednexo.assinar_registro($1)', [id]); await c.query('RELEASE SAVEPOINT assin'); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT assin'); await c.query('RELEASE SAVEPOINT assin'); return e.message; }
  }
  const CAMPOS_EVOL = ['subjetivo', 'objetivo', 'estado_mental', 'sono', 'apetite', 'comportamento', 'adesao', 'efeitos_adversos', 'impressao_diagnostica', 'conduta', 'texto_livre'];
  const MOTIVOS = ['rotina', 'intercorrencia', 'admissao', 'pre_alta', 'outro'];

  const R = {
    'POST /api/evolucoes': async (s, c, q, b, ctx) => {
      const it = await internacao(c, b.internacao_id);
      const motivo = MOTIVOS.includes(b.motivo) ? b.motivo : 'rotina';
      const oc = ts(b.ocorrido_em, 'data/hora da evolução inválida');
      const r = (await c.query(`INSERT INTO mednexo.registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id, ocorrido_em, justificativa_retroativo)
        VALUES ($1,$2,$3,$4,'evolucao',$5,COALESCE($6::timestamptz, clock_timestamp()),$7) RETURNING id`, [ctx.org, it.paciente_id, it.hospital_id, it.id, ctx.uid, oc, txt(b.justificativa_retroativo)])).rows[0];
      await c.query(`INSERT INTO mednexo.evolucao (registro_id, motivo, ${CAMPOS_EVOL.join(', ')}) VALUES ($1,$2::mednexo.motivo_evolucao,${CAMPOS_EVOL.map((_, i) => '$' + (i + 3)).join(',')})`,
        [r.id, motivo, ...CAMPOS_EVOL.map(k => txt(b[k]))]);
      const erro = b.assinar ? await tentarAssinar(c, r.id) : null;
      return { id: r.id, assinado: !!b.assinar && !erro, erro_assinatura: erro };
    },
    'POST /api/evolucoes/atualizar': async (s, c, q, b) => {
      const id = uuid(b.id); const motivo = MOTIVOS.includes(b.motivo) ? b.motivo : 'rotina';
      const rc = (await c.query(`SELECT status, autor_usuario_id FROM mednexo.registro_clinico WHERE id = $1 AND tipo = 'evolucao'`, [id])).rows[0];
      if (!rc) throw err('Evolução não encontrada.', 404);
      if (rc.status !== 'rascunho') throw err('Somente rascunhos podem ser editados; registros assinados recebem adendo.', 409);
      await c.query(`UPDATE mednexo.evolucao SET motivo = $2::mednexo.motivo_evolucao, ${CAMPOS_EVOL.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE registro_id = $1`, [id, motivo, ...CAMPOS_EVOL.map(k => txt(b[k]))]);
      const erro = b.assinar ? await tentarAssinar(c, id) : null;
      return { id, assinado: !!b.assinar && !erro, erro_assinatura: erro };
    },
    // ---- anexos de qualquer registro em rascunho
    'POST /api/registros/anexo': async (s, c, q, b, ctx) => {
      const rc = (await c.query('SELECT id, paciente_id, internacao_id, status FROM mednexo.registro_clinico WHERE id = $1', [uuid(b.registro_id)])).rows[0];
      if (!rc) throw err('Registro não encontrado.', 404);
      if (rc.status !== 'rascunho') throw err('Anexos só podem ser incluídos em rascunho.', 409);
      const a = await salvarArquivo(c, ctx, { id: rc.internacao_id, paciente_id: rc.paciente_id }, 'documento_paciente', b.arquivo);
      await c.query('INSERT INTO mednexo.registro_arquivo (registro_id, arquivo_id, organizacao_id, legenda) VALUES ($1,$2,$3,$4)', [rc.id, a.id, ctx.org, txt(b.legenda)]);
      return a;
    },
    // ---- exames (laboratório / imagem) com importação de arquivo
    'GET /api/exames': async (s, c, q) => (await c.query(`SELECT e.id, e.nome_exame, e.tipo, e.status, e.coletado_em, e.resultado_em, e.resultado_texto, e.resultado_alterado,
        a.id AS arquivo_id, a.nome_original, a.mime_type, a.tamanho_bytes, encode(a.sha256,'hex') AS sha256, a.invalidado_em, a.motivo_invalidacao, u.nome_completo AS registrado_por
      FROM mednexo.exame e LEFT JOIN mednexo.arquivo a ON a.id = e.resultado_arquivo_id JOIN mednexo.usuario u ON u.id = e.registrado_por
      WHERE e.internacao_id = $1 ORDER BY COALESCE(e.resultado_em, e.solicitado_em) DESC`, [uuid(q.internacao_id)])).rows,
    'POST /api/exames': async (s, c, q, b, ctx) => {
      const it = await internacao(c, b.internacao_id);
      const tipo = ['laboratorial', 'imagem', 'eletrofisiologico', 'neuropsicologico', 'outro'].includes(b.tipo) ? b.tipo : 'outro';
      const nome = need(b.nome_exame, 'nome do exame obrigatório').slice(0, 200);
      if (!b.arquivo && !txt(b.resultado_texto)) throw err('Anexe o arquivo do exame ou informe o resultado em texto.');
      const arq = b.arquivo ? await salvarArquivo(c, ctx, it, 'exame', b.arquivo) : null;
      const e = (await c.query(`INSERT INTO mednexo.exame (organizacao_id, paciente_id, hospital_id, internacao_id, nome_exame, tipo, status, coletado_em, resultado_em, resultado_texto, resultado_arquivo_id, resultado_alterado, registrado_por)
        VALUES ($1,$2,$3,$4,$5,$6::mednexo.tipo_exame,'resultado_disponivel',$7,COALESCE($8::timestamptz, now()),$9,$10,$11,$12) RETURNING id`,
        [ctx.org, it.paciente_id, it.hospital_id, it.id, nome, tipo, ts(b.coletado_em), ts(b.resultado_em), txt(b.resultado_texto), arq && arq.id, b.resultado_alterado === true ? true : b.resultado_alterado === false ? false : null, ctx.uid])).rows[0];
      return { id: e.id, arquivo: arq };
    },
    'GET /api/arquivo': async (s, c, q, b, ctx) => {
      const a = (await c.query(`SELECT a.id, a.nome_original, a.mime_type, a.paciente_id, a.internacao_id, encode(k.conteudo,'base64') AS b64
        FROM mednexo.arquivo a JOIN mednexo.arquivo_conteudo k ON k.arquivo_id = a.id WHERE a.id = $1`, [uuid(q.id)])).rows[0];
      if (!a) throw err('Arquivo não encontrado ou sem permissão.', 404);
      await c.query(`SELECT mednexo.auditar_acesso('leitura','arquivo',$1,$2::uuid,$3::uuid,'{"origem":"visualizacao"}'::jsonb)`, [a.id, a.paciente_id, a.internacao_id]);
      return { __raw: { mime: a.mime_type, nome: a.nome_original, buf: Buffer.from(a.b64, 'base64') } };
    },
    'POST /api/arquivos/invalidar': async (s, c, q, b) => {
      const m = need(b.motivo, 'motivo obrigatório'); if (m.length < 10) throw err('Motivo muito curto (mín. 10 caracteres).');
      await c.query('UPDATE mednexo.arquivo SET motivo_invalidacao = $2, invalidado_em = now() WHERE id = $1', [uuid(b.id), m]);
      return { ok: true };
    },
    // ---- catálogo de medicamentos (cadastro por médico administrador; sem doses de referência inventadas)
    'GET /api/catalogo': async (s, c, q) => (await c.query(`SELECT ma.id, p.nome AS principio, ma.nome_comercial, ma.concentracao_valor, ma.concentracao_unidade, ma.forma_farmaceutica, ma.vias_permitidas, p.lista_controle_especial
      FROM mednexo.medicamento_apresentacao ma JOIN mednexo.principio_ativo p ON p.id = ma.principio_ativo_id
      WHERE ma.ativo AND p.ativo AND ($1 = '' OR p.nome ILIKE '%' || $1 || '%' OR ma.nome_comercial ILIKE '%' || $1 || '%') ORDER BY p.nome, ma.concentracao_valor LIMIT 60`, [(q.q || '').slice(0, 60)])).rows,
    'POST /api/catalogo': async (s, c, q, b) => {
      if (s.papel !== 'medico_administrador') throw err('Somente o médico administrador cadastra medicamentos no catálogo.', 403);
      const vias = (Array.isArray(b.vias) ? b.vias : []).filter(v => ['oral', 'sublingual', 'im', 'ev', 'sc', 'topica', 'retal', 'inalatoria', 'oftalmica', 'outra'].includes(v));
      if (!vias.length) throw err('Selecione ao menos uma via permitida.');
      const nome = need(b.principio, 'princípio ativo obrigatório').slice(0, 120), forma = need(b.forma, 'forma farmacêutica obrigatória').slice(0, 80);
      const cv = txt(b.concentracao_valor) ? num(b.concentracao_valor, 'concentração inválida') : null;
      // catálogo é dado de referência (sem RLS por organização): grava com o papel do dono, fora da sessão do usuário
      const p = (await pool.query(`INSERT INTO mednexo.principio_ativo (nome, classe_terapeutica, lista_controle_especial) VALUES ($1,$2,$3)
        ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`, [nome, txt(b.classe), txt(b.lista_controle)])).rows[0];
      const a = (await pool.query(`INSERT INTO mednexo.medicamento_apresentacao (principio_ativo_id, nome_comercial, concentracao_valor, concentracao_unidade, forma_farmaceutica, vias_permitidas)
        VALUES ($1,$2,$3,$4,$5,$6::mednexo.via_administracao[]) RETURNING id`, [p.id, txt(b.nome_comercial), cv, txt(b.concentracao_unidade), forma, '{' + vias.join(',') + '}'])).rows[0];
      console.log('catalogo: apresentacao criada', a.id, 'por', s.nome);
      return { id: a.id };
    },
    // ---- prescrição
    'GET /api/prescricao/vigente': async (s, c, q) => {
      const r = (await c.query(`SELECT rc.id FROM mednexo.registro_clinico rc WHERE rc.internacao_id = $1 AND rc.tipo = 'prescricao' AND rc.status = 'assinado' ORDER BY rc.assinado_em DESC LIMIT 1`, [uuid(q.internacao_id)])).rows[0];
      if (!r) return { itens: [] };
      return { registro_id: r.id, itens: await itensPresc(c, r.id) };
    },
    'POST /api/prescricoes': async (s, c, q, b, ctx) => {
      const it = await internacao(c, b.internacao_id);
      const itens = Array.isArray(b.itens) ? b.itens : [];
      if (!itens.length) throw err('Inclua ao menos um item na prescrição.');
      if (itens.length > 40) throw err('Máximo de 40 itens por prescrição.');
      const tipo = ['hospitalar', 'alta', 'ambulatorial'].includes(b.tipo) ? b.tipo : 'hospitalar';
      const r = (await c.query(`INSERT INTO mednexo.registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
        VALUES ($1,$2,$3,$4,'prescricao',$5) RETURNING id`, [ctx.org, it.paciente_id, it.hospital_id, it.id, ctx.uid])).rows[0];
      await c.query(`INSERT INTO mednexo.prescricao (registro_id, tipo, valida_ate, dieta_cuidados, observacoes_gerais) VALUES ($1,$2::mednexo.tipo_prescricao,$3,$4,$5)`,
        [r.id, tipo, ts(b.valida_ate, 'validade inválida'), txt(b.dieta_cuidados), txt(b.observacoes_gerais)]);
      let ordem = 0;
      for (const i of itens) {
        ordem++; const ft = ['intervalo', 'vezes_dia', 'dose_unica', 'sos', 'infusao_continua'].includes(i.frequencia_tipo) ? i.frequencia_tipo : null;
        if (!ft) throw err(`Item ${ordem}: frequência obrigatória.`);
        const acao = ['iniciar', 'manter', 'ajustar', 'substituir', 'suspender'].includes(i.acao) ? i.acao : 'iniciar';
        const hor = Array.isArray(i.horarios) ? i.horarios.filter(h => /^\d{2}:\d{2}$/.test(h)) : [];
        await c.query(`INSERT INTO mednexo.prescricao_item (registro_id, ordem, apresentacao_id, dose_valor, dose_unidade, via, frequencia_tipo, intervalo_horas, vezes_dia, horarios,
            sos_indicacao, sos_dose_max_24h, data_inicio, data_fim, duracao_dias, quantidade_total, orientacoes, indicacao_clinica, acao, item_anterior_id, motivo_alteracao)
          VALUES ($1,$2,$3,$4,$5,$6::mednexo.via_administracao,$7::mednexo.tipo_frequencia,$8,$9,$10::time[],$11,$12,COALESCE($13::timestamptz, now()),$14,$15,$16,$17,$18,$19::mednexo.acao_item_prescricao,$20,$21)`,
          [r.id, ordem, uuid(i.apresentacao_id, `Item ${ordem}: selecione o medicamento do catálogo.`), num(i.dose_valor, `Item ${ordem}: dose inválida.`), need(i.dose_unidade, `Item ${ordem}: unidade da dose obrigatória.`), need(i.via, `Item ${ordem}: via obrigatória.`), ft,
           ft === 'intervalo' ? num(i.intervalo_horas, `Item ${ordem}: intervalo em horas inválido.`) : null, ft === 'vezes_dia' ? Math.round(num(i.vezes_dia, `Item ${ordem}: vezes ao dia inválido.`)) : null,
           hor.length ? '{' + hor.join(',') + '}' : null, ft === 'sos' ? need(i.sos_indicacao, `Item ${ordem}: indicação do SOS obrigatória.`) : null, ft === 'sos' ? num(i.sos_dose_max_24h, `Item ${ordem}: dose máxima em 24h do SOS obrigatória.`) : null,
           ts(i.data_inicio), ts(i.data_fim), txt(i.duracao_dias) ? Math.round(num(i.duracao_dias, `Item ${ordem}: duração inválida.`)) : null, txt(i.quantidade_total) ? num(i.quantidade_total, `Item ${ordem}: quantidade inválida.`) : null,
           txt(i.orientacoes), need(i.indicacao_clinica, `Item ${ordem}: indicação clínica obrigatória.`), acao, i.item_anterior_id ? uuid(i.item_anterior_id) : null, txt(i.motivo_alteracao)]);
      }
      await c.query('SELECT mednexo.avaliar_alertas_prescricao($1)', [r.id]);
      const erro = b.assinar ? await tentarAssinar(c, r.id) : null;
      const alertas = (await c.query('SELECT id, tipo, gravidade, mensagem, justificativa_medica FROM mednexo.alerta_prescricao WHERE registro_id = $1 ORDER BY gravidade DESC', [r.id])).rows;
      return { id: r.id, assinado: !!b.assinar && !erro, erro_assinatura: erro, alertas };
    },
    'POST /api/prescricoes/justificar': async (s, c, q, b) => {
      const j = need(b.justificativa, 'justificativa obrigatória'); if (j.length < 10) throw err('Justificativa muito curta (mín. 10 caracteres).');
      await c.query('UPDATE mednexo.alerta_prescricao SET justificativa_medica = $2 WHERE id = $1', [uuid(b.alerta_id), j]); return { ok: true };
    },
  };
  async function itensPresc(c, id) {
    return (await c.query(`SELECT i.id, i.ordem, i.apresentacao_id, p.nome AS principio, ma.nome_comercial, ma.concentracao_valor, ma.concentracao_unidade, ma.forma_farmaceutica,
        i.dose_valor, i.dose_unidade, i.via, i.frequencia_tipo, i.intervalo_horas, i.vezes_dia, i.horarios::text AS horarios, i.sos_indicacao, i.sos_dose_max_24h,
        i.data_inicio, i.data_fim, i.duracao_dias, i.orientacoes, i.indicacao_clinica, i.acao, i.motivo_alteracao
      FROM mednexo.prescricao_item i JOIN mednexo.medicamento_apresentacao ma ON ma.id = i.apresentacao_id JOIN mednexo.principio_ativo p ON p.id = ma.principio_ativo_id
      WHERE i.registro_id = $1 ORDER BY i.ordem`, [id])).rows;
  }
  async function detalheRegistro(c, id) {
    const r = (await c.query(`SELECT rc.id, rc.tipo, rc.status, rc.ocorrido_em, rc.assinado_em, rc.justificativa_retroativo, encode(rc.hash_conteudo,'hex') AS hash, rc.motivo_anulacao, u.nome_completo AS autor
      FROM mednexo.registro_clinico rc JOIN mednexo.usuario u ON u.id = rc.autor_usuario_id WHERE rc.id = $1`, [uuid(id)])).rows[0];
    if (!r) throw err('Registro não encontrado ou sem permissão.', 404);
    if (r.tipo === 'evolucao') r.evolucao = (await c.query('SELECT * FROM mednexo.evolucao WHERE registro_id = $1', [r.id])).rows[0];
    if (r.tipo === 'prescricao') {
      r.prescricao = (await c.query('SELECT tipo, valida_de, valida_ate, dieta_cuidados, observacoes_gerais FROM mednexo.prescricao WHERE registro_id = $1', [r.id])).rows[0];
      r.itens = await itensPresc(c, r.id);
      r.alertas = (await c.query('SELECT id, tipo, gravidade, mensagem, justificativa_medica FROM mednexo.alerta_prescricao WHERE registro_id = $1 ORDER BY gravidade DESC', [r.id])).rows;
    }
    r.anexos = (await c.query(`SELECT a.id, a.nome_original, a.mime_type, a.tamanho_bytes, ra.legenda FROM mednexo.registro_arquivo ra JOIN mednexo.arquivo a ON a.id = ra.arquivo_id WHERE ra.registro_id = $1`, [r.id])).rows;
    r.adendos = (await c.query('SELECT tipo, justificativa, conteudo, criado_em FROM mednexo.registro_adendo WHERE registro_id = $1 ORDER BY criado_em', [r.id])).rows;
    return r;
  }
  const pront = require('./prontuario')(pool, { need, uuid }, { internacao, tentarAssinar, txt, ts });
  Object.assign(R, pront.routes);
  R['GET /api/registro'] = async (s, c, q) => { const r = await detalheRegistro(c, q.id); await pront.detalhe(c, r); return r; };
  return { routes: R, migrar: () => pool.raw(MIGRACAO) };
};
