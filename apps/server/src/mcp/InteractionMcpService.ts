import { type ChatWidgetPresentation, type InteractionPresentation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { readMutationCaller } from "./threadAccess.ts";

/** The provider's persisted tool call is the presentation; no second copy of chat state. */
export const present = Effect.fn("InteractionMcpService.present")(function* (
  input: InteractionPresentation,
) {
  const { scope } = yield* readMutationCaller();
  yield* McpInvocationContext.requireThreadScope(scope, "t3_interaction_present");
  return {
    message:
      "This presentation is available in Shared space on T3 web and desktop. Finish your turn and let the user respond; do not poll. Their arrangement and notes arrive as a normal message. Also summarize the choices in your reply so clients without the panel can answer in text.",
    title: input.title,
  };
});

export const presentWidget = Effect.fn("InteractionMcpService.presentWidget")(function* (
  input: ChatWidgetPresentation,
) {
  const { scope } = yield* readMutationCaller();
  yield* McpInvocationContext.requireThreadScope(scope, "t3_widget_present");
  return {
    title: input.title,
    message:
      "The widget is available inline in this chat on T3 web and desktop. Finish your turn; do not poll. Only the user's explicit Send reply sends a response. Also describe the interaction in text for clients without widgets. Each call creates a separate widget in history.",
  };
});
