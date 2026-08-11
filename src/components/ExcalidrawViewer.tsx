import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { useEffect, useState } from "react";
import { loadLocalExcalidrawScene, type LocalExcalidrawScene } from "./excalidrawScene";
import "./ExcalidrawViewer.css";

export type ExcalidrawViewerProps = Readonly<{
  /** A local file served by Vite from public/diagrams/. */
  sceneUrl?: string;
}>;

const DEFAULT_SCENE_URL = "/diagrams/sample.excalidraw";

export function ExcalidrawViewer({ sceneUrl = DEFAULT_SCENE_URL }: ExcalidrawViewerProps) {
  const [scene, setScene] = useState<LocalExcalidrawScene | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setScene(null);
    setError(null);

    loadLocalExcalidrawScene(sceneUrl).then(
      (loadedScene) => {
        if (active) setScene(loadedScene);
      },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load diagram");
      },
    );

    return () => {
      active = false;
    };
  }, [sceneUrl]);

  if (error) return <p className="excalidraw-viewer__message" role="alert">{error}</p>;
  if (!scene) return <p className="excalidraw-viewer__message">Loading local diagram…</p>;

  return (
    <section className="excalidraw-viewer" aria-label="Excalidraw diagram">
      <Excalidraw
        initialData={scene as ExcalidrawInitialDataState}
        // Local viewer policy: never render scene URLs as remote embedded documents.
        renderEmbeddable={() => null}
      />
    </section>
  );
}
