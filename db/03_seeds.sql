-- =====================================================================
-- MEDNEXO — 03_seeds.sql : matriz de permissões e catálogo do Exame do Estado Mental
-- NÃO semeia: CID (importar do DATASUS/OMS), medicamentos, faixas de dose e interações
-- (esses catálogos exigem fonte e revisão clínica registradas — ver ARQUITETURA §6).
-- =====================================================================
SET search_path = mednexo, public;

INSERT INTO papel_permissao (papel, permissao) VALUES
 -- plataforma: gestão técnica, SEM acesso clínico
 ('admin_plataforma','usuario.gerir'),('admin_plataforma','cadastro.hospital.gerir'),
 -- médico administrador (sócio gestor)
 ('medico_administrador','usuario.gerir'),('medico_administrador','cadastro.hospital.gerir'),
 ('medico_administrador','paciente.cadastro.ler'),('medico_administrador','paciente.cadastro.escrever'),
 ('medico_administrador','internacao.escrever'),('medico_administrador','equipe.gerir'),
 ('medico_administrador','clinico.ler'),('medico_administrador','clinico.escrever'),
 ('medico_administrador','clinico.assinar'),('medico_administrador','clinico.anular'),
 ('medico_administrador','documento.exportar'),('medico_administrador','documento.compartilhar'),
 ('medico_administrador','auditoria.ler'),('medico_administrador','ia.usar'),
 -- médico assistente
 ('medico_assistente','paciente.cadastro.ler'),('medico_assistente','paciente.cadastro.escrever'),
 ('medico_assistente','internacao.escrever'),('medico_assistente','clinico.ler'),
 ('medico_assistente','clinico.escrever'),('medico_assistente','clinico.assinar'),
 ('medico_assistente','clinico.anular'),('medico_assistente','documento.exportar'),
 ('medico_assistente','documento.compartilhar'),('medico_assistente','ia.usar'),
 -- médico consultor: lê o necessário e escreve apenas pareceres
 ('medico_consultor','paciente.cadastro.ler'),('medico_consultor','clinico.ler'),
 ('medico_consultor','clinico.escrever.parecer'),('medico_consultor','clinico.assinar'),
 ('medico_consultor','documento.exportar'),
 -- enfermagem: somente conteúdo assistencial (evolução, intercorrência, prescrição, risco, exames, alergias)
 ('enfermagem','paciente.cadastro.ler'),('enfermagem','clinico.ler.assistencial'),
 -- auditor: leitura e trilha de auditoria
 ('auditor','paciente.cadastro.ler'),('auditor','clinico.ler'),('auditor','auditoria.ler'),
 -- administrativo: dados administrativos, NUNCA conteúdo clínico
 ('administrativo','paciente.cadastro.ler'),('administrativo','paciente.cadastro.escrever'),
 ('administrativo','internacao.escrever'),('administrativo','cadastro.hospital.gerir');

INSERT INTO eem_catalogo (dominio, codigo, descricao, ordem) VALUES
 ('aparencia','higiene_adequada','Higiene adequada',1),('aparencia','higiene_precaria','Higiene precária',2),
 ('aparencia','vestimenta_adequada','Vestimenta adequada',3),('aparencia','vestimenta_inadequada','Vestimenta inadequada',4),
 ('aparencia','aspecto_cuidado','Apresentação cuidada',5),('aparencia','aspecto_descuidado','Apresentação descuidada',6),
 ('atitude','cooperativo','Cooperativo',1),('atitude','desconfiado','Desconfiado',2),
 ('atitude','hostil','Hostil',3),('atitude','retraido','Retraído',4),('atitude','outra','Outra (descrever)',9),
 ('consciencia','vigil','Vigil',1),('consciencia','sonolento','Sonolento',2),
 ('consciencia','rebaixado','Rebaixado',3),('consciencia','outra','Outra (descrever)',9),
 ('orientacao','orientado_tempo','Orientado no tempo',1),('orientacao','desorientado_tempo','Desorientado no tempo',2),
 ('orientacao','orientado_espaco','Orientado no espaço',3),('orientacao','desorientado_espaco','Desorientado no espaço',4),
 ('orientacao','orientado_pessoa','Orientado quanto à pessoa',5),('orientacao','desorientado_pessoa','Desorientado quanto à pessoa',6),
 ('orientacao','orientado_situacao','Orientado quanto à situação',7),('orientacao','desorientado_situacao','Desorientado quanto à situação',8),
 ('atencao','preservada','Preservada',1),('atencao','hipovigilancia','Hipovigilância',2),
 ('atencao','distraibilidade','Distraibilidade',3),('atencao','outra','Outra (descrever)',9),
 ('psicomotricidade','normal','Normal',1),('psicomotricidade','agitacao','Agitação',2),
 ('psicomotricidade','retardo','Retardo',3),('psicomotricidade','outra','Outra (descrever)',9),
 ('humor','eutimico','Eutímico',1),('humor','deprimido','Deprimido',2),
 ('humor','irritavel','Irritável',3),('humor','elevado','Elevado',4),('humor','outra','Outra (descrever)',9),
 ('afeto','modulado','Modulado',1),('afeto','hipomodulado','Hipomodulado',2),('afeto','embotado','Embotado',3),
 ('afeto','labil','Lábil',4),('afeto','congruente','Congruente',5),('afeto','incongruente','Incongruente',6),
 ('pensamento','curso_normal','Curso normal',1),('pensamento','curso_acelerado','Curso acelerado',2),
 ('pensamento','curso_lentificado','Curso lentificado',3),('pensamento','fuga_de_ideias','Fuga de ideias',4),
 ('pensamento','desagregacao','Desagregação',5),('pensamento','pobreza_de_conteudo','Pobreza de conteúdo',6),
 ('pensamento','conteudo_delirante','Conteúdo delirante (descrever)',7),('pensamento','ideias_obsessivas','Ideias obsessivas',8),
 ('pensamento','sem_alteracoes','Sem alterações de forma e conteúdo',9),
 ('sensopercepcao','sem_alteracoes','Sem alterações',1),('sensopercepcao','alucinacoes_auditivas','Alucinações auditivas',2),
 ('sensopercepcao','alucinacoes_visuais','Alucinações visuais',3),('sensopercepcao','alucinacoes_outras','Outras alucinações (descrever)',4),
 ('sensopercepcao','ilusoes','Ilusões',5),
 ('memoria','imediata_preservada','Imediata preservada',1),('memoria','imediata_comprometida','Imediata comprometida',2),
 ('memoria','recente_preservada','Recente preservada',3),('memoria','recente_comprometida','Recente comprometida',4),
 ('memoria','remota_preservada','Remota preservada',5),('memoria','remota_comprometida','Remota comprometida',6),
 ('linguagem','fluente','Fluente',1),('linguagem','velocidade_aumentada','Velocidade aumentada',2),
 ('linguagem','velocidade_diminuida','Velocidade diminuída',3),('linguagem','coerente','Coerente',4),
 ('linguagem','incoerente','Incoerente',5),('linguagem','mutismo','Mutismo',6),
 ('juizo_critico','preservado','Preservado',1),('juizo_critico','comprometido','Comprometido',2),
 ('insight','preservado','Preservado',1),('insight','parcial','Parcial',2),('insight','ausente','Ausente',3),
 ('cognicao','sem_alteracoes','Sem alterações observadas',1),('cognicao','alteracoes_observadas','Alterações observadas (descrever)',2);
