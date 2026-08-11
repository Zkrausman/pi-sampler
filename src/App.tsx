import { ColorPalette } from "./components/ColorPalette";
import { ExcalidrawViewer } from "./components/ExcalidrawViewer";
import { Soundboard } from "./components/Soundboard";
import { ThemeProvider } from "./ui/ThemeProvider";

export default function App() {
  return (
    <ThemeProvider>
      <main>
        <ColorPalette />
        <Soundboard />
        <h1>Local Excalidraw viewer</h1>
        <ExcalidrawViewer sceneUrl="/diagrams/sample.excalidraw" />
      </main>
    </ThemeProvider>
  );
}
