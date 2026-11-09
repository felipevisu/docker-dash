// Podman + podman machine backend.
// Podman's CLI is nearly the same as Docker's, but the JSON differs: `--format json` returns arrays,
// names come in lists, ports are objects, sizes are in bytes and stats uses snake_case.
// So we convert everything to the same types the UI uses.
import type { Backend, Machine, Container, Image, Stat, Volume, DiskUsage, PruneKind } from "./types"
import { parsePair, parseSize, clean } from "../lib/format"
import { run, jsonLines, lastLine, pick, ago, copyToClipboard, exitCodeOf, composeProject, removeEach } from "./exec"

const short = (id: string) => String(id ?? "").replace(/^sha256:/, "").slice(0, 12)

/** Podman ports → same text as `docker ps` ("0.0.0.0:8080->80/tcp"), to reuse the parser */
function portsToString(ports: any): string {
  if (!ports) return ""
  if (typeof ports === "string") return ports
  return (ports as any[])
    .map((p) => {
      const host = pick(p, "host_port", "hostPort")
      const ctr = pick(p, "container_port", "containerPort")
      const proto = pick(p, "protocol") ?? "tcp"
      const range = Number(pick(p, "range") ?? 1)
      if (!host) return `${ctr}/${proto}`
      const ip = pick(p, "host_ip", "hostIP") || "0.0.0.0"
      const suffix = range > 1 ? ` (+${range - 1})` : ""
      return `${ip}:${host}->${ctr}/${proto}${suffix}`
    })
    .join(", ")
}

const list = (v: any) => (Array.isArray(v) ? v.join(",") : String(v ?? ""))

/** "docker.io/library/postgres" → "postgres"; "docker.io/minio/minio" → "minio/minio" */
function shortRepo(repo: string) {
  return repo.replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "")
}

function bytesOf(v: any): number {
  if (typeof v === "number") return v
  const n = Number(v)
  return isFinite(n) && String(v).trim() !== "" ? n : parseSize(String(v ?? ""))
}

export function podmanBackend(): Backend {
  const podman = (args: string[], timeout?: number) => run("podman", args, timeout)

  return {
    engine: "podman",
    vmName: "podman machine",
    cli: "podman",
    unsupported: ["builder"],

    async machines() {
      const { stdout } = await podman(["machine", "list", "--format", "json"], 15_000)
      const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
      return jsonLines(stdout).map((m): Machine => ({
        name: String(m.Name ?? "").replace(/\*$/, ""),
        status: m.Running ? "Running" : m.Starting ? "Starting" : "Stopped",
        arch,
        cpus: Number(pick(m, "CPUs", "Cpus") ?? 0),
        memory: bytesOf(m.Memory),
        disk: bytesOf(pick(m, "DiskSize", "Disk")),
        runtime: `podman${m.VMType ? ` · ${m.VMType}` : ""}${m.Default ? " · default" : ""}`,
        address: m.Port ? `ssh :${m.Port}` : "",
      }))
    },

    async containers() {
      const { stdout } = await podman(["ps", "-a", "--format", "json"])
      return jsonLines(stdout).map((c): Container => ({
        id: short(pick(c, "Id", "ID")),
        name: Array.isArray(c.Names) ? c.Names[0] : String(c.Names ?? ""),
        image: shortRepo(String(c.Image ?? "")),
        state: String(c.State ?? "").toLowerCase(),
        status: String(c.Status ?? c.State ?? ""),
        ports: portsToString(c.Ports),
        command: Array.isArray(c.Command) ? c.Command.join(" ") : String(c.Command ?? ""),
        createdAt: String(c.CreatedAt ?? ""),
        networks: list(c.Networks),
        mounts: list(c.Mounts),
        exitCode: c.ExitCode !== undefined && String(c.State).toLowerCase() !== "running" ? Number(c.ExitCode) : exitCodeOf(c.Status),
        project: composeProject(c.Labels),
      }))
    },

    async stats() {
      let stdout = ""
      try {
        stdout = (await podman(["stats", "--no-stream", "--no-reset", "--format", "json"], 20_000)).stdout
      } catch (e: any) {
        // old versions lack --no-reset; and with no running containers podman may complain
        if (/no-reset/.test(e.message)) stdout = (await podman(["stats", "--no-stream", "--format", "json"], 20_000)).stdout
        else if (/no (running )?containers/i.test(e.message)) return []
        else throw e
      }
      return jsonLines(stdout).map((s): Stat => {
        const [memUsed, memLimit] = parsePair(pick(s, "mem_usage", "MemUsage"))
        const [netRx, netTx] = parsePair(pick(s, "net_io", "NetIO"))
        const [blockRead, blockWrite] = parsePair(pick(s, "block_io", "BlockIO"))
        return {
          id: short(pick(s, "id", "ID", "ContainerID")),
          name: pick(s, "name", "Name") ?? "",
          cpu: parseFloat(pick(s, "cpu_percent", "CPU", "CPUPerc")) || 0,
          memUsed,
          memLimit,
          memPerc: parseFloat(pick(s, "mem_percent", "MemPerc")) || 0,
          netRx, netTx, blockRead, blockWrite,
          pids: Number(pick(s, "pids", "PIDs", "PIDS")) || 0,
        }
      })
    },

    async images() {
      const { stdout } = await podman(["images", "--format", "json"])
      return jsonLines(stdout).flatMap((i): Image[] => {
        const base = { id: short(pick(i, "Id", "ID")), size: bytesOf(i.Size), created: ago(pick(i, "Created", "CreatedAt")) }
        const tags: string[] = i.RepoTags?.length ? i.RepoTags : i.Names?.length ? i.Names : []
        if (!tags.length) return [{ ...base, repo: "<none>", tag: "<none>" }]
        return tags.map((t) => {
          const at = t.lastIndexOf(":")
          const slash = t.lastIndexOf("/")
          const hasTag = at > slash
          return { ...base, repo: shortRepo(hasTag ? t.slice(0, at) : t), tag: hasTag ? t.slice(at + 1) : "latest" }
        })
      })
    },

    async volumes() {
      const { stdout } = await podman(["volume", "ls", "--format", "json"])
      const vols = jsonLines(stdout).map((v): Volume => ({
        name: v.Name,
        driver: v.Driver ?? "local",
        mountpoint: v.Mountpoint ?? "",
        users: [],
      }))
      // `podman ps` doesn't say which volumes each container uses; inspect does (one call for all)
      try {
        const idList = (await podman(["ps", "-aq"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean)
        if (idList.length) {
          const info = jsonLines((await podman(["container", "inspect", ...idList])).stdout)
          const byVol: Record<string, string[]> = {}
          for (const c of info) {
            const name = String(c.Name ?? "").replace(/^\//, "")
            for (const m of c.Mounts ?? []) if (m.Type === "volume" && m.Name) (byVol[m.Name] ??= []).push(name)
          }
          for (const v of vols) v.users = byVol[v.name] ?? []
        }
      } catch {
        for (const v of vols) delete v.users // without the info, the UI uses the fallback
      }
      return vols
    },

    async diskUsage() {
      const { stdout } = await podman(["system", "df", "--format", "json"])
      return jsonLines(stdout).map((r): DiskUsage => ({
        type: r.Type,
        total: Number(pick(r, "Total", "TotalCount")) || 0,
        active: Number(r.Active) || 0,
        size: r.RawSize !== undefined ? Number(r.RawSize) : parseSize(r.Size),
        reclaimable: String(r.Reclaimable ?? ""),
      }))
    },

    async logs(id, tail) {
      const { stdout, stderr } = await podman(["logs", "--tail", String(tail), id], 10_000)
      return (stdout + stderr)
        .split("\n")
        .map((l) => clean(l.split("\r").pop() ?? ""))
        .filter((l) => l.trim().length > 0)
        .slice(-tail)
    },

    async containerAction(action, id) {
      const args = action === "rm" ? ["rm", "-f", id] : [action, id]
      await podman(args, 60_000)
      return ""
    },

    async removeImage(id) {
      const { stdout } = await podman(["rmi", id], 60_000)
      return lastLine(stdout)
    },

    // no -f on purpose: a running container (or image in use) fails instead of being removed
    removeContainers: (ids) => removeEach("podman", ["rm"], ids),
    removeImages: (ids) => removeEach("podman", ["rmi"], ids),

    async removeVolume(name) {
      await podman(["volume", "rm", name])
      return ""
    },

    async prune(kind: PruneKind) {
      const args: Partial<Record<PruneKind, string[]>> = {
        containers: ["container", "prune", "-f"],
        images: ["image", "prune", "-f"],
        "images-all": ["image", "prune", "-a", "-f"],
        volumes: ["volume", "prune", "-f"],
        networks: ["network", "prune", "-f"],
        system: ["system", "prune", "-f"],
      }
      if (!args[kind]) throw new Error(`"${kind} prune" doesn't exist in Podman`)
      const { stdout } = await podman(args[kind]!, 10 * 60_000)
      const lines = stdout.trim().split("\n").filter(Boolean)
      return lines.length > 1 ? `${lines.length} items removed` : lastLine(stdout)
    },

    async pull(ref) {
      const { stdout } = await podman(["pull", ref], 15 * 60_000)
      return `ok ${short(lastLine(stdout))}`
    },

    async machineAction(action, name) {
      const timeout = 15 * 60_000
      if (action === "restart") {
        await podman(["machine", "stop", name], timeout).catch(() => {})
        await podman(["machine", "start", name], timeout)
        return "restarted"
      }
      const { stdout, stderr } = await podman(["machine", action, name], timeout)
      return lastLine(stdout || stderr)
    },

    copy: copyToClipboard,

    async openUrl(url) {
      await run("open", [url])
    },
  }
}
