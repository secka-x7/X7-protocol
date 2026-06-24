// X7-SV · cexfeed.js — 4 CEX WebSocket feeds · triggers P6/S3

import WebSocket from 'ws'
import { getConfig, setConfig } from './db.js'
import { p6StatArb } from './propellers.js'
import { processCEXDEXGap } from './revenue.js'
import { getActiveChains } from './chains.js'
import { emit } from './events.js'

let _prices = { ETH: 0, BTC: 0 }

export const getCEXPrice = (sym='ETH') => _prices[sym] || 0

async function onPriceUpdate(symbol, price) {
  if (!price || price <= 0) return
  _prices[symbol] = price
  const prices = JSON.parse(getConfig('prices')||'{}')
  prices[symbol] = price
  setConfig('prices', JSON.stringify(prices))

  emit('cex_price', { symbol, price })

  const chains = getActiveChains().filter(c => c.tier === 1)
  for (const chain of chains) {
    const dexPrice = parseFloat(getConfig(`dex_price_${chain.name}`)||'0')
    if (!dexPrice) continue
    const gap = Math.abs(price - dexPrice) / dexPrice * 100
    if (gap >= 0.03) {
      p6StatArb(chain.name, price, dexPrice).catch(() => {})
      processCEXDEXGap(chain.name, price, dexPrice, symbol).catch(() => {})
    }
  }
}

function connectBinance() {
  function connect() {
    try {
      const ws = new WebSocket('wss://stream.binance.com:9443/ws/ethusdt@trade')
      ws.on('open',    () => console.log('[CEX] Binance connected'))
      ws.on('message', raw => {
        try {
          const d = JSON.parse(raw.toString())
          if (d.e === 'trade' && d.s === 'ETHUSDT') onPriceUpdate('ETH', parseFloat(d.p))
        } catch {}
      })
      ws.on('error', () => {})
      ws.on('close', () => setTimeout(connect, 3000))
    } catch { setTimeout(connect, 5000) }
  }
  connect()
}

function connectOKX() {
  function connect() {
    try {
      const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public')
      ws.on('open', () => {
        ws.send(JSON.stringify({ op:'subscribe', args:[{ channel:'tickers', instId:'ETH-USDT' }] }))
        console.log('[CEX] OKX connected')
      })
      ws.on('message', raw => {
        try {
          const d = JSON.parse(raw.toString())
          if (d.data?.[0]?.instId === 'ETH-USDT') onPriceUpdate('ETH', parseFloat(d.data[0].last))
        } catch {}
      })
      ws.on('error', () => {})
      ws.on('close', () => setTimeout(connect, 3000))
    } catch { setTimeout(connect, 5000) }
  }
  connect()
}

function connectBybit() {
  function connect() {
    try {
      const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot')
      ws.on('open', () => {
        ws.send(JSON.stringify({ op:'subscribe', args:['tickers.ETHUSDT'] }))
        console.log('[CEX] Bybit connected')
      })
      ws.on('message', raw => {
        try {
          const d = JSON.parse(raw.toString())
          if (d.data?.symbol === 'ETHUSDT') onPriceUpdate('ETH', parseFloat(d.data.lastPrice))
        } catch {}
      })
      ws.on('error', () => {})
      ws.on('close', () => setTimeout(connect, 3000))
    } catch { setTimeout(connect, 5000) }
  }
  connect()
}

export function startCEXFeed() {
  console.log('[CEX] Connecting to 3 CEX feeds (Binance · OKX · Bybit)...')
  connectBinance()
  setTimeout(connectOKX,   1000)
  setTimeout(connectBybit, 2000)
}
