import { describe, expect, test } from "bun:test";
import { forbiddenPublicPathReason, secretTextFindings } from "../scripts/check-public-hygiene";

describe("public repository hygiene", () => {
  test("rejects private runtime and browser state paths", () => {
    expect(forbiddenPublicPathReason("storage-state.json")).toBeTruthy();
    expect(forbiddenPublicPathReason("browser/Cookies")).toBeTruthy();
    expect(forbiddenPublicPathReason("council/owner-control.json")).toBeTruthy();
    expect(forbiddenPublicPathReason("launcher-state.json")).toBeTruthy();
    expect(forbiddenPublicPathReason("session.jsonl")).toBeTruthy();
    expect(forbiddenPublicPathReason("README.md")).toBeUndefined();
    expect(forbiddenPublicPathReason("src/config.ts")).toBeUndefined();
  });

  test("detects high-confidence credentials and private credential-bearing URLs", () => {
    const githubToken = "github_" + "pat_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const credentialUrl = "https://owner:" + "secret@example.invalid/path";
    const queryUrl = "https://example.invalid/?access_" + "token=super-secret-access-token";
    const privateKeyHeader = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";
    expect(secretTextFindings(githubToken)).toContain("GitHub token");
    expect(secretTextFindings(credentialUrl)).toContain("credential-bearing URL");
    expect(secretTextFindings(queryUrl)).toContain("secret URL query parameter");
    expect(secretTextFindings(privateKeyHeader)).toContain("private key");
  });

  test("allows the explicit fake credentials used by logging tests", () => {
    expect(secretTextFindings("sk-exampleRuntimeSecret123")).toEqual([]);
    expect(secretTextFindings("Bearer this-must-never-be-recorded")).toEqual([]);
  });
});
