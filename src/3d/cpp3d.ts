import * as vscode from "vscode";
import { MEMORY_CHUNK_SIZE } from "../constants";
import type { DebugVariableInfo, Point3D } from "../types";
import {
  getCurrentFrameId,
  getEvaluateContext,
  isUsingCppdbg,
  isUsingLLDB,
  isUsingMSVC,
  readMemoryChunked,
  tryGetDataPointer,
} from "../utils/debugger";
import { openCppPointCloudPanel, type CloudSnapshot } from "../utils/pointCloudPanel";

export async function drawPointCloud(
  debugSession: vscode.DebugSession,
  variableInfo: DebugVariableInfo,
  variableName: string,
  isDouble = false
): Promise<void> {
  const points = await loadPointCloudWithProgress(
    variableInfo,
    (progress) =>
      getPointCloudViaReadMemory(
        debugSession,
        variableInfo.evaluateName ?? variableName,
        variableInfo,
        isDouble,
        progress
      ),
    "Loading OpenCV Point Cloud"
  );

  await openCppPointCloudPanel(
    debugSession,
    variableName,
    points
  );
}

export async function drawPointCloudPCL(
  debugSession: vscode.DebugSession,
  variableInfo: DebugVariableInfo,
  variableName: string,
  hasRGB: boolean
): Promise<void> {
  const points = await loadPointCloudWithProgress(
    variableInfo,
    (progress) =>
      getPointCloudViaReadMemoryPCL(
        debugSession,
        variableInfo.evaluateName ?? variableName,
        variableInfo,
        hasRGB,
        progress
      ),
    "Loading PCL Point Cloud"
  );

  await openCppPointCloudPanel(
    debugSession,
    variableName,
    points
  );
}

async function loadPointCloudWithProgress(
  variableInfo: DebugVariableInfo,
  loader: (
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ) => Promise<CloudSnapshot | undefined>,
  title: string
): Promise<CloudSnapshot | undefined> {
  if (!variableInfo.evaluateName) {
    return undefined;
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Reading point cloud data..." });
      return loader(progress);
    }
  );
}

export async function getPointCloudViaReadMemory(
  debugSession: vscode.DebugSession,
  evaluateName: string,
  variableInfo: DebugVariableInfo,
  isDouble: boolean,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<CloudSnapshot | undefined> {
  const frameId = variableInfo.frameId ?? (await getCurrentFrameId(debugSession));
  const context = getEvaluateContext(debugSession);

  const size = await resolveVectorSize(debugSession, evaluateName, variableInfo, frameId, context);
  if (size <= 0) {
    return undefined;
  }

  progress.report({ message: `Reading ${size} points...` });

  const dataPtr = await resolveVectorDataPointer(
    debugSession,
    evaluateName,
    variableInfo,
    frameId,
    context
  );
  if (!dataPtr) {
    return undefined;
  }

  return readCloudSnapshot(debugSession, dataPtr, size, isDouble ? 24 : 12, isDouble, false, progress);
}

export async function getPointCloudViaReadMemoryPCL(
  debugSession: vscode.DebugSession,
  evaluateName: string,
  variableInfo: DebugVariableInfo,
  hasRGB: boolean,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<CloudSnapshot | undefined> {
  const frameId = variableInfo.frameId ?? (await getCurrentFrameId(debugSession));
  const context = getEvaluateContext(debugSession);
  const baseExpr = resolvePclPointsExpression(evaluateName, variableInfo.type ?? "");

  let size = 0;
  const resultMatch = variableInfo.result?.match(/with\s+(\d+)\s+points/);
  if (resultMatch) {
    size = parseInt(resultMatch[1], 10);
  }

  if (size <= 0) {
    try {
      const response = await debugSession.customRequest("evaluate", {
        expression: `(int)${baseExpr}.size()`,
        frameId,
        context,
      });
      const parsed = parseInt(response.result, 10);
      if (!isNaN(parsed) && parsed > 0) {
        size = parsed;
      }
    } catch (error) {
      console.warn("Failed to read PCL point count:", error);
    }
  }

  if (size <= 0) {
    return undefined;
  }

  progress.report({ message: `Reading ${size} points...` });

  const dataPtr = await resolvePclDataPointer(
    debugSession,
    variableInfo,
    baseExpr,
    frameId,
    context
  );
  if (!dataPtr) {
    return undefined;
  }

  const type = variableInfo.type ?? "";
  const pointType = type.match(/(?:pcl::)?PointCloud<\s*(?:struct\s+|class\s+)?(?:pcl::)?(PointXYZ(?:RGB|RGBA|I)?)\s*>/)?.[1];
  if (!pointType) {
    throw new Error("Unsupported PCL point layout. Supported types: PointXYZ, PointXYZI, PointXYZRGB, PointXYZRGBA.");
  }
  const colored = hasRGB || pointType === "PointXYZRGB" || pointType === "PointXYZRGBA";
  const pointBytes = pointType === "PointXYZ" ? 16 : 32;
  // Some adapters cannot evaluate sizeof on a debugger expression.
  const measured = await debugSession.customRequest("evaluate", {
    expression: `sizeof((${baseExpr})[0])`, frameId, context,
  }).then((response) => Number(response.result), () => NaN);
  if (Number.isFinite(measured) && measured !== pointBytes) {
    throw new Error(`Unexpected PCL point size for ${pointType}: ${measured} bytes.`);
  }
  return readCloudSnapshot(debugSession, normalizePointer(dataPtr), size, pointBytes, false, colored, progress);
}

async function readCloudSnapshot(
  session: vscode.DebugSession, reference: string, count: number, pointBytes: number,
  doublePrecision: boolean, colored: boolean,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<CloudSnapshot> {
  if (!Number.isSafeInteger(count * pointBytes)) {
    throw new Error("Invalid point cloud size.");
  }
  const pointsPerChunk = Math.floor(MEMORY_CHUNK_SIZE / pointBytes);
  const chunks: Buffer[] = [];
  for (let start = 0; start < count; start += pointsPerChunk) {
    const batch = Math.min(count - start, pointsPerChunk);
    const chunk = await readMemoryChunked(session, reference, batch * pointBytes, start * pointBytes);
    if (!chunk) {
      throw new Error("Could not read the complete point cloud.");
    }
    chunks.push(chunk);
    progress.report({ increment: batch / count * 100 });
  }
  return {
    count, colored,
    pointAt(index): Point3D {
      const chunk = chunks[Math.floor(index / pointsPerChunk)];
      const offset = (index % pointsPerChunk) * pointBytes;
      if (doublePrecision) {
        return { x: chunk.readDoubleLE(offset), y: chunk.readDoubleLE(offset + 8), z: chunk.readDoubleLE(offset + 16) };
      }
      const point: Point3D = {
        x: chunk.readFloatLE(offset), y: chunk.readFloatLE(offset + 4), z: chunk.readFloatLE(offset + 8),
      };
      if (colored) {
        point.r = chunk[offset + 18];
        point.g = chunk[offset + 17];
        point.b = chunk[offset + 16];
        point.a = chunk[offset + 19];
      }
      return point;
    },
  };
}

async function resolveVectorSize(
  debugSession: vscode.DebugSession,
  evaluateName: string,
  variableInfo: DebugVariableInfo,
  frameId: number,
  context: string
): Promise<number> {
  const resultMatch = variableInfo.result?.match(/size\s*=\s*(\d+)/);
  if (resultMatch) {
    return parseInt(resultMatch[1], 10);
  }

  try {
    const response = await debugSession.customRequest("evaluate", {
      expression: `(int)${evaluateName}.size()`,
      frameId,
      context,
    });
    const size = parseInt(response.result, 10);
    return !isNaN(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

async function resolveVectorDataPointer(
  debugSession: vscode.DebugSession,
  evaluateName: string,
  variableInfo: DebugVariableInfo,
  frameId: number,
  context: string
): Promise<string | null> {
  if (isUsingMSVC(debugSession)) {
    return tryGetDataPointer(
      debugSession,
      [
        `(long long)&${evaluateName}[0]`,
        `(long long)${evaluateName}.data()`,
        `reinterpret_cast<long long>(${evaluateName}.data())`,
      ],
      frameId,
      context
    );
  }

  if (isUsingLLDB(debugSession)) {
    const fromVariables = await readLldbVectorPointer(
      debugSession,
      variableInfo.variablesReference
    );
    if (fromVariables) {
      return fromVariables;
    }

    return tryGetDataPointer(
      debugSession,
      [
        `${evaluateName}.__begin_`,
        `${evaluateName}.data()`,
        `&${evaluateName}[0]`,
      ],
      frameId,
      context
    );
  }

  if (isUsingCppdbg(debugSession)) {
    return tryGetDataPointer(
      debugSession,
      [
        `(long long)${evaluateName}._M_impl._M_start`,
        `(long long)${evaluateName}.data()`,
        `(long long)&${evaluateName}[0]`,
      ],
      frameId,
      context
    );
  }

  return tryGetDataPointer(
    debugSession,
    [
      `(long long)&${evaluateName}[0]`,
      `(long long)${evaluateName}._M_impl._M_start`,
      `(long long)${evaluateName}.__begin_`,
      `(long long)${evaluateName}.data()`,
    ],
    frameId,
    context
  );
}

async function readLldbVectorPointer(
  debugSession: vscode.DebugSession,
  variablesReference?: number
): Promise<string | null> {
  if (!variablesReference || variablesReference <= 0) {
    return null;
  }

  try {
    const varsResponse = await debugSession.customRequest("variables", {
      variablesReference,
    });

    for (const variable of varsResponse.variables ?? []) {
      if (variable.name === "__begin_" || variable.name.includes("__begin")) {
        const ptrMatch = variable.value?.match(/0x[0-9a-fA-F]+/);
        if (ptrMatch) {
          return ptrMatch[0];
        }
        if (variable.memoryReference) {
          return variable.memoryReference;
        }
      }
    }

    const firstElement = varsResponse.variables?.find(
      (variable: { name: string }) => variable.name === "[0]"
    );
    if (firstElement?.memoryReference) {
      return firstElement.memoryReference;
    }
    const ptrMatch = firstElement?.value?.match(/0x[0-9a-fA-F]+/);
    return ptrMatch?.[0] ?? null;
  } catch {
    return null;
  }
}

function resolvePclPointsExpression(evaluateName: string, typeStr: string): string {
  if (typeStr.includes("boost::shared_ptr<")) {
    return `${evaluateName}.px->points`;
  }
  if (typeStr.includes("::Ptr") || typeStr.includes("shared_ptr<")) {
    return `(*${evaluateName}).points`;
  }
  return `${evaluateName}.points`;
}

async function resolvePclDataPointer(
  debugSession: vscode.DebugSession,
  variableInfo: DebugVariableInfo,
  baseExpr: string,
  frameId: number,
  context: string
): Promise<string | null> {
  if (isUsingMSVC(debugSession)) {
    return tryGetDataPointer(
      debugSession,
      [`(long long)&${baseExpr}[0]`, `(long long)${baseExpr}.data()`],
      frameId,
      context
    );
  }

  if (isUsingLLDB(debugSession) && variableInfo.variablesReference) {
    try {
      const vars = await debugSession.customRequest("variables", {
        variablesReference: variableInfo.variablesReference,
      });
      const pointsVar = vars.variables?.find(
        (variable: { name: string }) => variable.name === "points"
      );
      if (pointsVar?.variablesReference) {
        const vecVars = await debugSession.customRequest("variables", {
          variablesReference: pointsVar.variablesReference,
        });
        for (const variable of vecVars.variables ?? []) {
          if (variable.name === "__begin_") {
            const ptrMatch = variable.value?.match(/0x[0-9a-fA-F]+/);
            if (ptrMatch) {
              return ptrMatch[0];
            }
          }
          if (variable.name === "[0]" && variable.memoryReference) {
            return variable.memoryReference;
          }
        }
      }
    } catch {
      // Fall through to expression-based lookup.
    }

    return tryGetDataPointer(
      debugSession,
      [`${baseExpr}.__begin_`, `&${baseExpr}[0]`],
      frameId,
      context
    );
  }

  if (isUsingCppdbg(debugSession)) {
    return tryGetDataPointer(
      debugSession,
      [
        `(long long)${baseExpr}._M_impl._M_start`,
        `(long long)&${baseExpr}[0]`,
        `(long long)${baseExpr}.data()`,
      ],
      frameId,
      context
    );
  }

  return tryGetDataPointer(
    debugSession,
    [`&${baseExpr}[0]`, `${baseExpr}.data()`],
    frameId,
    context
  );
}

function normalizePointer(dataPtr: string): string {
  if (dataPtr.startsWith("0x") || dataPtr.startsWith("0X")) {
    return "0x" + dataPtr.substring(2).toLowerCase();
  }
  if (/^[0-9a-fA-F]+$/.test(dataPtr)) {
    return "0x" + dataPtr.toLowerCase();
  }
  return dataPtr;
}
