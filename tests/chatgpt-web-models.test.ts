import { describe, expect, test } from "bun:test";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../src/chatgpt-web-models";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

describe("fixed ChatGPT Web model routes", () => {
  const plus = { solAvailable: true, proAvailable: false };
  const pro = { solAvailable: true, proAvailable: true };

  test("uses unique stable slugs and one explicit adapter effort per model", () => {
    expect(new Set(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug)).size).toBe(CHATGPT_WEB_MODEL_ROUTES.length);
    expect(CHATGPT_WEB_MODEL_ROUTES.map(route => [route.slug, route.codexEffort, route.adapterEffort])).toEqual([
      ["chatgpt-web/light", "low", "low"],
      ["chatgpt-web/medium", "medium", "medium"],
      ["chatgpt-web/high", "high", "high"],
      ["chatgpt-web/extra-high", "xhigh", "xhigh"],
      ["chatgpt-web/pro", "ultra", "max"],
    ]);
    expect(CHATGPT_WEB_MODEL_ROUTES[0]?.displayName).toBe("ChatGPT Web — Instant");
  });

  test("exposes only Plus-eligible routes without the Pro account capability", () => {
    expect(availableChatGptWebModelRoutes(plus).map(route => route.slug)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
    ]);
    expect(availableChatGptWebModelRoutes({ solAvailable: true, proAvailable: true }))
      .toEqual(CHATGPT_WEB_MODEL_ROUTES);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", plus))
      .toThrow("Extra High is not available for this account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", plus))
      .toThrow("Pro is not available for this account");
  });

  test("exposes only Luna when the authenticated account has no Sol selector", () => {
    const free = { solAvailable: false, proAvailable: false };
    expect(availableChatGptWebModelRoutes(free)).toEqual([CHATGPT_WEB_LUNA_MODEL_ROUTE]);
    expect(requireChatGptWebModelRoute("chatgpt-web/luna", free).backendModel)
      .toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/light", free))
      .toThrow("Luna-only account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", {
      solAvailable: true,
      proAvailable: false,
    })).toThrow("only available for Luna-only accounts");
  });

  test("publishes measured Plus browser windows and compacts before the transport ceiling", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      contextWindow: 41_000,
      effectiveContextWindowPercent: 78,
      autoCompactTokenLimit: 32_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      contextWindow: 90_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 80_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", plus)).toEqual({
      contextWindow: 90_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 80_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      browserComposerCharLimit: 211_256,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      browserComposerCharLimit: 1_048_572,
    });
    expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", plus))
      .toThrow("unavailable effort");
  });

  test("publishes the usable Pro browser window instead of the unreachable underlying model window", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", pro)).toEqual({
      contextWindow: 111_193,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 95_000,
    });
    for (const effort of ["medium", "high", "xhigh"] as const) {
      expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, pro)).toEqual({
        contextWindow: 111_193,
        effectiveContextWindowPercent: 85,
        autoCompactTokenLimit: 95_000,
      });
    }
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "max", pro)).toEqual({
      contextWindow: 112_193,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 95_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", pro)).toEqual({
      browserMessageTokenLimit: 103_000,
      browserComposerCharLimit: 545_000,
    });
    for (const effort of ["medium", "high", "xhigh"] as const) {
      expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, pro)).toEqual({
        browserMessageTokenLimit: 103_000,
        browserComposerCharLimit: 1_045_000,
      });
    }
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "max", pro)).toEqual({
      browserMessageTokenLimit: 104_000,
      browserComposerCharLimit: 1_635_000,
    });
  });

  test("publishes Luna's real model window without early native compaction", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", {
      solAvailable: false,
      proAvailable: false,
    })).toEqual({
      contextWindow: 1_050_000,
      effectiveContextWindowPercent: 100,
      autoCompactTokenLimit: 1_050_000,
    });
  });

  test("binds the selected model route to the current adapter mode", () => {
    const route = requireChatGptWebModelRoute("chatgpt-web/high", plus);
    const mode = resolveChatGptWebModelMode(route.backendModel, route.adapterEffort, {
      localToolsEnabled: true,
      ...plus,
    });

    expect(route.slug).toBe("chatgpt-web/high");
    expect(route.backendModel).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(route.adapterEffort).toBe("high");
    expect(mode.displayLabel).toBe("High");
    expect(mode.effort).toBe("high");
    expect(mode.localTools).toBe(true);
  });

  test("binds the Pro route to browser Pro mode and fails closed for unknown routes", () => {
    const route = requireChatGptWebModelRoute("chatgpt-web/pro", pro);
    const mode = resolveChatGptWebModelMode(route.backendModel, route.adapterEffort, {
      localToolsEnabled: true,
      ...pro,
    });

    expect(route.adapterEffort).toBe("max");
    expect(mode.displayLabel).toBe("Pro");
    expect(mode.effort).toBe("max");
    expect(mode.localTools).toBe(false);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/not-enabled", pro))
      .toThrow("model is not enabled");
  });

  test("binds the Luna route directly to the current Luna adapter mode", () => {
    const free = { solAvailable: false, proAvailable: false };
    const route = requireChatGptWebModelRoute("chatgpt-web/luna", free);
    const mode = resolveChatGptWebModelMode(route.backendModel, route.adapterEffort, {
      localToolsEnabled: true,
      ...free,
    });

    expect(route).toBe(CHATGPT_WEB_LUNA_MODEL_ROUTE);
    expect(mode.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(mode.effort).toBe("low");
    expect(mode.displayLabel).toBe("Luna");
  });
});
