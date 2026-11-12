'use strict';
// Peso/altura do paciente e resumo clínico sem identificação (para análise manual). NENHUMA integração com API de IA externa.
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
module.exports = function (pool, { need, uuid }, clin) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const txt = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
  const R = {};
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

  // Resumo clínico SEM identificação direta, para o médico copiar e levar a uma análise manual (fora do sistema).
  R['GET /api/exames/contexto'] = async (s, c, q) => {
    const it = await clin.internacao(c, q.internacao_id);
    const ctxp = await contextoPaciente(c, { paciente_id: it.paciente_id, internacao_id: it.id, id: '00000000-0000-0000-0000-000000000000' });
    return { texto: ctxp.texto };
  };
  return { routes: R, migrar: () => pool.raw(MIGRACAO) };
};
