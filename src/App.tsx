import { ExcalidrawViewer } from "./components/ExcalidrawViewer";
import { ThemeProvider } from "./ui/ThemeProvider";

export default function App() {
  return (
    <ThemeProvider>
      <main>
        <h1>Local Excalidraw viewer</h1>
        <ExcalidrawViewer sceneUrl="/diagrams/sample.excalidraw" />
      </main>
    </ThemeProvider>
  );
}
