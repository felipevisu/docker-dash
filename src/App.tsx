// @ts-nocheck
// Preview no navegador (bun run preview): sempre com dados simulados,
// já que o navegador não pode chamar os CLIs do Docker/Podman.
import { TUI } from "@gridland/web"
import { Root } from "./Root"
import { mockBackend, mockDetect } from "./backend/mock"

const engine = new URLSearchParams(location.search).get("engine")

export function App() {
  return (
    <TUI style={{ width: "100vw", height: "100vh" }} backgroundColor="#0e1117" fontSize={14}>
      <Root initialEngine={engine === "docker" || engine === "podman" ? engine : null} detect={mockDetect} makeBackend={(e) => mockBackend(e)} />
    </TUI>
  )
}
