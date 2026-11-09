// @ts-nocheck
// Dashboard de containers (Docker + Colima ou Podman + podman machine). Um único handler de teclado decide o que fazer conforme o "modo"
// (normal, filtro, prompt, confirmação, logs, ajuda) e a aba ativa.
import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useTerminalDimensions, useRenderer } from "@gridland/utils"
import type { Backend, Container, PruneKind } from "./backend/types"
import { useDashData } from "./useDashData"
import { fmtBytes, pad, padL, trunc, spark, bar, parsePorts, fmtPorts, scrollStart, clamp, strWidth, parseSize } from "./lib/format"

export const T = {
  bg: "#0e1117",
  border: "#2b3245",
  focus: "#5ea8ff",
  text: "#d6deeb",
  muted: "#7a8499",
  dim: "#4b5468",
  green: "#3ddc84",
  yellow: "#ffcc4d",
  red: "#ff5c7a",
  blue: "#5ea8ff",
  cyan: "#4fd6ff",
  purple: "#b18cff",
  selBg: "#1d2a44",
}

const TABS = ["Containers", "Imagens", "Volumes", "Sistema"]

const STATE: Record<string, [string, string]> = {
  running: ["●", T.green],
  paused: ["◐", T.yellow],
  restarting: ["↻", T.blue],
  created: ["○", T.muted],
  exited: ["○", T.dim],
  dead: ["✕", T.red],
  removing: ["…", T.yellow],
}
const stateIcon = (s: string) => STATE[s] ?? ["?", T.muted]
const cpuColor = (v: number) => (v > 80 ? T.red : v > 40 ? T.yellow : T.green)

const HELP: Record<number, [string, string][]> = {
  0: [["s", "start/stop"], ["r", "restart"], ["p", "pausar"], ["d", "remover"], ["l", "logs"], ["e", "copiar exec"], ["o", "abrir porta"], ["a", "todos/rodando"]],
  1: [["n", "pull"], ["d", "remover"], ["P", "prune <none>"]],
  2: [["d", "remover"], ["P", "prune não usados"]],
  3: [["S", "start VM"], ["X", "stop VM"], ["R", "restart VM"], ["P", "system prune"], ["B", "limpar build cache"]],
}
// ---------- limpeza ----------
// Regra de segurança: containers e imagens são removidos por LISTA EXPLÍCITA (exatamente o que o
// painel mostra), um a um e sem -f. Nada que esteja rodando pode ser removido. Containers ficam
// desmarcados por padrão, e os que pararam com erro (ex.: Exited (255) quando a VM cai) são um item
// separado, porque quase sempre são containers que você quer de volta.
type CleanKind = "ctr-ok" | "ctr-err" | "dangling" | "images" | "networks" | "builder" | "volumes"
interface CleanItem { key: CleanKind; label: string; on: boolean; danger?: boolean; warn?: boolean }
const CLEAN_ITEMS: CleanItem[] = [
  { key: "dangling", label: "Imagens <none> (sem tag)", on: true },
  { key: "networks", label: "Redes não usadas", on: true },
  { key: "builder", label: "Build cache", on: true },
  { key: "images", label: "Imagens sem nenhum container", on: false },
  { key: "ctr-ok", label: "Containers parados normalmente", on: false },
  { key: "ctr-err", label: "Containers que pararam com erro", on: false, warn: true },
  { key: "volumes", label: "Volumes sem container (apaga dados!)", on: false, danger: true },
]
const SAFE_KEYS = new Set<CleanKind>(["dangling", "networks", "builder"])
const cleanItemsFor = (b: Backend) => CLEAN_ITEMS.filter((i) => !(i.key === "builder" && b.unsupported?.includes("builder")))
const sumSize = (rows: { size: number }[] | null) => (rows ?? []).reduce((a, r) => a + (r.size || 0), 0)

const STOPPED = new Set(["exited", "created", "dead"])
const stoppedOk = (c: Container) => STOPPED.has(c.state) && (c.exitCode === 0 || c.exitCode == null) && c.state !== "dead"
const stoppedErr = (c: Container) => STOPPED.has(c.state) && !stoppedOk(c)

/** o que cada item vai remover, calculado a partir dos dados atuais */
function cleanTargets(d) {
  const inUse = (img) => d.containers.some((c) => c.image === `${img.repo}:${img.tag}` || (img.tag === "latest" && c.image === img.repo) || c.image.startsWith(img.id))
  const usedVols = new Set(d.containers.flatMap((c) => (c.mounts || "").split(",").map((s) => s.trim())))
  return {
    "ctr-ok": d.containers.filter(stoppedOk),
    "ctr-err": d.containers.filter(stoppedErr),
    dangling: d.images.filter((i) => i.repo === "<none>"),
    images: d.images.filter((i) => i.repo !== "<none>" && !inUse(i)),
    volumes: d.volumes.filter((v) => (v.users ? v.users.length === 0 : !usedVols.has(v.name))),
  }
}
const ctrLabel = (c: Container) => `${c.name}${c.project ? ` [${c.project}]` : ""}${c.exitCode != null && c.exitCode !== 0 ? ` (${c.exitCode})` : ""}`

/** atalhos da aba, sem os que o motor atual não suporta */
const helpFor = (tab: number, backend: Backend) =>
  HELP[tab].filter(([k]) => !(k === "B" && backend.unsupported?.includes("builder")))
export const engineTitle = (b: Backend) => (b.engine === "podman" ? "Podman" : "Docker")
const GLOBAL_HELP: [string, string][] = [["1-4/tab", "aba"], ["C", "limpeza"], ["E", "trocar motor"], ["↑↓", "mover"], ["/", "filtrar"], ["u", "atualizar/redesenhar"], ["?", "ajuda"], ["q", "sair"]]

/** useState + ref sempre atualizada: o handler de teclado lê o valor mais recente
 *  mesmo quando várias teclas chegam antes do próximo render. */
function useRefState<V>(init: V) {
  const [v, setV] = useState<V>(init)
  const r = useRef<V>(v)
  const set = (nv: V | ((prev: V) => V)) => {
    r.current = typeof nv === "function" ? (nv as any)(r.current) : nv
    setV(r.current)
  }
  return [v, set, r] as const
}

// ---------- primitivos de layout ----------

function Panel({ title, children, focused = false, ...rest }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={focused ? T.focus : T.border}
      title={title ? ` ${title} ` : undefined}
      flexDirection="column"
      paddingX={1}
      {...rest}
    >
      {children}
    </box>
  )
}

/** Uma linha de tabela: cada célula é [texto, largura, cor, alinhamento?]. Preenche até `width`. */
function Row({ cells, width, selected = false, bold = false }) {
  let used = 0
  const spans = cells.map(([text, w, color, align], i) => {
    const s = (align === "right" ? padL(String(text), w) : pad(String(text), w)) + (i < cells.length - 1 ? " " : "")
    used += strWidth(s)
    return <span key={i} style={{ fg: color ?? T.text, bold }}>{s}</span>
  })
  if (used < width) spans.push(<span key="fill">{" ".repeat(width - used)}</span>)
  return <text style={selected ? { bg: T.selBg } : undefined}>{spans}</text>
}

function Line({ children, color = T.text }) {
  return <text style={{ fg: color }}>{children}</text>
}

function Empty({ text, color = T.muted }) {
  return <text style={{ fg: color }}>{text}</text>
}

// ---------- componente principal ----------

export function DockerDash({ backend, onExit, onSwitchEngine }: { backend: Backend; onExit?: () => void; onSwitchEngine?: () => void }) {
  const { width, height } = useTerminalDimensions()
  const { d, refreshAll, statFor, histFor } = useDashData(backend)
  const renderer = useRenderer()

  /** limpa o terminal e força o renderer a redesenhar tudo (útil se algo sujar a tela) */
  const fullRedraw = () => {
    try {
      const r: any = renderer
      if (r?.lib?.clearTerminal && r?.rendererPtr) r.lib.clearTerminal(r.rendererPtr)
      r?.requestRender?.()
    } catch {}
  }

  const [tab, setTab, tabR] = useRefState(0)
  const [sel, setSel, selR] = useRefState([0, 0, 0, 0])
  const [showAll, setShowAll] = useState(true)
  const [filter, setFilter, filterR] = useRefState("")
  const [mode, setMode, modeR] = useRefState<"normal" | "filter" | "prompt" | "confirm" | "logs" | "help" | "cleanup">("normal")
  const [clean, setClean, cleanR] = useRefState<{ sel: number; on: Record<string, boolean>; running: boolean }>({
    sel: 0,
    on: Object.fromEntries(CLEAN_ITEMS.map((i) => [i.key, i.on])),
    running: false,
  })
  const [prompt, setPrompt, promptR] = useRefState<{ label: string; value: string; onSubmit: (v: string) => void } | null>(null)
  const [confirm, setConfirm, confirmR] = useRefState<{ text: string; label: string; fn: () => Promise<string> } | null>(null)
  const [msg, setMsg] = useState<{ text: string; kind: "info" | "ok" | "err" | "busy" }>({ text: "", kind: "info" })
  const [logs, setLogs] = useState<{ id: string | null; lines: string[] }>({ id: null, lines: [] })
  const [logScroll, setLogScroll] = useState(0) // linhas acima do fim; 0 = seguindo

  // ----- listas filtradas -----
  const f = filter.toLowerCase()
  const match = (s: string) => !f || s.toLowerCase().includes(f)
  const containers = d.containers
    .filter((c) => (showAll || c.state === "running") && match(`${c.name} ${c.image}`))
    .sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || a.name.localeCompare(b.name))
  const images = d.images.filter((i) => match(`${i.repo}:${i.tag} ${i.id}`))
  const volumes = d.volumes.filter((v) => match(v.name))
  const lists = [containers, images, volumes, d.profiles]
  const curSel = (t: number) => clamp(selR.current[t], 0, Math.max(0, lists[t].length - 1))
  const selected = lists[tab][curSel(tab)]
  const selContainer: Container | undefined = containers[curSel(0)]

  const setSelFor = (t: number, fn: (v: number) => number) =>
    setSel((s) => s.map((v, i) => (i === t ? clamp(fn(clamp(v, 0, Math.max(0, lists[t].length - 1))), 0, Math.max(0, lists[t].length - 1)) : v)))

  // ----- logs do container selecionado -----
  const wantLogs = tab === 0 && !!selContainer
  const logId = selContainer?.id
  useEffect(() => {
    if (!wantLogs || !logId) return
    let alive = true
    const load = async () => {
      try {
        const lines = await backend.logs(logId, 500)
        if (alive) setLogs({ id: logId, lines })
      } catch (e: any) {
        if (alive) setLogs({ id: logId, lines: [`(erro ao ler logs: ${e.message})`] })
      }
    }
    load()
    const t = setInterval(load, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [wantLogs, logId, backend])

  // ----- execução de ações -----
  const run = async (label: string, fn: () => Promise<string>) => {
    setMsg({ text: `⏳ ${label}…`, kind: "busy" })
    try {
      const out = await fn()
      setMsg({ text: `✓ ${label}${out ? ` · ${trunc(out.replace(/\s+/g, " "), 120)}` : ""}`, kind: "ok" })
    } catch (e: any) {
      setMsg({ text: `✗ ${label}: ${e.message}`, kind: "err" })
    } finally {
      refreshAll()
    }
  }
  const ask = (text: string, label: string, fn: () => Promise<string>) => {
    setConfirm({ text, label, fn })
    setMode("confirm")
  }

  /** roda a limpeza. `snap` é exatamente o que o usuário viu no painel no momento do enter. */
  const runCleanup = async (snap: { keys: CleanKind[]; ctrIds: string[]; imgIds: string[] }) => {
    setMode("normal")
    if (!snap.keys.length) return setMsg({ text: "nada selecionado para limpar", kind: "info" })
    setClean((c) => ({ ...c, running: true }))
    const before = await backend.diskUsage().catch(() => null)
    const errors: string[] = []
    let removedCtr = 0, removedImg = 0, skipped = 0
    const steps: [string, () => Promise<void>][] = []

    if (snap.ctrIds.length) steps.push(["containers selecionados", async () => {
      // confere de novo o estado real: só remove o que AINDA está parado e estava na lista mostrada
      const fresh = await backend.containers()
      const stillStopped = new Set(fresh.filter((c) => STOPPED.has(c.state)).map((c) => c.id))
      const ids = snap.ctrIds.filter((id) => stillStopped.has(id))
      skipped += snap.ctrIds.length - ids.length
      const r = await backend.removeContainers(ids)
      removedCtr += r.removed.length
      r.failed.forEach((f) => errors.push(f.error))
    }])
    if (snap.keys.includes("dangling")) steps.push(["imagens <none>", async () => { await backend.prune("images") }])
    if (snap.imgIds.length) steps.push(["imagens sem container", async () => {
      const r = await backend.removeImages(snap.imgIds)
      removedImg += r.removed.length
      r.failed.forEach((f) => errors.push(f.error))
    }])
    if (snap.keys.includes("networks")) steps.push(["redes", async () => { await backend.prune("networks") }])
    if (snap.keys.includes("builder")) steps.push(["build cache", async () => { await backend.prune("builder") }])
    if (snap.keys.includes("volumes")) steps.push(["volumes", async () => { await backend.prune("volumes") }])

    for (let i = 0; i < steps.length; i++) {
      setMsg({ text: `🧹 limpeza ${i + 1}/${steps.length}: ${steps[i][0]}…`, kind: "busy" })
      try { await steps[i][1]() } catch (e: any) { errors.push(`${steps[i][0]}: ${e.message}`) }
    }
    const after = await backend.diskUsage().catch(() => null)
    const freed = before && after ? Math.max(0, sumSize(before) - sumSize(after)) : null
    setClean((c) => ({ ...c, running: false }))
    const parts = [
      freed !== null ? `${fmtBytes(freed)} liberados` : "",
      removedCtr ? `${removedCtr} container(s)` : "",
      removedImg ? `${removedImg} imagem(ns)` : "",
      skipped ? `${skipped} pulado(s) porque voltaram a rodar` : "",
    ].filter(Boolean).join(" · ")
    if (errors.length) setMsg({ text: `✗ limpeza com ${errors.length} aviso(s) · ${parts} · ${errors[0]}`, kind: "err" })
    else setMsg({ text: `✓ limpeza concluída · ${parts || "nada a remover"}`, kind: "ok" })
    refreshAll()
  }

  /** enter no painel: monta o snapshot e, se houver containers, pede confirmação listando os nomes */
  const startCleanup = () => {
    const items = cleanItemsFor(backend).filter((i) => cleanR.current.on[i.key])
    const t = cleanTargets(d)
    const keys = items.map((i) => i.key)
    const ctrs = [...(keys.includes("ctr-ok") ? t["ctr-ok"] : []), ...(keys.includes("ctr-err") ? t["ctr-err"] : [])]
    const imgs = keys.includes("images") ? t.images : []
    const snap = { keys, ctrIds: ctrs.map((c) => c.id), imgIds: imgs.map((i) => i.id) }
    if (ctrs.length || keys.includes("volumes")) {
      const names = ctrs.map(ctrLabel)
      const shown = names.slice(0, 8).join(", ") + (names.length > 8 ? ` e mais ${names.length - 8}` : "")
      const text = [
        ctrs.length ? `Remover ${ctrs.length} container(s): ${shown}.` : "",
        ctrs.some(stoppedErr) ? "Alguns pararam com erro e provavelmente estavam rodando antes de uma queda." : "",
        keys.includes("volumes") ? "Volumes sem container também serão APAGADOS com seus dados." : "",
        "Isso não pode ser desfeito. Continuar?",
      ].filter(Boolean).join(" ")
      setConfirm({ text, label: "limpeza", fn: async () => { await runCleanup(snap); return "" } })
      setMode("confirm")
      return
    }
    runCleanup(snap)
  }

  const profile = d.profiles.find((p) => p.status === "Running") ?? d.profiles.find((p) => p.name === "default") ?? d.profiles[0]
  const selProfile = d.profiles[curSel(3)] ?? profile

  // ----- teclado -----
  useKeyboard((e) => {
    const k = e.name
    const mode = modeR.current
    const filter = filterR.current
    const prompt = promptR.current
    const confirm = confirmR.current
    const tab = tabR.current
    let ch = e.sequence && e.sequence.length === 1 ? e.sequence : null
    if (ch === "/" && e.shift) ch = "?" // alguns teclados/navegadores reportam shift+/

    if (mode === "confirm") {
      if (k === "y" || k === "return") {
        const c = confirm
        setConfirm(null)
        setMode("normal")
        if (c?.label === "limpeza") c.fn() // a limpeza mostra o próprio resumo
        else if (c) run(c.label, c.fn)
      } else if (k === "n" || k === "escape" || k === "q") {
        setConfirm(null)
        setMode("normal")
        setMsg({ text: "cancelado", kind: "info" })
      }
      return
    }

    if (mode === "filter" || mode === "prompt") {
      const set = (fn: (v: string) => string) => (mode === "filter" ? setFilter(fn) : setPrompt((p) => (p ? { ...p, value: fn(p.value) } : p)))
      if (k === "escape") {
        if (mode === "filter") setFilter("")
        setPrompt(null)
        setMode("normal")
      } else if (k === "return") {
        if (mode === "prompt" && prompt) {
          const p = prompt
          setPrompt(null)
          setMode("normal")
          if (p.value.trim()) p.onSubmit(p.value.trim())
        } else setMode("normal")
      } else if (k === "backspace") set((v) => v.slice(0, -1))
      else if (ch && ch >= " " && ch !== "\x7f") set((v) => v + ch)
      return
    }

    if (mode === "cleanup") {
      const items = cleanItemsFor(backend)
      if (k === "escape" || k === "q") setMode("normal")
      else if (k === "up") setClean((c) => ({ ...c, sel: (c.sel - 1 + items.length) % items.length }))
      else if (k === "down") setClean((c) => ({ ...c, sel: (c.sel + 1) % items.length }))
      else if (k === "space" || ch === " ") {
        const it = items[cleanR.current.sel]
        if (it) setClean((c) => ({ ...c, on: { ...c.on, [it.key]: !c.on[it.key] } }))
      } else if (ch === "a") setClean((c) => ({ ...c, on: Object.fromEntries(items.map((i) => [i.key, SAFE_KEYS.has(i.key)])) }))
      else if (k === "return" && !cleanR.current.running) startCleanup()
      return
    }

    if (mode === "help") {
      setMode("normal")
      return
    }

    if (mode === "logs") {
      const page = Math.max(1, height - 6)
      if (k === "escape" || k === "l" || k === "q") setMode("normal")
      else if (k === "up") setLogScroll((s) => s + 1)
      else if (k === "down") setLogScroll((s) => Math.max(0, s - 1))
      else if (k === "pageup") setLogScroll((s) => s + page)
      else if (k === "pagedown") setLogScroll((s) => Math.max(0, s - page))
      else if (k === "end" || k === "f") setLogScroll(0)
      else if (k === "home") setLogScroll(1e9)
      return
    }

    // ----- modo normal -----
    if (k === "q" && !e.shift) return onExit?.()
    if (ch === "?") return setMode("help")
    if (ch === "E" && onSwitchEngine) return onSwitchEngine()
    if (ch === "C") {
      if (cleanR.current.running) return setMsg({ text: "limpeza já em andamento…", kind: "busy" })
      setMode("cleanup")
      return
    }
    if (ch === "/") { setMode("filter"); return }
    if (k === "escape" && filter) { setFilter(""); return }
    if (k === "tab") { setTab((t) => (t + (e.shift ? 3 : 1)) % 4); return }
    if (ch && "1234".includes(ch)) { setTab(+ch - 1); return }
    if (k === "up") return setSelFor(tab, (v) => v - 1)
    if (k === "down") return setSelFor(tab, (v) => v + 1)
    if (k === "pageup") return setSelFor(tab, (v) => v - 10)
    if (k === "pagedown") return setSelFor(tab, (v) => v + 10)
    if (k === "home") return setSelFor(tab, () => 0)
    if (k === "end") return setSelFor(tab, () => 1e9)
    if (ch === "u" || (k === "l" && e.ctrl)) { refreshAll(); fullRedraw(); setMsg({ text: "atualizado", kind: "info" }); return }

    if (tab === 0) {
      if (ch === "a") { setShowAll((v) => !v); return }
      const c = containers[curSel(0)]
      if (!c) return
      if (ch === "s") {
        const action = c.state === "running" || c.state === "paused" ? "stop" : "start"
        run(`${action} ${c.name}`, () => backend.containerAction(action, c.id))
      } else if (ch === "r") run(`restart ${c.name}`, () => backend.containerAction("restart", c.id))
      else if (ch === "p") {
        if (c.state === "paused") run(`unpause ${c.name}`, () => backend.containerAction("unpause", c.id))
        else if (c.state === "running") run(`pause ${c.name}`, () => backend.containerAction("pause", c.id))
      } else if (ch === "d") {
        ask(`Remover o container "${c.name}"${c.state === "running" ? " (está rodando, será forçado)" : ""}?`, `remover ${c.name}`, () => backend.containerAction("rm", c.id))
      } else if (ch === "l") { setLogScroll(0); setMode("logs") }
      else if (ch === "e") {
        const cmd = `${backend.cli} exec -it ${c.name} sh`
        backend.copy(cmd).then(
          () => setMsg({ text: `✓ copiado: ${cmd}  (cole no terminal)`, kind: "ok" }),
          (err) => setMsg({ text: `✗ não consegui copiar: ${err.message}`, kind: "err" }),
        )
      } else if (ch === "o") {
        const port = parsePorts(c.ports)[0]
        if (!port) setMsg({ text: `${c.name} não publica nenhuma porta`, kind: "info" })
        else {
          const url = `http://localhost:${port.host}`
          backend.openUrl(url).then(() => setMsg({ text: `✓ abrindo ${url}`, kind: "ok" }), (err) => setMsg({ text: `✗ ${err.message}`, kind: "err" }))
        }
      }
    } else if (tab === 1) {
      const img = images[curSel(1)]
      if (ch === "n") {
        setPrompt({ label: "pull imagem", value: "", onSubmit: (ref) => run(`pull ${ref}`, () => backend.pull(ref)) })
        setMode("prompt")
      } else if (ch === "d" && img) {
        const ref = img.repo === "<none>" ? img.id : `${img.repo}:${img.tag}`
        ask(`Remover a imagem ${ref} (${fmtBytes(img.size)})?`, `remover ${ref}`, () => backend.removeImage(img.repo === "<none>" ? img.id : ref))
      } else if (ch === "P") ask("Remover todas as imagens <none> (dangling)?", "image prune", () => backend.prune("images"))
    } else if (tab === 2) {
      const v = volumes[curSel(2)]
      if (ch === "d" && v) ask(`Remover o volume "${v.name}"? Os dados serão perdidos.`, `remover volume ${v.name}`, () => backend.removeVolume(v.name))
      else if (ch === "P") ask("Remover TODOS os volumes não usados por nenhum container? Os dados serão perdidos.", "volume prune", () => backend.prune("volumes"))
    } else if (tab === 3) {
      const p = d.profiles[curSel(3)] ?? profile
      const vm = backend.vmName
      if (ch === "S" && p) run(`${vm} start ${p.name}`, () => backend.machineAction("start", p.name))
      else if (ch === "X" && p) ask(`Parar ${vm} "${p.name}"? Todos os containers dela vão parar.`, `${vm} stop ${p.name}`, () => backend.machineAction("stop", p.name))
      else if (ch === "R" && p) ask(`Reiniciar ${vm} "${p.name}"?`, `${vm} restart ${p.name}`, () => backend.machineAction("restart", p.name))
      else if (ch === "P") ask("docker system prune: remove containers parados, redes sem uso, imagens <none> e build cache. Continuar?", "system prune", () => backend.prune("system"))
      else if (ch === "B" && !backend.unsupported?.includes("builder")) ask("Limpar todo o build cache do Docker?", "builder prune", () => backend.prune("builder"))
    }
  })

  // ----- layout -----
  const bodyH = Math.max(6, height - 4) // header + abas + mensagem + atalhos
  const running = d.containers.filter((c) => c.state === "running").length
  const stopped = d.containers.length - running
  const totCpu = d.total.cpu[d.total.cpu.length - 1] ?? 0
  const totMem = d.total.mem[d.total.mem.length - 1] ?? 0
  const clock = d.updatedAt ? d.updatedAt.toTimeString().slice(0, 8) : "--:--:--"

  let body
  if (mode === "logs" && selContainer) body = <LogsView c={selContainer} lines={logs.id === selContainer.id ? logs.lines : []} w={width} h={bodyH} scroll={logScroll} />
  else if (d.dockerErr && tab !== 3) body = <DockerDown err={d.dockerErr} w={width} h={bodyH} profile={profile} backend={backend} />
  else if (tab === 0) body = <ContainersView list={containers} sel={curSel(0)} w={width} h={bodyH} statFor={statFor} histFor={histFor} logs={logs.id === selContainer?.id ? logs.lines : []} showAll={showAll} loaded={d.loaded} />
  else if (tab === 1) body = <ImagesView list={images} sel={curSel(1)} w={width} h={bodyH} containers={d.containers} />
  else if (tab === 2) body = <VolumesView list={volumes} sel={curSel(2)} w={width} h={bodyH} containers={d.containers} />
  else body = <SystemView d={d} sel={curSel(3)} w={width} h={bodyH} backend={backend} />

  const help = mode === "logs"
    ? [["↑↓/pgup/pgdn", "rolar"], ["f/end", "seguir"], ["esc/l", "voltar"]]
    : mode === "cleanup"
    ? [["↑↓", "mover"], ["espaço", "marcar"], ["a", "só o seguro"], ["enter", "limpar"], ["esc", "cancelar"]]
    : [...helpFor(tab, backend), ...GLOBAL_HELP.filter(([k]) => k !== "E" || onSwitchEngine)]

  const msgColor = { info: T.muted, ok: T.green, err: T.red, busy: T.yellow }[msg.kind]

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={T.bg}>
      {/* cabeçalho */}
      <Header backend={backend} profile={profile} d={d} width={width} running={running} stopped={stopped} totCpu={totCpu} totMem={totMem} clock={clock} />

      {/* abas */}
      <text>
        <span> </span>
        {TABS.map((t, i) => {
          const count = i === 0 ? d.containers.length : i === 1 ? d.images.length : i === 2 ? d.volumes.length : d.profiles.length
          return (
            <span key={t} style={i === tab ? { fg: T.bg, bg: T.focus, bold: true } : { fg: T.muted }}>{` ${i + 1} ${t} ${count} `}</span>
          )
        })}
        {mode === "filter" || filter ? (
          <span style={{ fg: T.yellow }}>{`   / ${filter}${mode === "filter" ? "▏" : ""}`}</span>
        ) : null}
        {tab === 0 && !showAll ? <span style={{ fg: T.cyan }}>   só rodando</span> : null}
      </text>

      {/* corpo */}
      <box height={bodyH} width={width} flexDirection="column">{body}</box>

      {/* mensagem / prompt */}
      <text>
        {mode === "prompt" && prompt ? (
          <>
            <span style={{ fg: T.cyan, bold: true }}>{` ${prompt.label}: `}</span>
            <span style={{ fg: T.text }}>{prompt.value}</span>
            <span style={{ fg: T.focus }}>▏</span>
            <span style={{ fg: T.dim }}>   enter confirma · esc cancela</span>
          </>
        ) : (
          <span style={{ fg: msgColor }}>{` ${trunc(msg.text, width - 2)}`}</span>
        )}
      </text>

      {/* atalhos (cortados para caber em uma linha) */}
      <text>{fitHelp(help, width)}</text>

      {mode === "confirm" && confirm ? <ConfirmModal text={confirm.text} w={width} h={height} /> : null}
      {mode === "cleanup" ? <CleanupModal d={d} backend={backend} state={clean} w={width} h={height} /> : null}
      {mode === "help" ? <HelpModal w={width} h={height} backend={backend} /> : null}
    </box>
  )
}

// ---------- views ----------

function ContainersView({ list, sel, w, h, statFor, histFor, logs, showAll, loaded }) {
  const split = w >= 118
  const leftW = split ? Math.floor(w * 0.55) : w
  const inner = leftW - 4
  const rows = Math.max(1, h - 3)
  const start = scrollStart(sel, list.length, rows)

  // colunas: ícone, nome, imagem, cpu, mem, portas, status
  const fixed = 2 + 7 + 9 + 6 // ícone + cpu + mem + espaços
  const flex = Math.max(20, inner - fixed)
  const nameW = Math.floor(flex * 0.26)
  const imgW = Math.floor(flex * 0.28)
  const portW = Math.floor(flex * 0.2)
  const statusW = Math.max(4, flex - nameW - imgW - portW)

  const c = list[sel]
  return (
    <box flexDirection="row" width={w} height={h}>
      <Panel title={`Containers ${showAll ? "" : "(rodando) "}· ${list.length}`} width={leftW} height={h} focused>
        <Row width={inner} bold cells={[["", 1, T.muted], ["NOME", nameW, T.muted], ["IMAGEM", imgW, T.muted], ["CPU", 7, T.muted, "right"], ["MEM", 9, T.muted, "right"], ["PORTAS", portW, T.muted], ["STATUS", statusW, T.muted]]} />
        {list.length === 0 ? (
          <Empty text={loaded ? "nenhum container" : "carregando…"} />
        ) : (
          list.slice(start, start + rows).map((ct, i) => {
            const idx = start + i
            const st = statFor(ct.id)
            const [icon, color] = stateIcon(ct.state)
            return (
              <Row
                key={ct.id}
                width={inner}
                selected={idx === sel}
                cells={[
                  [icon, 1, color],
                  [ct.name, nameW, idx === sel ? T.focus : T.text],
                  [ct.image, imgW, T.muted],
                  [st ? `${st.cpu.toFixed(1)}%` : "-", 7, st ? cpuColor(st.cpu) : T.dim, "right"],
                  [st ? fmtBytes(st.memUsed) : "-", 9, st ? T.text : T.dim, "right"],
                  [fmtPorts(ct.ports), portW, T.cyan],
                  [ct.status, statusW, ct.state === "running" ? T.muted : T.dim],
                ]}
              />
            )
          })
        )}
      </Panel>
      {split ? <ContainerDetails c={c} st={c && statFor(c.id)} hist={c ? histFor(c.id) : null} logs={logs} w={w - leftW} h={h} /> : null}
    </box>
  )
}

function ContainerDetails({ c, st, hist, logs, w, h }) {
  const inner = w - 4
  if (!c) return <Panel title="Detalhes" width={w} height={h}><Empty text="selecione um container" /></Panel>
  const [icon, color] = stateIcon(c.state)
  const sparkW = Math.max(10, inner - 22)
  const ports = parsePorts(c.ports)
  const info = [
    ["imagem", c.image],
    ["id", c.id.slice(0, 12)],
    ["comando", c.command],
    ["redes", c.networks || "-"],
    ["mounts", c.mounts || "-"],
  ]
  const lines = []
  lines.push(
    <text key="state">
      <span style={{ fg: color }}>{`${icon} ${c.state}`}</span>
      <span style={{ fg: T.muted }}>{`  ${trunc(c.status, inner - c.state.length - 4)}`}</span>
    </text>,
  )
  for (const [k, v] of info) {
    lines.push(
      <text key={k}>
        <span style={{ fg: T.dim }}>{pad(k, 9)}</span>
        <span style={{ fg: T.text }}>{trunc(v, inner - 9)}</span>
      </text>,
    )
  }
  lines.push(
    <text key="ports">
      <span style={{ fg: T.dim }}>{pad("portas", 9)}</span>
      <span style={{ fg: T.cyan }}>{trunc(ports.length ? ports.map((p) => `localhost:${p.host} → ${p.container}/${p.proto}`).join("  ") : "-", inner - 9)}</span>
    </text>,
  )
  lines.push(<text key="sp1"> </text>)
  if (st && hist) {
    lines.push(
      <text key="cpu">
        <span style={{ fg: T.dim }}>{pad("CPU", 5)}</span>
        <span style={{ fg: cpuColor(st.cpu) }}>{spark(hist.cpu, sparkW, Math.max(100, ...hist.cpu))}</span>
        <span style={{ fg: cpuColor(st.cpu), bold: true }}>{padL(`${st.cpu.toFixed(1)}%`, 8)}</span>
      </text>,
      <text key="mem">
        <span style={{ fg: T.dim }}>{pad("MEM", 5)}</span>
        <span style={{ fg: T.purple }}>{spark(hist.mem, sparkW)}</span>
        <span style={{ fg: T.purple, bold: true }}>{padL(fmtBytes(st.memUsed), 8)}</span>
        <span style={{ fg: T.dim }}>{padL(`${st.memPerc.toFixed(1)}%`, 7)}</span>
      </text>,
      <text key="io">
        <span style={{ fg: T.dim }}>{pad("REDE", 5)}</span>
        <span style={{ fg: T.text }}>{`↓ ${fmtBytes(st.netRx)}  ↑ ${fmtBytes(st.netTx)}`}</span>
        <span style={{ fg: T.dim }}>{"   DISCO "}</span>
        <span style={{ fg: T.text }}>{`r ${fmtBytes(st.blockRead)}  w ${fmtBytes(st.blockWrite)}`}</span>
        <span style={{ fg: T.dim }}>{`   PIDs ${st.pids}`}</span>
      </text>,
    )
  } else {
    lines.push(<Empty key="nostat" text={c.state === "running" ? "coletando estatísticas…" : "sem estatísticas (container parado)"} color={T.dim} />)
  }
  lines.push(<text key="sp2"> </text>)
  const used = lines.length + 1
  const logRows = Math.max(0, h - 2 - used)
  lines.push(<text key="lh" style={{ fg: T.muted, bold: true }}>{pad(`LOGS  ·  l para tela cheia`, inner)}</text>)
  const tail = logs.slice(-logRows)
  tail.forEach((l, i) => lines.push(<LogLine key={`l${i}`} line={l} width={inner} />))
  return (
    <Panel title={c.name} width={w} height={h}>
      {lines}
    </Panel>
  )
}

function logColor(l: string) {
  if (/\b(error|err|fatal|panic|exception)\b/i.test(l)) return T.red
  if (/\b(warn|warning)\b/i.test(l)) return T.yellow
  return T.muted
}
function LogLine({ line, width }) {
  return <text style={{ fg: logColor(line) }}>{pad(line, width)}</text>
}

function LogsView({ c, lines, w, h, scroll }) {
  const inner = w - 4
  const rows = Math.max(1, h - 2)
  const maxScroll = Math.max(0, lines.length - rows)
  const s = Math.min(scroll, maxScroll)
  const end = lines.length - s
  const view = lines.slice(Math.max(0, end - rows), end)
  return (
    <Panel title={`Logs · ${c.name} · ${s === 0 ? "seguindo" : `${s} linhas acima`} · ${lines.length} linhas`} width={w} height={h} focused>
      {view.length === 0 ? <Empty text="sem logs" /> : view.map((l, i) => <LogLine key={i} line={l} width={inner} />)}
    </Panel>
  )
}

function ImagesView({ list, sel, w, h, containers }) {
  const inner = w - 4
  const rows = Math.max(1, h - 4)
  const start = scrollStart(sel, list.length, rows)
  const fixed = 12 + 10 + 16 + 6 + 5
  const flex = Math.max(20, inner - fixed)
  const repoW = Math.floor(flex * 0.65)
  const tagW = flex - repoW
  const usedBy = (img) => containers.filter((c) => c.image === `${img.repo}:${img.tag}` || (img.tag === "latest" && c.image === img.repo) || c.image === img.id).length
  const total = list.reduce((a, i) => a + i.size, 0)
  const dangling = list.filter((i) => i.repo === "<none>")
  return (
    <Panel title={`Imagens · ${list.length} · ${fmtBytes(total)}`} width={w} height={h} focused>
      <Row width={inner} bold cells={[["REPOSITÓRIO", repoW, T.muted], ["TAG", tagW, T.muted], ["ID", 12, T.muted], ["TAMANHO", 10, T.muted, "right"], ["CRIADA", 16, T.muted], ["USO", 5, T.muted, "right"]]} />
      {list.length === 0 ? <Empty text="nenhuma imagem" /> : list.slice(start, start + rows).map((img, i) => {
        const idx = start + i
        const n = usedBy(img)
        const none = img.repo === "<none>"
        return (
          <Row key={img.id + img.tag + idx} width={inner} selected={idx === sel} cells={[
            [img.repo, repoW, none ? T.dim : idx === sel ? T.focus : T.text],
            [img.tag, tagW, none ? T.dim : T.cyan],
            [img.id.replace("sha256:", "").slice(0, 12), 12, T.dim],
            [fmtBytes(img.size), 10, img.size > 1024 ** 3 ? T.yellow : T.text, "right"],
            [img.created, 16, T.muted],
            [n ? `${n}` : "-", 5, n ? T.green : T.dim, "right"],
          ]} />
        )
      })}
      <box flexGrow={1} />
      <text style={{ fg: T.dim }}>{trunc(dangling.length ? `${dangling.length} imagem(ns) <none> ocupando ${fmtBytes(dangling.reduce((a, i) => a + i.size, 0))} · P para limpar` : "nenhuma imagem <none>", inner)}</text>
    </Panel>
  )
}

function VolumesView({ list, sel, w, h, containers }) {
  const inner = w - 4
  const rows = Math.max(1, h - 4)
  const start = scrollStart(sel, list.length, rows)
  const users = (v) =>
    v.users ? v.users.map((name) => ({ name })) : containers.filter((c) => (c.mounts || "").split(",").map((s) => s.trim()).includes(v.name))
  const nameW = Math.min(48, Math.floor(inner * 0.4))
  const usersW = Math.max(10, inner - nameW - 10 - 3)
  const unused = list.filter((v) => users(v).length === 0).length
  return (
    <Panel title={`Volumes · ${list.length}`} width={w} height={h} focused>
      <Row width={inner} bold cells={[["NOME", nameW, T.muted], ["DRIVER", 8, T.muted], ["USADO POR", usersW, T.muted]]} />
      {list.length === 0 ? <Empty text="nenhum volume" /> : list.slice(start, start + rows).map((v, i) => {
        const idx = start + i
        const u = users(v)
        return (
          <Row key={v.name} width={inner} selected={idx === sel} cells={[
            [v.name, nameW, idx === sel ? T.focus : T.text],
            [v.driver, 8, T.muted],
            [u.length ? u.map((c) => c.name).join(", ") : "não usado", usersW, u.length ? T.green : T.dim],
          ]} />
        )
      })}
      <box flexGrow={1} />
      <text style={{ fg: T.dim }}>{trunc(`${unused} volume(s) sem container · P remove os não usados`, inner)}</text>
    </Panel>
  )
}

function SystemView({ d, sel, w, h, backend }) {
  const inner = w - 4
  const profH = Math.min(h - 8, Math.max(4, d.profiles.length + 3))
  const restH = h - profH
  const halfW = Math.floor(w / 2)
  const sparkW = Math.max(10, halfW - 4 - 14)
  const cpuNow = d.total.cpu[d.total.cpu.length - 1] ?? 0
  const memNow = d.total.mem[d.total.mem.length - 1] ?? 0
  const prof = d.profiles.find((p) => p.status === "Running") ?? d.profiles[0]
  const memFrac = prof?.memory ? memNow / prof.memory : 0
  const cpuFrac = prof?.cpus ? cpuNow / (prof.cpus * 100) : 0
  const barW = Math.max(10, halfW - 4 - 22)

  const nameW = Math.max(8, Math.floor(inner * 0.2))
  const rtW = Math.max(11, Math.min(28, inner - nameW - 1 - 9 - 8 - 4 - 9 - 9 - 16 - 9))
  const topRows = Math.max(0, restH - 2 - 7)
  const top = Object.values(d.stats).sort((a, b) => b.cpu - a.cpu || b.memUsed - a.memUsed).slice(0, topRows)
  const topNameW = Math.max(8, halfW - 4 - 18 - 22)
  return (
    <box flexDirection="column" width={w} height={h}>
      <Panel title={backend.engine === "podman" ? "Podman · máquinas" : "Colima · perfis"} width={w} height={profH} focused>
        {d.vmErr ? <Empty text={`${backend.vmName}: ${d.vmErr}`} color={T.red} /> : null}
        <Row width={inner} bold cells={[["", 1, T.muted], [backend.engine === "podman" ? "MÁQUINA" : "PERFIL", nameW, T.muted], ["STATUS", 9, T.muted], ["RUNTIME", rtW, T.muted], ["ARCH", 8, T.muted], ["CPU", 4, T.muted, "right"], ["MEMÓRIA", 9, T.muted, "right"], ["DISCO", 9, T.muted, "right"], ["ENDEREÇO", 16, T.muted]]} />
        {d.profiles.map((p, i) => (
          <Row key={p.name} width={inner} selected={i === sel} cells={[
            [p.status === "Running" ? "●" : "○", 1, p.status === "Running" ? T.green : T.dim],
            [p.name, nameW, i === sel ? T.focus : T.text],
            [p.status, 9, p.status === "Running" ? T.green : T.muted],
            [p.runtime, rtW, T.text],
            [p.arch, 8, T.muted],
            [String(p.cpus), 4, T.text, "right"],
            [fmtBytes(p.memory, 0), 9, T.text, "right"],
            [fmtBytes(p.disk, 0), 9, T.text, "right"],
            [p.address || "-", 16, T.muted],
          ]} />
        ))}
      </Panel>
      <box flexDirection="row" width={w} height={restH}>
        <Panel title="Uso total dos containers" width={halfW} height={restH}>
          <text>
            <span style={{ fg: T.dim }}>{pad("CPU", 5)}</span>
            <span style={{ fg: cpuColor(cpuFrac * 100) }}>{spark(d.total.cpu, sparkW, Math.max(100, ...d.total.cpu))}</span>
            <span style={{ fg: cpuColor(cpuFrac * 100), bold: true }}>{padL(`${cpuNow.toFixed(1)}%`, 9)}</span>
          </text>
          <text>
            <span style={{ fg: T.dim }}>{pad("MEM", 5)}</span>
            <span style={{ fg: T.purple }}>{spark(d.total.mem, sparkW)}</span>
            <span style={{ fg: T.purple, bold: true }}>{padL(fmtBytes(memNow), 9)}</span>
          </text>
          <text> </text>
          {prof ? (
            <>
              <BarLine label="CPU da VM" frac={cpuFrac} width={barW} text={`${(cpuFrac * 100).toFixed(0)}% de ${prof.cpus}`} />
              <BarLine label="RAM da VM" frac={memFrac} width={barW} text={`${fmtBytes(memNow)}/${fmtBytes(prof.memory, 0)}`} />
            </>
          ) : null}
          <text> </text>
          <text style={{ fg: T.muted, bold: true }}>MAIORES CONSUMIDORES</text>
          {top.length === 0 ? <Empty text="nenhum container rodando" color={T.dim} /> : top.map((s) => (
            <text key={s.id}>
              <span style={{ fg: T.text }}>{pad(s.name, topNameW)}</span>
              <span style={{ fg: cpuColor(s.cpu) }}>{padL(`${s.cpu.toFixed(1)}%`, 8)}</span>
              <span style={{ fg: T.purple }}>{padL(fmtBytes(s.memUsed), 10)}</span>
              <span style={{ fg: T.dim }}>{`  ↓${fmtBytes(s.netRx)} ↑${fmtBytes(s.netTx)}`}</span>
            </text>
          ))}
        </Panel>
        <Panel title={`${engineTitle(backend)} · uso de disco`} width={w - halfW} height={restH}>
          <Row width={w - halfW - 4} bold cells={[["TIPO", 14, T.muted], ["TOTAL", 6, T.muted, "right"], ["ATIVOS", 6, T.muted, "right"], ["TAMANHO", 9, T.muted, "right"], ["RECUPERÁVEL", Math.max(8, w - halfW - 4 - 40), T.muted]]} />
          {d.disk.map((r) => (
            <Row key={r.type} width={w - halfW - 4} cells={[
              [r.type, 14, T.text],
              [String(r.total), 6, T.text, "right"],
              [String(r.active), 6, T.green, "right"],
              [fmtBytes(r.size), 9, T.text, "right"],
              [r.reclaimable, Math.max(8, w - halfW - 4 - 40), r.reclaimable.startsWith("0B") ? T.dim : T.yellow],
            ]} />
          ))}
          <box flexGrow={1} />
          <text style={{ fg: T.dim }}>{backend.unsupported?.includes("builder") ? "C limpeza completa · P system prune" : "C limpeza completa · P system prune · B build cache"}</text>
        </Panel>
      </box>
    </box>
  )
}

function BarLine({ label, frac, width, text }) {
  const [a, b] = bar(frac, width)
  const color = frac > 0.85 ? T.red : frac > 0.6 ? T.yellow : T.green
  return (
    <text>
      <span style={{ fg: T.dim }}>{pad(label, 10)}</span>
      <span style={{ fg: color }}>{a}</span>
      <span style={{ fg: T.border }}>{b}</span>
      <span style={{ fg: T.text }}>{` ${text}`}</span>
    </text>
  )
}

function DockerDown({ err, w, h, profile, backend }) {
  const podman = backend.engine === "podman"
  return (
    <Panel title={`${engineTitle(backend)} indisponível`} width={w} height={h} focused>
      <text> </text>
      <text style={{ fg: T.red }}>{trunc(`  ✗ ${err}`, w - 4)}</text>
      <text> </text>
      <text style={{ fg: T.text }}>{profile && profile.status !== "Running" ? `  ${podman ? "A máquina" : "O Colima"} "${profile.name}" está ${profile.status.toLowerCase()}.` : `  Não foi possível falar com o ${engineTitle(backend)}.`}</text>
      <text style={{ fg: T.muted }}>{`  Vá na aba 4 Sistema e pressione S para iniciar ${podman ? "a máquina" : "o Colima"},`}</text>
      <text style={{ fg: T.muted }}>{`  ou rode \`${podman ? "podman machine start" : "colima start"}\` em outro terminal. O painel reconecta sozinho.`}</text>
      <text style={{ fg: T.dim }}>  E troca de motor (Docker ↔ Podman).</text>
    </Panel>
  )
}

function ConfirmModal({ text, w, h }) {
  const mw = Math.min(70, w - 4)
  const inner = mw - 4
  const words = text.split(" ")
  const lines = [""]
  for (const word of words) {
    if ((lines[lines.length - 1] + " " + word).trim().length > inner) lines.push(word)
    else lines[lines.length - 1] = (lines[lines.length - 1] + " " + word).trim()
  }
  const mh = lines.length + 4
  return (
    <box position="absolute" left={Math.floor((w - mw) / 2)} top={Math.floor((h - mh) / 2)} width={mw} height={mh} zIndex={10}
      border borderStyle="double" borderColor={T.red} backgroundColor="#1a1020" title=" Confirmar " flexDirection="column" paddingX={1}>
      {lines.map((l, i) => <text key={i} style={{ fg: T.text }}>{l}</text>)}
      <text> </text>
      <text>
        <span style={{ fg: T.red, bold: true }}>[y]</span>
        <span style={{ fg: T.text }}> sim    </span>
        <span style={{ fg: T.muted, bold: true }}>[n/esc]</span>
        <span style={{ fg: T.muted }}> cancelar</span>
      </text>
    </box>
  )
}

function HelpModal({ w, h, backend }) {
  const sections: [string, [string, string][]][] = [
    ["Geral", GLOBAL_HELP],
    ["Containers", helpFor(0, backend)],
    ["Imagens", helpFor(1, backend)],
    ["Volumes", helpFor(2, backend)],
    [`Sistema (${backend.vmName})`, helpFor(3, backend)],
  ]
  const lines = sections.flatMap(([title, items]) => [[title, null], ...items.map((it) => [it[0], it[1]]), ["", ""]])
  const mw = Math.min(56, w - 4)
  const mh = Math.min(h - 2, lines.length + 2)
  return (
    <box position="absolute" left={Math.floor((w - mw) / 2)} top={Math.max(0, Math.floor((h - mh) / 2))} width={mw} height={mh} zIndex={10}
      border borderStyle="rounded" borderColor={T.focus} backgroundColor="#111827" title=" Atalhos · qualquer tecla fecha " flexDirection="column" paddingX={1}>
      {lines.slice(0, mh - 2).map(([a, b], i) =>
        b === null ? (
          <text key={i} style={{ fg: T.purple, bold: true }}>{a}</text>
        ) : (
          <text key={i}>
            <span style={{ fg: T.cyan, bold: true }}>{pad(`  ${a}`, 14)}</span>
            <span style={{ fg: T.text }}>{b}</span>
          </text>
        ),
      )}
    </box>
  )
}

function CleanupModal({ d, backend, state, w, h }) {
  // linhas com largura exata: nenhuma pode passar de `inner`, senão quebra e desalinha o modal
  const items = cleanItemsFor(backend)
  const t = cleanTargets(d)
  const df = (type: string) => d.disk.find((r) => r.type.toLowerCase().startsWith(type))
  const reclaim = (type: string) => parseSize(df(type)?.reclaimable ?? "")
  const imgSize = (list) => list.reduce((a, i) => a + i.size, 0)
  const info: Record<CleanKind, [string, number | null, string[]]> = {
    dangling: [`${t.dangling.length} imagem(ns)`, imgSize(t.dangling), t.dangling.map((i) => i.id.slice(0, 12))],
    networks: ["redes customizadas sem uso", null, []],
    builder: ["cache de builds", reclaim("build"), []],
    images: [`${t.images.length} imagem(ns)`, imgSize(t.images), t.images.map((i) => `${i.repo}:${i.tag}`)],
    "ctr-ok": [`${t["ctr-ok"].length} container(s)`, null, t["ctr-ok"].map(ctrLabel)],
    "ctr-err": [`${t["ctr-err"].length} container(s)`, null, t["ctr-err"].map(ctrLabel)],
    volumes: [`${t.volumes.length} volume(s)`, reclaim("local"), t.volumes.map((v) => v.name)],
  }
  const selected = items.filter((i) => state.on[i.key])
  const total = selected.reduce((a, i) => a + (info[i.key][1] ?? 0), 0)
  const cur = items[state.sel]
  const preview = cur ? info[cur.key][2] : []

  const mw = Math.min(88, w - 4)
  const inner = mw - 4
  const labelW = Math.max(16, inner - 6 - 22 - 10)
  // pré-visualização do item destacado: até 3 linhas com os nomes
  const prevLines: string[] = []
  if (preview.length) {
    let line = "  "
    for (const n of preview) {
      if (strWidth(line + n + ", ") > inner) { prevLines.push(line); line = "  "; if (prevLines.length === 3) break }
      line += n + ", "
    }
    if (prevLines.length < 3 && line.trim()) prevLines.push(line.replace(/, $/, ""))
  }
  const mh = items.length + 13
  return (
    <box position="absolute" left={Math.floor((w - mw) / 2)} top={Math.max(1, Math.floor((h - mh) / 2))} width={mw} height={mh} zIndex={10}
      border borderStyle="rounded" borderColor={T.green} backgroundColor="#0f1a14" title=" Limpeza · liberar espaço " flexDirection="column" paddingX={1}>
      <text style={{ fg: T.muted }}>{pad("Nada que esteja rodando é removido. Containers e imagens saem por nome, sem forçar.", inner)}</text>
      <text> </text>
      {items.map((it, i) => {
        const on = !!state.on[it.key]
        const [count, size] = info[it.key]
        const isCur = i === state.sel
        const color = it.danger ? T.red : it.warn ? T.yellow : T.text
        return (
          <text key={it.key} style={isCur ? { bg: "#1b3326" } : undefined}>
            <span style={{ fg: isCur ? T.green : T.dim }}>{isCur ? "▸ " : "  "}</span>
            <span style={{ fg: on ? (it.danger ? T.red : it.warn ? T.yellow : T.green) : T.dim }}>{on ? "[x] " : "[ ] "}</span>
            <span style={{ fg: color }}>{pad(it.label, labelW - 1) + " "}</span>
            <span style={{ fg: T.muted }}>{pad(count, 22)}</span>
            <span style={{ fg: size ? T.yellow : T.dim }}>{padL(size ? fmtBytes(size) : "", 10)}</span>
          </text>
        )
      })}
      <text> </text>
      <text style={{ fg: T.muted, bold: true }}>{pad(cur ? `${cur.label}${preview.length ? ":" : ""}` : "", inner)}</text>
      {[0, 1, 2].map((i) => (
        <text key={`p${i}`} style={{ fg: cur?.danger ? T.red : cur?.warn ? T.yellow : T.text }}>{pad(prevLines[i] ?? (i === 0 && !preview.length ? "  (nada para listar)" : ""), inner)}</text>
      ))}
      <text> </text>
      <text>
        <span style={{ fg: T.text }}>{"Estimativa: "}</span>
        <span style={{ fg: T.green, bold: true }}>{`~${fmtBytes(total)}`}</span>
        <span style={{ fg: T.dim }}>{pad("  (o valor real aparece no fim)", Math.max(0, inner - 12 - strWidth(`~${fmtBytes(total)}`)))}</span>
      </text>
      <text>
        <span style={{ fg: T.green, bold: true }}>[enter]</span>
        <span style={{ fg: T.text }}> limpar   </span>
        <span style={{ fg: T.cyan, bold: true }}>[espaço]</span>
        <span style={{ fg: T.text }}> marcar   </span>
        <span style={{ fg: T.cyan, bold: true }}>[a]</span>
        <span style={{ fg: T.text }}> só o seguro   </span>
        <span style={{ fg: T.muted, bold: true }}>[esc]</span>
        <span style={{ fg: T.muted }}> cancelar</span>
      </text>
    </box>
  )
}

function fitHelp(help: [string, string][], width: number) {
  const out = []
  let used = 0
  for (let i = 0; i < help.length; i++) {
    const [key, label] = help[i]
    const len = strWidth(` ${key} ${label} `)
    if (used + len > width - 1) break
    used += len
    out.push(<span key={`k${i}`} style={{ fg: T.cyan, bold: true }}>{` ${key}`}</span>)
    out.push(<span key={`l${i}`} style={{ fg: T.muted }}>{` ${label} `}</span>)
  }
  return out
}

/** cabeçalho em uma única linha: o lado direito (contadores) tem prioridade, o resto é cortado */
function Header({ backend, profile, d, width, running, stopped, totCpu, totMem, clock }) {
  const right = `▲ ${running} ■ ${stopped}  CPU ${totCpu.toFixed(1)}%  MEM ${fmtBytes(totMem)}  ${clock} `
  const brand = ` ◆ ${backend.engine === "podman" ? "podman" : "colima"} `
  const demo = backend.mock ? "  [demo]" : ""
  const status = profile ? `${profile.status === "Running" ? "● " : "○ "}${profile.status.toLowerCase()}` : ""
  const avail = Math.max(0, width - strWidth(right) - strWidth(brand) - strWidth(status) - strWidth(demo) - 2)
  const details = profile
    ? trunc(`  ${profile.name} · ${profile.runtime} · ${profile.arch} · ${profile.cpus} CPU · ${fmtBytes(profile.memory, 0)} RAM · ${fmtBytes(profile.disk, 0)} disco`, avail)
    : trunc(d.vmErr ? `${backend.vmName}: ${d.vmErr}` : "carregando…", avail + strWidth(status))
  const leftLen = strWidth(brand) + strWidth(status) + strWidth(details) + strWidth(demo)
  const gap = Math.max(1, width - leftLen - strWidth(right))
  return (
    <text>
      <span style={{ fg: T.purple, bold: true }}>{brand}</span>
      {profile ? <span style={{ fg: profile.status === "Running" ? T.green : T.red }}>{status}</span> : null}
      <span style={{ fg: profile ? T.muted : d.vmErr ? T.red : T.muted }}>{details}</span>
      {demo ? <span style={{ fg: T.yellow }}>{demo}</span> : null}
      <span>{" ".repeat(gap)}</span>
      <span style={{ fg: T.green }}>{`▲ ${running} `}</span>
      <span style={{ fg: T.dim }}>{`■ ${stopped}  `}</span>
      <span style={{ fg: T.muted }}>CPU </span>
      <span style={{ fg: cpuColor(totCpu / Math.max(1, profile?.cpus ?? 1)) }}>{`${totCpu.toFixed(1)}%  `}</span>
      <span style={{ fg: T.muted }}>MEM </span>
      <span style={{ fg: T.text }}>{`${fmtBytes(totMem)}  `}</span>
      <span style={{ fg: T.dim }}>{`${clock} `}</span>
    </text>
  )
}
