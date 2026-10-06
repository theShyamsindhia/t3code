import * as InteractionMcpService from "../../InteractionMcpService.ts";
import { InteractionToolkit } from "./tools.ts";

export const layer = InteractionToolkit.toLayer({
  t3_widget_present: InteractionMcpService.presentWidget,
  t3_interaction_present: InteractionMcpService.present,
});
