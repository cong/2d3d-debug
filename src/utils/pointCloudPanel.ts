import * as vscode from "vscode";
import { MAX_POINT_CLOUD_POINTS } from "../constants";
import { getLoadingHtml } from "../3d/3dWebview";
import type { Point3D } from "../types";
import { binaryPcdHeader, writeCloudFile } from "./cloudExport";
import { loadWebview, PanelManager } from "./panel";

export interface CloudSnapshot {
  count: number;
  colored: boolean;
  pointAt(index: number): Point3D;
}

export async function openCppPointCloudPanel(
  session: vscode.DebugSession, name: string, cloud?: CloudSnapshot
): Promise<void> {
  if (!cloud?.count) {
    vscode.window.showWarningMessage("No points found. Make sure the container is not empty.");
    return;
  }
  const previewCount = Math.min(cloud.count, MAX_POINT_CLOUD_POINTS);
  const positions = new Float32Array(previewCount * 3);
  const colors = cloud.colored ? new Uint8Array(previewCount * 3) : null;
  for (let i = 0; i < previewCount; i++) {
    const point = cloud.pointAt(Math.floor(i * cloud.count / previewCount));
    const offset = i * 3;
    positions[offset] = point.x;
    positions[offset + 1] = point.y;
    positions[offset + 2] = point.z;
    if (colors) {
      colors[offset] = point.r ?? 0;
      colors[offset + 1] = point.g ?? 0;
      colors[offset + 2] = point.b ?? 0;
    }
  }

  const panel = PanelManager.getOrCreatePanel("3DPointViewer", `View: PointCloud ${name}`, session.id, name);
  loadWebview(panel, getLoadingHtml(), {
    type: "initCloud", points: positions.buffer, colors: colors?.buffer, totalCount: cloud.count,
  }, async (message) => {
    if (message.command !== "savePcd" && message.command !== "savePLY") {
      return;
    }
    const format = message.command === "savePcd" ? "pcd" : "ply";
    try {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${name}.${format}`),
        filters: { [format.toUpperCase()]: [format] },
      });
      if (uri) {
        await writeCloudFile(uri, encodeCloud(cloud, format, format === "ply" && message.format === "ascii"));
        vscode.window.showInformationMessage(`Point cloud saved to ${uri.fsPath}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to save point cloud: ${error}`);
    }
  });
}

async function* encodeCloud(cloud: CloudSnapshot, format: "pcd" | "ply", ascii: boolean) {
  const colored = format === "pcd" && cloud.colored;
  if (format === "pcd") {
    yield binaryPcdHeader(cloud.count, colored);
  } else {
    yield Buffer.from([
      "ply", ascii ? "format ascii 1.0" : "format binary_little_endian 1.0",
      `element vertex ${cloud.count}`, "property float x", "property float y", "property float z", "end_header", "",
    ].join("\n"));
  }
  const pointBytes = colored ? 16 : 12;
  const batchSize = 8192;
  for (let start = 0; start < cloud.count; start += batchSize) {
    const count = Math.min(batchSize, cloud.count - start);
    if (ascii) {
      const lines = Array.from({ length: count }, (_, i) => {
        const { x, y, z } = cloud.pointAt(start + i);
        return `${x} ${y} ${z}\n`;
      });
      yield Buffer.from(lines.join(""));
    } else {
      const bytes = Buffer.allocUnsafe(count * pointBytes);
      for (let i = 0; i < count; i++) {
        const point = cloud.pointAt(start + i);
        const offset = i * pointBytes;
        bytes.writeFloatLE(point.x, offset);
        bytes.writeFloatLE(point.y, offset + 4);
        bytes.writeFloatLE(point.z, offset + 8);
        if (colored) {
          bytes[offset + 12] = point.b ?? 0;
          bytes[offset + 13] = point.g ?? 0;
          bytes[offset + 14] = point.r ?? 0;
          bytes[offset + 15] = point.a ?? 255;
        }
      }
      yield bytes;
    }
  }
}
