// Helpers de formatação e parsing (tamanhos, portas, tabelas, sparklines).

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
}

/** "123.4MiB" → bytes */
export function parseSize(s?: string): number {
  const m = /([\d.]+)\s*([a-zA-Z]+)?/.exec(s ?? "")
  if (!m) return 0
  return parseFloat(m[1]) * (UNITS[(m[2] ?? "b").toLowerCase()] ?? 1)
}

/** "1.2kB / 3MB" → [1200, 3000000] */
export function parsePair(s?: string): [number, number] {
  const [a, b] = (s ?? "").split("/")
  return [parseSize(a), parseSize(b)]
}

export function fmtBytes(n: number, digits = 1): string {
  if (!isFinite(n) || n <= 0) return "0B"
  const u = ["B", "KiB", "MiB", "GiB", "TiB"]
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : digits)}${u[i]}`
}

// Sequências ANSI (CSI, OSC, ESC simples) e caracteres de controle. Logs de containers
// costumam trazer cores e movimentos de cursor; se chegarem ao terminal, quebram o layout.
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -\/]*[@-~]/g
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/** remove cores/controles e troca tab por espaços */
export function clean(s: string): string {
  return String(s ?? "").replace(ANSI_RE, "").replace(/\t/g, "  ").replace(CTRL_RE, "")
}

/** largura de um caractere no terminal (0, 1 ou 2 colunas) */
function charWidth(cp: number): number {
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x2600 && cp <= 0x27bf && cp !== 0x2713 && cp !== 0x2717 && cp !== 0x2715)
  ) return 2
  return 1
}

export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0)!)
  return w
}

/** corta pelo número de COLUNAS (não de caracteres), limpando ANSI antes */
export function trunc(s: string, w: number): string {
  s = clean(s)
  if (w <= 0) return ""
  if (strWidth(s) <= w) return s
  let out = ""
  let used = 0
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!)
    if (used + cw > w - 1) break
    out += ch
    used += cw
  }
  return out + "…"
}
export const pad = (s: string, w: number) => {
  const t = trunc(s, w)
  return t + " ".repeat(Math.max(0, w - strWidth(t)))
}
export const padL = (s: string, w: number) => {
  const t = trunc(s, w)
  return " ".repeat(Math.max(0, w - strWidth(t))) + t
}

export interface PortMap { host: number; container: number; proto: string }

/** "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp, 6379/tcp" → portas publicadas (sem duplicar IPv4/IPv6) */
export function parsePorts(s?: string): PortMap[] {
  const out: PortMap[] = []
  const seen = new Set<string>()
  const re = /:(\d+)->(\d+)\/(\w+)/g
  let m
  while ((m = re.exec(s ?? ""))) {
    const key = `${m[1]}-${m[2]}-${m[3]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ host: +m[1], container: +m[2], proto: m[3] })
  }
  return out
}

export function fmtPorts(s?: string): string {
  return parsePorts(s).map((p) => (p.host === p.container ? `${p.host}` : `${p.host}→${p.container}`)).join(", ")
}

const SPARK = "▁▂▃▄▅▆▇█"
/** Sparkline com as últimas `width` amostras. `max` fixo opcional (ex.: 100 para %). */
export function spark(values: number[], width: number, max?: number): string {
  const v = values.slice(-width)
  const top = max ?? Math.max(1e-9, ...v)
  const s = v.map((x) => SPARK[Math.max(0, Math.min(7, Math.round((x / top) * 7)))]).join("")
  return s.padStart(width, " ")
}

/** Barra horizontal de progresso */
export function bar(frac: number, width: number): [string, string] {
  const f = Math.max(0, Math.min(1, frac || 0))
  const n = Math.round(f * width)
  return ["█".repeat(n), "░".repeat(Math.max(0, width - n))]
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Índice inicial da janela visível para manter `sel` na tela */
export function scrollStart(sel: number, len: number, rows: number) {
  if (len <= rows) return 0
  return clamp(sel - Math.floor(rows / 2), 0, len - rows)
}
