// X7-SV · treasury.js — USDC sweep · LP vault · Modem Pay Wave withdrawal

import { getConfig, setConfig, recordWithdrawal } from './db.js'
import { getActiveChains, getChain } from './chains.js'
import { rpcCall } from './rpc.js'
import { getExecutorAddress } from './pimlico.js'

// ── LP VAULT ────────────────────────────────────────────────────────────────
// Track USDC deployed as LP across all chains
export function getLPVaultBalance() {
  return parseFloat(getConfig('lp_vault_total') || '0')
}

export function addToLPVault(amount) {
  const current = getLPVaultBalance()
  setConfig('lp_vault_total', (current + amount).toFixed(2))
}

// ── BALANCE CHECK ────────────────────────────────────────────────────────────
export async function getUSDCBalance(chainName) {
  const chain = getChain(chainName)
  const exec = getExecutorAddress()
  if (!chain?.usdc || !exec) return 0
  try {
    const bal = await rpcCall(chainName, 'eth_call', [{
      to: chain.usdc,
      data: '0x70a08231000000000000000000000000' + exec.slice(2)
    }, 'latest'])
    return Number(BigInt(bal || '0x0')) / 1e6
  } catch { return 0 }
}

export async function getAllBalances() {
  const chains = getActiveChains()
  const balances = {}
  await Promise.allSettled(chains.map(async c => {
    try {
      const hex = await rpcCall(c.name, 'eth_getBalance', [getExecutorAddress(), 'latest'])
      balances[c.name] = (Number(BigInt(hex || '0x0')) / 1e18).toFixed(8)
    } catch { balances[c.name] = '0' }
  }))
  return balances
}

// ── MODEM PAY WITHDRAWAL ─────────────────────────────────────────────────────
export async function withdraw(amountUSDC) {
  if (!amountUSDC || amountUSDC <= 0) throw new Error('Invalid amount')
  const key = process.env.MODEM_PAY_SECRET_KEY
  const wave = process.env.MODEM_PAY_WAVE_NUMBER
  if (!key || !wave) throw new Error('MODEM_PAY credentials not set in env')

  const resp = await fetch('https://api.modempay.com/v1/transfer', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountUSDC, currency: 'USDC', recipient: wave, network: 'wave' }),
    signal: AbortSignal.timeout(30000)
  })

  if (!resp.ok) throw new Error('Modem Pay API error: ' + resp.status)
  const data = await resp.json()
  const gmd = amountUSDC * 570 // Approximate USDC → GMD rate

  recordWithdrawal({ usdcAmount: amountUSDC, gmdAmount: gmd, txId: data.id || 'pending', status: 'completed' })
  setConfig('last_withdrawal', JSON.stringify({ amount: amountUSDC, ts: Date.now() }))
  console.log(`[TREASURY] Withdrew $${amountUSDC} USDC → ${gmd.toFixed(0)} GMD via Wave`)
  return { success: true, gmd, txId: data.id }
}

// ── AUTO-WITHDRAW ────────────────────────────────────────────────────────────
export function startTreasury() {
  console.log('[TREASURY] USDC tracking + Modem Pay + LP vault active')

  // Auto-withdraw 30% when balance crosses threshold
  setInterval(async () => {
    if (getConfig('auto_withdraw') !== 'true') return
    const threshold = parseFloat(getConfig('auto_withdraw_threshold') || '500')
    const total = parseFloat(getConfig('sv_total') || '0')
    const lastWD = JSON.parse(getConfig('last_withdrawal') || '{"amount":0}')
    const earned = total - (lastWD.amount || 0)
    if (earned >= threshold) {
      const amount = earned * 0.3
      withdraw(amount).catch(e => console.error('[TREASURY] Auto-withdraw failed:', e.message))
    }
  }, 60000)

  // LP vault: deploy 50% of profits automatically
  setInterval(() => {
    const total = parseFloat(getConfig('sv_total') || '0')
    const deployed = getLPVaultBalance()
    const available = (total - deployed) * 0.5
    if (available > 100) {
      addToLPVault(available)
      console.log(`[TREASURY] LP vault +$${available.toFixed(0)} (total: $${(deployed + available).toFixed(0)})`)
    }
  }, 300000) // Every 5 minutes
}
