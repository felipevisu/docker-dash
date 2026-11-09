// Contract between the UI and whatever talks to the container engine.
// `docker.ts` (Docker + Colima) and `podman.ts` (Podman + podman machine) use the real CLIs;
// `mock.ts` fakes everything (to test without either).

export type Engine = "docker" | "podman"

/** Detection info shown on the engine picker screen */
export interface EngineInfo {
  engine: Engine
  installed: boolean
  running: boolean
  version: string
  detail: string
}

export interface Machine {
  name: string
  status: string // "Running" | "Stopped" | ...
  arch: string
  cpus: number
  memory: number // bytes
  disk: number // bytes
  runtime: string
  address: string
}

export interface Container {
  id: string
  name: string
  image: string
  state: string // running | exited | paused | restarting | created | dead
  status: string // "Up 3 hours", "Exited (0) 2 days ago"
  ports: string
  command: string
  createdAt: string
  networks: string
  mounts: string // comma-separated volume names/paths
  /** exit code when stopped ("Exited (255)" → 255) */
  exitCode?: number | null
  /** docker compose project, if any */
  project?: string
}

/** result of explicit removals, item by item */
export interface RemoveResult { removed: string[]; failed: { id: string; error: string }[] }

export interface Stat {
  id: string
  name: string
  cpu: number // %
  memUsed: number // bytes
  memLimit: number // bytes
  memPerc: number
  netRx: number
  netTx: number
  blockRead: number
  blockWrite: number
  pids: number
}

export interface Image {
  id: string
  repo: string
  tag: string
  size: number // bytes
  created: string
}

export interface Volume {
  name: string
  driver: string
  mountpoint: string
  /** containers using the volume, when the backend can tell directly */
  users?: string[]
}

export interface DiskUsage {
  type: string
  total: number
  active: number
  size: number
  reclaimable: string
}

export type ContainerAction = "start" | "stop" | "restart" | "pause" | "unpause" | "rm"
export type PruneKind = "containers" | "images" | "images-all" | "volumes" | "networks" | "builder" | "system"
export type MachineAction = "start" | "stop" | "restart"

export interface Backend {
  engine: Engine
  /** VM manager name: "colima" or "podman machine" */
  vmName: string
  /** CLI used in suggested commands (docker exec / podman exec) */
  cli: string
  mock?: boolean
  /** actions this engine doesn't support (the UI hides their shortcuts) */
  unsupported?: PruneKind[]
  machines(): Promise<Machine[]>
  containers(): Promise<Container[]>
  stats(): Promise<Stat[]>
  images(): Promise<Image[]>
  volumes(): Promise<Volume[]>
  diskUsage(): Promise<DiskUsage[]>
  logs(id: string, tail: number): Promise<string[]>
  containerAction(action: ContainerAction, id: string): Promise<string>
  removeImage(id: string): Promise<string>
  /** removes exactly these containers, one by one, WITHOUT force (a running container fails instead of being stopped) */
  removeContainers(ids: string[]): Promise<RemoveResult>
  /** removes exactly these images, WITHOUT force (an image in use fails) */
  removeImages(ids: string[]): Promise<RemoveResult>
  removeVolume(name: string): Promise<string>
  prune(kind: PruneKind): Promise<string>
  pull(ref: string): Promise<string>
  machineAction(action: MachineAction, profile: string): Promise<string>
  copy(text: string): Promise<void>
  openUrl(url: string): Promise<void>
}
