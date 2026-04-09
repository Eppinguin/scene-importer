import OBR from "@owlbear-rodeo/sdk";
import { useEffect, useState } from "react";

/**
 * Render children only after OBR is ready.
 * Outside plugin runtime we render immediately for local development.
 */
export function PluginGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(!OBR.isAvailable);

  useEffect(() => {
    if (!OBR.isAvailable) {
      return;
    }

    return OBR.onReady(() => {
      setReady(true);
    });
  }, []);

  if (!ready) {
    return null;
  }

  return <>{children}</>;
}
