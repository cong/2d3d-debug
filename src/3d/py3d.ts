import { createReadStream } from "fs";
import { mkdtemp, open, readFile, rm, stat } from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { binaryPcdHeader, writeCloudFile } from "../utils/cloudExport";
import { MAX_POINT_CLOUD_POINTS, PYTHON_EXPORT_TIMEOUT_MS } from "../constants";
import { evaluateWithTimeout, isolatedPythonScript } from "../utils/debugger";
import { ensureViewerTempDir } from "../utils/paths";
import { loadWebview, PanelManager } from "../utils/panel";
import { getLoadingHtmlO3D } from "./3dWebview";

export function drawOpen3DPointCloud(session: vscode.DebugSession, frameId: number, name: string) {
  return drawPythonCloud(session, frameId, name, true);
}

export function drawNumpyXYZPointCloud(session: vscode.DebugSession, frameId: number, name: string) {
  return drawPythonCloud(session, frameId, name, false);
}

async function drawPythonCloud(
  session: vscode.DebugSession, frameId: number, name: string, open3d: boolean
): Promise<void> {
  const dir = await mkdtemp(path.join(ensureViewerTempDir(), "cloud-"));
  let retained = false;
  try {
    const file = path.join(dir, "points.bin");
    const meta = path.join(dir, "meta.json");
    const code = `
import json
import numpy as np

cloud = __viewer_value
xyz = np.asarray(cloud.points if ${open3d ? "True" : "False"} else cloud)
if xyz.ndim != 2 or xyz.shape[1] != 3:
    raise ValueError("Expected an N by 3 point array")
rgb = np.asarray(getattr(cloud, "colors", []))
has_color = rgb.shape == xyz.shape and len(xyz) > 0
with open(${JSON.stringify(file)}, "wb") as out:
    for start in range(0, len(xyz), 65536):
        end = min(start + 65536, len(xyz))
        if has_color:
            rows = np.empty((end - start, 4), dtype="<f4")
            rows[:, :3] = xyz[start:end]
            color = np.clip(rgb[start:end] * 255, 0, 255).astype(np.uint32)
            rows.view("<u4")[:, 3] = (color[:, 0] << 16) | (color[:, 1] << 8) | color[:, 2]
        else:
            rows = np.asarray(xyz[start:end], dtype="<f4")
        rows.tofile(out)
with open(${JSON.stringify(meta)}, "w", encoding="utf8") as out:
    json.dump([len(xyz), has_color], out)
`;
    const response = await evaluateWithTimeout(
      session, isolatedPythonScript(name, code), frameId, PYTHON_EXPORT_TIMEOUT_MS
    );
    const [count, colored] = JSON.parse(await readFile(meta, "utf8").catch(() => {
      throw new Error(response.result || "Point cloud snapshot was not created.");
    }));
    const pointBytes = colored ? 16 : 12;
    if (!Number.isSafeInteger(count) || count < 0 || typeof colored !== "boolean" ||
        (await stat(file)).size !== count * pointBytes) {
      throw new Error("Invalid point cloud snapshot.");
    }
    if (!count) {
      vscode.window.showWarningMessage("Point cloud is empty.");
      return;
    }

    const { points, colors } = await readPreview(file, count, pointBytes, colored);
    const panel = PanelManager.getOrCreatePanel("3DPointViewer", `View: PointCloud ${name}`, session.id, name);
    let saves = 0;
    let released = false;
    const release = () => {
      released = true;
      if (!saves) {
        void rm(dir, { recursive: true, force: true }).catch(console.error);
      }
    };
    loadWebview(panel, getLoadingHtmlO3D(), {
      type: "initCloud", points: points.buffer, colors: colors?.buffer, totalCount: count,
    }, async (message) => {
      if (message.command !== "savePcd") {
        return;
      }
      saves++;
      try {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${name}.pcd`), filters: { "PCD Files": ["pcd"] },
        });
        if (uri) {
          await writeCloudFile(uri, snapshotContents(file, count, colored));
          vscode.window.showInformationMessage(`Point cloud saved to ${uri.fsPath}`);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to save PCD file: ${error}`);
      } finally {
        saves--;
        if (released && !saves) {
          release();
        }
      }
    }, release);
    retained = true;
  } finally {
    if (!retained) {
      await rm(dir, { recursive: true, force: true }).catch(console.error);
    }
  }
}

async function readPreview(file: string, count: number, pointBytes: number, colored: boolean) {
  const length = Math.min(count, MAX_POINT_CLOUD_POINTS);
  const points = new Float32Array(length * 3);
  const colors = colored ? new Uint8Array(length * 3) : null;
  const input = await open(file, "r");
  const batch = 65536;
  const buffer = Buffer.allocUnsafe(batch * pointBytes);
  try {
    let sample = 0;
    for (let start = 0; start < count && sample < length; start += batch) {
      const end = Math.min(count, start + batch);
      const lengthBytes = (end - start) * pointBytes;
      let loaded = 0;
      while (loaded < lengthBytes) {
        const { bytesRead } = await input.read(buffer, loaded, lengthBytes - loaded, start * pointBytes + loaded);
        if (!bytesRead) {
          throw new Error("Incomplete point cloud snapshot.");
        }
        loaded += bytesRead;
      }
      while (sample < length) {
        const index = Math.floor(sample * count / length);
        if (index >= end) {
          break;
        }
        const offset = (index - start) * pointBytes;
        const target = sample++ * 3;
        for (let axis = 0; axis < 3; axis++) {
          points[target + axis] = buffer.readFloatLE(offset + axis * 4);
          if (colors) {
            colors[target + axis] = buffer[offset + 14 - axis];
          }
        }
      }
    }
  } finally {
    await input.close();
  }
  return { points, colors };
}

async function* snapshotContents(file: string, count: number, colored: boolean) {
  yield binaryPcdHeader(count, colored);
  yield* createReadStream(file);
}
