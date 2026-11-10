# MEDNEXO — Arquitetura Técnica (v1.0)

**PEP multi-hospital para médicos que acompanham pacientes internados em vários hospitais.**
Documento de entrega para a IA/equipe desenvolvedora. O banco de dados (PostgreSQL 16) já está implementado e testado nos scripts `01..04`; **as regras críticas vivem no banco** (constraints, triggers, RLS) e a API não deve reimplementá-las de forma divergente — apenas respeitá-las e traduzir erros.

> Aviso: sistema de apoio à documentação clínica. Não substitui julgamento médico. Catálogos clínicos (CID, medicamentos, doses, interações) **não vêm preenchidos** de propósito (ver §6).

---
## 1. Princípios inegociáveis

1. **Integridade do prontuário > aparência.** Registro assinado é imutável; correção só por adendo; anulação exige motivo e permissão; nada clínico é apagado.
2. **Paciente ≠ internação ≠ hospital.** Paciente é cadastro permanente único por organização. Cada internação é um episódio independente, em um hospital, com prontuário próprio. Um paciente só pode ter **uma internação ativa** por vez.
3. **Privacidade entre hospitais e papéis** garantida no banco (RLS), não só na API.
4. **Nada de classificação automática de risco.** O nível de risco é sempre escolha explícita do profissional; "não avaliado" nunca vira "ausente"; nunca se exibe "paciente seguro".
5. **Auditoria encadeada por hash**, append-only; leituras clínicas também são auditadas.
6. **IA só como assistente** (rascunho/resumo), nunca grava nem assina sozinha (Etapa 5).

## 2. Stack e implantação

- PostgreSQL 16 (schema `mednexo`), extensões `pgcrypto`, `btree_gist`, `unaccent`, `pg_trgm` (instaladas em `public`).
- API sugerida: Node/TypeScript (NestJS ou Fastify) + driver `pg`; front React/TS PWA. Qualquer stack serve desde que cumpra o **contrato de sessão** (§4).
- Papéis de banco: `mednexo_app` (NOLOGIN; a API faz `SET LOCAL ROLE`/login com um usuário membro dele; não é dono, sem BYPASSRLS) e `mednexo_auth` (serviço de login; único que lê `senha_hash`/MFA).
- Produção exige: HTTPS, backup criptografado, segredos fora do código, storage de arquivos fora do banco (tabela `arquivo` guarda metadados + `sha256` + `storage_chave`).

## 3. Modelo de dados (61 tabelas, 8 views)

**Multi-tenant:** toda tabela de negócio tem `organizacao_id`; FKs **compostas** `(id, organizacao_id)` impedem referência cruzada entre organizações.

| Domínio | Tabelas |
|---|---|
| Organização/acesso | organizacao, usuario, profissional, organizacao_membro, membro_hospital, papel_permissao |
| Hospitais | hospital, hospital_contato, hospital_contrato_dados, operadora, hospital_operadora, unidade_internacao, leito |
| Paciente | paciente, paciente_responsavel, paciente_convenio, paciente_hospital, paciente_alergia, paciente_medicacao_previa, paciente_evento_historico |
| Internação | internacao (administrativo), internacao_clinico (motivo etc.), internacao_equipe, internacao_movimentacao (leitos), diagnostico, cid |
| Registro clínico | registro_clinico (supertipo) + anamnese, anamnese_substancia, exame_estado_mental, eem_dominio, eem_item, eem_catalogo, avaliacao_risco, avaliacao_risco_item, evolucao, intercorrencia, prescricao, prescricao_item, alerta_prescricao, receita, receita_item, documento_clinico, resumo_alta, resumo_alta_diagnostico, registro_adendo, registro_arquivo |
| Catálogos de segurança | principio_ativo, medicamento_apresentacao, faixa_dose_referencia, interacao_medicamentosa |
| Documentos | arquivo, exame, modelo_documento, pdf_gerado, compartilhamento_documento |
| Operação | regra_pendencia, agenda_compromisso, ia_interacao |
| Sistema | auditoria_evento, contador |

**Views** (`security_invoker`, respeitam RLS do chamador): `vw_painel_internados`, `vw_paciente_cabecalho`, `vw_linha_do_tempo`, `vw_pendencias`, `vw_leito_atual`, `vw_ultimo_risco`, `vw_medicacao_ativa`, e `vw_paciente_episodios` (exceção deliberada: mostra que existem episódios em outros hospitais **sem** conteúdo clínico).

### 3.1 Identidade do paciente
Único por organização por **CPF** (quando existe) e por **nome normalizado + nascimento + nome da mãe** (sem acento/caixa/espaços duplicados). `numero`/`codigo` (PAC-000001) sequenciais e imutáveis. CPF validado por dígito verificador. Duplicata ⇒ erro `ux_paciente_cpf` / `ux_paciente_identidade`: a API deve oferecer "abrir o cadastro existente".

### 3.2 Internação
- `internacao`: dados administrativos (hospital, modalidade, responsável, admissão, convênio, MP). `internacao_clinico`: motivo e conteúdo clínico (separado para o **administrativo nunca ler clínico**).
- Índice único parcial garante 1 internação ativa por paciente.
- Leito: **fonte única** = `internacao_movimentacao` com `EXCLUDE gist` (leito não pode ter dois ocupantes no mesmo intervalo). Troca de leito fecha a anterior.
- Médico responsável entra automaticamente em `internacao_equipe`.
- Encerramento **só via** `encerrar_internacao(id, motivo, destino, data_alta)`: exige resumo de alta **assinado** (exceto evasão/óbito) e nenhum rascunho pendente; libera o leito; internação encerrada fica imutável e não aceita novos registros (adendos continuam permitidos).
- Internação involuntária: pendência de comunicação ao Ministério Público em 72 h (Lei 10.216) via `regra_pendencia`.

### 3.3 Registro clínico (supertipo/subtipo)
`registro_clinico` (cabeçalho: tipo, internação, autor, `ocorrido_em` vs `registrado_em`, status, hash) + tabela 1:1 por tipo (PK = `registro_id`). Tipos: anamnese, exame_estado_mental, avaliacao_risco, evolucao, intercorrencia, prescricao, receita, documento, resumo_alta, parecer etc.

Regras (em trigger):
- Criar: `autor_usuario_id` deve ser o usuário da sessão; hospital/paciente devem ser os da internação (FK composta); internação ativa.
- Retroativo (> 12 h) exige `justificativa_retroativo`; `ocorrido_em` não pode ser anterior à admissão nem futuro.
- Rascunho: só o autor edita; pode ser descartado (fica na auditoria).
- **Assinar:** `SELECT assinar_registro(id [, tipo, assinatura_externa])` — valida pendências do tipo (lista tudo que falta), calcula **SHA-256 do JSON canônico (UTC)** do cabeçalho + subtipo + filhos, grava hash, assinante, data. A assinatura roda dentro do trigger; não dá para forjar via UPDATE.
- Assinado: cabeçalho, subtipo e filhos **imutáveis** (UPDATE/DELETE bloqueados). `verificar_integridade_registro(id)` recomputa e compara o hash.
- **Adendo:** `registro_adendo` (append-only; tipo, justificativa, conteúdo) — única forma de complementar/corrigir.
- **Anulação:** `anular_registro(id, motivo ≥ 10 chars)`; status final `anulado`, conteúdo preservado.

### 3.4 Regras clínicas de segurança
- **Risco:** 13 dimensões obrigatórias (`avaliacao_risco_item`), situação `presente|ausente|nao_avaliado`; `nao_avaliado` exige motivo; nível (`baixo|moderado|alto|iminente`) só pelo profissional; "baixo" com ideação/intenção/plano/tentativa **presente** exige `justificativa_nivel`; reavaliação com data posterior à avaliação.
- **EEM:** 15 domínios obrigatórios (avaliado ou não avaliado + motivo); achados só do catálogo `eem_catalogo`; domínio avaliado exige ≥ 1 achado.
- **Alergias:** `paciente.alergias_status` (`nao_avaliado|sem_alergias_conhecidas|possui_alergias`). `nao_avaliado` gera alerta **grave** em toda prescrição. Cadastrar alergia atualiza o status.
- **Prescrição:** itens só de `medicamento_apresentacao` (catálogo); via ∈ vias permitidas; SOS exige indicação + dose máxima/24 h; alteração/suspensão exige `item_anterior_id` + motivo (**o original nunca é editado**).
- **Alertas** (`avaliar_alertas_prescricao(registro)` — a API chama ao salvar o rascunho; alertas ficam persistidos): alergia ao princípio ativo (contraindicada), interação medicamentosa, duplicidade, via, dose acima da faixa (unitária/diária), alergias não avaliadas. Alerta grave/contraindicado **bloqueia a assinatura** até `justificativa_medica` (mín. 10 caracteres). Alertas sem justificativa são recalculados; justificados são preservados e entram no hash.
- **Diagnóstico:** CID de catálogo, situação (hipótese/confirmado/descartado…), momento, único principal ativo por internação; trocar CID = encerrar e criar novo (histórico); responsável vem da sessão.
- **Receitas controladas:** não há numeração própria; exige dados de emissão oficial externa + assinatura ICP-Brasil (`tipo_assinatura`).
- **Exportação:** PDF gerado é append-only (`pdf_gerado`, código de validação); compartilhar por WhatsApp/e-mail exige `conferiu_destinatario`, finalidade e destinatário (`compartilhamento_documento`). Compartilhamento é via share nativo do dispositivo; o sistema só registra.

## 4. Contrato de sessão (obrigatório para a API)

Dentro de **cada transação** da API, antes de qualquer consulta:

```sql
SET LOCAL ROLE mednexo_app;
SELECT set_config('app.organizacao_id', :org, true),
       set_config('app.usuario_id',     :uid, true),
       set_config('app.ip',             :ip,  true),
       set_config('app.user_agent',     :ua,  true),
       set_config('app.dispositivo',    :dev, true),
       set_config('app.request_id',     :rid, true);
```
Sem isso, RLS não retorna nada (falha fechada). Use pool com transação por requisição (nunca `SET` de sessão). Leituras clínicas: chame `auditar_acesso(acao, entidade, entidade_id, paciente_id, internacao_id, detalhes jsonb)`.
Autenticação (senha/Argon2, MFA TOTP, sessões) é da API usando `mednexo_auth`; o banco só confia em `app.usuario_id` já autenticado.

## 5. Permissões

Papéis: `medico_administrador`, `medico_assistente`, `medico_consultor`, `enfermagem`, `administrativo`, `auditor`, `admin_plataforma` (matriz em `papel_permissao`, seeds em `03_seeds.sql`). Acesso clínico exige **vínculo com o hospital** (`membro_hospital`) **e** pertencer à **equipe da internação** (`internacao_equipe`).

| Papel | Resumo |
|---|---|
| medico_administrador | tudo da organização, gerir usuários/hospitais/equipe, anular |
| medico_assistente | ler/escrever/assinar nas internações em que está na equipe |
| medico_consultor | apenas parecer, nas internações em que foi incluído |
| enfermagem | ler tipos **assistenciais** + alergias; sem diagnóstico, anamnese, EEM, alta |
| administrativo | cadastro e dados administrativos da internação; **nenhum** conteúdo clínico |
| auditor | leitura da trilha de auditoria; sem escrita |
| admin_plataforma | sem acesso a conteúdo clínico |

### 5.1 Chaves JSON de campos livres da anamnese
Os campos `jsonb` da anamnese (história psiquiátrica, familiar, social, exame físico) devem usar chaves estáveis em `snake_case` definidas pelo front e versionadas em `modelo_documento`; o banco valida apenas que são objeto JSON. Nunca guardar dado obrigatório só dentro de jsonb.

## 6. Catálogos clínicos — NÃO preenchidos

`cid`, `principio_ativo`, `medicamento_apresentacao`, `faixa_dose_referencia`, `interacao_medicamentosa` vêm **vazios**. Carregar a partir de fonte oficial/revisada (CID-10 DATASUS/CID-11 OMS, bula/ANVISA/RENAME, base de interações licenciada) com `fonte` e `revisado_em/revisado_por` preenchidos. Médico responsável revisa antes de produção. Enquanto vazios, o sistema não emite alerta de dose/interação — a UI deve exibir "base de referência não carregada". Os testes usam dados **fictícios** rotulados "TESTE".

## 7. Auditoria, LGPD

- `auditoria_evento`: append-only, encadeada (`hash_anterior`→`hash`), trigger de imutabilidade, `verificar_cadeia_auditoria(org)` retorna os elos quebrados (vazio = íntegra). Rodar diariamente e alertar.
- Triggers automáticos auditam todo DML clínico; a API audita leituras e exportações.
- LGPD: base legal = tutela da saúde; minimização (administrativo sem clínico); acesso por necessidade; trilha de quem viu o quê; exportação/compartilhamento registrados; retenção mínima legal de prontuário (20 anos) — **não implementar exclusão**; anonimização só por rotina aprovada pelo DPO. Dados sensíveis nunca em logs de aplicação.

## 8. Guia da API (resumo)

- Erros de banco são mensagens em português com a lista de pendências: repassar ao usuário.
- Fluxos: criar rascunho → salvar subtipo/filhos → (prescrição) `avaliar_alertas_prescricao` → justificar alertas → `assinar_registro`.
- Idempotência em POST de criação (`request_id`). Paginação por `ocorrido_em`/`id`.
- Endpoints mínimos: auth/MFA, hospitais, pacientes (busca com `pg_trgm`), internações (admitir, mover leito, encerrar), registros por tipo (+assinar, anular, adendo), prescrição/alertas, diagnósticos, alergias, painel, pendências, linha do tempo, PDF/compartilhamento, auditoria.
- Front: PWA, painel do dia por hospital, cabeçalho fixo do paciente (alergias, risco vigente, medicação ativa), rascunho autosave, bloqueio visual de assinado.

## 9. Testes de aceite (`04_testes.sql`, 113 verificações — todas passam)

Cobre: 3 hospitais; paciente único sem duplicar; duas internações em hospitais diferentes; leito/histórico; evolução rascunho→assinada→imutável→adendo→anulação; adulteração detectada por hash; risco e EEM completos; prescrição, alertas e bloqueio; alta e encerramento; isolamento por hospital/equipe/papel/organização; administrativo sem clínico; auditoria encadeada e detecção de adulteração; PDF/compartilhamento. Rodar em banco descartável: `psql -v ON_ERROR_STOP=1 -f 01..04`.

## 10. Roadmap

1. **Fundação** (este pacote): banco, RLS, auth, hospitais, pacientes, internações.
2. **PEP núcleo:** anamnese, EEM, risco, evolução, diagnósticos, alta, painel, pendências.
3. **Prescrição e documentos:** catálogos revisados, alertas, receitas (ICP-Brasil), PDF, compartilhamento.
4. **Operação:** agenda, produção por hospital, relatórios, auditoria/LGPD UI, PWA offline leve.
5. **IA assistiva:** resumo/rascunho de evolução, sempre revisado e assinado pelo médico; log em `ia_interacao`.

## 11. Pontos que exigem decisão humana antes de produção
Fonte/licença dos catálogos; provedor ICP-Brasil; política de retenção/backup; DPO e termos LGPD; hospedagem com HTTPS/domínio; revisão clínica das listas de pendências padrão (`semear_regras_pendencia`).
