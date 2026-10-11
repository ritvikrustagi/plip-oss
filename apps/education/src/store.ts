/**
 * The same tiny external store Plip's macOS UI uses (ui/src/bridge.ts): a value,
 * a set of listeners, and useSyncExternalStore. No state library, so the whole
 * app is one `npm install` on a school network.
 */
import { useSyncExternalStore } from 'react'

type Listener = () => void

export class Store<T extends object> {
  private value: T
  private listeners = new Set<Listener>()

  constructor(initial: T) {
    this.value = initial
  }

  get = () => this.value

  set = (patch: Partial<T> | ((current: T) => Partial<T>)) => {
    const next = typeof patch === 'function' ? patch(this.value) : patch
    this.value = { ...this.value, ...next }
    this.listeners.forEach((listener) => listener())
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
