'use strict';
// Documentos (atestado, relatório, parecer...), receitas simples, geração de PDF e registro de compartilhamento.
const crypto = require('crypto');
const { build } = require('./pdf');
const TIPOS_DOC = ['parecer', 'relatorio', 'atestado', 'declaracao', 'encaminhamento', 'solicitacao_exames'];
const NOME_TIPO = { evolucao: 'Evolução médica', prescricao: 'Prescrição médica', receita: 'Receita médica', parecer: 'Parecer médico', relatorio: 'Relatório médico', atestado: 'Atestado médico',
  declaracao: 'Declaração', encaminhamento: 'Encaminhamento', solicitacao_exames: 'Solicitação de exames' };
const EXPORT = { evolucao: 'evolucoes_periodo', prescricao: 'prescricoes', receita: 'receituario', parecer: 'parecer', relatorio: 'relatorio', atestado: 'atestado', resumo_alta: 'resumo_alta' };
const MODELO = 'mednexo-pdf-1';
const FREQ = (i) => i.frequencia_tipo === 'intervalo' ? `a cada ${Number(i.intervalo_horas)} h` : i.frequencia_tipo === 'vezes_dia' ? `${i.vezes_dia}x ao dia` : i.frequencia_tipo === 'sos' ? `SOS (${i.sos_indicacao}; máx. ${Number(i.sos_dose_max_24h)} ${i.dose_unidade}/24 h)` : i.frequencia_tipo === 'dose_unica' ? 'dose única' : 'infusão contínua';
const D = (d, hora) => d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', ...(hora === false ? {} : { hour: '2-digit', minute: '2-digit' }) }) : '—';
const DD = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—';
const idade = n => { if (!n) return ''; const b = new Date(String(n).slice(0, 10)), h = new Date(); let a = h.getFullYear() - b.getFullYear(); if (h < new Date(h.getFullYear(), b.getMonth(), b.getDate())) a--; return a + ' anos'; };
const cnpjF = c => c ? String(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : '';

module.exports = function (pool, { need, uuid }, clin) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const txt = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
  const R = {};

  // ---------- criação ----------
  R['POST /api/documentos'] = async (s, c, q, b, ctx) => {
    const it = await clin.internacao(c, b.internacao_id);
    if (!TIPOS_DOC.includes(b.tipo)) throw err('Tipo de documento inválido.');
    const dias = b.tipo === 'atestado' ? (txt(b.dias_afastamento) === null ? null : Math.round(Number(b.dias_afastamento))) : null;
    if (b.tipo === 'atestado' && (dias === null || !Number.isFinite(dias) || dias < 0 || dias > 365)) throw err('Atestado: informe os dias de afastamento (0 se não houver; máx. 365).');
    const r = (await c.query(`INSERT INTO mednexo.registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES ($1,$2,$3,$4,$5::mednexo.tipo_registro,$6) RETURNING id`,
      [ctx.org, it.paciente_id, it.hospital_id, it.id, b.tipo, ctx.uid])).rows[0];
    await c.query(`INSERT INTO mednexo.documento_clinico (registro_id, titulo, finalidade, destinatario, corpo, cid_id, dias_afastamento) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.id, txt(b.titulo) || NOME_TIPO[b.tipo], txt(b.finalidade), txt(b.destinatario), txt(b.corpo), b.cid_id ? Number(b.cid_id) : null, dias]);
    const erro = b.assinar ? await clin.tentarAssinar(c, r.id) : null;
    return { id: r.id, assinado: !!b.assinar && !erro, erro_assinatura: erro };
  };
  R['POST /api/documentos/atualizar'] = async (s, c, q, b) => {
    const id = uuid(b.id);
    const rc = (await c.query(`SELECT status, tipo FROM mednexo.registro_clinico WHERE id = $1`, [id])).rows[0];
    if (!rc || !TIPOS_DOC.includes(rc.tipo)) throw err('Documento não encontrado.', 404);
    if (rc.status !== 'rascunho') throw err('Somente rascunhos podem ser editados; documentos assinados recebem adendo.', 409);
    const dias = rc.tipo === 'atestado' && txt(b.dias_afastamento) !== null ? Math.round(Number(b.dias_afastamento)) : null;
    await c.query(`UPDATE mednexo.documento_clinico SET titulo=$2, finalidade=$3, destinatario=$4, corpo=$5, cid_id=$6, dias_afastamento=$7 WHERE registro_id=$1`,
      [id, txt(b.titulo) || NOME_TIPO[rc.tipo], txt(b.finalidade), txt(b.destinatario), txt(b.corpo), b.cid_id ? Number(b.cid_id) : null, dias]);
    const erro = b.assinar ? await clin.tentarAssinar(c, id) : null;
    return { id, assinado: !!b.assinar && !erro, erro_assinatura: erro };
  };
  R['POST /api/receitas'] = async (s, c, q, b, ctx) => {
    const it = await clin.internacao(c, b.internacao_id);
    const itens = Array.isArray(b.itens) ? b.itens : [];
    if (!itens.length) throw err('Inclua ao menos um medicamento na receita.');
    if (itens.length > 20) throw err('Máximo de 20 itens por receita.');
    let ordem = 0; const rows = [];
    for (const i of itens) {
      ordem++; const ap = (await c.query(`SELECT ma.id, p.nome, p.lista_controle_especial FROM mednexo.medicamento_apresentacao ma JOIN mednexo.principio_ativo p ON p.id = ma.principio_ativo_id WHERE ma.id = $1`, [uuid(i.apresentacao_id, `Item ${ordem}: selecione o medicamento do catálogo.`)])).rows[0];
      if (!ap) throw err(`Item ${ordem}: medicamento não encontrado.`);
      if (ap.lista_controle_especial) throw err(`Item ${ordem}: "${ap.nome}" é de controle especial. Receitas controladas seguem o fluxo oficial externo (receituário próprio/sistema oficial com assinatura ICP-Brasil); o MEDNEXO não gera numeração própria.`);
      const qt = Number(String(i.quantidade).replace(',', '.')); if (!Number.isFinite(qt) || qt <= 0) throw err(`Item ${ordem}: quantidade inválida.`);
      rows.push([ordem, ap.id, need(i.posologia, `Item ${ordem}: posologia obrigatória.`), need(i.via, `Item ${ordem}: via obrigatória.`), qt, need(i.unidade_quantidade, `Item ${ordem}: unidade da quantidade obrigatória.`), txt(i.observacoes)]);
    }
    const r = (await c.query(`INSERT INTO mednexo.registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES ($1,$2,$3,$4,'receita',$5) RETURNING id`, [ctx.org, it.paciente_id, it.hospital_id, it.id, ctx.uid])).rows[0];
    await c.query(`INSERT INTO mednexo.receita (registro_id, tipo, validade_ate, observacoes) VALUES ($1,'simples',$2,$3)`, [r.id, txt(b.validade_ate), txt(b.observacoes)]);
    for (const x of rows) await c.query(`INSERT INTO mednexo.receita_item (registro_id, ordem, apresentacao_id, posologia, via, quantidade, unidade_quantidade, observacoes) VALUES ($1,$2,$3,$4,$5::mednexo.via_administracao,$6,$7,$8)`, [r.id, ...x]);
    const erro = b.assinar ? await clin.tentarAssinar(c, r.id) : null;
    return { id: r.id, assinado: !!b.assinar && !erro, erro_assinatura: erro };
  };
  R['GET /api/documentos'] = async (s, c, q) => (await c.query(`SELECT rc.id, rc.tipo, rc.status, rc.ocorrido_em, u.nome_completo AS autor, d.titulo,
      (SELECT count(*)::int FROM mednexo.pdf_gerado p WHERE p.registro_id = rc.id) AS pdfs
    FROM mednexo.registro_clinico rc JOIN mednexo.usuario u ON u.id = rc.autor_usuario_id LEFT JOIN mednexo.documento_clinico d ON d.registro_id = rc.id
    WHERE rc.internacao_id = $1 AND rc.tipo IN ('parecer','relatorio','atestado','declaracao','encaminhamento','solicitacao_exames','receita','resumo_alta') ORDER BY rc.ocorrido_em DESC`, [uuid(q.internacao_id)])).rows;

  // ---------- montagem do PDF ----------
  async function contexto(c, regOuInt) {
    const cab = (await c.query(`SELECT i.id AS internacao_id, i.codigo AS int_codigo, i.data_admissao, i.paciente_id, p.codigo AS pac_codigo, p.nome_completo, p.nome_social, p.data_nascimento, p.cpf,
        h.nome_fantasia, h.razao_social, h.cnpj, h.cnes, h.cabecalho_documento, h.logradouro, h.numero, h.bairro, h.cidade, h.uf, h.telefone
      FROM mednexo.internacao i JOIN mednexo.paciente p ON p.id = i.paciente_id JOIN mednexo.hospital h ON h.id = i.hospital_id WHERE i.id = $1`, [regOuInt])).rows[0];
    if (!cab) throw err('Internação não encontrada ou sem permissão.', 404); return cab;
  }
  async function profissional(c, usuarioId) {
    const r = (await c.query(`SELECT u.nome_completo, pr.conselho, pr.numero_registro, pr.uf, pr.especialidade, pr.rqe FROM mednexo.usuario u LEFT JOIN mednexo.profissional pr ON pr.usuario_id = u.id WHERE u.id = $1`, [usuarioId])).rows[0];
    return r || { nome_completo: '—' };
  }
  const cabecalho = h => {
    const l = [{ t: h.nome_fantasia, bold: true, size: 13 }];
    if (h.razao_social && h.razao_social !== h.nome_fantasia) l.push({ t: h.razao_social, size: 9 });
    const doc = [h.cnpj ? 'CNPJ ' + cnpjF(h.cnpj) : '', h.cnes ? 'CNES ' + h.cnes : ''].filter(Boolean).join(' · '); if (doc) l.push({ t: doc, size: 9, gray: 0.3 });
    const end = [[h.logradouro, h.numero].filter(Boolean).join(', '), h.bairro, [h.cidade, h.uf].filter(Boolean).join('/'), h.telefone].filter(Boolean).join(' — '); if (end) l.push({ t: end, size: 9, gray: 0.3 });
    if (h.cabecalho_documento) l.push({ t: h.cabecalho_documento, size: 9, gray: 0.3 });
    return l;
  };
  const identPac = (h, extra = []) => [['Paciente', h.nome_completo + (h.nome_social ? ` (${h.nome_social})` : '')], ['Código', `${h.pac_codigo} · internação ${h.int_codigo}`],
    ['Nascimento', DD(h.data_nascimento) + (idade(h.data_nascimento) ? ' · ' + idade(h.data_nascimento) : '')], ...extra];
  const sigBlock = (pr, r, codigo) => {
    const reg = pr.numero_registro ? `${pr.conselho}-${pr.uf} ${pr.numero_registro}` + (pr.especialidade ? ' · ' + pr.especialidade : '') : 'registro profissional não informado';
    const extra = r.status === 'assinado' ? [`Assinado eletronicamente (assinatura simples) em ${D(r.assinado_em)}.`, `Integridade (SHA-256): ${(r.hash || '').slice(0, 32)}…`] : ['Documento NÃO assinado — rascunho sem validade.'];
    if (codigo) extra.push(`Código de validação: ${codigo}`);
    return { t: 'sig', nome: pr.nome_completo, linha2: reg, extra };
  };
  async function montar(c, r, codigo) {
    const h = await contexto(c, r.internacao_id), pr = await profissional(c, r.autor_usuario_id), blocos = [], ident = identPac(h);
    let titulo = NOME_TIPO[r.tipo] || r.tipo;
    if (r.tipo === 'evolucao') {
      const e = (await c.query('SELECT * FROM mednexo.evolucao WHERE registro_id = $1', [r.id])).rows[0] || {};
      ident.push(['Data/hora', D(r.ocorrido_em)], ['Tipo', String(e.motivo || '').replace('_', '-')]);
      for (const [k, n] of [['subjetivo', 'Relato subjetivo'], ['objetivo', 'Exame objetivo'], ['estado_mental', 'Estado mental'], ['sono', 'Sono'], ['apetite', 'Apetite'], ['comportamento', 'Comportamento'], ['adesao', 'Adesão ao tratamento'], ['efeitos_adversos', 'Efeitos adversos'], ['impressao_diagnostica', 'Impressão diagnóstica'], ['conduta', 'Conduta'], ['texto_livre', 'Observações']])
        if (e[k]) blocos.push({ t: 'h', v: n }, { t: 'p', v: e[k] });
    } else if (r.tipo === 'prescricao') {
      const p = (await c.query('SELECT tipo, valida_de, valida_ate, dieta_cuidados, observacoes_gerais FROM mednexo.prescricao WHERE registro_id = $1', [r.id])).rows[0] || {};
      const itens = await clin.itensPresc(c, r.id);
      ident.push(['Data/hora', D(r.ocorrido_em)], ['Tipo / validade', `${p.tipo || ''} · até ${D(p.valida_ate)}`]);
      blocos.push({ t: 'h', v: 'Itens prescritos' });
      for (const i of itens) {
        const nome = `${i.principio}${i.nome_comercial ? ' (' + i.nome_comercial + ')' : ''}${i.concentracao_valor ? ' ' + Number(i.concentracao_valor) + ' ' + (i.concentracao_unidade || '') : ''} — ${i.forma_farmaceutica}`;
        blocos.push({ t: 'p', v: `${i.ordem}. ${nome}`, size: 10.5 });
        const hor = i.horarios ? ` · horários: ${String(i.horarios).replace(/[{}]/g, '').replace(/:00(?=,|$)/g, '').replace(/,/g, ', ')}` : '';
        blocos.push({ t: 'li', v: `${Number(i.dose_valor)} ${i.dose_unidade} · via ${i.via} · ${FREQ(i)}${hor}` });
        if (i.duracao_dias) blocos.push({ t: 'li', v: `Duração: ${i.duracao_dias} dia(s)` });
        if (i.indicacao_clinica) blocos.push({ t: 'li', v: `Indicação: ${i.indicacao_clinica}` });
        if (i.orientacoes) blocos.push({ t: 'li', v: `Orientações: ${i.orientacoes}` });
        if (i.acao && i.acao !== 'iniciar') blocos.push({ t: 'li', v: `Ação: ${i.acao}${i.motivo_alteracao ? ' — ' + i.motivo_alteracao : ''}` });
      }
      if (p.dieta_cuidados) blocos.push({ t: 'h', v: 'Dieta e cuidados' }, { t: 'p', v: p.dieta_cuidados });
      if (p.observacoes_gerais) blocos.push({ t: 'h', v: 'Observações gerais' }, { t: 'p', v: p.observacoes_gerais });
      const al = (await c.query('SELECT gravidade, mensagem, justificativa_medica FROM mednexo.alerta_prescricao WHERE registro_id = $1 ORDER BY gravidade DESC', [r.id])).rows;
      if (al.length) { blocos.push({ t: 'h', v: 'Alertas do sistema' }); for (const a of al) blocos.push({ t: 'li', v: `[${a.gravidade}] ${a.mensagem}${a.justificativa_medica ? ' — Justificativa médica: ' + a.justificativa_medica : ''}` }); }
    } else if (r.tipo === 'receita') {
      const rc = (await c.query('SELECT tipo, validade_ate, observacoes FROM mednexo.receita WHERE registro_id = $1', [r.id])).rows[0] || {};
      ident.push(['Data', D(r.ocorrido_em, false)], ['Validade', rc.validade_ate ? DD(rc.validade_ate) : '—']);
      const it = (await c.query(`SELECT i.*, p.nome, ma.nome_comercial, ma.concentracao_valor, ma.concentracao_unidade, ma.forma_farmaceutica FROM mednexo.receita_item i JOIN mednexo.medicamento_apresentacao ma ON ma.id = i.apresentacao_id JOIN mednexo.principio_ativo p ON p.id = ma.principio_ativo_id WHERE i.registro_id = $1 ORDER BY i.ordem`, [r.id])).rows;
      for (const i of it) {
        blocos.push({ t: 'p', v: `${i.ordem}. ${i.nome}${i.concentracao_valor ? ' ' + Number(i.concentracao_valor) + ' ' + (i.concentracao_unidade || '') : ''} — ${i.forma_farmaceutica}  ·  ${Number(i.quantidade)} ${i.unidade_quantidade}`, size: 11 });
        blocos.push({ t: 'li', v: `Uso ${i.via}: ${i.posologia}` }); if (i.observacoes) blocos.push({ t: 'li', v: i.observacoes });
      }
      if (rc.observacoes) blocos.push({ t: 'h', v: 'Observações' }, { t: 'p', v: rc.observacoes });
      blocos.push({ t: 'p', v: 'Receita simples. Medicamentos de controle especial exigem receituário oficial.', size: 8, gray: 0.4 });
    } else if (TIPOS_DOC.includes(r.tipo)) {
      const d = (await c.query(`SELECT d.*, cid.codigo AS cid_codigo, cid.descricao AS cid_desc FROM mednexo.documento_clinico d LEFT JOIN mednexo.cid ON cid.id = d.cid_id WHERE d.registro_id = $1`, [r.id])).rows[0] || {};
      titulo = d.titulo || titulo; ident.push(['Data', D(r.ocorrido_em)]);
      if (d.destinatario) ident.push(['Destinatário', d.destinatario]); if (d.finalidade) ident.push(['Finalidade', d.finalidade]);
      blocos.push({ t: 'sp', h: 6 }, { t: 'p', v: d.corpo || '', size: 11 });
      if (r.tipo === 'atestado') { blocos.push({ t: 'p', v: d.dias_afastamento > 0 ? `Afastamento recomendado: ${d.dias_afastamento} dia(s).` : 'Sem necessidade de afastamento.', size: 11 }); if (d.cid_codigo) blocos.push({ t: 'p', v: `CID-10: ${d.cid_codigo} — ${d.cid_desc} (informado com ciência do paciente).` }); }
    } else if (r.tipo === 'resumo_alta') {
      const a = (await c.query('SELECT * FROM mednexo.resumo_alta WHERE registro_id = $1', [r.id])).rows[0] || {};
      for (const [k, n] of [['resumo_internacao', 'Resumo da internação'], ['condicao_clinica_alta', 'Condição clínica na alta'], ['tratamento_realizado', 'Tratamento realizado'], ['orientacoes_paciente', 'Orientações ao paciente'], ['orientacoes_familia', 'Orientações à família'], ['encaminhamentos', 'Encaminhamentos'], ['recomendacao_retorno', 'Retorno']]) if (a[k]) blocos.push({ t: 'h', v: n }, { t: 'p', v: a[k] });
    } else throw err('Este tipo de registro não possui modelo de PDF.');
    const ad = (await c.query('SELECT tipo, justificativa, conteudo, criado_em FROM mednexo.registro_adendo WHERE registro_id = $1 ORDER BY criado_em', [r.id])).rows;
    if (ad.length) { blocos.push({ t: 'h', v: 'Adendos' }); for (const a of ad) blocos.push({ t: 'li', v: `${D(a.criado_em)} — ${a.justificativa}: ${typeof a.conteudo === 'string' ? a.conteudo : JSON.stringify(a.conteudo)}` }); }
    blocos.push(sigBlock(pr, r, codigo));
    const marca = r.status === 'anulado' ? 'ANULADO' : r.status !== 'assinado' ? 'RASCUNHO' : null;
    return { h, doc: { titulo, cabecalho: cabecalho(h), ident, blocos, marca, rodape: `MEDNEXO · ${h.nome_fantasia} · ${h.pac_codigo}${codigo ? ' · ' + codigo : ''}` }, titulo };
  }
  const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'documento';
  const novoCodigo = () => { const h = crypto.randomBytes(6).toString('hex').toUpperCase(); return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`; };

  async function registro(c, id) {
    const r = (await c.query(`SELECT rc.id, rc.tipo, rc.status, rc.ocorrido_em, rc.assinado_em, rc.internacao_id, rc.paciente_id, rc.autor_usuario_id, encode(rc.hash_conteudo,'hex') AS hash FROM mednexo.registro_clinico rc WHERE rc.id = $1`, [uuid(id)])).rows[0];
    if (!r) throw err('Registro não encontrado ou sem permissão.', 404); return r;
  }
  // devolve {buf, nome, pdf_id?, arquivo_id?, codigo?, rascunho}
  async function gerar(c, ctx, r) {
    if (r.status === 'assinado') {
      const ult = (await c.query(`SELECT p.id, p.arquivo_id, p.codigo_validacao, p.gerado_em FROM mednexo.pdf_gerado p WHERE p.registro_id = $1 ORDER BY p.gerado_em DESC LIMIT 1`, [r.id])).rows[0];
      const ad = (await c.query('SELECT max(criado_em) AS m FROM mednexo.registro_adendo WHERE registro_id = $1', [r.id])).rows[0].m;
      if (ult && !(ad && new Date(ad) > new Date(ult.gerado_em))) {
        const k = (await c.query('SELECT encode(conteudo,\'base64\') AS b FROM mednexo.arquivo_conteudo WHERE arquivo_id = $1', [ult.arquivo_id])).rows[0];
        if (k) return { buf: Buffer.from(k.b, 'base64'), nome: `${slug(NOME_TIPO[r.tipo] || r.tipo)}_${ult.codigo_validacao}.pdf`, pdf_id: ult.id, arquivo_id: ult.arquivo_id, codigo: ult.codigo_validacao };
      }
    }
    if (!EXPORT[r.tipo] && !TIPOS_DOC.includes(r.tipo)) throw err('Este tipo de registro não possui PDF.');
    const codigo = r.status === 'assinado' ? novoCodigo() : null;
    const m = await montar(c, r, codigo); const buf = build(m.doc);
    const nome = `${slug(m.titulo)}_${codigo || 'rascunho'}.pdf`;
    if (r.status !== 'assinado') { await c.query(`SELECT mednexo.auditar_acesso('exportacao','registro_clinico',$1,$2::uuid,$3::uuid,'{"formato":"pdf","rascunho":true}'::jsonb)`, [r.id, r.paciente_id, r.internacao_id]); return { buf, nome, rascunho: true }; }
    const a = await clin.salvarArquivo(c, ctx, { id: r.internacao_id, paciente_id: r.paciente_id }, 'pdf_gerado', { nome, mime: 'application/pdf', base64: buf.toString('base64') });
    const tipoExp = EXPORT[r.tipo] || 'outro';
    const p = (await c.query(`INSERT INTO mednexo.pdf_gerado (organizacao_id, paciente_id, internacao_id, registro_id, tipo_exportacao, arquivo_id, codigo_validacao, versao_modelo, parametros, gerado_por)
      VALUES ($1,$2,$3,$4,$5::mednexo.tipo_exportacao,$6,$7,$8,$9::jsonb,$10) RETURNING id`, [ctx.org, r.paciente_id, r.internacao_id, r.id, tipoExp, a.id, codigo, MODELO, JSON.stringify({ hash_registro: r.hash }), ctx.uid])).rows[0];
    await c.query(`SELECT mednexo.auditar_acesso('exportacao','pdf_gerado',$1,$2::uuid,$3::uuid,$4::jsonb)`, [p.id, r.paciente_id, r.internacao_id, JSON.stringify({ registro_id: r.id, codigo })]);
    return { buf, nome, pdf_id: p.id, arquivo_id: a.id, codigo };
  }
  R['GET /api/pdf'] = async (s, c, q, b, ctx) => { const g = await gerar(c, ctx, await registro(c, q.registro_id)); return { __raw: { mime: 'application/pdf', nome: g.nome, buf: g.buf } }; };

  // PDF de evoluções assinadas de um período (uma internação)
  R['GET /api/pdf/evolucoes'] = async (s, c, q, b, ctx) => {
    const h = await contexto(c, uuid(q.internacao_id)); const ini = q.inicio ? new Date(q.inicio) : null, fim = q.fim ? new Date(q.fim + 'T23:59:59-03:00') : null;
    if ((ini && isNaN(ini)) || (fim && isNaN(fim))) throw err('Período inválido.');
    const ev = (await c.query(`SELECT rc.id, rc.ocorrido_em, rc.autor_usuario_id, encode(rc.hash_conteudo,'hex') AS hash, e.* FROM mednexo.registro_clinico rc JOIN mednexo.evolucao e ON e.registro_id = rc.id
      WHERE rc.internacao_id = $1 AND rc.tipo = 'evolucao' AND rc.status = 'assinado' AND ($2::timestamptz IS NULL OR rc.ocorrido_em >= $2) AND ($3::timestamptz IS NULL OR rc.ocorrido_em <= $3) ORDER BY rc.ocorrido_em`, [h.internacao_id, ini && ini.toISOString(), fim && fim.toISOString()])).rows;
    if (!ev.length) throw err('Nenhuma evolução assinada no período.', 404);
    const blocos = [];
    for (const e of ev) {
      const pr = await profissional(c, e.autor_usuario_id);
      blocos.push({ t: 'h', v: `${D(e.ocorrido_em)} — ${String(e.motivo).replace('_', '-')} — ${pr.nome_completo}${pr.numero_registro ? ' (' + pr.conselho + '-' + pr.uf + ' ' + pr.numero_registro + ')' : ''}` });
      for (const [k, n] of [['subjetivo', 'Subjetivo'], ['objetivo', 'Objetivo'], ['estado_mental', 'Estado mental'], ['sono', 'Sono'], ['apetite', 'Apetite'], ['comportamento', 'Comportamento'], ['adesao', 'Adesão'], ['efeitos_adversos', 'Efeitos adversos'], ['impressao_diagnostica', 'Impressão'], ['conduta', 'Conduta'], ['texto_livre', 'Obs.']]) if (e[k]) blocos.push({ t: 'p', v: `${n}: ${e[k]}` });
      blocos.push({ t: 'p', v: `Assinada eletronicamente · SHA-256 ${e.hash.slice(0, 16)}…`, size: 7.5, gray: 0.4 });
    }
    const codigo = novoCodigo(), pr0 = await profissional(c, ctx.uid);
    const doc = { titulo: 'Evoluções médicas — ' + (ini ? D(ini, false) : 'início') + ' a ' + (fim ? D(fim, false) : 'hoje'), cabecalho: cabecalho(h), ident: identPac(h, [['Registros', String(ev.length)], ['Emitido por', pr0.nome_completo + ' em ' + D(new Date())]]), blocos: [...blocos, { t: 'p', v: `Código de validação: ${codigo}`, size: 8, gray: 0.4 }], rodape: `MEDNEXO · ${h.nome_fantasia} · ${h.pac_codigo} · ${codigo}` };
    const buf = build(doc), nome = `Evolucoes_${h.pac_codigo}_${codigo}.pdf`;
    const a = await clin.salvarArquivo(c, ctx, { id: h.internacao_id, paciente_id: h.paciente_id }, 'pdf_gerado', { nome, mime: 'application/pdf', base64: buf.toString('base64') });
    const p = (await c.query(`INSERT INTO mednexo.pdf_gerado (organizacao_id, paciente_id, internacao_id, tipo_exportacao, periodo_inicio, periodo_fim, arquivo_id, codigo_validacao, versao_modelo, parametros, gerado_por)
      VALUES ($1,$2,$3,'evolucoes_periodo',$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`, [ctx.org, h.paciente_id, h.internacao_id, ini && ini.toISOString(), fim && fim.toISOString(), a.id, codigo, MODELO, JSON.stringify({ registros: ev.map(e => e.id) }), ctx.uid])).rows[0];
    await c.query(`SELECT mednexo.auditar_acesso('exportacao','pdf_gerado',$1,$2::uuid,$3::uuid,$4::jsonb)`, [p.id, h.paciente_id, h.internacao_id, JSON.stringify({ codigo, n: ev.length })]);
    return { __raw: { mime: 'application/pdf', nome, buf } };
  };

  // ---------- compartilhamento: registra a intenção e devolve o PDF para o aparelho entregar ----------
  R['POST /api/compartilhamentos'] = async (s, c, q, b, ctx) => {
    const r = await registro(c, b.registro_id);
    if (r.status !== 'assinado') throw err('Só documentos assinados podem ser compartilhados. Assine primeiro (rascunho pode ser apenas visualizado/impresso).', 409);
    const canal = ['whatsapp', 'impressao', 'download', 'email', 'outro'].includes(b.canal) ? b.canal : null; if (!canal) throw err('Canal inválido.');
    const dt = ['paciente', 'responsavel_legal', 'familiar', 'outro_profissional', 'instituicao', 'proprio_medico', 'outro'].includes(b.destinatario_tipo) ? b.destinatario_tipo : null;
    if (!dt) throw err('Informe quem é o destinatário.');
    const fin = need(b.finalidade, 'Informe a finalidade do compartilhamento (mín. 5 caracteres).'); if (fin.trim().length < 5) throw err('Finalidade muito curta (mín. 5 caracteres).');
    if (['whatsapp', 'email'].includes(canal) && b.conferiu_destinatario !== true) throw err('Confirme que conferiu o número/endereço do destinatário antes de enviar.');
    const g = await gerar(c, ctx, r);
    const ds = need(b.destinatario_descricao, 'Descreva o destinatário (nome/relação).').slice(0, 200);
    const x = (await c.query(`INSERT INTO mednexo.compartilhamento_documento (organizacao_id, pdf_id, usuario_id, canal, destinatario_tipo, destinatario_descricao, finalidade, conferiu_destinatario)
      VALUES ($1,$2,$3,$4::mednexo.canal_compartilhamento,$5::mednexo.destinatario_tipo,$6,$7,$8) RETURNING id`, [ctx.org, g.pdf_id, ctx.uid, canal, dt, ds, fin.trim(), b.conferiu_destinatario === true])).rows[0];
    await c.query(`SELECT mednexo.auditar_acesso('compartilhamento','pdf_gerado',$1,$2::uuid,$3::uuid,$4::jsonb)`, [g.pdf_id, r.paciente_id, r.internacao_id, JSON.stringify({ canal, destinatario_tipo: dt })]);
    return { id: x.id, pdf_id: g.pdf_id, arquivo_id: g.arquivo_id, codigo: g.codigo, nome: g.nome };
  };
  R['GET /api/compartilhamentos'] = async (s, c, q) => (await c.query(`SELECT x.id, x.canal, x.destinatario_tipo, x.destinatario_descricao, x.finalidade, x.compartilhado_em, p.codigo_validacao
    FROM mednexo.compartilhamento_documento x JOIN mednexo.pdf_gerado p ON p.id = x.pdf_id WHERE p.registro_id = $1 ORDER BY x.compartilhado_em DESC`, [uuid(q.registro_id)])).rows;

  // verificação de autenticidade: compara o arquivo guardado com o hash registrado
  R['GET /api/verificar'] = async (s, c, q) => {
    const p = (await c.query(`SELECT p.id, p.codigo_validacao, p.gerado_em, p.registro_id, p.tipo_exportacao, p.arquivo_id, encode(a.sha256,'hex') AS sha_arquivo, encode(k.conteudo,'hex') AS conteudo FROM mednexo.pdf_gerado p JOIN mednexo.arquivo a ON a.id = p.arquivo_id JOIN mednexo.arquivo_conteudo k ON k.arquivo_id = a.id WHERE p.codigo_validacao = $1`, [String(q.codigo || '').toUpperCase().trim()])).rows[0];
    if (!p) throw err('Código não encontrado nesta organização.', 404);
    const sha = crypto.createHash('sha256').update(Buffer.from(p.conteudo, 'hex')).digest('hex');
    const integro_reg = p.registro_id ? (await c.query('SELECT mednexo.verificar_integridade_registro($1) AS ok', [p.registro_id])).rows[0].ok : null;
    return { codigo: p.codigo_validacao, gerado_em: p.gerado_em, tipo: p.tipo_exportacao, arquivo_integro: sha === p.sha_arquivo, registro_integro: integro_reg };
  };
  return { routes: R };
};
