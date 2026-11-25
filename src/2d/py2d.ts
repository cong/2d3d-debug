import { access, unlink } from "fs/promises";
import { EVALUATE_TIMEOUT_MS } from "../constants";
import { evaluateWithTimeout, isolatedPythonScript } from "../utils/debugger";
import * as path from "path";
import * as vscode from "vscode";
import { loadWebview } from "../utils/panel";
import { ensureViewerTempDir, toPythonRawPath } from "../utils/paths";
import { getHtml } from "./pyWebview";

export async function showPythonImageViewer(
  debugSession: vscode.DebugSession,
  variableName: string,
  frameId: number
): Promise<void> {
  const tmpDir = ensureViewerTempDir();
  const filePath = path.join(
    tmpDir,
    `${Date.now()}_${Math.random().toString(36).slice(2)}.png`
  );

  try {
    await exportImage(debugSession, frameId, variableName, filePath);
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }

  const panel = vscode.window.createWebviewPanel(
    "pythonImage",
    `Image: ${variableName}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(tmpDir)],
    }
  );

  const imgUri = panel.webview.asWebviewUri(vscode.Uri.file(filePath));
  loadWebview(panel, getHtml(), { command: "show", uri: imgUri.toString() });
  panel.onDidDispose(() => { void unlink(filePath).catch(() => undefined); });
}

async function exportImage(
  debugSession: vscode.DebugSession,
  frameId: number,
  variableName: string,
  output: string
): Promise<void> {
  const outputPath = toPythonRawPath(output);
  const code = `
import numpy as np

obj = __viewer_value

try:
    if hasattr(obj, "detach"):
        obj = obj.detach().cpu().numpy()
except Exception:
    pass

try:
    if "PIL." in str(type(obj)):
        obj = np.array(obj)
except Exception:
    pass

arr = np.array(obj)

if arr.ndim == 2:
    arr = np.stack([arr] * 3, axis=-1)
elif arr.ndim == 3:
    if arr.shape[0] in (1, 3, 4) and arr.shape[-1] not in (1, 3, 4):
        arr = np.transpose(arr, (1, 2, 0))
elif arr.ndim == 4:
    if arr.shape[1] in (1, 3, 4):
        arr = np.transpose(arr[0], (1, 2, 0))
    elif arr.shape[-1] in (1, 3, 4):
        arr = arr[0]
    else:
        arr = arr[0]

if arr.ndim == 3:
    if arr.shape[2] == 1:
        arr = np.repeat(arr, 3, axis=2)
    if arr.shape[2] > 4:
        arr = arr[:, :, :3]

if arr.dtype != np.uint8:
    arr = arr.astype(np.float32)
    mn = float(arr.min())
    mx = float(arr.max())
    if abs(mx - mn) < 1e-12:
        arr[:] = 0
    else:
        arr = (arr - mn) / (mx - mn) * 255
    arr = np.clip(arr, 0, 255).astype(np.uint8)

from PIL import Image
Image.fromarray(arr).save(r'''${outputPath}''')
print("ok")
`;

  const response = await evaluateWithTimeout(
    debugSession, isolatedPythonScript(variableName, code), frameId, EVALUATE_TIMEOUT_MS
  );
  if (response.result) {
    // debugpy can report an execution error in a successful evaluate response.
    await access(output).catch(() => { throw new Error(response.result || "Image export failed."); });
  } else {
    await access(output);
  }
}
