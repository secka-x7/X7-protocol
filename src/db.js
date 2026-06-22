// X7-SV · db.js — SQLite + Postgres dual-write · Railway volume persistence
// Data survives all redeploys via /data volume + external Postgres

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import pg from 'pg'

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

let db, pgPool

export async function initDB() {
  // SQLite on Railway persistent volume
  db = new Database(`${DATA_DIR}/x7sv.db`)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT, chain TEXT, protocol TEXT,
      profit_usdc REAL DEFAULT 0, status TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usdc_amount REAL, gmd_amount REAL,
      tx_id TEXT, status TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_exec_chain ON executions(chain, created_at);
    CREATE INDEX IF NOT EXISTS idx_exec_proto ON executions(protocol, status);
  `)

  // Postgres (Railway plugin) — backup/recovery layer
  if (process.env.DATABASE_URL) {
    try {
      pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS executions (
          id SERIAL PRIMARY KEY, tx_hash TEXT, chain TEXT, protocol TEXT,
          profit_usdc REAL DEFAULT 0, status TEXT,
          created_at BIGINT DEFAULT extract(epoch from now())
        );
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS withdrawals (
          id SERIAL PRIMARY KEY, usdc_amount REAL, gmd_amount REAL,
          tx_id TEXT, status TEXT,
          created_at BIGINT DEFAULT extract(epoch from now())
        );
      `)
      // Restore SQLite from Postgres if SQLite was fresh
      const count = db.prepare('SELECT COUNT(*) as n FROM executions').get()
      if (count.n === 0) {
        const rows = await pgPool.query('SELECT * FROM config')
        const ins = db.prepare('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)')
        rows.rows.forEach(r => ins.run(r.key, r.value))
      }
      console.log('[DB] Postgres connected — dual-write active')
    } catch (e) { console.log('[DB] Postgres optional:', e.message.slice(0, 60)) }
  }

  console.log('[DB] SQLite ready at ' + DATA_DIR + '/x7sv.db')
}

// Batched writes — flush every 100ms, not per-operation
const _writeQueue = []
let _flushTimer = null

function queueWrite(fn) {
  _writeQueue.push(fn)
  if (!_flushTimer) _flushTimer = setTimeout(flush, 100)
}

function flush() {
  _flushTimer = null
  if (!_writeQueue.length) return
  const batch = db.transaction(() => { _writeQueue.splice(0).forEach(fn => fn()) })
  try { batch() } catch (e) { console.error('[DB] flush:', e.message) }
}

export function setConfig(key, value) {
  queueWrite(() => db.prepare('INSERT OR REPLACE INTO config(key,value,updated_at) VALUES(?,?,unixepoch())').run(key, String(value)))
  if (pgPool) pgPool.query('INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [key, String(value)]).catch(() => {})
}

export function getConfig(key) {
  try { return db.prepare('SELECT value FROM config WHERE key=?').get(key)?.value ?? null }
  catch { return null }
}

export function recordExecution(data) {
  queueWrite(() => db.prepare('INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status) VALUES(?,?,?,?,?)').run(data.txHash || '', data.chain || '', data.protocol || '', data.profitUsdc || 0, data.status || 'success'))
  if (pgPool) pgPool.query('INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status) VALUES($1,$2,$3,$4,$5)', [data.txHash || '', data.chain || '', data.protocol || '', data.profitUsdc || 0, data.status || 'success']).catch(() => {})
}

export function recordWithdrawal(data) {
  queueWrite(() => db.prepare('INSERT INTO withdrawals(usdc_amount,gmd_amount,tx_id,status) VALUES(?,?,?,?)').run(data.usdcAmount, data.gmdAmount, data.txId || '', data.status || 'completed'))
  if (pgPool) pgPool.query('INSERT INTO withdrawals(usdc_amount,gmd_amount,tx_id,status) VALUES($1,$2,$3,$4)', [data.usdcAmount, data.gmdAmount, data.txId || '', data.status || 'completed']).catch(() => {})
}

export function getExecutions(limit = 50, protocol = '') {
  const sql = protocol
    ? 'SELECT * FROM executions WHERE protocol=? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM executions ORDER BY created_at DESC LIMIT ?'
  try { return db.prepare(sql).all(...(protocol ? [protocol, limit] : [limit])) }
  catch { return [] }
}

export function getStats() {
  try {
    const r = db.prepare(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) wins,
             SUM(profit_usdc) profit,
             SUM(CASE WHEN created_at > unixepoch()-86400 THEN profit_usdc ELSE 0 END) today
      FROM executions
    `).get()
    return { total: r.total || 0, winRate: r.total ? Math.round(r.wins / r.total * 100) + '%' : '0%', profit: r.profit || 0, today: r.today || 0 }
  } catch { return { total: 0, winRate: '0%', profit: 0, today: 0 } }
}
