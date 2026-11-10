-- =====================================================================
-- MEDNEXO — PEP multi-hospital  |  01_estrutura.sql
-- PostgreSQL 15+ (testado em 16). Tipos, tabelas, chaves e constraints.
-- Convenções:
--   * schema "mednexo"; PK uuid; timestamps em timestamptz (UTC no banco)
--   * multi-tenant: toda tabela de negócio tem organizacao_id
--   * FKs compostas (id, organizacao_id) impedem referência entre tenants
--   * NADA clínico é apagado: soft-status + triggers (ver 02_integridade.sql)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS mednexo;
SET search_path = mednexo, public;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


-- ---------------------------------------------------------------------
-- FUNÇÕES BASE (usadas em colunas geradas e CHECKs)
-- ---------------------------------------------------------------------
CREATE FUNCTION f_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, btrim(regexp_replace(coalesce(t,''), '\s+', ' ', 'g')))) $$;

CREATE FUNCTION cpf_valido(c text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s int; r int; i int;
BEGIN
  IF c IS NULL OR c !~ '^[0-9]{11}$' OR c ~ '^(.)\1{10}$' THEN RETURN false; END IF;
  s := 0; FOR i IN 1..9  LOOP s := s + substr(c,i,1)::int * (11 - i); END LOOP;
  r := (s * 10) % 11; IF r = 10 THEN r := 0; END IF;
  IF r <> substr(c,10,1)::int THEN RETURN false; END IF;
  s := 0; FOR i IN 1..10 LOOP s := s + substr(c,i,1)::int * (12 - i); END LOOP;
  r := (s * 10) % 11; IF r = 10 THEN r := 0; END IF;
  RETURN r = substr(c,11,1)::int;
END $$;

CREATE FUNCTION cnpj_valido(c text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE w1 int[] := ARRAY[5,4,3,2,9,8,7,6,5,4,3,2]; w2 int[] := ARRAY[6,5,4,3,2,9,8,7,6,5,4,3,2];
        s int; r int; i int;
BEGIN
  IF c IS NULL OR c !~ '^[0-9]{14}$' OR c ~ '^(.)\1{13}$' THEN RETURN false; END IF;
  s := 0; FOR i IN 1..12 LOOP s := s + substr(c,i,1)::int * w1[i]; END LOOP;
  r := s % 11; r := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  IF r <> substr(c,13,1)::int THEN RETURN false; END IF;
  s := 0; FOR i IN 1..13 LOOP s := s + substr(c,i,1)::int * w2[i]; END LOOP;
  r := s % 11; r := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  RETURN r = substr(c,14,1)::int;
END $$;

-- ---------------------------------------------------------------------
-- 0. TIPOS ENUMERADOS
-- ---------------------------------------------------------------------
CREATE TYPE papel_usuario AS ENUM ('admin_plataforma','medico_administrador','medico_assistente',
  'medico_consultor','enfermagem','auditor','administrativo');
CREATE TYPE tipo_instituicao AS ENUM ('hospital_psiquiatrico','hospital_geral','clinica','caps','outro');
CREATE TYPE sexo_registrado AS ENUM ('masculino','feminino','intersexo','nao_informado');
CREATE TYPE tipo_cobertura AS ENUM ('convenio','sus','particular');
CREATE TYPE status_internacao AS ENUM ('internado','encerrada');
CREATE TYPE modalidade_internacao AS ENUM ('voluntaria','involuntaria','compulsoria');
CREATE TYPE motivo_encerramento AS ENUM ('alta_melhora','alta_a_pedido','alta_administrativa',
  'transferencia','evasao','obito','outro');
CREATE TYPE funcao_equipe AS ENUM ('responsavel','assistente','consultor','enfermagem');
CREATE TYPE tipo_movimentacao AS ENUM ('admissao','troca_leito','transferencia_unidade');

CREATE TYPE tipo_registro AS ENUM ('anamnese','exame_estado_mental','avaliacao_risco','evolucao',
  'intercorrencia','prescricao','receita','parecer','relatorio','atestado','declaracao',
  'encaminhamento','solicitacao_exames','resumo_alta');
CREATE TYPE status_registro AS ENUM ('rascunho','assinado','anulado');
CREATE TYPE tipo_assinatura AS ENUM ('eletronica_simples','icp_brasil');

CREATE TYPE situacao_diagnostico AS ENUM ('hipotese','confirmado','descartado','resolvido');
CREATE TYPE momento_diagnostico AS ENUM ('admissao','curso','alta','historico');
CREATE TYPE versao_cid AS ENUM ('CID-10','CID-11');
CREATE TYPE categoria_alergia AS ENUM ('medicamento','alimento','ambiental','outro');
CREATE TYPE gravidade_alergia AS ENUM ('leve','moderada','grave','anafilaxia','desconhecida');
CREATE TYPE situacao_alergia AS ENUM ('ativa','inativa','registrada_por_engano');
CREATE TYPE alergias_status AS ENUM ('nao_avaliado','sem_alergias_conhecidas','possui_alergias');
CREATE TYPE tipo_evento_historico AS ENUM ('tentativa_suicidio','automutilacao','agressividade',
  'abandono_tratamento','internacao_previa','trauma_violencia','outro');
CREATE TYPE precisao_data AS ENUM ('exata','mes','ano','aproximada');
CREATE TYPE situacao_uso_medicacao AS ENUM ('em_uso','suspenso','previo');

CREATE TYPE confiabilidade_relato AS ENUM ('boa','regular','ruim','nao_avaliavel');
CREATE TYPE substancia AS ENUM ('alcool','tabaco','cannabis','cocaina','crack','opioides',
  'benzodiazepinicos','outra');
CREATE TYPE padrao_uso AS ENUM ('nunca','experimentacao','uso_atual','uso_pregresso','nao_informado');
CREATE TYPE dominio_eem AS ENUM ('aparencia','atitude','consciencia','orientacao','atencao',
  'psicomotricidade','humor','afeto','pensamento','sensopercepcao','memoria','linguagem',
  'juizo_critico','insight','cognicao');
CREATE TYPE dimensao_risco AS ENUM ('ideacao_suicida','intencao_suicida','planejamento_suicida',
  'acesso_meios','tentativas_anteriores','automutilacao','agressividade_terceiros',
  'agitacao_psicomotora','sintomas_psicoticos_relevantes','vulnerabilidade','risco_fuga_evasao',
  'risco_abstinencia','prejuizo_autocuidado');
-- 'presente' = risco/prejuízo identificado. 'nao_avaliado' NUNCA equivale a 'ausente'.
CREATE TYPE situacao_risco AS ENUM ('ausente','presente','nao_avaliado');
CREATE TYPE nivel_risco AS ENUM ('baixo','moderado','alto','iminente');
CREATE TYPE motivo_evolucao AS ENUM ('rotina','intercorrencia','admissao','pre_alta','outro');
CREATE TYPE tipo_intercorrencia AS ENUM ('agitacao','evasao','queda','autolesao',
  'tentativa_suicidio','agressao','contencao','clinica','outro');

CREATE TYPE via_administracao AS ENUM ('oral','sublingual','im','ev','sc','topica','retal',
  'inalatoria','oftalmica','outra');
CREATE TYPE tipo_frequencia AS ENUM ('intervalo','vezes_dia','dose_unica','sos','infusao_continua');
CREATE TYPE acao_item_prescricao AS ENUM ('iniciar','manter','ajustar','substituir','suspender');
CREATE TYPE tipo_prescricao AS ENUM ('hospitalar','alta','ambulatorial');
CREATE TYPE tipo_receita AS ENUM ('simples','controle_especial','notificacao_a','notificacao_b',
  'notificacao_c','antimicrobiano');
CREATE TYPE gravidade_alerta AS ENUM ('informativa','moderada','grave','contraindicada');
CREATE TYPE tipo_alerta AS ENUM ('alergia','alergias_nao_avaliadas','duplicidade_principio_ativo',
  'via_incompativel','interacao','dose_acima_referencia','dose_sem_referencia');
CREATE TYPE tipo_adendo AS ENUM ('correcao','complemento','esclarecimento');

CREATE TYPE tipo_exame AS ENUM ('laboratorial','imagem','eletrofisiologico','neuropsicologico','outro');
CREATE TYPE status_exame AS ENUM ('solicitado','coletado','resultado_disponivel','cancelado');
CREATE TYPE categoria_arquivo AS ENUM ('documento_paciente','exame','foto_identificacao',
  'logotipo_hospital','pdf_gerado','contrato','outro');
CREATE TYPE tipo_exportacao AS ENUM ('prontuario_completo','prontuario_internacao','evolucoes_periodo',
  'prescricoes','receituario','parecer','relatorio','atestado','resumo_alta','historico_medicamentos','outro');
CREATE TYPE canal_compartilhamento AS ENUM ('whatsapp','impressao','download','email','outro');
CREATE TYPE destinatario_tipo AS ENUM ('paciente','responsavel_legal','familiar',
  'outro_profissional','instituicao','proprio_medico','outro');
CREATE TYPE papel_lgpd AS ENUM ('controlador','operador','controlador_conjunto');
CREATE TYPE tipo_pendencia AS ENUM ('evolucao','avaliacao_risco','revisao_prescricao',
  'comunicacao_ministerio_publico','resumo_alta');
CREATE TYPE status_agenda AS ENUM ('agendado','realizado','cancelado');

-- ---------------------------------------------------------------------
-- 1. ORGANIZAÇÃO, USUÁRIOS, PAPÉIS
-- ---------------------------------------------------------------------
CREATE TABLE organizacao (            -- a empresa / clínica médica (tenant)
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  razao_social  text,
  cnpj          char(14) CHECK (cnpj IS NULL OR cnpj_valido(cnpj)),
  ativa         boolean NOT NULL DEFAULT true,
  criada_em     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usuario (                -- identidade pessoal e intransferível
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  nome_completo      text NOT NULL,
  senha_hash         text,            -- argon2id (gerado pela aplicação); nunca senha em claro
  mfa_ativo          boolean NOT NULL DEFAULT false,
  mfa_segredo_cifrado bytea,          -- cifrado pela aplicação (envelope encryption)
  ativo              boolean NOT NULL DEFAULT true,
  tentativas_falhas  smallint NOT NULL DEFAULT 0,
  bloqueado_ate      timestamptz,
  ultimo_login_em    timestamptz,
  criado_em          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profissional (           -- registro de conselho (necessário para assinar)
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id         uuid NOT NULL UNIQUE REFERENCES usuario(id),
  conselho           text NOT NULL DEFAULT 'CRM',
  numero_registro    text NOT NULL,
  uf                 char(2) NOT NULL,
  especialidade      text,
  rqe                text,
  certificado_icp_serial   text,
  certificado_icp_validade date,
  UNIQUE (conselho, numero_registro, uf)
);

CREATE TABLE organizacao_membro (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL REFERENCES organizacao(id),
  usuario_id      uuid NOT NULL REFERENCES usuario(id),
  papel           papel_usuario NOT NULL,
  ativo           boolean NOT NULL DEFAULT true,
  desde           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organizacao_id, usuario_id),
  UNIQUE (id, organizacao_id)
);

CREATE TABLE papel_permissao (        -- matriz de permissões granulares (seed em 03)
  papel      papel_usuario NOT NULL,
  permissao  text NOT NULL,
  PRIMARY KEY (papel, permissao)
);

-- ---------------------------------------------------------------------
-- 2. HOSPITAIS, UNIDADES, LEITOS, CONVÊNIOS
-- ---------------------------------------------------------------------
CREATE TABLE hospital (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id      uuid NOT NULL REFERENCES organizacao(id),
  nome_fantasia       text NOT NULL,
  razao_social        text,
  cnpj                char(14) CHECK (cnpj IS NULL OR cnpj_valido(cnpj)),
  cnes                char(7) CHECK (cnes IS NULL OR cnes ~ '^[0-9]{7}$'),
  tipo                tipo_instituicao NOT NULL DEFAULT 'hospital_psiquiatrico',
  diretor_tecnico_nome text,
  diretor_tecnico_crm  text,
  diretor_tecnico_crm_uf char(2),
  telefone            text,
  email               citext,
  cep                 char(8),
  logradouro          text,
  numero              text,
  complemento         text,
  bairro              text,
  cidade              text,
  uf                  char(2),
  cabecalho_documento text,           -- texto de cabeçalho dos PDFs
  logotipo_arquivo_id uuid,           -- FK adicionada após "arquivo"
  ativo               boolean NOT NULL DEFAULT true,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organizacao_id)
);
CREATE UNIQUE INDEX ux_hospital_cnpj ON hospital (organizacao_id, cnpj) WHERE cnpj IS NOT NULL;

CREATE TABLE membro_hospital (        -- vínculo do membro com cada hospital onde atua
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL,
  membro_id      uuid NOT NULL,
  hospital_id    uuid NOT NULL,
  ativo          boolean NOT NULL DEFAULT true,
  desde          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membro_id, hospital_id),
  FOREIGN KEY (membro_id, organizacao_id)   REFERENCES organizacao_membro (id, organizacao_id),
  FOREIGN KEY (hospital_id, organizacao_id) REFERENCES hospital (id, organizacao_id)
);

CREATE TABLE unidade_internacao (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL,
  hospital_id    uuid NOT NULL,
  nome           text NOT NULL,
  tipo           text,
  ativa          boolean NOT NULL DEFAULT true,
  UNIQUE (hospital_id, nome),
  UNIQUE (id, hospital_id, organizacao_id),
  FOREIGN KEY (hospital_id, organizacao_id) REFERENCES hospital (id, organizacao_id)
);

CREATE TABLE leito (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL,
  hospital_id    uuid NOT NULL,
  unidade_id     uuid NOT NULL,
  identificacao  text NOT NULL,
  tipo_acomodacao text,               -- enfermaria, apartamento, quarto protegido...
  ativo          boolean NOT NULL DEFAULT true,
  UNIQUE (unidade_id, identificacao),
  UNIQUE (id, hospital_id, organizacao_id),
  FOREIGN KEY (unidade_id, hospital_id, organizacao_id)
    REFERENCES unidade_internacao (id, hospital_id, organizacao_id)
);

CREATE TABLE operadora (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL REFERENCES organizacao(id),
  nome           text NOT NULL,
  registro_ans   text,
  ativa          boolean NOT NULL DEFAULT true,
  UNIQUE (organizacao_id, nome),
  UNIQUE (id, organizacao_id)
);

CREATE TABLE hospital_operadora (
  hospital_id    uuid NOT NULL,
  operadora_id   uuid NOT NULL,
  organizacao_id uuid NOT NULL,
  PRIMARY KEY (hospital_id, operadora_id),
  FOREIGN KEY (hospital_id, organizacao_id)  REFERENCES hospital (id, organizacao_id),
  FOREIGN KEY (operadora_id, organizacao_id) REFERENCES operadora (id, organizacao_id)
);

CREATE TABLE hospital_contato (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL,
  hospital_id    uuid NOT NULL,
  nome           text NOT NULL,
  cargo          text,
  telefone       text,
  email          citext,
  FOREIGN KEY (hospital_id, organizacao_id) REFERENCES hospital (id, organizacao_id)
);

CREATE TABLE hospital_contrato_dados (   -- LGPD: papéis controlador/operador por hospital
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  hospital_id     uuid NOT NULL,
  papel_hospital  papel_lgpd NOT NULL,
  papel_organizacao papel_lgpd NOT NULL,
  base_legal      text NOT NULL,          -- ex.: tutela da saúde (LGPD art. 11, II, "f")
  vigencia_inicio date NOT NULL,
  vigencia_fim    date,
  guarda_prontuario_responsavel text NOT NULL,  -- quem guarda o prontuário (contrato)
  arquivo_id      uuid,
  observacoes     text,
  FOREIGN KEY (hospital_id, organizacao_id) REFERENCES hospital (id, organizacao_id),
  CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);

-- ---------------------------------------------------------------------
-- 3. PACIENTE (cadastro permanente, único por organização)
-- ---------------------------------------------------------------------
CREATE TABLE contador (                -- numeração sem lacunas por organização
  organizacao_id uuid NOT NULL REFERENCES organizacao(id),
  nome           text NOT NULL,
  valor          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organizacao_id, nome)
);

CREATE TABLE paciente (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id    uuid NOT NULL REFERENCES organizacao(id),
  numero            bigint NOT NULL,                       -- preenchido por trigger
  codigo            text GENERATED ALWAYS AS ('PAC-' || lpad(numero::text, 6, '0')) STORED,
  nome_completo     text NOT NULL CHECK (length(btrim(nome_completo)) >= 3),
  nome_social       text,
  nome_mae          text,
  cpf               char(11) CHECK (cpf IS NULL OR cpf_valido(cpf)),
  rg                text,
  rg_orgao_emissor  text,
  cns               char(15) CHECK (cns IS NULL OR cns ~ '^[0-9]{15}$'),
  data_nascimento   date NOT NULL CHECK (data_nascimento <= CURRENT_DATE AND data_nascimento > DATE '1890-01-01'),
  data_nascimento_estimada boolean NOT NULL DEFAULT false,
  sexo_registrado   sexo_registrado NOT NULL DEFAULT 'nao_informado',
  identidade_genero text,
  estado_civil      text,
  nacionalidade     text,
  naturalidade      text,
  profissao         text,
  escolaridade      text,
  foto_arquivo_id   uuid,
  cep               char(8),
  logradouro        text,
  numero_endereco   text,
  complemento       text,
  bairro            text,
  municipio         text,
  uf                char(2),
  telefone_principal  text,
  telefone_secundario text,
  email             citext,
  alergias_status   alergias_status NOT NULL DEFAULT 'nao_avaliado',
  ativo             boolean NOT NULL DEFAULT true,
  data_obito        date,
  mesclado_em_id    uuid,                                  -- duplicidade resolvida (nunca apagar)
  nome_normalizado  text GENERATED ALWAYS AS (f_norm(nome_completo)) STORED,
  criado_por        uuid REFERENCES usuario(id),
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organizacao_id),
  UNIQUE (organizacao_id, numero),
  FOREIGN KEY (mesclado_em_id, organizacao_id) REFERENCES paciente (id, organizacao_id),
  CHECK (mesclado_em_id IS NULL OR mesclado_em_id <> id)
);

-- Evita duplicidade de identidade dentro da organização
CREATE UNIQUE INDEX ux_paciente_cpf ON paciente (organizacao_id, cpf)
  WHERE cpf IS NOT NULL AND mesclado_em_id IS NULL;
CREATE UNIQUE INDEX ux_paciente_identidade ON paciente (organizacao_id, nome_normalizado, data_nascimento, f_norm(nome_mae))
  WHERE nome_mae IS NOT NULL AND mesclado_em_id IS NULL;
CREATE INDEX ix_paciente_nome_trgm ON paciente USING gin (nome_normalizado gin_trgm_ops);

CREATE TABLE paciente_responsavel (    -- responsável legal / contato de emergência
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  nome            text NOT NULL,
  parentesco      text,
  cpf             char(11) CHECK (cpf IS NULL OR cpf_valido(cpf)),
  telefone        text,
  telefone_secundario text,
  email           citext,
  responsavel_legal boolean NOT NULL DEFAULT false,
  contato_emergencia boolean NOT NULL DEFAULT false,
  tipo_responsabilidade text,         -- curador, tutor, familiar...
  documento_representacao_arquivo_id uuid,
  ativo           boolean NOT NULL DEFAULT true,
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES paciente (id, organizacao_id)
);

CREATE TABLE paciente_convenio (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  cobertura       tipo_cobertura NOT NULL DEFAULT 'convenio',
  operadora_id    uuid,
  plano           text,
  numero_carteirinha text,
  validade        date,
  titular_nome    text,
  titular_parentesco text,
  ativo           boolean NOT NULL DEFAULT true,
  UNIQUE (id, organizacao_id),
  FOREIGN KEY (paciente_id, organizacao_id)  REFERENCES paciente (id, organizacao_id),
  FOREIGN KEY (operadora_id, organizacao_id) REFERENCES operadora (id, organizacao_id),
  CHECK (cobertura <> 'convenio' OR (operadora_id IS NOT NULL AND numero_carteirinha IS NOT NULL))
);

CREATE TABLE paciente_hospital (       -- identificação do paciente em cada hospital
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  hospital_id     uuid NOT NULL,
  numero_prontuario_hospital text,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (paciente_id, hospital_id),
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES paciente (id, organizacao_id),
  FOREIGN KEY (hospital_id, organizacao_id) REFERENCES hospital (id, organizacao_id)
);

-- ---------------------------------------------------------------------
-- 4. CATÁLOGOS GLOBAIS (somente leitura para a aplicação)
-- ---------------------------------------------------------------------
CREATE TABLE cid (                     -- importar do DATASUS/OMS; NÃO semeado aqui
  id         serial PRIMARY KEY,
  versao     versao_cid NOT NULL,
  codigo     text NOT NULL,
  descricao  text NOT NULL,
  ativo      boolean NOT NULL DEFAULT true,
  UNIQUE (versao, codigo)
);

CREATE TABLE principio_ativo (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                  text NOT NULL UNIQUE,
  classe_terapeutica    text,
  lista_controle_especial text,        -- lista da Portaria SVS/MS 344/98, se houver
  ativo                 boolean NOT NULL DEFAULT true
);

CREATE TABLE medicamento_apresentacao (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principio_ativo_id    uuid NOT NULL REFERENCES principio_ativo(id),
  nome_comercial        text,
  concentracao_valor    numeric(12,4),
  concentracao_unidade  text,          -- mg, mg/mL, mcg...
  forma_farmaceutica    text NOT NULL, -- comprimido, solução oral, ampola...
  vias_permitidas       via_administracao[] NOT NULL CHECK (cardinality(vias_permitidas) >= 1),
  embalagem             text,
  registro_anvisa       text,
  ativo                 boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX ux_med_apresentacao ON medicamento_apresentacao
  (principio_ativo_id, coalesce(nome_comercial,''), coalesce(concentracao_valor,0),
   coalesce(concentracao_unidade,''), forma_farmaceutica);

CREATE TABLE faixa_dose_referencia (   -- alertas de dose SOMENTE com fonte e revisão registradas
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principio_ativo_id    uuid NOT NULL REFERENCES principio_ativo(id),
  via                   via_administracao NOT NULL,
  unidade               text NOT NULL,
  dose_unica_max        numeric(12,4),
  dose_diaria_max       numeric(12,4),
  populacao             text NOT NULL DEFAULT 'adulto' CHECK (populacao IN ('adulto','idoso','pediatrico','geral')),
  fonte                 text NOT NULL,
  revisado_em           date NOT NULL,
  revisado_por          text NOT NULL,
  CHECK (dose_unica_max IS NOT NULL OR dose_diaria_max IS NOT NULL)
);

CREATE TABLE interacao_medicamentosa (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principio_a_id      uuid NOT NULL REFERENCES principio_ativo(id),
  principio_b_id      uuid NOT NULL REFERENCES principio_ativo(id),
  gravidade           gravidade_alerta NOT NULL,
  descricao           text NOT NULL,
  conduta_sugerida    text,
  fonte               text NOT NULL,
  revisado_em         date NOT NULL,
  CHECK (principio_a_id < principio_b_id),
  UNIQUE (principio_a_id, principio_b_id)
);

CREATE TABLE eem_catalogo (            -- opções do Exame do Estado Mental (seed em 03)
  dominio    dominio_eem NOT NULL,
  codigo     text NOT NULL,
  descricao  text NOT NULL,
  ordem      smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (dominio, codigo)
);

-- ---------------------------------------------------------------------
-- 5. INTERNAÇÃO (episódio assistencial) — independente do paciente
-- ---------------------------------------------------------------------
CREATE TABLE internacao (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id        uuid NOT NULL,
  paciente_id           uuid NOT NULL,
  hospital_id           uuid NOT NULL,
  numero                bigint NOT NULL,                  -- trigger
  codigo                text GENERATED ALWAYS AS ('INT-' || lpad(numero::text, 6, '0')) STORED,
  numero_atendimento_hospital text,                       -- nº do atendimento no hospital
  status                status_internacao NOT NULL DEFAULT 'internado',
  modalidade            modalidade_internacao NOT NULL,
  origem_encaminhamento text,
  medico_solicitante    text,
  profissional_responsavel_id uuid NOT NULL REFERENCES profissional(id),
  data_admissao         timestamptz NOT NULL,
  paciente_convenio_id  uuid,
  numero_autorizacao    text,
  data_autorizacao      date,
  tipo_acomodacao       text,
  -- Lei 10.216/2001: internação involuntária deve ser comunicada ao MP em até 72 h
  comunicado_ministerio_publico_em timestamptz,
  data_alta             timestamptz,
  motivo_encerramento   motivo_encerramento,
  destino_alta          text,
  criado_por            uuid REFERENCES usuario(id),
  criado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organizacao_id),
  UNIQUE (id, paciente_id, hospital_id, organizacao_id),
  UNIQUE (id, hospital_id, organizacao_id),
  UNIQUE (organizacao_id, numero),
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES paciente (id, organizacao_id),
  FOREIGN KEY (hospital_id, organizacao_id) REFERENCES hospital (id, organizacao_id),
  FOREIGN KEY (paciente_convenio_id, organizacao_id) REFERENCES paciente_convenio (id, organizacao_id),
  CHECK ((status = 'internado' AND data_alta IS NULL AND motivo_encerramento IS NULL)
      OR (status = 'encerrada' AND data_alta IS NOT NULL AND motivo_encerramento IS NOT NULL)),
  CHECK (data_alta IS NULL OR data_alta >= data_admissao)
);
-- um paciente não pode estar internado em dois lugares ao mesmo tempo
CREATE UNIQUE INDEX ux_internacao_ativa_por_paciente ON internacao (paciente_id) WHERE status = 'internado';
CREATE INDEX ix_internacao_hospital_status ON internacao (hospital_id, status);

CREATE TABLE internacao_clinico (      -- dados clínicos da admissão (separados do administrativo)
  internacao_id      uuid PRIMARY KEY REFERENCES internacao(id),
  organizacao_id     uuid NOT NULL,
  motivo_internacao  text NOT NULL,
  observacoes_admissao text,
  FOREIGN KEY (internacao_id, organizacao_id) REFERENCES internacao (id, organizacao_id)
);

CREATE TABLE internacao_equipe (       -- quem pode acessar/atuar nesta internação
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  internacao_id   uuid NOT NULL,
  usuario_id      uuid NOT NULL REFERENCES usuario(id),
  funcao          funcao_equipe NOT NULL,
  inicio          timestamptz NOT NULL DEFAULT now(),
  fim             timestamptz,
  FOREIGN KEY (internacao_id, organizacao_id) REFERENCES internacao (id, organizacao_id),
  CHECK (fim IS NULL OR fim > inicio)
);
CREATE UNIQUE INDEX ux_equipe_ativa ON internacao_equipe (internacao_id, usuario_id) WHERE fim IS NULL;

CREATE TABLE internacao_movimentacao ( -- única fonte da verdade sobre o leito atual/histórico
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  internacao_id   uuid NOT NULL,
  hospital_id     uuid NOT NULL,
  leito_id        uuid NOT NULL,
  tipo            tipo_movimentacao NOT NULL,
  inicio          timestamptz NOT NULL,
  fim             timestamptz,
  motivo          text,
  registrado_por  uuid REFERENCES usuario(id),
  FOREIGN KEY (internacao_id, hospital_id, organizacao_id) REFERENCES internacao (id, hospital_id, organizacao_id),
  FOREIGN KEY (leito_id, hospital_id, organizacao_id) REFERENCES leito (id, hospital_id, organizacao_id),
  CHECK (fim IS NULL OR fim > inicio),
  -- um leito não pode ter dois ocupantes ao mesmo tempo
  EXCLUDE USING gist (leito_id WITH =, tstzrange(inicio, fim) WITH &&)
);
CREATE UNIQUE INDEX ux_mov_aberta ON internacao_movimentacao (internacao_id) WHERE fim IS NULL;

-- ---------------------------------------------------------------------
-- 6. HISTÓRICO LONGITUDINAL DO PACIENTE (nível 1)
-- ---------------------------------------------------------------------
CREATE TABLE paciente_alergia (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  agente          text NOT NULL,
  categoria       categoria_alergia NOT NULL,
  principio_ativo_id uuid REFERENCES principio_ativo(id),  -- permite cruzar com a prescrição
  gravidade       gravidade_alergia NOT NULL DEFAULT 'desconhecida',
  reacao          text,
  situacao        situacao_alergia NOT NULL DEFAULT 'ativa',
  fonte           text,
  registrado_por  uuid NOT NULL REFERENCES usuario(id),
  registrado_em   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES paciente (id, organizacao_id),
  CHECK (categoria <> 'medicamento' OR principio_ativo_id IS NOT NULL OR length(agente) > 0)
);

CREATE TABLE paciente_evento_historico ( -- tentativas de suicídio, automutilação etc.
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  tipo            tipo_evento_historico NOT NULL,
  data_evento     date,
  precisao        precisao_data NOT NULL DEFAULT 'aproximada',
  descricao       text NOT NULL,
  fonte_informacao text,
  situacao        text NOT NULL DEFAULT 'ativo' CHECK (situacao IN ('ativo','registrado_por_engano')),
  registrado_por  uuid NOT NULL REFERENCES usuario(id),
  registrado_em   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES paciente (id, organizacao_id)
);

CREATE TABLE paciente_medicacao_previa (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  principio_ativo_id uuid REFERENCES principio_ativo(id),
  nome_informado  text NOT NULL,
  dose_texto      text,
  situacao        situacao_uso_medicacao NOT NULL,
  inicio_aproximado text,
  fim_aproximado  text,
  motivo_suspensao text,
  fonte           text,
  registrado_por  uuid NOT NULL REFERENCES usuario(id),
  registrado_em   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES paciente (id, organizacao_id)
);

CREATE TABLE diagnostico (             -- CID sempre com situação, data e responsável
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  internacao_id   uuid,
  hospital_id     uuid,
  cid_id          integer NOT NULL REFERENCES cid(id),
  situacao        situacao_diagnostico NOT NULL,
  momento         momento_diagnostico NOT NULL DEFAULT 'curso',
  principal       boolean NOT NULL DEFAULT false,
  observacao      text,
  registrado_por  uuid NOT NULL REFERENCES usuario(id),
  registrado_em   timestamptz NOT NULL DEFAULT now(),
  encerrado_em    timestamptz,
  UNIQUE (id, organizacao_id),
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES paciente (id, organizacao_id),
  FOREIGN KEY (internacao_id, paciente_id, hospital_id, organizacao_id)
    REFERENCES internacao (id, paciente_id, hospital_id, organizacao_id),
  CHECK ((internacao_id IS NULL) = (hospital_id IS NULL)),
  CHECK (NOT principal OR situacao IN ('hipotese','confirmado'))
);
CREATE UNIQUE INDEX ux_diagnostico_principal ON diagnostico (internacao_id)
  WHERE principal AND encerrado_em IS NULL AND internacao_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 7. ARQUIVOS (anexos, fotos de documentos/exames, PDFs gerados)
-- ---------------------------------------------------------------------
CREATE TABLE arquivo (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL REFERENCES organizacao(id),
  paciente_id     uuid,
  internacao_id   uuid,
  categoria       categoria_arquivo NOT NULL,
  nome_original   text NOT NULL,
  mime_type       text NOT NULL,
  tamanho_bytes   bigint NOT NULL CHECK (tamanho_bytes > 0),
  sha256          bytea NOT NULL CHECK (octet_length(sha256) = 32),
  storage_chave   text NOT NULL UNIQUE,      -- objeto em armazenamento PRIVADO
  criado_por      uuid REFERENCES usuario(id),
  criado_em       timestamptz NOT NULL DEFAULT now(),
  invalidado_em   timestamptz,
  invalidado_por  uuid REFERENCES usuario(id),
  motivo_invalidacao text,
  UNIQUE (id, organizacao_id),
  FOREIGN KEY (paciente_id, organizacao_id)  REFERENCES paciente (id, organizacao_id),
  FOREIGN KEY (internacao_id, organizacao_id) REFERENCES internacao (id, organizacao_id),
  CHECK ((invalidado_em IS NULL) = (motivo_invalidacao IS NULL))
);
ALTER TABLE hospital ADD FOREIGN KEY (logotipo_arquivo_id, organizacao_id) REFERENCES arquivo (id, organizacao_id);
ALTER TABLE paciente ADD FOREIGN KEY (foto_arquivo_id, organizacao_id) REFERENCES arquivo (id, organizacao_id);
ALTER TABLE hospital_contrato_dados ADD FOREIGN KEY (arquivo_id, organizacao_id) REFERENCES arquivo (id, organizacao_id);
ALTER TABLE paciente_responsavel ADD FOREIGN KEY (documento_representacao_arquivo_id, organizacao_id) REFERENCES arquivo (id, organizacao_id);

-- ---------------------------------------------------------------------
-- 8. REGISTRO CLÍNICO (supertipo): assinatura, hash, anulação — comum a todos os documentos
-- ---------------------------------------------------------------------
CREATE TABLE registro_clinico (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id     uuid NOT NULL,
  paciente_id        uuid NOT NULL,
  hospital_id        uuid NOT NULL,
  internacao_id      uuid NOT NULL,
  tipo               tipo_registro NOT NULL,
  status             status_registro NOT NULL DEFAULT 'rascunho',
  autor_usuario_id   uuid NOT NULL REFERENCES usuario(id),
  ocorrido_em        timestamptz NOT NULL DEFAULT now(),         -- quando o fato clínico ocorreu
  registrado_em      timestamptz NOT NULL DEFAULT clock_timestamp(), -- quando foi lançado
  justificativa_retroativo text,
  assinado_em        timestamptz,
  assinado_por_usuario_id uuid REFERENCES usuario(id),
  tipo_assinatura    tipo_assinatura,
  assinatura_externa jsonb,                                     -- cadeia/carimbo ICP-Brasil
  algoritmo_hash     text NOT NULL DEFAULT 'sha256',
  hash_conteudo      bytea,
  anulado_em         timestamptz,
  anulado_por_usuario_id uuid REFERENCES usuario(id),
  motivo_anulacao    text,
  UNIQUE (id, organizacao_id),
  UNIQUE (id, internacao_id),
  FOREIGN KEY (internacao_id, paciente_id, hospital_id, organizacao_id)
    REFERENCES internacao (id, paciente_id, hospital_id, organizacao_id),
  CHECK (ocorrido_em <= registrado_em + interval '5 minutes'),
  CHECK (ocorrido_em >= registrado_em - interval '12 hours' OR justificativa_retroativo IS NOT NULL),
  CHECK (status <> 'assinado' OR (assinado_em IS NOT NULL AND assinado_por_usuario_id IS NOT NULL
         AND tipo_assinatura IS NOT NULL AND hash_conteudo IS NOT NULL)),
  CHECK (status <> 'anulado' OR (anulado_em IS NOT NULL AND anulado_por_usuario_id IS NOT NULL
         AND length(btrim(motivo_anulacao)) >= 10 AND assinado_em IS NOT NULL))
);
CREATE INDEX ix_registro_internacao ON registro_clinico (internacao_id, tipo, ocorrido_em DESC);
CREATE INDEX ix_registro_paciente ON registro_clinico (paciente_id, ocorrido_em DESC);

CREATE TABLE registro_adendo (         -- correção/complemento de registro assinado (insert-only)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  registro_id     uuid NOT NULL,
  tipo            tipo_adendo NOT NULL,
  justificativa   text NOT NULL CHECK (length(btrim(justificativa)) >= 10),
  conteudo        text NOT NULL CHECK (length(btrim(conteudo)) >= 1),
  autor_usuario_id uuid NOT NULL REFERENCES usuario(id),
  criado_em       timestamptz NOT NULL DEFAULT clock_timestamp(),
  hash_conteudo   bytea NOT NULL,
  FOREIGN KEY (registro_id, organizacao_id) REFERENCES registro_clinico (id, organizacao_id)
);

CREATE TABLE registro_arquivo (        -- fotos de documentos/exames anexadas a um registro
  registro_id     uuid NOT NULL REFERENCES registro_clinico(id) ON DELETE CASCADE,
  arquivo_id      uuid NOT NULL,
  organizacao_id  uuid NOT NULL,
  legenda         text,
  PRIMARY KEY (registro_id, arquivo_id),
  FOREIGN KEY (arquivo_id, organizacao_id) REFERENCES arquivo (id, organizacao_id)
);

-- ---------------------------------------------------------------------
-- 9. SUBTIPOS DE REGISTRO (PK = registro_id)
-- ---------------------------------------------------------------------
CREATE TABLE anamnese (
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  fonte_informacao   text,
  confiabilidade_relato confiabilidade_relato,
  acompanhante       text,
  motivo_avaliacao   text,
  procedencia        text,
  contexto_internacao text,
  queixa_principal   text,
  hda_inicio_sintomas text,
  hda_tempo_evolucao text,
  hda_fatores_desencadeantes text,
  hda_sintomas_predominantes text,
  hda_evolucao_recente text,
  hda_tratamentos_realizados text,
  hda_resposta_tratamentos text,
  hda_impacto_funcional text,
  hda_complementar   text,
  antecedentes_psiquiatricos jsonb NOT NULL DEFAULT '{}',   -- ver ARQUITETURA §5.2 (chaves definidas)
  antecedentes_pessoais      jsonb NOT NULL DEFAULT '{}',
  antecedentes_familiares    jsonb NOT NULL DEFAULT '{}',
  contexto_psicossocial      jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE anamnese_substancia (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id     uuid NOT NULL REFERENCES anamnese(registro_id) ON DELETE CASCADE,
  substancia      substancia NOT NULL,
  outra_descricao text,
  padrao          padrao_uso NOT NULL,
  frequencia      text,
  quantidade      text,
  ultimo_consumo  text,
  historico_abstinencia text,
  CHECK (substancia <> 'outra' OR outra_descricao IS NOT NULL)
);
CREATE UNIQUE INDEX ux_anamnese_substancia ON anamnese_substancia (registro_id, substancia, coalesce(outra_descricao,''));

CREATE TABLE exame_estado_mental (
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  observacoes_gerais text
);
CREATE TABLE eem_dominio (              -- cada um dos 15 domínios deve ser tratado explicitamente
  registro_id  uuid NOT NULL REFERENCES exame_estado_mental(registro_id) ON DELETE CASCADE,
  dominio      dominio_eem NOT NULL,
  avaliado     boolean NOT NULL,
  observacao   text,
  PRIMARY KEY (registro_id, dominio),
  CHECK (avaliado OR observacao IS NOT NULL)      -- "não avaliado" exige justificativa
);
CREATE TABLE eem_item (
  registro_id  uuid NOT NULL,
  dominio      dominio_eem NOT NULL,
  codigo       text NOT NULL,
  PRIMARY KEY (registro_id, dominio, codigo),
  FOREIGN KEY (registro_id, dominio) REFERENCES eem_dominio (registro_id, dominio) ON DELETE CASCADE,
  FOREIGN KEY (dominio, codigo) REFERENCES eem_catalogo (dominio, codigo)
);

CREATE TABLE avaliacao_risco (
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  achados_clinicos   text,
  fatores_risco      text,
  fatores_protetores text,
  rede_apoio         text,
  avaliacao_clinica  text,
  nivel_risco_profissional nivel_risco,        -- SEM default e SEM cálculo automático
  justificativa_nivel text,
  conduta            text,
  necessita_reavaliacao boolean,
  reavaliar_em       timestamptz
);
CREATE TABLE avaliacao_risco_item (
  registro_id  uuid NOT NULL REFERENCES avaliacao_risco(registro_id) ON DELETE CASCADE,
  dimensao     dimensao_risco NOT NULL,
  situacao     situacao_risco NOT NULL,
  observacao   text,
  PRIMARY KEY (registro_id, dimensao),
  CHECK (situacao <> 'nao_avaliado' OR length(btrim(coalesce(observacao,''))) > 0)
);

CREATE TABLE evolucao (
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  motivo             motivo_evolucao NOT NULL DEFAULT 'rotina',
  subjetivo          text,
  objetivo           text,
  estado_mental      text,
  sono               text,
  apetite            text,
  comportamento      text,
  adesao             text,
  efeitos_adversos   text,
  impressao_diagnostica text,
  conduta            text,
  texto_livre        text,
  avaliacao_risco_registro_id uuid REFERENCES avaliacao_risco(registro_id)
);

CREATE TABLE intercorrencia (
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  tipo               tipo_intercorrencia NOT NULL,
  descricao          text,
  conduta            text,
  contencao_fisica   boolean NOT NULL DEFAULT false,
  contencao_quimica  boolean NOT NULL DEFAULT false,
  justificativa_contencao text,
  responsavel_comunicado_em timestamptz,
  CHECK (NOT (contencao_fisica OR contencao_quimica) OR justificativa_contencao IS NOT NULL)
);

CREATE TABLE prescricao (               -- cada prescrição assinada é a LISTA COMPLETA vigente
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  tipo               tipo_prescricao NOT NULL DEFAULT 'hospitalar',
  valida_de          timestamptz NOT NULL DEFAULT now(),
  valida_ate         timestamptz,
  dieta_cuidados     text,
  observacoes_gerais text,
  CHECK (valida_ate IS NULL OR valida_ate > valida_de)
);
CREATE TABLE prescricao_item (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id        uuid NOT NULL REFERENCES prescricao(registro_id) ON DELETE CASCADE,
  ordem              smallint NOT NULL,
  apresentacao_id    uuid NOT NULL REFERENCES medicamento_apresentacao(id),  -- só do catálogo
  dose_valor         numeric(12,4) NOT NULL CHECK (dose_valor > 0),
  dose_unidade       text NOT NULL,
  via                via_administracao NOT NULL,
  frequencia_tipo    tipo_frequencia NOT NULL,
  intervalo_horas    numeric(5,2) CHECK (intervalo_horas > 0),
  vezes_dia          smallint CHECK (vezes_dia > 0),
  horarios           time[],
  sos_indicacao      text,
  sos_dose_max_24h   numeric(12,4),
  data_inicio        timestamptz NOT NULL,
  data_fim           timestamptz,
  duracao_dias       integer CHECK (duracao_dias > 0),
  quantidade_total   numeric(12,2),
  orientacoes        text,
  indicacao_clinica  text NOT NULL,
  acao               acao_item_prescricao NOT NULL DEFAULT 'iniciar',
  item_anterior_id   uuid REFERENCES prescricao_item(id),
  motivo_alteracao   text,
  UNIQUE (registro_id, ordem),
  CHECK (data_fim IS NULL OR data_fim > data_inicio),
  CHECK (frequencia_tipo <> 'intervalo' OR intervalo_horas IS NOT NULL),
  CHECK (frequencia_tipo <> 'vezes_dia' OR vezes_dia IS NOT NULL),
  CHECK (frequencia_tipo <> 'sos' OR (sos_indicacao IS NOT NULL AND sos_dose_max_24h IS NOT NULL)),
  CHECK (acao NOT IN ('ajustar','substituir','suspender')
         OR (item_anterior_id IS NOT NULL AND length(btrim(coalesce(motivo_alteracao,''))) >= 5))
);
CREATE TABLE alerta_prescricao (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id     uuid NOT NULL REFERENCES prescricao(registro_id) ON DELETE CASCADE,
  item_id         uuid REFERENCES prescricao_item(id) ON DELETE CASCADE,
  chave           text NOT NULL,
  tipo            tipo_alerta NOT NULL,
  gravidade       gravidade_alerta NOT NULL,
  mensagem        text NOT NULL,
  fonte           text,
  gerado_em       timestamptz NOT NULL DEFAULT now(),
  justificativa_medica text,
  justificado_por uuid REFERENCES usuario(id),
  justificado_em  timestamptz,
  UNIQUE (registro_id, chave),
  CHECK ((justificativa_medica IS NULL) = (justificado_por IS NULL))
);

CREATE TABLE receita (                  -- receitas controladas seguem fluxo OFICIAL externo
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  tipo               tipo_receita NOT NULL DEFAULT 'simples',
  validade_ate       date,
  observacoes        text,
  emissao_externa    jsonb              -- {sistema, numero, codigo_validacao, url} — nunca numeração própria
);
CREATE TABLE receita_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id      uuid NOT NULL REFERENCES receita(registro_id) ON DELETE CASCADE,
  ordem            smallint NOT NULL,
  apresentacao_id  uuid NOT NULL REFERENCES medicamento_apresentacao(id),
  posologia        text NOT NULL,
  via              via_administracao NOT NULL,
  quantidade       numeric(12,2) NOT NULL CHECK (quantidade > 0),
  unidade_quantidade text NOT NULL,
  observacoes      text,
  UNIQUE (registro_id, ordem)
);

CREATE TABLE documento_clinico (        -- parecer, relatório, atestado, declaração, encaminhamento, solic. exames
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  titulo             text,
  finalidade         text,
  destinatario       text,
  corpo              text,
  cid_id             integer REFERENCES cid(id),
  dias_afastamento   smallint CHECK (dias_afastamento >= 0),
  dados              jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE resumo_alta (
  registro_id        uuid PRIMARY KEY REFERENCES registro_clinico(id) ON DELETE CASCADE,
  diagnostico_principal_id uuid,
  condicao_clinica_alta text,
  resumo_internacao  text,
  tratamento_realizado text,
  prescricao_alta_registro_id uuid REFERENCES prescricao(registro_id),
  orientacoes_paciente text,
  orientacoes_familia  text,
  encaminhamentos    text,
  necessita_acompanhamento_ambulatorial boolean,
  recomendacao_retorno text,
  condicao_saida     text,
  destino_paciente   text
);
CREATE TABLE resumo_alta_diagnostico (
  registro_id     uuid NOT NULL REFERENCES resumo_alta(registro_id) ON DELETE CASCADE,
  diagnostico_id  uuid NOT NULL REFERENCES diagnostico(id),
  PRIMARY KEY (registro_id, diagnostico_id)
);
ALTER TABLE resumo_alta ADD FOREIGN KEY (diagnostico_principal_id) REFERENCES diagnostico(id);

CREATE TABLE exame (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  hospital_id     uuid NOT NULL,
  internacao_id   uuid NOT NULL,
  nome_exame      text NOT NULL,
  tipo            tipo_exame NOT NULL,
  status          status_exame NOT NULL DEFAULT 'solicitado',
  solicitacao_registro_id uuid REFERENCES registro_clinico(id),
  solicitado_em   timestamptz NOT NULL DEFAULT now(),
  coletado_em     timestamptz,
  resultado_em    timestamptz,
  resultado_texto text,
  resultado_arquivo_id uuid,
  resultado_alterado boolean,
  substitui_exame_id uuid REFERENCES exame(id),   -- correção de resultado = nova linha
  registrado_por  uuid NOT NULL REFERENCES usuario(id),
  FOREIGN KEY (internacao_id, paciente_id, hospital_id, organizacao_id)
    REFERENCES internacao (id, paciente_id, hospital_id, organizacao_id),
  FOREIGN KEY (resultado_arquivo_id, organizacao_id) REFERENCES arquivo (id, organizacao_id),
  CHECK (status <> 'resultado_disponivel' OR (resultado_em IS NOT NULL
         AND (resultado_texto IS NOT NULL OR resultado_arquivo_id IS NOT NULL)))
);

-- ---------------------------------------------------------------------
-- 10. DOCUMENTOS GERADOS, COMPARTILHAMENTO, MODELOS
-- ---------------------------------------------------------------------
CREATE TABLE pdf_gerado (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  paciente_id     uuid NOT NULL,
  internacao_id   uuid,
  registro_id     uuid REFERENCES registro_clinico(id),
  tipo_exportacao tipo_exportacao NOT NULL,
  periodo_inicio  timestamptz,
  periodo_fim     timestamptz,
  arquivo_id      uuid NOT NULL,
  codigo_validacao text NOT NULL UNIQUE,
  versao_modelo   text NOT NULL,
  parametros      jsonb NOT NULL DEFAULT '{}',
  gerado_por      uuid NOT NULL REFERENCES usuario(id),
  gerado_em       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organizacao_id),
  FOREIGN KEY (paciente_id, organizacao_id)  REFERENCES paciente (id, organizacao_id),
  FOREIGN KEY (internacao_id, organizacao_id) REFERENCES internacao (id, organizacao_id),
  FOREIGN KEY (arquivo_id, organizacao_id)   REFERENCES arquivo (id, organizacao_id)
);

CREATE TABLE compartilhamento_documento ( -- registra a INTENÇÃO de compartilhar (WhatsApp, impressão...)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  pdf_id          uuid NOT NULL,
  usuario_id      uuid NOT NULL REFERENCES usuario(id),
  canal           canal_compartilhamento NOT NULL,
  destinatario_tipo destinatario_tipo NOT NULL,
  destinatario_descricao text NOT NULL,
  finalidade      text NOT NULL CHECK (length(btrim(finalidade)) >= 5),
  conferiu_destinatario boolean NOT NULL DEFAULT false,
  compartilhado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (pdf_id, organizacao_id) REFERENCES pdf_gerado (id, organizacao_id),
  CHECK (canal NOT IN ('whatsapp','email') OR conferiu_destinatario)
);

CREATE TABLE modelo_documento (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  hospital_id     uuid,
  tipo            tipo_registro NOT NULL,
  nome            text NOT NULL,
  conteudo        text NOT NULL,
  ativo           boolean NOT NULL DEFAULT true,
  FOREIGN KEY (hospital_id, organizacao_id) REFERENCES hospital (id, organizacao_id)
);

-- ---------------------------------------------------------------------
-- 11. AGENDA, PENDÊNCIAS, IA
-- ---------------------------------------------------------------------
CREATE TABLE agenda_compromisso (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  usuario_id      uuid NOT NULL REFERENCES usuario(id),
  hospital_id     uuid,
  paciente_id     uuid,
  internacao_id   uuid,
  titulo          text NOT NULL,
  inicio          timestamptz NOT NULL,
  fim             timestamptz,
  status          status_agenda NOT NULL DEFAULT 'agendado',
  observacoes     text,
  FOREIGN KEY (hospital_id, organizacao_id)   REFERENCES hospital (id, organizacao_id),
  FOREIGN KEY (paciente_id, organizacao_id)   REFERENCES paciente (id, organizacao_id),
  FOREIGN KEY (internacao_id, organizacao_id) REFERENCES internacao (id, organizacao_id),
  CHECK (fim IS NULL OR fim > inicio)
);

CREATE TABLE regra_pendencia (          -- regras configuradas por organização/hospital (não pela IA)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  hospital_id     uuid,
  tipo            tipo_pendencia NOT NULL,
  periodicidade_horas integer NOT NULL CHECK (periodicidade_horas > 0),
  ativa           boolean NOT NULL DEFAULT true,
  FOREIGN KEY (hospital_id, organizacao_id) REFERENCES hospital (id, organizacao_id)
);
CREATE UNIQUE INDEX ux_regra_pendencia ON regra_pendencia
  (organizacao_id, coalesce(hospital_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo);

CREATE TABLE ia_interacao (             -- toda chamada de IA fica rastreável (Etapa 5)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id  uuid NOT NULL,
  usuario_id      uuid NOT NULL REFERENCES usuario(id),
  paciente_id     uuid NOT NULL,
  internacao_id   uuid,
  finalidade      text NOT NULL,
  provedor        text NOT NULL,
  modelo          text NOT NULL,
  avaliacao_seguranca_ref text NOT NULL,   -- referência da avaliação formal (LGPD/contrato) que autoriza o envio
  registros_origem uuid[] NOT NULL,        -- registros usados como fonte (rastreabilidade)
  prompt_sha256   bytea NOT NULL,
  resposta        text,
  resultado       text CHECK (resultado IN ('descartado','usado_como_rascunho')),
  revisado_por    uuid REFERENCES usuario(id),
  revisado_em     timestamptz,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (paciente_id, organizacao_id) REFERENCES paciente (id, organizacao_id),
  FOREIGN KEY (internacao_id, organizacao_id) REFERENCES internacao (id, organizacao_id)
);

-- ---------------------------------------------------------------------
-- 12. AUDITORIA (append-only, encadeada por hash)
-- ---------------------------------------------------------------------
CREATE TABLE auditoria_evento (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizacao_id  uuid NOT NULL,
  ocorrido_em     timestamptz NOT NULL DEFAULT clock_timestamp(),
  usuario_id      uuid,
  acao            text NOT NULL,       -- login, login_falha, leitura, criacao, alteracao, exclusao_rascunho,
                                       -- assinatura, anulacao, adendo, exportacao, compartilhamento, acesso_negado, ia
  entidade        text,
  entidade_id     text,
  paciente_id     uuid,
  hospital_id     uuid,
  internacao_id   uuid,
  ip              inet,
  user_agent      text,
  dispositivo     text,
  request_id      text,
  detalhes        jsonb NOT NULL DEFAULT '{}',
  hash_anterior   bytea,
  hash            bytea NOT NULL
);
CREATE INDEX ix_auditoria_org_seq ON auditoria_evento (organizacao_id, seq);
CREATE INDEX ix_auditoria_paciente ON auditoria_evento (paciente_id, ocorrido_em DESC);
CREATE INDEX ix_auditoria_usuario ON auditoria_evento (usuario_id, ocorrido_em DESC);
