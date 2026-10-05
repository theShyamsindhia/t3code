import * as InteractionMcpService from "../../InteractionMcpService.ts";
import { InteractionToolkit } from "./tools.ts";

export const InteractionHandlersLive = InteractionToolkit.toLayer({
  t3_widget_present: InteractionMcpService.presentWidget,
  t3_interaction_present: InteractionMcpService.present,
});
