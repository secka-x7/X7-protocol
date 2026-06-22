// X7-SV · dashboard.js — WebSocket server · REST API · Nightfall backend

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getConfig, setConfig, getExecutions, getStats } from './db.js'
import { getActiveChains, getChain } from './chains.js'
import { getExecutorAddress, getContractAddr } from './pimlico.js'
import { getSVStats } from './vaults.js'
import { getAllBalances, withdraw, startTreasury } from './treasury.js'
import { getPropellerStats, getPropellerConfig, setPropellerConfig } from './propellers.js'
import { getSolverStats } from './solver.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })
const PORT = process.env.PORT || 3000
const PASSKEY = process.env.NIGHTFALL_PASSKEY || '3530588'

app.use(express.json())

// ── WEBSOCKET BROADCAST ──────────────────────────────────────────────────────
const clients = new Set()

export function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() })
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg) })
}

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  // Send current state on connect
  buildOverview().then(d => ws.send(JSON.stringify({ type: 'tick', data: d }))).catch(() => {})
})

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() | 0 }))

// ── OVERVIEW ─────────────────────────────────────────────────────────────────
async function buildOverview() {
  const stats = getStats()
  const sv = getSVStats()
  const balances = await getAllBalances()
  const chains = {}

  getActiveChains().forEach(c => {
    chains[c.name] = {
      contract: getContractAddr(c.name) || getConfig('deploy_status_' + c.name) || 'waiting',
      balance: balances[c.name] || '0',
      profit24: parseFloat(getConfig('profit24_' + c.name) || '0'),
      tier: c.tier
    }
  })

  const prices = JSON.parse(getConfig('prices') || '{}')

  return {
    totalRevenue: stats.profit,
    todayRevenue: stats.today,
    executor: getExecutorAddress(),
    balances, chains, sv, prices,
    propellers: getPropellerConfig(),
    propellerStats: getPropellerStats(),
    solver: getSolverStats(),
    stats: { total: stats.total, winRate: stats.winRate, profit: stats.profit },
    recentExecutions: getExecutions(20),
    uptime: process.uptime() | 0,
    activeChains: getActiveChains().length
  }
}

app.get('/api/overview', async (_, res) => {
  try { res.json(await buildOverview()) }
  catch (e) { res.json({ initializing: true, error: e.message }) }
})

app.get('/api/executions', (req, res) => {
  const sv = req.query.sv || ''
  const executions = getExecutions(100, sv)
  const stats = getStats()
  res.json({ executions, stats: { total: stats.total, winRate: stats.winRate, profit: stats.profit } })
})

app.get('/api/treasury', async (_, res) => {
  const stats = getStats()
  const balances = await getAllBalances()
  const byChain = {}
  getActiveChains().forEach(c => { byChain[c.name] = parseFloat(getConfig('profit24_' + c.name) || '0') })
  res.json({ totalRevenue: stats.profit, byChain, autoWithdraw: getConfig('auto_withdraw') === 'true', balances })
})

app.get('/api/system', (_, res) => {
  const mem = process.memoryUsage()
  res.json({
    uptime: process.uptime() | 0,
    memory: (mem.rss / 1024 / 1024).toFixed(0) + 'MB',
    heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
    activeChains: getActiveChains(),
    dbReady: true,
    envStatus: {
      EXECUTOR_KEY: !!process.env.EXECUTOR_PRIVATE_KEY,
      ALCHEMY_ETH: !!process.env.ALCHEMY_ETH_KEY,
      ALCHEMY_ARB: !!process.env.ALCHEMY_ARB_KEY,
      ALCHEMY_POL: !!process.env.ALCHEMY_POL_KEY,
      PIMLICO: !!process.env.PIMLICO_API_KEY,
      MODEM_PAY: !!process.env.MODEM_PAY_SECRET_KEY,
      DATABASE_URL: !!process.env.DATABASE_URL,
    }
  })
})

// ── CONTROLS ─────────────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  const { key, value } = req.body
  if (!key) return res.status(400).json({ error: 'key required' })
  setConfig(key, value)
  res.json({ ok: true })
})

app.post('/api/propeller', (req, res) => {
  const { key, value } = req.body
  if (!key) return res.status(400).json({ error: 'key required' })
  setPropellerConfig(key, value)
  broadcast('propeller_update', getPropellerConfig())
  res.json({ ok: true, config: getPropellerConfig() })
})

app.post('/api/withdraw', async (req, res) => {
  const { amount } = req.body
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' })
  try {
    const result = await withdraw(parseFloat(amount))
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/toggle-auto-withdraw', (req, res) => {
  const current = getConfig('auto_withdraw') === 'true'
  setConfig('auto_withdraw', String(!current))
  res.json({ autoWithdraw: !current })
})

// ── SERVE NIGHTFALL UI ────────────────────────────────────────────────────────
const uiPath = join(__dir, 'dashboard/nightfall.html')
app.get('/', (req, res) => {
  if (existsSync(uiPath)) {
    let html = readFileSync(uiPath, 'utf8')
    // Inject passkey for gate
    html = html.replace('__PASSKEY__', PASSKEY)
    res.send(html)
  } else {
    res.send('<h1>X7-SV Nightfall</h1><p>UI loading...</p>')
  }
})

export function startDashboard() {
  server.listen(PORT, () => console.log(`[DASHBOARD] Nightfall live on :${PORT}`))

  // Broadcast tick every 3s
  setInterval(async () => {
    try {
      const d = await buildOverview()
      broadcast('tick', d)
    } catch {}
  }, 3000)
}
