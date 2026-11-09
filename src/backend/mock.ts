// Mock backend: fake data that changes over time. Useful for testing the UI without Docker
// (bun run src/cli.tsx --mock) and for the browser preview.
import type { Backend, Container, Image, Stat, Volume, Machine, Engine, EngineInfo } from "./types"

const GiB = 1024 ** 3
const MiB = 1024 ** 2
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const walk = (v: number, lo: number, hi: number, step: number) =>
  Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * step))

const LOG_TEMPLATES: Record<string, string[]> = {
  postgres: [
    "LOG:  checkpoint starting: time",
    "LOG:  checkpoint complete: wrote 42 buffers (0.3%)",
    "LOG:  connection received: host=172.18.0.5 port=50122",
    "LOG:  connection authorized: user=app database=app_dev",
  ],
  redis: [
    "* Background saving started by pid 31",
    "* DB saved on disk",
    "* 100 changes in 300 seconds. Saving...",
  ],
  api: [
    "INFO  GET /api/health 200 2ms",
    "INFO  POST /api/orders 201 48ms",
    "WARN  slow query on orders (812ms)",
    "INFO  GET /api/users/42 200 11ms",
    "ERROR upstream timeout calling payments-svc",
    "\x1b[31mError [TransformError]: Transform failed with 1 error:\x1b[39m",
    "\x1b[2K\x1b[1G\x1b[36m42\x1b[0m \x1b[3A progress 42%\r100% ✅ done 🚀",
    '{"level":"info","time":"2026-10-30T13:03:12.862Z","service":"chat","env":"dev","msg":"message received 你好 \t tab"}',
  ],
  web: [
    "GET / 200 3.1ms",
    "GET /_next/static/chunks/main.js 200 0.8ms",
    "GET /favicon.ico 304 0.2ms",
  ],
  default: ["tick", "processing job", "job done"],
}

export function mockBackend(engine: Engine = "docker"): Backend {
  const podman = engine === "podman"
  const containers: Container[] = [
    { id: "a1b2c3d4e5f6", name: "postgres", image: "postgres:16-alpine", state: "running", status: "Up 3 hours", ports: "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp", command: "docker-entrypoint.sh postgres", createdAt: "", networks: "app_default", mounts: "pgdata" },
    { id: "b2c3d4e5f6a1", name: "redis", image: "redis:7", state: "running", status: "Up 3 hours", ports: "0.0.0.0:6379->6379/tcp", command: "redis-server --appendonly yes", createdAt: "", networks: "app_default", mounts: "redisdata" },
    { id: "c3d4e5f6a1b2", name: "api", image: "acme/api:dev", state: "running", status: "Up 25 minutes", ports: "0.0.0.0:8080->3000/tcp", command: "bun run src/server.ts", createdAt: "", networks: "app_default", mounts: "/Users/felipe/Projects/api" },
    { id: "d4e5f6a1b2c3", name: "web", image: "acme/web:dev", state: "running", status: "Up 25 minutes", ports: "0.0.0.0:3000->3000/tcp", command: "next dev", createdAt: "", networks: "app_default", mounts: "" },
    { id: "e5f6a1b2c3d4", name: "minio", image: "minio/minio:latest", state: "paused", status: "Up 2 days (Paused)", ports: "0.0.0.0:9000->9000/tcp, 0.0.0.0:9001->9001/tcp", command: "minio server /data", createdAt: "", networks: "bridge", mounts: "miniodata" },
    { id: "f6a1b2c3d4e5", name: "worker", image: "acme/worker:dev", state: "exited", status: "Exited (1) 12 minutes ago", ports: "", command: "bun run worker.ts", createdAt: "", networks: "app_default", mounts: "" },
    { id: "9f8e7d6c5b4a", name: "orch-testdb", image: "pgvector/pgvector:pg16", state: "exited", status: "Exited (255) About a minute ago", ports: "0.0.0.0:55433->5432/tcp", command: "docker-entrypoint.sh postgres", createdAt: "", networks: "bridge", mounts: "", exitCode: 255, project: undefined },
    { id: "0a1b2c3d4e5f", name: "localstack", image: "localstack/localstack:3", state: "exited", status: "Exited (0) 3 days ago", ports: "", command: "docker-entrypoint.sh", createdAt: "", networks: "bridge", mounts: "" },
  ]
  for (const c of containers) {
    c.exitCode ??= /Exited \((\d+)\)/.exec(c.status) ? Number(/Exited \((\d+)\)/.exec(c.status)![1]) : null
    if (["postgres", "redis", "api", "web", "worker"].includes(c.name)) c.project ??= "acme"
  }
  let images: Image[] = [
    { id: "sha1postgres", repo: "postgres", tag: "16-alpine", size: 243 * MiB, created: "3 weeks ago" },
    { id: "sha1redis000", repo: "redis", tag: "7", size: 138 * MiB, created: "5 weeks ago" },
    { id: "sha1api00000", repo: "acme/api", tag: "dev", size: 412 * MiB, created: "25 minutes ago" },
    { id: "sha1web00000", repo: "acme/web", tag: "dev", size: 688 * MiB, created: "25 minutes ago" },
    { id: "sha1minio000", repo: "minio/minio", tag: "latest", size: 160 * MiB, created: "2 months ago" },
    { id: "sha1worker00", repo: "acme/worker", tag: "dev", size: 398 * MiB, created: "1 hour ago" },
    { id: "sha1locals00", repo: "localstack/localstack", tag: "3", size: 1.2 * GiB, created: "4 months ago" },
    { id: "sha1dangl000", repo: "<none>", tag: "<none>", size: 401 * MiB, created: "2 days ago" },
    { id: "sha1node0000", repo: "node", tag: "22-alpine", size: 155 * MiB, created: "1 month ago" },
  ]
  let volumes: Volume[] = [
    { name: "pgdata", driver: "local", mountpoint: "/var/lib/docker/volumes/pgdata/_data" },
    { name: "redisdata", driver: "local", mountpoint: "/var/lib/docker/volumes/redisdata/_data" },
    { name: "miniodata", driver: "local", mountpoint: "/var/lib/docker/volumes/miniodata/_data" },
    { name: "3f9c1e0a7b8d4c2e9f1a", driver: "local", mountpoint: "/var/lib/docker/volumes/3f9c…/_data" },
  ]
  const profiles: Machine[] = podman
    ? [
        { name: "podman-machine-default", status: "Running", arch: "aarch64", cpus: 5, memory: 4 * GiB, disk: 100 * GiB, runtime: "podman · applehv · default", address: "ssh :52345" },
        { name: "rootful", status: "Stopped", arch: "aarch64", cpus: 2, memory: 2 * GiB, disk: 60 * GiB, runtime: "podman · applehv", address: "" },
      ]
    : [
        { name: "default", status: "Running", arch: "aarch64", cpus: 4, memory: 8 * GiB, disk: 100 * GiB, runtime: "docker", address: "192.168.106.2" },
        { name: "k8s", status: "Stopped", arch: "aarch64", cpus: 2, memory: 4 * GiB, disk: 60 * GiB, runtime: "containerd", address: "" },
      ]
  let buildCache = 1.9 * GiB
  const volSize: Record<string, number> = { pgdata: 1.4 * GiB, redisdata: 120 * MiB, miniodata: 480 * MiB, "3f9c1e0a7b8d4c2e9f1a": 310 * MiB }
  let networks = 6
  const imgInUse = (i: Image) => containers.some((c) => c.image === `${i.repo}:${i.tag}`)
  const volInUse = (v: Volume) => containers.some((c) => c.mounts.split(",").includes(v.name))
  const live: Record<string, { cpu: number; mem: number; rx: number; tx: number; br: number; bw: number }> = {}
  const logs: Record<string, string[]> = {}

  const now = () => new Date().toISOString().slice(11, 19)
  const byId = (id: string) => containers.find((c) => c.id === id || c.name === id)

  return {
    engine,
    vmName: podman ? "podman machine" : "colima",
    cli: podman ? "podman" : "docker",
    mock: true,
    unsupported: podman ? ["builder"] : [],
    async machines() {
      await sleep(80)
      return profiles.map((p) => ({ ...p }))
    },
    async containers() {
      await sleep(60)
      return containers.map((c) => ({ ...c }))
    },
    async stats() {
      await sleep(300)
      return containers
        .filter((c) => c.state === "running" || c.state === "paused")
        .map((c): Stat => {
          const s = (live[c.id] ??= { cpu: Math.random() * 20, mem: (50 + Math.random() * 400) * MiB, rx: 0, tx: 0, br: 0, bw: 0 })
          if (c.state === "running") {
            s.cpu = walk(s.cpu, 0, c.name === "api" ? 140 : 60, 12)
            s.mem = walk(s.mem, 30 * MiB, 1.5 * GiB, 30 * MiB)
            s.rx += Math.random() * 400_000
            s.tx += Math.random() * 200_000
            s.br += Math.random() * 50_000
            s.bw += Math.random() * 90_000
          } else s.cpu = 0
          return { id: c.id, name: c.name, cpu: s.cpu, memUsed: s.mem, memLimit: 7.7 * GiB, memPerc: (s.mem / (7.7 * GiB)) * 100, netRx: s.rx, netTx: s.tx, blockRead: s.br, blockWrite: s.bw, pids: 4 + Math.floor(s.cpu / 5) }
        })
    },
    async images() {
      await sleep(60)
      return images.map((i) => ({ ...i }))
    },
    async volumes() {
      await sleep(60)
      return volumes.map((v) => ({ ...v }))
    },
    async diskUsage() {
      const running = containers.filter((c) => c.state === "running").length
      const imgTotal = images.reduce((a, i) => a + i.size, 0)
      const imgUnused = images.filter((i) => !imgInUse(i)).reduce((a, i) => a + i.size, 0)
      const ctrSize = containers.length * 12 * MiB
      const ctrStopped = containers.filter((c) => c.state === "exited").length * 12 * MiB
      const volTotal = volumes.reduce((a, v) => a + (volSize[v.name] ?? 0), 0)
      const volUnused = volumes.filter((v) => !volInUse(v)).reduce((a, v) => a + (volSize[v.name] ?? 0), 0)
      const pct = (a: number, b: number) => (b ? ` (${Math.round((a / b) * 100)}%)` : "")
      const h = (n: number) => `${(n / 1e9 >= 1 ? (n / 1e9).toFixed(2) + "GB" : (n / 1e6).toFixed(1) + "MB")}`
      return [
        { type: "Images", total: images.length, active: images.filter(imgInUse).length, size: imgTotal, reclaimable: `${h(imgUnused)}${pct(imgUnused, imgTotal)}` },
        { type: "Containers", total: containers.length, active: running, size: ctrSize, reclaimable: `${h(ctrStopped)}${pct(ctrStopped, ctrSize)}` },
        { type: "Local Volumes", total: volumes.length, active: volumes.filter(volInUse).length, size: volTotal, reclaimable: `${h(volUnused)}${pct(volUnused, volTotal)}` },
        ...(podman ? [] : [{ type: "Build Cache", total: buildCache ? 57 : 0, active: 0, size: buildCache, reclaimable: h(buildCache) }]),
      ]
    },
    async logs(id, tail) {
      const c = byId(id)
      if (!c) return []
      const tpl = LOG_TEMPLATES[c.name] ?? LOG_TEMPLATES.default
      const arr = (logs[c.id] ??= Array.from({ length: 30 }, (_, i) => `2026-11-08T21:${String(i).padStart(2, "0")}:00Z ${tpl[i % tpl.length]}`))
      if (c.state === "running" && Math.random() < 0.7) arr.push(`2026-11-08T${now()}Z ${tpl[Math.floor(Math.random() * tpl.length)]}`)
      return arr.slice(-tail)
    },
    async containerAction(action, id) {
      await sleep(500)
      const c = byId(id)
      if (!c) throw new Error(`No such container: ${id}`)
      if (action === "rm") containers.splice(containers.indexOf(c), 1)
      if (action === "start" || action === "restart") { c.state = "running"; c.status = "Up 1 second" }
      if (action === "stop") { c.state = "exited"; c.status = "Exited (0) 1 second ago" }
      if (action === "pause") { c.state = "paused"; c.status = "Up 3 hours (Paused)" }
      if (action === "unpause") { c.state = "running"; c.status = "Up 3 hours" }
      return ""
    },
    async removeImage(id) {
      await sleep(400)
      const img = images.find((i) => i.id === id)
      if (img && containers.some((c) => c.image === `${img.repo}:${img.tag}`))
        throw new Error("conflict: unable to remove repository reference (must force) - container is using its referenced image")
      images = images.filter((i) => i.id !== id)
      return `Deleted: ${id}`
    },
    async removeContainers(ids) {
      await sleep(500)
      const removed: string[] = [], failed: { id: string; error: string }[] = []
      for (const id of ids) {
        const c = byId(id)
        if (!c) failed.push({ id, error: "No such container" })
        else if (c.state === "running" || c.state === "paused") failed.push({ id, error: `cannot remove container "${c.name}": container is running` })
        else { containers.splice(containers.indexOf(c), 1); removed.push(id) }
      }
      return { removed, failed }
    },
    async removeImages(ids) {
      await sleep(500)
      const removed: string[] = [], failed: { id: string; error: string }[] = []
      for (const id of ids) {
        const img = images.find((i) => i.id === id)
        if (!img) failed.push({ id, error: "No such image" })
        else if (imgInUse(img)) failed.push({ id, error: "image is being used by a container" })
        else { images = images.filter((i) => i !== img); removed.push(id) }
      }
      return { removed, failed }
    },
    async removeVolume(name) {
      await sleep(300)
      if (containers.some((c) => c.mounts.split(",").includes(name))) throw new Error(`remove ${name}: volume is in use`)
      volumes = volumes.filter((v) => v.name !== name)
      return ""
    },
    async prune(kind) {
      await sleep(700)
      if (kind === "builder" && podman) throw new Error(`"builder prune" doesn't exist in Podman`)
      if (kind === "containers" || kind === "system") {
        for (const c of containers.filter((c) => c.state === "exited")) containers.splice(containers.indexOf(c), 1)
      }
      if (kind === "images" || kind === "system") images = images.filter((i) => i.repo !== "<none>")
      if (kind === "images-all") images = images.filter(imgInUse)
      if (kind === "volumes") volumes = volumes.filter(volInUse)
      if (kind === "networks" || kind === "system") networks = 3
      if (kind === "builder" || kind === "system") buildCache = 0
      return "Total reclaimed space: (mock)"
    },
    async pull(ref) {
      await sleep(1500)
      const [repo, tag = "latest"] = ref.split(":")
      images.unshift({ id: "sha1" + Math.random().toString(16).slice(2, 10), repo, tag, size: 120 * MiB, created: "Just now" })
      return `Status: Downloaded newer image for ${repo}:${tag}`
    },
    async machineAction(action, profile) {
      await sleep(1500)
      const p = profiles.find((x) => x.name === profile)
      if (p) p.status = action === "stop" ? "Stopped" : "Running"
      return "done"
    },
    async copy() {},
    async openUrl() {},
  }
}

/** mock detection for the picker screen in demo mode */
export async function mockDetect(): Promise<EngineInfo[]> {
  await sleep(400)
  return [
    { engine: "docker", installed: true, running: true, version: "27.3.1", detail: "server 27.3.1 (mock)" },
    { engine: "podman", installed: true, running: true, version: "5.3.1", detail: "machine podman-machine-default running (mock)" },
  ]
}
