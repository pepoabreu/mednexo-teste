'use strict';
// Contratação self-service: cada contratante recebe uma ORGANIZAÇÃO (tenant) própria e isolada,
// com período de teste. Nenhum dado é compartilhado entre organizações (RLS por organizacao_id).
const TESTE_DIAS = 14;
const tentativas = new Map(); // ip -> [timestamps]; limite simples contra abuso do cadastro público

module.exports = (pool, { need }, { hashSenha }) => {
  const erro = (http, m) => Object.assign(new Error(m), { http });
  async function migrar() {
    await pool.raw(`
      ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS plano text NOT NULL DEFAULT 'demo';
      ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS teste_ate date;
      ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS contato_email text;
      ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS contato_telefone text;
      ALTER TABLE mednexo.organizacao ADD COLUMN IF NOT EXISTS termos_aceitos_em timestamptz;
    `);
  }
  function limite(ip) {
    const agora = Date.now(), l = (tentativas.get(ip) || []).filter(t => agora - t < 3600e3);
    if (l.length >= 5) throw erro(429, 'Muitas tentativas. Tente novamente em 1 hora.');
    l.push(agora); tentativas.set(ip, l);
  }
  async function contratar(ip, b) {
    limite(ip);
    const clinica = need(b.clinica, 'Informe o nome do consultório/clínica.').slice(0, 120);
    const nome = need(b.nome, 'Informe seu nome completo.').slice(0, 120);
    const email = need(b.email, 'Informe o e-mail.').toLowerCase().slice(0, 160);
    const senha = need(b.senha, 'Informe a senha.');
    const crm = need(b.crm, 'Informe o número do CRM.').replace(/\D/g, '');
    const uf = need(b.uf, 'Informe a UF do CRM.').toUpperCase();
    const tel = String(b.telefone || '').replace(/[^\d+() -]/g, '').slice(0, 25);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erro(400, 'E-mail inválido.');
    if (senha.length < 10) throw erro(400, 'A senha precisa ter 10 ou mais caracteres.');
    if (!/^\d{3,9}$/.test(crm)) throw erro(400, 'CRM inválido (somente números).');
    if (!/^[A-Z]{2}$/.test(uf)) throw erro(400, 'UF inválida.');
    if (b.aceite !== true) throw erro(422, 'É necessário aceitar os Termos de Uso e a Política de Privacidade (LGPD).');
    if ((await pool.query('SELECT 1 FROM mednexo.usuario WHERE email = $1', [email])).rows.length) throw erro(409, 'E-mail já cadastrado. Entre com sua senha.');
    if ((await pool.query(`SELECT 1 FROM mednexo.profissional WHERE conselho='CRM' AND numero_registro=$1 AND uf=$2`, [crm, uf])).rows.length) throw erro(409, 'Este CRM já está cadastrado. Entre com sua conta ou fale conosco.');
    const org = await pool.tx(async c => {
      const o = (await c.query(`INSERT INTO mednexo.organizacao (nome, plano, teste_ate, contato_email, contato_telefone, termos_aceitos_em)
        VALUES ($1,'teste', current_date + $2::int, $3, NULLIF($4,''), now()) RETURNING id`, [clinica, TESTE_DIAS, email, tel])).rows[0].id;
      const id = (await c.query('INSERT INTO mednexo.usuario (email, nome_completo, senha_hash) VALUES ($1,$2,$3) RETURNING id', [email, nome, hashSenha(senha)])).rows[0].id;
      await c.query(`SELECT set_config('app.usuario_id',$1,true), set_config('app.organizacao_id',$2,true)`, [id, o]);
      await c.query(`INSERT INTO mednexo.profissional (usuario_id, conselho, numero_registro, uf) VALUES ($1,'CRM',$2,$3)`, [id, crm, uf]);
      await c.query(`INSERT INTO mednexo.organizacao_membro (organizacao_id, usuario_id, papel) VALUES ($1,$2,'medico_administrador'::mednexo.papel_usuario)`, [o, id]);
      return o;
    });
    return { ok: true, teste_dias: TESTE_DIAS, organizacao: org };
  }
  // dados do plano da organização da sessão (RLS já restringe à própria organização)
  async function plano(c) {
    const r = (await c.query(`SELECT plano, teste_ate, (teste_ate - current_date) AS dias FROM mednexo.organizacao LIMIT 1`)).rows[0] || {};
    return { plano: r.plano, teste_ate: r.teste_ate, teste_dias_restantes: r.teste_ate ? Number(r.dias) : null };
  }
  return { migrar, contratar, plano };
};
