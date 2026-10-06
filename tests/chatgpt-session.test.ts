import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";
const { createDocument } = createRequire(import.meta.url)("@mixmark-io/domino");

test("current ChatGPT composer excludes the invitation's separate writing editor", () => {
  const doc = createDocument(`<div contenteditable="true" role="textbox" aria-label="Start writing">Invitation</div>
    <form data-chatgpt-composer>
      <div contenteditable="true" role="textbox" data-composer-markdown aria-label="Ask ChatGPT"></div>
      <button type="button" aria-label="Dictate"></button>
      <button type="submit" aria-label="Send"></button>
    </form>`);
  const composers = doc.querySelectorAll(CHATGPT_COMPOSER_SELECTOR);
  expect(composers.length).toBe(1);
  expect(composers[0].getAttribute("aria-label")).toBe("Ask ChatGPT");
  const send = composers[0].closest("form").querySelectorAll(CHATGPT_SEND_BUTTON_SELECTOR);
  expect(send.length).toBe(1);
  expect(send[0].getAttribute("type")).toBe("submit");
});

test("legacy composer and send controls remain supported", () => {
  const doc = createDocument(`<form><div id="prompt-textarea" contenteditable="true" data-lexical-editor="true"></div>
    <button data-testid="send-button" type="submit" aria-label="Send"></button></form>`);
  const composers = doc.querySelectorAll(CHATGPT_COMPOSER_SELECTOR);
  expect(composers.length).toBe(1);
  expect(composers[0].closest("form").querySelectorAll(CHATGPT_SEND_BUTTON_SELECTOR).length).toBe(1);
});

test("login keeps the established turn composer contract", () => {
  const turnSelectors = CHATGPT_COMPOSER_SELECTOR.split(",").map(selector => selector.trim());
  expect(turnSelectors).toContain('[data-testid="prompt-textarea"]');
  expect(turnSelectors).toContain("#prompt-textarea");
  expect(turnSelectors).toContain('[contenteditable="true"][data-lexical-editor="true"]');
  expect(turnSelectors).not.toContain('form [contenteditable="true"]');
  expect(turnSelectors).not.toContain("form textarea[placeholder]");
});

test("the effort selector identifies the model slider instead of any composer menu button", () => {
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('[data-animated-slider-trigger="true"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('[data-testid="model-switcher-dropdown-button"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).not.toBe('button[aria-haspopup="menu"]');
});

test("a complete authenticated composer with no effort selector is Luna-only", async () => {
  const effortButton = {
    last() { return this; },
    isVisible: async () => false,
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composer = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composer,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
});

test("a transient effort control does not turn a Luna-only account into Sol", async () => {
  let visibilityReads = 0;
  const effortButton = {
    last() { return this; },
    isVisible: async () => {
      visibilityReads += 1;
      return visibilityReads === 1;
    },
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composers = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composers,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
  expect(visibilityReads).toBe(2);
});
