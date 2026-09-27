import { assertChatGptConversationUrl } from "./conversation-registry";
import type { CouncilManagedRuntime } from "./managed-runtime";
import type { CouncilStore } from "./store";

export interface CouncilOwnerRelayInput {
  leadConversationUrl: string;
  peerConversationUrl: string;
  peerAgentId: string;
  nonce: string;
  task: string;
}

export async function startCouncilOwnerRelay(
  store: CouncilStore,
  runtime: CouncilManagedRuntime,
  input: CouncilOwnerRelayInput,
  ownerToken?: string,
): Promise<{ leadAgentId: string; peerAgentId: string; leadConversationUrl: string; peerConversationUrl: string; nonce: string; wakeId: string }> {
  const project = runtime.activeProject();
  if (!project) throw new Error("A managed Council project must be active before starting a relay");
  const leadConversationUrl = assertChatGptConversationUrl(input.leadConversationUrl);
  const peerConversationUrl = assertChatGptConversationUrl(input.peerConversationUrl);
  if (leadConversationUrl === peerConversationUrl) throw new Error("Relay conversations must be distinct");
  const lead = runtime.supervisorAgents().find(agent => agent.id === project.leadAgentId);
  if (lead?.conversationUrl !== leadConversationUrl) throw new Error("Relay Lead is not bound to the requested exact conversation");
  const nonce = input.nonce.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{11,95}$/.test(nonce)) throw new Error("relay nonce is invalid");
  const task = input.task.trim();
  if (!task || task.length > 3_500) throw new Error("relay task is invalid");
  if (ownerToken && task.includes(ownerToken)) throw new Error("relay task contains owner-control material");
  const marker = `COUNCIL_RELAY:${nonce}:`;
  if (store.snapshot().wakes.some(wake => wake.reason.startsWith(marker))) {
    throw new Error("Relay nonce already has a wake; inspect the existing execution before creating a new intent");
  }

  const peer = runtime.prepareBoundRelayPeer(project.leadAgentId, input.peerAgentId, peerConversationUrl);
  const wake = store.wake({
    targetAgentId: project.leadAgentId,
    roomId: project.roomId,
    reason: `${marker}\nController task for the bound Lead. Relay peer agent ID: ${peer.id}. Use Council actions to hand off; do not create another peer or use another conversation.\n${task}`,
  });
  const delivered = await runtime.deliverWakeEvent(wake);
  if (!delivered) throw new Error("Controller relay wake could not be scheduled");
  return { leadAgentId: project.leadAgentId, peerAgentId: peer.id, leadConversationUrl, peerConversationUrl, nonce, wakeId: wake.id };
}
