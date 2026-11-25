import * as vscode from "vscode";
import { EVALUATE_TIMEOUT_MS, MEMORY_CHUNK_SIZE } from "../constants";
import type { DebugVariableInfo } from "../types";
import {
  evaluateWithTimeout,
  isUsingLLDB,
  readMemoryChunked,
} from "../utils/debugger";
import { getWebviewContentForMat } from "./cppWebview";
import { loadWebview, PanelManager } from "../utils/panel";
import { getBytesPerElement } from "../utils/judge";

// Function to draw the cv::Mat image
export async function drawMatImage(
  debugSession: vscode.DebugSession,
  variableInfo: DebugVariableInfo,
  frameId: number,
  variableName: string
): Promise<void> {
  try {
    const usingLLDB = isUsingLLDB(debugSession);

    let rows: number, cols: number, channels: number, depth: number, dataPtr = "";
    let continuous: boolean | undefined;

    if (usingLLDB) {
      // For LLDB, we must use variables request - evaluate won't work
      if (variableInfo.variablesReference && variableInfo.variablesReference > 0) {
        const matInfo = await getMatInfoFromVariables(debugSession, variableInfo.variablesReference);
        rows = matInfo.rows;
        cols = matInfo.cols;
        channels = matInfo.channels;
        depth = matInfo.depth;
        dataPtr = matInfo.dataPtr;        continuous = matInfo.continuous;
      } else {
        // Try to get variablesReference from scopes
        const scopesResponse = await debugSession.customRequest("scopes", { frameId: frameId });
        let foundVariable = null;

        for (const scope of scopesResponse.scopes) {
          const varsResponse = await debugSession.customRequest("variables", {
            variablesReference: scope.variablesReference
          });

          for (const v of varsResponse.variables) {
            if (v.name === variableName || v.evaluateName === variableName) {
              foundVariable = v;
              break;
            }
          }
          if (foundVariable) {
            break;
          }
        }

        if (foundVariable && foundVariable.variablesReference > 0) {
          const matInfo = await getMatInfoFromVariables(debugSession, foundVariable.variablesReference);
          rows = matInfo.rows;
          cols = matInfo.cols;
          channels = matInfo.channels;
          depth = matInfo.depth;
          dataPtr = matInfo.dataPtr;          continuous = matInfo.continuous;
        } else {
          throw new Error("Cannot access Mat variable in LLDB. Make sure it's a valid cv::Mat.");
        }
      }

    } else {
      // For other debuggers (cppdbg, cppvsdbg), prefer variablesReference to get Mat info
      // because .depth() and .channels() method calls may not work via evaluate
      if (variableInfo.variablesReference && variableInfo.variablesReference > 0) {
        const matInfo = await getMatInfoFromVariables(debugSession, variableInfo.variablesReference);
        rows = matInfo.rows;
        cols = matInfo.cols;
        channels = matInfo.channels;
        depth = matInfo.depth;
        dataPtr = matInfo.dataPtr;        continuous = matInfo.continuous;
      } else {
        // Fallback: use evaluate expressions
        const rowsExp = `${variableName}.rows`;
        const colsExp = `${variableName}.cols`;
        const flagsExp = `${variableName}.flags`;
        const dataExp = `${variableName}.data`;

        // Get matrix dimensions in parallel
        const [rowsResponse, colsResponse, flagsResponse, dataResponse] = await Promise.all([
          evaluateWithTimeout(debugSession, rowsExp, frameId, EVALUATE_TIMEOUT_MS),
          evaluateWithTimeout(debugSession, colsExp, frameId, EVALUATE_TIMEOUT_MS),
          evaluateWithTimeout(debugSession, flagsExp, frameId, EVALUATE_TIMEOUT_MS),
          evaluateWithTimeout(debugSession, dataExp, frameId, EVALUATE_TIMEOUT_MS),
        ]);

        rows = parseInt(rowsResponse.result ?? "", 10);
        cols = parseInt(colsResponse.result ?? "", 10);
        dataPtr = dataResponse.memoryReference ?? dataResponse.result?.match(/0x[\da-f]+/i)?.[0] ?? "";

        // Parse depth and channels from flags (same logic as LLDB)
        const flags = parseInt(flagsResponse.result ?? "", 10);
        if (!isNaN(flags)) {
          continuous = (flags & 0x4000) !== 0;
          const type = flags & 0xFFF;
          depth = type & 7;  // CV_MAT_DEPTH_MASK = 7
          channels = ((type >> 3) & 63) + 1;  // ((type >> 3) & 63) gives (channels - 1)
        } else {
          // Last resort: try .depth() and .channels()
          const channelsExp = `${variableName}.channels()`;
          const depthExp = `${variableName}.depth()`;
          const [channelsResponse, depthResponse] = await Promise.all([
            evaluateWithTimeout(debugSession, channelsExp, frameId, EVALUATE_TIMEOUT_MS),
            evaluateWithTimeout(debugSession, depthExp, frameId, EVALUATE_TIMEOUT_MS),
          ]);
          channels = parseInt(channelsResponse.result ?? "", 10);
          depth = parseInt(depthResponse.result ?? "", 10);
        }
      }
    }


    if (isNaN(rows) || isNaN(cols) || isNaN(channels) || isNaN(depth)) {
      throw new Error("Invalid matrix dimensions or type");
    }

    if (rows <= 0 || cols <= 0) {
      throw new Error("Matrix is empty");
    }

    const rowBytes = cols * channels * getBytesPerElement(depth);
    const stride = continuous ? rowBytes : await resolveRowStride(debugSession, variableName, frameId);
    if (!Number.isSafeInteger(stride) || stride < rowBytes) {
      throw new Error("Cannot determine the OpenCV Mat row stride.");
    }

    if (!dataPtr) {
      const response = await evaluateWithTimeout(
        debugSession, `(${variableName}).data`, frameId, EVALUATE_TIMEOUT_MS
      );
      dataPtr = response.memoryReference ?? response.result?.match(/0x[\da-f]+/i)?.[0] ?? "";
    }
    if (!dataPtr) {
      throw new Error("Cannot resolve the OpenCV Mat data pointer.");
    }

    const buffer = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Loading OpenCV Mat" },
      async (progress) => {
        const packed = Buffer.allocUnsafeSlow(rows * rowBytes);
        const rowsPerRead = Math.max(1, Math.floor(MEMORY_CHUNK_SIZE / stride));
        for (let row = 0; row < rows; row += rowsPerRead) {
          const batch = Math.min(rows - row, rowsPerRead);
          const length = (batch - 1) * stride + rowBytes;
          const data = await readMemoryChunked(debugSession, dataPtr, length, row * stride);
          if (!data) {
            throw new Error("Could not read the complete OpenCV Mat.");
          }
          if (stride === rowBytes) {
            data.copy(packed, row * rowBytes);
          } else {
            for (let i = 0; i < batch; i++) {
              data.copy(packed, (row + i) * rowBytes, i * stride, i * stride + rowBytes);
            }
          }
          progress.report({ increment: batch / rows * 100 });
        }
        return packed;
      }
    );

    // Show the webview to visualize the matrix as an image
    const panelTitle = `View: Image ${variableName}`;
    const panel = PanelManager.getOrCreatePanel(
      "MatImageViewer",
      panelTitle,
      debugSession.id,
      variableName
    );

    loadWebview(
      panel,
      getWebviewContentForMat(panel.webview, rows, cols, channels, depth),
      { command: "completeData", data: buffer.buffer }
    );
  } catch (error) {
    console.error("Error drawing Mat image:", error);
    throw error;
  }
}

// Get Mat info from LLDB variables request
export async function getMatInfoFromVariables(
  debugSession: vscode.DebugSession,
  variablesReference: number
): Promise<{ rows: number; cols: number; channels: number; depth: number; dataPtr: string; continuous?: boolean }> {
  // Get the children of the Mat variable
  const varsResponse = await debugSession.customRequest("variables", {
    variablesReference: variablesReference
  });

  let rows = 0, cols = 0, channels = 1, depth = 0, dataPtr = "";
  let flags = 0;

  // Check if this is a cv::Mat_<T> with an internal cv::Mat member
  // For cv::Mat_<T>, the actual Mat data is stored in an internal cv::Mat member
  for (const v of varsResponse.variables) {
    const name = v.name;
    const value = v.value;

    // If we find a cv::Mat member (for cv::Mat_<T>), recursively get its info
    if (name === "cv::Mat" || name.includes("cv::Mat") || (name === "Mat" && value.includes("rows"))) {
      if (v.variablesReference > 0) {
        const innerMatInfo = await getMatInfoFromVariables(debugSession, v.variablesReference);
        rows = innerMatInfo.rows;
        cols = innerMatInfo.cols;
        channels = innerMatInfo.channels;
        depth = innerMatInfo.depth;
        dataPtr = innerMatInfo.dataPtr;
        // Return immediately if we got info from internal Mat
        if (rows > 0 && cols > 0 && dataPtr) {
          return innerMatInfo;
        }
      }
    }
  }

  // If not a cv::Mat_<T> or recursive lookup failed, try direct members
  for (const v of varsResponse.variables) {
    const name = v.name;
    const value = v.value;

    if (name === "rows") {
      rows = parseInt(value);
    } else if (name === "cols") {
      cols = parseInt(value);
    } else if (name === "data") {
      // Try multiple ways to get the data pointer
      // 1. First check if memoryReference is available (most reliable)
      if (v.memoryReference) {
        dataPtr = v.memoryReference;
      }
      // 2. Try to extract from value string
      else {
        const ptrMatch = value.match(/0x[0-9a-fA-F]+/);
        if (ptrMatch) {
          dataPtr = ptrMatch[0];
        }
      }
      // 3. If still no pointer and has variablesReference, try to expand
      if (!dataPtr && v.variablesReference > 0) {
        try {
          const dataVars = await debugSession.customRequest("variables", {
            variablesReference: v.variablesReference
          });
          // Look for __ptr or raw pointer value
          for (const dv of dataVars.variables) {
            if (dv.memoryReference) {
              dataPtr = dv.memoryReference;
              break;
            }
            const ptrMatch2 = dv.value?.match(/0x[0-9a-fA-F]+/);
            if (ptrMatch2) {
              dataPtr = ptrMatch2[0];
              break;
            }
          }
        } catch (e) {
          console.log("Failed to expand data variable:", e);
        }
      }
    } else if (name === "flags") {
      flags = parseInt(value);
      // Extract depth and channels from flags
      // OpenCV flags format: lower 12 bits contain the type
      // type = depth | ((channels - 1) << 3)
      // CV_MAT_TYPE_MASK = 0xFFF
      const type = flags & 0xFFF;
      depth = type & 7;  // CV_MAT_DEPTH_MASK = 7
      channels = ((type >> 3) & 63) + 1;  // ((type >> 3) & 63) gives (channels - 1)
    }
  }

  return { rows, cols, channels, depth, dataPtr, continuous: Number.isFinite(flags) && flags !== 0 ? (flags & 0x4000) !== 0 : undefined };
}

async function resolveRowStride(session: vscode.DebugSession, name: string, frameId: number): Promise<number> {
  for (const member of ["step.p[0]", "step.buf[0]", "step[0]"]) {
    try {
      const result = await evaluateWithTimeout(session, `(${name}).${member}`, frameId, EVALUATE_TIMEOUT_MS);
      const match = result.result?.trim().match(/^(0x[\da-f]+|[0-9]+)/i);
      const stride = Number(match?.[1]);
      if (Number.isSafeInteger(stride) && stride > 0) {
        return stride;
      }
    } catch {
      // Try the next representation exposed by the debug adapter.
    }
  }
  return NaN;
}
