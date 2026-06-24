// X7-SV · db.js — sql.js (pure JS) + Postgres backup + Railway volume
// sql.js = zero native compilation = Railway nixpacks compatible
// Data survives all redeploys via /data volume + external Postgres

import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import pg from 'pg'

const require = createRequire(import.meta.url)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = DATA_DIR + '/x7sv.db'
let _db, _pgPool, _SQL

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY, value TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT, chain TEXT, protocol TEXT,
    profit_usdc REAL DEFAULT 0, status TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usdc_amount REAL, gmd_amount REAL, tx_id TEXT, status TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_exec_chain ON executions(chain, created_at);
  CREATE INDEX IF NOT EXISTS idx_exec_proto ON executions(protocol, status);
`

export async function initDB() {
  // Load sql.js (pure WASM SQLite — no native compilation needed)
  const initSqlJs = require('sql.js')
  _SQL = await initSqlJs()

  // Load existing DB from disk or create new
  if (existsSync(DB_PATH)) {
    const data = readFileSync(DB_PATH)
    _db = new _SQL.Database(data)
    console.log('[DB] Restored from', DB_PATH)
  } else {
    _db = new _SQL.Database()
    console.log('[DB] New database created')
  }

  _db.run(SCHEMA)
  _persist()

  // Postgres backup (Railway plugin)
  if (process.env.DATABASE_URL) {
    try {
      _pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
      await _pgPool.query(`
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS executions (
          id SERIAL PRIMARY KEY, tx_hash TEXT, chain TEXT, protocol TEXT,
          profit_usdc REAL DEFAULT 0, status TEXT,
          created_at BIGINT DEFAULT extract(epoch from now())
        );
        CREATE TABLE IF NOT EXISTS withdrawals (
          id SERIAL PRIMARY KEY, usdc_amount REAL, gmd_amount REAL,
          tx_id TEXT, status TEXT,
          created_at BIGINT DEFAULT extract(epoch from now())
        );
      `)
      // Restore config from Postgres if local DB was empty
      const localCount = _db.exec('SELECT COUNT(*) FROM config')[0]?.values[0][0] || 0
      if (localCount === 0) {
        const rows = await _pgPool.query('SELECT key, value FROM config')
        const ins = _db.prepare('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)')
        rows.rows.forEach(r => ins.run([r.key, r.value]))
        ins.free()
        _persist()
        console.log('[DB] Restored', rows.rows.length, 'config keys from Postgres')
      }
      console.log('[DB] Postgres connected — dual-write active')
    } catch (e) { console.log('[DB] Postgres optional:', e.message.slice(0, 60)) }
  }

  // Persist to disk every 5 seconds
  setInterval(_persist, 5000)
  console.log('[DB] Ready')
}

function _persist() {
  if (!_db) return
  try {
    const data = _db.export()
    writeFileSync(DB_PATH, Buffer.from(data))
  } catch (e) { console.error('[DB] persist error:', e.message) }
}

// Batched writes — flush every 100ms
const _queue = []
let _timer = null

function _queue_write(sql, params) {
  _queue.push({ sql, params })
  if (!_timer) _timer = setTimeout(_flush, 100)
}

function _flush() {
  _timer = null
  if (!_queue.length || !_db) return
  try {
    _db.run('BEGIN')
    _queue.splice(0).forEach(({ sql, params }) => _db.run(sql, params))
    _db.run('COMMIT')
  } catch (e) {
    try { _db.run('ROLLBACK') } catch {}
    console.error('[DB] flush error:', e.message)
  }
}

export function setConfig(key, value) {
  const v = String(value)
  _queue_write('INSERT OR REPLACE INTO config(key,value,updated_at) VALUES(?,?,strftime(\'%s\',\'now\'))', [key, v])
  if (_pgPool) _pgPool.query('INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [key, v]).catch(() => {})
}

export function getConfig(key) {
  if (!_db) return null
  try {
    const r = _db.exec(`SELECT value FROM config WHERE key='${key.replace(/'/g,"''")}'`)
    return r[0]?.values[0]?.[0] ?? null
  } catch { return null }
}

export function recordExecution(data) {
  _queue_write(
    'INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status) VALUES(?,?,?,?,?)',
    [data.txHash || '', data.chain || '', data.protocol || '', data.profitUsdc || 0, data.status || 'success']
  )
  if (_pgPool) _pgPool.query(
    'INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status) VALUES($1,$2,$3,$4,$5)',
    [data.txHash || '', data.chain || '', data.protocol || '', data.profitUsdc || 0, data.status || 'success']
  ).catch(() => {})
}

export function recordWithdrawal(data) {
  _queue_write(
    'INSERT INTO withdrawals(usdc_amount,gmd_amount,tx_id,status) VALUES(?,?,?,?)',
    [data.usdcAmount, data.gmdAmount, data.txId || '', data.status || 'completed']
  )
}

export function getExecutions(limit = 50, protocol = '') {
  if (!_db) return []
  try {
    const sql = protocol
      ? `SELECT * FROM executions WHERE protocol=? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM executions ORDER BY created_at DESC LIMIT ?`
    const stmt = _db.prepare(sql)
    const rows = []
    if (protocol) stmt.bind([protocol, limit])
    else stmt.bind([limit])
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  } catch { return [] }
}

export function getStats() {
  if (!_db) return { total: 0, winRate: '0%', profit: 0, today: 0 }
  try {
    const r = _db.exec(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) wins,
             COALESCE(SUM(profit_usdc),0) profit,
             COALESCE(SUM(CASE WHEN created_at > strftime('%s','now')-86400 THEN profit_usdc ELSE 0 END),0) today
      FROM executions
    `)
    const v = r[0]?.values[0] || [0, 0, 0, 0]
    return { total: v[0]||0, winRate: v[0] ? Math.round((v[1]/v[0])*100)+'%' : '0%', profit: v[2]||0, today: v[3]||0 }
  } catch { return { total: 0, winRate: '0%', profit: 0, today: 0 } }
}
