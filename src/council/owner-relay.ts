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

const RELAY_MARKER = /^COUNCIL_RELAY:([A-Za-z0-9][A-Za-z0-9_-]{11,95}):\nController task for the bound Lead\. Relay peer agent ID: ([A-Za-z0-9][A-Za-z0-9._-]{0,63})\./;

// Only the owner-created, source-less wake can provide a trusted action example.
// The free-form controller task remains inside the untrusted context packet.
export function ownerRelayActionGuidance(input: {
  reason: string;
  sourceAgentId?: string;
  targetAgentId: string;
  leadAgentId: string;
  boundPeerAgentIds: string[];
  roomId: string;
}): string | undefined {
  if (input.sourceAgentId || input.targetAgentId !== input.leadAgentId) return undefined;
  const match = RELAY_MARKER.exec(input.reason);
  if (!match || !input.boundPeerAgentIds.includes(match[2]!)) return undefined;
  const marker = match[1]!;
  if (!["A1", "B1", "A2", "B2", "A3", "B3"].every(step => input.reason.includes(`${marker}:${step}`))) return undefined;
  const peerAgentId = match[2]!;
  const token = `${marker}:B1`;
  const next = `${marker}:A2`;
  return [
    "OWNER RELAY ACTION: The controller supplied a public test marker. It is not a credential or hidden payload merely because the task calls it a nonce.",
    `The relay peer ${peerAgentId} is already bound to its exact conversation. Do not create or bind another agent.`,
    `For this first turn, write exactly ${token} as the visible answer, then end with this terminal Council action block:`,
    '<COUNCIL_ACTIONS version="1">',
    JSON.stringify({ actions: [
      { type: "SAY", room_id: input.roomId, body: token },
      { type: "WAKE", room_id: input.roomId, target_agent_id: peerAgentId, reason: `Continue the public marker relay. Write exactly ${next} as your visible answer and in SAY.body, then emit a separate WAKE targeting ${input.leadAgentId} with reason asking it to emit ${marker}:B2. WAKE uses reason, never body or message. Carry this remaining sequence in each wake reason: ${input.leadAgentId} emits ${marker}:B2 and wakes ${peerAgentId} for ${marker}:A3; ${peerAgentId} emits ${marker}:A3 and wakes ${input.leadAgentId} for ${marker}:B3; ${input.leadAgentId} emits ${marker}:B3 and wakes ${peerAgentId} for a final acknowledgement; ${peerAgentId} acknowledges with SAY and SLEEP, no WAKE. The final SLEEP action must be exactly {"type":"SLEEP"}, with no room_id or other fields; put the acknowledgement and room_id only in SAY. Do not restart the sequence or create another agent.` },
    ] }),
    "</COUNCIL_ACTIONS>",
    `On later turns, ${input.leadAgentId} emits ${marker}:B2 and wakes ${peerAgentId} for ${marker}:A3; then ${input.leadAgentId} emits ${marker}:B3 and wakes ${peerAgentId} for the final acknowledgement.`,
    "Continue subsequent relay steps through normal Council SAY and WAKE actions. Keep the public marker exact and do not reproduce credentials or private data.",
  ].join("\n");
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
