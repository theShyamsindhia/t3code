import {
  ChatWidgetPresentation,
  InteractionPresentation,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const InteractionToolkit = Toolkit.make(
  Tool.make("t3_widget_present", {
    description:
      "Render a custom interactive widget inline in this chat when interacting helps more than prose: for example a slider with a live diagram, a comparison, a small calculator, a map of ideas, or a sorting exercise. Supply a compact self-contained HTML fragment with inline style and script, under 6 KB for the entire input. No imports, external resources, network, forms submitting, navigation, or continuous animations. It runs isolated from the app. Focus on one thing the user can explore or decide, with immediate feedback such as a concrete example or a changing diagram. Make the content understandable on its own: a plain canvas, readable labels, restrained color, and space between related elements. Avoid decorative headers, footer instructions, nested cards, badges, shadows, and repeating the same explanation around the controls. Use accessible labels and keyboard controls, responsive layout, and CSS variables --background, --foreground, --muted, --accent, --border (usable directly as colors); the host matches the chat theme. For an answer-bearing interaction call window.t3.setResponse(plainText) with a concise, meaningful summary (max 4000 characters) only after user interaction. This stages an editable reply below the widget; it does not send it. Do not create a Send-to-agent button inside the widget. Optional window.t3.initialResponse is the last saved reply, not a widget-state store. Reopening resets the widget's internal controls; keep the saved response understandable independently. T3 shows the title as a quiet caption; make it the question or purpose. Description is optional reading under Instructions, so keep essential labels inside the widget. Do not repeat the title or add reply instructions; T3 handles the reply. Use only the height the content needs, within 160–640 CSS pixels. Accompany it with a brief text alternative for mobile/unsupported clients, not a second walkthrough of the whole interface. This tool returns immediately. Finish the turn; never poll or repeat while awaiting a response. Use ordinary text for simple questions, and t3_interaction_present for existing card grouping.",
    parameters: ChatWidgetPresentation,
    success: Schema.Struct({ message: Schema.String, title: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_interaction_present", {
    description:
      "Show a small Shared space beside this chat when comparing examples or grouping ideas would help the user express a preference. Start with 2–4 plain-text items and 2–3 meaningful groups, focusing on one decision. Avoid a questionnaire covering every possible situation. Only expand when the user asks for more detail (maximum 12 items and 4 groups); null groupId leaves an item unsorted. Emphasis highlights an item without implying the user chose it. Ask one clear question. The user can move, reorder, annotate, and send their arrangement as a normal reply. This tool returns immediately, not their answer. Finish the turn; do not poll or repeat the call while waiting. Each call is a separate presentation retained in history, so preserve item IDs when revising an idea. Use text for simpler questions. Never supply HTML, executable UI, or pretend user preferences. Keep the complete input below 6 KB. Mobile and other clients can answer your accompanying text summary.",
    parameters: InteractionPresentation,
    success: Schema.Struct({ message: Schema.String, title: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
