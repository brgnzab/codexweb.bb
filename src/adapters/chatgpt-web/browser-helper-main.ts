import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import type { CodexProviderConfig } from "../../types";
import { PlaywrightCouncilChatDriver } from "../../council/playwright-council-driver";
import type { CouncilExecutionObservation, CouncilPromptAttachment } from "../../council/browser-transport";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "./browser-worker";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptWebCapabilities } from "./model";
import { createProcessLineWriter } from "./process-line-writer";
import type { CompiledChatGptWebPrompt } from "./prompt";

interface RunMessage {
  type: "run";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
    turnTimeoutMs: number;
    autoApproveToolCalls: boolean;
  };
  turn: {
    traceId: string;
    modelId: string;
    reasoning?: string;
    capabilities: ChatGptWebCapabilities;
    prepared: CompiledChatGptWebPrompt;
    captureLunaCheckpoint?: boolean;
  };
}

interface VerifyMessage {
  type: "verify";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
  };
}

interface InspectMessage {
  type: "inspect";
  id: string;
  config: VerifyMessage["config"];
  detectCapabilities: boolean;
}

interface SmokeMessage {
  type: "smoke";
  id: string;
  config: VerifyMessage["config"];
}

interface CouncilMessage {
  type: "council";
  id: string;
  operation: "create" | "resume" | "focus" | "capture";
  config: { browserHostDescriptorPath: string };
  input: {
    surfaceId: string;
    conversationUrl?: string;
    prompt?: string;
    attachments?: Array<{
      name: string;
      mimeType: CouncilPromptAttachment["mimeType"];
      base64: string;
    }>;
  };
}

type MaintenanceMessage = VerifyMessage | InspectMessage | SmokeMessage;
type InputMessage = RunMessage | MaintenanceMessage | CouncilMessage | { type: "abort"; id: string } | { type: "shutdown" };

let outputFailure: Error | undefined;
const handleOutputFailure = (error: Error): void => {
  if (outputFailure) return;
  outputFailure = error;
  void requestShutdown();
};
const protocolOutput = createProcessLineWriter(stdout, handleOutputFailure);
const diagnosticOutput = createProcessLineWriter(stderr, handleOutputFailure);

const writeProtocol = (message: unknown): void => {
  protocolOutput.write(JSON.stringify(message));
};

const diagnostic = (...values: unknown[]): void => {
  diagnosticOutput.write(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
};
console.info = diagnostic;
console.warn = diagnostic;
console.error = diagnostic;

const abortControllers = new Map<string, AbortController>();
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

function requestShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  let completeShutdown!: () => void;
  shutdownPromise = new Promise<void>(resolveShutdown => {
    completeShutdown = resolveShutdown;
  });
  shuttingDown = true;
  protocolOutput.close();
  diagnosticOutput.close();
  for (const controller of abortControllers.values()) controller.abort();
  input.close();
  void closeChatGptBrowserWorkers().then(
    () => {
      completeShutdown();
      process.exit(0);
    },
    error => {
      diagnostic(`Browser helper shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      completeShutdown();
      process.exit(1);
    },
  );
  return shutdownPromise;
}

async function run(message: RunMessage): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id) || message.id !== message.turn.traceId) {
    throw new Error("Browser helper turn identity is invalid");
  }
  if (abortControllers.has(message.id)) throw new Error(`Browser helper turn already exists: ${message.id}`);
  if (!message.turn.prepared || typeof message.turn.prepared.text !== "string" || !Array.isArray(message.turn.prepared.images)) {
    throw new Error("Browser helper prompt is invalid");
  }
  if (message.turn.captureLunaCheckpoint !== undefined && typeof message.turn.captureLunaCheckpoint !== "boolean") {
    throw new Error("Browser helper Luna checkpoint flag is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName: message.config.appName,
      browserHost: "launcher",
      browserHostDescriptorPath: message.config.browserHostDescriptorPath,
      turnTimeoutMs: message.config.turnTimeoutMs,
      autoApproveToolCalls: message.config.autoApproveToolCalls,
    },
  };
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  const turn: BrowserTurn = {
    traceId: message.turn.traceId,
    modelId: message.turn.modelId,
    reasoning: message.turn.reasoning,
    capabilities: message.turn.capabilities,
    prepare: async () => ({ ...message.turn.prepared, release: () => {} }),
    abortSignal: abortController.signal,
    onHeartbeat: () => writeProtocol({ type: "event", id: message.id, event: "heartbeat" }),
    onReasoningSummary: (text, continuation) => writeProtocol({
      type: "event",
      id: message.id,
      event: "reasoning",
      text,
      ...(continuation ? { continuation: true } : {}),
    }),
    onCommentary: (text, continuation) => writeProtocol({ type: "event", id: message.id, event: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
    onTextDelta: text => writeProtocol({ type: "event", id: message.id, event: "text", text }),
    ...(message.turn.captureLunaCheckpoint ? {
      captureLunaCheckpoint: true,
      onLunaCheckpoint: captured => writeProtocol({
        type: "event",
        id: message.id,
        event: "luna_checkpoint",
        ...captured,
      }),
    } : {}),
  };
  try {
    const text = await ChatGptBrowserWorker.forProvider(provider).run(turn);
    writeProtocol({ type: "result", id: message.id, text });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ChatGptWebAdapterError ? {
        status: error.status,
        errorType: error.errorType,
        code: error.code,
        retryable: error.retryable,
      } : {}),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

function councilAttachments(message: CouncilMessage): CouncilPromptAttachment[] | undefined {
  if (message.input.attachments === undefined) return undefined;
  if (!Array.isArray(message.input.attachments) || message.input.attachments.length > 20) throw new Error("Council browser helper attachments are invalid");
  return message.input.attachments.map(file => {
    if (!file || typeof file !== "object"
      || typeof file.name !== "string"
      || !file.name.trim()
      || file.name.length > 240
      || !["image/png", "image/jpeg", "image/webp"].includes(file.mimeType)
      || typeof file.base64 !== "string") {
      throw new Error("Council browser helper attachment is invalid");
    }
    const buffer = Buffer.from(file.base64, "base64");
    if (buffer.length === 0) throw new Error("Council browser helper attachment is empty");
    return { name: file.name, mimeType: file.mimeType, buffer };
  });
}

async function runCouncil(message: CouncilMessage): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id)) throw new Error("Council browser helper operation identity is invalid");
  if (abortControllers.has(message.id)) throw new Error(`Council browser helper operation already exists: ${message.id}`);
  const descriptorPath = message.config?.browserHostDescriptorPath?.trim();
  if (!descriptorPath) throw new Error("Council browser helper descriptor path is invalid");
  if (!/^[A-Za-z0-9_-]{32}$/.test(message.input?.surfaceId ?? "")) throw new Error("Council browser helper surface identity is invalid");
  if (!["create", "resume", "focus", "capture"].includes(message.operation)) throw new Error("Council browser helper operation is invalid");

  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  const driver = new PlaywrightCouncilChatDriver(descriptorPath);
  const onExecution = (observation: CouncilExecutionObservation) => writeProtocol({ type: "council-event", id: message.id, observation });
  try {
    let value: unknown;
    if (message.operation === "create") {
      if (typeof message.input.prompt !== "string") throw new Error("Council browser helper create prompt is invalid");
      value = await driver.create({
        surfaceId: message.input.surfaceId,
        prompt: message.input.prompt,
        attachments: councilAttachments(message),
        signal: abortController.signal,
        onExecution,
      });
    } else if (message.operation === "resume") {
      if (typeof message.input.prompt !== "string" || typeof message.input.conversationUrl !== "string") throw new Error("Council browser helper resume input is invalid");
      value = await driver.resume({
        surfaceId: message.input.surfaceId,
        conversationUrl: message.input.conversationUrl,
        prompt: message.input.prompt,
        attachments: councilAttachments(message),
        signal: abortController.signal,
        onExecution,
      });
    } else if (message.operation === "focus") {
      if (typeof message.input.conversationUrl !== "string") throw new Error("Council browser helper focus input is invalid");
      value = await driver.focus!({
        surfaceId: message.input.surfaceId,
        conversationUrl: message.input.conversationUrl,
        signal: abortController.signal,
      });
    } else {
      if (typeof message.input.conversationUrl !== "string") throw new Error("Council browser helper capture input is invalid");
      const captured = await driver.capture!({
        surfaceId: message.input.surfaceId,
        conversationUrl: message.input.conversationUrl,
        signal: abortController.signal,
      });
      value = {
        pngBase64: captured.png.toString("base64"),
        conversationUrl: captured.conversationUrl,
        health: captured.health,
        ...(captured.note ? { note: captured.note } : {}),
      };
    }
    writeProtocol({ type: "council-result", id: message.id, value });
  } catch (error) {
    writeProtocol({
      type: "council-error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

async function verify(message: VerifyMessage): Promise<void> {
  try {
    const selected = await maintenanceWorker(message).verifyConnector();
    writeProtocol({ type: "result", id: message.id, text: selected });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function maintenanceWorker(message: MaintenanceMessage): ChatGptBrowserWorker {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id)) {
    throw new Error("Browser helper maintenance identity is invalid");
  }
  const appName = message.config.appName?.trim();
  const browserHostDescriptorPath = message.config.browserHostDescriptorPath?.trim();
  if (!appName || appName.length > 80 || !browserHostDescriptorPath) {
    throw new Error("Browser helper maintenance config is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: { appName, browserHost: "launcher", browserHostDescriptorPath },
  };
  return ChatGptBrowserWorker.forProvider(provider);
}

async function maintain(message: InspectMessage | SmokeMessage): Promise<void> {
  if (abortControllers.has(message.id)) throw new Error(`Browser helper maintenance operation already exists: ${message.id}`);
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  try {
    const worker = maintenanceWorker(message);
    const value = message.type === "inspect"
      ? await worker.inspectSession(message.detectCapabilities)
      : await worker.smokeTest(abortController.signal);
    writeProtocol({ type: "result", id: message.id, value });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

const input = createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (shuttingDown) return;
  let message: InputMessage;
  try { message = JSON.parse(line) as InputMessage; }
  catch {
    writeProtocol({ type: "error", id: "protocol", message: "Browser helper received invalid JSON" });
    return;
  }
  if (message.type === "abort") abortControllers.get(message.id)?.abort();
  else if (message.type === "shutdown") {
    void requestShutdown();
  } else if (message.type === "verify") {
    void verify(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "inspect" || message.type === "smoke") {
    void maintain(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "council") {
    void runCouncil(message).catch(error => writeProtocol({
      type: "council-error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    }));
  } else {
    void run(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
});
input.on("close", () => {
  void requestShutdown();
});
process.once("SIGINT", () => {
  void requestShutdown();
});
process.once("SIGTERM", () => {
  void requestShutdown();
});

writeProtocol({ type: "ready" });