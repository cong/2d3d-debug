import * as vscode from "vscode";
import * as os from "os";
import { MEMORY_CHUNK_SIZE } from "../constants";
import type { EvaluateResult } from "../types";

/** Evaluate context compatible with the active debugger adapter. */
export function getEvaluateContext(debugSession: vscode.DebugSession): string {
  return debugSession.type === "lldb" ? "watch" : "repl";
}

export function isUsingLLDB(debugSession: vscode.DebugSession): boolean {
  return debugSession.type === "lldb";
}

export function isUsingCppdbg(debugSession: vscode.DebugSession): boolean {
  return debugSession.type === "cppdbg";
}

export function isUsingMSVC(debugSession: vscode.DebugSession): boolean {
  return debugSession.type === "cppvsdbg";
}

export function isPythonDebugSession(debugSession: vscode.DebugSession): boolean {
  return debugSession.type === "python" || debugSession.type === "debugpy";
}

export async function evaluateWithTimeout(
  debugSession: vscode.DebugSession,
  expression: string,
  frameId: number,
  timeout: number
): Promise<EvaluateResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      debugSession.customRequest("evaluate", {
        expression,
        frameId,
        context: getEvaluateContext(debugSession),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Evaluation request timed out")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getCurrentFrameId(
  debugSession: vscode.DebugSession
): Promise<number> {
  try {
    const threadsResponse = await debugSession.customRequest("threads", {});
    const thread = threadsResponse.threads?.[0];
    if (!thread) {
      return 0;
    }

    const stackResponse = await debugSession.customRequest("stackTrace", {
      threadId: thread.id,
      startFrame: 0,
      levels: 1,
    });
    return stackResponse.stackFrames?.[0]?.id ?? 0;
  } catch (error) {
    console.error("Failed to get current frame ID:", error);
    return 0;
  }
}

/**
 * Read debugger memory in parallel chunks to work around adapter size limits.
 */
export async function readMemoryChunked(
  debugSession: vscode.DebugSession,
  memoryReference: string,
  totalBytes: number,
  startOffset = 0
): Promise<Buffer | null> {
  const cpuCount = os.cpus().length || 4;
  const concurrency = Math.min(8, Math.max(2, cpuCount));
  const numChunks = Math.ceil(totalBytes / MEMORY_CHUNK_SIZE);
  const result = Buffer.allocUnsafeSlow(totalBytes);

  let nextChunkIndex = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (nextChunkIndex < numChunks && !failed) {
      const index = nextChunkIndex++;
      const offset = index * MEMORY_CHUNK_SIZE;
      const count = Math.min(MEMORY_CHUNK_SIZE, totalBytes - offset);

      try {
        const memoryResponse = await debugSession.customRequest("readMemory", {
          memoryReference,
          offset: startOffset + offset,
          count,
        });

        if (memoryResponse?.data && !failed) {
          const buffer = Buffer.from(memoryResponse.data, "base64");
          if (buffer.length !== count || memoryResponse.unreadableBytes > 0) {
            throw new Error("Incomplete memory read at offset " + offset);
          }
          buffer.copy(result, offset);
        } else if (!failed) {
          console.error(`readMemory returned no data for chunk ${index}`);
          failed = true;
        }
      } catch (error) {
        console.error(`Error reading memory chunk ${index}:`, error);
        failed = true;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return failed ? null : result;
}

/** Try a list of debugger expressions until a memory pointer is found. */
export async function tryGetDataPointer(
  debugSession: vscode.DebugSession,
  expressions: string[],
  frameId: number,
  context: string
): Promise<string | null> {
  for (const expression of expressions) {
    try {
      const response = await debugSession.customRequest("evaluate", {
        expression,
        frameId,
        context,
      });

      const ptrMatch = response.result?.match(/0x[0-9a-fA-F]+/);
      if (ptrMatch) {
        return ptrMatch[0];
      }
      if (response.memoryReference) {
        return response.memoryReference;
      }
    } catch {
      // Try the next expression.
    }
  }
  return null;
}

/** Use the selected frame, or resolve the first frame of the selected thread. */
export async function getActiveFrameId(debugSession: vscode.DebugSession): Promise<number> {
  const selected = vscode.debug.activeStackItem;
  if (selected?.session.id === debugSession.id && "frameId" in selected) {
    return selected.frameId;
  }

  const threadId = selected?.session.id === debugSession.id
    ? selected.threadId
    : (await debugSession.customRequest("threads")).threads?.[0]?.id;
  if (threadId === undefined) {
    throw new Error("No stopped debug thread.");
  }
  const response = await debugSession.customRequest("stackTrace", {
    threadId, startFrame: 0, levels: 1,
  });
  const frameId = response.stackFrames?.[0]?.id;
  if (frameId === undefined) {
    throw new Error("Pause the debugger and select a stack frame.");
  }
  return frameId;
}

export function isolatedPythonScript(variableName: string, code: string): string {
  return 'exec(' + JSON.stringify(code) + ', {"__viewer_value": (' + variableName + ')})';
}

/** Evaluate a variable in the current debug frame. */
export async function evaluateVariable(
  debugSession: vscode.DebugSession,
  variableName: string,
  frameId: number,
  fallback?: { value?: string; type?: string; variablesReference?: number }
): Promise<import("../types").DebugVariableInfo> {
  if (debugSession.type === "lldb") {
    try {
      const evalResult = await debugSession.customRequest("evaluate", {
        expression: variableName,
        frameId,
        context: "watch",
      });
      return {
        result: evalResult.result ?? fallback?.value,
        type: evalResult.type ?? fallback?.type,
        variablesReference:
          evalResult.variablesReference ?? fallback?.variablesReference,
        evaluateName: variableName,
        frameId,
      };
    } catch {
      return {
        result: fallback?.value,
        type: fallback?.type,
        variablesReference: fallback?.variablesReference,
        evaluateName: variableName,
        frameId,
      };
    }
  }

  const variableInfo = await debugSession.customRequest("evaluate", {
    expression: variableName,
    frameId,
    context: getEvaluateContext(debugSession),
  });
  return { ...variableInfo, evaluateName: variableName, frameId };
}
