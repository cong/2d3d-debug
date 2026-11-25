# Change Log

All notable changes to this extension are documented in this file.

## [0.1.4] - 2026-11-25

### Changed

- Cached 2D image rendering and switched 3D point clouds to binary Webview messages and on-demand rendering.
- Capped point cloud previews while preserving full PCD exports and writing exports in chunks.

### Fixed

- Use the selected debug stack frame and isolate Python exports from debuggee variable bindings.
- Respect OpenCV Mat row stride and validate supported PCL point layouts.
- Wait for viewers to be ready and reject incomplete debugger memory reads.

## [0.1.3] - 2025-06-11

### Changed

- Refactored `src/` for clearer module structure and shared types/utilities.
- Removed unused npm dependencies (`open`, `three`, `vite`) and local dev artifacts.

### Fixed

- Mat webview: declare `cachedMinMax` in the embedded viewer script.

### Initial release

- 2D/3D visualization during C++/Python debugging (OpenCV, PCL, NumPy, PIL, PyTorch, Open3D).
