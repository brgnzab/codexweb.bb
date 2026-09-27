import { describe, expect, test } from "bun:test";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptAssistantTurnSelector,
} from "../src/chatgpt-session";
import { councilAssistantCandidateIndex, councilNewTurnIdentity, councilReboundTurnIdentity } from "../src/council/playwright-council-driver";
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
