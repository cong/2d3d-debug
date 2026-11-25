import { createWriteStream } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import * as path from "path";
import { pipeline } from "stream/promises";
import * as vscode from "vscode";
import { ensureViewerTempDir } from "./paths";

export function binaryPcdHeader(count: number, colored: boolean): Buffer {
  return Buffer.from([
    "VERSION 0.7", colored ? "FIELDS x y z rgb" : "FIELDS x y z",
    colored ? "SIZE 4 4 4 4" : "SIZE 4 4 4", colored ? "TYPE F F F U" : "TYPE F F F",
    colored ? "COUNT 1 1 1 1" : "COUNT 1 1 1",
    `WIDTH ${count}`, "HEIGHT 1", "VIEWPOINT 0 0 0 1 0 0 0", `POINTS ${count}`, "DATA binary", "",
  ].join("\n"));
}

export async function writeCloudFile(uri: vscode.Uri, contents: AsyncIterable<Buffer>): Promise<void> {
  const dir = await mkdtemp(path.join(ensureViewerTempDir(), "export-"));
  const output = path.join(dir, "cloud");
  try {
    await pipeline(contents, createWriteStream(output));
    if (uri.scheme === "file") {
      await vscode.workspace.fs.copy(vscode.Uri.file(output), uri, { overwrite: true });
    } else {
      await vscode.workspace.fs.writeFile(uri, await readFile(output));
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(console.error);
  }
}
