// X7-SV · compiler.js — compile X7.sol on boot using solc (pure JS)

import { readFileSync, existsSync } from 'fs'
import { createRequire }            from 'module'
import { join, dirname }            from 'path'
import { fileURLToPath }            from 'url'

const __dir  = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let _artifact = null

export async function compile() {
  if (_artifact) return _artifact

  const solPath = join(__dir, '../contracts/X7.sol')
  if (!existsSync(solPath)) {
    console.error('[COMPILER] X7.sol not found at', solPath)
    return null
  }

  try {
    const solc   = require('solc')
    const source = readFileSync(solPath, 'utf8')

    const input = {
      language: 'Solidity',
      sources:  { 'X7.sol': { content: source } },
      settings: {
        viaIR:           true,                // fixes "Stack too deep" on 10-param functions
        optimizer:       { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
      }
    }

    console.log('[COMPILER] Compiling X7.sol via IR...')
    const output = JSON.parse(solc.compile(JSON.stringify(input)))

    // Split warnings from errors — warnings are fine, errors block us
    const errors   = (output.errors || []).filter(e => e.severity === 'error')
    const warnings = (output.errors || []).filter(e => e.severity === 'warning')

    if (warnings.length) {
      warnings.forEach(w => console.warn('[COMPILER] Warning:', w.formattedMessage?.slice(0, 100)))
    }

    if (errors.length) {
      errors.forEach(e => console.error('[COMPILER] Error:', e.formattedMessage?.slice(0, 120)))
      return null
    }

    const contracts = output.contracts?.['X7.sol']
    if (!contracts) {
      console.error('[COMPILER] No contracts in output')
      return null
    }

    const contract = contracts['X7']
    if (!contract) {
      console.error('[COMPILER] X7 contract not found in output. Found:', Object.keys(contracts).join(', '))
      return null
    }

    const bytecodeObj = contract.evm?.bytecode?.object
    if (!bytecodeObj || bytecodeObj.length < 10) {
      console.error('[COMPILER] Empty bytecode — check X7.sol for abstract functions')
      return null
    }

    _artifact = {
      abi:      contract.abi,
      bytecode: '0x' + bytecodeObj
    }

    const sizeBytes = Math.round(bytecodeObj.length / 2)
    const sizeKB    = (sizeBytes / 1024).toFixed(1)

    // EIP-170 contract size limit is 24576 bytes
    if (sizeBytes > 24576) {
      console.warn(`[COMPILER] Contract size ${sizeKB}KB exceeds 24KB EIP-170 limit — deployment will fail`)
      console.warn('[COMPILER] Reduce runs: 200 → 1, or split contract')
    }

    console.log(`[COMPILER] ✓ X7.sol compiled — ${sizeBytes} bytes (${sizeKB}KB) · ${contract.abi.length} ABI entries`)
    return _artifact

  } catch (e) {
    console.error('[COMPILER] Fatal:', e.message)
    // If solc itself fails to load
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error('[COMPILER] solc not installed — run: npm install solc')
    }
    return null
  }
}

export const getArtifact = () => _artifact
