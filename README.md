# 2D/3D Debug Visualizer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Visualize 2D images and 3D point clouds from C++ and Python variables while debugging in VS Code.

## Features

### 2D visualization

- **C++**: `cv::Mat`
- **Python**: `numpy.ndarray`, `PIL.Image`, `torch.Tensor`
- Pan, zoom, pixel inspection, RGB/BGR toggle, PNG export
- Open local image files from the Explorer context menu

### 3D visualization

- **C++**: `std::vector<cv::Point3f/d>`, `pcl::PointCloud<T>`
- **Python**: Open3D `PointCloud`, NumPy `(N, 3)` arrays
- Interactive orbit controls, axis widget, PCD export

### Supported debug adapters

- C++: `cppvsdbg`, `cppdbg`, `lldb`
- Python: `debugpy`, `python`

## Usage

1. Start a C++ or Python debug session in VS Code.
2. Break at a point where the variable is in scope.
3. In **Variables** or **Watch**, right-click the variable.
4. Choose **View 2D/3D Data**.

For local image files, right-click a `.jpg`/`.png`/… file in the Explorer and use the same command.

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
git clone https://github.com/cong/2d3d-debug.git
cd 2d3d-debug
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host.

### Scripts

| Script | Description |
|--------|-------------|
| `npm run compile` | Type-check and build `dist/extension.js` |
| `npm run watch` | Watch mode for development |
| `npm run lint` | Run ESLint on `src/` |
| `npm run package` | Production build (used before publishing) |
| `npm test` | Lint + type-check |

### Project layout

```
src/
├── extension.ts       # Entry point & command registration
├── types.ts           # Shared TypeScript types
├── constants.ts       # Shared constants
├── 2d/                # 2D image viewers (C++ / Python)
├── 3d/                # 3D point cloud viewers (C++ / Python)
└── utils/             # Debugger helpers, type detection, panels
```

## Publishing

Build a `.vsix` locally (not committed to git):

```bash
npm install -g @vscode/vsce
npm run package
vsce package
```

## License

MIT — see [LICENSE](LICENSE).
