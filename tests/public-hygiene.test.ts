import { describe, expect, test } from "bun:test";
import {
  forbiddenPublicPathReason,
  secretTextFindings,
  secretTextFindingsForPath,
} from "../scripts/check-public-hygiene";

describe("public repository hygiene", () => {
  test("rejects private runtime and browser state paths", () => {
    expect(forbiddenPublicPathReason("storage-state.json")).toBeTruthy();
    expect(forbiddenPublicPathReason("browser/Cookies")).toBeTruthy();
    expect(forbiddenPublicPathReason("council/owner-control.json")).toBeTruthy();
    expect(forbiddenPublicPathReason("launcher-state.json")).toBeTruthy();
    expect(forbiddenPublicPathReason("session.jsonl")).toBeTruthy();
    expect(forbiddenPublicPathReason("nested/.cwc-data/council/state.json")).toBe("private runtime state tree");
    expect(forbiddenPublicPathReason("nested/.codex-chatgpt-web/runtime/config.json")).toBe("private runtime state tree");
    expect(forbiddenPublicPathReason("profile/Local Storage/leveldb/000003.log")).toBeTruthy();
    expect(forbiddenPublicPathReason("profile/Session Storage/000005.ldb")).toBe("browser profile state tree");
    expect(forbiddenPublicPathReason("profile/WebStorage/QuotaManager")).toBe("browser profile state tree");
    expect(forbiddenPublicPathReason("profile/IndexedDB/chatgpt.indexeddb.leveldb/000001.log")).toBeTruthy();
    expect(forbiddenPublicPathReason("profile/Service Worker/Database/000001.log")).toBeTruthy();
    expect(forbiddenPublicPathReason("profile/GPUCache/data_0")).toBe("browser profile state tree");
    expect(forbiddenPublicPathReason("README.md")).toBeUndefined();
    expect(forbiddenPublicPathReason("src/config.ts")).toBeUndefined();
    expect(forbiddenPublicPathReason("src/council/store.ts")).toBeUndefined();
  });

  test("detects high-confidence credentials and private credential-bearing URLs", () => {
    const githubToken = "github_" + "pat_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const credentialUrl = "https://owner:" + "secret@example.invalid/path";
    const queryUrl = "https://example.invalid/?access_" + "token=super-secret-access-token";
    const sessionUrl = "https://example.invalid/?session_" + "id=private-session-credential";
    const csrfUrl = "https://example.invalid/?csrf_" + "token=private-csrf-credential";
    expect(secretTextFindings(githubToken)).toContain("GitHub token");
    expect(secretTextFindings(credentialUrl)).toContain("credential-bearing URL");
    expect(secretTextFindings(queryUrl)).toContain("secret URL query parameter");
    expect(secretTextFindings(sessionUrl)).toContain("secret URL query parameter");
    expect(secretTextFindings(csrfUrl)).toContain("secret URL query parameter");
  });

  test("requires a complete key-shaped PEM block instead of a validator marker", () => {
    const header = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";
    const footer = "-----END OPENSSH " + "PRIVATE KEY-----";
    expect(secretTextFindings(header)).not.toContain("private key");
    expect(secretTextFindings(`${header}\n${"A".repeat(64)}\n${footer}`)).toContain("private key");
  });

  test("allows only the exact inherited fake bearer fixtures", () => {
    for (const fixture of [
      "Bearer this-must-never-be-recorded",
      "Bearer secret-should-never-cross-renderer",
      "Bearer ghp_super_secret_should_never_be_logged",
      "Bearer wrong-release-smoke-token",
      "Bearer launcher-control-token-0123456789abcdefghijklmnop",
      "Bearer chatgpt-session-token",
    ]) {
      expect(secretTextFindings(fixture)).toEqual([]);
    }
    const unknownBearer = "Bearer " + "newly-leaked-token-0123456789abcdef";
    expect(secretTextFindings(unknownBearer)).toContain("Bearer credential");
  });

  test("suppresses only known vendor credential-URL test fixtures", () => {
    const fakeCredentialUrl = "https://fixture-user:" + "fixture-password@example.com/path";
    expect(secretTextFindingsForPath(fakeCredentialUrl, "node_modules/fast-uri/test/fixtures/url.js")).toEqual([]);
    expect(secretTextFindingsForPath(fakeCredentialUrl, "node_modules/zod/tests/url.test.js")).toEqual([]);
    expect(secretTextFindingsForPath(fakeCredentialUrl, "node_modules/@mixmark-io/domino/test/domino.js")).toEqual([]);
    expect(secretTextFindingsForPath(fakeCredentialUrl, "node_modules/domino/test/domino.js"))
      .toContain("credential-bearing URL");
    expect(secretTextFindingsForPath(fakeCredentialUrl, "node_modules/other-package/test/url.js"))
      .toContain("credential-bearing URL");
    expect(secretTextFindingsForPath(fakeCredentialUrl, "node_modules/fast-uri/index.js"))
      .toContain("credential-bearing URL");
    const unknownBearer = "Bearer " + "dependency-secret-0123456789abcdef";
    expect(secretTextFindingsForPath(unknownBearer, "node_modules/fast-uri/test/url.js"))
      .toContain("Bearer credential");
  });

  test("suppresses the MCP SDK secret query fixture only in its shipped elicitation URL example", () => {
    const exampleUrl = "https://example.invalid/callback?" + "token=vendor-example-token-value";
    for (const moduleFormat of ["cjs", "esm"]) {
      expect(secretTextFindingsForPath(
        exampleUrl,
        `node_modules/@modelcontextprotocol/sdk/dist/${moduleFormat}/examples/server/elicitationUrlExample.js`,
      )).toEqual([]);
    }
    expect(secretTextFindingsForPath(
      exampleUrl,
      "node_modules/@modelcontextprotocol/sdk/dist/cjs/examples/server/otherExample.js",
    )).toContain("secret URL query parameter");
    expect(secretTextFindingsForPath(
      exampleUrl,
      "node_modules/other-package/dist/cjs/examples/server/elicitationUrlExample.js",
    )).toContain("secret URL query parameter");
  });
});
