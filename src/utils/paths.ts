import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { VIEWER_TMP_DIR } from "../constants";

/** Ensure the shared viewer temp directory exists and return its path. */
export function ensureViewerTempDir(): string {
  const dir = path.join(os.tmpdir(), VIEWER_TMP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Normalize a filesystem path for embedding in Python raw strings. */
export function toPythonRawPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
