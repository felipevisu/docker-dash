// Execução de comandos compartilhada pelos backends reais.
// Sempre execFile com argv em array: nada passa por shell.
import { execFile, spawn } from "node:child_process"

export interface RunResult { stdout: string; stderr: string }

export function run(cmd: string, args: string[], timeout = 30_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as any).code
        let message: string
        if (code === "ENOENT") message = `comando "${cmd}" não encontrado no PATH`
        else if ((err as any).killed) message = `"${cmd} ${args[0]}" demorou demais (timeout)`
        else message = (String(stderr || "").trim().split("\n").filter(Boolean).pop() ?? err.message).trim()
        reject(new Error(message || `${cmd} falhou`))
      } else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Aceita um array JSON ou um objeto JSON por linha (formato `{{json .}}`) */
export function jsonLines(s: string): any[] {
  const t = s.trim()
  if (!t || t === "null") return []
  if (t.startsWith("[")) {
    try { return JSON.parse(t) ?? [] } catch {}
  }
  return t.split("\n").flatMap((l) => {
    try { return [JSON.parse(l)] } catch { return [] }
  })
}

export const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? ""

/** Primeiro campo existente entre vários nomes possíveis (formatos mudam entre versões) */
export function pick(o: any, ...keys: string[]): any {
  for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null) return o[k]
  return undefined
}

/** "há quanto tempo", a partir de um timestamp unix (s) ou data ISO */
export function ago(t: number | string | undefined): string {
  if (t === undefined || t === null || t === "") return ""
  const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t)
  if (!isFinite(ms)) return String(t)
  const s = Math.max(0, (Date.now() - ms) / 1000)
  const units: [number, string, string][] = [[31536000, "year", "years"], [2592000, "month", "months"], [604800, "week", "weeks"], [86400, "day", "days"], [3600, "hour", "hours"], [60, "minute", "minutes"]]
  for (const [secs, one, many] of units) {
    const n = Math.floor(s / secs)
    if (n >= 1) return `${n} ${n === 1 ? one : many} ago`
  }
  return "Just now"
}

/** "Exited (255) 3 minutes ago" → 255 */
export function exitCodeOf(status: string): number | null {
  const m = /exited\s*\((-?\d+)\)/i.exec(status ?? "")
  return m ? Number(m[1]) : null
}

/** projeto compose a partir dos labels (string "k=v,k=v" do docker ou objeto do podman) */
export function composeProject(labels: any): string | undefined {
  if (!labels) return undefined
  if (typeof labels === "string") {
    const m = /(?:^|,)com\.docker\.compose\.project=([^,]+)/.exec(labels)
    return m?.[1]
  }
  return labels["com.docker.compose.project"] ?? labels["io.podman.compose.project"]
}

/** executa `cli <args...> <id>` para cada id, sem parar no primeiro erro */
export async function removeEach(cli: string, args: string[], ids: string[]) {
  const removed: string[] = []
  const failed: { id: string; error: string }[] = []
  for (const id of ids) {
    try {
      await run(cli, [...args, id], 60_000)
      removed.push(id)
    } catch (e: any) {
      failed.push({ id, error: e.message })
    }
  }
  return { removed, failed }
}

/** Copia texto para o clipboard do macOS */
export function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("pbcopy")
    p.on("error", reject)
    p.on("close", () => resolve())
    p.stdin.end(text)
  })
}

/** Detecta Docker e Podman (instalado? rodando?) em paralelo, com timeouts curtos */
export async function detectEngines(): Promise<import("./types").EngineInfo[]> {
  const docker = (async () => {
    const info = { engine: "docker" as const, installed: false, running: false, version: "", detail: "" }
    try {
      info.version = (await run("docker", ["--version"], 4000)).stdout.trim().replace(/^Docker version\s*/i, "").split(",")[0]
      info.installed = true
    } catch { info.detail = "docker não encontrado (brew install docker colima)"; return info }
    try {
      const v = (await run("docker", ["info", "--format", "{{.ServerVersion}}"], 5000)).stdout.trim()
      info.running = true
      info.detail = `servidor ${v}`
    } catch {
      info.detail = "daemon parado (Colima desligado?)"
    }
    return info
  })()
  const podman = (async () => {
    const info = { engine: "podman" as const, installed: false, running: false, version: "", detail: "" }
    try {
      info.version = (await run("podman", ["--version"], 4000)).stdout.trim().replace(/^podman version\s*/i, "")
      info.installed = true
    } catch { info.detail = "podman não encontrado (brew install podman)"; return info }
    try {
      const machines = jsonLines((await run("podman", ["machine", "list", "--format", "json"], 5000)).stdout)
      const up = machines.find((m) => m.Running)
      info.running = !!up
      info.detail = up ? `máquina ${up.Name} rodando` : machines.length ? "máquina parada" : "nenhuma máquina (podman machine init)"
    } catch {
      info.detail = "não consegui listar as máquinas"
    }
    return info
  })()
  return Promise.all([docker, podman])
}
