'use strict';
// Massa de demonstração (100% fictícia) para a conta do administrador extra: 3 hospitais com 5 pacientes internados cada,
// com anamnese, avaliação de risco, diagnóstico, evoluções e exames. Roda uma única vez (só se a organização não tiver hospitais).
// Usa as próprias rotas do sistema (mesmas regras, RLS e assinatura) para que os dados sejam idênticos aos de um uso real.

const DIM = ['ideacao_suicida', 'intencao_suicida', 'planejamento_suicida', 'acesso_meios', 'tentativas_anteriores', 'automutilacao', 'agressividade_terceiros', 'agitacao_psicomotora', 'sintomas_psicoticos_relevantes', 'vulnerabilidade', 'risco_fuga_evasao', 'risco_abstinencia', 'prejuizo_autocuidado'];

const HOSPITAIS = [
  { nome_fantasia: 'Hospital Psiquiátrico Santa Clara (fictício)', tipo: 'hospital_psiquiatrico', cidade: 'Niterói', uf: 'RJ', unidade: 'Enfermaria Masculina e Feminina', leito: 'SC-' },
  { nome_fantasia: 'Hospital Geral Vale Verde · Ala Psiquiátrica (fictício)', tipo: 'hospital_geral', cidade: 'Rio de Janeiro', uf: 'RJ', unidade: 'Ala Psiquiátrica 3º andar', leito: 'VV-' },
  { nome_fantasia: 'Clínica Recanto da Serra (fictícia)', tipo: 'clinica', cidade: 'Petrópolis', uf: 'RJ', unidade: 'Unidade de Dependência Química', leito: 'RS-' },
];

// [nome, nascimento, sexo, modalidade, dias internado, motivo, CID, descrição CID, anamnese{}, risco{nivel, presentes[], obs}, evoluções[[dias atrás, S, O/EM, conduta]], exames[[nome, tipo, texto, alterado, dias atrás]]]
const P = [
  // ---- Hospital 1
  ['Mariana Duarte Fictícia', '1987-03-14', 'feminino', 'voluntaria', 9, 'Episódio depressivo grave com ideação suicida estruturada', 'F32.2', 'Episódio depressivo grave sem sintomas psicóticos',
    { queixa_principal: 'Tristeza profunda, insônia e pensamentos de morte há 2 meses', hda_inicio_sintomas: 'Há cerca de 2 meses, após separação conjugal', hda_sintomas_predominantes: 'Humor deprimido, anedonia, insônia terminal, perda de 6 kg, culpa excessiva, ideação suicida com plano (ingestão de medicamentos)', hda_tratamentos_realizados: 'Sertralina 50 mg por 3 semanas, prescrita por clínico, sem resposta', hda_impacto_funcional: 'Afastada do trabalho há 4 semanas' },
    { nivel: 'alto', presentes: ['ideacao_suicida', 'planejamento_suicida', 'acesso_meios', 'vulnerabilidade'], fatores: 'Plano estruturado, acesso a medicamentos em casa, separação recente', protetores: 'Filha de 8 anos, vínculo com a irmã', conduta: 'Observação contínua, retirada de objetos perfurocortantes, família orientada a retirar medicamentos de casa' },
    [[8, 'Refere choro fácil e desesperança. Mantém ideação suicida passiva, nega plano atual.', 'Hipomímica, discurso lentificado, sono de 4 h.', 'Sertralina ajustada para 100 mg. Manter observação contínua.'],
     [4, 'Refere leve melhora do sono. Ainda com pensamentos de morte esporádicos.', 'Mais reativa, alimentando-se melhor.', 'Associada mirtazapina 15 mg à noite. Reavaliar risco em 48 h.'],
     [1, 'Diz que "a vontade de morrer diminuiu". Participou do grupo terapêutico.', 'Afeto mais modulado, sono de 6 h.', 'Manter esquema. Iniciar planejamento de alta com a família.']],
    [['Hemograma completo', 'laboratorial', 'Hb 11,2 g/dL (ref. 12-16), VCM 76 fL (ref. 80-100). Leucócitos e plaquetas normais.', true, 7],
     ['TSH e T4 livre', 'laboratorial', 'TSH 2,1 mUI/L (ref. 0,4-4,0); T4L 1,1 ng/dL (ref. 0,8-1,8).', false, 7]]],
  ['Carlos Eduardo Moreira Fictício', '1979-11-02', 'masculino', 'involuntaria', 6, 'Episódio maníaco com sintomas psicóticos, heteroagressividade', 'F31.2', 'Transtorno afetivo bipolar, episódio atual maníaco com sintomas psicóticos',
    { queixa_principal: 'Trazido pela família por agitação, gastos excessivos e agressividade', hda_inicio_sintomas: 'Há 10 dias, após suspender o lítio por conta própria', hda_sintomas_predominantes: 'Euforia, irritabilidade, redução da necessidade de sono, pressão de fala, delírios de grandeza (afirma ser dono de uma rede de bancos)', hda_tratamentos_realizados: 'Carbonato de lítio 900 mg/dia por 3 anos, com boa resposta até a suspensão', hda_complementar: 'Três internações prévias por mania' },
    { nivel: 'moderado', presentes: ['agressividade_terceiros', 'agitacao_psicomotora', 'sintomas_psicoticos_relevantes', 'risco_fuga_evasao'], fatores: 'Juízo crítico prejudicado, má adesão', protetores: 'Família presente e engajada', conduta: 'Contenção verbal, ambiente com baixa estimulação, reintrodução do lítio' },
    [[5, 'Irritado, afirma que não precisa de tratamento.', 'Taquilálico, fuga de ideias, dormiu 3 h.', 'Lítio 600 mg/dia reintroduzido e quetiapina 300 mg/dia. Solicitada litemia em 5 dias.'],
     [2, 'Mais calmo, ainda expansivo.', 'Sono de 6 h, discurso ainda acelerado.', 'Lítio aumentado para 900 mg/dia. Aguardar litemia.']],
    [['Litemia', 'laboratorial', 'Lítio sérico 1,4 mEq/L (ref. terapêutica 0,6-1,2), coletado 12 h após a última dose.', true, 1],
     ['Creatinina e ureia', 'laboratorial', 'Creatinina 1,3 mg/dL (ref. 0,7-1,2); ureia 48 mg/dL (ref. 15-45).', true, 1],
     ['TSH', 'laboratorial', 'TSH 5,8 mUI/L (ref. 0,4-4,0).', true, 1]]],
  ['Ana Beatriz Lopes Fictícia', '2001-07-21', 'feminino', 'voluntaria', 4, 'Autolesão recorrente e crise de instabilidade emocional', 'F60.3', 'Transtorno de personalidade emocionalmente instável',
    { queixa_principal: 'Cortes nos antebraços após briga com o namorado', hda_inicio_sintomas: 'Autolesões desde os 15 anos, piora há 1 mês', hda_sintomas_predominantes: 'Instabilidade afetiva, sentimento crônico de vazio, impulsividade, autolesões superficiais', hda_tratamentos_realizados: 'Psicoterapia irregular; fluoxetina 20 mg com uso irregular' },
    { nivel: 'moderado', presentes: ['automutilacao', 'tentativas_anteriores', 'ideacao_suicida'], fatores: 'Duas tentativas prévias por ingestão de medicamentos', protetores: 'Vínculo com a terapeuta, cursando faculdade', conduta: 'Plano de segurança construído com a paciente, curativos diários' },
    [[3, 'Refere arrependimento, pede alta.', 'Lesões superficiais em antebraço esquerdo, sem sinais de infecção.', 'Iniciada DBT em grupo. Manter fluoxetina 20 mg.'],
     [1, 'Mais estável, nega novos episódios de autolesão.', 'Afeto lábil, mas congruente.', 'Programar alta com seguimento ambulatorial em 7 dias.']],
    [['Beta-HCG', 'laboratorial', 'Negativo.', false, 3]]],
  ['José Ribamar Teixeira Fictício', '1958-01-30', 'masculino', 'involuntaria', 12, 'Agitação e confusão mental em idoso', 'F05.1', 'Delirium sobreposto à demência',
    { queixa_principal: 'Confusão mental, agitação noturna e alucinações visuais há 4 dias', hda_inicio_sintomas: 'Quadro agudo há 4 dias, com piora vespertina', hda_sintomas_predominantes: 'Desorientação, flutuação do nível de consciência, alucinações visuais, inversão do ciclo sono-vigília', hda_complementar: 'Diagnóstico prévio de doença de Alzheimer leve há 2 anos; diabetes e hipertensão' },
    { nivel: 'moderado', presentes: ['agitacao_psicomotora', 'risco_fuga_evasao', 'prejuizo_autocuidado', 'vulnerabilidade'], fatores: 'Idade, déficit cognitivo, risco de queda', protetores: 'Filhos presentes', conduta: 'Prevenção de quedas, reorientação frequente, investigar causa orgânica' },
    [[11, 'Desorientado no tempo e espaço.', 'Febril (38,1 °C), urina turva.', 'Solicitados EAS e urocultura. Haloperidol 0,5 mg se agitação.'],
     [7, 'Mais orientado pela manhã.', 'Afebril após antibiótico.', 'Manter antibiótico conforme clínica médica.'],
     [2, 'Família refere que voltou ao "jeito de antes".', 'Orientado parcialmente, sem alucinações há 3 dias.', 'Suspender haloperidol. Planejar alta com cuidador.']],
    [['EAS (urina tipo 1)', 'laboratorial', 'Leucocitúria intensa, nitrito positivo, bacteriúria.', true, 11],
     ['Sódio e potássio', 'laboratorial', 'Sódio 129 mEq/L (ref. 135-145); potássio 4,2 mEq/L.', true, 11],
     ['Tomografia de crânio', 'imagem', 'Atrofia cortical difusa compatível com a idade; sem sinais de lesão aguda.', false, 10]]],
  ['Fernanda Cristina Alves Fictícia', '1995-05-09', 'feminino', 'voluntaria', 3, 'Depressão pós-parto com ideias obsessivas', 'F53.0', 'Transtornos mentais e de comportamento leves associados ao puerpério',
    { queixa_principal: 'Tristeza e medo de machucar o bebê, 5 semanas após o parto', hda_inicio_sintomas: 'Duas semanas após o parto', hda_sintomas_predominantes: 'Humor deprimido, ansiedade intensa, pensamentos intrusivos e egodistônicos de causar dano ao bebê, com evitação', hda_complementar: 'Amamentando. Sem sintomas psicóticos.' },
    { nivel: 'moderado', presentes: ['ideacao_suicida', 'vulnerabilidade'], fatores: 'Puerpério, privação de sono', protetores: 'Marido e mãe muito presentes, crítica preservada', conduta: 'Visitas supervisionadas com o bebê, apoio à amamentação' },
    [[2, 'Sente culpa pelos pensamentos, chora muito.', 'Crítica preservada, sem psicose.', 'Iniciada sertralina 25 mg (compatível com amamentação). Psicoterapia diária.']],
    [['Hemograma completo', 'laboratorial', 'Hb 10,4 g/dL (ref. 12-16), ferritina 8 ng/mL (ref. 15-150).', true, 2]]],
  // ---- Hospital 2
  ['Roberto Lima Santos Fictício', '1990-09-17', 'masculino', 'involuntaria', 15, 'Esquizofrenia refratária em uso de clozapina', 'F20.0', 'Esquizofrenia paranoide',
    { queixa_principal: 'Ouve vozes que o ameaçam e se isolou no quarto', hda_inicio_sintomas: 'Primeiro surto aos 19 anos', hda_sintomas_predominantes: 'Alucinações auditivas de comando, delírios persecutórios, embotamento afetivo', hda_tratamentos_realizados: 'Risperidona e olanzapina em doses adequadas, sem resposta; clozapina iniciada há 20 dias', hda_resposta_tratamentos: 'Resposta parcial à clozapina até o momento' },
    { nivel: 'moderado', presentes: ['sintomas_psicoticos_relevantes', 'agressividade_terceiros', 'prejuizo_autocuidado'], fatores: 'Alucinações de comando', protetores: 'Mãe cuidadora', conduta: 'Vigilância, titulação da clozapina, hemograma semanal obrigatório' },
    [[14, 'Desconfiado, acredita que a comida está envenenada.', 'Alucinado, recusa parcial de alimentos.', 'Clozapina 200 mg/dia. Hemograma semanal.'],
     [7, 'Vozes menos frequentes.', 'Sialorreia noturna, taquicardia de repouso (FC 112 bpm).', 'Clozapina 300 mg/dia. Solicitar ECG e troponina.'],
     [1, 'Refere cansaço e dor no peito leve ao subir escadas.', 'FC 118 bpm, temperatura 37,9 °C.', 'Avaliação da clínica médica solicitada.']],
    [['Hemograma (controle clozapina)', 'laboratorial', 'Leucócitos 4.100/mm³; neutrófilos 1.600/mm³ (ref. > 1.500); eosinófilos 9%.', true, 2],
     ['Troponina I', 'laboratorial', 'Troponina I 0,09 ng/mL (ref. < 0,04).', true, 1],
     ['PCR', 'laboratorial', 'Proteína C reativa 38 mg/L (ref. < 5).', true, 1],
     ['Eletrocardiograma', 'eletrofisiologico', 'Taquicardia sinusal 116 bpm; QTc 448 ms; alterações inespecíficas da repolarização.', true, 1]]],
  ['Luciana Prado Vieira Fictícia', '1972-12-05', 'feminino', 'voluntaria', 7, 'Depressão recorrente com sintomas psicóticos', 'F33.3', 'Transtorno depressivo recorrente, episódio atual grave com sintomas psicóticos',
    { queixa_principal: 'Acredita que está "podre por dentro" e deixou de comer', hda_inicio_sintomas: 'Há 6 semanas', hda_sintomas_predominantes: 'Delírios niilistas e de culpa, recusa alimentar parcial, lentificação psicomotora', hda_complementar: 'Dois episódios depressivos prévios' },
    { nivel: 'alto', presentes: ['ideacao_suicida', 'sintomas_psicoticos_relevantes', 'prejuizo_autocuidado', 'vulnerabilidade'], fatores: 'Psicose congruente com o humor, recusa alimentar', protetores: 'Marido presente', conduta: 'Monitorar ingesta e peso diário; discutir eletroconvulsoterapia' },
    [[6, 'Diz que não merece comer.', 'Peso 51 kg (era 58 kg), ingesta de 30%.', 'Venlafaxina 150 mg e olanzapina 10 mg. Nutrição acompanhando.'],
     [2, 'Mantém ideias de ruína.', 'Ingesta de 40%, peso 50,2 kg.', 'Indicação de ECT discutida com a família.']],
    [['Albumina', 'laboratorial', 'Albumina 3,0 g/dL (ref. 3,5-5,0).', true, 5],
     ['Glicemia de jejum', 'laboratorial', 'Glicemia 88 mg/dL.', false, 5]]],
  ['Thiago Henrique Rocha Fictício', '2003-02-11', 'masculino', 'involuntaria', 5, 'Primeiro episódio psicótico', 'F23.1', 'Transtorno psicótico agudo polimorfo com sintomas esquizofrênicos',
    { queixa_principal: 'Comportamento bizarro e fala desorganizada há 2 semanas', hda_inicio_sintomas: 'Há 2 semanas, após uso intenso de cannabis', hda_sintomas_predominantes: 'Desorganização do pensamento, alucinações auditivas, insônia, ideias de referência' },
    { nivel: 'moderado', presentes: ['sintomas_psicoticos_relevantes', 'agitacao_psicomotora', 'risco_fuga_evasao'], fatores: 'Primeiro episódio, uso de substâncias', protetores: 'Pais engajados', conduta: 'Ambiente calmo, investigação orgânica completa' },
    [[4, 'Pouco colaborativo.', 'Discurso desagregado, alucinado.', 'Risperidona 2 mg/dia. Solicitar exames de rotina para primeiro episódio.'],
     [1, 'Mais organizado, aceita conversar.', 'Ainda com ideias de referência.', 'Risperidona 3 mg/dia.']],
    [['Toxicológico urinário', 'laboratorial', 'Positivo para canabinoides. Negativo para cocaína, anfetaminas e opioides.', true, 4],
     ['Prolactina', 'laboratorial', 'Prolactina 62 ng/mL (ref. 2-18).', true, 1],
     ['VDRL e anti-HIV', 'laboratorial', 'Não reagentes.', false, 4]]],
  ['Sebastiana Rodrigues Fictícia', '1949-06-22', 'feminino', 'voluntaria', 10, 'Depressão em idosa com declínio cognitivo', 'F32.1', 'Episódio depressivo moderado',
    { queixa_principal: 'Desânimo, esquecimento e isolamento após viuvez', hda_inicio_sintomas: 'Há 4 meses, após a morte do marido', hda_sintomas_predominantes: 'Humor deprimido, apatia, queixas de memória, hiporexia', hda_complementar: 'Em uso de hidroclorotiazida 25 mg e losartana 50 mg' },
    { nivel: 'baixo', presentes: ['vulnerabilidade', 'prejuizo_autocuidado'], fatores: 'Isolamento social, luto', protetores: 'Filhos presentes, religiosidade', conduta: 'Estimular atividades em grupo' },
    [[9, 'Pouco interesse nas atividades.', 'Mini-mental 22/30.', 'Iniciado escitalopram 5 mg.'],
     [3, 'Refere tontura ao levantar.', 'Mais sonolenta, PA 100x60.', 'Escitalopram 10 mg. Avaliar sódio.']],
    [['Sódio sérico', 'laboratorial', 'Sódio 126 mEq/L (ref. 135-145).', true, 2],
     ['Vitamina B12', 'laboratorial', 'B12 160 pg/mL (ref. 200-900).', true, 8]]],
  ['Pedro Augusto Nogueira Fictício', '1985-08-03', 'masculino', 'voluntaria', 2, 'Crise de pânico com agorafobia grave', 'F41.0', 'Transtorno de pânico',
    { queixa_principal: 'Ataques de pânico diários, não consegue sair de casa', hda_inicio_sintomas: 'Há 1 ano, com piora há 2 meses', hda_sintomas_predominantes: 'Taquicardia, dispneia, medo de morrer, evitação de locais públicos', hda_tratamentos_realizados: 'Clonazepam 2 mg/dia por conta própria há 8 meses' },
    { nivel: 'baixo', presentes: ['risco_abstinencia'], fatores: 'Uso prolongado de benzodiazepínico', protetores: 'Emprego estável, esposa', conduta: 'Desmame gradual do clonazepam' },
    [[1, 'Ansioso, com medo de ficar sem o clonazepam.', 'Sem sinais de abstinência.', 'Paroxetina 10 mg. Plano de redução gradual do clonazepam.']],
    [['Eletrocardiograma', 'eletrofisiologico', 'Ritmo sinusal, sem alterações.', false, 2]]],
  // ---- Hospital 3
  ['Marcos Vinícius Pereira Fictício', '1976-04-28', 'masculino', 'voluntaria', 3, 'Síndrome de abstinência alcoólica', 'F10.3', 'Transtornos mentais e comportamentais devidos ao uso de álcool, síndrome de abstinência',
    { queixa_principal: 'Tremores e ansiedade após parar de beber', hda_inicio_sintomas: 'Uso de 1 litro de destilado por dia há 10 anos; última dose há 36 h', hda_sintomas_predominantes: 'Tremor, sudorese, taquicardia, insônia, ansiedade', hda_complementar: 'Um episódio de convulsão por abstinência há 2 anos' },
    { nivel: 'moderado', presentes: ['risco_abstinencia', 'vulnerabilidade'], fatores: 'Convulsão prévia na abstinência', protetores: 'Desejo de parar, apoio da irmã', conduta: 'Escala CIWA-Ar a cada 4 h, diazepam conforme escore, tiamina' },
    [[2, 'Tremores e insônia.', 'CIWA-Ar 18, PA 160x100, FC 108.', 'Diazepam 10 mg a cada 6 h. Tiamina 300 mg IM.'],
     [0, 'Refere ver "bichos na parede".', 'Desorientado no tempo, CIWA-Ar 24, febre 38 °C.', 'Avaliar evolução para delirium tremens.']],
    [['Enzimas hepáticas', 'laboratorial', 'TGO 182 U/L, TGP 96 U/L (ref. < 40), GGT 640 U/L (ref. < 60).', true, 2],
     ['Magnésio e potássio', 'laboratorial', 'Magnésio 1,4 mg/dL (ref. 1,7-2,4); potássio 3,1 mEq/L (ref. 3,5-5,0).', true, 2]]],
  ['Juliana Ferreira Costa Fictícia', '1998-10-19', 'feminino', 'voluntaria', 8, 'Uso nocivo de cocaína com sintomas depressivos', 'F14.2', 'Síndrome de dependência de cocaína',
    { queixa_principal: 'Não consegue parar de usar cocaína', hda_inicio_sintomas: 'Uso desde os 18 anos, diário há 1 ano', hda_sintomas_predominantes: 'Fissura intensa, humor deprimido no período de abstinência, insônia' },
    { nivel: 'moderado', presentes: ['ideacao_suicida', 'risco_fuga_evasao', 'vulnerabilidade'], fatores: 'Ideação suicida na abstinência', protetores: 'Mãe presente', conduta: 'Grupo terapêutico, vigilância nos primeiros dias' },
    [[7, 'Fissura forte.', 'Inquieta, irritada.', 'Topiramato 25 mg. Terapia cognitivo-comportamental.'],
     [2, 'Fissura menor, dorme melhor.', 'Mais colaborativa.', 'Manter conduta.']],
    [['Toxicológico urinário', 'laboratorial', 'Positivo para cocaína na admissão.', true, 8]]],
  ['Antônio Carlos Mendes Fictício', '1968-02-14', 'masculino', 'voluntaria', 20, 'Dependência de álcool, reabilitação', 'F10.2', 'Síndrome de dependência do álcool',
    { queixa_principal: 'Deseja tratamento para o alcoolismo', hda_inicio_sintomas: 'Uso diário há 20 anos', hda_sintomas_predominantes: 'Perda de controle, prejuízo no trabalho e na família', hda_complementar: 'Esteatose hepática conhecida' },
    { nivel: 'baixo', presentes: ['vulnerabilidade'], fatores: 'Recaídas prévias', protetores: 'Motivação, emprego', conduta: 'Programa de reabilitação' },
    [[15, 'Sem sintomas de abstinência.', 'Estável.', 'Naltrexona 50 mg iniciada.'],
     [5, 'Participando bem das atividades.', 'Humor estável.', 'Planejar alta e grupo de mútua ajuda.']],
    [['Enzimas hepáticas (controle)', 'laboratorial', 'TGO 45 U/L, TGP 52 U/L (ref. < 40), GGT 120 U/L.', true, 6]]],
  ['Beatriz Helena Souza Fictícia', '1993-01-07', 'feminino', 'voluntaria', 5, 'Dependência de benzodiazepínicos', 'F13.2', 'Síndrome de dependência de sedativos ou hipnóticos',
    { queixa_principal: 'Usa alprazolam em doses cada vez maiores', hda_inicio_sintomas: 'Alprazolam 0,5 mg há 4 anos, hoje 6 mg/dia', hda_sintomas_predominantes: 'Tolerância, ansiedade de rebote, uso compulsivo' },
    { nivel: 'moderado', presentes: ['risco_abstinencia'], fatores: 'Doses altas, risco de convulsão', protetores: 'Crítica preservada', conduta: 'Substituição por clonazepam e redução de 10% por semana' },
    [[4, 'Ansiosa, medo da abstinência.', 'Sem tremores.', 'Clonazepam 4 mg/dia em substituição.'],
     [1, 'Dormiu mal.', 'Ansiedade moderada.', 'Manter dose esta semana.']],
    [['Eletroencefalograma', 'eletrofisiologico', 'Atividade beta difusa, compatível com efeito de benzodiazepínico. Sem atividade epileptiforme.', false, 3]]],
  ['Rafael Gomes Barbosa Fictício', '1982-06-30', 'masculino', 'involuntaria', 4, 'Intoxicação e psicose por uso de crack', 'F14.5', 'Transtorno psicótico devido ao uso de cocaína',
    { queixa_principal: 'Trazido pelo SAMU por agitação e paranoia', hda_inicio_sintomas: 'Uso de crack há 5 anos, intenso na última semana', hda_sintomas_predominantes: 'Paranoia, agitação, alucinações táteis, emagrecimento' },
    { nivel: 'alto', presentes: ['agressividade_terceiros', 'agitacao_psicomotora', 'sintomas_psicoticos_relevantes', 'risco_fuga_evasao', 'prejuizo_autocuidado'], fatores: 'Agressividade na admissão', protetores: 'Nenhum identificado', conduta: 'Contenção mecânica por 2 h na admissão, haloperidol' },
    [[3, 'Agitado, desconfiado.', 'Paranoide, emagrecido (IMC 17).', 'Haloperidol 5 mg/dia. Dieta hipercalórica.'],
     [0, 'Mais calmo, pede para ir embora.', 'Sem alucinações.', 'Reduzir haloperidol para 2,5 mg/dia.']],
    [['Hemograma completo', 'laboratorial', 'Leucócitos 11.800/mm³; Hb 12,9 g/dL.', true, 3],
     ['CPK', 'laboratorial', 'CPK 1.850 U/L (ref. < 190).', true, 3]]],
];

module.exports = async function demo(pool, routes, env) {
  const email = String(env.ADMIN_EXTRA_EMAIL || '').trim().toLowerCase(); if (!email) return;
  const u = (await pool.query(`SELECT u.id, u.nome_completo, m.organizacao_id, m.papel FROM mednexo.usuario u JOIN mednexo.organizacao_membro m ON m.usuario_id = u.id WHERE u.email = $1 LIMIT 1`, [email])).rows[0];
  if (!u) return;
  if ((await pool.query('SELECT count(*)::int n FROM mednexo.hospital WHERE organizacao_id = $1', [u.organizacao_id])).rows[0].n) return;
  const ctx = { org: u.organizacao_id, uid: u.id, ip: '127.0.0.1', ua: 'demo', rid: require('crypto').randomUUID() };
  const s = { uid: u.id, org: u.organizacao_id, papel: u.papel, nome: u.nome_completo };
  const call = (k, b, q = {}) => pool.tx(c => routes[k](s, c, q, b, ctx), ctx);
  const iso = d => new Date(Date.now() - d * 864e5).toISOString();
  const cids = {};
  for (const p of P) if (!cids[p[6]]) cids[p[6]] = (await call('POST /api/cid', { versao: 'CID-10', codigo: p[6], descricao: p[7] })).id;
  let n = 0;
  for (let h = 0; h < 3; h++) {
    const H = HOSPITAIS[h];
    const hid = (await call('POST /api/hospitais', H)).id;
    const un = (await call('POST /api/unidades', { hospital_id: hid, nome: H.unidade })).id;
    await call('POST /api/leitos', { unidade_id: un, identificacao: H.leito, quantidade: 8, tipo_acomodacao: 'enfermaria' });
    const leitos = (await pool.query('SELECT id FROM mednexo.leito WHERE unidade_id = $1 ORDER BY identificacao', [un])).rows;
    for (let k = 0; k < 5; k++) {
      const [nome, nasc, sexo, modal, dias, motivo, cid, , an, rk, evs, exs] = P[h * 5 + k];
      try {
        const pac = await call('POST /api/pacientes', { nome_completo: nome, nome_mae: 'Mãe de ' + nome.split(' ')[0] + ' (fictícia)', data_nascimento: nasc, sexo });
        const adm = iso(dias + 0.2);
        const iid = await pool.tx(async c => {
          const prof = (await c.query('SELECT id FROM mednexo.profissional WHERE usuario_id = $1', [ctx.uid])).rows[0];
          const i = (await c.query(`INSERT INTO mednexo.internacao (organizacao_id, paciente_id, hospital_id, modalidade, profissional_responsavel_id, data_admissao) VALUES ($1,$2,$3,$4::mednexo.modalidade_internacao,$5,$6) RETURNING id`, [ctx.org, pac.id, hid, modal, prof.id, adm])).rows[0];
          await c.query('INSERT INTO mednexo.internacao_clinico (internacao_id, organizacao_id, motivo_internacao) VALUES ($1,$2,$3)', [i.id, ctx.org, motivo]);
          await c.query(`INSERT INTO mednexo.internacao_movimentacao (organizacao_id, internacao_id, hospital_id, leito_id, tipo, inicio) VALUES ($1,$2,$3,$4,'admissao',$5)`, [ctx.org, i.id, hid, leitos[k].id, adm]);
          return i.id;
        }, ctx);
        const just = 'Registro de demonstração com dados fictícios';
        await call('POST /api/pacientes/alergias', { paciente_id: pac.id, status: 'sem_alergias_conhecidas' });
        await call('POST /api/anamneses', { internacao_id: iid, fonte_informacao: 'Paciente e familiar', confiabilidade_relato: 'boa', ...an, ocorrido_em: iso(dias), justificativa_retroativo: just, assinar: true });
        await call('POST /api/diagnosticos', { internacao_id: iid, cid_id: cids[cid], situacao: 'confirmado', momento: 'admissao', principal: true });
        await call('POST /api/riscos', { internacao_id: iid, nivel_risco: rk.nivel, justificativa_nivel: rk.fatores, fatores_risco: rk.fatores, fatores_protetores: rk.protetores, conduta: rk.conduta, avaliacao_clinica: `Risco ${rk.nivel} definido pelo médico após entrevista e dados da família. ${rk.fatores}.`, necessita_reavaliacao: true, reavaliar_em: iso(-1),
          itens: DIM.map(d => ({ dimensao: d, situacao: rk.presentes.includes(d) ? 'presente' : 'ausente' })), ocorrido_em: iso(dias), justificativa_retroativo: just, assinar: true });
        for (const [d, sub, obj, cond] of evs) await call('POST /api/evolucoes', { internacao_id: iid, motivo: 'rotina', subjetivo: sub, objetivo: obj, conduta: cond, ocorrido_em: iso(d + 0.1), justificativa_retroativo: d > 0 ? just : null, assinar: true });
        for (const [nm, tipo, txt, alt, d] of exs) await call('POST /api/exames', { internacao_id: iid, nome_exame: nm, tipo, resultado_texto: txt, resultado_alterado: alt, coletado_em: iso(d + 0.3), resultado_em: iso(d) });
        n++;
      } catch (e) { console.error('demo: paciente', nome, '-', e.message); }
    }
  }
  console.log(`Demonstração criada para ${email}: 3 hospitais, ${n} pacientes fictícios.`);
};
