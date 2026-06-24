// X7-SV · events.js — standalone EventEmitter
// Imported by ALL files that need emit/on — eliminates circular imports
// index.js no longer exports these — every file imports from here directly

import { EventEmitter } from 'events'

const bus = new EventEmitter()
bus.setMaxListeners(200)

export const emit = (event, data) => bus.emit(event, data)
export const on   = (event, fn)   => bus.on(event, fn)
export const off  = (event, fn)   => bus.off(event, fn)
export const once = (event, fn)   => bus.once(event, fn)
