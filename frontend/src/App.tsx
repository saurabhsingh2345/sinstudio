import { useEffect, useState } from "react";
import { ProjectList } from "./components/ProjectList";
import { StudioView } from "./components/studio/StudioView";
import { JobsOverlay } from "./components/JobsOverlay";
import { Toasts } from "./components/Toasts";
import { AuthGate } from "./components/AuthGate";
import { startJobStream } from "./jobs";

export function App() {
  const [projectId, setProjectId] = useState<string | null>(() =>
    location.hash.startsWith("#/p/") ? location.hash.slice(4) : null
  );

  useEffect(() => {
    startJobStream();
    const onHash = () =>
      setProjectId(location.hash.startsWith("#/p/") ? location.hash.slice(4) : null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const open = (id: string) => {
    location.hash = `#/p/${id}`;
    setProjectId(id);
  };
  const home = () => {
    location.hash = "";
    setProjectId(null);
  };

  return (
    <AuthGate>
      {projectId ? (
        <StudioView key={projectId} projectId={projectId} onHome={home} />
      ) : (
        <ProjectList onOpen={open} />
      )}
      <JobsOverlay />
      <Toasts />
    </AuthGate>
  );
}
