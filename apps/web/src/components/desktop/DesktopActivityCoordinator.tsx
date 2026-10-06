import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { DesktopActivitySnapshot } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { buildDesktopActivitySnapshot } from "../../desktopActivity";
import { environmentPresentations, environmentSummaries } from "../../state/presentation";
import { environmentShell } from "../../state/shell";

// String equality keeps message-only shell updates from rerendering or sending IPC.
const activityAtom = Atom.make((get) =>
  JSON.stringify(
    buildDesktopActivitySnapshot(
      get(environmentSummaries.environmentIdsAtom).map((environmentId) => ({
        environmentId,
        label:
          get(environmentPresentations.presentationAtom(environmentId))?.entry.target.label ??
          "Environment",
        shell: get(environmentShell.stateValueAtom(environmentId)),
      })),
    ),
  ),
);

export function DesktopActivityCoordinator() {
  const snapshot = useAtomValue(activityAtom);
  const navigate = useNavigate();
  useEffect(() => {
    const value: DesktopActivitySnapshot = JSON.parse(snapshot);
    void window.desktopBridge?.setActivitySnapshot?.(value).catch(() => undefined);
  }, [snapshot]);
  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onActivityOpenThread?.((params) => {
      void navigate({ to: "/$environmentId/$threadId", params });
    });
    return unsubscribe;
  }, [navigate]);
  useEffect(
    () => () => {
      void window.desktopBridge?.setActivitySnapshot?.(null).catch(() => undefined);
    },
    [],
  );
  return null;
}
