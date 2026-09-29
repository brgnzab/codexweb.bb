import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { councilPromptEquivalentPrefixLength, councilPromptTextEquivalent } from "../src/council/playwright-council-driver";

describe("Council ChatGPT prompt preservation", () => {
  test("accepts Lexical NBSP preservation only inside expected multi-space runs", () => {
    const expected = `prefix\n${" ".repeat(24)}suffix`;
    const observed = `prefix\n${"\u00A0 ".repeat(12)}suffix`;
    expect(observed.length).toBe(expected.length);
    expect(councilPromptTextEquivalent(expected, observed)).toBeTrue();
    expect(councilPromptEquivalentPrefixLength(expected, observed)).toBe(expected.length);
  });

  test("accepts pretty-printed Council JSON indentation represented with NBSP", () => {
    const expected = JSON.stringify({ roomId: "g9", nested: { token: "CWC017" } }, null, 2);
    const observed = expected.replace(/^ {2,}/gm, spaces => spaces.replace(/ (?= )/g, "\u00A0"));
    expect(observed.length).toBe(expected.length);
    expect(councilPromptTextEquivalent(expected, observed)).toBeTrue();
  });

  test("keeps single spaces, newlines, tabs and intentional NBSP exact", () => {
    expect(councilPromptTextEquivalent("a b", "a\u00A0b")).toBeFalse();
    expect(councilPromptTextEquivalent("a\nb", "a b")).toBeFalse();
    expect(councilPromptTextEquivalent("a\tb", "a b")).toBeFalse();
    expect(councilPromptTextEquivalent("a\u00A0b", "a b")).toBeFalse();
  });

  test("long prompt insertion re-acquires the live composer, restores the caret and verifies every chunk before continuing", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "council", "playwright-council-driver.ts"), "utf8");
    expect(source).toContain("const INSERT_CHUNK_CHARS = 4_000");
    expect(source).toContain("composer = await visibleComposer(page)");
    expect(source).toContain("await moveComposerCaretToEnd(composer)");
    expect(source).toContain("const observedSoFar = await waitForComposerText(composer, expectedSoFar, signal)");
    expect(source).toContain("if (!councilPromptTextEquivalent(expectedSoFar, observedSoFar))");
  });
});
