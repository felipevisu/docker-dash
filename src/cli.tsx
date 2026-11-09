#!/usr/bin/env bun
// @ts-nocheck
// Entrada do terminal (e do binário compilado `docker-dash`).
import pkg from "../package.json"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)

if (args.includes("-h") || args.includes("--help")) {
  console.log(`docker-dash ${pkg.version}
Dashboard de terminal para Docker (Colima) e Podman.

Uso:
  docker-dash                 abre com o último motor escolhido (ou a tela de escolha)
  docker-dash --docker        abre direto com Docker + Colima
  docker-dash --podman        abre direto com Podman + podman machine
  docker-dash --mock          dados simulados (combine com --docker/--podman)
  docker-dash --version       mostra a versão

Também dá para fixar o motor com a variável DOCKER_DASH_ENGINE=docker|podman.
Dentro do app: ? mostra os atalhos, C abre a limpeza, E troca de motor.`)
  process.exit(0)
}
if (args.includes("-v") || args.includes("--version")) {
  console.log(pkg.version)
  process.exit(0)
}

// O binário pode ser aberto de lugares onde o PATH não tem o Homebrew.
const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME}/.local/bin`]
const path = (process.env.PATH ?? "").split(":")
process.env.PATH = [...path, ...extra.filter((p) => !path.includes(p))].join(":")

// motor escolhido por flag/variável
const engineArg = args.find((a) => a.startsWith("--engine="))?.split("=")[1]
const fromFlag = args.includes("--podman") ? "podman" : args.includes("--docker") ? "docker" : engineArg ?? process.env.DOCKER_DASH_ENGINE
const valid = (e) => (e === "docker" || e === "podman" ? e : null)

// lembra a última escolha para pré-selecionar na próxima vez
const configDir = join(process.env.HOME ?? ".", ".config", "docker-dash")
const configFile = join(configDir, "config.json")
let lastEngine = null
try { lastEngine = JSON.parse(readFileSync(configFile, "utf8")).engine ?? null } catch {}
// flag/variável > última escolha salva > tela de escolha (E no app reabre a escolha)
const initialEngine = valid(fromFlag) ?? valid(lastEngine)
const saveEngine = (engine) => {
  try {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(configFile, JSON.stringify({ engine }, null, 2))
  } catch {}
}

const mock = args.includes("--mock")
const { createCliRenderer, createRoot } = await import("@gridland/bun")
const { Root } = await import("./Root")
const { dockerBackend } = await import("./backend/docker")
const { podmanBackend } = await import("./backend/podman")
const { mockBackend, mockDetect } = await import("./backend/mock")
const { detectEngines } = await import("./backend/exec")

const renderer = await createCliRenderer({ exitOnCtrlC: true })

createRoot(renderer).render(
  <Root
    initialEngine={initialEngine}
    lastEngine={lastEngine}
    detect={mock ? mockDetect : detectEngines}
    makeBackend={(engine) => (mock ? mockBackend(engine) : engine === "podman" ? podmanBackend() : dockerBackend())}
    onEngineChosen={mock ? undefined : saveEngine}
    onExit={() => {
      renderer.destroy()
      process.exit(0)
    }}
  />,
)
