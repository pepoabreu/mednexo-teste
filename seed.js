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
module.exports = { seed, hashSenha, confereSenha };
