/** Temporary directory for exported Python debug artifacts. */
export const VIEWER_TMP_DIR = "vscode-2d3d-viewer";

/** Maximum points sent to the 3D webview (downsampled when exceeded). */
export const MAX_POINT_CLOUD_POINTS = 1_200_000;

/** Bytes read per `readMemory` chunk. */
export const MEMORY_CHUNK_SIZE = 8 * 1024 * 1024;

/** Default timeout (ms) for debugger expression evaluation. */
export const EVALUATE_TIMEOUT_MS = 10_000;

/** Extended timeout (ms) for Python export scripts. */
export const PYTHON_EXPORT_TIMEOUT_MS = 60_000;
