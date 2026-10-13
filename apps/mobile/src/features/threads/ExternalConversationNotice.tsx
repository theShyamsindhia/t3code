import {
  externalSessionSource,
  WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useNavigation, StackActions } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

const importExternalSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "external-conversation:takeover",
  tag: WS_METHODS.agentSessionsImport,
});

export function ExternalConversationNotice(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const importSession = useAtomCommand(importExternalSession, { reportFailure: false });
  const navigation = useNavigation();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = externalSessionSource(props.threadId);
  const takeOver = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await importSession({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          takeOverThreadId: props.threadId,
        },
      });
      if (result._tag !== "Success" || result.value.threadId === undefined) {
        setError(
          "Could not take over this conversation. Your original session is unchanged. Try again.",
        );
        return;
      }
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: props.environmentId,
          threadId: result.value.threadId,
        }),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="gap-2 rounded-[20px] border border-border-subtle bg-card-alt p-4">
      <Text className="text-sm text-foreground-secondary">
        Conversation from {source}. History refreshes every minute.
      </Text>
      <Text className="text-sm text-foreground-secondary">
        Stop work in {source} before sending messages from T3.
      </Text>
      {error !== null && (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      <View className="flex-row">
        <RequestActionButton
          disabled={busy}
          label={busy ? "Loading conversation…" : "Continue in T3"}
          onPress={() =>
            Alert.alert(
              "Continue in T3?",
              `Stop work in ${source} first. T3 will resume this session when you send your next message.`,
              [
                { text: "Cancel", style: "cancel" },
                { text: "I've stopped it", onPress: () => void takeOver() },
              ],
            )
          }
        />
      </View>
    </View>
  );
}
