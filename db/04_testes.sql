-- =====================================================================
-- MEDNEXO — 04_testes.sql : critérios de aceite do banco (ARQUITETURA §12)
-- Rodar em banco DESCARTÁVEL: cria dados de teste (inclusive catálogos FICTÍCIOS de
-- medicamento/interação/dose, com fonte "TESTE", que NÃO são conteúdo clínico).
-- Resultado: linhas "PASS/FAIL"; termina com erro se houver qualquer FAIL.
-- =====================================================================
SET search_path = mednexo, public;
CREATE SCHEMA IF NOT EXISTS teste;
CREATE TABLE IF NOT EXISTS teste.resultado (n serial, ok boolean, msg text);
GRANT USAGE ON SCHEMA teste TO PUBLIC;
GRANT ALL ON teste.resultado TO PUBLIC;
GRANT USAGE ON SEQUENCE teste.resultado_n_seq TO PUBLIC;

CREATE OR REPLACE FUNCTION teste.afirma(c boolean, m text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO teste.resultado(ok, msg) VALUES (coalesce(c, false), m);
  RAISE NOTICE '% %', CASE WHEN coalesce(c,false) THEN 'PASS' ELSE 'FAIL' END, m;
END $$;

CREATE OR REPLACE FUNCTION teste.erra(p_sql text, p_trecho text, m text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  PERFORM teste.afirma(false, m || ' — esperava erro "' || p_trecho || '" mas executou');
EXCEPTION WHEN OTHERS THEN
  PERFORM teste.afirma((SQLERRM ~* p_trecho AND SQLERRM !~* 'malformed|syntax|does not exist'), m || ' [' || left(SQLERRM, 110) || ']');
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA teste TO PUBLIC;

DO $$
DECLARE
  orgA uuid := gen_random_uuid(); orgB uuid := gen_random_uuid();
  uA uuid := gen_random_uuid(); uB uuid := gen_random_uuid(); uC uuid := gen_random_uuid();
  uE uuid := gen_random_uuid(); uAdm uuid := gen_random_uuid(); uAud uuid := gen_random_uuid();
  uPl uuid := gen_random_uuid(); uX uuid := gen_random_uuid();
  pA uuid; pB uuid; pC uuid; mA uuid; mB uuid; mC uuid; mE uuid; mAdm uuid; mAud uuid; mPl uuid; mX uuid;
  H1 uuid; H2 uuid; H3 uuid; HX uuid; UI1 uuid; UI2 uuid; L101 uuid; L102 uuid; L201 uuid;
  cid1 int; cid2 int; paHal uuid; paOla uuid; paDia uuid; apHal uuid; apOla uuid; apDia uuid;
  P1 uuid; P2 uuid; I1 uuid; I2 uuid; I3 uuid; r uuid; r2 uuid; r3 uuid; rr uuid; d1 uuid;
  n int; b boolean; h bytea; v_msg text; v_seq bigint; rp uuid; pdf uuid; arq uuid; it1 uuid;
  falhas int;
BEGIN
  -- ============ SETUP (superusuário, sem RLS) ============
  PERFORM set_config('app.usuario_id', uA::text, true);
  PERFORM set_config('app.organizacao_id', orgA::text, true);
  INSERT INTO organizacao (id, nome) VALUES (orgA, 'Clínica A (teste)'), (orgB, 'Clínica B (teste)');
  INSERT INTO usuario (id, email, nome_completo) VALUES
    (uA,'dra@teste','Dra. A'),(uB,'drb@teste','Dr. B'),(uC,'cons@teste','Dr. Consultor'),(uE,'enf@teste','Enfermeira'),
    (uAdm,'adm@teste','Administrativo'),(uAud,'aud@teste','Auditor'),(uPl,'pl@teste','Plataforma'),(uX,'x@teste','Dr. X (outra org)');
  INSERT INTO profissional (usuario_id, numero_registro, uf) VALUES (uA,'1001','RJ'),(uB,'1002','RJ'),(uC,'1003','RJ'),(uX,'9001','SP');
  INSERT INTO organizacao_membro (organizacao_id, usuario_id, papel) VALUES
    (orgA,uA,'medico_administrador'),(orgA,uB,'medico_assistente'),(orgA,uC,'medico_consultor'),(orgA,uE,'enfermagem'),
    (orgA,uAdm,'administrativo'),(orgA,uAud,'auditor'),(orgA,uPl,'admin_plataforma'),(orgB,uX,'medico_administrador');
  SELECT id INTO mA FROM organizacao_membro WHERE usuario_id = uA;   SELECT id INTO mB FROM organizacao_membro WHERE usuario_id = uB;
  SELECT id INTO mC FROM organizacao_membro WHERE usuario_id = uC;   SELECT id INTO mE FROM organizacao_membro WHERE usuario_id = uE;
  SELECT id INTO mAdm FROM organizacao_membro WHERE usuario_id = uAdm; SELECT id INTO mAud FROM organizacao_membro WHERE usuario_id = uAud;
  SELECT id INTO mX FROM organizacao_membro WHERE usuario_id = uX;
  PERFORM semear_regras_pendencia(orgA);
  -- catálogos FICTÍCIOS de teste
  INSERT INTO cid (versao, codigo, descricao) VALUES ('CID-10','F20.0','TESTE esquizofrenia'),('CID-10','F32.1','TESTE depressivo') ;
  SELECT id INTO cid1 FROM cid WHERE codigo='F20.0'; SELECT id INTO cid2 FROM cid WHERE codigo='F32.1';
  INSERT INTO principio_ativo (nome, classe_terapeutica) VALUES ('haloperidol-T','antipsicótico'),('olanzapina-T','antipsicótico'),('diazepam-T','benzodiazepínico');
  SELECT id INTO paHal FROM principio_ativo WHERE nome='haloperidol-T'; SELECT id INTO paOla FROM principio_ativo WHERE nome='olanzapina-T';
  SELECT id INTO paDia FROM principio_ativo WHERE nome='diazepam-T';
  INSERT INTO medicamento_apresentacao (principio_ativo_id, concentracao_valor, concentracao_unidade, forma_farmaceutica, vias_permitidas)
    VALUES (paHal, 5, 'mg', 'comprimido', ARRAY['oral']::via_administracao[]) RETURNING id INTO apHal;
  INSERT INTO medicamento_apresentacao (principio_ativo_id, concentracao_valor, concentracao_unidade, forma_farmaceutica, vias_permitidas)
    VALUES (paOla, 10, 'mg', 'comprimido', ARRAY['oral']::via_administracao[]) RETURNING id INTO apOla;
  INSERT INTO medicamento_apresentacao (principio_ativo_id, concentracao_valor, concentracao_unidade, forma_farmaceutica, vias_permitidas)
    VALUES (paDia, 10, 'mg', 'comprimido', ARRAY['oral']::via_administracao[]) RETURNING id INTO apDia;
  INSERT INTO faixa_dose_referencia (principio_ativo_id, via, unidade, dose_unica_max, dose_diaria_max, fonte, revisado_em, revisado_por)
    VALUES (paHal, 'oral', 'mg', 10, 20, 'TESTE (valor fictício)', current_date, 'teste');
  INSERT INTO interacao_medicamentosa (principio_a_id, principio_b_id, gravidade, descricao, fonte, revisado_em)
    VALUES (least(paOla, paDia), greatest(paOla, paDia), 'grave', 'interação FICTÍCIA de teste', 'TESTE', current_date);

  PERFORM teste.afirma(cnpj_valido('11222333000181') AND NOT cnpj_valido('11222333000182'), 'cnpj_valido aceita válido e rejeita inválido');
  PERFORM teste.afirma(cpf_valido('52998224725') AND NOT cpf_valido('12345678900') AND NOT cpf_valido('11111111111'), 'cpf_valido');

  -- ============ A PARTIR DAQUI: papel da aplicação (RLS ativa) ============
  EXECUTE 'SET LOCAL ROLE mednexo_app';

  -- ---- 1. três hospitais, vínculos, unidades e leitos (como Dra. A, médica administradora)
  PERFORM set_config('app.usuario_id', uA::text, true);
  INSERT INTO hospital (organizacao_id, nome_fantasia, cnpj) VALUES (orgA, 'Hospital 1', '11222333000181') RETURNING id INTO H1;
  INSERT INTO hospital (organizacao_id, nome_fantasia) VALUES (orgA, 'Hospital 2') RETURNING id INTO H2;
  INSERT INTO hospital (organizacao_id, nome_fantasia) VALUES (orgA, 'Hospital 3') RETURNING id INTO H3;
  PERFORM teste.afirma((SELECT count(*) FROM hospital) = 3, '1. cadastra 3 hospitais');
  PERFORM teste.erra($q$INSERT INTO hospital (organizacao_id, nome_fantasia, cnpj) VALUES (current_setting('app.organizacao_id')::uuid,'dup','11222333000181')$q$,
      'ux_hospital_cnpj', '1b. CNPJ duplicado na organização é rejeitado');
  PERFORM teste.erra($q$INSERT INTO hospital (organizacao_id, nome_fantasia, cnpj) VALUES (current_setting('app.organizacao_id')::uuid,'x','11222333000182')$q$,
      'check', '1c. CNPJ inválido é rejeitado');
  INSERT INTO membro_hospital (organizacao_id, membro_id, hospital_id) VALUES
    (orgA,mA,H1),(orgA,mA,H2),(orgA,mA,H3),(orgA,mB,H1),(orgA,mC,H1),(orgA,mE,H1),(orgA,mAdm,H1),(orgA,mAdm,H2),(orgA,mAud,H1),(orgA,mAud,H2);
  INSERT INTO unidade_internacao (organizacao_id, hospital_id, nome) VALUES (orgA,H1,'UI-1') RETURNING id INTO UI1;
  INSERT INTO unidade_internacao (organizacao_id, hospital_id, nome) VALUES (orgA,H2,'UI-A') RETURNING id INTO UI2;
  INSERT INTO leito (organizacao_id, hospital_id, unidade_id, identificacao) VALUES (orgA,H1,UI1,'101') RETURNING id INTO L101;
  INSERT INTO leito (organizacao_id, hospital_id, unidade_id, identificacao) VALUES (orgA,H1,UI1,'102') RETURNING id INTO L102;
  INSERT INTO leito (organizacao_id, hospital_id, unidade_id, identificacao) VALUES (orgA,H2,UI2,'01') RETURNING id INTO L201;
  PERFORM teste.erra(format($q$INSERT INTO leito (organizacao_id, hospital_id, unidade_id, identificacao) VALUES (%L,%L,%L,'101')$q$, orgA, H1, UI2),
      'foreign key', '1d. leito não pode apontar para unidade de outro hospital (FK composta)');

  -- ---- 2. paciente único, sem duplicar identidade
  INSERT INTO paciente (organizacao_id, nome_completo, nome_mae, cpf, data_nascimento)
    VALUES (orgA, 'João da Silva', 'Maria da Silva', '52998224725', DATE '1980-05-10') RETURNING id INTO P1;
  PERFORM teste.afirma((SELECT codigo FROM paciente WHERE id = P1) = 'PAC-000001', '2. paciente recebe código sequencial PAC-000001');
  PERFORM teste.erra(format($q$INSERT INTO paciente (organizacao_id, nome_completo, cpf, data_nascimento) VALUES (%L,'Outro Nome','52998224725',DATE '1990-01-01')$q$, orgA),
      'ux_paciente_cpf', '2b. mesmo CPF não cria segundo paciente');
  PERFORM teste.erra(format($q$INSERT INTO paciente (organizacao_id, nome_completo, nome_mae, data_nascimento) VALUES (%L,'JOAO  da  silva','maria da silva',DATE '1980-05-10')$q$, orgA),
      'ux_paciente_identidade', '2c. mesmo nome+nascimento+mãe (sem acento/caixa) não duplica');
  PERFORM teste.erra(format($q$INSERT INTO paciente (organizacao_id, nome_completo, cpf, data_nascimento) VALUES (%L,'Fulano Teste','12345678900',DATE '1990-01-01')$q$, orgA),
      'check', '2d. CPF inválido é rejeitado');
  PERFORM teste.erra(format($q$UPDATE paciente SET numero = 99 WHERE id = %L$q$, P1), 'imutáveis', '2e. número do paciente é imutável');

  -- ---- 3. internação 1 no Hospital 1; regra "um paciente, uma internação ativa"
  INSERT INTO internacao (organizacao_id, paciente_id, hospital_id, modalidade, profissional_responsavel_id, data_admissao)
    VALUES (orgA, P1, H1, 'voluntaria', (SELECT id FROM profissional WHERE usuario_id = uA), now() - interval '1 day') RETURNING id INTO I1;
  INSERT INTO internacao_clinico (internacao_id, organizacao_id, motivo_internacao) VALUES (I1, orgA, 'Motivo clínico de teste');
  PERFORM teste.afirma((SELECT codigo FROM internacao WHERE id = I1) = 'INT-000001', '3. internação recebe INT-000001');
  PERFORM teste.afirma((SELECT count(*) FROM internacao_equipe WHERE internacao_id = I1 AND funcao = 'responsavel') = 1, '3b. médico responsável entra na equipe automaticamente');
  PERFORM teste.afirma((SELECT count(*) FROM paciente_hospital WHERE paciente_id = P1 AND hospital_id = H1) = 1, '3c. vínculo paciente-hospital criado');
  PERFORM teste.erra(format($q$INSERT INTO internacao (organizacao_id, paciente_id, hospital_id, modalidade, profissional_responsavel_id, data_admissao)
      VALUES (%L,%L,%L,'voluntaria',(SELECT id FROM profissional WHERE usuario_id=%L), now())$q$, orgA, P1, H2, uA), 'já está internado', '3d. paciente não pode estar internado em dois hospitais');
  PERFORM teste.erra(format($q$INSERT INTO internacao (organizacao_id, paciente_id, hospital_id, modalidade, profissional_responsavel_id, data_admissao)
      VALUES (%L,%L,%L,'voluntaria',(SELECT id FROM profissional WHERE usuario_id=%L), now())$q$, orgA, P1, H3, uB), 'já está internado', '3e. idem (outro hospital/outro médico)');

  -- leitos: ocupação única e histórico
  INSERT INTO internacao_movimentacao (organizacao_id, internacao_id, hospital_id, leito_id, tipo, inicio)
    VALUES (orgA, I1, H1, L101, 'admissao', now() - interval '1 day');
  INSERT INTO internacao_movimentacao (organizacao_id, internacao_id, hospital_id, leito_id, tipo, inicio)
    VALUES (orgA, I1, H1, L102, 'troca_leito', now() - interval '1 hour');
  PERFORM teste.afirma((SELECT leito FROM vw_leito_atual WHERE internacao_id = I1) = '102', '3f. troca de leito fecha a ocupação anterior; leito atual = 102');
  PERFORM teste.afirma((SELECT count(*) FROM internacao_movimentacao WHERE internacao_id = I1) = 2, '3g. histórico de leitos preservado');

  -- ---- 4. evolução: rascunho → validação → assinatura → imutabilidade → adendo → anulação
  INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
    VALUES (orgA, P1, H1, I1, 'evolucao', uA) RETURNING id INTO r;
  INSERT INTO evolucao (registro_id, subjetivo) VALUES (r, 'Refere melhora do sono.');
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, r), 'pendências:.*conduta', '4. assinatura bloqueada sem conduta (lista pendências)');
  UPDATE evolucao SET conduta = 'Manter acompanhamento.' WHERE registro_id = r;
  h := assinar_registro(r);
  PERFORM teste.afirma(h IS NOT NULL AND octet_length(h) = 32, '4b. assinatura grava hash SHA-256');
  PERFORM teste.afirma(verificar_integridade_registro(r), '4c. integridade confere após assinar');
  PERFORM teste.afirma((SELECT assinado_por_usuario_id FROM registro_clinico WHERE id = r) = uA, '4d. assinante = usuário da sessão');
  PERFORM teste.erra(format($q$UPDATE evolucao SET subjetivo = 'adulterado' WHERE registro_id = %L$q$, r), 'imutável', '4e. conteúdo assinado não pode ser alterado');
  PERFORM teste.erra(format($q$DELETE FROM evolucao WHERE registro_id = %L$q$, r), 'imutável', '4f. conteúdo assinado não pode ser apagado');
  PERFORM teste.erra(format($q$UPDATE registro_clinico SET ocorrido_em = now() WHERE id = %L$q$, r), 'imutável', '4g. cabeçalho assinado não pode ser alterado');
  PERFORM teste.erra(format($q$DELETE FROM registro_clinico WHERE id = %L$q$, r), 'não pode ser excluído', '4h. registro assinado não pode ser excluído');
  PERFORM teste.erra(format($q$UPDATE registro_clinico SET status = 'rascunho' WHERE id = %L$q$, r), 'imutável', '4i. assinado não volta a rascunho');
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, r), 'não está em rascunho', '4j. não assina duas vezes');
  INSERT INTO registro_adendo (organizacao_id, registro_id, tipo, justificativa, conteudo)
    VALUES (orgA, r, 'complemento', 'Complemento por informação tardia', 'Familiar relatou piora do sono na véspera.');
  PERFORM teste.afirma((SELECT count(*) FROM registro_adendo WHERE registro_id = r) = 1, '4k. adendo registrado sem alterar o original');
  PERFORM teste.erra(format($q$UPDATE registro_adendo SET conteudo = 'x' WHERE registro_id = %L$q$, r), 'permission denied|append-only', '4l. adendo é imutável');
  PERFORM teste.afirma(verificar_integridade_registro(r), '4m. original continua íntegro após adendo');
  PERFORM teste.erra(format($q$SELECT anular_registro(%L, 'curto')$q$, r), 'motivo', '4n. anulação exige motivo');
  -- rascunho: só o autor edita; autor não pode ser forjado
  INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
    VALUES (orgA, P1, H1, I1, 'evolucao', uA) RETURNING id INTO r2;
  PERFORM teste.erra(format($q$INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES (%L,%L,%L,%L,'evolucao',%L)$q$, orgA, P1, H1, I1, uB),
      'autor do registro deve ser', '4o. não é possível criar registro em nome de outro usuário');
  PERFORM teste.erra(format($q$INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id, ocorrido_em)
      VALUES (%L,%L,%L,%L,'evolucao',%L, now() - interval '20 hours')$q$, orgA, P1, H1, I1, uA), 'check', '4p. registro retroativo exige justificativa');
  PERFORM teste.erra(format($q$INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
      VALUES (%L,%L,%L,%L,'evolucao',%L)$q$, orgA, P1, H2, I1, uA), 'foreign key', '4q. registro não pode apontar para hospital diferente da internação');
  DELETE FROM registro_clinico WHERE id = r2;   -- rascunho pode ser descartado (fica na auditoria)
  PERFORM teste.afirma(NOT EXISTS (SELECT 1 FROM registro_clinico WHERE id = r2), '4r. rascunho pode ser descartado');
  -- anulação com motivo, pelo autor
  PERFORM anular_registro(r, 'Registrado no paciente errado, conferido com a equipe.');
  PERFORM teste.afirma((SELECT status FROM registro_clinico WHERE id = r) = 'anulado', '4s. anulação justificada preserva o registro (status anulado)');
  PERFORM teste.afirma((SELECT count(*) FROM evolucao WHERE registro_id = r) = 1, '4t. conteúdo do registro anulado continua existindo');
  PERFORM teste.erra(format($q$UPDATE registro_clinico SET status='assinado' WHERE id = %L$q$, r), 'anulado', '4u. anulado é final');

  -- ---- 5. avaliação de risco (nunca classifica sozinho; tudo explícito)
  INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
    VALUES (orgA, P1, H1, I1, 'avaliacao_risco', uA) RETURNING id INTO rr;
  INSERT INTO avaliacao_risco (registro_id, avaliacao_clinica, conduta, nivel_risco_profissional, necessita_reavaliacao, reavaliar_em)
    VALUES (rr, 'Paciente colaborativo.', 'Observação a cada 2 h.', 'baixo', true, now() + interval '1 day');
  INSERT INTO avaliacao_risco_item (registro_id, dimensao, situacao) VALUES (rr, 'ideacao_suicida', 'presente'), (rr, 'intencao_suicida', 'ausente');
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, rr), '2 de 13', '5. risco incompleto (2 de 13 dimensões) não assina');
  PERFORM teste.erra(format($q$INSERT INTO avaliacao_risco_item (registro_id, dimensao, situacao) VALUES (%L,'acesso_meios','nao_avaliado')$q$, rr),
      'check', '5b. "não avaliado" exige motivo (não vira "ausente")');
  INSERT INTO avaliacao_risco_item (registro_id, dimensao, situacao, observacao)
    SELECT rr, d, 'nao_avaliado', 'paciente não permitiu avaliação neste turno'
      FROM unnest(enum_range(NULL::dimensao_risco)) d WHERE d NOT IN ('ideacao_suicida','intencao_suicida');
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, rr), 'justificativa do nível', '5c. nível "baixo" com ideação presente exige justificativa');
  UPDATE avaliacao_risco SET nivel_risco_profissional = 'alto' WHERE registro_id = rr;
  PERFORM assinar_registro(rr);
  PERFORM teste.afirma((SELECT nivel::text FROM vw_ultimo_risco WHERE internacao_id = I1) = 'alto', '5d. nível exibido é o definido pelo profissional');
  PERFORM teste.afirma((SELECT situacao FROM vw_ultimo_risco WHERE internacao_id = I1) = 'vigente', '5e. situação "vigente" (nunca "seguro")');

  -- ---- 6. exame do estado mental: 15 domínios explícitos
  INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
    VALUES (orgA, P1, H1, I1, 'exame_estado_mental', uA) RETURNING id INTO r3;
  INSERT INTO exame_estado_mental (registro_id) VALUES (r3);
  INSERT INTO eem_dominio (registro_id, dominio, avaliado) VALUES (r3, 'humor', true);
  INSERT INTO eem_item (registro_id, dominio, codigo) VALUES (r3, 'humor', 'eutimico');
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, r3), '1 de 15', '6. EEM com 1 de 15 domínios não assina');
  PERFORM teste.erra(format($q$INSERT INTO eem_item (registro_id, dominio, codigo) VALUES (%L,'humor','inexistente')$q$, r3), 'foreign key', '6b. achado fora do catálogo é rejeitado');
  INSERT INTO eem_dominio (registro_id, dominio, avaliado, observacao)
    SELECT r3, d, false, 'não avaliado nesta consulta' FROM unnest(enum_range(NULL::dominio_eem)) d WHERE d <> 'humor';
  PERFORM assinar_registro(r3);
  PERFORM teste.afirma((SELECT status FROM registro_clinico WHERE id = r3) = 'assinado', '6c. EEM completo assina');

  -- ---- 7. prescrição e alertas de segurança
  INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
    VALUES (orgA, P1, H1, I1, 'prescricao', uA) RETURNING id INTO rp;
  INSERT INTO prescricao (registro_id, valida_de, valida_ate) VALUES (rp, now(), now() + interval '1 day');
  PERFORM teste.erra(format($q$INSERT INTO prescricao_item (registro_id, ordem, apresentacao_id, dose_valor, dose_unidade, via, frequencia_tipo, data_inicio, indicacao_clinica)
      VALUES (%L,1,%L,5,'mg','oral','sos',now(),'agitação')$q$, rp, apHal), 'check', '7. item SOS sem dose máxima em 24 h é rejeitado');
  INSERT INTO prescricao_item (registro_id, ordem, apresentacao_id, dose_valor, dose_unidade, via, frequencia_tipo, vezes_dia, data_inicio, indicacao_clinica)
    VALUES (rp, 1, apHal, 15, 'mg', 'oral', 'vezes_dia', 2, now(), 'psicose') RETURNING id INTO it1;
  PERFORM avaliar_alertas_prescricao(rp);   -- a API chama isto ao salvar o rascunho: alertas ficam visíveis e justificáveis
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, rp), 'alergias_nao_avaliadas', '7b. alergias não avaliadas bloqueiam a assinatura até justificativa');
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, rp), 'dose_acima_referencia', '7c. dose acima da faixa de referência exige justificativa');
  UPDATE paciente SET alergias_status = 'sem_alergias_conhecidas' WHERE id = P1;
  PERFORM avaliar_alertas_prescricao(rp);
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, rp), 'dose_acima_referencia', '7d. após declarar alergias, o alerta de dose continua');
  PERFORM teste.afirma(NOT EXISTS (SELECT 1 FROM alerta_prescricao WHERE registro_id = rp AND tipo = 'alergias_nao_avaliadas'), '7e. alerta de alergias é recalculado e some após resolvido');
  UPDATE alerta_prescricao SET justificativa_medica = 'Dose acima da referência por resposta prévia documentada.' WHERE registro_id = rp AND tipo = 'dose_acima_referencia';
  PERFORM assinar_registro(rp);
  PERFORM teste.afirma((SELECT count(*) FROM vw_medicacao_ativa WHERE internacao_id = I1) = 1, '7f. medicação ativa deriva da prescrição vigente assinada');
  PERFORM teste.afirma(verificar_integridade_registro(rp), '7g. hash da prescrição inclui itens e justificativas');
  PERFORM teste.erra(format($q$UPDATE prescricao_item SET dose_valor = 1 WHERE id = %L$q$, it1), 'imutável', '7h. item de prescrição assinada não muda');

  -- alergia a princípio ativo → contraindicação; interação; suspensão por nova prescrição com histórico
  INSERT INTO paciente_alergia (organizacao_id, paciente_id, agente, categoria, principio_ativo_id, gravidade)
    VALUES (orgA, P1, 'haloperidol-T', 'medicamento', paHal, 'anafilaxia');
  PERFORM teste.afirma((SELECT alergias_status::text FROM paciente WHERE id = P1) = 'possui_alergias', '7i. cadastrar alergia atualiza o status do paciente');
  INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
    VALUES (orgA, P1, H1, I1, 'prescricao', uA) RETURNING id INTO r;
  INSERT INTO prescricao (registro_id, valida_de, valida_ate) VALUES (r, now(), now() + interval '1 day');
  INSERT INTO prescricao_item (registro_id, ordem, apresentacao_id, dose_valor, dose_unidade, via, frequencia_tipo, vezes_dia, data_inicio, indicacao_clinica, acao, item_anterior_id, motivo_alteracao)
    VALUES (r, 1, apHal, 5, 'mg', 'oral', 'vezes_dia', 2, now(), 'psicose', 'ajustar', it1, 'redução de dose');
  INSERT INTO prescricao_item (registro_id, ordem, apresentacao_id, dose_valor, dose_unidade, via, frequencia_tipo, vezes_dia, data_inicio, indicacao_clinica)
    VALUES (r, 2, apOla, 10, 'mg', 'oral', 'vezes_dia', 1, now(), 'psicose');
  INSERT INTO prescricao_item (registro_id, ordem, apresentacao_id, dose_valor, dose_unidade, via, frequencia_tipo, vezes_dia, data_inicio, indicacao_clinica)
    VALUES (r, 3, apDia, 10, 'mg', 'oral', 'vezes_dia', 1, now(), 'ansiedade');
  PERFORM avaliar_alertas_prescricao(r);
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, r), 'alerta alergia .contraindicada', '7j. alergia grave ao princípio ativo é contraindicação (exige justificativa)');
  PERFORM teste.erra(format($q$SELECT assinar_registro(%L)$q$, r), 'alerta interacao .grave', '7k. interação cadastrada gera alerta grave');
  PERFORM teste.erra(format($q$UPDATE alerta_prescricao SET justificativa_medica = 'curta' WHERE registro_id = %L AND tipo = 'alergia'$q$, r), 'curta', '7l. justificativa precisa ter conteúdo mínimo');
  PERFORM teste.erra(format($q$INSERT INTO prescricao_item (registro_id, ordem, apresentacao_id, dose_valor, dose_unidade, via, frequencia_tipo, data_inicio, indicacao_clinica, acao)
      VALUES (%L,4,%L,5,'mg','oral','dose_unica',now(),'x','suspender')$q$, r, apOla), 'check', '7m. suspensão exige item anterior e motivo');
  DELETE FROM registro_clinico WHERE id = r;   -- descarta o rascunho de teste

  -- ---- 8. diagnóstico com CID, situação e responsável; resumo de alta; encerramento
  INSERT INTO diagnostico (organizacao_id, paciente_id, internacao_id, hospital_id, cid_id, situacao, momento, principal)
    VALUES (orgA, P1, I1, H1, cid1, 'hipotese', 'admissao', true) RETURNING id INTO d1;
  PERFORM teste.erra(format($q$INSERT INTO diagnostico (organizacao_id, paciente_id, internacao_id, hospital_id, cid_id, situacao, principal) VALUES (%L,%L,%L,%L,%s,'confirmado',true)$q$, orgA, P1, I1, H1, cid2),
      'ux_diagnostico_principal', '8. só um diagnóstico principal ativo por internação');
  PERFORM teste.erra(format($q$UPDATE diagnostico SET cid_id = %s WHERE id = %L$q$, cid2, d1), 'encerre', '8b. trocar CID exige novo registro (histórico preservado)');
  UPDATE diagnostico SET situacao = 'confirmado' WHERE id = d1;
  PERFORM teste.afirma((SELECT registrado_por FROM diagnostico WHERE id = d1) = uA, '8c. responsável pelo diagnóstico vem da sessão');

  PERFORM teste.erra(format($q$SELECT encerrar_internacao(%L, 'alta_melhora', 'domicílio')$q$, I1), 'resumo de alta assinado', '8d. não encerra sem resumo de alta assinado');
  INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id)
    VALUES (orgA, P1, H1, I1, 'resumo_alta', uA) RETURNING id INTO r;
  INSERT INTO resumo_alta (registro_id, diagnostico_principal_id, condicao_clinica_alta, resumo_internacao, tratamento_realizado, necessita_acompanhamento_ambulatorial, destino_paciente)
    VALUES (r, d1, 'Estável', 'Resumo de teste', 'Tratamento de teste', true, 'Domicílio');
  -- rascunho aberto bloqueia encerramento
  PERFORM teste.erra(format($q$SELECT encerrar_internacao(%L, 'alta_melhora', 'domicílio')$q$, I1), 'resumo de alta assinado', '8e. rascunho de resumo não basta');
  PERFORM assinar_registro(r);
  PERFORM encerrar_internacao(I1, 'alta_melhora', 'Domicílio');
  PERFORM teste.afirma((SELECT status::text FROM internacao WHERE id = I1) = 'encerrada', '8f. internação encerrada com resumo assinado');
  PERFORM teste.afirma((SELECT count(*) FROM internacao_movimentacao WHERE internacao_id = I1 AND fim IS NULL) = 0, '8g. leito liberado no encerramento');
  PERFORM teste.afirma((SELECT count(*) FROM registro_clinico WHERE internacao_id = I1 AND status <> 'rascunho') >= 4, '8h. histórico preservado após alta (consulta continua)');
  PERFORM teste.erra(format($q$UPDATE internacao SET data_admissao = now() WHERE id = %L$q$, I1), 'imutável', '8i. internação encerrada é imutável');
  PERFORM teste.erra(format($q$INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES (%L,%L,%L,%L,'evolucao',%L)$q$, orgA, P1, H1, I1, uA),
      'encerrada', '8j. não se evolui internação encerrada');
  INSERT INTO registro_adendo (organizacao_id, registro_id, tipo, justificativa, conteudo)
    SELECT orgA, rc.id, 'esclarecimento', 'Esclarecimento posterior à alta', 'Texto do adendo pós-alta.' FROM registro_clinico rc WHERE rc.id = rr;
  PERFORM teste.afirma(true, '8k. adendo permitido em registro assinado mesmo após a alta');

  -- ---- 9. segunda internação em OUTRO hospital: mesmo paciente, prontuário separado
  INSERT INTO internacao (organizacao_id, paciente_id, hospital_id, modalidade, profissional_responsavel_id, data_admissao, comunicado_ministerio_publico_em)
    VALUES (orgA, P1, H2, 'involuntaria', (SELECT id FROM profissional WHERE usuario_id = uA), now() - interval '80 hours', NULL) RETURNING id INTO I2;
  INSERT INTO internacao_clinico (internacao_id, organizacao_id, motivo_internacao) VALUES (I2, orgA, 'Segunda internação');
  PERFORM teste.afirma((SELECT count(*) FROM paciente WHERE nome_completo ILIKE 'Jo%o da Silva') = 1, '9. continua um único cadastro de paciente');
  PERFORM teste.afirma((SELECT count(*) FROM internacao WHERE paciente_id = P1) = 2, '9b. paciente com duas internações em hospitais diferentes');
  PERFORM teste.afirma((SELECT count(*) FROM registro_clinico WHERE internacao_id = I2) = 0, '9c. a nova internação tem prontuário próprio (vazio)');
  PERFORM teste.afirma((SELECT count(*) FROM vw_linha_do_tempo WHERE paciente_id = P1) >= 6, '9d. linha do tempo longitudinal do paciente');
  PERFORM teste.afirma(EXISTS (SELECT 1 FROM vw_pendencias WHERE internacao_id = I2 AND tipo = 'evolucao'), '9e. pendência de evolução aparece');
  PERFORM teste.afirma(EXISTS (SELECT 1 FROM vw_pendencias WHERE internacao_id = I2 AND tipo = 'comunicacao_ministerio_publico'), '9f. pendência de comunicação ao MP (involuntária > 72 h)');
  PERFORM teste.afirma(NOT EXISTS (SELECT 1 FROM vw_pendencias WHERE internacao_id = I2 AND tipo = 'revisao_prescricao') IS NOT TRUE, '9g. pendência de prescrição aparece');
  PERFORM teste.afirma((SELECT count(*) FROM vw_painel_internados) = 1, '9h. painel lista só os internados atuais');

  -- ---- 10. isolamento: hospital, equipe, papel e organização
  -- Dr. B: vinculado só ao H1 e fora da equipe da internação 2
  PERFORM set_config('app.usuario_id', uB::text, true);
  PERFORM teste.afirma((SELECT count(*) FROM registro_clinico WHERE internacao_id = I1) = 0, '10. Dr. B (fora da equipe) não lê prontuário da internação 1');
  PERFORM teste.afirma((SELECT count(*) FROM internacao WHERE id = I2) = 0, '10b. Dr. B sem vínculo com H2 não enxerga a internação 2');
  PERFORM teste.afirma((SELECT count(*) FROM vw_paciente_episodios WHERE paciente_id = P1) = 2, '10c. Dr. B vê que existem 2 episódios (sem conteúdo clínico)');
  PERFORM teste.afirma((SELECT count(*) FROM diagnostico) = 0 AND (SELECT count(*) FROM paciente_alergia) = 0, '10d. nenhum dado clínico vaza para quem não é da equipe');
  PERFORM teste.erra(format($q$INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES (%L,%L,%L,%L,'evolucao',%L)$q$, orgA, P1, H1, I1, uB),
      'sem permissão', '10e. Dr. B não cria registro em internação fora da equipe');
  PERFORM teste.afirma((SELECT count(*) FROM auditoria_evento) = 0, '10f. médico assistente não lê a trilha de auditoria');

  -- Administrativo: vê cadastro/internação, nunca conteúdo clínico
  PERFORM set_config('app.usuario_id', uAdm::text, true);
  PERFORM teste.afirma((SELECT count(*) FROM internacao) = 2, '10g. administrativo vê as internações (dados administrativos)');
  PERFORM teste.afirma((SELECT count(*) FROM registro_clinico) = 0 AND (SELECT count(*) FROM internacao_clinico) = 0
                       AND (SELECT count(*) FROM diagnostico) = 0 AND (SELECT count(*) FROM paciente_alergia) = 0,
                       '10h. administrativo NÃO acessa conteúdo clínico (registros, motivo, CID, alergias)');
  PERFORM teste.erra(format($q$INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES (%L,%L,%L,%L,'evolucao',%L)$q$, orgA, P1, H2, I2, uAdm),
      'sem permissão', '10i. administrativo não escreve registro clínico');

  -- Enfermagem: só após entrar na equipe, e só conteúdo assistencial
  PERFORM set_config('app.usuario_id', uE::text, true);
  PERFORM teste.afirma((SELECT count(*) FROM registro_clinico) = 0, '10j. enfermagem fora da equipe não lê nada');
  PERFORM set_config('app.usuario_id', uA::text, true);
  INSERT INTO internacao_equipe (organizacao_id, internacao_id, usuario_id, funcao) VALUES (orgA, I1, uE, 'enfermagem');
  PERFORM set_config('app.usuario_id', uE::text, true);
  PERFORM teste.afirma((SELECT count(DISTINCT tipo) FROM registro_clinico) > 0
                       AND NOT EXISTS (SELECT 1 FROM registro_clinico WHERE tipo IN ('anamnese','resumo_alta','exame_estado_mental','parecer')),
                       '10k. enfermagem na equipe lê apenas tipos assistenciais');
  PERFORM teste.afirma((SELECT count(*) FROM paciente_alergia) = 1, '10l. enfermagem enxerga alergias (segurança do paciente)');
  PERFORM teste.afirma((SELECT count(*) FROM diagnostico) = 0, '10m. enfermagem não lê diagnósticos');

  -- Consultor: só parecer
  PERFORM set_config('app.usuario_id', uA::text, true);
  INSERT INTO internacao_equipe (organizacao_id, internacao_id, usuario_id, funcao) VALUES (orgA, I2, uC, 'consultor');
  PERFORM set_config('app.usuario_id', uC::text, true);
  PERFORM teste.erra(format($q$INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES (%L,%L,%L,%L,'evolucao',%L)$q$, orgA, P1, H2, I2, uC),
      'sem permissão', '10n. consultor não escreve evolução');
  PERFORM teste.erra(format($q$INSERT INTO registro_clinico (organizacao_id, paciente_id, hospital_id, internacao_id, tipo, autor_usuario_id) VALUES (%L,%L,%L,%L,'parecer',%L)$q$, orgA, P1, H2, I2, uC),
      'sem permissão', '10o. consultor sem vínculo com o hospital H2 não escreve nem parecer');

  -- Outra organização
  PERFORM set_config('app.usuario_id', uX::text, true);
  PERFORM set_config('app.organizacao_id', orgB::text, true);
  PERFORM teste.afirma((SELECT count(*) FROM paciente) = 0 AND (SELECT count(*) FROM hospital) = 0 AND (SELECT count(*) FROM internacao) = 0
                       AND (SELECT count(*) FROM registro_clinico) = 0, '10p. outra organização não enxerga nada da Clínica A');
  PERFORM teste.erra(format($q$INSERT INTO internacao (organizacao_id, paciente_id, hospital_id, modalidade, profissional_responsavel_id, data_admissao)
      VALUES (%L,%L,%L,'voluntaria',(SELECT id FROM profissional WHERE usuario_id=%L), now())$q$, orgB, P1, H1, uX), 'inexistente|diferente|permission|foreign|policy', '10q. não é possível referenciar paciente/hospital de outra organização');
  PERFORM set_config('app.organizacao_id', orgA::text, true);

  -- ---- 11. exportação e compartilhamento
  PERFORM set_config('app.usuario_id', uA::text, true);
  INSERT INTO arquivo (organizacao_id, paciente_id, internacao_id, categoria, nome_original, mime_type, tamanho_bytes, sha256, storage_chave)
    VALUES (orgA, P1, I1, 'pdf_gerado', 'prontuario.pdf', 'application/pdf', 1000, digest('x','sha256'), 'k/' || gen_random_uuid()) RETURNING id INTO arq;
  INSERT INTO pdf_gerado (organizacao_id, paciente_id, internacao_id, tipo_exportacao, arquivo_id, codigo_validacao, versao_modelo)
    VALUES (orgA, P1, I1, 'prontuario_internacao', arq, 'VAL-' || gen_random_uuid(), 'v1') RETURNING id INTO pdf;
  PERFORM teste.erra(format($q$INSERT INTO compartilhamento_documento (organizacao_id, pdf_id, canal, destinatario_tipo, destinatario_descricao, finalidade, conferiu_destinatario)
      VALUES (%L,%L,'whatsapp','familiar','irmã do paciente','envio de relatório',false)$q$, orgA, pdf), 'check', '11. WhatsApp exige conferência do destinatário');
  INSERT INTO compartilhamento_documento (organizacao_id, pdf_id, canal, destinatario_tipo, destinatario_descricao, finalidade, conferiu_destinatario)
    VALUES (orgA, pdf, 'whatsapp', 'responsavel_legal', 'responsável legal (conferido)', 'envio de relatório', true);
  PERFORM teste.erra(format($q$UPDATE pdf_gerado SET versao_modelo = 'v2' WHERE id = %L$q$, pdf), 'permission denied|append-only', '11b. PDF gerado é append-only');
  PERFORM teste.erra(format($q$UPDATE arquivo SET sha256 = digest('y','sha256') WHERE id = %L$q$, arq), 'imutável', '11c. arquivo não muda (só invalidação com motivo)');
  PERFORM teste.erra(format($q$DELETE FROM arquivo WHERE id = %L$q$, arq), 'permission denied|exclusão proibida', '11d. arquivo não é excluído');

  -- ---- 12. auditoria
  PERFORM auditar_acesso('leitura', 'registro_clinico', rr::text, P1, I1, '{"origem":"teste"}');
  PERFORM set_config('app.usuario_id', uAud::text, true);
  PERFORM teste.afirma((SELECT count(*) FROM auditoria_evento WHERE acao = 'assinatura') >= 5, '12. auditor lê a trilha: assinaturas registradas');
  PERFORM teste.afirma(EXISTS (SELECT 1 FROM auditoria_evento WHERE acao = 'exclusao_rascunho'), '12b. exclusão de rascunho ficou na auditoria');
  PERFORM teste.afirma(EXISTS (SELECT 1 FROM auditoria_evento WHERE acao = 'anulacao'), '12c. anulação registrada');
  PERFORM teste.afirma(EXISTS (SELECT 1 FROM auditoria_evento WHERE acao = 'leitura' AND paciente_id = P1), '12d. leitura registrada pela aplicação');
  PERFORM teste.afirma(EXISTS (SELECT 1 FROM auditoria_evento WHERE acao = 'adendo'), '12e. adendo registrado');
  PERFORM teste.erra($q$UPDATE auditoria_evento SET acao = 'x'$q$, 'permission denied', '12f. app não altera auditoria');
  PERFORM teste.erra($q$DELETE FROM auditoria_evento$q$, 'permission denied', '12g. app não apaga auditoria');
  PERFORM teste.erra($q$INSERT INTO auditoria_evento (organizacao_id, acao, hash) VALUES (gen_random_uuid(),'x','\x00')$q$, 'permission denied', '12h. app não forja auditoria');
  PERFORM teste.erra($q$SELECT * FROM contador$q$, 'permission denied', '12i. app não acessa contadores');
  PERFORM teste.erra($q$SELECT senha_hash FROM usuario$q$, 'permission denied', '12j. app não lê hash de senha');
  EXECUTE 'RESET ROLE';
  PERFORM teste.afirma(NOT EXISTS (SELECT 1 FROM verificar_cadeia_auditoria(orgA)), '12k. cadeia de hash da auditoria íntegra');
  PERFORM teste.erra($q$UPDATE auditoria_evento SET acao = 'x'$q$, 'imutável', '12l. nem o dono altera a auditoria (trigger)');
  -- adulteração direta (como se alguém desativasse o trigger) é detectada
  BEGIN
    ALTER TABLE auditoria_evento DISABLE TRIGGER trg_aud_imut_row;
    UPDATE auditoria_evento SET detalhes = '{"adulterado":true}' WHERE seq = (SELECT min(seq) FROM auditoria_evento WHERE organizacao_id = orgA);
    PERFORM teste.afirma(EXISTS (SELECT 1 FROM verificar_cadeia_auditoria(orgA)), '12m. adulteração da auditoria é detectada pela verificação');
    RAISE EXCEPTION 'desfazer_adulteracao';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'desfazer_adulteracao' THEN RAISE; END IF;
  END;
  PERFORM teste.afirma(NOT EXISTS (SELECT 1 FROM verificar_cadeia_auditoria(orgA)), '12n. após desfazer, cadeia volta a íntegra');
  -- adulteração de conteúdo assinado (burlando triggers) é detectada pelo hash
  PERFORM set_config('app.usuario_id', uA::text, true);
  BEGIN
    ALTER TABLE evolucao DISABLE TRIGGER trg_a_guard;
    UPDATE evolucao SET conduta = 'conduta adulterada por fora da aplicação'
     WHERE registro_id = (SELECT id FROM registro_clinico WHERE internacao_id = I1 AND tipo = 'evolucao' LIMIT 1);
    PERFORM teste.afirma(NOT verificar_integridade_registro((SELECT id FROM registro_clinico WHERE internacao_id = I1 AND tipo = 'evolucao' LIMIT 1)),
                         '12o. adulteração de registro assinado é detectada pelo hash');
    RAISE EXCEPTION 'desfazer_adulteracao';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'desfazer_adulteracao' THEN RAISE; END IF;
  END;

  -- ---- resultado
  SELECT count(*) INTO falhas FROM teste.resultado WHERE NOT ok;
  RAISE NOTICE '================ % testes, % falha(s) ================', (SELECT count(*) FROM teste.resultado), falhas;
  IF falhas > 0 THEN RAISE EXCEPTION '% teste(s) falharam', falhas; END IF;
END $$;
