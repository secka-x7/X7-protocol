// X7-SV · index.js — boot · async main() · health first · watchdog

// ── CRITICAL FIX: Express binds BEFORE any async work ────────────────────────
// This is what was crashing Railway: top-level await import crashed before
// /health could ever respond. Now health binds in <5ms, Railway is happy.

import express from 'express'
import { on } from './events.js'

const PORT = process.env.PORT || 3000
const app  = express()

// /health responds IMMEDIATELY — before DB, chains, anything
app.get('/health', (_, res) => res.json({ status:'ok', uptime: process.uptime()|0 }))
const server = app.listen(PORT, () => {
  console.log('X7-SV v3.0 STARTING — 10 SVs · 5,000 instances · 50 chains')
  console.log('[BOOT] /health live on :', PORT)
})

// ── ASYNC MAIN — everything else loads here ───────────────────────────────────
const START = Date.now()

async function main() {
  // 1. DB (sql.js — no native compile)
  try {
    const { initDB } = await import('./db.js')
    await initDB()
  } catch(e) { console.error('[DB] FATAL:', e.message); process.exit(1) }

  // 2. Dashboard (replaces bare express with full WebSocket + API)
  try {
    const { startDashboard } = await import('./dashboard.js')
    server.close() // Close bare server
    startDashboard() // Full dashboard server starts on same PORT
  } catch(e) { console.error('[DASHBOARD]:', e.message) }

  // 3. Chains
  let chains
  try {
    const { initChains } = await import('./chains.js')
    chains = await initChains()
  } catch(e) { console.error('[CHAINS]:', e.message); return }

  // 4. RPC + WebSocket
  try {
    const { initRPC } = await import('./rpc.js')
    initRPC(chains)
  } catch(e) { console.error('[RPC]:', e.message) }

  // 5. Executor wallet
  try {
    const { initPimlico } = await import('./pimlico.js')
    initPimlico()
  } catch(e) { console.error('[PIMLICO]:', e.message) }

  // 6. Compile X7.sol
  try {
    const { compile } = await import('./compiler.js')
    await compile()
  } catch(e) { console.warn('[COMPILER]:', e.message) }

  // 7. Bootstrap (Arch 1: zero-seed)
  try {
    const { initBootstrap } = await import('./bootstrap.js')
    await initBootstrap()
  } catch(e) { console.warn('[BOOTSTRAP]:', e.message) }

  // 8. CEX feeds → triggers P6/S3
  try {
    const { startCEXFeed } = await import('./cexfeed.js')
    startCEXFeed()
  } catch(e) { console.warn('[CEX]:', e.message) }

  // 9. Revenue engine (Arch 2: 6 non-MEV streams)
  try {
    const { startRevenue } = await import('./revenue.js')
    startRevenue()
  } catch(e) { console.warn('[REVENUE]:', e.message) }

  // 10. Vaults — 10 SVs watching all chains
  try {
    const { startVaults } = await import('./vaults.js')
    startVaults()
  } catch(e) { console.error('[VAULTS]:', e.message) }

  // 11. Treasury
  try {
    const { startTreasury } = await import('./treasury.js')
    startTreasury()
  } catch(e) { console.warn('[TREASURY]:', e.message) }

  const bootMs = Date.now() - START
  console.log(`X7-SV OPERATIONAL — ${Object.keys(chains).length} chains — boot ${bootMs}ms`)

  // ── WATCHDOG ─────────────────────────────────────────────────────────────
  let fails = 0
  setInterval(async () => {
    try {
      const { rpcCall } = await import('./rpc.js')
      const { getActiveChains } = await import('./chains.js')
      let ok = 0
      for (const c of getActiveChains().slice(0,3)) {
        try { if (await rpcCall(c.name, 'eth_blockNumber', [])) ok++ } catch {}
      }
      if (ok === 0) {
        fails++
        console.warn(`[WATCHDOG] All RPC failed (${fails}/3)`)
        if (fails >= 3) { fails = 0; console.error('[WATCHDOG] Critical — check RPC providers') }
      } else { fails = 0 }
    } catch {}
  }, 30000)

  // ── CIRCUIT BREAKER ───────────────────────────────────────────────────────
  let misses = 0, execs = 0
  on('missed_rev', () => misses++)
  on('sv_update',  () => execs++)
  setInterval(() => {
    if (execs > 5 && misses / (execs+misses) > 0.8)
      console.warn('[CIRCUIT] High miss rate — check chain health')
    misses = 0; execs = 0
  }, 300000)
}

// No top-level await — main() is called, not awaited at top level
main().catch(e => {
  console.error('[BOOT] Fatal:', e.message)
  process.exit(1)
})

process.on('uncaughtException',  e => console.error('[UNCAUGHT]:', e.message?.slice(0,100)))
process.on('unhandledRejection', e => console.error('[REJECT]:',   String(e).slice(0,100)))
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0) })
