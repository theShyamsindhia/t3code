import {
  type EnvironmentId,
  type ExternalSessionCandidate,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

const externalSessions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-sessions",
  tag: WS_METHODS.externalSessions,
});
type Scan = {
  environmentId: EnvironmentId;
  label: string;
  candidates: readonly ExternalSessionCandidate[];
  selected: readonly ThreadId[];
  error: string | null;
};

export function ExternalSessionsSheet(props: {
  environments: readonly { environmentId: EnvironmentId; label: string }[];
  onClose: () => void;
}) {
  const manage = useAtomCommand(externalSessions, { reportFailure: false });
  const [scans, setScans] = useState<Scan[]>([]);
  const [busy, setBusy] = useState(true);
  const [environments] = useState(props.environments);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      environments.map(async (environment): Promise<Scan> => {
        const result = await manage({ environmentId: environment.environmentId, input: {} });
        const candidates = result._tag === "Success" ? result.value.candidates : [];
        return {
          ...environment,
          candidates,
          selected: candidates.filter((c) => c.tracked).map((c) => c.threadId),
          error: result._tag === "Success" ? null : "Could not scan. Reopen Sync to try again.",
        };
      }),
    ).then((results) => {
      if (!cancelled) {
        setScans(results);
        setBusy(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environments, manage]);
  const save = async () => {
    setBusy(true);
    let failed = false;
    for (const scan of scans) {
      if (scan.error) continue;
      const result = await manage({
        environmentId: scan.environmentId,
        input: { threadIds: scan.selected },
      });
      if (result._tag !== "Success") {
        failed = true;
        setScans((items) =>
          items.map((item) =>
            item.environmentId === scan.environmentId
              ? { ...item, error: "Could not save. Reopen Sync to try again." }
              : item,
          ),
        );
      }
    }
    setBusy(false);
    if (!failed) props.onClose();
  };
  const count = scans.reduce((total, scan) => total + scan.selected.length, 0);
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy || scans.length === 0) props.onClose();
      }}
    >
      <View className="flex-1 items-center justify-center bg-backdrop px-6">
        <View className="max-h-[80%] w-full max-w-md gap-4 rounded-3xl bg-screen p-6">
          <Text accessibilityRole="header" className="text-xl font-t3-semibold">
            Sync conversations
          </Text>
          <Text className="text-sm text-foreground-secondary">
            Choose which Codex and Claude Code chats to show in T3. Only selected chats refresh
            automatically. Uncheck a chat to archive its preview.
          </Text>
          <ScrollView className="grow-0" contentContainerStyle={{ gap: 12 }}>
            {busy && scans.length === 0 ? <Text>Looking for conversations…</Text> : null}
            {!busy && scans.length === 0 ? (
              <Text>Connect an environment to find conversations.</Text>
            ) : null}
            {scans.map((scan) => (
              <View key={scan.environmentId} className="gap-2">
                {scans.length > 1 ? <Text className="font-t3-semibold">{scan.label}</Text> : null}
                {scan.error ? (
                  <Text accessibilityRole="alert" className="text-danger-foreground">
                    {scan.error}
                  </Text>
                ) : null}
                {!scan.error && scan.candidates.length === 0 ? (
                  <Text>No recent external conversations found.</Text>
                ) : null}
                {scan.candidates.map((candidate) => (
                  <Pressable
                    key={candidate.threadId}
                    accessibilityRole="checkbox"
                    accessibilityState={{
                      checked: scan.selected.includes(candidate.threadId),
                      disabled: busy || scan.error !== null,
                    }}
                    disabled={busy || scan.error !== null}
                    className="flex-row items-center gap-3 py-2"
                    onPress={() =>
                      setScans((items) =>
                        items.map((item) =>
                          item.environmentId === scan.environmentId
                            ? {
                                ...item,
                                selected: item.selected.includes(candidate.threadId)
                                  ? item.selected.filter((id) => id !== candidate.threadId)
                                  : [...item.selected, candidate.threadId],
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    <Text>{scan.selected.includes(candidate.threadId) ? "☑" : "☐"}</Text>
                    <View className="min-w-0 flex-1">
                      <Text numberOfLines={2}>{candidate.title}</Text>
                      <Text className="text-xs text-foreground-secondary">
                        {candidate.projectTitle} ·{" "}
                        {candidate.source === "codex" ? "Codex" : "Claude Code"} ·{" "}
                        {new Date(candidate.updatedAt).toLocaleDateString()}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ))}
          </ScrollView>
          <View className="flex-row justify-end gap-3">
            <RequestActionButton
              label="Cancel"
              disabled={busy && scans.length > 0}
              onPress={props.onClose}
            />
            <RequestActionButton
              label={busy && scans.length > 0 ? "Saving…" : `Track selected (${count})`}
              disabled={busy || !scans.some((scan) => !scan.error)}
              onPress={() => void save()}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
