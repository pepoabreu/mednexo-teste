// Cliente PostgreSQL mínimo (protocolo simple-query, sem dependências). Autenticação: trust (rede interna do compose) ou socket Unix.
const net = require('net');
const OIDS_NUM = new Set([20, 21, 23, 700, 701]);
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('número inválido'); return String(v); }
  if (v instanceof Date) return `'${v.toISOString()}'`;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.includes('\0')) throw new Error('caractere inválido');
  return `'${s.replace(/'/g, "''")}'`;
}
function fmt(sql, params = []) {
  return sql.replace(/\$(\d+)/g, (_, n) => { const i = +n - 1; if (i >= params.length) throw new Error('parâmetro ausente'); return lit(params[i]); });
}
class Conn {
  constructor(opts) { this.opts = opts; this.buf = Buffer.alloc(0); this.q = []; this.cur = null; this.ready = false; this.dead = false; }
  open() {
    return new Promise((res, rej) => {
      const o = this.opts;
      this.s = o.path ? net.connect({ path: o.path }) : net.connect({ host: o.host, port: o.port });
      this.onReady = res; this.onFail = rej;
      this.s.on('connect', () => {
        const kv = Buffer.from(`user\0${o.user}\0database\0${o.database}\0client_encoding\0UTF8\0\0`);
        const m = Buffer.alloc(8 + kv.length); m.writeInt32BE(m.length, 0); m.writeInt32BE(196608, 4); kv.copy(m, 8); this.s.write(m);
      });
      this.s.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
      this.s.on('error', e => this.fail(e));
      this.s.on('close', () => this.fail(new Error('conexão fechada')));
    });
  }
  fail(e) {
    this.dead = true;
    if (this.onFail) { const f = this.onFail; this.onFail = null; f(e); }
    if (this.cur) { const c = this.cur; this.cur = null; c.rej(e); }
    for (const c of this.q) c.rej(e); this.q = [];
  }
  parse() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const t = String.fromCharCode(this.buf[0]); const b = this.buf.subarray(5, 1 + len); this.buf = this.buf.subarray(1 + len);
      this.msg(t, b);
    }
  }
  msg(t, b) {
    if (t === 'R') { if (b.readInt32BE(0) !== 0) this.fail(new Error('autenticação do banco não suportada (use trust na rede interna)')); }
    else if (t === 'T') {
      const n = b.readInt16BE(0); let p = 2; this.cols = [];
      for (let i = 0; i < n; i++) { const e = b.indexOf(0, p); const name = b.toString('utf8', p, e); p = e + 1; const oid = b.readInt32BE(p + 6); this.cols.push({ name, oid }); p += 18; }
      this.rows = [];
    } else if (t === 'D') {
      const n = b.readInt16BE(0); let p = 2; const row = {};
      for (let i = 0; i < n; i++) {
        const l = b.readInt32BE(p); p += 4; let v = null;
        if (l >= 0) { v = b.toString('utf8', p, p + l); p += l; const { name, oid } = this.cols[i];
          if (OIDS_NUM.has(oid)) v = Number(v); else if (oid === 16) v = v === 't'; else if (oid === 114 || oid === 3802) v = JSON.parse(v); }
        row[this.cols[i].name] = v;
      }
      this.rows.push(row);
    } else if (t === 'E') {
      const f = {}; let p = 0; while (b[p]) { const k = String.fromCharCode(b[p]); const e = b.indexOf(0, p + 1); f[k] = b.toString('utf8', p + 1, e); p = e + 1; }
      this.err = Object.assign(new Error(f.M || 'erro'), { code: f.C, detail: f.D });
    } else if (t === 'Z') {
      if (!this.ready) { this.ready = true; const r = this.onReady; this.onReady = null; this.onFail = null; r && r(this); }
      if (this.cur) { const c = this.cur; this.cur = null; if (this.err) { const e = this.err; this.err = null; c.rej(e); } else c.res({ rows: this.rows || [] }); }
      this.rows = null; this.cols = null; this.next();
    }
  }
  next() { if (this.cur || !this.ready || !this.q.length) return; this.cur = this.q.shift(); this.rows = []; const m = Buffer.from(this.cur.sql + '\0'); const h = Buffer.alloc(5); h[0] = 81; h.writeInt32BE(4 + m.length, 1); this.s.write(Buffer.concat([h, m])); }
  raw(sql) { return new Promise((res, rej) => { this.q.push({ sql, res, rej }); this.next(); }); }
  query(sql, params) { return new Promise((res, rej) => { let s; try { s = fmt(sql, params); } catch (e) { return rej(e); } this.q.push({ sql: s, res, rej }); this.next(); }); }
  close() { try { this.s.end(); } catch {} }
}
class Pool {
  constructor(opts, max = 6) { this.opts = opts; this.max = max; this.idle = []; this.n = 0; this.wait = []; }
  async get() {
    while (this.idle.length) { const c = this.idle.pop(); if (!c.dead) return c; this.n--; }
    if (this.n < this.max) { this.n++; try { return await new Conn(this.opts).open(); } catch (e) { this.n--; throw e; } }
    return new Promise(r => this.wait.push(r));
  }
  put(c) { if (c.dead) { this.n--; return; } const w = this.wait.shift(); if (w) w(c); else this.idle.push(c); }
  async raw(sql) { const c = await this.get(); try { return await c.raw(sql); } finally { this.put(c); } }
  async query(sql, p) { const c = await this.get(); try { return await c.query(sql, p); } finally { this.put(c); } }
  // transação com contexto de sessão (papel da aplicação + GUCs)
  async tx(fn, ctx) {
    const c = await this.get(); let ok = false;
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL search_path = mednexo, public');
      if (ctx) {
        await c.query('SET LOCAL ROLE mednexo_app');
        await c.query(`SELECT set_config('app.organizacao_id',$1,true), set_config('app.usuario_id',$2,true), set_config('app.ip',$3,true), set_config('app.user_agent',$4,true), set_config('app.request_id',$5,true)`,
          [ctx.org, ctx.uid, ctx.ip || '', (ctx.ua || '').slice(0, 200), ctx.rid || '']);
      }
      const r = await fn(c); await c.query('COMMIT'); ok = true; return r;
    } finally { if (!ok && !c.dead) { try { await c.query('ROLLBACK'); } catch {} } this.put(c); }
  }
}
module.exports = { Pool, lit, fmt };
