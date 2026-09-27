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

  test("reads a non-markdown assistant body when an empty markdown placeholder precedes completion controls", () => {
    const originalStyle = globalThis.getComputedStyle;
    const originalNode = globalThis.Node;
    (globalThis as any).getComputedStyle = () => ({ display: "block", visibility: "visible" });
    (globalThis as any).Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
    try {
      const unit = (assistant: boolean) => ({
        querySelector: (selector: string) => selector.includes('data-conversation-role="assistant"') && assistant ? {} : null,
      });
      const candidate = (text: string, assistant: boolean) => ({
        innerText: text,
        isConnected: true,
        getBoundingClientRect: () => ({ width: 100, height: 20 }),
        closest: (selector: string) => selector === "[data-content-search-unit-key]" ? unit(assistant) : null,
        compareDocumentPosition: () => 4,
      });
      const placeholder = candidate("", true);
      const answer = candidate("final answer", true);
      const userText = candidate("submitted prompt", false);
      const action = candidate("Copy", true);
      const root = (body: typeof answer | undefined) => ({
        hasAttribute: (name: string) => name === "data-turn-key",
        querySelectorAll: (selector: string) => selector.includes("data-chatgpt-agent-turn-start") ? []
          : selector.includes(".markdown") ? [placeholder]
          : selector.includes("data-chatgpt-selection-message-id") ? []
          : selector.includes(".puik-root.not-markdown") ? [userText, ...(body ? [body] : [])]
          : [action],
      });
      expect(councilResponseObservation(root(answer) as unknown as Element, CHATGPT_COMPLETION_ACTION_SELECTOR))
        .toEqual({ text: "final answer", completion: true });
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
