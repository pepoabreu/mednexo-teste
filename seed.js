'use strict';
const crypto = require('crypto');
function hashSenha(s) { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(s, salt, 32, { N: 16384 }); return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`; }
function confereSenha(s, stored) {
  if (!stored) return false; const [t, salt, h] = stored.split('$'); if (t !== 'scrypt') return false;
  const x = crypto.scryptSync(s, Buffer.from(salt, 'hex'), 32, { N: 16384 }); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex'));
}
// Dados 100% FICTÍCIOS de demonstração (criados só se o banco estiver vazio)
async function seed(pool, env) {
  const ja = (await pool.query('SELECT count(*)::int n FROM mednexo.organizacao')).rows[0].n;
  if (ja) return;
  const U = [
    ['medico@mednexo.teste', 'Dra. Demo (médica administradora)', 'medico_administrador', env.PW_MEDICO, true, ['H1', 'H2']],
    ['assistente@mednexo.teste', 'Dr. Assistente Demo', 'medico_assistente', env.PW_ASSIST, true, ['H1', 'H2']],
    ['enfermagem@mednexo.teste', 'Enfermeira Demo', 'enfermagem', env.PW_ENF, false, ['H1']],
    ['administrativo@mednexo.teste', 'Administrativo Demo', 'administrativo', env.PW_ADM, false, ['H1', 'H2']],
    ['auditor@mednexo.teste', 'Auditor Demo', 'auditor', env.PW_AUD, false, ['H1', 'H2']],
  ];
  for (const u of U) if (!u[3] || u[3].length < 10) throw new Error('defina PW_* com 10+ caracteres');
  await pool.tx(async c => {
    const org = (await c.query(`INSERT INTO mednexo.organizacao (nome) VALUES ('Clínica Demo (dados fictícios)') RETURNING id`)).rows[0].id;
    const ids = {}; let first = null;
    for (const [email, nome, papel, pw, med] of U) {
      const id = (await c.query('INSERT INTO mednexo.usuario (email, nome_completo, senha_hash) VALUES ($1,$2,$3) RETURNING id', [email, nome, hashSenha(pw)])).rows[0].id;
      ids[email] = id; first = first || id;
      if (med) await c.query(`INSERT INTO mednexo.profissional (usuario_id, numero_registro, uf, especialidade) VALUES ($1,$2,'RJ','Psiquiatria')`, [id, String(900000 + Object.keys(ids).length)]);
      await c.query('INSERT INTO mednexo.organizacao_membro (organizacao_id, usuario_id, papel) VALUES ($1,$2,$3::mednexo.papel_usuario)', [org, id, papel]);
    }
    await c.query(`SELECT set_config('app.usuario_id',$1,true), set_config('app.organizacao_id',$2,true)`, [first, org]);
    const H = {};
    for (const [k, nome, uni, leitos] of [['H1', 'Hospital Demo Um', 'Enfermaria A', ['101', '102', '103']], ['H2', 'Hospital Demo Dois', 'Ala Psiquiátrica', ['01', '02', '03']]]) {
      H[k] = (await c.query('INSERT INTO mednexo.hospital (organizacao_id, nome_fantasia) VALUES ($1,$2) RETURNING id', [org, nome])).rows[0].id;
      const un = (await c.query('INSERT INTO mednexo.unidade_internacao (organizacao_id, hospital_id, nome) VALUES ($1,$2,$3) RETURNING id', [org, H[k], uni])).rows[0].id;
      for (const l of leitos) await c.query('INSERT INTO mednexo.leito (organizacao_id, hospital_id, unidade_id, identificacao) VALUES ($1,$2,$3,$4)', [org, H[k], un, l]);
    }
    for (const [email, , , , , hs] of U) for (const h of hs)
      await c.query('INSERT INTO mednexo.membro_hospital (organizacao_id, membro_id, hospital_id) SELECT $1, id, $3 FROM mednexo.organizacao_membro WHERE usuario_id = $2', [org, ids[email], H[h]]);
    await c.query('SELECT mednexo.semear_regras_pendencia($1)', [org]);
  });
  console.log('Dados de demonstração (fictícios) criados.');
}
// Administrador extra (opcional, por variável de ambiente): médico administrador de uma organização própria de demonstração. Não altera se já existir.
async function adminExtra(pool, env) {
  const email = String(env.ADMIN_EXTRA_EMAIL || '').trim().toLowerCase(), senha = env.ADMIN_EXTRA_SENHA || '';
  if (!email) return;
  if (senha.length < 10) { console.log('ADMIN_EXTRA_SENHA precisa de 10+ caracteres; administrador extra não criado.'); return; }
  if ((await pool.query('SELECT 1 FROM mednexo.usuario WHERE email = $1', [email])).rows.length) return;
  await pool.tx(async c => {
    const org = (await c.query(`INSERT INTO mednexo.organizacao (nome, plano) VALUES ($1, 'demo') RETURNING id`, [env.ADMIN_EXTRA_ORG || 'Clínica IAVTech (demonstração, dados fictícios)'])).rows[0].id;
    const id = (await c.query('INSERT INTO mednexo.usuario (email, nome_completo, senha_hash) VALUES ($1,$2,$3) RETURNING id', [email, env.ADMIN_EXTRA_NOME || 'IAVTech (médico administrador)', hashSenha(senha)])).rows[0].id;
    await c.query(`SELECT set_config('app.usuario_id',$1,true), set_config('app.organizacao_id',$2,true)`, [id, org]);
    const crm = (await c.query(`SELECT (coalesce(max(numero_registro::bigint), 990000) + 1)::text AS n FROM mednexo.profissional WHERE numero_registro ~ '^99[0-9]{4}$'`)).rows[0].n;
    await c.query(`INSERT INTO mednexo.profissional (usuario_id, numero_registro, uf, especialidade) VALUES ($1,$2,'RJ','Psiquiatria')`, [id, crm]);
    const m = (await c.query(`INSERT INTO mednexo.organizacao_membro (organizacao_id, usuario_id, papel) VALUES ($1,$2,'medico_administrador'::mednexo.papel_usuario) RETURNING id`, [org, id])).rows[0].id;
    await c.query('INSERT INTO mednexo.membro_hospital (organizacao_id, membro_id, hospital_id) SELECT $1, $2, id FROM mednexo.hospital WHERE organizacao_id = $1', [org, m]);
  });
  console.log('Administrador extra criado:', email);
}
// Gestor médico real (por variável de ambiente): médico administrador de uma organização própria, vazia, plano ativo.
// O CRM é opcional; quando GESTOR_CRM/GESTOR_UF forem informados depois, o cadastro profissional é criado no próximo início.
async function gestor(pool, env) {
  const email = String(env.GESTOR_EMAIL || '').trim().toLowerCase(), senha = env.GESTOR_SENHA || '';
  if (!email) return;
  if (senha.length < 10) { console.log('GESTOR_SENHA precisa de 10+ caracteres; gestor não criado.'); return; }
  let u = (await pool.query('SELECT u.id, m.organizacao_id FROM mednexo.usuario u JOIN mednexo.organizacao_membro m ON m.usuario_id = u.id WHERE u.email = $1 LIMIT 1', [email])).rows[0];
  if (!u) await pool.tx(async c => {
    const org = (await c.query(`INSERT INTO mednexo.organizacao (nome, plano) VALUES ($1, 'ativo') RETURNING id`, [env.GESTOR_ORG || 'MedNexo · ' + (env.GESTOR_NOME || email)])).rows[0].id;
    const id = (await c.query('INSERT INTO mednexo.usuario (email, nome_completo, senha_hash) VALUES ($1,$2,$3) RETURNING id', [email, env.GESTOR_NOME || email, hashSenha(senha)])).rows[0].id;
    await c.query(`SELECT set_config('app.usuario_id',$1,true), set_config('app.organizacao_id',$2,true)`, [id, org]);
    await c.query(`INSERT INTO mednexo.organizacao_membro (organizacao_id, usuario_id, papel) VALUES ($1,$2,'medico_administrador'::mednexo.papel_usuario)`, [org, id]);
    u = { id, organizacao_id: org }; console.log('Gestor médico criado:', email);
  });
  const crm = String(env.GESTOR_CRM || '').replace(/\D/g, ''), uf = String(env.GESTOR_UF || '').trim().toUpperCase();
  if (crm && /^[A-Z]{2}$/.test(uf) && !(await pool.query('SELECT 1 FROM mednexo.profissional WHERE usuario_id = $1', [u.id])).rows.length)
    await pool.tx(async c => { await c.query(`SELECT set_config('app.usuario_id',$1,true), set_config('app.organizacao_id',$2,true)`, [u.id, u.organizacao_id]);
      await c.query(`INSERT INTO mednexo.profissional (usuario_id, conselho, numero_registro, uf, especialidade) VALUES ($1,'CRM',$2,$3,$4)`, [u.id, crm, uf, env.GESTOR_ESPECIALIDADE || null]); console.log('CRM do gestor cadastrado.'); });
}
module.exports = { seed, adminExtra, gestor, hashSenha, confereSenha };
