// @ts-nocheck
// App root: picks the engine (Docker/Colima or Podman), then opens the dashboard.
// The picker can be skipped with --docker / --podman. Inside the dashboard, E comes back here.
import { useEffect, useRef, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@gridland/utils"
import type { Backend, Engine, EngineInfo } from "./backend/types"
import { DockerDash, T } from "./DockerDash"
import { pad, trunc } from "./lib/format"

interface RootProps {
  initialEngine?: Engine | null
  lastEngine?: Engine | null
  detect: () => Promise<EngineInfo[]>
  makeBackend: (engine: Engine) => Backend
  onEngineChosen?: (engine: Engine) => void
  onExit?: () => void
}

export function Root({ initialEngine, lastEngine, detect, makeBackend, onEngineChosen, onExit }: RootProps) {
  const [engine, setEngine] = useState<Engine | null>(initialEngine ?? null)
  const backends = useRef<Partial<Record<Engine, Backend>>>({})

  if (engine) {
    const backend = (backends.current[engine] ??= makeBackend(engine))
    return <DockerDash key={engine} backend={backend} onExit={onExit} onSwitchEngine={() => setEngine(null)} />
  }
  return (
    <EnginePicker
      detect={detect}
      preferred={lastEngine}
      onExit={onExit}
      onPick={(e) => {
        onEngineChosen?.(e)
        setEngine(e)
      }}
    />
  )
}

const OPTIONS: { engine: Engine; title: string; sub: string; key: string }[] = [
  { engine: "docker", title: "Docker", sub: "via Colima", key: "d" },
  { engine: "podman", title: "Podman", sub: "via podman machine", key: "p" },
]

function EnginePicker({ detect, preferred, onPick, onExit }) {
  const { width, height } = useTerminalDimensions()
  const [infos, setInfos] = useState<EngineInfo[] | null>(null)
  const [sel, setSel] = useState(Math.max(0, OPTIONS.findIndex((o) => o.engine === preferred)))
  const touched = useRef(false)

  const load = () => {
    setInfos(null)
    detect().then((list) => {
      setInfos(list)
      // no previous choice: preselect the engine that's running
      if (!touched.current && !preferred) {
        const i = OPTIONS.findIndex((o) => list.find((x) => x.engine === o.engine)?.running)
        if (i >= 0) setSel(i)
      }
    }).catch(() => setInfos([]))
  }
  useEffect(load, [])

  useKeyboard((e) => {
    const ch = e.sequence?.length === 1 ? e.sequence : null
    if (e.name === "up" || e.name === "down" || e.name === "tab") {
      touched.current = true
      setSel((s) => (s + 1) % OPTIONS.length)
    } else if (e.name === "return") onPick(OPTIONS[sel].engine)
    else if (ch === "d") onPick("docker")
    else if (ch === "p") onPick("podman")
    else if (ch === "r") load()
    else if (ch === "q" || e.name === "escape") onExit?.()
  })

  const bw = Math.min(72, width - 4)
  const inner = bw - 4
  const bh = 15
  return (
    <box width={width} height={height} backgroundColor={T.bg} flexDirection="column" alignItems="center" justifyContent="center">
      <box width={bw} height={bh} border borderStyle="rounded" borderColor={T.focus} title=" docker-dash " titleAlignment="center" flexDirection="column" paddingX={1}>
        <text> </text>
        <text style={{ fg: T.text, bold: true }}>{pad("Which container engine do you want to manage?", inner)}</text>
        <text> </text>
        {OPTIONS.map((o, i) => {
          const info = infos?.find((x) => x.engine === o.engine)
          const cur = i === sel
          const [icon, color, status] = !infos
            ? ["…", T.muted, "detecting…"]
            : !info?.installed
            ? ["✕", T.red, "not installed"]
            : info.running
            ? ["●", T.green, "running"]
            : ["○", T.yellow, "stopped"]
          return (
            <box key={o.engine} flexDirection="column">
              <text style={cur ? { bg: T.selBg } : undefined}>
                <span style={{ fg: cur ? T.focus : T.dim }}>{cur ? " ▸ " : "   "}</span>
                <span style={{ fg: cur ? T.focus : T.text, bold: true }}>{pad(o.title, 8)}</span>
                <span style={{ fg: T.muted }}>{pad(o.sub, 20)}</span>
                <span style={{ fg: color }}>{`${icon} `}</span>
                <span style={{ fg: color }}>{pad(status, Math.max(6, inner - 3 - 8 - 20 - 2))}</span>
              </text>
              <text style={{ fg: T.dim }}>{pad(`     ${trunc([info?.version, info?.detail].filter(Boolean).join(" · "), inner - 5)}`, inner)}</text>
            </box>
          )
        })}
        <text> </text>
        <box flexGrow={1} />
        <text>
          <span style={{ fg: T.cyan, bold: true }}> enter</span>
          <span style={{ fg: T.muted }}> open  </span>
          <span style={{ fg: T.cyan, bold: true }}>d/p</span>
          <span style={{ fg: T.muted }}> docker/podman  </span>
          <span style={{ fg: T.cyan, bold: true }}>r</span>
          <span style={{ fg: T.muted }}> detect again  </span>
          <span style={{ fg: T.cyan, bold: true }}>q</span>
          <span style={{ fg: T.muted }}> quit</span>
        </text>
      </box>
      <text style={{ fg: T.dim }}>{"tip: docker-dash --docker or --podman skips this screen"}</text>
    </box>
  )
}
