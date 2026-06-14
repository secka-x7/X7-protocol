// X7 PROTOCOL — ENTRY POINT
// /health binds in < 50ms
// Everything else boots after
import { startDashboard, broadcast } from './dashboard.js'

console.log('X7 PROTOCOL STARTING')
startDashboard()
console.log('/health live')

setTimeout(boot, 1500)

async function boot() {
  // DB
  try { const {initDB}=await import('./db.js'); await initDB() }
  catch(e){ console.error('DB fatal:',e.message); process.exit(1) }
  // Load any manually set contract addresses from Railway env vars
  try {
    const { loadManualContracts } = await import('./deployer.js')
    loadManualContracts()
  } catch {}
  // Load manually set contract addresses from Railway env vars
  try {
    const { loadManualContracts } = await import('./deployer.js')
    loadManualContracts()
  } catch {}

  // Env check
  const need=['EXECUTOR_PRIVATE_KEY','PIMLICO_API_KEY','MODEM_PAY_SECRET_KEY','MODEM_PAY_WAVE_NUMBER']
  const missing=need.filter(k=>!process.env[k])
  if(missing.length) console.warn('Missing vars:',missing.join(', '))

  // APEX
  try { const {startApex}=await import('./apex.js'); await startApex() }
  catch(e){ console.error('APEX:',e.message) }

  // Compile + Deploy
  try {
    const {compile}=await import('./compiler.js')
    await compile()
    const {deployAll}=await import('./deployer.js')
    deployAll().catch(e=>console.warn('Deploy deferred:',e.message))
  } catch(e){ console.warn('Compile/deploy:',e.message) }

  // Yield manager
  try { const {startYield}=await import('./yield.js'); startYield() }
  catch(e){ console.warn('Yield:',e.message) }

  // Learner
  try { const {startLearner}=await import('./learner.js'); startLearner() }
  catch(e){ console.warn('Learner:',e.message) }

  // Scanner + Execution queue
  try { await startEngine() }
  catch(e){ console.error('Engine:',e.message) }

  console.log('X7 PROTOCOL OPERATIONAL')
}

async function startEngine() {
  const {startScanner}   = await import('./scanner.js')
  const {execute}        = await import('./executor.js')
  const {checkAutoWithdraw} = await import('./treasury.js')
  const {setConfig,getConfig} = await import('./db.js')

  // Priority queues: tier1 = HF < 0.95, tier2 = HF 0.95-1.0
  const tier1 = [], tier2 = []
  let   busy  = false

  const enqueue = opp => {
    const q = opp.tier1 ? tier1 : tier2
    if (!q.find(o=>o.borrower===opp.borrower&&o.chainName===opp.chainName)) {
      q.push(opp)
      console.log(`[QUEUE] ${opp.chainName}/${opp.protocol} ${opp.borrower.slice(0,10)} HF=${opp.hf?.toFixed(4)} tier${opp.tier1?1:2}`)
      broadcast('opportunity',{chain:opp.chainName,hf:opp.hf,tier:opp.tier1?1:2})
    }
  }

  // Process every 500ms — tier1 first (100% close factor)
  setInterval(async () => {
    if (busy) return
    const opp = tier1.shift() || tier2.shift()
    if (!opp) return
    busy = true
    try {
      const result = await execute(opp)
      if (result?.success) {
        broadcast('execution',{chain:opp.chainName,profit:result.profitUSDC})
        await checkAutoWithdraw().catch(()=>{})
        // Cascade: re-check same collateral positions immediately
        setConfig(`cascade_trigger_${opp.chainName}`, Date.now())
      }
    } catch(e){ console.error('Queue error:',e.message) }
    finally { busy = false }
  }, 500)

  startScanner(enqueue)
  console.log('Engine started — scanning all chains')
}

process.on('uncaughtException',  e=>console.error('Uncaught:',e.message))
process.on('unhandledRejection', e=>console.error('Rejection:',String(e).slice(0,200)))
process.on('SIGTERM', ()=>{ console.log('SIGTERM'); process.exit(0) })
