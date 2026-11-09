// Coleta periódica dos dados (polling) com proteção contra chamadas sobrepostas.
// Containers/estatísticas a cada 2-3s, Colima a cada 5s, imagens/volumes/disco a cada 15s.
import { useEffect, useRef, useState, useCallback } from "react"
import type { Backend, Machine, Container, Image, Stat, Volume, DiskUsage } from "./backend/types"

export const HISTORY = 90 // amostras guardadas por container (~4 min)

export interface DashData {
  profiles: Machine[]
  containers: Container[]
  stats: Record<string, Stat>
  hist: Record<string, { cpu: number[]; mem: number[] }>
  total: { cpu: number[]; mem: number[] }
  images: Image[]
  volumes: Volume[]
  disk: DiskUsage[]
  dockerErr: string | null
  vmErr: string | null
  loaded: boolean
  updatedAt: Date | null
}

const push = (arr: number[], v: number) => {
  arr.push(v)
  if (arr.length > HISTORY) arr.shift()
}

export function useDashData(backend: Backend) {
  const [, force] = useState(0)
  const rerender = useCallback(() => force((n) => (n + 1) % 1e9), [])
  const d = useRef<DashData>({
    profiles: [], containers: [], stats: {}, hist: {}, total: { cpu: [], mem: [] },
    images: [], volumes: [], disk: [], dockerErr: null, vmErr: null, loaded: false, updatedAt: null,
  }).current
  const inflight = useRef<Record<string, boolean>>({})

  const poll = useCallback(async (key: string, fn: () => Promise<void>) => {
    if (inflight.current[key]) return
    inflight.current[key] = true
    try { await fn() } finally { inflight.current[key] = false; rerender() }
  }, [rerender])

  const loadContainers = useCallback(() => poll("containers", async () => {
    try {
      d.containers = await backend.containers()
      d.dockerErr = null
      d.updatedAt = new Date()
    } catch (e: any) {
      d.dockerErr = e.message
      d.containers = []
    }
    d.loaded = true
  }), [backend, poll])

  const loadStats = useCallback(() => poll("stats", async () => {
    try {
      const list = await backend.stats()
      const next: Record<string, Stat> = {}
      let cpu = 0, mem = 0
      for (const s of list) {
        next[s.id] = s
        const h = (d.hist[s.id] ??= { cpu: [], mem: [] })
        push(h.cpu, s.cpu)
        push(h.mem, s.memUsed)
        cpu += s.cpu
        mem += s.memUsed
      }
      d.stats = next
      push(d.total.cpu, cpu)
      push(d.total.mem, mem)
    } catch {
      d.stats = {}
    }
  }), [backend, poll])

  const loadMachines = useCallback(() => poll("machines", async () => {
    try {
      d.profiles = await backend.machines()
      d.vmErr = null
    } catch (e: any) {
      d.vmErr = e.message
    }
  }), [backend, poll])

  const loadSlow = useCallback(() => poll("slow", async () => {
    const [imgs, vols, disk] = await Promise.allSettled([backend.images(), backend.volumes(), backend.diskUsage()])
    if (imgs.status === "fulfilled") d.images = imgs.value
    if (vols.status === "fulfilled") d.volumes = vols.value
    if (disk.status === "fulfilled") d.disk = disk.value
  }), [backend, poll])

  const refreshAll = useCallback(() => {
    loadContainers(); loadStats(); loadMachines(); loadSlow()
  }, [loadContainers, loadStats, loadMachines, loadSlow])

  useEffect(() => {
    refreshAll()
    const timers = [
      setInterval(loadContainers, 2000),
      setInterval(loadStats, 2500),
      setInterval(loadMachines, 5000),
      setInterval(loadSlow, 15000),
    ]
    return () => timers.forEach(clearInterval)
  }, [refreshAll, loadContainers, loadStats, loadMachines, loadSlow])

  /** estatística de um container pelo ID (docker stats usa o ID curto) */
  const statFor = (id: string): Stat | undefined => d.stats[id] ?? d.stats[id?.slice(0, 12)]
  const histFor = (id: string) => d.hist[id] ?? d.hist[id?.slice(0, 12)] ?? { cpu: [], mem: [] }

  return { d, refreshAll, statFor, histFor, rerender }
}
