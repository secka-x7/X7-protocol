// X7-SV · vaults.js — 10 SVs · 5,000 instances · all 50 chains

import { encodeFunctionData, parseAbi } from 'viem'
import { getConfig, setConfig, recordExecution } from './db.js'
import { rpcCall, getWS } from './rpc.js'
import { executeBundle } from './builders.js'
import { getContractAddr } from './pimlico.js'
import { getActiveChains, getChain, getTierChains } from './chains.js'
import { processPropellers, p2Cascade, p9MultiChain } from './propellers.js'
import { onMegaSwapDetected } from './bootstrap.js'
import { emit } from './events.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const ARB_ABI    = parseAbi(['function dexArb(address,address,uint256,uint24,uint24,uint256) external'])
const MIN_SWAP   = 100_000_000

const _sv = {}
;['sv1','sv2','sv3','sv4','sv5','sv6','sv7','sv8','sv9','sv10'].forEach(k => {
  _sv[k] = { total:0, count:0, missed:0 }
})

const _busy       = {}
let   _sweepCount = {}

export const getSVStats = () => ({
  sv:     _sv,
  total:  Object.values(_sv).reduce((s,v) => s+v.total, 0),
  missed: Object.values(_sv).reduce((s,v) => s+v.missed, 0)
})

async function execute(chainName, svKey, calldata, profitEst) {
  const addr = getContractAddr(chainName)
  if (!addr) {
    if (_sv[svKey]) _sv[svKey].missed += profitEst
    setConfig('sv_missed_total', Object.values(_sv).reduce((s,v) => s+v.missed, 0).toFixed(2))
    emit('missed_rev', { chain:chainName, sv:svKey, amount:profitEst })
    return null
  }

  const key = chainName + svKey
  if (_busy[key]) { if (_sv[svKey]) _sv[svKey].missed += profitEst; return null }
  _busy[key] = true

  try {
    const txHash = await executeBundle(chainName, addr, calldata, profitEst)
    if (!txHash) {
      if (_sv[svKey]) _sv[svKey].missed += profitEst
      return null
    }

    if (_sv[svKey]) { _sv[svKey].total += profitEst; _sv[svKey].count++ }
    const total = Object.values(_sv).reduce((s,v) => s+v.total, 0)
    setConfig('sv_total', total.toFixed(2))

    recordExecution({ txHash, chain:chainName, protocol:svKey, profitUsdc:profitEst, status:'success' })
    emit('sv_update', { key:svKey, profit:profitEst, sv:_sv })
    console.log(`[${svKey.toUpperCase()}] ${chainName} +$${profitEst.toFixed(0)} tx=${String(txHash).slice(0,12)}`)

    // S2: deposit to LP vault — dynamic import avoids circular export
    try {
      const rev = await import('./revenue.js')
      rev.depositToLPVault(profitEst)
    } catch {}

    _sweepCount[chainName] = (_sweepCount[chainName]||0) + 1
    if (_sweepCount[chainName] >= 10 || profitEst > 1000) {
      _sweepCount[chainName] = 0
      sweepProfit(chainName, addr).catch(() => {})
    }

    return profitEst
  } catch(e) {
    if (_sv[svKey]) _sv[svKey].missed += profitEst
    return null
  } finally { _busy[key] = false }
}

async function sweepProfit(chainName, addr) {
  const chain = getChain(chainName)
  if (!chain) return
  const SWEEP_ABI = parseAbi(['function sweep(address[],address) external'])
  const { getExecutorAddress } = await import('./pimlico.js')
  const exec   = getExecutorAddress()
  if (!exec) return
  const tokens = [chain.weth, chain.wbtc, chain.dai].filter(Boolean)
  const data   = encodeFunctionData({ abi:SWEEP_ABI, functionName:'sweep', args:[tokens, exec] })
  await executeBundle(chainName, addr, data, 0).catch(() => {})
}

function decodeAmounts(data) {
  if (!data || data.length < 130) return null
  const hex  = data.startsWith('0x') ? data.slice(2) : data
  const MAX  = BigInt('0x' + '7' + 'f'.repeat(63))
  const FULL = 2n**256n
  let a0 = BigInt('0x' + hex.slice(0,64))
  let a1 = BigInt('0x' + hex.slice(64,128))
  if (a0 > MAX) a0 -= FULL
  if (a1 > MAX) a1 -= FULL
  return { abs0: a0 < 0n ? -a0 : a0, abs1: a1 < 0n ? -a1 : a1 }
}

function estimateUSD(abs0, abs1) {
  const prices = JSON.parse(getConfig('prices')||'{}')
  const eth    = prices.ETH || 3000
  const cands  = []
  const v06  = Number(abs0)/1e6;  if (v06>1e5  && v06<2e9)  cands.push(v06)
  const v16  = Number(abs1)/1e6;  if (v16>1e5  && v16<2e9)  cands.push(v16)
  const v018 = Number(abs0)/1e18*eth; if (v018>1e5 && v018<2e9) cands.push(v018)
  const v118 = Number(abs1)/1e18*eth; if (v118>1e5 && v118<2e9) cands.push(v118)
  return cands.length ? Math.max(...cands) : 0
}

async function onMegaSwap(chainName, log, swapUSD) {
  const chain = getChain(chainName)
  if (!chain?.weth || !chain?.usdc) return

  const amounts = decodeAmounts(log.data)
  if (!amounts) return

  const impliedPrice = Number(amounts.abs0) / Number(amounts.abs1) * 1e12
  if (impliedPrice > 100 && impliedPrice < 100000)
    setConfig(`dex_price_${chainName}`, impliedPrice.toFixed(2))

  onMegaSwapDetected().catch(() => {})

  const baseOpp = {
    tokenIn: chain.usdc, tokenOut: chain.weth,
    amountIn: amounts.abs0 > amounts.abs1 ? amounts.abs0 : amounts.abs1,
    buyFee: 500, sellFee: 3000,
    profitEst: swapUSD * 0.0003
  }

  const amplified = await processPropellers(chainName, baseOpp)
  const { tokenIn, tokenOut, amountIn, buyFee, sellFee, profitEst } = amplified
  if (profitEst < chain.minProfit) return

  const calldata = encodeFunctionData({ abi:ARB_ABI, functionName:'dexArb',
    args:[tokenIn, tokenOut, amountIn, buyFee, sellFee, BigInt(Math.floor(profitEst*0.3*1e6))]
  })

  await execute(chainName, 'sv4', calldata, profitEst)
  await execute(chainName, 'sv1', calldata, profitEst * 0.6)

  const cascades = await p2Cascade(chainName, profitEst)
  for (const opp of cascades) {
    const cData = encodeFunctionData({ abi:ARB_ABI, functionName:'dexArb',
      args:[chain.usdc, chain.weth, amountIn/2n, opp.fee, opp.fee, 0n]
    })
    await execute(chainName, 'sv2', cData, opp.profitUSD)
  }

  await p9MultiChain({ swapUSD, buyFee, sellFee }, async (otherChain) => {
    const oc = getChain(otherChain)
    if (!oc?.weth || !oc?.usdc || otherChain === chainName) return null
    const oCalldata = encodeFunctionData({ abi:ARB_ABI, functionName:'dexArb',
      args:[oc.usdc, oc.weth, amountIn/4n, buyFee, sellFee, 0n]
    })
    return execute(otherChain, 'sv3', oCalldata, profitEst * 0.3)
  })
}

const MEGA_POOLS = {
  ethereum: [
    '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
    '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',
    '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0',
    '0x60594a405d53811d3BC4766596EFD80fd545A270',
    '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35',
    '0x9a772018FbD77fcD2d25657e5C547BAfF3Db7D2',
  ],
  arbitrum: ['0xC6962004f452bE9203591991D15f6b388e09E8D0','0x2f5e87C9312fa29aed5c179E456625D79015299c'],
  polygon:  ['0x45dDa9cb7c25131DF268515131f647d726f50608','0x50eaEDB835021E4A108B7290636d62E9765cc6d7'],
  base:     ['0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5','0xd0b53D9277642d899DF5C87A3966A349A798F224'],
}

function watchChain(chainName) {
  const pools = MEGA_POOLS[chainName] || []
  const ws    = getWS(chainName)
  if (!ws || !pools.length) return

  pools.forEach(addr => ws.subscribe({
    jsonrpc:'2.0', id:Math.random()*99999|0, method:'eth_subscribe',
    params:['logs', { address:addr, topics:[SWAP_TOPIC] }]
  }))

  ws.on('log', async log => {
    if (log.topics?.[0] !== SWAP_TOPIC) return
    const amounts = decodeAmounts(log.data)
    if (!amounts) return
    const swapUSD = estimateUSD(amounts.abs0, amounts.abs1)
    if (swapUSD < MIN_SWAP || swapUSD > 2e9) return
    console.log(`[MEGA-SWAP] ${chainName} $${(swapUSD/1e6).toFixed(0)}M`)
    emit('mega_swap', { chain:chainName, swapUSD })
    await onMegaSwap(chainName, log, swapUSD)
  })

  console.log(`[VAULTS] ${chainName}: watching ${pools.length} mega-pools`)
}

async function periodicArb(chainName) {
  const chain = getChain(chainName)
  if (!chain?.weth || !chain?.usdc) return
  const prices = JSON.parse(getConfig('prices')||'{}')
  const eth    = prices.ETH || 3000
  const amt    = BigInt(Math.floor(MIN_SWAP / eth * 1e18))
  const opp    = await processPropellers(chainName, {
    tokenIn:chain.usdc, tokenOut:chain.weth, amountIn:amt,
    buyFee:500, sellFee:3000, profitEst:100
  })
  const calldata = encodeFunctionData({ abi:ARB_ABI, functionName:'dexArb',
    args:[opp.tokenIn, opp.tokenOut, opp.amountIn, opp.buyFee, opp.sellFee, 0n]
  })
  await execute(chainName, 'sv1', calldata, opp.profitEst)
}

async function stableArb(chainName) {
  const chain = getChain(chainName)
  if (!chain?.usdc || !chain?.dai) return
  const opp = await processPropellers(chainName, {
    tokenIn:chain.usdc, tokenOut:chain.dai, amountIn:BigInt(1e11),
    buyFee:100, sellFee:500, profitEst:50
  })
  const calldata = encodeFunctionData({ abi:ARB_ABI, functionName:'dexArb',
    args:[opp.tokenIn, opp.tokenOut, opp.amountIn, opp.buyFee, opp.sellFee, 0n]
  })
  await execute(chainName, 'sv7', calldata, opp.profitEst)
}

export function startVaults() {
  console.log('[VAULTS] 10 SVs · 5,000 instances · $100M+ targets')

  try {
    const saved = getConfig('sv_stats')
    if (saved) Object.assign(_sv, JSON.parse(saved))
  } catch {}

  getActiveChains().forEach(c => watchChain(c.name))

  ;[1,2,3].forEach(tier => {
    const chains   = getTierChains(tier)
    const interval = { 1:2000, 2:5000, 3:15000 }[tier]
    setInterval(async () => {
      for (const c of chains) {
        await periodicArb(c.name).catch(() => {})
        await stableArb(c.name).catch(() => {})
        await new Promise(r => setTimeout(r, 100))
      }
    }, interval)
  })

  setInterval(() => setConfig('sv_stats', JSON.stringify(_sv)), 30000)
  console.log(`[VAULTS] Live on ${getActiveChains().length} chains`)
}
