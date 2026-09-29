import { describe, expect, test } from "bun:test";
import { CouncilAutonomyError, classifyCouncilFailure } from "../src/council/autonomy-errors";

describe("Council autonomy errors", () => {
  test("preserves structured failure codes", () => {
    expect(classifyCouncilFailure(new CouncilAutonomyError("CHATGPT_LIMITED", "limit", false))).toEqual({
      code: "CHATGPT_LIMITED",
      retryableBeforeSubmit: false,
    });
  });

  test("maps legacy capacity evidence conservatively", () => {
    expect(classifyCouncilFailure(new Error("all browser surfaces are busy"))).toEqual({
      code: "CAPACITY_BUSY",
      retryableBeforeSubmit: true,
    });
  });

  test("maps helper readiness loss to a pre-submit connection failure", () => {
    expect(classifyCouncilFailure(new Error("Council browser helper did not become ready"))).toEqual({
      code: "CONNECTION_FAILED",
      retryableBeforeSubmit: true,
    });
  });

  test("classifies composer integrity failures without making them automatic retries", () => {
    expect(classifyCouncilFailure(new Error("ChatGPT Council composer did not preserve the complete prompt (expectedChars=20101, actualChars=20101, commonPrefixChars=11986)"))).toEqual({
      code: "PROMPT_INTEGRITY",
      retryableBeforeSubmit: false,
    });
  });

  test("does not treat an unknown error as retryable", () => {
    expect(classifyCouncilFailure(new Error("unexpected"))).toEqual({
      code: "UNKNOWN",
      retryableBeforeSubmit: false,
    });
  });
});
