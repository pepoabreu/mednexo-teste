'use strict';
// Integração com o Asaas: assinatura do MedNexo (conta principal), subcontas dos médicos, cobrança da teleconsulta
// com split da taxa da plataforma, estorno, NFS-e do médico e webhook. A chave principal e as chaves das subcontas
// nunca vão para o navegador; as das subcontas ficam cifradas (AES-256-GCM) no banco.
const crypto = require('crypto');

const MIGRACAO = `
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS asaas_customer_id text;
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS asaas_subscription_id text;
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS assinatura_plano text;
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS assinatura_valor numeric(12,2);
ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS assinatura_status text;
ALTER TABLE mednexo.teleconsulta ADD COLUMN IF NOT EXISTS valor numeric(12,2) NOT NULL DEFAULT 0 CHECK (valor >= 0);
ALTER TABLE mednexo.teleconsulta ADD COLUMN IF NOT EXISTS pago_em timestamptz;
ALTER TABLE mednexo.teleconsulta ADD COLUMN IF NOT EXISTS reembolsado_em timestamptz;
CREATE TABLE IF NOT EXISTS mednexo.cobranca (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL REFERENCES mednexo.organizacao(id),
  tipo text NOT NULL CHECK (tipo IN ('assinatura','teleconsulta')),
  conta_usuario_id uuid REFERENCES mednexo.usuario(id),       -- NULL = conta principal do MedNexo; senão, subconta do médico
  teleconsulta_id uuid REFERENCES mednexo.teleconsulta(id),
  asaas_payment_id text UNIQUE NOT NULL,
  asaas_customer_id text,
  valor numeric(12,2) NOT NULL, valor_liquido numeric(12,2),
  status text NOT NULL, vencimento date, pago_em timestamptz,
  invoice_url text, descricao text,
  criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ix_cobranca_org ON mednexo.cobranca (organizacao_id, tipo, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_cobranca_tele ON mednexo.cobranca (teleconsulta_id);
CREATE TABLE IF NOT EXISTS mednexo.medico_recebimento (
  usuario_id uuid PRIMARY KEY REFERENCES mednexo.usuario(id),
  organizacao_id uuid NOT NULL REFERENCES mednexo.organizacao(id),
  asaas_account_id text NOT NULL, wallet_id text NOT NULL, chave_cifrada text NOT NULL,
  titular_nome text, titular_documento text,
  preco_teleconsulta numeric(12,2), servico_municipal text, aliquota_iss numeric(5,2),
  webhook_ok boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mednexo.nota_fiscal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL REFERENCES mednexo.organizacao(id),
  teleconsulta_id uuid REFERENCES mednexo.teleconsulta(id),
  cobranca_id uuid REFERENCES mednexo.cobranca(id),
  asaas_invoice_id text UNIQUE NOT NULL, status text NOT NULL, pdf_url text, numero text, erro text,
  criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS mednexo.asaas_evento (id text PRIMARY KEY, evento text, recebido_em timestamptz NOT NULL DEFAULT now(), payload jsonb);
ALTER TABLE mednexo.cobranca ENABLE ROW LEVEL SECURITY;
ALTER TABLE mednexo.medico_recebimento ENABLE ROW LEVEL SECURITY;
ALTER TABLE mednexo.nota_fiscal ENABLE ROW LEVEL SECURITY;
ALTER TABLE mednexo.asaas_evento ENABLE ROW LEVEL SECURITY;
`;
const PAGO = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const PLANOS = { individual: 'Individual', equipe: 'Equipe', clinica: 'Clínica' };
const EVENTOS = ['PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_CHARGEBACK_REQUESTED',
  'INVOICE_CREATED', 'INVOICE_UPDATED', 'INVOICE_SYNCHRONIZED', 'INVOICE_AUTHORIZED', 'INVOICE_PROCESSING_CANCELLATION', 'INVOICE_CANCELED', 'INVOICE_CANCELLATION_DENIED', 'INVOICE_ERROR'];

module.exports = function (pool, { need, uuid }, env = process.env) {
  const err = (m, http = 422) => Object.assign(new Error(m), { http });
  const BASE = (env.ASAAS_BASE_URL || (env.ASAAS_AMBIENTE === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3')).replace(/\/$/, '');
  const CHAVE = String(env.ASAAS_API_KEY || '').trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'); // tolera aspas usadas para proteger o '$' da chave no .env
  const TAXA = Number(env.TAXA_PLATAFORMA || 10);
  const URL_PUB = (env.URL_PUBLICA || '').replace(/\/$/, '');
  let PLAT = null; // planos vindos do painel da plataforma (tabela mednexo.plano); sem ele, usa PRECO_* do ambiente
  const precoPlano = p => { if (PLAT) return PLAT.preco(p); const v = Number(env['PRECO_' + p.toUpperCase()] || 0); return v > 0 ? v : null; };
  const nomesPlanos = () => PLAT ? Object.fromEntries(PLAT.lista().map(p => [p.id, p.nome])) : PLANOS;
  const configurado = () => !!CHAVE;
  const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // data de Brasília
  const so = v => String(v || '').replace(/\D/g, '');
  const dinheiro = v => { const n = Math.round(Number(String(v ?? '').replace(',', '.')) * 100) / 100; return Number.isFinite(n) ? n : NaN; };

  // ---- cifra das chaves das subcontas
  const K = crypto.createHash('sha256').update(String(env.ASAAS_CRIPTO || '')).digest();
  function cifra(t) { if (!env.ASAAS_CRIPTO) throw err('Servidor sem ASAAS_CRIPTO configurado.', 503); const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', K, iv); const d = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.'); }
  function decifra(s) { const [iv, tag, d] = s.split('.').map(x => Buffer.from(x, 'base64')); const c = crypto.createDecipheriv('aes-256-gcm', K, iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); }

  // ---- cliente HTTP
  async function api(chave, metodo, caminho, corpo) {
    if (!chave) throw err('Integração com o Asaas não configurada neste servidor.', 503);
    let r;
    try { r = await fetch(BASE + caminho, { method: metodo, headers: { access_token: chave, 'Content-Type': 'application/json', 'User-Agent': 'MedNexo/1.0' }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw err('Não foi possível falar com o Asaas agora. Tente de novo em instantes.', 502); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const d = (j.errors || []).map(x => x.description).filter(Boolean).join(' '); console.error('asaas', metodo, caminho, r.status, d); throw err(d ? 'Asaas: ' + d : `Asaas recusou a operação (${r.status}).`, r.status === 401 ? 502 : 422); }
    return j;
  }
  let carteira = env.ASAAS_WALLET_ID || null;
  async function carteiraPlataforma() { if (carteira) return carteira; const w = await api(CHAVE, 'GET', '/wallets'); carteira = (w.data && w.data[0] && w.data[0].id) || null; if (!carteira) throw err('Não foi possível obter a carteira (walletId) do MedNexo no Asaas.', 502); return carteira; }
  const estado = { conectado: null, verificado_em: null, erro: null, webhook: null };
  async function webhookConta(chave, nome) {
    if (!URL_PUB || !env.ASAAS_WEBHOOK_TOKEN) return false;
    const url = URL_PUB + '/api/asaas/webhook';
    const l = await api(chave, 'GET', '/webhooks?limit=100').catch(() => ({ data: [] }));
    if ((l.data || []).some(w => w.url === url)) return true;
    await api(chave, 'POST', '/webhooks', { name: nome, url, email: env.ASAAS_EMAIL_AVISOS || undefined, enabled: true, interrupted: false, apiVersion: 3, authToken: env.ASAAS_WEBHOOK_TOKEN, sendType: 'SEQUENTIALLY', events: EVENTOS });
    return true;
  }
  async function iniciar() {
    if (!configurado()) return;
    try { const c = await api(CHAVE, 'GET', '/myAccount/commercialInfo').catch(() => api(CHAVE, 'GET', '/wallets')); estado.conectado = true; estado.conta = c && (c.name || c.companyName) || null; await carteiraPlataforma(); }
    catch (e) { estado.conectado = false; estado.erro = e.message; }
    try { estado.webhook = await webhookConta(CHAVE, 'MedNexo'); } catch (e) { estado.webhook = false; estado.erro_webhook = e.message; }
    estado.verificado_em = new Date().toISOString();
    console.log('Asaas:', JSON.stringify({ ambiente: env.ASAAS_AMBIENTE || 'sandbox', conectado: estado.conectado, webhook: estado.webhook, erro: estado.erro || estado.erro_webhook || null }));
  }

  // ---- situação de uso da organização (somente leitura após 5 dias de atraso ou teste vencido sem assinatura)
  const cache = new Map();
  async function situacao(org) {
    const c = cache.get(org); if (c && Date.now() - c.t < 60000) return c.v;
    const o = (await pool.query(`SELECT plano, teste_ate, asaas_subscription_id, assinatura_status, suspensa_em, suspensao_motivo FROM mednexo.organizacao WHERE id = $1`, [org])).rows[0] || {};
    let v = { bloqueada: false, motivo: null };
    const atraso = (await pool.query(`SELECT min(vencimento) AS v FROM mednexo.cobranca WHERE organizacao_id = $1 AND tipo = 'assinatura' AND status = 'OVERDUE'`, [org])).rows[0].v;
    if (atraso && (Date.now() - new Date(atraso).getTime()) / 864e5 > 5) v = { bloqueada: true, motivo: 'inadimplente', desde: atraso };
    else if (o.plano === 'teste' && o.teste_ate && new Date(o.teste_ate).getTime() + 864e5 < Date.now()) v = { bloqueada: true, motivo: 'teste_vencido' };
    if (o.suspensa_em) v = { bloqueada: true, motivo: 'suspensa', desde: o.suspensa_em };
    cache.set(org, { t: Date.now(), v }); return v;
  }
  const invalida = org => org ? cache.delete(org) : cache.clear();

  // ---- registra/atualiza uma cobrança a partir do objeto payment do Asaas
  async function gravaPagamento(p, extra = {}) {
    const r = (await pool.query(`INSERT INTO mednexo.cobranca (organizacao_id, tipo, conta_usuario_id, teleconsulta_id, asaas_payment_id, asaas_customer_id, valor, valor_liquido, status, vencimento, pago_em, invoice_url, descricao)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (asaas_payment_id) DO UPDATE SET valor = EXCLUDED.valor, valor_liquido = EXCLUDED.valor_liquido, status = EXCLUDED.status, vencimento = EXCLUDED.vencimento,
        pago_em = coalesce(mednexo.cobranca.pago_em, EXCLUDED.pago_em), invoice_url = coalesce(EXCLUDED.invoice_url, mednexo.cobranca.invoice_url), atualizado_em = now()
      RETURNING *`, [extra.org, extra.tipo, extra.conta || null, extra.tele || null, p.id, p.customer || null, p.value, p.netValue ?? null, p.status, p.dueDate || null,
      PAGO.has(p.status) ? (p.confirmedDate || p.paymentDate || new Date().toISOString()) : null, p.invoiceUrl || null, p.description || null])).rows[0];
    return r;
  }
  const ouvintesPago = [];
  const aoPagarTele = id => { for (const f of ouvintesPago) Promise.resolve().then(() => f(id)).catch(e => console.error('pós-pagamento:', e.message)); };
  async function efeitos(cob) {
    if (cob.tipo === 'assinatura') {
      if (PAGO.has(cob.status)) await pool.query(`UPDATE mednexo.organizacao SET plano = 'ativo', assinatura_status = 'ativa' WHERE id = $1`, [cob.organizacao_id]);
      invalida(cob.organizacao_id);
    }
    if (cob.tipo === 'teleconsulta' && cob.teleconsulta_id) {
      if (PAGO.has(cob.status)) { const u = (await pool.query(`UPDATE mednexo.teleconsulta SET pago_em = coalesce(pago_em, now()) WHERE id = $1 AND pago_em IS NULL RETURNING id`, [cob.teleconsulta_id])).rows[0]; if (u) aoPagarTele(cob.teleconsulta_id); }
      if (/REFUND/.test(cob.status)) await pool.query(`UPDATE mednexo.teleconsulta SET reembolsado_em = coalesce(reembolsado_em, now()) WHERE id = $1`, [cob.teleconsulta_id]);
    }
  }
  async function contaMedico(uid) { const m = (await pool.query(`SELECT * FROM mednexo.medico_recebimento WHERE usuario_id = $1`, [uid])).rows[0]; if (m) m.chave = decifra(m.chave_cifrada); return m; }

  // ===================== WEBHOOK (público, autenticado pelo token) =====================
  async function webhook(req, res, readBody, send) {
    const tok = String(req.headers['asaas-access-token'] || '');
    if (!env.ASAAS_WEBHOOK_TOKEN || tok.length !== env.ASAAS_WEBHOOK_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(env.ASAAS_WEBHOOK_TOKEN))) return send(res, 401, { erro: 'token inválido' });
    const b = await readBody(req, 2e6);
    const id = String(b.id || crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex'));
    const novo = (await pool.query(`INSERT INTO mednexo.asaas_evento (id, evento, payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [id, b.event || null, JSON.stringify(b)])).rows[0];
    send(res, 200, { received: true });
    if (!novo) return;
    try {
      if (b.payment && b.payment.id) {
        const p = b.payment;
        let cob = (await pool.query(`SELECT * FROM mednexo.cobranca WHERE asaas_payment_id = $1`, [p.id])).rows[0];
        if (!cob && p.subscription) { const o = (await pool.query(`SELECT id FROM mednexo.organizacao WHERE asaas_subscription_id = $1`, [p.subscription])).rows[0]; if (o) cob = { organizacao_id: o.id, tipo: 'assinatura' }; }
        if (!cob && /^tele:/.test(p.externalReference || '')) { const t = (await pool.query(`SELECT id, organizacao_id, medico_usuario_id FROM mednexo.teleconsulta WHERE id = $1`, [p.externalReference.slice(5)])).rows[0]; if (t) cob = { organizacao_id: t.organizacao_id, tipo: 'teleconsulta', teleconsulta_id: t.id, conta_usuario_id: t.medico_usuario_id }; }
        if (!cob) return;
        if (b.event === 'PAYMENT_DELETED') p.status = 'DELETED';
        const r = await gravaPagamento(p, { org: cob.organizacao_id, tipo: cob.tipo, conta: cob.conta_usuario_id, tele: cob.teleconsulta_id });
        await efeitos(r);
      }
      if (b.invoice && b.invoice.id) {
        const i = b.invoice;
        await pool.query(`UPDATE mednexo.nota_fiscal SET status = $2, pdf_url = coalesce($3, pdf_url), numero = coalesce($4, numero), erro = $5, atualizado_em = now() WHERE asaas_invoice_id = $1`, [i.id, i.status, i.pdfUrl || null, i.number || null, b.event === 'INVOICE_ERROR' ? (i.statusDescription || 'erro na emissão') : null]);
      }
    } catch (e) { console.error('webhook asaas:', e.message); }
  }

  // ===================== ROTAS COM SESSÃO =====================
  const gestor = s => { if (s.papel !== 'medico_administrador') throw err('Somente o médico gestor gerencia a assinatura.', 403); };
  const medico = s => { if (!['medico_administrador', 'medico_assistente'].includes(s.papel)) throw err('Somente médicos recebem por teleconsulta.', 403); };
  const R = {
    'GET /api/asaas/status': async (s) => { gestor(s); return { configurado: configurado(), ambiente: env.ASAAS_AMBIENTE || 'sandbox', ...estado, taxa_plataforma: TAXA }; },
    'GET /api/assinatura': async (s) => { gestor(s);
      const o = (await pool.query(`SELECT nome, plano, teste_ate, assinatura_plano, assinatura_valor, assinatura_status, asaas_subscription_id FROM mednexo.organizacao WHERE id = $1`, [s.org])).rows[0];
      const cob = (await pool.query(`SELECT valor, status, vencimento, pago_em, invoice_url FROM mednexo.cobranca WHERE organizacao_id = $1 AND tipo = 'assinatura' AND status <> 'DELETED' ORDER BY vencimento DESC NULLS LAST, criado_em DESC LIMIT 24`, [s.org])).rows;
      return { configurado: configurado(), organizacao: o, situacao: await situacao(s.org), planos: PLAT ? PLAT.lista() : Object.entries(PLANOS).map(([k, n]) => ({ id: k, nome: n, valor: precoPlano(k) })), cobrancas: cob };
    },
    'POST /api/assinatura': async (s, c, q, b) => { gestor(s);
      const plano = nomesPlanos()[b.plano] ? b.plano : null; if (!plano) throw err('Escolha o plano.'); const valor = precoPlano(plano); if (!valor) throw err('O valor deste plano ainda não foi definido.', 409);
      const doc = so(b.cpf_cnpj); if (![11, 14].includes(doc.length)) throw err('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.');
      const nome = need(b.nome, 'Informe o nome ou razão social do pagador.').slice(0, 120);
      const o = (await pool.query(`SELECT asaas_customer_id, asaas_subscription_id, assinatura_status FROM mednexo.organizacao WHERE id = $1`, [s.org])).rows[0];
      if (o.asaas_subscription_id && o.assinatura_status !== 'cancelada') throw err('A organização já tem uma assinatura. Para trocar de plano, fale com o suporte.', 409);
      let cus = o.asaas_customer_id;
      if (!cus) cus = (await api(CHAVE, 'POST', '/customers', { name: nome, cpfCnpj: doc, email: String(b.email || '').trim() || undefined, mobilePhone: so(b.telefone) || undefined, externalReference: 'org:' + s.org, notificationDisabled: false })).id;
      const sub = await api(CHAVE, 'POST', '/subscriptions', { customer: cus, billingType: 'UNDEFINED', value: valor, nextDueDate: hoje(), cycle: 'MONTHLY', description: `MedNexo · plano ${nomesPlanos()[plano]}`, externalReference: 'org:' + s.org });
      await pool.query(`UPDATE mednexo.organizacao SET asaas_customer_id = $2, asaas_subscription_id = $3, assinatura_plano = $4, assinatura_valor = $5, assinatura_status = 'aguardando_pagamento' WHERE id = $1`, [s.org, cus, sub.id, plano, valor]);
      const ps = await api(CHAVE, 'GET', `/subscriptions/${sub.id}/payments`).catch(() => ({ data: [] }));
      let link = null; for (const p of ps.data || []) { const r = await gravaPagamento(p, { org: s.org, tipo: 'assinatura' }); link = link || r.invoice_url; }
      invalida(s.org);
      await c.query(`SELECT mednexo.auditar_acesso('assinatura_criar','organizacao',$1,NULL,NULL,$2::jsonb)`, [s.org, JSON.stringify({ plano, valor })]);
      return { ok: true, link_pagamento: link };
    },
    // ---- recebimentos do médico (subconta)
    'GET /api/recebimento': async (s) => { medico(s);
      const m = (await pool.query(`SELECT asaas_account_id, wallet_id, titular_nome, titular_documento, preco_teleconsulta, servico_municipal, aliquota_iss, criado_em FROM mednexo.medico_recebimento WHERE usuario_id = $1`, [s.uid])).rows[0];
      let situ = null;
      if (m) { const k = await contaMedico(s.uid); situ = await api(k.chave, 'GET', '/myAccount/status').catch(e => ({ erro: e.message })); if (!k.webhook_ok) webhookConta(k.chave, 'MedNexo (médico)').then(ok => ok && pool.query(`UPDATE mednexo.medico_recebimento SET webhook_ok = true WHERE usuario_id = $1`, [s.uid])).catch(() => {}); }
      return { configurado: configurado(), taxa_plataforma: TAXA, conta: m ? { ...m, titular_documento: m.titular_documento ? '•••' + m.titular_documento.slice(-4) : null } : null, situacao: situ };
    },
    'POST /api/recebimento/conta': async (s, c, q, b) => { medico(s);
      if ((await pool.query(`SELECT 1 FROM mednexo.medico_recebimento WHERE usuario_id = $1`, [s.uid])).rows.length) throw err('Sua conta de recebimento já foi criada.', 409);
      const doc = so(b.cpf_cnpj); const pj = doc.length === 14; if (![11, 14].includes(doc.length)) throw err('Informe CPF (11 dígitos) ou CNPJ (14 dígitos).');
      const renda = dinheiro(b.renda); if (!(renda > 0)) throw err('Informe a renda ou faturamento mensal (exigido pelo Asaas).');
      const corpo = { name: need(b.nome, 'Informe o nome completo ou a razão social.'), email: need(b.email, 'Informe o e-mail da conta de recebimento.').trim().toLowerCase(), cpfCnpj: doc,
        mobilePhone: so(need(b.celular, 'Informe o celular.')), incomeValue: renda, address: need(b.endereco, 'Informe o endereço.'), addressNumber: need(b.numero, 'Informe o número.'),
        complement: String(b.complemento || '').trim() || undefined, province: need(b.bairro, 'Informe o bairro.'), postalCode: so(need(b.cep, 'Informe o CEP.')) };
      if (pj) corpo.companyType = ['MEI', 'LIMITED', 'INDIVIDUAL', 'ASSOCIATION'].includes(b.tipo_empresa) ? b.tipo_empresa : 'LIMITED';
      else corpo.birthDate = need(b.nascimento, 'Informe a data de nascimento.');
      const a = await api(CHAVE, 'POST', '/accounts', corpo);
      if (!a.apiKey || !a.walletId) throw err('O Asaas criou a conta mas não devolveu a chave. Fale com o suporte antes de tentar de novo.', 502);
      await pool.query(`INSERT INTO mednexo.medico_recebimento (usuario_id, organizacao_id, asaas_account_id, wallet_id, chave_cifrada, titular_nome, titular_documento, preco_teleconsulta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [s.uid, s.org, a.id, a.walletId, cifra(a.apiKey), corpo.name, doc, dinheiro(b.preco) > 0 ? dinheiro(b.preco) : null]);
      webhookConta(a.apiKey, 'MedNexo (médico)').then(ok => ok && pool.query(`UPDATE mednexo.medico_recebimento SET webhook_ok = true WHERE usuario_id = $1`, [s.uid])).catch(e => console.error('webhook subconta:', e.message));
      await c.query(`SELECT mednexo.auditar_acesso('recebimento_conta_criar','usuario',$1,NULL,NULL,'{}'::jsonb)`, [s.uid]);
      return { ok: true };
    },
    'POST /api/recebimento/config': async (s, c, q, b) => { medico(s);
      const preco = dinheiro(b.preco); if (!(preco >= 0)) throw err('Valor da consulta inválido.');
      if (preco > 0 && preco < TAXA + 5) throw err(`O valor da consulta precisa ser de pelo menos R$ ${(TAXA + 5).toFixed(2).replace('.', ',')} (taxa da plataforma + mínimo do Asaas).`);
      const iss = b.aliquota_iss === '' || b.aliquota_iss == null ? null : dinheiro(b.aliquota_iss); if (iss != null && !(iss >= 0 && iss <= 10)) throw err('Alíquota de ISS inválida (0 a 10%).');
      const r = await pool.query(`UPDATE mednexo.medico_recebimento SET preco_teleconsulta = $2, servico_municipal = $3, aliquota_iss = $4 WHERE usuario_id = $1 RETURNING usuario_id`, [s.uid, preco || null, String(b.servico_municipal || '').trim().slice(0, 60) || null, iss]);
      if (!r.rows.length) throw err('Crie primeiro a sua conta de recebimento.', 409); return { ok: true };
    },
  };

  // ===================== TELECONSULTA PAGA (chamado pelo módulo de telemedicina) =====================
  async function cobrarTele(t, b) {
    const k = await contaMedico(t.medico_usuario_id); if (!k) throw err('O médico ainda não ativou o recebimento. Avise o consultório.', 409);
    const ex = (await pool.query(`SELECT * FROM mednexo.cobranca WHERE teleconsulta_id = $1 AND status NOT IN ('DELETED','REFUNDED') ORDER BY criado_em DESC LIMIT 1`, [t.id])).rows[0];
    let cob = ex;
    if (!cob) {
      const doc = so(b.cpf); if (doc.length !== 11 && doc.length !== 14) throw err('Informe o CPF de quem vai pagar (11 dígitos).');
      const nome = String(b.nome || t.paciente_nome || '').trim().slice(0, 120) || 'Paciente';
      const cus = (await api(k.chave, 'POST', '/customers', { name: nome, cpfCnpj: doc, email: String(b.email || '').trim() || undefined, externalReference: 'pac:' + t.paciente_id, notificationDisabled: true })).id;
      const p = await api(k.chave, 'POST', '/payments', { customer: cus, billingType: 'UNDEFINED', value: Number(t.valor), dueDate: hoje(), description: `Teleconsulta com ${t.medico}`, externalReference: 'tele:' + t.id,
        split: [{ walletId: await carteiraPlataforma(), fixedValue: TAXA }] });
      cob = await gravaPagamento(p, { org: t.organizacao_id, tipo: 'teleconsulta', conta: t.medico_usuario_id, tele: t.id });
    }
    let pix = null; if (!PAGO.has(cob.status)) pix = await api(k.chave, 'GET', `/payments/${cob.asaas_payment_id}/pixQrCode`).catch(() => null);
    return { status: cob.status, pago: PAGO.has(cob.status), valor: Number(cob.valor), link: cob.invoice_url, pix: pix && pix.payload ? { imagem: pix.encodedImage, copia_cola: pix.payload, expira: pix.expirationDate } : null };
  }
  async function statusTele(t) {
    const cob = (await pool.query(`SELECT * FROM mednexo.cobranca WHERE teleconsulta_id = $1 ORDER BY criado_em DESC LIMIT 1`, [t.id])).rows[0];
    if (!cob) return { status: null, pago: false };
    if (!PAGO.has(cob.status) && Date.now() - new Date(cob.atualizado_em).getTime() > 8000) { // confirma no Asaas caso o webhook atrase
      const k = await contaMedico(cob.conta_usuario_id).catch(() => null);
      if (k) { const p = await api(k.chave, 'GET', `/payments/${cob.asaas_payment_id}`).catch(() => null); if (p) { const r = await gravaPagamento(p, { org: cob.organizacao_id, tipo: 'teleconsulta', conta: cob.conta_usuario_id, tele: t.id }); await efeitos(r); return { status: r.status, pago: PAGO.has(r.status) }; } }
    }
    return { status: cob.status, pago: PAGO.has(cob.status) };
  }
  async function reembolsarTele(t) {
    const cob = (await pool.query(`SELECT * FROM mednexo.cobranca WHERE teleconsulta_id = $1 ORDER BY criado_em DESC LIMIT 1`, [t.id])).rows[0];
    if (!cob || !PAGO.has(cob.status)) throw err('Não há pagamento confirmado para reembolsar.', 409);
    const k = await contaMedico(cob.conta_usuario_id);
    const p = await api(k.chave, 'POST', `/payments/${cob.asaas_payment_id}/refund`, { description: 'Teleconsulta não realizada pelo médico' });
    const r = await gravaPagamento(p.id ? p : { ...p, id: cob.asaas_payment_id, value: cob.valor, status: 'REFUND_REQUESTED' }, { org: cob.organizacao_id, tipo: 'teleconsulta', conta: cob.conta_usuario_id, tele: t.id });
    await efeitos(r); return { status: r.status };
  }
  async function notaTele(t) {
    const cob = (await pool.query(`SELECT * FROM mednexo.cobranca WHERE teleconsulta_id = $1 ORDER BY criado_em DESC LIMIT 1`, [t.id])).rows[0];
    if (!cob || !PAGO.has(cob.status)) throw err('A nota fiscal só pode ser emitida para consulta paga.', 409);
    const ja = (await pool.query(`SELECT * FROM mednexo.nota_fiscal WHERE cobranca_id = $1 AND status NOT IN ('CANCELED','ERROR') ORDER BY criado_em DESC LIMIT 1`, [cob.id])).rows[0];
    if (ja) return ja;
    const k = await contaMedico(cob.conta_usuario_id);
    if (!k.servico_municipal) throw err('Configure em "Meu perfil → Recebimentos" o código do serviço municipal e a alíquota de ISS antes de emitir notas.', 409);
    const corpo = { payment: cob.asaas_payment_id, serviceDescription: 'Consulta médica realizada por telemedicina', observations: 'Teleconsulta via MedNexo', value: Number(cob.valor), deductions: 0, effectiveDate: hoje(),
      taxes: { retainIss: false, iss: Number(k.aliquota_iss || 0), cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0 } };
    if (/^\d+$/.test(k.servico_municipal)) corpo.municipalServiceId = k.servico_municipal; else corpo.municipalServiceCode = k.servico_municipal;
    const inv = await api(k.chave, 'POST', '/invoices', corpo);
    const aut = await api(k.chave, 'POST', `/invoices/${inv.id}/authorize`).catch(e => ({ status: inv.status, _erro: e.message }));
    const n = (await pool.query(`INSERT INTO mednexo.nota_fiscal (organizacao_id, teleconsulta_id, cobranca_id, asaas_invoice_id, status, pdf_url, erro) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cob.organizacao_id, t.id, cob.id, inv.id, aut.status || inv.status, aut.pdfUrl || inv.pdfUrl || null, aut._erro || null])).rows[0];
    return n;
  }
  async function notaStatus(t) {
    const n = (await pool.query(`SELECT * FROM mednexo.nota_fiscal WHERE teleconsulta_id = $1 ORDER BY criado_em DESC LIMIT 1`, [t.id])).rows[0]; if (!n) return null;
    if (n.status !== 'AUTHORIZED' || !n.pdf_url) { const k = await contaMedico(t.medico_usuario_id); const i = await api(k.chave, 'GET', `/invoices/${n.asaas_invoice_id}`).catch(() => null);
      if (i) return (await pool.query(`UPDATE mednexo.nota_fiscal SET status = $2, pdf_url = coalesce($3, pdf_url), numero = coalesce($4, numero), erro = $5, atualizado_em = now() WHERE id = $1 RETURNING *`, [n.id, i.status, i.pdfUrl || null, i.number || null, i.status === 'ERROR' ? (i.statusDescription || 'erro na emissão') : null])).rows[0]; }
    return n;
  }
  async function cancelarCobrancaTele(teleId) {
    const cob = (await pool.query(`SELECT * FROM mednexo.cobranca WHERE teleconsulta_id = $1 ORDER BY criado_em DESC LIMIT 1`, [teleId])).rows[0];
    if (!cob || PAGO.has(cob.status) || cob.status === 'DELETED') return;
    const k = await contaMedico(cob.conta_usuario_id); await api(k.chave, 'DELETE', `/payments/${cob.asaas_payment_id}`).catch(() => null);
    await pool.query(`UPDATE mednexo.cobranca SET status = 'DELETED', atualizado_em = now() WHERE id = $1`, [cob.id]);
  }
  async function cobrancaTeleResumo(ids) {
    if (!ids.length) return {};
    const r = (await pool.query(`SELECT DISTINCT ON (c.teleconsulta_id) c.teleconsulta_id, c.status, c.valor, c.valor_liquido, n.status AS nota_status, n.pdf_url FROM mednexo.cobranca c LEFT JOIN mednexo.nota_fiscal n ON n.cobranca_id = c.id WHERE c.teleconsulta_id = ANY($1::uuid[]) ORDER BY c.teleconsulta_id, c.criado_em DESC, n.criado_em DESC`, ['{' + ids.join(',') + '}'])).rows;
    return Object.fromEntries(r.map(x => [x.teleconsulta_id, x]));
  }
  return { routes: R, webhook, situacao, invalida, iniciar, migrar: () => pool.raw(MIGRACAO), cobrarTele, statusTele, reembolsarTele, notaTele, notaStatus, cobrancaTeleResumo, contaMedico, TAXA, PAGO,
    aoPagar: f => { ouvintesPago.push(f); }, usarPlanos: p => { PLAT = p; }, configurado, cifra, decifra, cancelarCobrancaTele, estado };
};
