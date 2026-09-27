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
function assertReady(job, raw) {
  const snapshot = validateTarget(job, raw);
  const status = snapshot.thread.status?.type;
  if (!["idle", "notLoaded"].includes(status) || snapshot.turns.some(turn => !["completed", "failed", "interrupted"].includes(turn.status))) throw new Error("The bound desktop chat is busy or needs attention; do not send");
  if (snapshot.turns.some(turn => turn.items?.some(item => item.type === "userMessage" && item.content?.some(part => part.text === job.prompt)))) throw new Error("This delivery already appears in the chat; do not send again");
  return true;
}
function completedAnswer(job, raw) {
  const snapshot = validateTarget(job, raw);
  const matching = snapshot.turns.filter(turn => turn.items?.some(item => item.type === "userMessage" && item.content?.length === 1 && item.content[0].type === "text" && item.content[0].text === job.prompt));
  if (matching.length !== 1) throw new Error("Exact submitted prompt is missing or duplicated in the desktop read; do not forward or replay");
  const turn = matching[0];
  if (turn.status !== "completed" || turn.error) throw new Error("The matching desktop turn has not completed successfully");
  const messages = turn.items.filter(item => item.type === "agentMessage" && (snapshot.thread.kind === "chatgpt" ? !item.phase || item.phase === "final_answer" : item.phase === "final_answer"));
  if (messages.length !== 1 || typeof messages[0].text !== "string" || messages[0].truncated || turn.truncated || snapshot.truncated) throw new Error("Desktop final answer is missing, ambiguous, or truncated");
  if (typeof turn.id !== "string" || typeof messages[0].id !== "string") throw new Error("Desktop response receipt is missing");
  return { answer: messages[0].text, receipt: `${turn.id}:${messages[0].id}` };
}
module.exports = { assertReady, completedAnswer, readSnapshot };
