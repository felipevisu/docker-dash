// Backend Docker + Colima: chama os CLIs `docker` e `colima` com execFile (argv em array, sem shell).
// O Docker usa o contexto ativo; com Colima rodando ele já aponta para o socket do Colima.
import type { Backend, Machine, Container, Image, Stat, Volume, DiskUsage, PruneKind } from "./types"
import { parsePair, parseSize, clean } from "../lib/format"
import { run, jsonLines, lastLine, copyToClipboard, exitCodeOf, composeProject, removeEach } from "./exec"

export function dockerBackend(): Backend {
  const docker = (args: string[], timeout?: number) => run("docker", args, timeout)

  return {
    engine: "docker",
    vmName: "colima",
    cli: "docker",

    async machines() {
      const { stdout } = await run("colima", ["list", "--json"], 15_000)
      return jsonLines(stdout).map((p): Machine => ({
        name: p.name ?? "default",
        status: p.status ?? "?",
        arch: p.arch ?? "",
        cpus: Number(p.cpus ?? 0),
        memory: Number(p.memory ?? 0),
        disk: Number(p.disk ?? 0),
        runtime: p.runtime ?? "",
        address: p.address ?? "",
      }))
    },

    async containers() {
      const { stdout } = await docker(["ps", "-a", "--format", "{{json .}}"])
      return jsonLines(stdout).map((c): Container => ({
        id: c.ID,
        name: c.Names,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports ?? "",
        command: (c.Command ?? "").replace(/^"|"$/g, ""),
        createdAt: c.CreatedAt ?? "",
        networks: c.Networks ?? "",
        mounts: c.Mounts ?? "",
        exitCode: exitCodeOf(c.Status),
        project: composeProject(c.Labels),
      }))
    },

    async stats() {
      const { stdout } = await docker(["stats", "--no-stream", "--format", "{{json .}}"], 20_000)
      return jsonLines(stdout).map((s): Stat => {
        const [memUsed, memLimit] = parsePair(s.MemUsage)
        const [netRx, netTx] = parsePair(s.NetIO)
        const [blockRead, blockWrite] = parsePair(s.BlockIO)
        return {
          id: s.ID,
          name: s.Name,
          cpu: parseFloat(s.CPUPerc) || 0,
          memUsed,
          memLimit,
          memPerc: parseFloat(s.MemPerc) || 0,
          netRx, netTx, blockRead, blockWrite,
          pids: Number(s.PIDs) || 0,
        }
      })
    },

    async images() {
      const { stdout } = await docker(["images", "--format", "{{json .}}"])
      return jsonLines(stdout).map((i): Image => ({
        id: i.ID,
        repo: i.Repository,
        tag: i.Tag,
        size: parseSize(i.Size),
        created: i.CreatedSince ?? i.CreatedAt ?? "",
      }))
    },

    async volumes() {
      const { stdout } = await docker(["volume", "ls", "--format", "{{json .}}"])
      return jsonLines(stdout).map((v): Volume => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint ?? "" }))
    },

    async diskUsage() {
      const { stdout } = await docker(["system", "df", "--format", "{{json .}}"])
      return jsonLines(stdout).map((r): DiskUsage => ({
        type: r.Type,
        total: Number(r.TotalCount) || 0,
        active: Number(r.Active) || 0,
        size: parseSize(r.Size),
        reclaimable: r.Reclaimable ?? "",
      }))
    },

    async logs(id, tail) {
      const { stdout, stderr } = await docker(["logs", "--tail", String(tail), id], 10_000)
      // docker logs escreve stdout e stderr do container separados; juntamos os dois
      // \r (barras de progresso) e ANSI viram texto puro; cada linha é limpa antes de chegar à UI
      return (stdout + stderr)
        .split("\n")
        .map((l) => clean(l.split("\r").pop() ?? ""))
        .filter((l) => l.trim().length > 0)
        .slice(-tail)
    },

    async containerAction(action, id) {
      const args = action === "rm" ? ["rm", "-f", id] : [action, id]
      await docker(args, 60_000)
      return ""
    },

    async removeImage(id) {
      const { stdout } = await docker(["rmi", id], 60_000)
      return lastLine(stdout)
    },

    // sem -f de propósito: um container rodando (ou imagem em uso) falha em vez de ser removido
    removeContainers: (ids) => removeEach("docker", ["rm"], ids),
    removeImages: (ids) => removeEach("docker", ["rmi"], ids),

    async removeVolume(name) {
      await docker(["volume", "rm", name])
      return ""
    },

    async prune(kind: PruneKind) {
      const args: Record<PruneKind, string[]> = {
        containers: ["container", "prune", "-f"],
        images: ["image", "prune", "-f"],
        "images-all": ["image", "prune", "-a", "-f"],
        volumes: ["volume", "prune", "-a", "-f"],
        networks: ["network", "prune", "-f"],
        builder: ["builder", "prune", "-a", "-f"],
        system: ["system", "prune", "-f"],
      }
      try {
        const { stdout } = await docker(args[kind], 10 * 60_000)
        return lastLine(stdout)
      } catch (e: any) {
        // Docker < 23 não tem `volume prune -a` (e lá o prune já remove volumes nomeados)
        if (kind === "volumes" && /unknown (shorthand )?flag/i.test(e.message)) {
          const { stdout } = await docker(["volume", "prune", "-f"], 10 * 60_000)
          return lastLine(stdout)
        }
        throw e
      }
    },

    async pull(ref) {
      const { stdout } = await docker(["pull", ref], 15 * 60_000)
      return lastLine(stdout)
    },

    async machineAction(action, profile) {
      // start/stop podem levar minutos (sobe/desliga a VM)
      const { stdout, stderr } = await run("colima", [action, "--profile", profile], 15 * 60_000)
      return lastLine(stderr || stdout).replace(/^time="[^"]*"\s*level=\w+\s*msg=/, "").replace(/^"|"$/g, "")
    },

    copy: copyToClipboard,

    async openUrl(url) {
      await run("open", [url])
    },
  }
}
