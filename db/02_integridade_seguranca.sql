-- =====================================================================
-- MEDNEXO — 02_integridade_seguranca.sql
-- Funções, triggers (imutabilidade, assinatura, hash, auditoria encadeada),
-- permissões, RLS e views. Executar APÓS 01_estrutura.sql.
-- Contrato com a aplicação (por transação):
--   SET LOCAL app.organizacao_id = '<uuid>';  SET LOCAL app.usuario_id = '<uuid>';
--   SET LOCAL app.ip = '...'; app.user_agent; app.dispositivo; app.request_id (opcionais)
-- A aplicação conecta com o papel mednexo_app (NÃO é dono das tabelas, não tem BYPASSRLS).
-- =====================================================================
SET search_path = mednexo, public;

-- ---------------------------------------------------------------------
-- A. CONTEXTO DA SESSÃO
-- ---------------------------------------------------------------------
CREATE FUNCTION ctx_org() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.organizacao_id', true), '')::uuid $$;
CREATE FUNCTION ctx_usuario() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.usuario_id', true), '')::uuid $$;

CREATE FUNCTION exigir_ctx() RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF ctx_org() IS NULL OR ctx_usuario() IS NULL THEN
    RAISE EXCEPTION 'contexto de sessão ausente (app.organizacao_id / app.usuario_id)' USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- B. PERMISSÕES (SECURITY DEFINER: leem tabelas de autorização ignorando RLS)
-- ---------------------------------------------------------------------
CREATE FUNCTION ctx_papel() RETURNS papel_usuario LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = mednexo, public, pg_temp AS $$
  SELECT m.papel FROM organizacao_membro m
   WHERE m.organizacao_id = ctx_org() AND m.usuario_id = ctx_usuario() AND m.ativo $$;

CREATE FUNCTION tem_permissao(p text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = mednexo, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM organizacao_membro m
                   JOIN papel_permissao pp ON pp.papel = m.papel
                  WHERE m.organizacao_id = ctx_org() AND m.usuario_id = ctx_usuario()
                    AND m.ativo AND pp.permissao = p) $$;

CREATE FUNCTION tem_vinculo_hospital(p_hosp uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = mednexo, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM membro_hospital mh
                   JOIN organizacao_membro m ON m.id = mh.membro_id
                  WHERE m.organizacao_id = ctx_org() AND m.usuario_id = ctx_usuario()
                    AND m.ativo AND mh.ativo AND mh.hospital_id = p_hosp) $$;

CREATE FUNCTION na_equipe(p_int uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = mednexo, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM internacao_equipe e
                  WHERE e.internacao_id = p_int AND e.organizacao_id = ctx_org()
                    AND e.usuario_id = ctx_usuario() AND e.inicio <= now()
                    AND (e.fim IS NULL OR e.fim > now())) $$;

-- Acesso CLÍNICO à internação: vínculo com o hospital + (equipe | médico administrador/auditor p/ leitura)
CREATE FUNCTION acesso_internacao(p_int uuid, p_escrita boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE v_h uuid; v_o uuid;
BEGIN
  SELECT hospital_id, organizacao_id INTO v_h, v_o FROM internacao WHERE id = p_int;
  IF NOT FOUND OR v_o IS DISTINCT FROM ctx_org() THEN RETURN false; END IF;
  IF NOT tem_vinculo_hospital(v_h) THEN RETURN false; END IF;
  IF na_equipe(p_int) THEN RETURN true; END IF;
  IF NOT p_escrita AND ctx_papel() IN ('medico_administrador','auditor') THEN RETURN true; END IF;
  RETURN false;
END $$;

CREATE FUNCTION pode_ler_tipo(p_tipo tipo_registro, p_int uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
BEGIN
  IF tem_permissao('clinico.ler') THEN RETURN acesso_internacao(p_int, false); END IF;
  IF tem_permissao('clinico.ler.assistencial')
     AND p_tipo IN ('evolucao','intercorrencia','prescricao','avaliacao_risco') THEN
    RETURN acesso_internacao(p_int, false);
  END IF;
  RETURN false;
END $$;

CREATE FUNCTION pode_ler_registro(p_reg uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT tipo, internacao_id, status, autor_usuario_id, organizacao_id INTO r
    FROM registro_clinico WHERE id = p_reg;
  IF NOT FOUND OR r.organizacao_id IS DISTINCT FROM ctx_org() THEN RETURN false; END IF;
  IF r.status = 'rascunho' AND r.autor_usuario_id IS DISTINCT FROM ctx_usuario() THEN RETURN false; END IF;
  RETURN pode_ler_tipo(r.tipo, r.internacao_id);
END $$;

CREATE FUNCTION pode_escrever_registro(p_tipo tipo_registro, p_int uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT (tem_permissao('clinico.escrever')
          OR (p_tipo = 'parecer' AND tem_permissao('clinico.escrever.parecer')))
         AND acesso_internacao(p_int, true) $$;

CREATE FUNCTION pode_ler_clinico_paciente(p_pac uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT tem_permissao('clinico.ler')
     AND EXISTS (SELECT 1 FROM internacao i WHERE i.paciente_id = p_pac
                    AND i.organizacao_id = ctx_org() AND acesso_internacao(i.id, false)) $$;

CREATE FUNCTION pode_escrever_clinico_paciente(p_pac uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT tem_permissao('clinico.escrever')
     AND EXISTS (SELECT 1 FROM internacao i WHERE i.paciente_id = p_pac
                    AND i.organizacao_id = ctx_org() AND acesso_internacao(i.id, true)) $$;

CREATE FUNCTION paciente_vinculado_a_meus_hospitais(p_pac uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM paciente_hospital ph
                  WHERE ph.paciente_id = p_pac AND tem_vinculo_hospital(ph.hospital_id)) $$;

CREATE FUNCTION pode_ler_arquivo(p_cat categoria_arquivo, p_pac uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT CASE WHEN p_cat IN ('logotipo_hospital','contrato','foto_identificacao')
              THEN tem_permissao('paciente.cadastro.ler')
              ELSE p_pac IS NOT NULL AND pode_ler_clinico_paciente(p_pac) END $$;

-- ---------------------------------------------------------------------
-- C. UTILITÁRIOS GENÉRICOS DE TRIGGER
-- ---------------------------------------------------------------------
CREATE FUNCTION trg_atualizado_em() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.atualizado_em := now(); RETURN NEW; END $$;

CREATE FUNCTION trg_bloquear_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'exclusão proibida em %: use inativação/anulação (dado clínico não pode sumir)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE FUNCTION trg_somente_insercao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% é append-only: alteração/exclusão proibida', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- força colunas de autoria a partir do contexto da sessão (cliente não escolhe o autor)
CREATE FUNCTION trg_forcar_autor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM exigir_ctx();
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], ctx_usuario()));
  RETURN NEW;
END $$;

CREATE FUNCTION proximo_numero(p_org uuid, p_nome text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO contador (organizacao_id, nome, valor) VALUES (p_org, p_nome, 1)
  ON CONFLICT (organizacao_id, nome) DO UPDATE SET valor = contador.valor + 1
  RETURNING valor INTO v;
  RETURN v;
END $$;

CREATE FUNCTION trg_numerar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.numero := proximo_numero(NEW.organizacao_id, TG_ARGV[0]);
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- D. AUDITORIA ENCADEADA (hash chain por organização)
-- ---------------------------------------------------------------------
CREATE FUNCTION registrar_auditoria(p_org uuid, p_acao text, p_entidade text, p_entidade_id text,
  p_paciente uuid, p_hospital uuid, p_internacao uuid, p_detalhes jsonb DEFAULT '{}'::jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE
  v_prev bytea; v_hash bytea; v_seq bigint; v_ts timestamptz := clock_timestamp();
  v_ip inet := nullif(current_setting('app.ip', true), '')::inet;
  v_user uuid := ctx_usuario();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text, 4242));
  SELECT hash INTO v_prev FROM auditoria_evento WHERE organizacao_id = p_org ORDER BY seq DESC LIMIT 1;
  v_hash := digest(coalesce(v_prev, '\x'::bytea) || convert_to(concat_ws('|', p_org::text,
              to_char(v_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), coalesce(v_user::text,''),
              p_acao, coalesce(p_entidade,''), coalesce(p_entidade_id,''), coalesce(p_paciente::text,''),
              coalesce(p_hospital::text,''), coalesce(p_internacao::text,''), coalesce(v_ip::text,''),
              p_detalhes::text), 'UTF8'), 'sha256');
  INSERT INTO auditoria_evento (organizacao_id, ocorrido_em, usuario_id, acao, entidade, entidade_id,
      paciente_id, hospital_id, internacao_id, ip, user_agent, dispositivo, request_id, detalhes,
      hash_anterior, hash)
  VALUES (p_org, v_ts, v_user, p_acao, p_entidade, p_entidade_id, p_paciente, p_hospital, p_internacao,
      v_ip, nullif(current_setting('app.user_agent', true), ''), nullif(current_setting('app.dispositivo', true), ''),
      nullif(current_setting('app.request_id', true), ''), p_detalhes, v_prev, v_hash)
  RETURNING seq INTO v_seq;
  RETURN v_seq;
END $$;

-- Usado pela aplicação para registrar LEITURAS, exportações, logins, acessos negados etc.
CREATE FUNCTION auditar_acesso(p_acao text, p_entidade text, p_entidade_id text, p_paciente uuid,
  p_internacao uuid, p_detalhes jsonb DEFAULT '{}'::jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE v_h uuid;
BEGIN
  PERFORM exigir_ctx();
  IF p_internacao IS NOT NULL THEN SELECT hospital_id INTO v_h FROM internacao WHERE id = p_internacao; END IF;
  RETURN registrar_auditoria(ctx_org(), p_acao, p_entidade, p_entidade_id, p_paciente, v_h, p_internacao, p_detalhes);
END $$;

CREATE FUNCTION trg_auditoria_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'auditoria_evento é imutável' USING ERRCODE = 'restrict_violation'; END $$;
CREATE TRIGGER trg_aud_imut_row BEFORE UPDATE OR DELETE ON auditoria_evento
  FOR EACH ROW EXECUTE FUNCTION trg_auditoria_imutavel();
CREATE TRIGGER trg_aud_imut_trunc BEFORE TRUNCATE ON auditoria_evento
  FOR EACH STATEMENT EXECUTE FUNCTION trg_auditoria_imutavel();

CREATE FUNCTION verificar_cadeia_auditoria(p_org uuid) RETURNS TABLE (seq bigint, problema text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE r auditoria_evento; v_prev bytea := NULL; v_calc bytea;
BEGIN
  FOR r IN SELECT * FROM auditoria_evento a WHERE a.organizacao_id = p_org ORDER BY a.seq LOOP
    IF r.hash_anterior IS DISTINCT FROM v_prev THEN
      seq := r.seq; problema := 'hash_anterior não confere (evento removido ou reordenado)'; RETURN NEXT;
    END IF;
    v_calc := digest(coalesce(v_prev, '\x'::bytea) || convert_to(concat_ws('|', r.organizacao_id::text,
              to_char(r.ocorrido_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), coalesce(r.usuario_id::text,''),
              r.acao, coalesce(r.entidade,''), coalesce(r.entidade_id,''), coalesce(r.paciente_id::text,''),
              coalesce(r.hospital_id::text,''), coalesce(r.internacao_id::text,''), coalesce(r.ip::text,''),
              r.detalhes::text), 'UTF8'), 'sha256');
    IF v_calc <> r.hash THEN
      seq := r.seq; problema := 'conteúdo do evento alterado'; RETURN NEXT;
    END IF;
    v_prev := r.hash;
  END LOOP;
END $$;

-- Auditoria automática de DML (escrita). Leitura é registrada pela aplicação via auditar_acesso().
CREATE FUNCTION trg_auditar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_new jsonb; v_old jsonb; v_row jsonb; v_org uuid; v_pac uuid; v_hosp uuid; v_int uuid;
  v_id text; v_acao text; v_det jsonb; v_reg record;
BEGIN
  v_new := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_old := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_row := coalesce(v_new, v_old);
  v_org := nullif(v_row->>'organizacao_id','')::uuid;
  v_pac := nullif(v_row->>'paciente_id','')::uuid;
  v_hosp := nullif(v_row->>'hospital_id','')::uuid;
  v_int := nullif(v_row->>'internacao_id','')::uuid;
  IF v_row ? 'registro_id' AND (v_org IS NULL OR v_pac IS NULL) THEN
    SELECT organizacao_id, paciente_id, hospital_id, internacao_id INTO v_reg
      FROM registro_clinico WHERE id = (v_row->>'registro_id')::uuid;
    IF FOUND THEN v_org := v_reg.organizacao_id; v_pac := v_reg.paciente_id;
                  v_hosp := v_reg.hospital_id; v_int := v_reg.internacao_id; END IF;
  END IF;
  IF TG_TABLE_NAME = 'paciente' THEN v_pac := (v_row->>'id')::uuid; END IF;
  IF TG_TABLE_NAME = 'internacao' THEN v_int := (v_row->>'id')::uuid; END IF;
  IF TG_TABLE_NAME = 'hospital' THEN v_hosp := (v_row->>'id')::uuid; END IF;
  v_org := coalesce(v_org, ctx_org());
  IF v_org IS NULL THEN RAISE EXCEPTION 'auditoria: organização indeterminada para %', TG_TABLE_NAME; END IF;
  v_id := coalesce(v_row->>'id', v_row->>'registro_id');
  IF v_id IS NULL THEN v_id := v_row::text; END IF;

  IF TG_OP = 'INSERT' THEN
    v_acao := 'criacao'; v_det := jsonb_build_object('depois', v_new);
  ELSIF TG_OP = 'DELETE' THEN
    v_acao := CASE WHEN TG_TABLE_NAME = 'registro_clinico' THEN 'exclusao_rascunho' ELSE 'exclusao' END;
    v_det := jsonb_build_object('antes', v_old);
  ELSE
    v_old := v_old - 'atualizado_em'; v_new := v_new - 'atualizado_em';
    IF v_old = v_new THEN RETURN NULL; END IF;
    v_acao := 'alteracao';
    IF TG_TABLE_NAME = 'registro_clinico' THEN
      IF OLD.status = 'rascunho' AND NEW.status = 'assinado' THEN v_acao := 'assinatura';
      ELSIF NEW.status = 'anulado' THEN v_acao := 'anulacao'; END IF;
    END IF;
    v_det := jsonb_build_object(
      'antes',  (SELECT coalesce(jsonb_object_agg(k, v_old->k), '{}') FROM jsonb_object_keys(v_new) k WHERE v_old->k IS DISTINCT FROM v_new->k),
      'depois', (SELECT coalesce(jsonb_object_agg(k, v_new->k), '{}') FROM jsonb_object_keys(v_new) k WHERE v_old->k IS DISTINCT FROM v_new->k));
  END IF;
  IF TG_TABLE_NAME = 'registro_adendo' THEN v_acao := 'adendo'; END IF;
  PERFORM registrar_auditoria(v_org, v_acao, TG_TABLE_NAME, v_id, v_pac, v_hosp, v_int, v_det);
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- E. CONTEÚDO CANÔNICO E HASH (integridade do registro assinado)
-- ---------------------------------------------------------------------
CREATE FUNCTION txt_vazio(t text) RETURNS boolean LANGUAGE sql IMMUTABLE
AS $$ SELECT t IS NULL OR btrim(t) = '' $$;

CREATE FUNCTION conteudo_canonico(p_registro uuid, p_tipo tipo_registro) RETURNS jsonb
LANGUAGE plpgsql STABLE SET timezone = 'UTC' AS $$
DECLARE v jsonb;
BEGIN
  IF p_tipo = 'anamnese' THEN
    SELECT jsonb_build_object('corpo', to_jsonb(a) - 'registro_id',
      'substancias', coalesce((SELECT jsonb_agg(to_jsonb(s) - 'id' - 'registro_id'
                                 ORDER BY s.substancia, coalesce(s.outra_descricao,''))
                                 FROM anamnese_substancia s WHERE s.registro_id = a.registro_id), '[]'::jsonb))
      INTO v FROM anamnese a WHERE a.registro_id = p_registro;
  ELSIF p_tipo = 'exame_estado_mental' THEN
    SELECT jsonb_build_object('corpo', to_jsonb(e) - 'registro_id',
      'dominios', coalesce((SELECT jsonb_agg(jsonb_build_object('dominio', d.dominio, 'avaliado', d.avaliado,
          'observacao', d.observacao,
          'itens', coalesce((SELECT jsonb_agg(i.codigo ORDER BY i.codigo) FROM eem_item i
                              WHERE i.registro_id = d.registro_id AND i.dominio = d.dominio), '[]'::jsonb))
          ORDER BY d.dominio) FROM eem_dominio d WHERE d.registro_id = e.registro_id), '[]'::jsonb))
      INTO v FROM exame_estado_mental e WHERE e.registro_id = p_registro;
  ELSIF p_tipo = 'avaliacao_risco' THEN
    SELECT jsonb_build_object('corpo', to_jsonb(a) - 'registro_id',
      'itens', coalesce((SELECT jsonb_agg(to_jsonb(i) - 'registro_id' ORDER BY i.dimensao)
                          FROM avaliacao_risco_item i WHERE i.registro_id = a.registro_id), '[]'::jsonb))
      INTO v FROM avaliacao_risco a WHERE a.registro_id = p_registro;
  ELSIF p_tipo = 'evolucao' THEN
    SELECT jsonb_build_object('corpo', to_jsonb(x) - 'registro_id') INTO v FROM evolucao x WHERE x.registro_id = p_registro;
  ELSIF p_tipo = 'intercorrencia' THEN
    SELECT jsonb_build_object('corpo', to_jsonb(x) - 'registro_id') INTO v FROM intercorrencia x WHERE x.registro_id = p_registro;
  ELSIF p_tipo = 'prescricao' THEN
    SELECT jsonb_build_object('corpo', to_jsonb(p) - 'registro_id',
      'itens', coalesce((SELECT jsonb_agg(to_jsonb(i) - 'registro_id' ORDER BY i.ordem)
                          FROM prescricao_item i WHERE i.registro_id = p.registro_id), '[]'::jsonb),
      'alertas', coalesce((SELECT jsonb_agg(jsonb_build_object('chave', al.chave, 'tipo', al.tipo,
                          'gravidade', al.gravidade, 'mensagem', al.mensagem,
                          'justificativa', al.justificativa_medica) ORDER BY al.chave)
                          FROM alerta_prescricao al WHERE al.registro_id = p.registro_id), '[]'::jsonb))
      INTO v FROM prescricao p WHERE p.registro_id = p_registro;
  ELSIF p_tipo = 'receita' THEN
    SELECT jsonb_build_object('corpo', to_jsonb(r) - 'registro_id',
      'itens', coalesce((SELECT jsonb_agg(to_jsonb(i) - 'registro_id' ORDER BY i.ordem)
                          FROM receita_item i WHERE i.registro_id = r.registro_id), '[]'::jsonb))
      INTO v FROM receita r WHERE r.registro_id = p_registro;
  ELSIF p_tipo = 'resumo_alta' THEN
    SELECT jsonb_build_object('corpo', to_jsonb(r) - 'registro_id',
      'diagnosticos', coalesce((SELECT jsonb_agg(d.diagnostico_id ORDER BY d.diagnostico_id)
                          FROM resumo_alta_diagnostico d WHERE d.registro_id = r.registro_id), '[]'::jsonb))
      INTO v FROM resumo_alta r WHERE r.registro_id = p_registro;
  ELSE  -- parecer, relatorio, atestado, declaracao, encaminhamento, solicitacao_exames
    SELECT jsonb_build_object('corpo', to_jsonb(x) - 'registro_id') INTO v
      FROM documento_clinico x WHERE x.registro_id = p_registro;
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION hash_registro(rc registro_clinico) RETURNS bytea
LANGUAGE sql STABLE SET timezone = 'UTC' AS $$
  SELECT digest(convert_to(jsonb_build_object(
    'cabecalho', jsonb_build_object('id', rc.id, 'organizacao_id', rc.organizacao_id,
       'paciente_id', rc.paciente_id, 'hospital_id', rc.hospital_id, 'internacao_id', rc.internacao_id,
       'tipo', rc.tipo, 'autor_usuario_id', rc.autor_usuario_id, 'ocorrido_em', rc.ocorrido_em,
       'registrado_em', rc.registrado_em, 'justificativa_retroativo', rc.justificativa_retroativo),
    'conteudo', conteudo_canonico(rc.id, rc.tipo))::text, 'UTF8'), 'sha256') $$;

-- true = conteúdo atual confere com o hash gravado na assinatura
CREATE FUNCTION verificar_integridade_registro(p_registro uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT rc.hash_conteudo IS NOT NULL AND hash_registro(rc) = rc.hash_conteudo
    FROM registro_clinico rc WHERE rc.id = p_registro $$;

-- ---------------------------------------------------------------------
-- F. ALERTAS DE SEGURANÇA DA PRESCRIÇÃO (regras determinísticas; IA não decide)
-- ---------------------------------------------------------------------
CREATE FUNCTION avaliar_alertas_prescricao(p_registro uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_pac uuid; v_nasc date; v_status alergias_status; v_idade int; v_pop text;
  n int := 0; c int; r record; f record; v_doses_dia numeric; v_total numeric;
BEGIN
  SELECT rc.paciente_id, p.data_nascimento, p.alergias_status INTO v_pac, v_nasc, v_status
    FROM registro_clinico rc JOIN paciente p ON p.id = rc.paciente_id WHERE rc.id = p_registro;
  v_idade := date_part('year', age(current_date, v_nasc));
  -- recalcula do zero: alertas sem justificativa são regerados; os já justificados são preservados
  DELETE FROM alerta_prescricao WHERE registro_id = p_registro AND justificativa_medica IS NULL;
  v_pop := CASE WHEN v_idade < 18 THEN 'pediatrico' WHEN v_idade >= 65 THEN 'idoso' ELSE 'adulto' END;

  IF v_status = 'nao_avaliado' THEN
    INSERT INTO alerta_prescricao (registro_id, chave, tipo, gravidade, mensagem, fonte)
    VALUES (p_registro, 'alergias_nao_avaliadas', 'alergias_nao_avaliadas', 'grave',
      'Alergias do paciente não foram avaliadas. Registre alergias ou declare "sem alergias conhecidas".',
      'regra do sistema') ON CONFLICT (registro_id, chave) DO NOTHING;
    GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  END IF;

  INSERT INTO alerta_prescricao (registro_id, item_id, chave, tipo, gravidade, mensagem, fonte)
  SELECT p_registro, i.id, 'alergia:' || i.id::text || ':' || pa.id::text, 'alergia',
         CASE WHEN pa.gravidade IN ('grave','anafilaxia') THEN 'contraindicada'::gravidade_alerta
              ELSE 'grave'::gravidade_alerta END,
         format('Alergia ativa registrada (%s, gravidade %s) e o item contém %s.', pa.agente, pa.gravidade, pr.nome),
         'cadastro de alergias do paciente'
    FROM prescricao_item i
    JOIN medicamento_apresentacao ma ON ma.id = i.apresentacao_id
    JOIN principio_ativo pr ON pr.id = ma.principio_ativo_id
    JOIN paciente_alergia pa ON pa.principio_ativo_id = pr.id AND pa.paciente_id = v_pac AND pa.situacao = 'ativa'
   WHERE i.registro_id = p_registro AND i.acao <> 'suspender'
  ON CONFLICT (registro_id, chave) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  INSERT INTO alerta_prescricao (registro_id, chave, tipo, gravidade, mensagem, fonte)
  SELECT p_registro, 'duplicidade:' || ma.principio_ativo_id::text, 'duplicidade_principio_ativo', 'moderada',
         format('Princípio ativo %s aparece %s vezes nesta prescrição.', min(pr.nome), count(*)), 'regra do sistema'
    FROM prescricao_item i
    JOIN medicamento_apresentacao ma ON ma.id = i.apresentacao_id
    JOIN principio_ativo pr ON pr.id = ma.principio_ativo_id
   WHERE i.registro_id = p_registro AND i.acao <> 'suspender'
   GROUP BY ma.principio_ativo_id HAVING count(*) > 1
  ON CONFLICT (registro_id, chave) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  INSERT INTO alerta_prescricao (registro_id, item_id, chave, tipo, gravidade, mensagem, fonte)
  SELECT p_registro, i.id, 'via:' || i.id::text, 'via_incompativel', 'grave',
         format('Via %s não consta entre as vias da apresentação %s.', i.via, pr.nome), 'catálogo de medicamentos'
    FROM prescricao_item i
    JOIN medicamento_apresentacao ma ON ma.id = i.apresentacao_id
    JOIN principio_ativo pr ON pr.id = ma.principio_ativo_id
   WHERE i.registro_id = p_registro AND i.acao <> 'suspender' AND NOT (i.via = ANY (ma.vias_permitidas))
  ON CONFLICT (registro_id, chave) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  INSERT INTO alerta_prescricao (registro_id, chave, tipo, gravidade, mensagem, fonte)
  SELECT p_registro, 'interacao:' || im.id::text, 'interacao', im.gravidade,
         format('Interação %s + %s: %s', a.nome, b.nome, im.descricao), im.fonte
    FROM interacao_medicamentosa im
    JOIN principio_ativo a ON a.id = im.principio_a_id
    JOIN principio_ativo b ON b.id = im.principio_b_id
   WHERE EXISTS (SELECT 1 FROM prescricao_item i JOIN medicamento_apresentacao ma ON ma.id = i.apresentacao_id
                  WHERE i.registro_id = p_registro AND i.acao <> 'suspender' AND ma.principio_ativo_id = im.principio_a_id)
     AND EXISTS (SELECT 1 FROM prescricao_item i JOIN medicamento_apresentacao ma ON ma.id = i.apresentacao_id
                  WHERE i.registro_id = p_registro AND i.acao <> 'suspender' AND ma.principio_ativo_id = im.principio_b_id)
  ON CONFLICT (registro_id, chave) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  FOR r IN SELECT i.id, i.dose_valor, i.dose_unidade, i.via, i.frequencia_tipo, i.vezes_dia,
                  i.intervalo_horas, i.sos_dose_max_24h, ma.principio_ativo_id AS pa_id, pr.nome
             FROM prescricao_item i
             JOIN medicamento_apresentacao ma ON ma.id = i.apresentacao_id
             JOIN principio_ativo pr ON pr.id = ma.principio_ativo_id
            WHERE i.registro_id = p_registro AND i.acao <> 'suspender' LOOP
    SELECT * INTO f FROM faixa_dose_referencia fd
     WHERE fd.principio_ativo_id = r.pa_id AND fd.via = r.via AND fd.unidade = r.dose_unidade
       AND fd.populacao IN (v_pop, 'geral') ORDER BY (fd.populacao = 'geral') LIMIT 1;
    IF NOT FOUND THEN
      INSERT INTO alerta_prescricao (registro_id, item_id, chave, tipo, gravidade, mensagem, fonte)
      VALUES (p_registro, r.id, 'semfaixa:' || r.id::text, 'dose_sem_referencia', 'informativa',
        format('Sem faixa de dose de referência cadastrada para %s (%s, %s). Dose não verificada pelo sistema.',
               r.nome, r.via, r.dose_unidade), 'regra do sistema')
      ON CONFLICT (registro_id, chave) DO NOTHING;
      GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
    ELSE
      v_doses_dia := CASE r.frequencia_tipo WHEN 'vezes_dia' THEN r.vezes_dia
                       WHEN 'intervalo' THEN 24 / r.intervalo_horas WHEN 'dose_unica' THEN 1 ELSE NULL END;
      v_total := CASE WHEN r.frequencia_tipo = 'sos' THEN r.sos_dose_max_24h
                      WHEN v_doses_dia IS NOT NULL THEN r.dose_valor * v_doses_dia END;
      IF (f.dose_unica_max IS NOT NULL AND r.dose_valor > f.dose_unica_max)
         OR (f.dose_diaria_max IS NOT NULL AND v_total IS NOT NULL AND v_total > f.dose_diaria_max) THEN
        INSERT INTO alerta_prescricao (registro_id, item_id, chave, tipo, gravidade, mensagem, fonte)
        VALUES (p_registro, r.id, 'dose:' || r.id::text, 'dose_acima_referencia', 'grave',
          format('Dose de %s acima da referência (dose %s %s; total/dia %s; máx. unitária %s, máx. diária %s).',
                 r.nome, r.dose_valor, r.dose_unidade, v_total, f.dose_unica_max, f.dose_diaria_max),
          f.fonte || ' (rev. ' || f.revisado_em::text || ')')
        ON CONFLICT (registro_id, chave) DO NOTHING;
        GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END $$;

CREATE FUNCTION trg_alerta_justificativa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.justificativa_medica IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.justificativa_medica IS DISTINCT FROM OLD.justificativa_medica) THEN
    IF length(btrim(NEW.justificativa_medica)) < 10 THEN
      RAISE EXCEPTION 'justificativa do alerta muito curta (mín. 10 caracteres)';
    END IF;
    PERFORM exigir_ctx();
    NEW.justificado_por := ctx_usuario(); NEW.justificado_em := now();
  ELSIF NEW.justificativa_medica IS NULL THEN
    NEW.justificado_por := NULL; NEW.justificado_em := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_b_alerta_just BEFORE INSERT OR UPDATE ON alerta_prescricao
  FOR EACH ROW EXECUTE FUNCTION trg_alerta_justificativa();

-- ---------------------------------------------------------------------
-- G. VALIDAÇÃO ANTES DE ASSINAR (regras de completude e segurança clínica)
-- ---------------------------------------------------------------------
CREATE FUNCTION validar_para_assinatura(rc registro_clinico) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  e text[] := '{}'; a record; n int; r record; v_int record;
BEGIN
  IF rc.tipo = 'anamnese' THEN
    SELECT * INTO a FROM anamnese WHERE registro_id = rc.id;
    IF NOT FOUND THEN e := array_append(e, 'conteúdo da anamnese não preenchido');
    ELSE
      IF txt_vazio(a.queixa_principal) THEN e := array_append(e, 'queixa principal'); END IF;
      IF txt_vazio(a.fonte_informacao) THEN e := array_append(e, 'fonte das informações'); END IF;
      IF a.confiabilidade_relato IS NULL THEN e := array_append(e, 'confiabilidade do relato'); END IF;
      IF txt_vazio(a.hda_sintomas_predominantes) THEN e := array_append(e, 'sintomas predominantes (HDA)'); END IF;
    END IF;

  ELSIF rc.tipo = 'exame_estado_mental' THEN
    SELECT count(*) INTO n FROM eem_dominio WHERE registro_id = rc.id;
    IF n < 15 THEN e := array_append(e, format('exame do estado mental: %s de 15 domínios tratados', n)); END IF;
    FOR r IN SELECT d.dominio FROM eem_dominio d
              WHERE d.registro_id = rc.id AND d.avaliado
                AND NOT EXISTS (SELECT 1 FROM eem_item i WHERE i.registro_id = d.registro_id AND i.dominio = d.dominio)
    LOOP e := array_append(e, format('domínio "%s" marcado como avaliado sem nenhum achado', r.dominio)); END LOOP;

  ELSIF rc.tipo = 'avaliacao_risco' THEN
    SELECT * INTO a FROM avaliacao_risco WHERE registro_id = rc.id;
    IF NOT FOUND THEN e := array_append(e, 'conteúdo da avaliação de risco não preenchido');
    ELSE
      SELECT count(*) INTO n FROM avaliacao_risco_item WHERE registro_id = rc.id;
      IF n < 13 THEN e := array_append(e, format('avaliação de risco: %s de 13 dimensões tratadas (use "nao_avaliado" + motivo)', n)); END IF;
      IF a.nivel_risco_profissional IS NULL THEN e := array_append(e, 'nível de risco (decisão do profissional)'); END IF;
      IF txt_vazio(a.avaliacao_clinica) THEN e := array_append(e, 'avaliação clínica do profissional'); END IF;
      IF txt_vazio(a.conduta) THEN e := array_append(e, 'conduta'); END IF;
      IF a.necessita_reavaliacao IS NULL THEN e := array_append(e, 'necessidade de reavaliação (sim/não)');
      ELSIF a.necessita_reavaliacao AND a.reavaliar_em IS NULL THEN e := array_append(e, 'data/hora da reavaliação');
      ELSIF a.reavaliar_em IS NOT NULL AND a.reavaliar_em <= rc.ocorrido_em THEN e := array_append(e, 'reavaliação deve ser posterior à avaliação'); END IF;
      IF a.nivel_risco_profissional = 'baixo' AND txt_vazio(a.justificativa_nivel)
         AND EXISTS (SELECT 1 FROM avaliacao_risco_item i WHERE i.registro_id = rc.id
                      AND i.dimensao IN ('ideacao_suicida','intencao_suicida','planejamento_suicida','tentativas_anteriores')
                      AND i.situacao = 'presente') THEN
        e := array_append(e, format('nível "baixo" com ideação/intenção/plano/tentativa presente exige justificativa do nível'));
      END IF;
    END IF;

  ELSIF rc.tipo = 'evolucao' THEN
    SELECT * INTO a FROM evolucao WHERE registro_id = rc.id;
    IF NOT FOUND THEN e := array_append(e, 'conteúdo da evolução não preenchido');
    ELSE
      IF txt_vazio(a.subjetivo) AND txt_vazio(a.objetivo) AND txt_vazio(a.texto_livre) THEN
        e := array_append(e, 'relato subjetivo, objetivo ou texto livre'); END IF;
      IF txt_vazio(a.conduta) THEN e := array_append(e, 'conduta'); END IF;
      IF a.avaliacao_risco_registro_id IS NOT NULL THEN
        SELECT status, internacao_id INTO r FROM registro_clinico WHERE id = a.avaliacao_risco_registro_id;
        IF r.status IS DISTINCT FROM 'assinado' OR r.internacao_id IS DISTINCT FROM rc.internacao_id THEN
          e := array_append(e, 'avaliação de risco vinculada deve estar assinada e ser da mesma internação'); END IF;
      END IF;
    END IF;

  ELSIF rc.tipo = 'intercorrencia' THEN
    SELECT * INTO a FROM intercorrencia WHERE registro_id = rc.id;
    IF NOT FOUND THEN e := array_append(e, 'conteúdo da intercorrência não preenchido');
    ELSE
      IF txt_vazio(a.descricao) THEN e := array_append(e, 'descrição'); END IF;
      IF txt_vazio(a.conduta) THEN e := array_append(e, 'conduta'); END IF;
    END IF;

  ELSIF rc.tipo = 'prescricao' THEN
    SELECT * INTO a FROM prescricao WHERE registro_id = rc.id;
    IF NOT FOUND THEN e := array_append(e, 'cabeçalho da prescrição não preenchido');
    ELSE
      IF a.tipo = 'hospitalar' AND a.valida_ate IS NULL THEN e := array_append(e, 'validade da prescrição hospitalar'); END IF;
      SELECT count(*) INTO n FROM prescricao_item WHERE registro_id = rc.id;
      IF n = 0 THEN e := array_append(e, 'prescrição sem itens'); END IF;
      FOR r IN SELECT i.ordem FROM prescricao_item i JOIN medicamento_apresentacao ma ON ma.id = i.apresentacao_id
                WHERE i.registro_id = rc.id AND NOT ma.ativo
      LOOP e := array_append(e, format('item %s usa apresentação inativa no catálogo', r.ordem)); END LOOP;
      FOR r IN SELECT i.ordem FROM prescricao_item i
                 JOIN prescricao_item ant ON ant.id = i.item_anterior_id
                 JOIN registro_clinico rant ON rant.id = ant.registro_id
                WHERE i.registro_id = rc.id AND (rant.internacao_id <> rc.internacao_id OR rant.status <> 'assinado')
      LOOP e := array_append(e, format('item %s referencia item anterior de outra internação ou não assinado', r.ordem)); END LOOP;
      PERFORM avaliar_alertas_prescricao(rc.id);
      FOR r IN SELECT al.tipo, al.gravidade, al.mensagem FROM alerta_prescricao al
                WHERE al.registro_id = rc.id AND al.gravidade IN ('grave','contraindicada')
                  AND txt_vazio(al.justificativa_medica)
      LOOP e := array_append(e, format('alerta %s (%s) sem justificativa médica: %s', r.tipo, r.gravidade, r.mensagem)); END LOOP;
    END IF;

  ELSIF rc.tipo = 'receita' THEN
    SELECT * INTO a FROM receita WHERE registro_id = rc.id;
    IF NOT FOUND THEN e := array_append(e, 'cabeçalho da receita não preenchido');
    ELSE
      SELECT count(*) INTO n FROM receita_item WHERE registro_id = rc.id;
      IF n = 0 THEN e := array_append(e, 'receita sem itens'); END IF;
      IF a.tipo <> 'simples' THEN
        IF a.emissao_externa IS NULL OR txt_vazio(a.emissao_externa->>'numero') THEN
          e := array_append(e, 'receita controlada exige emissão no sistema oficial (número/código externo); o MEDNEXO não cria numeração própria'); END IF;
        IF rc.tipo_assinatura IS DISTINCT FROM 'icp_brasil' THEN e := array_append(e, 'receita controlada exige assinatura ICP-Brasil'); END IF;
      END IF;
    END IF;

  ELSIF rc.tipo = 'resumo_alta' THEN
    SELECT * INTO a FROM resumo_alta WHERE registro_id = rc.id;
    IF NOT FOUND THEN e := array_append(e, 'conteúdo do resumo de alta não preenchido');
    ELSE
      IF txt_vazio(a.resumo_internacao) THEN e := array_append(e, 'resumo da internação'); END IF;
      IF txt_vazio(a.condicao_clinica_alta) THEN e := array_append(e, 'condição clínica na alta'); END IF;
      IF txt_vazio(a.tratamento_realizado) THEN e := array_append(e, 'tratamento realizado'); END IF;
      IF txt_vazio(a.destino_paciente) THEN e := array_append(e, 'destino do paciente'); END IF;
      IF a.necessita_acompanhamento_ambulatorial IS NULL THEN e := array_append(e, 'necessidade de acompanhamento ambulatorial'); END IF;
      IF a.diagnostico_principal_id IS NULL THEN e := array_append(e, 'diagnóstico principal na alta');
      ELSIF NOT EXISTS (SELECT 1 FROM diagnostico d WHERE d.id = a.diagnostico_principal_id AND d.internacao_id = rc.internacao_id) THEN
        e := array_append(e, 'diagnóstico principal deve pertencer a esta internação'); END IF;
      IF a.prescricao_alta_registro_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM registro_clinico p JOIN prescricao pr ON pr.registro_id = p.id
            WHERE p.id = a.prescricao_alta_registro_id AND p.status = 'assinado'
              AND p.internacao_id = rc.internacao_id AND pr.tipo = 'alta') THEN
        e := array_append(e, format('prescrição de alta vinculada deve estar assinada, ser do tipo "alta" e desta internação')); END IF;
    END IF;

  ELSE  -- documentos de texto
    SELECT * INTO a FROM documento_clinico WHERE registro_id = rc.id;
    IF NOT FOUND THEN e := array_append(e, 'conteúdo do documento não preenchido');
    ELSE
      IF txt_vazio(a.titulo) THEN e := array_append(e, 'título'); END IF;
      IF txt_vazio(a.corpo) THEN e := array_append(e, 'corpo do documento'); END IF;
      IF rc.tipo = 'atestado' AND a.dias_afastamento IS NULL THEN e := array_append(e, 'dias de afastamento (0 se não houver)'); END IF;
    END IF;
  END IF;

  IF cardinality(e) > 0 THEN
    RAISE EXCEPTION 'registro % (%) não pode ser assinado — pendências: %', rc.id, rc.tipo, array_to_string(e, '; ')
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- H. TRIGGERS DO REGISTRO CLÍNICO: criação, edição de rascunho, assinatura, anulação
-- ---------------------------------------------------------------------
CREATE FUNCTION trg_registro_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  PERFORM exigir_ctx();
  IF NEW.autor_usuario_id IS DISTINCT FROM ctx_usuario() THEN
    RAISE EXCEPTION 'o autor do registro deve ser o usuário autenticado' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> 'rascunho' OR NEW.assinado_em IS NOT NULL OR NEW.hash_conteudo IS NOT NULL
     OR NEW.anulado_em IS NOT NULL THEN
    RAISE EXCEPTION 'registro nasce como rascunho; assinatura só via assinar_registro()';
  END IF;
  IF NOT pode_escrever_registro(NEW.tipo, NEW.internacao_id) THEN
    RAISE EXCEPTION 'sem permissão para criar % nesta internação', NEW.tipo USING ERRCODE = '42501';
  END IF;
  SELECT status, data_admissao, data_alta INTO v FROM internacao WHERE id = NEW.internacao_id;
  IF v.status = 'encerrada' AND NEW.tipo NOT IN ('resumo_alta','relatorio','atestado','declaracao','encaminhamento','parecer') THEN
    RAISE EXCEPTION 'internação encerrada: % não pode mais ser criado (use adendo em registro assinado)', NEW.tipo
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.ocorrido_em < v.data_admissao THEN
    RAISE EXCEPTION 'ocorrido_em (%) anterior à admissão (%)', NEW.ocorrido_em, v.data_admissao;
  END IF;
  NEW.registrado_em := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_registro_ins BEFORE INSERT ON registro_clinico
  FOR EACH ROW EXECUTE FUNCTION trg_registro_before_insert();

CREATE FUNCTION trg_registro_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_prof record;
BEGIN
  PERFORM exigir_ctx();
  IF (NEW.id, NEW.tipo, NEW.organizacao_id, NEW.paciente_id, NEW.hospital_id, NEW.internacao_id,
      NEW.autor_usuario_id, NEW.registrado_em)
     IS DISTINCT FROM
     (OLD.id, OLD.tipo, OLD.organizacao_id, OLD.paciente_id, OLD.hospital_id, OLD.internacao_id,
      OLD.autor_usuario_id, OLD.registrado_em) THEN
    RAISE EXCEPTION 'identidade/autoria do registro é imutável' USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'anulado' THEN
    RAISE EXCEPTION 'registro anulado é imutável' USING ERRCODE = 'restrict_violation';

  ELSIF OLD.status = 'assinado' THEN
    IF NEW.status <> 'anulado' THEN
      RAISE EXCEPTION 'registro assinado é imutável: use adendo (registro_adendo) ou anulação justificada'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT (tem_permissao('clinico.anular') AND
            (ctx_usuario() = OLD.autor_usuario_id OR ctx_papel() = 'medico_administrador')) THEN
      RAISE EXCEPTION 'sem permissão para anular este registro' USING ERRCODE = '42501';
    END IF;
    IF txt_vazio(NEW.motivo_anulacao) OR length(btrim(NEW.motivo_anulacao)) < 10 THEN
      RAISE EXCEPTION 'anulação exige motivo (mín. 10 caracteres)';
    END IF;
    NEW.anulado_em := clock_timestamp(); NEW.anulado_por_usuario_id := ctx_usuario();
    IF (to_jsonb(NEW) - ARRAY['status','anulado_em','anulado_por_usuario_id','motivo_anulacao'])
       <> (to_jsonb(OLD) - ARRAY['status','anulado_em','anulado_por_usuario_id','motivo_anulacao']) THEN
      RAISE EXCEPTION 'anulação não pode alterar conteúdo' USING ERRCODE = 'restrict_violation';
    END IF;

  ELSE -- rascunho
    IF ctx_usuario() <> OLD.autor_usuario_id THEN
      RAISE EXCEPTION 'apenas o autor pode editar/assinar o rascunho' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'anulado' THEN
      RAISE EXCEPTION 'rascunho não se anula: exclua-o (a exclusão é auditada)'; END IF;
    IF NEW.status = 'assinado' THEN
      IF NOT tem_permissao('clinico.assinar') THEN
        RAISE EXCEPTION 'sem permissão para assinar' USING ERRCODE = '42501'; END IF;
      SELECT * INTO v_prof FROM profissional WHERE usuario_id = ctx_usuario();
      IF NOT FOUND THEN RAISE EXCEPTION 'usuário sem registro profissional (CRM) não pode assinar'; END IF;
      IF NEW.tipo_assinatura IS NULL THEN RAISE EXCEPTION 'informe o tipo de assinatura'; END IF;
      IF NEW.tipo_assinatura = 'icp_brasil' AND (NEW.assinatura_externa IS NULL
         OR v_prof.certificado_icp_serial IS NULL OR v_prof.certificado_icp_validade < current_date) THEN
        RAISE EXCEPTION 'assinatura ICP-Brasil exige assinatura_externa e certificado válido do profissional';
      END IF;
      PERFORM validar_para_assinatura(NEW);
      NEW.assinado_em := clock_timestamp();
      NEW.assinado_por_usuario_id := ctx_usuario();
      NEW.hash_conteudo := hash_registro(NEW);
    ELSE
      IF NEW.assinado_em IS NOT NULL OR NEW.hash_conteudo IS NOT NULL OR NEW.anulado_em IS NOT NULL THEN
        RAISE EXCEPTION 'rascunho não pode carregar dados de assinatura'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_registro_upd BEFORE UPDATE ON registro_clinico
  FOR EACH ROW EXECUTE FUNCTION trg_registro_before_update();

CREATE FUNCTION trg_registro_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM exigir_ctx();
  IF OLD.status <> 'rascunho' THEN
    RAISE EXCEPTION 'registro % não pode ser excluído (use anulação)', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF ctx_usuario() <> OLD.autor_usuario_id THEN
    RAISE EXCEPTION 'apenas o autor pode excluir o rascunho' USING ERRCODE = '42501'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_a_registro_del BEFORE DELETE ON registro_clinico
  FOR EACH ROW EXECUTE FUNCTION trg_registro_before_delete();

-- API explícita (equivalente a UPDATE status; as regras vivem no trigger e valem para qualquer caminho)
CREATE FUNCTION assinar_registro(p_registro uuid, p_tipo tipo_assinatura DEFAULT 'eletronica_simples',
  p_assinatura_externa jsonb DEFAULT NULL) RETURNS bytea LANGUAGE plpgsql AS $$
DECLARE v_hash bytea;
BEGIN
  UPDATE registro_clinico SET status = 'assinado', tipo_assinatura = p_tipo, assinatura_externa = p_assinatura_externa
   WHERE id = p_registro AND status = 'rascunho' RETURNING hash_conteudo INTO v_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'registro % não encontrado ou não está em rascunho', p_registro; END IF;
  RETURN v_hash;
END $$;

CREATE FUNCTION anular_registro(p_registro uuid, p_motivo text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE registro_clinico SET status = 'anulado', motivo_anulacao = p_motivo
   WHERE id = p_registro AND status = 'assinado';
  IF NOT FOUND THEN RAISE EXCEPTION 'registro % não encontrado ou não está assinado', p_registro; END IF;
END $$;

-- Guarda dos subtipos/filhos: só o autor edita, só enquanto o registro é rascunho
CREATE FUNCTION trg_subtipo_editavel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id uuid; r record;
BEGIN
  v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.registro_id ELSE NEW.registro_id END;
  IF TG_OP = 'UPDATE' AND NEW.registro_id <> OLD.registro_id THEN
    RAISE EXCEPTION 'registro_id é imutável'; END IF;
  SELECT status, autor_usuario_id, tipo INTO r FROM registro_clinico WHERE id = v_id;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;   -- cascata de exclusão de rascunho
    RAISE EXCEPTION 'registro % inexistente', v_id;
  END IF;
  IF r.status <> 'rascunho' THEN
    RAISE EXCEPTION 'registro % está %: conteúdo imutável (use adendo)', v_id, r.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM exigir_ctx();
  IF r.autor_usuario_id <> ctx_usuario() THEN
    RAISE EXCEPTION 'apenas o autor pode editar o rascunho' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'INSERT' AND TG_NARGS > 0 AND NOT (r.tipo::text = ANY (TG_ARGV)) THEN
    RAISE EXCEPTION 'tabela % não é válida para registros do tipo %', TG_TABLE_NAME, r.tipo;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- ---------------------------------------------------------------------
-- I. ADENDO (correção rastreável de registro assinado)
-- ---------------------------------------------------------------------
CREATE FUNCTION trg_adendo_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r registro_clinico;
BEGIN
  PERFORM exigir_ctx();
  SELECT * INTO r FROM registro_clinico WHERE id = NEW.registro_id;
  IF NOT FOUND OR r.status <> 'assinado' THEN
    RAISE EXCEPTION 'adendo só se aplica a registro assinado (rascunhos são editados; anulados são finais)'; END IF;
  IF NOT (pode_escrever_registro(r.tipo, r.internacao_id) AND tem_permissao('clinico.assinar')) THEN
    RAISE EXCEPTION 'sem permissão para registrar adendo' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profissional WHERE usuario_id = ctx_usuario()) THEN
    RAISE EXCEPTION 'adendo exige profissional com registro no conselho'; END IF;
  NEW.autor_usuario_id := ctx_usuario();
  NEW.criado_em := clock_timestamp();
  NEW.hash_conteudo := digest(convert_to(concat_ws('|', r.hash_conteudo::text, NEW.tipo::text,
      NEW.justificativa, NEW.conteudo, NEW.autor_usuario_id::text,
      to_char(NEW.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8'), 'sha256');
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_adendo_ins BEFORE INSERT ON registro_adendo
  FOR EACH ROW EXECUTE FUNCTION trg_adendo_before_insert();
CREATE TRIGGER trg_b_adendo_imut BEFORE UPDATE OR DELETE ON registro_adendo
  FOR EACH ROW EXECUTE FUNCTION trg_somente_insercao();

-- ---------------------------------------------------------------------
-- J. INTERNAÇÃO: admissão, movimentação de leito, encerramento
-- ---------------------------------------------------------------------
CREATE FUNCTION acesso_internacao_adm(p_int uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
DECLARE v_h uuid; v_o uuid;
BEGIN
  SELECT hospital_id, organizacao_id INTO v_h, v_o FROM internacao WHERE id = p_int;
  IF NOT FOUND OR v_o IS DISTINCT FROM ctx_org() OR NOT tem_vinculo_hospital(v_h) THEN RETURN false; END IF;
  RETURN na_equipe(p_int) OR ctx_papel() IN ('administrativo','medico_administrador','auditor');
END $$;

CREATE FUNCTION paciente_visivel(p_pac uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM paciente p
                  WHERE p.id = p_pac AND p.organizacao_id = ctx_org()
                    AND (p.criado_por = ctx_usuario() OR paciente_vinculado_a_meus_hospitais(p.id))) $$;

CREATE FUNCTION pode_ler_assistencial_paciente(p_pac uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mednexo, public, pg_temp AS $$
  SELECT (tem_permissao('clinico.ler') OR tem_permissao('clinico.ler.assistencial'))
     AND EXISTS (SELECT 1 FROM internacao i WHERE i.paciente_id = p_pac
                    AND i.organizacao_id = ctx_org() AND acesso_internacao(i.id, false)) $$;

CREATE FUNCTION trg_internacao_before_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mednexo, public, pg_temp AS $$
DECLARE p record; h record; v_user uuid;
BEGIN
  PERFORM exigir_ctx();
  IF NEW.organizacao_id IS DISTINCT FROM ctx_org() THEN
    RAISE EXCEPTION 'organização da internação difere da sessão' USING ERRCODE = '42501'; END IF;
  IF NEW.status <> 'internado' THEN RAISE EXCEPTION 'internação nasce com status internado'; END IF;
  SELECT ativo, mesclado_em_id, data_obito INTO p FROM paciente
   WHERE id = NEW.paciente_id AND organizacao_id = NEW.organizacao_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'paciente inexistente'; END IF;
  IF p.mesclado_em_id IS NOT NULL THEN RAISE EXCEPTION 'cadastro de paciente foi mesclado em outro; use o cadastro principal'; END IF;
  IF NOT p.ativo THEN RAISE EXCEPTION 'paciente inativo'; END IF;
  IF p.data_obito IS NOT NULL THEN RAISE EXCEPTION 'paciente com óbito registrado'; END IF;
  SELECT i.id, ho.nome_fantasia INTO h FROM internacao i JOIN hospital ho ON ho.id = i.hospital_id
   WHERE i.paciente_id = NEW.paciente_id AND i.status = 'internado' LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'paciente já está internado em "%" (internação %)', h.nome_fantasia, h.id; END IF;
  IF NOT (SELECT ativo FROM hospital WHERE id = NEW.hospital_id) THEN RAISE EXCEPTION 'hospital inativo'; END IF;
  IF NEW.data_admissao > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'data de admissão no futuro'; END IF;
  SELECT usuario_id INTO v_user FROM profissional WHERE id = NEW.profissional_responsavel_id;
  IF NOT EXISTS (SELECT 1 FROM membro_hospital mh JOIN organizacao_membro m ON m.id = mh.membro_id
                  WHERE m.organizacao_id = NEW.organizacao_id AND m.usuario_id = v_user AND m.ativo
                    AND mh.ativo AND mh.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'médico responsável sem vínculo ativo com este hospital'; END IF;
  NEW.numero := proximo_numero(NEW.organizacao_id, 'internacao');
  NEW.criado_por := ctx_usuario();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_internacao_ins BEFORE INSERT ON internacao
  FOR EACH ROW EXECUTE FUNCTION trg_internacao_before_insert();

CREATE FUNCTION trg_internacao_after_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mednexo, public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT usuario_id INTO v_user FROM profissional WHERE id = NEW.profissional_responsavel_id;
  INSERT INTO internacao_equipe (organizacao_id, internacao_id, usuario_id, funcao, inicio)
  VALUES (NEW.organizacao_id, NEW.id, v_user, 'responsavel', NEW.data_admissao);
  INSERT INTO paciente_hospital (organizacao_id, paciente_id, hospital_id)
  VALUES (NEW.organizacao_id, NEW.paciente_id, NEW.hospital_id) ON CONFLICT (paciente_id, hospital_id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_b_internacao_ins_after AFTER INSERT ON internacao
  FOR EACH ROW EXECUTE FUNCTION trg_internacao_after_insert();

CREATE FUNCTION trg_internacao_before_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mednexo, public, pg_temp AS $$
DECLARE v_rasc int; v_perm text[] := ARRAY['comunicado_ministerio_publico_em','numero_autorizacao',
  'data_autorizacao','paciente_convenio_id','atualizado_em'];
BEGIN
  IF (NEW.id, NEW.paciente_id, NEW.hospital_id, NEW.organizacao_id, NEW.numero)
     IS DISTINCT FROM (OLD.id, OLD.paciente_id, OLD.hospital_id, OLD.organizacao_id, OLD.numero) THEN
    RAISE EXCEPTION 'paciente/hospital/número da internação são imutáveis' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD.status = 'encerrada' THEN
    IF (to_jsonb(NEW) - v_perm) <> (to_jsonb(OLD) - v_perm) THEN
      RAISE EXCEPTION 'internação encerrada é imutável (apenas dados administrativos tardios)'
        USING ERRCODE = 'restrict_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'encerrada' THEN
    IF NEW.motivo_encerramento IS NULL THEN RAISE EXCEPTION 'motivo do encerramento obrigatório'; END IF;
    IF NEW.data_alta IS NULL THEN NEW.data_alta := clock_timestamp(); END IF;
    IF NEW.motivo_encerramento NOT IN ('evasao','obito') AND NOT EXISTS (
         SELECT 1 FROM registro_clinico WHERE internacao_id = NEW.id AND tipo = 'resumo_alta' AND status = 'assinado') THEN
      RAISE EXCEPTION 'encerramento exige resumo de alta assinado'; END IF;
    SELECT count(*) INTO v_rasc FROM registro_clinico WHERE internacao_id = NEW.id AND status = 'rascunho';
    IF v_rasc > 0 THEN
      RAISE EXCEPTION 'há % registro(s) em rascunho: assine ou exclua antes de encerrar a internação', v_rasc; END IF;
    UPDATE internacao_movimentacao SET fim = NEW.data_alta WHERE internacao_id = NEW.id AND fim IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_internacao_upd BEFORE UPDATE ON internacao
  FOR EACH ROW EXECUTE FUNCTION trg_internacao_before_update();

CREATE FUNCTION encerrar_internacao(p_id uuid, p_motivo motivo_encerramento, p_destino text,
  p_data_alta timestamptz DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE internacao SET status = 'encerrada', motivo_encerramento = p_motivo, destino_alta = p_destino,
         data_alta = coalesce(p_data_alta, clock_timestamp())
   WHERE id = p_id AND status = 'internado';
  IF NOT FOUND THEN RAISE EXCEPTION 'internação % não encontrada ou já encerrada', p_id; END IF;
END $$;

CREATE FUNCTION trg_movimentacao_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM internacao WHERE id = NEW.internacao_id) <> 'internado' THEN
    RAISE EXCEPTION 'internação encerrada: não há movimentação de leito'; END IF;
  UPDATE internacao_movimentacao SET fim = NEW.inicio WHERE internacao_id = NEW.internacao_id AND fim IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_b_mov_ins BEFORE INSERT ON internacao_movimentacao
  FOR EACH ROW EXECUTE FUNCTION trg_movimentacao_before_insert();

-- ---------------------------------------------------------------------
-- K. OUTRAS REGRAS DE INTEGRIDADE
-- ---------------------------------------------------------------------
CREATE FUNCTION trg_paciente_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organizacao_id, NEW.numero) IS DISTINCT FROM (OLD.id, OLD.organizacao_id, OLD.numero) THEN
    RAISE EXCEPTION 'identificador/organização/número do paciente são imutáveis'; END IF;
  IF OLD.mesclado_em_id IS NOT NULL AND NEW.mesclado_em_id IS DISTINCT FROM OLD.mesclado_em_id THEN
    RAISE EXCEPTION 'mesclagem não pode ser desfeita por update'; END IF;
  IF NEW.alergias_status = 'sem_alergias_conhecidas' AND EXISTS (
       SELECT 1 FROM paciente_alergia WHERE paciente_id = NEW.id AND situacao = 'ativa') THEN
    RAISE EXCEPTION 'há alergias ativas registradas: não é possível declarar "sem alergias conhecidas"'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_paciente_upd BEFORE UPDATE ON paciente
  FOR EACH ROW EXECUTE FUNCTION trg_paciente_before_update();

CREATE FUNCTION trg_alergia_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mednexo, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM paciente_alergia WHERE paciente_id = NEW.paciente_id AND situacao = 'ativa') THEN
    UPDATE paciente SET alergias_status = 'possui_alergias'
     WHERE id = NEW.paciente_id AND alergias_status <> 'possui_alergias';
  ELSE
    UPDATE paciente SET alergias_status = 'nao_avaliado'
     WHERE id = NEW.paciente_id AND alergias_status = 'possui_alergias';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_b_alergia_sync AFTER INSERT OR UPDATE ON paciente_alergia
  FOR EACH ROW EXECUTE FUNCTION trg_alergia_sync();

CREATE FUNCTION trg_diagnostico_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.cid_id, NEW.paciente_id, NEW.internacao_id, NEW.registrado_por, NEW.registrado_em)
     IS DISTINCT FROM (OLD.cid_id, OLD.paciente_id, OLD.internacao_id, OLD.registrado_por, OLD.registrado_em) THEN
    RAISE EXCEPTION 'para trocar o CID, encerre este diagnóstico e registre outro (histórico preservado)'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_diag_upd BEFORE UPDATE ON diagnostico
  FOR EACH ROW EXECUTE FUNCTION trg_diagnostico_before_update();

CREATE FUNCTION trg_exame_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'resultado_disponivel' THEN
    RAISE EXCEPTION 'resultado de exame é imutável: registre nova linha com substitui_exame_id'
      USING ERRCODE = 'restrict_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_exame_upd BEFORE UPDATE ON exame
  FOR EACH ROW EXECUTE FUNCTION trg_exame_before_update();

CREATE FUNCTION trg_arquivo_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.invalidado_em IS NOT NULL THEN RAISE EXCEPTION 'arquivo já invalidado'; END IF;
  IF (to_jsonb(NEW) - ARRAY['invalidado_em','invalidado_por','motivo_invalidacao'])
     <> (to_jsonb(OLD) - ARRAY['invalidado_em','invalidado_por','motivo_invalidacao']) THEN
    RAISE EXCEPTION 'arquivo é imutável (apenas invalidação com motivo)' USING ERRCODE = 'restrict_violation'; END IF;
  NEW.invalidado_por := ctx_usuario();
  NEW.invalidado_em := coalesce(NEW.invalidado_em, clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a_arquivo_upd BEFORE UPDATE ON arquivo
  FOR EACH ROW EXECUTE FUNCTION trg_arquivo_before_update();

-- ---------------------------------------------------------------------
-- L. ANEXAR TRIGGERS GENÉRICOS
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hospital','paciente','internacao'] LOOP
    EXECUTE format('CREATE TRIGGER trg_z_atualizado BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_atualizado_em()', t);
  END LOOP;

  EXECUTE 'CREATE TRIGGER trg_a_numerar BEFORE INSERT ON paciente FOR EACH ROW EXECUTE FUNCTION trg_numerar(''paciente'')';

  -- tabela:coluna de autoria forçada a partir da sessão
  FOREACH t IN ARRAY ARRAY['paciente:criado_por','paciente_alergia:registrado_por','paciente_evento_historico:registrado_por',
      'paciente_medicacao_previa:registrado_por','diagnostico:registrado_por','exame:registrado_por',
      'arquivo:criado_por','pdf_gerado:gerado_por','compartilhamento_documento:usuario_id',
      'ia_interacao:usuario_id','internacao_movimentacao:registrado_por'] LOOP
    EXECUTE format('CREATE TRIGGER trg_a_autor BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION trg_forcar_autor(%L)',
                   split_part(t, ':', 1), split_part(t, ':', 2));
  END LOOP;

  -- nada clínico/cadastral é excluído
  FOREACH t IN ARRAY ARRAY['hospital','membro_hospital','unidade_internacao','leito','operadora','hospital_operadora',
      'hospital_contato','hospital_contrato_dados','paciente','paciente_responsavel','paciente_convenio','paciente_hospital',
      'internacao','internacao_clinico','internacao_equipe','internacao_movimentacao','paciente_alergia',
      'paciente_evento_historico','paciente_medicacao_previa','diagnostico','exame','arquivo','pdf_gerado',
      'compartilhamento_documento','ia_interacao'] LOOP
    EXECUTE format('CREATE TRIGGER trg_a_nodel BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_bloquear_delete()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pdf_gerado','compartilhamento_documento'] LOOP
    EXECUTE format('CREATE TRIGGER trg_a_appendonly BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_somente_insercao()', t);
  END LOOP;

  -- subtipos 1:1 (com lista de tipos de registro aceitos) e tabelas filhas
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON anamnese FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''anamnese'')';
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON exame_estado_mental FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''exame_estado_mental'')';
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON avaliacao_risco FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''avaliacao_risco'')';
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON evolucao FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''evolucao'')';
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON intercorrencia FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''intercorrencia'')';
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON prescricao FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''prescricao'')';
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON receita FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''receita'')';
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON resumo_alta FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''resumo_alta'')';
  EXECUTE 'CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON documento_clinico FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel(''parecer'',''relatorio'',''atestado'',''declaracao'',''encaminhamento'',''solicitacao_exames'')';
  FOREACH t IN ARRAY ARRAY['anamnese_substancia','eem_dominio','eem_item','avaliacao_risco_item','prescricao_item',
      'alerta_prescricao','receita_item','resumo_alta_diagnostico','registro_arquivo'] LOOP
    EXECUTE format('CREATE TRIGGER trg_a_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_subtipo_editavel()', t);
  END LOOP;

  -- auditoria de escrita em tudo que é cadastral/clínico
  FOREACH t IN ARRAY ARRAY['hospital','membro_hospital','unidade_internacao','leito','operadora','hospital_operadora',
      'hospital_contato','hospital_contrato_dados','paciente','paciente_responsavel','paciente_convenio','paciente_hospital',
      'internacao','internacao_clinico','internacao_equipe','internacao_movimentacao','paciente_alergia',
      'paciente_evento_historico','paciente_medicacao_previa','diagnostico','exame','arquivo','registro_arquivo',
      'registro_clinico','registro_adendo','anamnese','anamnese_substancia','exame_estado_mental','eem_dominio','eem_item',
      'avaliacao_risco','avaliacao_risco_item','evolucao','intercorrencia','prescricao','prescricao_item',
      'alerta_prescricao','receita','receita_item','documento_clinico','resumo_alta','resumo_alta_diagnostico',
      'pdf_gerado','compartilhamento_documento','modelo_documento','agenda_compromisso','regra_pendencia',
      'ia_interacao','organizacao_membro'] LOOP
    EXECUTE format('CREATE TRIGGER trg_zz_auditar AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_auditar()', t);
  END LOOP;
END $$;

-- Regras padrão de pendência para uma nova organização (ajustáveis pelo médico/hospital)
CREATE FUNCTION semear_regras_pendencia(p_org uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO regra_pendencia (organizacao_id, tipo, periodicidade_horas) VALUES
    (p_org, 'evolucao', 24), (p_org, 'avaliacao_risco', 24), (p_org, 'revisao_prescricao', 24),
    (p_org, 'comunicacao_ministerio_publico', 72)
  ON CONFLICT DO NOTHING $$;

-- ---------------------------------------------------------------------
-- M. VIEWS (security_invoker: RLS do usuário continua valendo)
-- ---------------------------------------------------------------------
CREATE VIEW vw_leito_atual WITH (security_invoker = true) AS
SELECT m.internacao_id, m.leito_id, l.identificacao AS leito, u.nome AS unidade, m.inicio
  FROM internacao_movimentacao m
  JOIN leito l ON l.id = m.leito_id
  JOIN unidade_internacao u ON u.id = l.unidade_id
 WHERE m.fim IS NULL;

CREATE VIEW vw_ultimo_risco WITH (security_invoker = true) AS
SELECT i.id AS internacao_id, i.paciente_id, ur.registro_id, ur.ocorrido_em AS avaliado_em,
       ur.nivel_risco_profissional AS nivel, ur.reavaliar_em,
       CASE WHEN ur.registro_id IS NULL THEN 'nunca_avaliado'
            WHEN ur.reavaliar_em IS NOT NULL AND ur.reavaliar_em < now() THEN 'reavaliacao_vencida'
            ELSE 'vigente' END AS situacao   -- nunca "seguro": só o profissional classifica
  FROM internacao i
  LEFT JOIN LATERAL (
    SELECT rc.id AS registro_id, rc.ocorrido_em, ar.nivel_risco_profissional, ar.reavaliar_em
      FROM registro_clinico rc JOIN avaliacao_risco ar ON ar.registro_id = rc.id
     WHERE rc.internacao_id = i.id AND rc.tipo = 'avaliacao_risco' AND rc.status = 'assinado'
     ORDER BY rc.ocorrido_em DESC, rc.assinado_em DESC LIMIT 1) ur ON true;

CREATE VIEW vw_medicacao_ativa WITH (security_invoker = true) AS
WITH ult AS (
  SELECT DISTINCT ON (rc.internacao_id) rc.id AS registro_id, rc.internacao_id, rc.paciente_id, p.valida_ate
    FROM registro_clinico rc JOIN prescricao p ON p.registro_id = rc.id
   WHERE rc.tipo = 'prescricao' AND rc.status = 'assinado' AND p.tipo = 'hospitalar'
   ORDER BY rc.internacao_id, rc.ocorrido_em DESC, rc.assinado_em DESC)
SELECT u.internacao_id, u.paciente_id, u.registro_id AS prescricao_registro_id, i.id AS item_id, i.ordem,
       pa.nome AS principio_ativo, ma.nome_comercial, ma.concentracao_valor, ma.concentracao_unidade,
       ma.forma_farmaceutica, i.dose_valor, i.dose_unidade, i.via, i.frequencia_tipo,
       i.intervalo_horas, i.vezes_dia, i.horarios, i.sos_indicacao, i.sos_dose_max_24h,
       i.data_inicio, i.data_fim, i.indicacao_clinica,
       (u.valida_ate IS NOT NULL AND u.valida_ate < now()) AS prescricao_vencida,
       (i.data_inicio > now()) AS inicio_futuro
  FROM ult u
  JOIN prescricao_item i ON i.registro_id = u.registro_id
  JOIN medicamento_apresentacao ma ON ma.id = i.apresentacao_id
  JOIN principio_ativo pa ON pa.id = ma.principio_ativo_id
 WHERE i.acao <> 'suspender' AND (i.data_fim IS NULL OR i.data_fim > now());

CREATE VIEW vw_paciente_cabecalho WITH (security_invoker = true) AS
SELECT i.id AS internacao_id, p.id AS paciente_id, p.codigo AS paciente_codigo, p.nome_completo, p.nome_social,
       date_part('year', age(current_date, p.data_nascimento))::int AS idade,
       CASE WHEN p.cpf IS NULL THEN NULL ELSE substr(p.cpf,1,3) || '.***.***-' || substr(p.cpf,10,2) END AS cpf_mascarado,
       h.nome_fantasia AS hospital, la.unidade, la.leito, i.data_admissao, i.status AS situacao_internacao,
       i.codigo AS internacao_codigo, i.modalidade,
       coalesce(op.nome, pc.cobertura::text) AS convenio,
       cid.codigo AS cid_principal, cid.descricao AS diagnostico_principal,
       p.alergias_status,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('agente', a.agente, 'gravidade', a.gravidade)), '[]'::jsonb)
          FROM paciente_alergia a WHERE a.paciente_id = p.id AND a.situacao = 'ativa') AS alergias_ativas,
       (SELECT count(*) FROM vw_medicacao_ativa m WHERE m.internacao_id = i.id) AS qtd_medicamentos_ativos,
       r.nivel AS risco_nivel, r.avaliado_em AS risco_avaliado_em, r.situacao AS risco_situacao
  FROM internacao i
  JOIN paciente p ON p.id = i.paciente_id
  JOIN hospital h ON h.id = i.hospital_id
  LEFT JOIN vw_leito_atual la ON la.internacao_id = i.id
  LEFT JOIN paciente_convenio pc ON pc.id = i.paciente_convenio_id
  LEFT JOIN operadora op ON op.id = pc.operadora_id
  LEFT JOIN diagnostico d ON d.internacao_id = i.id AND d.principal AND d.encerrado_em IS NULL
  LEFT JOIN cid ON cid.id = d.cid_id
  LEFT JOIN vw_ultimo_risco r ON r.internacao_id = i.id;

-- Existência de episódios (sem conteúdo clínico) — permite saber que há outra internação
CREATE VIEW vw_paciente_episodios AS
SELECT i.paciente_id, i.id AS internacao_id, i.codigo, h.nome_fantasia AS hospital, i.status,
       i.modalidade, i.data_admissao, i.data_alta
  FROM internacao i JOIN hospital h ON h.id = i.hospital_id
 WHERE i.organizacao_id = ctx_org() AND tem_permissao('paciente.cadastro.ler') AND paciente_visivel(i.paciente_id);

CREATE VIEW vw_linha_do_tempo WITH (security_invoker = true) AS
SELECT i.paciente_id, i.id AS internacao_id, i.hospital_id, i.data_admissao AS ocorrido_em,
       'admissao'::text AS evento, NULL::uuid AS registro_id, NULL::uuid AS autor_usuario_id, 'internado'::text AS status
  FROM internacao i
UNION ALL
SELECT rc.paciente_id, rc.internacao_id, rc.hospital_id, rc.ocorrido_em, rc.tipo::text, rc.id,
       rc.autor_usuario_id, rc.status::text
  FROM registro_clinico rc WHERE rc.status <> 'rascunho'
UNION ALL
SELECT i.paciente_id, i.id, i.hospital_id, i.data_alta, 'alta:' || i.motivo_encerramento::text, NULL, NULL, 'encerrada'
  FROM internacao i WHERE i.status = 'encerrada';

CREATE VIEW vw_pendencias WITH (security_invoker = true) AS
WITH base AS (
  SELECT i.id AS internacao_id, i.paciente_id, i.hospital_id, i.organizacao_id, i.modalidade,
         i.data_admissao, i.comunicado_ministerio_publico_em,
         (SELECT max(rc.ocorrido_em) FROM registro_clinico rc WHERE rc.internacao_id = i.id
             AND rc.tipo = 'evolucao' AND rc.status = 'assinado') AS ult_evolucao,
         (SELECT max(rc.ocorrido_em) FROM registro_clinico rc WHERE rc.internacao_id = i.id
             AND rc.tipo = 'avaliacao_risco' AND rc.status = 'assinado') AS ult_risco,
         (SELECT max(ar.reavaliar_em) FROM registro_clinico rc JOIN avaliacao_risco ar ON ar.registro_id = rc.id
           WHERE rc.id = (SELECT rc2.id FROM registro_clinico rc2 WHERE rc2.internacao_id = i.id
                            AND rc2.tipo = 'avaliacao_risco' AND rc2.status = 'assinado'
                          ORDER BY rc2.ocorrido_em DESC, rc2.assinado_em DESC LIMIT 1)) AS risco_reavaliar_em,
         (SELECT max(p.valida_ate) FROM registro_clinico rc JOIN prescricao p ON p.registro_id = rc.id
           WHERE rc.id = (SELECT rc2.id FROM registro_clinico rc2 JOIN prescricao p2 ON p2.registro_id = rc2.id
                           WHERE rc2.internacao_id = i.id AND rc2.status = 'assinado' AND p2.tipo = 'hospitalar'
                           ORDER BY rc2.ocorrido_em DESC, rc2.assinado_em DESC LIMIT 1)) AS presc_valida_ate,
         (SELECT count(*) FROM registro_clinico rc WHERE rc.internacao_id = i.id
             AND rc.tipo = 'prescricao' AND rc.status = 'assinado') AS qtd_prescricoes
    FROM internacao i WHERE i.status = 'internado'),
regra AS (
  SELECT b.internacao_id, t.tipo,
         coalesce((SELECT r.periodicidade_horas FROM regra_pendencia r
                    WHERE r.organizacao_id = b.organizacao_id AND r.tipo = t.tipo AND r.ativa
                      AND (r.hospital_id = b.hospital_id OR r.hospital_id IS NULL)
                    ORDER BY (r.hospital_id IS NULL) LIMIT 1),
                  CASE t.tipo WHEN 'comunicacao_ministerio_publico' THEN 72 ELSE 24 END) AS horas,
         NOT EXISTS (SELECT 1 FROM regra_pendencia r WHERE r.organizacao_id = b.organizacao_id AND r.tipo = t.tipo
                      AND NOT r.ativa AND (r.hospital_id = b.hospital_id OR r.hospital_id IS NULL)
                      AND NOT EXISTS (SELECT 1 FROM regra_pendencia r2 WHERE r2.organizacao_id = b.organizacao_id
                         AND r2.tipo = t.tipo AND r2.ativa AND (r2.hospital_id = b.hospital_id OR r2.hospital_id IS NULL))) AS habilitada
    FROM base b CROSS JOIN (VALUES ('evolucao'::tipo_pendencia), ('avaliacao_risco'), ('revisao_prescricao'),
                                   ('comunicacao_ministerio_publico')) t(tipo))
SELECT b.internacao_id, b.paciente_id, b.hospital_id, 'evolucao'::tipo_pendencia AS tipo,
       b.ult_evolucao AS referencia_em, 'sem evolução assinada nas últimas ' || r.horas || ' h' AS detalhe
  FROM base b JOIN regra r ON r.internacao_id = b.internacao_id AND r.tipo = 'evolucao'
 WHERE r.habilitada AND (b.ult_evolucao IS NULL OR b.ult_evolucao < now() - make_interval(hours => r.horas))
UNION ALL
SELECT b.internacao_id, b.paciente_id, b.hospital_id, 'avaliacao_risco', b.ult_risco,
       CASE WHEN b.ult_risco IS NULL THEN 'nenhuma avaliação de risco assinada'
            WHEN b.risco_reavaliar_em < now() THEN 'reavaliação programada vencida'
            ELSE 'sem avaliação de risco nas últimas ' || r.horas || ' h' END
  FROM base b JOIN regra r ON r.internacao_id = b.internacao_id AND r.tipo = 'avaliacao_risco'
 WHERE r.habilitada AND (b.ult_risco IS NULL OR b.risco_reavaliar_em < now()
                         OR b.ult_risco < now() - make_interval(hours => r.horas))
UNION ALL
SELECT b.internacao_id, b.paciente_id, b.hospital_id, 'revisao_prescricao', b.presc_valida_ate,
       CASE WHEN b.qtd_prescricoes = 0 THEN 'nenhuma prescrição assinada' ELSE 'prescrição vigente vencida' END
  FROM base b JOIN regra r ON r.internacao_id = b.internacao_id AND r.tipo = 'revisao_prescricao'
 WHERE r.habilitada AND (b.qtd_prescricoes = 0 OR b.presc_valida_ate < now())
UNION ALL
SELECT b.internacao_id, b.paciente_id, b.hospital_id, 'comunicacao_ministerio_publico', b.data_admissao,
       'internação involuntária/compulsória sem comunicação ao Ministério Público (prazo legal 72 h)'
  FROM base b JOIN regra r ON r.internacao_id = b.internacao_id AND r.tipo = 'comunicacao_ministerio_publico'
 WHERE r.habilitada AND b.modalidade = 'involuntaria' AND b.comunicado_ministerio_publico_em IS NULL
   AND b.data_admissao < now() - make_interval(hours => r.horas)
UNION ALL
SELECT i.id, i.paciente_id, i.hospital_id, 'resumo_alta', i.data_alta, 'internação encerrada sem resumo de alta assinado'
  FROM internacao i
 WHERE i.status = 'encerrada' AND NOT EXISTS (SELECT 1 FROM registro_clinico rc
         WHERE rc.internacao_id = i.id AND rc.tipo = 'resumo_alta' AND rc.status = 'assinado');

CREATE VIEW vw_painel_internados WITH (security_invoker = true) AS
SELECT c.internacao_id, c.paciente_id, c.nome_completo, c.hospital, c.unidade, c.leito, c.idade,
       c.cid_principal, c.diagnostico_principal, c.data_admissao, c.alergias_status, c.risco_nivel, c.risco_situacao,
       (SELECT max(rc.ocorrido_em) FROM registro_clinico rc WHERE rc.internacao_id = c.internacao_id
           AND rc.tipo = 'evolucao' AND rc.status = 'assinado') AS ultima_evolucao_em,
       (SELECT count(*) FROM vw_pendencias pd WHERE pd.internacao_id = c.internacao_id) AS qtd_pendencias
  FROM vw_paciente_cabecalho c WHERE c.situacao_internacao = 'internado';

-- ---------------------------------------------------------------------
-- N. PAPÉIS DO BANCO, GRANTS E ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mednexo_app') THEN
    CREATE ROLE mednexo_app NOLOGIN NOBYPASSRLS;       -- a API usa este papel (LOGIN definido no deploy)
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mednexo_auth') THEN
    CREATE ROLE mednexo_auth NOLOGIN NOBYPASSRLS;      -- serviço de login (único que lê senha_hash/MFA)
  END IF;
END $$;

REVOKE ALL ON SCHEMA mednexo FROM PUBLIC;
GRANT USAGE ON SCHEMA mednexo TO mednexo_app, mednexo_auth;

CREATE PROCEDURE criar_politicas(p_tab text, p_sel text, p_esc text, p_del boolean DEFAULT false)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_tab);
  EXECUTE format('CREATE POLICY p_sel ON %I FOR SELECT USING (%s)', p_tab, p_sel);
  EXECUTE format('CREATE POLICY p_ins ON %I FOR INSERT WITH CHECK (%s)', p_tab, p_esc);
  EXECUTE format('CREATE POLICY p_upd ON %I FOR UPDATE USING ((%s) AND (%s)) WITH CHECK (%s)', p_tab, p_sel, p_esc, p_esc);
  IF p_del THEN EXECUTE format('CREATE POLICY p_del ON %I FOR DELETE USING (%s)', p_tab, p_esc); END IF;
END $$;

DO $$
DECLARE
  t text;
  org text := 'organizacao_id = ctx_org()';
  sub_sel text := 'pode_ler_registro(registro_id)';
  sub_esc text := 'pode_ler_registro(registro_id) AND (tem_permissao(''clinico.escrever'') OR tem_permissao(''clinico.escrever.parecer''))';
BEGIN
  -- organização / membros
  EXECUTE 'ALTER TABLE organizacao ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY p_sel ON organizacao FOR SELECT USING (id = ctx_org())';
  CALL criar_politicas('organizacao_membro', org, org || ' AND tem_permissao(''usuario.gerir'')');
  CALL criar_politicas('membro_hospital', org, org || ' AND tem_permissao(''usuario.gerir'')');
  EXECUTE 'ALTER TABLE contador ENABLE ROW LEVEL SECURITY';   -- sem políticas: só funções SECURITY DEFINER

  -- hospitais
  CALL criar_politicas('hospital', org || ' AND (tem_vinculo_hospital(id) OR tem_permissao(''cadastro.hospital.gerir''))',
                       org || ' AND tem_permissao(''cadastro.hospital.gerir'')');
  FOREACH t IN ARRAY ARRAY['unidade_internacao','leito','hospital_operadora','hospital_contato','hospital_contrato_dados'] LOOP
    CALL criar_politicas(t, org || ' AND (tem_vinculo_hospital(hospital_id) OR tem_permissao(''cadastro.hospital.gerir''))',
                            org || ' AND tem_permissao(''cadastro.hospital.gerir'')');
  END LOOP;
  CALL criar_politicas('operadora', org, org || ' AND tem_permissao(''cadastro.hospital.gerir'')');
  CALL criar_politicas('modelo_documento', org, org || ' AND tem_permissao(''cadastro.hospital.gerir'')');
  CALL criar_politicas('regra_pendencia', org, org || ' AND tem_permissao(''cadastro.hospital.gerir'')');

  -- paciente (cadastro)
  CALL criar_politicas('paciente',
    org || ' AND tem_permissao(''paciente.cadastro.ler'') AND (criado_por = ctx_usuario() OR paciente_vinculado_a_meus_hospitais(id))',
    org || ' AND tem_permissao(''paciente.cadastro.escrever'')');
  FOREACH t IN ARRAY ARRAY['paciente_responsavel','paciente_convenio'] LOOP
    CALL criar_politicas(t, org || ' AND tem_permissao(''paciente.cadastro.ler'') AND paciente_visivel(paciente_id)',
                            org || ' AND tem_permissao(''paciente.cadastro.escrever'') AND paciente_visivel(paciente_id)');
  END LOOP;
  CALL criar_politicas('paciente_hospital', org || ' AND tem_permissao(''paciente.cadastro.ler'') AND paciente_visivel(paciente_id)',
    org || ' AND tem_permissao(''paciente.cadastro.escrever'') AND tem_vinculo_hospital(hospital_id)');

  -- internação (administrativo x clínico separados)
  CALL criar_politicas('internacao',
    org || ' AND tem_vinculo_hospital(hospital_id) AND (criado_por = ctx_usuario() OR na_equipe(id) OR ctx_papel() IN (''administrativo'',''medico_administrador'',''auditor''))',
    org || ' AND tem_vinculo_hospital(hospital_id) AND tem_permissao(''internacao.escrever'')');
  CALL criar_politicas('internacao_clinico',
    org || ' AND tem_permissao(''clinico.ler'') AND acesso_internacao(internacao_id, false)',
    org || ' AND tem_permissao(''clinico.escrever'') AND acesso_internacao(internacao_id, true)');
  CALL criar_politicas('internacao_equipe', org || ' AND (usuario_id = ctx_usuario() OR acesso_internacao_adm(internacao_id))',
    org || ' AND tem_permissao(''equipe.gerir'') AND acesso_internacao_adm(internacao_id)');
  CALL criar_politicas('internacao_movimentacao', org || ' AND acesso_internacao_adm(internacao_id)',
    org || ' AND tem_permissao(''internacao.escrever'') AND acesso_internacao_adm(internacao_id)');

  -- histórico longitudinal do paciente
  CALL criar_politicas('paciente_alergia',
    org || ' AND (pode_ler_clinico_paciente(paciente_id) OR pode_ler_assistencial_paciente(paciente_id))',
    org || ' AND pode_escrever_clinico_paciente(paciente_id)');
  FOREACH t IN ARRAY ARRAY['paciente_evento_historico','paciente_medicacao_previa','diagnostico'] LOOP
    CALL criar_politicas(t, org || ' AND pode_ler_clinico_paciente(paciente_id)',
                            org || ' AND pode_escrever_clinico_paciente(paciente_id)');
  END LOOP;
  CALL criar_politicas('exame',
    org || ' AND (tem_permissao(''clinico.ler'') OR tem_permissao(''clinico.ler.assistencial'')) AND acesso_internacao(internacao_id, false)',
    org || ' AND tem_permissao(''clinico.escrever'') AND acesso_internacao(internacao_id, true)');

  -- registro clínico e subtipos
  CALL criar_politicas('registro_clinico',
    org || ' AND (status <> ''rascunho'' OR autor_usuario_id = ctx_usuario()) AND pode_ler_tipo(tipo, internacao_id)',
    org || ' AND pode_escrever_registro(tipo, internacao_id)', true);
  FOREACH t IN ARRAY ARRAY['anamnese','anamnese_substancia','exame_estado_mental','eem_dominio','eem_item',
      'avaliacao_risco','avaliacao_risco_item','evolucao','intercorrencia','prescricao','prescricao_item',
      'alerta_prescricao','receita','receita_item','documento_clinico','resumo_alta','resumo_alta_diagnostico',
      'registro_arquivo'] LOOP
    CALL criar_politicas(t, sub_sel, sub_esc, true);
  END LOOP;
  CALL criar_politicas('registro_adendo', org || ' AND pode_ler_registro(registro_id)',
                       org || ' AND pode_ler_registro(registro_id) AND tem_permissao(''clinico.assinar'')');

  -- arquivos, PDFs, compartilhamento, agenda, IA
  CALL criar_politicas('arquivo', org || ' AND pode_ler_arquivo(categoria, paciente_id)',
    org || ' AND (tem_permissao(''paciente.cadastro.escrever'') OR tem_permissao(''clinico.escrever''))');
  CALL criar_politicas('pdf_gerado', org || ' AND pode_ler_clinico_paciente(paciente_id)',
    org || ' AND tem_permissao(''documento.exportar'') AND pode_ler_clinico_paciente(paciente_id)');
  CALL criar_politicas('compartilhamento_documento', org || ' AND (usuario_id = ctx_usuario() OR tem_permissao(''auditoria.ler''))',
    org || ' AND tem_permissao(''documento.compartilhar'')');
  CALL criar_politicas('agenda_compromisso', org || ' AND usuario_id = ctx_usuario()', org || ' AND usuario_id = ctx_usuario()', true);
  CALL criar_politicas('ia_interacao', org || ' AND (usuario_id = ctx_usuario() OR tem_permissao(''auditoria.ler''))',
    org || ' AND tem_permissao(''ia.usar'')');

  -- auditoria: leitura só para quem tem permissão; ninguém escreve direto (só funções SECURITY DEFINER)
  EXECUTE 'ALTER TABLE auditoria_evento ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY p_sel ON auditoria_evento FOR SELECT USING (organizacao_id = ctx_org() AND tem_permissao(''auditoria.ler''))';
END $$;

-- Privilégios de tabela
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'mednexo' LOOP
    EXECUTE format('GRANT SELECT ON %I TO mednexo_app', t);
  END LOOP;
  FOR t IN SELECT viewname FROM pg_views WHERE schemaname = 'mednexo' LOOP
    EXECUTE format('GRANT SELECT ON %I TO mednexo_app', t);
  END LOOP;
  REVOKE ALL ON contador FROM mednexo_app;
  -- escrita (INSERT/UPDATE); exclusão só onde faz sentido (rascunhos e agenda)
  FOREACH t IN ARRAY ARRAY['organizacao_membro','membro_hospital','hospital','unidade_internacao','leito','operadora',
      'hospital_operadora','hospital_contato','hospital_contrato_dados','paciente','paciente_responsavel',
      'paciente_convenio','paciente_hospital','internacao','internacao_clinico','internacao_equipe',
      'internacao_movimentacao','paciente_alergia','paciente_evento_historico','paciente_medicacao_previa',
      'diagnostico','exame','arquivo','registro_clinico','anamnese','anamnese_substancia','exame_estado_mental',
      'eem_dominio','eem_item','avaliacao_risco','avaliacao_risco_item','evolucao','intercorrencia','prescricao',
      'prescricao_item','alerta_prescricao','receita','receita_item','documento_clinico','resumo_alta',
      'resumo_alta_diagnostico','registro_arquivo','modelo_documento','agenda_compromisso','regra_pendencia',
      'ia_interacao'] LOOP
    EXECUTE format('GRANT INSERT, UPDATE ON %I TO mednexo_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['registro_adendo','pdf_gerado','compartilhamento_documento'] LOOP
    EXECUTE format('GRANT INSERT ON %I TO mednexo_app', t);          -- append-only
  END LOOP;
  FOREACH t IN ARRAY ARRAY['registro_clinico','anamnese','anamnese_substancia','exame_estado_mental','eem_dominio',
      'eem_item','avaliacao_risco','avaliacao_risco_item','evolucao','intercorrencia','prescricao','prescricao_item',
      'alerta_prescricao','receita','receita_item','documento_clinico','resumo_alta','resumo_alta_diagnostico',
      'registro_arquivo','agenda_compromisso'] LOOP
    EXECUTE format('GRANT DELETE ON %I TO mednexo_app', t);
  END LOOP;
END $$;

-- usuário/profissional: a API enxerga só colunas não sensíveis; o serviço de login enxerga o resto
REVOKE ALL ON usuario FROM mednexo_app;
GRANT SELECT (id, email, nome_completo, ativo, mfa_ativo) ON usuario TO mednexo_app;
GRANT SELECT, UPDATE ON usuario TO mednexo_auth;
GRANT SELECT ON organizacao_membro, profissional TO mednexo_auth;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mednexo TO mednexo_app;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA mednexo TO mednexo_app;
