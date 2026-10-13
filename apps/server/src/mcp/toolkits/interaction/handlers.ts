import * as InteractionMcpService from "../../InteractionMcpService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { InteractionToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(InteractionToolkit, {
  t3_widget_present: McpToolAccess.readsAsCaller(InteractionMcpService.presentWidget),
  t3_interaction_present: McpToolAccess.readsAsCaller(InteractionMcpService.present),
});
