// @ts-nocheck
// Browser preview (bun run preview): always uses mock data,
// since the browser can't call the Docker/Podman CLIs.
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
