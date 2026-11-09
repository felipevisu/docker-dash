// Contrato entre a UI e quem fala com o motor de containers.
// `docker.ts` (Docker + Colima) e `podman.ts` (Podman + podman machine) usam os CLIs reais;
// `mock.ts` simula tudo (para testar sem nenhum dos dois).

export type Engine = "docker" | "podman"

/** Informações de detecção mostradas na tela de escolha do motor */
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
  mounts: string // nomes de volumes/caminhos separados por vírgula
  /** código de saída quando parado ("Exited (255)" → 255) */
  exitCode?: number | null
  /** projeto do docker compose, se houver */
  project?: string
}

/** resultado de remoções explícitas, item a item */
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
  /** containers que usam o volume, quando o backend sabe informar diretamente */
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
  /** nome do gerenciador da VM: "colima" ou "podman machine" */
  vmName: string
  /** CLI usada nos comandos sugeridos (docker exec / podman exec) */
  cli: string
  mock?: boolean
  /** ações que este motor não suporta (a UI esconde os atalhos) */
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
  /** remove exatamente estes containers, um a um, SEM forçar (container rodando falha em vez de ser parado) */
  removeContainers(ids: string[]): Promise<RemoveResult>
  /** remove exatamente estas imagens, SEM forçar (imagem em uso falha) */
  removeImages(ids: string[]): Promise<RemoveResult>
  removeVolume(name: string): Promise<string>
  prune(kind: PruneKind): Promise<string>
  pull(ref: string): Promise<string>
  machineAction(action: MachineAction, profile: string): Promise<string>
  copy(text: string): Promise<void>
  openUrl(url: string): Promise<void>
}
