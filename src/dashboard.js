// X7 PROTOCOL — DASHBOARD SERVER
// Live wallet balances — updates every 5 seconds
// Four strategy panels with live P&L
// MATIC balance shows instantly when sent
// Deploy status updates in real-time

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getTotalRevenue, getTodayRevenue, getRecentExecutions,
         getWithdrawals, getConfig, query, isReady } from './db.js'
import { getAutoWithdraw, setAutoWithdraw, withdraw } from './treasury.js'
import { getExecutorAddress, getNativeBalance } from './pimlico.js'
import { CHAINS, ACTIVE_CHAINS } from './config.js'

const __dir  = dirname(fileURLToPath(import.meta.url))
const HTML   = readFileSync(join(__dir, 'dashboard/index.html'), 'utf8')
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const clients= new Set()
app.use(express.json())

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

export function broadcast(type, data) {
  const m = JSON.stringify({ type, data, ts: Date.now() })
  for (const c of clients)
    if (c.readyState === 1) try { c.send(m) } catch {}
}

// Push live wallet balances every 5 seconds
async function pushBalances() {
  const execAddr = getExecutorAddress()
  if (!execAddr) return

  const balances = {}
  for (const chainName of ['polygon','arbitrum','ethereum','avalanche','base']) {
    if (!CHAINS[chainName]) continue
    try {
      const bal = await getNativeBalance(chainName)
      const f   = (Number(bal) / 1e18).toFixed(6)
      balances[chainName] = f
      setConfig('live_balance_' + chainName, f)
    } catch {
      balances[chainName] = getConfig('live_balance_' + chainName) || '0'
    }
  }
  broadcast('balances', { executor: execAddr, balances })
}

// Health — always responds
app.get('/health', (_, res) => res.status(200).json({
  status: 'operational', uptime: Math.floor(process.uptime()),
  ts: new Date().toISOString(), dbReady: isReady()
}))

app.get('/api/overview', (req, res) => {
  if (!isReady()) return res.json({ initializing: true })
  try {
    const execAddr = getExecutorAddress()
    const balances = {}
    for (const c of ['polygon','arbitrum','ethereum','avalanche','base']) {
      balances[c] = getConfig('live_balance_' + c) || '0'
    }

    const totalExecs   = query('SELECT COUNT(*) as c FROM executions')[0]?.c || 0
    const successExecs = query("SELECT COUNT(*) as c FROM executions WHERE status='success'")[0]?.c || 0
    const borrowers    = query('SELECT COUNT(*) as c FROM borrowers')[0]?.c || 0
    const atRisk       = query('SELECT COUNT(*) as c FROM borrowers WHERE health_factor < 1.1 AND health_factor > 0')[0]?.c || 0
    const liquidatable = query('SELECT COUNT(*) as c FROM borrowers WHERE health_factor < 1.0 AND health_factor > 0')[0]?.c || 0

    // Four strategy statuses
    const strategies = {
      cexdex: {
        status: getConfig('cexdex_status') || 'starting',
        total:  getConfig('cexdex_total')  || '0',
        count:  getConfig('cexdex_count')  || '0',
        last:   (() => { try { return JSON.parse(getConfig('cexdex_last')||'{}') } catch { return {} } })()
      },
      backrun: {
        status: getConfig('backrun_status') || 'starting',
        total:  getConfig('backrun_total')  || '0',
        count:  getConfig('backrun_count')  || '0',
        last:   (() => { try { return JSON.parse(getConfig('backrun_last')||'{}') } catch { return {} } })()
      },
      jit: {
        status: getConfig('jit_status') || 'starting',
        total:  getConfig('jit_total')  || '0',
        count:  getConfig('jit_count')  || '0',
        last:   (() => { try { return JSON.parse(getConfig('jit_last')||'{}') } catch { return {} } })()
      },
      liquidations: {
        status:      'active',
        total:       getConfig('liq_total') || '0',
        count:       getConfig('liq_count') || '0',
        borrowers,
        atRisk,
        liquidatable,
        missed:      (() => {
          let t = 0
          ACTIVE_CHAINS.forEach(c => { t += Number(getConfig('missed_profit_' + c)||0) })
          return t.toFixed(2)
        })(),
        last: (() => { try { return JSON.parse(getConfig('liq_last')||'{}') } catch { return {} } })()
      }
    }

    res.json({
      totalRevenue:     getTotalRevenue(),
      todayRevenue:     getTodayRevenue(),
      recentExecutions: getRecentExecutions(15),
      prices:    JSON.parse(getConfig('prices') || '{}'),
      apex:      { insight: getConfig('apex_insight') || 'Scanning.',
                   action:  getConfig('apex_action')  || '--' },
      executor:  execAddr,
      balances,
      autoWithdraw: getAutoWithdraw(),
      strategies,
      stats: { total: totalExecs, success: successExecs,
               winRate: totalExecs > 0
                 ? ((successExecs/totalExecs)*100).toFixed(1)+'%' : '0%' },
      chains: ACTIVE_CHAINS.reduce((a, c) => ({
        ...a, [c]: {
          ws:       getConfig('ws_' + c)      || 'starting',
          contract: getConfig('contract_' + c) || 'waiting',
          wr_aave:  getConfig('wr_' + c + '_aave') || '0.400',
          yield:    getConfig('yield_deployed_' + c) || '0',
          borrowers: query('SELECT COUNT(*) as c FROM borrowers WHERE chain=?', [c])[0]?.c || 0,
          balance:  getConfig('live_balance_' + c) || '0'
        }
      }), {})
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/strategies', (req, res) => {
  if (!isReady()) return res.json({})
  try {
    res.json({
      cexdex:   { status: getConfig('cexdex_status')||'starting',
                  total:  getConfig('cexdex_total') ||'0',
                  count:  getConfig('cexdex_count') ||'0' },
      backrun:  { status: getConfig('backrun_status')||'starting',
                  total:  getConfig('backrun_total') ||'0',
                  count:  getConfig('backrun_count') ||'0' },
      jit:      { status: getConfig('jit_status')||'starting',
                  total:  getConfig('jit_total') ||'0',
                  count:  getConfig('jit_count') ||'0' },
      liq:      { total:  getConfig('liq_total')||'0',
                  count:  getConfig('liq_count')||'0',
                  missed: (() => {
                    let t=0; ACTIVE_CHAINS.forEach(c=>{t+=Number(getConfig('missed_profit_'+c)||0)}); return t.toFixed(2)
                  })() }
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/executions', (req, res) => {
  if (!isReady()) return res.json({ executions:[], stats:{} })
  try {
    const executions = query('SELECT * FROM executions ORDER BY created_at DESC LIMIT 200')
    const total   = query('SELECT COUNT(*) as c FROM executions')[0]?.c||0
    const success = query("SELECT COUNT(*) as c FROM executions WHERE status='success'")[0]?.c||0
    const profit  = query("SELECT SUM(profit_usdc) as t FROM executions WHERE status='success'"  )[0]?.t||0
    res.json({ executions, stats:{total,success,profit,
      winRate: total>0?((success/total)*100).toFixed(1)+'%':'0%'} })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('/api/treasury', (req, res) => {
  if (!isReady()) return res.json({})
  try {
    res.json({
      totalRevenue: getTotalRevenue(),
      todayRevenue: getTodayRevenue(),
      byChain: ACTIVE_CHAINS.reduce((a,c) => ({
        ...a, [c]: Number(query(
          "SELECT SUM(profit_usdc) as t FROM executions WHERE chain=? AND status='success'",[c]
        )[0]?.t)||0
      }),{}),
      withdrawals:  getWithdrawals(10),
      autoWithdraw: getAutoWithdraw()
    })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('/api/system', (req, res) => {
  if (!isReady()) return res.json({ initializing:true })
  try {
    res.json({
      uptime:      Math.floor(process.uptime()),
      memory:      (process.memoryUsage().heapUsed/1024/1024).toFixed(0)+'MB',
      executor:    getExecutorAddress(),
      dbReady:     isReady(),
      activeChains: ACTIVE_CHAINS,
      apexLog:     query('SELECT * FROM apex_log ORDER BY created_at DESC LIMIT 20'),
      contracts:   ACTIVE_CHAINS.reduce((a,c)=>({...a,[c]:getConfig('contract_'+c)||'--'}),{}),
      envStatus: {
        EXECUTOR_PRIVATE_KEY:  !!process.env.EXECUTOR_PRIVATE_KEY,
        PIMLICO_API_KEY:       !!process.env.PIMLICO_API_KEY,
        ANTHROPIC_API_KEY:     !!process.env.ANTHROPIC_API_KEY,
        ALCHEMY_POL_KEY:       !!(process.env.ALCHEMY_POL_KEY||process.env.ALCHEMY_POLY_KEY),
        ALCHEMY_ARB_KEY:       !!process.env.ALCHEMY_ARB_KEY,
        ALCHEMY_ETH_KEY:       !!process.env.ALCHEMY_ETH_KEY,
        ALCHEMY_AVAX_KEY:      !!process.env.ALCHEMY_AVAX_KEY,
        MODEM_PAY_WAVE_NUMBER: !!process.env.MODEM_PAY_WAVE_NUMBER
      }
    })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/withdraw', async (req, res) => {
  try {
    const { amount } = req.body
    if (!amount || isNaN(+amount) || +amount <= 0)
      return res.status(400).json({ error:'Valid amount required' })
    const result = await withdraw(+amount)
    broadcast('withdrawal', { amount, id: result.key })
    res.json({ success:true, ...result })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/toggle-auto-withdraw', (req, res) => {
  const current = getAutoWithdraw()
  setAutoWithdraw(!current)
  broadcast('auto_withdraw_toggle', { enabled:!current })
  res.json({ autoWithdraw:!current })
})

app.get('*', (_, res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.send(HTML)
})

export function startDashboard() {
  const PORT = parseInt(process.env.PORT) || 3000
  server.listen(PORT, '0.0.0.0', () =>
    console.log('[DASHBOARD] Live on port ' + PORT))

  // Revenue ticks every 5 seconds
  setInterval(() => {
    try {
      broadcast('tick', {
        revenue: getTotalRevenue(),
        today:   getTodayRevenue(),
        ts:      Date.now()
      })
    } catch {}
  }, 5000)

  // Live wallet balances every 5 seconds
  setInterval(() => { pushBalances().catch(() => {}) }, 5000)

  return server
             }
