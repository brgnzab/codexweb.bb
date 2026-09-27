import { describe, expect, test } from "bun:test";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptAssistantTurnSelector,
} from "../src/chatgpt-session";
import { councilAssistantCandidateIndex, councilNewTurnIdentity, councilReboundTurnIdentity, councilResponseObservation } from "../src/council/playwright-council-driver";
import { deriveCouncilChatGptState } from "../src/council/chatgpt-deep-state";

describe("Council ChatGPT response binding", () => {
  test("selectors cover grouped Activity/DIL turn surfaces", () => {
    expect(CHATGPT_ASSISTANT_TURN_SELECTOR).toContain("data-turn-key");
    expect(CHATGPT_ASSISTANT_TURN_SELECTOR).toContain("data-chatgpt-agent-turn-start");
    expect(CHATGPT_USER_TURN_SELECTOR).toContain("data-user-message-bubble");
    expect(CHATGPT_COMPLETION_ACTION_SELECTOR).toContain("turn-action-controls");
    expect(chatGptAssistantTurnSelector("group:assistant:abc")).toContain('data-turn-key="abc"');
    expect(chatGptAssistantTurnSelector("conversation-turn-7")).toContain('data-testid="conversation-turn-7"');
  });

  test("logical identity resolves only semantic assistant candidates", () => {
    expect(councilAssistantCandidateIndex("conversation-turn-7", ["conversation-turn-6", "conversation-turn-7"])).toBe(1);
    expect(councilAssistantCandidateIndex("conversation-turn-7", ["conversation-turn-6"])).toBeUndefined();
    expect(() => councilAssistantCandidateIndex("conversation-turn-7", ["conversation-turn-7", "conversation-turn-7"]))
      .toThrow("2 semantic assistant DOM candidates");
  });

  test("logical assistant identity rejects competing responses and permits one replacement", () => {
    const baseline = ["old-user", "old-assistant"];
    expect(councilNewTurnIdentity(baseline, [...baseline, "group:assistant:temp"])).toBe("group:assistant:temp");
    expect(() => councilNewTurnIdentity(baseline, [...baseline, "a", "b"])).toThrow("2 new conversation turns");
    expect(councilReboundTurnIdentity(baseline, "group:assistant:temp", ["group:assistant:temp"])).toBe("group:assistant:temp");
    expect(councilReboundTurnIdentity(baseline, "group:assistant:temp", [...baseline, "group:assistant:persisted"])).toBe("group:assistant:persisted");
  });

  test("reads a zero-box grouped assistant body after a user bubble and empty markdown placeholder", () => {
    const originalStyle = globalThis.getComputedStyle;
    const originalNode = globalThis.Node;
    (globalThis as any).getComputedStyle = (element: { contents?: boolean; hidden?: boolean }) => ({
      display: element.contents ? "contents" : "block", visibility: element.hidden ? "hidden" : "visible", opacity: "1",
    });
    (globalThis as any).Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
    try {
      const marker = {
        contains: () => false,
        compareDocumentPosition: (candidate: { user?: boolean }) => candidate.user ? 0 : 4,
      };
      const unit = (assistant: boolean) => ({
        // The same grouped unit contains a user bubble and the assistant role.
        querySelector: (selector: string) => selector.includes("data-user-message-bubble") ? {} : null,
        querySelectorAll: () => assistant ? [marker] : [],
        contains: () => true,
      });
      const candidate = (text: string, assistant: boolean, user = false) => ({
        innerText: text,
        textContent: text,
        user,
        isConnected: true,
        parentElement: null,
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
        closest: (selector: string) => selector === "[data-content-search-unit-key]" ? unit(assistant)
          : selector === "[data-user-message-bubble]" && user ? {} : null,
        compareDocumentPosition: () => 4,
      });
      const placeholder = candidate("", true);
      const answer = candidate("final answer", true);
      const contentsAnswer = {
        ...candidate("final answer", true),
        contents: true,
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
        querySelectorAll: () => [candidate("final answer", true)],
      };
      const hiddenContentsAnswer = {
        ...contentsAnswer,
        querySelectorAll: () => [{ ...candidate("hidden answer", true), hidden: true }],
      };
      const userText = candidate("submitted prompt", true, true);
      const action = candidate("Copy", true);
      const root = (body: typeof answer | undefined, roleBody?: typeof answer) => ({
        hasAttribute: (name: string) => name === "data-turn-key",
        querySelectorAll: (selector: string) => selector.includes("data-chatgpt-agent-turn-start") ? []
          : selector.includes(".markdown") ? [placeholder]
          : selector.includes("data-chatgpt-selection-message-id") ? []
          : selector.includes(".puik-root.not-markdown") ? [userText, ...(body ? [body] : [])]
          : selector === '[data-conversation-role="assistant"]' && roleBody
            ? [{ tagName: "H4", closest: () => unit(true), nextElementSibling: roleBody }]
          : [action],
      });
      expect(councilResponseObservation(root(answer) as unknown as Element, CHATGPT_COMPLETION_ACTION_SELECTOR))
        .toEqual({ text: "final answer", completion: true });
      expect(councilResponseObservation(root(undefined, answer) as unknown as Element, CHATGPT_COMPLETION_ACTION_SELECTOR))
        .toEqual({ text: "final answer", completion: true });
      expect(councilResponseObservation(root(undefined, contentsAnswer) as unknown as Element, CHATGPT_COMPLETION_ACTION_SELECTOR))
        .toEqual({ text: "final answer", completion: true });
      expect(councilResponseObservation(root(undefined, hiddenContentsAnswer) as unknown as Element, CHATGPT_COMPLETION_ACTION_SELECTOR))
        .toEqual({ text: "", completion: true });
      expect(councilResponseObservation(root(undefined) as unknown as Element, CHATGPT_COMPLETION_ACTION_SELECTOR))
        .toEqual({ text: "", completion: true });
    } finally {
      (globalThis as any).getComputedStyle = originalStyle;
      (globalThis as any).Node = originalNode;
    }
  });

  test("temporary response unmount is not DOM_DRIFT while generation remains live", () => {
    const started = 1_000;
    const first = deriveCouncilChatGptState({
      responsePresent: true,
      assistantText: "working",
      generationRunning: true,
      stopVisible: true,
      rateLimited: false,
      conversationLimit: false,
      connectionLost: false,
      terminalError: false,
    }, { submittedAt: started }, undefined, started);
    const duringActivity = deriveCouncilChatGptState({
      responsePresent: false,
      generationRunning: true,
      stopVisible: true,
      rateLimited: false,
      conversationLimit: false,
      connectionLost: false,
      terminalError: false,
    }, { submittedAt: started }, first, started + 90_000, { responseDomGraceMs: 1_000 });
    expect(duringActivity.state).not.toBe("DOM_DRIFT");
    const stopped = deriveCouncilChatGptState({
      responsePresent: false,
      generationRunning: false,
      stopVisible: false,
      rateLimited: false,
      conversationLimit: false,
      connectionLost: false,
      terminalError: false,
    }, { submittedAt: started }, duringActivity, started + 92_000, { responseDomGraceMs: 1_000 });
    expect(stopped.state).toBe("DOM_DRIFT");
  });
});
