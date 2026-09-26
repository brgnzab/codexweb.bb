import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { readLauncherBrowserHostDescriptor } from "../launcher-browser-host";
import type {
  CouncilExecutionObservation,
  CouncilPersistentChatDriver,
  CouncilPromptAttachment,
} from "./browser-transport";
import {
  CouncilConversationUnavailableError,
  CouncilSurfaceUnavailableError,
} from "./browser-transport";
import type { CouncilExecutionPhase } from "./autonomy-errors";
import { assertChatGptConversationUrl } from "./conversation-registry";
import type { CouncilObservationHealth } from "./observation-store";

const VALID_PHASES = new Set<CouncilExecutionPhase>([
  "lease-acquired",
  "conversation-ready",
  "connector-selected",
  "prompt-attached",
  "files-attached",
  "submit-started",
  "submit-observed",
  "response-streaming",
  "response-complete",
]);
const VALID_HEALTH = new Set<CouncilObservationHealth>([
  "healthy",
  "sleeping",
  "busy",
  "limited",
  "signed-out",
  "conversation-missing",
  "surface-unavailable",
  "connection-error",
  "response-stalled",
  "unknown",
]);

type CouncilOperation = "create" | "resume" | "focus" | "capture";

type TurnInput = {
  surfaceId: string;
  prompt: string;
  attachments?: CouncilPromptAttachment[];
  signal?: AbortSignal;
  onPhase?: (phase: CouncilExecutionPhase) => void;
  onExecution?: (observation: CouncilExecutionObservation) => void;
};
type ResumeInput = TurnInput & { conversationUrl: string };
type FocusInput = { surfaceId: string; conversationUrl: string; signal?: AbortSignal };
type CaptureInput = FocusInput;

type WireAttachment = { name: string; mimeType: CouncilPromptAttachment["mimeType"]; base64: string };
type WireInput = {
  surfaceId: string;
  conversationUrl?: string;
  prompt?: string;
  attachments?: WireAttachment[];
};

type WireMessage =
  | { type: "ready" }
  | { type: "council-event"; id: string; observation: unknown }
  | { type: "council-result"; id: string; value: unknown }
  | { type: "council-error"; id: string; name?: string; message: string };

function boundedDiagnostic(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(-2_000);
}

function serializeAttachments(attachments?: CouncilPromptAttachment[]): WireAttachment[] | undefined {
  if (!attachments?.length) return undefined;
  if (attachments.length > 20) throw new Error("Council manager turn supports at most 20 screenshot attachments");
  return attachments.map(file => ({
    name: file.name,
    mimeType: file.mimeType,
    base64: file.buffer.toString("base64"),
  }));
}

function parseObservation(value: unknown): CouncilExecutionObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Council browser helper emitted an invalid execution observation");
  const observation = value as Record<string, unknown>;
  if (observation.type === "phase") {
    if (typeof observation.phase !== "string" || !VALID_PHASES.has(observation.phase as CouncilExecutionPhase)) {
      throw new Error("Council browser helper emitted an invalid execution phase");
    }
    return { type: "phase", phase: observation.phase as CouncilExecutionPhase };
  }
  if (observation.type === "deep-state") {
    if (typeof observation.state !== "string"
      || typeof observation.confidence !== "number"
      || !Number.isFinite(observation.confidence)
      || observation.confidence < 0
      || observation.confidence > 1
      || typeof observation.reason !== "string"
      || observation.reason.length > 500) {
      throw new Error("Council browser helper emitted invalid deep-state telemetry");
    }
    return observation as CouncilExecutionObservation;
  }
  if (observation.type === "health") {
    if (typeof observation.health !== "string"
      || !VALID_HEALTH.has(observation.health as CouncilObservationHealth)
      || (observation.note !== undefined && (typeof observation.note !== "string" || observation.note.length > 500))) {
      throw new Error("Council browser helper emitted invalid health telemetry");
    }
    return observation as CouncilExecutionObservation;
  }
  throw new Error("Council browser helper emitted an unknown execution observation");
}

function parseMessage(line: string): WireMessage {
  const decoded = JSON.parse(line) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Council browser helper protocol message is not an object");
  const message = decoded as Record<string, unknown>;
  if (message.type === "ready") return { type: "ready" };
  if (typeof message.id !== "string" || !message.id) throw new Error("Council browser helper protocol message has no identity");
  if (message.type === "council-event") return { type: "council-event", id: message.id, observation: message.observation };
  if (message.type === "council-result") return { type: "council-result", id: message.id, value: message.value };
  if (message.type === "council-error") {
    if (typeof message.message !== "string" || (message.name !== undefined && typeof message.name !== "string")) {
      throw new Error("Council browser helper error payload is invalid");
    }
    return { type: "council-error", id: message.id, message: message.message, ...(message.name ? { name: message.name as string } : {}) };
  }
  throw new Error("Council browser helper emitted an unknown protocol message");
}

function reconstructError(message: Extract<WireMessage, { type: "council-error" }>): Error {
  if (message.name === "AbortError") return new DOMException(message.message, "AbortError");
  if (message.name === "CouncilConversationUnavailableError") return new CouncilConversationUnavailableError(message.message);
  if (message.name === "CouncilSurfaceUnavailableError") return new CouncilSurfaceUnavailableError(message.message);
  const error = new Error(message.message);
  if (message.name) error.name = message.name;
  return error;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

async function stopHelper(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`); } catch {}
  try { child.stdin.end(); } catch {}
  if (await waitForExit(child, 2_000)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2_000)) return;
  child.kill("SIGKILL");
}

export class NodePlaywrightCouncilChatDriver implements CouncilPersistentChatDriver {
  constructor(private readonly descriptorPath: string) {}

  async resume(input: ResumeInput): Promise<{ answer: string; conversationUrl: string }> {
    const value = await this.invoke("resume", input, {
      surfaceId: input.surfaceId,
      conversationUrl: assertChatGptConversationUrl(input.conversationUrl),
      prompt: input.prompt,
      attachments: serializeAttachments(input.attachments),
    });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Council browser helper returned an invalid resume result");
    const result = value as Record<string, unknown>;
    if (typeof result.answer !== "string" || typeof result.conversationUrl !== "string") throw new Error("Council browser helper returned an invalid resume result");
    return { answer: result.answer, conversationUrl: assertChatGptConversationUrl(result.conversationUrl) };
  }

  async create(input: TurnInput): Promise<{ answer: string; conversationUrl: string }> {
    const value = await this.invoke("create", input, {
      surfaceId: input.surfaceId,
      prompt: input.prompt,
      attachments: serializeAttachments(input.attachments),
    });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Council browser helper returned an invalid create result");
    const result = value as Record<string, unknown>;
    if (typeof result.answer !== "string" || typeof result.conversationUrl !== "string") throw new Error("Council browser helper returned an invalid create result");
    return { answer: result.answer, conversationUrl: assertChatGptConversationUrl(result.conversationUrl) };
  }

  async focus(input: FocusInput): Promise<{ conversationUrl: string }> {
    const value = await this.invoke("focus", input, { surfaceId: input.surfaceId, conversationUrl: assertChatGptConversationUrl(input.conversationUrl) });
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).conversationUrl !== "string") {
      throw new Error("Council browser helper returned an invalid focus result");
    }
    return { conversationUrl: assertChatGptConversationUrl((value as Record<string, unknown>).conversationUrl as string) };
  }

  async capture(input: CaptureInput): Promise<{ png: Buffer; conversationUrl: string; health: CouncilObservationHealth; note?: string }> {
    const value = await this.invoke("capture", input, { surfaceId: input.surfaceId, conversationUrl: assertChatGptConversationUrl(input.conversationUrl) });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Council browser helper returned an invalid capture result");
    const result = value as Record<string, unknown>;
    if (typeof result.pngBase64 !== "string"
      || typeof result.conversationUrl !== "string"
      || typeof result.health !== "string"
      || !VALID_HEALTH.has(result.health as CouncilObservationHealth)
      || (result.note !== undefined && typeof result.note !== "string")) {
      throw new Error("Council browser helper returned an invalid capture result");
    }
    const png = Buffer.from(result.pngBase64, "base64");
    if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new Error("Council browser helper returned invalid PNG evidence");
    }
    return {
      png,
      conversationUrl: assertChatGptConversationUrl(result.conversationUrl),
      health: result.health as CouncilObservationHealth,
      ...(typeof result.note === "string" ? { note: result.note.slice(0, 500) } : {}),
    };
  }

  private async invoke(operation: CouncilOperation, input: { signal?: AbortSignal; onPhase?: (phase: CouncilExecutionPhase) => void; onExecution?: (observation: CouncilExecutionObservation) => void }, wireInput: WireInput): Promise<unknown> {
    if (input.signal?.aborted) throw new DOMException("Council ChatGPT turn aborted", "AbortError");
    const descriptor = readLauncherBrowserHostDescriptor(this.descriptorPath);
    const id = `councilhelper_${randomUUID().replaceAll("-", "")}`;
    const child = spawn(descriptor.helper.executable, [descriptor.helper.script], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderrTail = "";
    const errors = createInterface({ input: child.stderr });
    errors.on("line", line => { stderrTail = boundedDiagnostic(`${stderrTail} ${line}`); });
    const output = createInterface({ input: child.stdout });
    let sent = false;
    let abortListener: (() => void) | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          if (readyTimer) clearTimeout(readyTimer);
          if (abortListener && input.signal) input.signal.removeEventListener("abort", abortListener);
          callback();
        };
        const fail = (error: Error) => finish(() => reject(error));
        const send = (message: unknown) => {
          if (child.exitCode !== null || child.signalCode !== null || child.killed) throw new Error("Council browser helper exited before request dispatch");
          child.stdin.write(`${JSON.stringify(message)}\n`);
        };

        abortListener = () => {
          if (!sent) {
            fail(new DOMException("Council ChatGPT turn aborted", "AbortError"));
            return;
          }
          try { send({ type: "abort", id }); }
          catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        };
        input.signal?.addEventListener("abort", abortListener, { once: true });

        child.once("error", error => fail(new Error(`Council browser helper process failed: ${error.message}`)));
        child.stdin.once("error", error => fail(new Error(`Council browser helper input failed: ${error.message}`)));
        child.once("exit", (code, signal) => {
          if (settled) return;
          fail(new Error(`Council browser helper exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}${stderrTail ? `: ${stderrTail}` : ""}`));
        });

        output.on("line", line => {
          if (settled) return;
          let message: WireMessage;
          try { message = parseMessage(line); }
          catch (error) {
            fail(new Error(`Council browser helper emitted invalid protocol data: ${error instanceof Error ? error.message : String(error)}`));
            return;
          }
          if (message.type === "ready") {
            if (sent) return;
            if (input.signal?.aborted) {
              fail(new DOMException("Council ChatGPT turn aborted", "AbortError"));
              return;
            }
            sent = true;
            try {
              send({
                type: "council",
                id,
                operation,
                config: { browserHostDescriptorPath: this.descriptorPath },
                input: wireInput,
              });
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
          if (message.id !== id) return;
          if (message.type === "council-event") {
            try {
              const observation = parseObservation(message.observation);
              if (observation.type === "phase") input.onPhase?.(observation.phase);
              input.onExecution?.(observation);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
          if (message.type === "council-result") finish(() => resolve(message.value));
          else if (message.type === "council-error") fail(reconstructError(message));
        });

        readyTimer = setTimeout(() => fail(new Error(`Council browser helper did not become ready${stderrTail ? `: ${stderrTail}` : ""}`)), 15_000);
      });
    } finally {
      output.close();
      errors.close();
      await stopHelper(child).catch(() => {});
    }
  }
}
