import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  assertAuthenticatedChatGptPage,
} from "../chatgpt-session";
import { connectLauncherBrowserHost } from "../launcher-browser-host";
import type { CouncilExecutionObserver, CouncilExecutionPhaseObserver, CouncilPersistentChatDriver, CouncilPromptAttachment } from "./browser-transport";
import { CouncilConversationUnavailableError, CouncilSurfaceUnavailableError } from "./browser-transport";
import { assertChatGptConversationUrl } from "./conversation-registry";
import { classifyCouncilConnectorObservation } from "./chatgpt-connector-policy";
import { deriveCouncilChatGptState, type CouncilChatGptStateResult } from "./chatgpt-deep-state";
import type { CouncilObservationHealth } from "./observation-store";
import { classifyConversationSurface } from "./playwright-council-surface";

const CHATGPT_HOME_URL = "https://chatgpt.com/";
const COUNCIL_CONNECTOR_NAME = "CodexWeb Council";
const PAGE_TIMEOUT_MS = 60_000;
const SUBMISSION_TIMEOUT_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 45 * 60_000;
const DIAGNOSTIC_SAMPLE_MS = 1_500;
const INSERT_CHUNK_CHARS = 12_000;
const CONNECTOR_MENU_TIMEOUT_MS = 4_000;

interface DriverInput {
  surfaceId: string;
  prompt: string;
  attachments?: CouncilPromptAttachment[];
  signal?: AbortSignal;
  onPhase?: CouncilExecutionPhaseObserver;
  onExecution?: CouncilExecutionObserver;
}
interface ResumeInput extends DriverInput { conversationUrl: string }

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Council ChatGPT turn aborted", "AbortError");
}

function phase(legacy: CouncilExecutionPhaseObserver | undefined, observer: CouncilExecutionObserver | undefined, value: Parameters<CouncilExecutionPhaseObserver>[0]): void {
  legacy?.(value);
  observer?.({ type: "phase", phase: value });
}

function emitDeepState(observer: CouncilExecutionObserver | undefined, state: CouncilChatGptStateResult): void {
  observer?.({
    type: "deep-state",
    state: state.state,
    confidence: Math.max(0, Math.min(1, state.confidence)),
    reason: state.reason.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500),
  });
}

async function visibleComposer(page: Page): Promise<Locator> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  await composers.last().waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
  await assertAuthenticatedChatGptPage(page);
  return composers.last();
}

async function composerText(composer: Locator): Promise<string> {
  return await composer.evaluate(element => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]').forEach(node => node.remove());
    return [...clone.childNodes].map(child => child.textContent ?? "").join("\n").trimStart();
  });
}

function councilPromptCodeUnitEquivalent(expected: string, observed: string, index: number): boolean {
  const expectedUnit = expected[index];
  const observedUnit = observed[index];
  if (expectedUnit === observedUnit) return true;
  if (expectedUnit !== " " || observedUnit !== "\u00A0") return false;
  return expected[index - 1] === " " || expected[index + 1] === " ";
}

export function councilPromptTextEquivalent(expected: string, observed: string): boolean {
  if (expected.length !== observed.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (!councilPromptCodeUnitEquivalent(expected, observed, index)) return false;
  }
  return true;
}

export function councilPromptEquivalentPrefixLength(expected: string, observed: string): number {
  const length = Math.min(expected.length, observed.length);
  let index = 0;
  while (index < length && councilPromptCodeUnitEquivalent(expected, observed, index)) index += 1;
  return index;
}

function selectedCouncilConnector(composer: Locator): Locator {
  return composer
    .locator('[data-id^="plugin:"][data-keyword]')
    .filter({ hasText: COUNCIL_CONNECTOR_NAME, visible: true });
}

async function councilConnectorIsSelected(composer: Locator): Promise<boolean> {
  const keywords = await selectedCouncilConnector(composer).evaluateAll(elements => elements.map(element => element.getAttribute("data-keyword")));
  const exact = keywords.filter(keyword => keyword === COUNCIL_CONNECTOR_NAME).length;
  if (exact > 1) throw new Error("ChatGPT exposed duplicate CodexWeb Council connector selections");
  return exact === 1;
}

/** Prefer the real ChatGPT connector when it is available, but keep ordinary Council
 * browser turns usable without it. The action footer is still processed by the local Council
 * runtime, so connector absence is capability degradation rather than a transport failure. */
async function trySelectCouncilConnector(
  page: Page,
  signal?: AbortSignal,
  onPhase?: CouncilExecutionPhaseObserver,
  onExecution?: CouncilExecutionObserver,
): Promise<{ composer: Locator; connectorSelected: boolean }> {
  let composer = await visibleComposer(page);
  await composer.fill("");
  const selectedExactCount = await selectedCouncilConnector(composer).evaluateAll(elements => elements.filter(element => element.getAttribute("data-keyword") === COUNCIL_CONNECTOR_NAME).length);
  const initial = classifyCouncilConnectorObservation({ selectedExactCount, exactMenuRowCount: 0 });
  if (initial === "ambiguous") throw new Error("ChatGPT exposed duplicate CodexWeb Council connector selections");
  if (initial === "selected") {
    phase(onPhase, onExecution, "connector-selected");
    return { composer, connectorSelected: true };
  }

  const menuRows = page.locator('.__menu-item[tabindex="0"]');
  const exactRow = menuRows.filter({ has: page.getByText(COUNCIL_CONNECTOR_NAME, { exact: true }) });
  const deadline = Date.now() + CONNECTOR_MENU_TIMEOUT_MS;
  while (Date.now() < deadline) {
    abortIfNeeded(signal);
    composer = await visibleComposer(page);
    await composer.fill("");
    await composer.focus();
    await composer.pressSequentially("@c", { delay: 20 });
    try {
      await exactRow.waitFor({ state: "visible", timeout: Math.min(1_250, Math.max(1, deadline - Date.now())) });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    }
    const exactMenuRowCount = await exactRow.count().catch(() => 0);
    const disposition = classifyCouncilConnectorObservation({ selectedExactCount: 0, exactMenuRowCount });
    if (disposition === "ambiguous") throw new Error(`ChatGPT exposed duplicate exact ${JSON.stringify(COUNCIL_CONNECTOR_NAME)} connector rows`);
    if (disposition === "selectable" && await exactRow.isVisible().catch(() => false)) {
      await exactRow.click({ force: true, timeout: 10_000 });
      const selectedComposer = await visibleComposer(page);
      await selectedCouncilConnector(selectedComposer).waitFor({ state: "visible", timeout: 10_000 });
      if (!await councilConnectorIsSelected(selectedComposer)) throw new Error("ChatGPT did not commit the CodexWeb Council connector selection");
      phase(onPhase, onExecution, "connector-selected");
      return { composer: selectedComposer, connectorSelected: true };
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  composer = await visibleComposer(page);
  await composer.fill("");
  return { composer, connectorSelected: false };
}

async function attachExactPrompt(
  page: Page,
  prompt: string,
  signal?: AbortSignal,
  onPhase?: CouncilExecutionPhaseObserver,
  onExecution?: CouncilExecutionObserver,
): Promise<Locator> {
  const { composer, connectorSelected } = await trySelectCouncilConnector(page, signal, onPhase, onExecution);
  await composer.focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  const transported = ` ${prompt}`;
  for (let offset = 0; offset < transported.length;) {
    abortIfNeeded(signal);
    let end = Math.min(offset + INSERT_CHUNK_CHARS, transported.length);
    if (end < transported.length) {
      const previous = transported.charCodeAt(end - 1);
      const next = transported.charCodeAt(end);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
    }
    await page.keyboard.insertText(transported.slice(offset, end));
    offset = end;
  }
  const deadline = Date.now() + 10_000;
  let observed = "";
  do {
    abortIfNeeded(signal);
    observed = await composerText(composer);
    if (councilPromptTextEquivalent(prompt, observed)) {
      if (connectorSelected && !await councilConnectorIsSelected(composer)) throw new Error("CodexWeb Council connector selection disappeared while attaching the prompt");
      phase(onPhase, onExecution, "prompt-attached");
      return composer;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const prefix = councilPromptEquivalentPrefixLength(prompt, observed);
  throw new Error(`ChatGPT Council composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${prefix})`);
}

async function attachFiles(
  page: Page,
  composer: Locator,
  attachments: CouncilPromptAttachment[] = [],
  onPhase?: CouncilExecutionPhaseObserver,
  onExecution?: CouncilExecutionObserver,
): Promise<void> {
  if (attachments.length === 0) {
    phase(onPhase, onExecution, "files-attached");
    return;
  }
  if (attachments.length > 20) throw new Error("Council manager turn supports at most 20 screenshot attachments");
  const input = page.locator('input[data-testid="upload-photos-input"]');
  await input.waitFor({ state: "attached", timeout: 20_000 });
  await input.setInputFiles(attachments.map(file => ({ name: file.name, mimeType: file.mimeType, buffer: file.buffer })));
  const form = composer.locator("xpath=ancestor::form[1]");
  for (const file of attachments) {
    await form.getByRole("group", { name: file.name, exact: true }).waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
  }
  phase(onPhase, onExecution, "files-attached");
}

interface CouncilTurnDomState {
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
}

interface CouncilResponseBinding {
  identity: string;
  acceptedTurnIdentities: readonly string[];
}

export function councilAssistantCandidateIndex(
  identity: string,
  candidateIdentities: readonly (string | undefined)[],
): number | undefined {
  const matches: number[] = [];
  candidateIdentities.forEach((candidate, index) => {
    if (candidate === identity) matches.push(index);
  });
  if (matches.length > 1) {
    throw new Error(`ChatGPT exposed ${matches.length} semantic assistant DOM candidates for logical turn ${identity}`);
  }
  return matches[0];
}

async function resolveCouncilAssistantTurn(page: Page, identity: string): Promise<Locator | undefined> {
  const candidates = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
  const identities = await candidates.evaluateAll(elements => elements.map(element => {
    const groupKey = element.getAttribute("data-turn-key");
    if (groupKey) return `group:assistant:${groupKey}`;
    return element.getAttribute("data-turn-id")
      ?? element.getAttribute("data-testid")
      ?? element.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
      ?? undefined;
  }));
  const index = councilAssistantCandidateIndex(identity, identities);
  return index === undefined ? undefined : candidates.nth(index);
}

export function councilNewTurnIdentity(initial: readonly string[], current: readonly string[]): string | undefined {
  const previous = new Set(initial);
  const added = current.filter(identity => !previous.has(identity));
  if (added.length > 1) throw new Error(`ChatGPT exposed ${added.length} new conversation turns for one submitted message`);
  return added[0];
}

export function councilReboundTurnIdentity(initial: readonly string[], boundIdentity: string, current: readonly string[]): string | undefined {
  if (current.includes(boundIdentity)) return boundIdentity;
  return councilNewTurnIdentity(initial, current);
}

async function councilTurnDomState(page: Page): Promise<CouncilTurnDomState> {
  return await page.evaluate(({ userSelector, assistantSelector }) => {
    const unique = (values: Array<string | null | undefined>, label: string) => {
      const clean = values.filter((value): value is string => Boolean(value));
      if (new Set(clean).size !== clean.length) throw new Error(`ChatGPT exposed duplicate ${label} identities`);
      return clean;
    };
    const legacyIdentity = (element: Element) =>
      element.getAttribute("data-turn-id")
      ?? element.getAttribute("data-testid")
      ?? element.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container");
    const legacy = (selector: string) => [...document.querySelectorAll(selector)].filter(element => !element.closest("[data-turn-key]"));
    const userIdentities = unique(legacy(userSelector).map(legacyIdentity), "user turn");
    const responseIdentities = unique(legacy(assistantSelector).map(legacyIdentity), "assistant turn");
    const turnIdentities = [...new Set([...userIdentities, ...responseIdentities])];
    const groups = [...document.querySelectorAll<HTMLElement>("[data-turn-key]")];
    const keys = unique(groups.map(group => group.getAttribute("data-turn-key")), "group turn");
    groups.forEach((group, index) => {
      const key = keys[index]!;
      const user = `group:user:${key}`;
      const assistant = `group:assistant:${key}`;
      // Preserve both logical roles in the baseline even if Activity temporarily unmounts one.
      turnIdentities.push(user, assistant);
      if (group.querySelector("[data-user-message-bubble]")) userIdentities.push(user);
      if (group.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]')) responseIdentities.push(assistant);
    });
    return {
      turnIdentities: [...new Set(turnIdentities)],
      userIdentities: [...new Set(userIdentities)],
      responseIdentities: [...new Set(responseIdentities)],
    };
  }, { userSelector: CHATGPT_USER_TURN_SELECTOR, assistantSelector: CHATGPT_ASSISTANT_TURN_SELECTOR });
}

function groupKeyFromUserIdentity(identity: string): string | undefined {
  const prefix = "group:user:";
  return identity.startsWith(prefix) ? identity.slice(prefix.length) : undefined;
}

async function userGroupMatchesSubmittedPrompt(page: Page, userIdentity: string, prompt: string): Promise<boolean> {
  const key = groupKeyFromUserIdentity(userIdentity);
  if (!key) return false;
  const group = page.locator(`[data-turn-key=${JSON.stringify(key)}]`);
  return await group.evaluate((element, submitted) => {
    const bubbles = element.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
    const contents = bubbles.length === 1 ? bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]") : [];
    const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
    return contents.length === 1 && normalize(contents[0]!.innerText) === normalize(submitted);
  }, prompt).catch(() => false);
}

async function reconcileCouncilResponseBinding(
  page: Page,
  baseline: CouncilTurnDomState,
  prompt: string,
  binding: CouncilResponseBinding | undefined,
  acceptedUserIdentity?: string,
): Promise<{ binding?: CouncilResponseBinding; state: CouncilTurnDomState; responseTurn?: Locator }> {
  const state = await councilTurnDomState(page);
  if (!binding) {
    const identity = councilNewTurnIdentity(baseline.turnIdentities, state.responseIdentities);
    const responseTurn = identity ? await resolveCouncilAssistantTurn(page, identity) : undefined;
    return {
      binding: identity ? { identity, acceptedTurnIdentities: state.turnIdentities } : undefined,
      state,
      responseTurn,
    };
  }

  // Resolve the logical identity only across nodes that already satisfy the semantic assistant-turn
  // selector. A legacy ChatGPT turn may mirror the same id through data-testid/data-turn-id/
  // data-turn-id-container on nested nodes; those attribute aliases are not separate responses.
  const boundTurn = await resolveCouncilAssistantTurn(page, binding.identity);
  if (boundTurn) return { binding, state, responseTurn: boundTurn };

  const acceptedTurns = new Set(binding.acceptedTurnIdentities);
  const identity = councilReboundTurnIdentity(baseline.turnIdentities, binding.identity, state.responseIdentities);
  const newUsers = state.userIdentities.filter(item => !baseline.turnIdentities.includes(item));
  if (newUsers.length > 1) throw new Error(`ChatGPT exposed ${newUsers.length} new user turns while the bound assistant response was detached`);
  const user = newUsers[0];

  // Activity may temporarily unmount the accepted assistant group before the replacement
  // appears. With no competing user evidence, keep waiting on the same logical turn.
  if (!user) return { binding, state, responseTurn: undefined };
  const userMatches = acceptedUserIdentity
    ? user === acceptedUserIdentity
    : await userGroupMatchesSubmittedPrompt(page, user, prompt);
  if (!userMatches) throw new Error("ChatGPT opened another user turn while the bound assistant response was detached");
  if (!identity) return { binding, state, responseTurn: undefined };

  const replacement = identity
    && binding.identity.startsWith("group:assistant:")
    && user.startsWith("group:user:")
    && identity === `group:assistant:${user.slice("group:user:".length)}`
    && !state.turnIdentities.includes(binding.identity)
    && state.turnIdentities.every(turn => baseline.turnIdentities.includes(turn) || acceptedTurns.has(turn) || turn === user || turn === identity);
  if (!replacement) throw new Error("ChatGPT assistant response rebind did not match the accepted submitted turn");
  return {
    binding: { identity, acceptedTurnIdentities: state.turnIdentities },
    state,
    responseTurn: await resolveCouncilAssistantTurn(page, identity),
  };
}

async function currentResponseObservation(responseTurn: Locator): Promise<{ text: string; completion: boolean }> {
  return await responseTurn.evaluate((element, completionSelector) => {
    const root = element as HTMLElement;
    const rendered = (candidate: HTMLElement) => {
      const style = getComputedStyle(candidate);
      const bounds = candidate.getBoundingClientRect();
      return candidate.isConnected && bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    // ChatGPT's DIL/Activity renderers do not guarantee a .markdown wrapper.
    const answerRootSelector = '.markdown, [data-message-author-role="assistant"] .puik-root.not-markdown > [class*="_DilResponseRoot"], [data-markdown-text-style="assistant-message"]';
    const activityContainers = [...root.querySelectorAll<HTMLElement>("[data-chatgpt-agent-turn-start]")]
      .map(marker => marker.parentElement)
      .filter((node): node is HTMLElement => Boolean(node));
    const answers = [...root.querySelectorAll<HTMLElement>(answerRootSelector)]
      .filter(candidate => candidate.closest("[data-streaming-response-status]") === null)
      .filter(candidate => {
        if (!root.hasAttribute("data-turn-key") && !candidate.hasAttribute("data-markdown-text-style")) return true;
        const unit = candidate.closest("[data-content-search-unit-key]");
        return unit
          ? Array.from(unit.children).some(child => child.getAttribute("data-conversation-role") === "assistant")
          : activityContainers.some(container => container.contains(candidate));
      })
      .filter(rendered);
    const text = answers.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n").trim();
    const actions = [...root.querySelectorAll<HTMLElement>(completionSelector)].filter(rendered);
    const lastAnswer = answers.at(-1);
    const completion = root.hasAttribute("data-turn-key")
      ? Boolean(lastAnswer && actions.some(action => Boolean(lastAnswer.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING)))
      : actions.length > 0;
    return { text, completion };
  }, CHATGPT_COMPLETION_ACTION_SELECTOR).catch(() => ({ text: "", completion: false }));
}

async function bodyDiagnosticText(page: Page): Promise<string> {
  return (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 30_000);
}

async function approveCouncilToolIfNeeded(page: Page): Promise<void> {
  const dialog = page.locator('[role="dialog"], [data-testid="tool-approval-card"]')
    .filter({ hasText: `Allow ChatGPT to use ${COUNCIL_CONNECTOR_NAME}?` })
    .last();
  if (!await dialog.isVisible().catch(() => false)) return;
  const allow = dialog.getByRole("button", { name: "Allow once", exact: true }).last();
  await allow.waitFor({ state: "visible", timeout: 10_000 });
  await allow.press("Enter");
}

function diagnosticSnapshot(text: string): Pick<import("./chatgpt-deep-state").CouncilChatGptSnapshot, "rateLimited" | "conversationLimit" | "connectionLost" | "terminalError"> {
  const compact = text.replace(/\s+/g, " ").trim();
  return {
    conversationLimit: /conversation (?:is )?too long|conversation limit|maximum context|start a new chat to continue/i.test(compact),
    rateLimited: /too many requests|making requests too quickly|rate limit|usage limit|message limit|you(?:'|’)ve reached|try again after|come back later/i.test(compact),
    connectionLost: /network error|connection error|failed to fetch|reconnecting|connection lost/i.test(compact),
    terminalError: /error generating|unable to generate|response failed|there was an error generating|something went wrong while generating/i.test(compact),
  };
}

async function genericUserInputRequired(page: Page): Promise<boolean> {
  const dialog = page.locator('[role="dialog"], [data-testid*="approval"], [data-testid*="confirmation"]').filter({ visible: true }).last();
  if (!await dialog.isVisible().catch(() => false)) return false;
  const text = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (text.includes(`Allow ChatGPT to use ${COUNCIL_CONNECTOR_NAME}?`)) return false;
  return /approval|approve|confirm|verification|verify|choose|select|continue|permission|required/i.test(text);
}

function throwDeepStateFailure(state: CouncilChatGptStateResult): void {
  if (state.state === "DOM_DRIFT") throw new Error(`ChatGPT Council DOM_DRIFT: ${state.reason}`);
  if (state.state === "RATE_LIMITED") throw new Error(`ChatGPT Council RATE_LIMITED: ${state.reason}`);
  if (state.state === "CONVERSATION_LIMIT") throw new Error(`ChatGPT Council CONVERSATION_LIMIT: ${state.reason}`);
  if (state.state === "CONNECTION_LOST") throw new Error(`ChatGPT Council CONNECTION_LOST: ${state.reason}`);
  if (state.state === "FAILED") throw new Error(`ChatGPT Council FAILED: ${state.reason}`);
  if (state.state === "WAITING_USER") throw new Error(`ChatGPT Council WAITING_USER: ${state.reason}`);
  if (state.state === "STALLED") throw new Error(`ChatGPT Council response stalled: ${state.reason}`);
}

async function sendAndWait(
  page: Page,
  prompt: string,
  attachments: CouncilPromptAttachment[] | undefined,
  signal?: AbortSignal,
  onPhase?: CouncilExecutionPhaseObserver,
  onExecution?: CouncilExecutionObserver,
): Promise<string> {
  abortIfNeeded(signal);
  const composer = await attachExactPrompt(page, prompt, signal, onPhase, onExecution);
  await attachFiles(page, composer, attachments, onPhase, onExecution);
  const baseline = await councilTurnDomState(page);
  const send = composer.locator("xpath=ancestor::form[1]").getByTestId("send-button");
  await send.waitFor({ state: "visible", timeout: 20_000 });
  if (!await send.isEnabled()) throw new Error("ChatGPT Council send button is disabled after prompt attachment");
  const submittedAt = Date.now();
  phase(onPhase, onExecution, "submit-started");
  await send.press("Enter");

  const submissionDeadline = Date.now() + SUBMISSION_TIMEOUT_MS;
  let submissionObserved = false;
  let acceptedUserIdentity: string | undefined;
  let responseBinding: CouncilResponseBinding | undefined;
  while (Date.now() < submissionDeadline) {
    abortIfNeeded(signal);
    const state = await councilTurnDomState(page);
    const newUsers = state.userIdentities.filter(identity => !baseline.turnIdentities.includes(identity));
    if (newUsers.length > 1) throw new Error(`ChatGPT exposed ${newUsers.length} new user turns for one submitted message`);
    acceptedUserIdentity ??= newUsers[0];
    const identity = councilNewTurnIdentity(baseline.turnIdentities, state.responseIdentities);
    if (identity) responseBinding = { identity, acceptedTurnIdentities: state.turnIdentities };
    const running = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count();
    if (acceptedUserIdentity || responseBinding || running > 0) {
      submissionObserved = true;
      phase(onPhase, onExecution, "submit-observed");
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!submissionObserved) throw new Error("ChatGPT Council did not accept the submitted prompt");

  const responseDeadline = submittedAt + RESPONSE_TIMEOUT_MS;
  let previousState: CouncilChatGptStateResult | undefined;
  let lastText = "";
  let lastAssistantMutationAt = submittedAt;
  let lastStatusMutationAt = submittedAt;
  let lastStatusSignature = "";
  let lastDiagnosticAt = 0;
  let diagnostic = { rateLimited: false, conversationLimit: false, connectionLost: false, terminalError: false };
  let emittedStreaming = false;

  while (Date.now() < responseDeadline) {
    abortIfNeeded(signal);
    if (page.isClosed()) throw new Error("ChatGPT Council browser surface closed during the turn");
    await approveCouncilToolIfNeeded(page);
    const now = Date.now();
    const reconciled = await reconcileCouncilResponseBinding(page, baseline, prompt, responseBinding, acceptedUserIdentity);
    responseBinding = reconciled.binding;
    const responseTurn = reconciled.responseTurn;
    const present = Boolean(responseTurn);
    const observation = responseTurn ? await currentResponseObservation(responseTurn) : { text: "", completion: false };
    const text = observation.text;
    if (text !== lastText) {
      lastText = text;
      lastAssistantMutationAt = now;
    }
    const [running, waitingUser] = await Promise.all([
      page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count().then(count => count > 0),
      genericUserInputRequired(page),
    ]);
    const completion = observation.completion;
    const statusSignature = `${present}:${running}:${completion}:${waitingUser}`;
    if (statusSignature !== lastStatusSignature) {
      lastStatusSignature = statusSignature;
      lastStatusMutationAt = now;
    }
    if (now - lastDiagnosticAt >= DIAGNOSTIC_SAMPLE_MS) {
      diagnostic = diagnosticSnapshot(await bodyDiagnosticText(page));
      lastDiagnosticAt = now;
    }

    const previousStateName = previousState?.state;
    const nextState = deriveCouncilChatGptState({
      composerPresent: true,
      responsePresent: present,
      assistantText: text,
      responseSignature: text,
      completionActionVisible: completion,
      generationRunning: running,
      stopVisible: running,
      waitingUser,
      ...diagnostic,
      toolActivities: [],
      lastAssistantMutationAt,
      lastStatusMutationAt,
    }, { submittedAt }, previousState, now);
    if (nextState.state !== previousStateName) emitDeepState(onExecution, nextState);
    previousState = nextState;

    if (present && !emittedStreaming && ["THINKING", "DEEP_THINKING", "STREAMING", "TOOL_RUNNING", "COMPLETING", "COMPLETED"].includes(nextState.state)) {
      emittedStreaming = true;
      phase(onPhase, onExecution, "response-streaming");
    }
    if (nextState.state === "COMPLETED") {
      phase(onPhase, onExecution, "response-complete");
      return nextState.lastAssistantText;
    }
    throwDeepStateFailure(nextState);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`ChatGPT Council response exceeded the ${Math.round(RESPONSE_TIMEOUT_MS / 60_000)} minute hard wall-clock limit`);
}

async function waitForConversationUrl(page: Page, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  do {
    try { return assertChatGptConversationUrl(page.url()); }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`ChatGPT did not establish a persistent conversation URL (${page.url()})`);
}

function surfaceUnavailable(page: Page): boolean {
  return page.isClosed() || page.url() === "about:blank";
}

async function navigateBeforeSubmit(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
  } catch (error) {
    if (surfaceUnavailable(page)) throw new CouncilSurfaceUnavailableError(`Council browser surface unavailable before navigation completed (${page.url()})`);
    throw error;
  }
}

async function scrollConversationToBottom(page: Page, signal?: AbortSignal): Promise<void> {
  for (let pass = 0; pass < 6; pass++) {
    abortIfNeeded(signal);
    await page.evaluate(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
      const candidates = [...document.querySelectorAll<HTMLElement>("main, [role='main'], [class*='overflow-y-auto'], [class*='overflow-auto']")];
      for (const element of candidates) {
        if (element.scrollHeight > element.clientHeight + 8) element.scrollTop = element.scrollHeight;
      }
    });
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}

function healthFromDiagnostic(text: string): { health: CouncilObservationHealth; note?: string } {
  const compact = text.replace(/\s+/g, " ").trim();
  if (/too many requests|making requests too quickly|rate limit/i.test(compact)) return { health: "limited", note: "ChatGPT rate-limit evidence is visible" };
  if (/you(?:'|’)ve reached|reached .* limit|usage limit|message limit|try again after|come back later/i.test(compact)) return { health: "limited", note: "ChatGPT usage/message-limit evidence is visible" };
  if (/sign in|log in|session expired|failed to load subscription/i.test(compact)) return { health: "signed-out", note: "ChatGPT authentication/session evidence is unhealthy" };
  if (/something went wrong|network error|connection error|failed to fetch/i.test(compact)) return { health: "connection-error", note: "ChatGPT connection/error evidence is visible" };
  return { health: "healthy" };
}

export class PlaywrightCouncilChatDriver implements CouncilPersistentChatDriver {
  constructor(private readonly descriptorPath: string) {}

  async resume(input: ResumeInput): Promise<{ answer: string; conversationUrl: string }> {
    const expected = assertChatGptConversationUrl(input.conversationUrl);
    const connection = await connectLauncherBrowserHost(this.descriptorPath, PAGE_TIMEOUT_MS, input.surfaceId, input.signal);
    try {
      const page = connection.page;
      if (page.isClosed()) throw new CouncilSurfaceUnavailableError("Council browser surface closed before conversation resume");
      if (page.url() !== expected) await navigateBeforeSubmit(page, expected);
      await new Promise(resolve => setTimeout(resolve, 250));
      const diagnostic = await bodyDiagnosticText(page);
      const surface = classifyConversationSurface(expected, page.url(), diagnostic);
      if (surface === "surface-unavailable") throw new CouncilSurfaceUnavailableError(`Council browser surface unavailable before submit (${page.url()})`);
      if (surface === "unavailable") throw new CouncilConversationUnavailableError(`ChatGPT conversation is unavailable: ${expected}`);
      if (surface === "invalid") throw new Error(`ChatGPT persistent surface left the expected origin: ${page.url()}`);
      try { await visibleComposer(page); }
      catch (error) {
        if (surfaceUnavailable(page)) throw new CouncilSurfaceUnavailableError(`Council browser surface unavailable before composer became ready (${page.url()})`);
        const state = classifyConversationSurface(expected, page.url(), await bodyDiagnosticText(page));
        if (state === "surface-unavailable") throw new CouncilSurfaceUnavailableError(`Council browser surface unavailable before composer became ready (${page.url()})`);
        if (state === "unavailable") throw new CouncilConversationUnavailableError(`ChatGPT conversation is unavailable: ${expected}`);
        throw error;
      }
      phase(input.onPhase, input.onExecution, "conversation-ready");
      const answer = await sendAndWait(page, input.prompt, input.attachments, input.signal, input.onPhase, input.onExecution);
      return { answer, conversationUrl: assertChatGptConversationUrl(page.url()) };
    } finally {
      await connection.browser.close().catch(() => {});
    }
  }

  async create(input: DriverInput): Promise<{ answer: string; conversationUrl: string }> {
    const connection = await connectLauncherBrowserHost(this.descriptorPath, PAGE_TIMEOUT_MS, input.surfaceId, input.signal);
    try {
      const page = connection.page;
      if (page.isClosed()) throw new CouncilSurfaceUnavailableError("Council browser surface closed before conversation creation");
      const current = new URL(page.url());
      if (current.origin !== "https://chatgpt.com" || current.pathname !== "/" || current.search) await navigateBeforeSubmit(page, CHATGPT_HOME_URL);
      try { await visibleComposer(page); }
      catch (error) {
        if (surfaceUnavailable(page)) throw new CouncilSurfaceUnavailableError(`Council browser surface unavailable before composer became ready (${page.url()})`);
        throw error;
      }
      phase(input.onPhase, input.onExecution, "conversation-ready");
      const answer = await sendAndWait(page, input.prompt, input.attachments, input.signal, input.onPhase, input.onExecution);
      return { answer, conversationUrl: await waitForConversationUrl(page) };
    } finally {
      await connection.browser.close().catch(() => {});
    }
  }

  async focus(input: { surfaceId: string; conversationUrl: string; signal?: AbortSignal }): Promise<{ conversationUrl: string }> {
    const expected = assertChatGptConversationUrl(input.conversationUrl);
    const connection = await connectLauncherBrowserHost(this.descriptorPath, PAGE_TIMEOUT_MS, input.surfaceId, input.signal);
    try {
      const page = connection.page;
      if (page.isClosed()) throw new CouncilSurfaceUnavailableError("Council browser surface closed before conversation focus");
      if (page.url() !== expected) await navigateBeforeSubmit(page, expected);
      await new Promise(resolve => setTimeout(resolve, 250));
      const diagnostic = await bodyDiagnosticText(page);
      const surface = classifyConversationSurface(expected, page.url(), diagnostic);
      if (surface === "surface-unavailable") throw new CouncilSurfaceUnavailableError(`Council browser surface unavailable before focus (${page.url()})`);
      if (surface === "unavailable") throw new CouncilConversationUnavailableError(`ChatGPT conversation is unavailable: ${expected}`);
      if (surface === "invalid") throw new Error(`ChatGPT persistent surface left the expected origin: ${page.url()}`);
      try { await visibleComposer(page); }
      catch (error) {
        if (surfaceUnavailable(page)) throw new CouncilSurfaceUnavailableError(`Council browser surface unavailable before focus became ready (${page.url()})`);
        const state = classifyConversationSurface(expected, page.url(), await bodyDiagnosticText(page));
        if (state === "unavailable") throw new CouncilConversationUnavailableError(`ChatGPT conversation is unavailable: ${expected}`);
        throw error;
      }
      return { conversationUrl: assertChatGptConversationUrl(page.url()) };
    } finally {
      await connection.browser.close().catch(() => {});
    }
  }

  async capture(input: { surfaceId: string; conversationUrl: string; signal?: AbortSignal }): Promise<{ png: Buffer; conversationUrl: string; health: CouncilObservationHealth; note?: string }> {
    const expected = assertChatGptConversationUrl(input.conversationUrl);
    const connection = await connectLauncherBrowserHost(this.descriptorPath, PAGE_TIMEOUT_MS, input.surfaceId, input.signal);
    try {
      const page = connection.page;
      if (page.isClosed()) throw new CouncilSurfaceUnavailableError("Council browser surface closed before observation capture");
      if (page.url() !== expected) await navigateBeforeSubmit(page, expected);
      await new Promise(resolve => setTimeout(resolve, 350));
      const diagnostic = await bodyDiagnosticText(page);
      const surface = classifyConversationSurface(expected, page.url(), diagnostic);
      if (surface === "surface-unavailable") throw new CouncilSurfaceUnavailableError(`Council browser surface unavailable before capture (${page.url()})`);
      if (surface === "unavailable") throw new CouncilConversationUnavailableError(`ChatGPT conversation is unavailable: ${expected}`);
      if (surface === "invalid") throw new Error(`ChatGPT observation surface left the expected origin: ${page.url()}`);
      await scrollConversationToBottom(page, input.signal);
      const freshDiagnostic = await bodyDiagnosticText(page);
      const health = healthFromDiagnostic(freshDiagnostic);
      const png = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide", timeout: 20_000 });
      return { png, conversationUrl: assertChatGptConversationUrl(page.url()), ...health };
    } finally {
      await connection.browser.close().catch(() => {});
    }
  }
}
