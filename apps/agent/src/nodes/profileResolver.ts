import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function profileResolverNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  return recordNodeEvent(state, "profileResolver", "completed", {
    manifest_version: state.manifest_version
  });
}
