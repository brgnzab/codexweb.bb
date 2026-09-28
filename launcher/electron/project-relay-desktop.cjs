// Native desktop read_thread adapter. It consumes structured tool results, never summaries.
function readSnapshot(value) {
  if (value?.isError) throw new Error("Desktop chat read failed");
  if (value?.content && !value?.thread) {
    const blocks = value.content.filter(item => item.type === "text");
    if (blocks.length !== 1) throw new Error("Ambiguous desktop chat read result");
    value = JSON.parse(blocks[0].text);
  }
  if (value?.schemaVersion !== 1 || !value.thread || !Array.isArray(value.turns)) throw new Error("Unsupported desktop chat read format");
  return value;
}
function validateTarget(job, raw) {
  const snapshot = readSnapshot(raw);
  const allowedKinds = job.target.kind === "work" ? ["chatgpt", "codex"] : job.target.kind === "codex" ? ["codex"] : [];
  if (snapshot.thread.id !== job.target.conversation || !allowedKinds.includes(snapshot.thread.kind)) throw new Error("Desktop read does not match the owner-bound chat and kind");
  return snapshot;
}
function submittedInput(item) {
  if (item.type === "userMessage") {
    if (item.truncated || item.content?.some(part => part.truncated)) throw new Error("Desktop input is truncated; read the full delivery before proceeding");
    if (item.content?.length === 1 && item.content[0].type === "text") return { prompt: item.content[0].text };
  }
  if (item.type !== "functionCallOutput" || item.namespace !== "codex_app" || item.name !== "send_message_to_thread") return null;
  if (item.truncated || item.output?.truncated || typeof item.output?.text !== "string") throw new Error("Native delivery output is missing or truncated; read_thread requires includeOutputs:true");
  // This is the native app's incoming-message envelope, not assistant-authored text.
  // Match the entire wrapper; keep the input byte-for-byte, including embedded tags.
  const match = /^<codex_delegation>\n  <source_thread_id>([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})<\/source_thread_id>\n  <input>([\s\S]*)<\/input>\n<\/codex_delegation>$/.exec(item.output.text);
  if (!match) throw new Error("Unsupported native delivery envelope; do not send or replay");
  return { source: match[1], prompt: match[2] };
}
function deliveries(snapshot) {
  if (snapshot.truncated || snapshot.turns.some(turn => turn.truncated || !Array.isArray(turn.items))) throw new Error("Desktop read is incomplete; read the full delivery before proceeding");
  return snapshot.turns.flatMap(turn => turn.items.map(item => ({ turn, input: submittedInput(item) })).filter(value => value.input));
}
function assertReady(job, raw) {
  const snapshot = validateTarget(job, raw);
  // The app caps each read_thread item at 20,000 characters. Refuse an input
  // that could never be read back in full, before crossing the send boundary.
  const envelope = `<codex_delegation>\n  <source_thread_id>${job.worker ?? "00000000-0000-0000-0000-000000000000"}</source_thread_id>\n  <input>${job.prompt}</input>\n</codex_delegation>`;
  if (envelope.length > 20000) throw new Error("Desktop delivery exceeds the native full-read limit; shorten the task or peer result before sending");
  const status = snapshot.thread.status?.type;
  if (!["idle", "notLoaded"].includes(status) || snapshot.turns.some(turn => !["completed", "failed", "interrupted"].includes(turn.status))) throw new Error("The bound desktop chat is busy or needs attention; do not send");
  if (deliveries(snapshot).some(value => value.input.prompt === job.prompt)) throw new Error("This delivery already appears in the chat; do not send again");
  return true;
}
function completedAnswer(job, raw) {
  const snapshot = validateTarget(job, raw);
  const matching = deliveries(snapshot).filter(value => value.input.prompt === job.prompt);
  if (matching.length !== 1) throw new Error("Exact submitted prompt is missing or duplicated in the desktop read; do not forward or replay");
  if (matching[0].input.source && matching[0].input.source !== job.worker) throw new Error("Native delivery source does not match the controller that claimed it");
  const turn = matching[0].turn;
  if (turn.status !== "completed" || turn.error) throw new Error("The matching desktop turn has not completed successfully");
  const messages = turn.items.filter(item => item.type === "agentMessage" && (snapshot.thread.kind === "chatgpt" ? !item.phase || item.phase === "final_answer" : item.phase === "final_answer"));
  if (messages.length !== 1 || typeof messages[0].text !== "string" || messages[0].truncated || turn.truncated || snapshot.truncated) throw new Error("Desktop final answer is missing, ambiguous, or truncated");
  if (typeof turn.id !== "string" || typeof messages[0].id !== "string") throw new Error("Desktop response receipt is missing");
  return { answer: messages[0].text, receipt: `${turn.id}:${messages[0].id}` };
}
module.exports = { assertReady, completedAnswer, readSnapshot };
