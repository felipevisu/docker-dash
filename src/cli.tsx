#!/usr/bin/env bun
// @ts-nocheck
// Terminal entry point (and of the compiled `docker-dash` binary).
import pkg from "../package.json"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)

if (args.includes("-h") || args.includes("--help")) {
  console.log(`docker-dash ${pkg.version}
Terminal dashboard for Docker (Colima) and Podman.

Usage:
  docker-dash                 opens with the last chosen engine (or the engine picker)
  docker-dash --docker        opens straight into Docker + Colima
  docker-dash --podman        opens straight into Podman + podman machine
  docker-dash --mock          mock data (combine with --docker/--podman)
  docker-dash --version       shows the version

You can also pin the engine with DOCKER_DASH_ENGINE=docker|podman.
Inside the app: ? shows shortcuts, C opens cleanup, E switches engine.`)
  process.exit(0)
}
if (args.includes("-v") || args.includes("--version")) {
  console.log(pkg.version)
  process.exit(0)
}

// The binary may be launched from places where PATH lacks Homebrew.
const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME}/.local/bin`]
const path = (process.env.PATH ?? "").split(":")
process.env.PATH = [...path, ...extra.filter((p) => !path.includes(p))].join(":")

// engine chosen via flag/env var
const engineArg = args.find((a) => a.startsWith("--engine="))?.split("=")[1]
const fromFlag = args.includes("--podman") ? "podman" : args.includes("--docker") ? "docker" : engineArg ?? process.env.DOCKER_DASH_ENGINE
const valid = (e) => (e === "docker" || e === "podman" ? e : null)

// remember the last choice to preselect it next time
const configDir = join(process.env.HOME ?? ".", ".config", "docker-dash")
const configFile = join(configDir, "config.json")
let lastEngine = null
try { lastEngine = JSON.parse(readFileSync(configFile, "utf8")).engine ?? null } catch {}
// flag/env var > last saved choice > engine picker (E in the app reopens the picker)
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
