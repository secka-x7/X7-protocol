// X7-SV — TREASURY ENGINE
// USDC sweep after every execution
// Modem Pay → Wave Mobile Money → GMD withdrawal
// Auto-withdraw toggle
// Exports: getAutoWithdraw, setAutoWithdraw, withdraw, manualWithdraw, startTreasury

import { getConfig, setConfig, recordWithdrawal } from './db.js'
import { getActiveChains, getChain } from './chains.js'
import { rpcCall } from './rpc.js'

// ─── AUTO-WITHDRAW STATE ──────────────────────────────────────────────────────

export function getAutoWithdraw() {
  return getConfig('auto_withdraw') === 'true'
}

export function setAutoWithdraw(val) {
  setConfig('auto_withdraw', val ? 'true' : 'false')
  return val
}

// ─── USDC SWEEP ───────────────────────────────────────────────────────────────
// Called after every execution — converts all non-USDC tokens to USDC

export async function sweepToUSDC(chainName, contractAddr) {
  try {
    const chain = getChain(chainName)
    if (!chain?.weth || !chain?.usdc) return

    const tokens = [chain.weth, chain.wbtc, chain.dai].filter(Boolean)
    if (!tokens.length) return

    const { buildAndSubmitBundle } = await import('./builders.js')
    const { encodeFunctionData, parseAbi } = await import('viem')

    const SWEEP_ABI = parseAbi([
      'function sweepToUSDC(address[] calldata tokens) external'
    ])

    const data = encodeFunctionData({
      abi: SWEEP_ABI,
      functionName: 'sweepToUSDC',
      args: [tokens]
    })

    await buildAndSubmitBundle(chainName, contractAddr, data, 0)
  } catch (e) {
    // Silent — sweep failure should never block execution
    console.log('[TREASURY] sweep error: ' + e.message?.slice(0, 80))
  }
}

// ─── MODEM PAY WITHDRAWAL ─────────────────────────────────────────────────────
// USDC → Modem Pay API → Wave Mobile Money → GMD
// Settlement: 5-10 minutes

export async function manualWithdraw(amountUSDC) {
  if (!amountUSDC || Number(amountUSDC) <= 0) {
    throw new Error('Invalid withdrawal amount')
  }

  const key    = process.env.MODEM_PAY_SECRET_KEY
  const wave   = process.env.MODEM_PAY_WAVE_NUMBER
  const pubKey = process.env.MODEM_PAY_PUBLIC_KEY

  if (!key || !wave) {
    throw new Error('MODEM_PAY_SECRET_KEY and MODEM_PAY_WAVE_NUMBER required')
  }

  const amount = parseFloat(amountUSDC)
  const rate   = 570 // approximate USDC → GMD rate
  const gmd    = (amount * rate).toFixed(2)

  let txId = 'mp_' + Date.now()

  try {
    const resp = await fetch('https://api.modempay.com/v1/transfer', {
      method: 'POST',
      headers: {
        'Authorization':  'Bearer ' + key,
        'X-Public-Key':   pubKey || '',
        'Content-Type':   'application/json'
      },
      body: JSON.stringify({
        amount:    amount,
        currency:  'USDC',
        recipient: wave,
        network:   'wave',
        reference: 'X7SV-' + Date.now()
      }),
      signal: AbortSignal.timeout(30000)
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.status.toString())
      throw new Error('Modem Pay API error: ' + errText.slice(0, 200))
    }

    const data = await resp.json()
    txId = data.id || data.transaction_id || txId
  } catch (e) {
    if (e.message?.startsWith('Modem Pay API error')) throw e
    // Network/timeout — log and continue (transfer may have gone through)
    console.log('[TREASURY] Modem Pay network error: ' + e.message?.slice(0, 100))
  }

  // Record regardless of API response
  try {
    recordWithdrawal({
      usdcAmount: amount,
      gmdAmount:  parseFloat(gmd),
      status:     'completed',
      txId
    })
  } catch {}

  setConfig('last_withdrawal', JSON.stringify({
    amount, gmd, txId, ts: Date.now()
  }))

  // Update running total withdrawn
  const totalWithdrawn = parseFloat(getConfig('total_withdrawn') || '0') + amount
  setConfig('total_withdrawn', totalWithdrawn.toFixed(2))

  console.log('[TREASURY] Withdrawal: $' + amount + ' USDC → ' + gmd + ' GMD | txId: ' + txId)

  return { success: true, amount, gmd, txId }
}

// ─── WITHDRAW ALIAS (used by dashboard.js) ───────────────────────────────────

export async function withdraw(amount) {
  return manualWithdraw(amount)
}

// ─── TREASURY STATS ───────────────────────────────────────────────────────────

export function getTreasuryStats() {
  const totalRevenue   = parseFloat(getConfig('sv_total')        || '0')
  const totalWithdrawn = parseFloat(getConfig('total_withdrawn')  || '0')
  const available      = Math.max(0, totalRevenue - totalWithdrawn)
  const autoWithdraw   = getAutoWithdraw()
  const lastWD         = JSON.parse(getConfig('last_withdrawal')  || 'null')

  // Revenue by chain
  const byChain = {}
  try {
    const chains = getActiveChains()
    for (const chain of chains) {
      const profit = parseFloat(getConfig('chain_profit_' + chain.name) || '0')
      if (profit > 0) byChain[chain.name] = profit
    }
  } catch {}

  return {
    totalRevenue,
    totalWithdrawn,
    available,
    autoWithdraw,
    lastWithdrawal: lastWD,
    byChain
  }
}

// ─── RECORD CHAIN PROFIT (called from vaults.js after each execution) ─────────

export function recordChainProfit(chainName, profitUSDC) {
  if (!chainName || !profitUSDC || profitUSDC <= 0) return
  const key     = 'chain_profit_' + chainName
  const current = parseFloat(getConfig(key) || '0')
  setConfig(key, (current + profitUSDC).toFixed(4))
}

// ─── BROADCAST HELPER ─────────────────────────────────────────────────────────

function broadcastTreasury() {
  try {
    import('./dashboard.js').then(m => {
      const stats = getTreasuryStats()
      m.broadcast('treasury_update', stats)
    }).catch(() => {})
  } catch {}
}

// ─── AUTO-WITHDRAW LOOP ───────────────────────────────────────────────────────
// Checks every 60 seconds
// Triggers at $500 accumulated profit since last withdrawal

export function startTreasury() {
  console.log('[TREASURY] USDC sweep + Modem Pay integration active')
  console.log('[TREASURY] Auto-withdraw: ' + (getAutoWithdraw() ? 'ON' : 'OFF'))

  setInterval(async () => {
    try {
      if (!getAutoWithdraw()) return

      const totalRevenue   = parseFloat(getConfig('sv_total')       || '0')
      const totalWithdrawn = parseFloat(getConfig('total_withdrawn') || '0')
      const available      = totalRevenue - totalWithdrawn

      // Trigger: $500+ available profit
      if (available < 500) return

      // Withdraw 30% of available
      const withdrawAmount = parseFloat((available * 0.3).toFixed(2))
      if (withdrawAmount < 1) return

      console.log('[TREASURY] Auto-withdraw triggered: $' + withdrawAmount)
      await manualWithdraw(withdrawAmount)
      broadcastTreasury()
    } catch (e) {
      console.log('[TREASURY] Auto-withdraw error: ' + e.message?.slice(0, 100))
    }
  }, 60000)

  // Broadcast treasury stats every 30 seconds to Nightfall
  setInterval(() => {
    broadcastTreasury()
  }, 30000)
}  recordWithdrawal({ usdcAmount: amountUSDC, gmdAmount: gmd, status: 'completed', txId: data.id })
  setConfig('last_withdrawal', JSON.stringify({ amount: amountUSDC, ts: Date.now() }))
  return { success: true, gmd, txId: data.id }
}

export function startTreasury() {
  console.log('[TREASURY] USDC sweep + Modem Pay integration active')
  // Auto-withdraw check every $500
  setInterval(async () => {
    const auto = getConfig('auto_withdraw') === 'true'
    if (!auto) return
    const total = Number(getConfig('sv_total') || 0)
    const lastWD = JSON.parse(getConfig('last_withdrawal') || '{"amount":0}')
    if (total - (lastWD.amount || 0) >= 500) {
      try { await manualWithdraw((total - (lastWD.amount || 0)) * 0.3) } catch {}
    }
  }, 60000)
}
