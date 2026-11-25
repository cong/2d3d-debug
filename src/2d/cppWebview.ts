import * as vscode from "vscode";

export function getWebviewContentForMat(
    webview: vscode.Webview,
    rows: number,
    cols: number,
    channels: number,
    depth: number
): string {
    const nonce = getNonce();
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
          <title>Matrix Image Viewer</title>
          <style nonce="${nonce}">
              body { margin: 0; overflow: hidden; font-family: Arial, sans-serif; background-color: #333; }
              #controls { 
                  position: absolute; 
                  top: 10px; 
                  left: 10px; 
                  background: rgba(255,255,255,0.9); 
                  padding: 10px; 
                  border-radius: 5px;
                  box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                  cursor: move;
                  user-select: none;
                  z-index: 1000;
              }
              #controls:hover { background: rgba(255,255,255,1); }
              #pixelInfo { 
                  position: absolute; 
                  bottom: 10px; 
                  left: 10px; 
                  background: rgba(255,255,255,0.9); 
                  color: black; 
                  padding: 10px; 
                  border-radius: 5px;
                  box-shadow: 0 2px 5px rgba(0,0,0,0.2);
              }
              button { 
                  margin-right: 5px; 
                  padding: 5px 10px; 
                  cursor: pointer;
                  border: 1px solid #ccc;
                  border-radius: 3px;
                  background: white;
              }
              button:hover { background: #f0f0f0; }
              #container { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
              canvas { position: absolute; top: 0; left: 0; }
              #grid-canvas { 
                  position: absolute; 
                  top: 0; 
                  left: 0; 
                  pointer-events: none;
                  z-index: 1;
              }
          </style>
      </head>
      <body>
        <div id="loading">
            <div class="spinner"></div>
        </div>
          <div id="container">
              <canvas id="canvas"></canvas>
              <canvas id="grid-canvas"></canvas>
          </div>
          <div id="controls">
              <button id="reset">Reset</button>
              <button id="downloadPng">Save PNG</button>
              <span id="zoomLevel">Zoom: 100%</span>
              <span id="Resolution">Size: 0x0</span>
          </div>
          <div id="pixelInfo"></div>
          <script nonce="${nonce}">
              (function() {
                  const canvas = document.getElementById('canvas');
                  const gridCanvas = document.getElementById('grid-canvas');
                  const ctx = canvas.getContext('2d');
                  const gridCtx = gridCanvas.getContext('2d');
                  const pixelInfo = document.getElementById('pixelInfo');
                  const zoomLevelDisplay = document.getElementById('zoomLevel');
                  const ResolutionDisplay = document.getElementById('Resolution');
                  const controls = document.getElementById('controls');
                  
                  const rows = ${rows};
                  const cols = ${cols};
                  const channels = ${channels};
                  const depth = ${depth};

                // Listen for complete data from extension
                const vscode = acquireVsCodeApi();
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'completeData') {
                        const rawBytes = new Uint8Array(message.data);
                        
                        // Use setTimeout to allow UI to update
                        setTimeout(() => {
                            try {
                                initializeImageViewer(rawBytes);
                            } catch (e) {
                                console.error('Initialization failed:', e);
                            }
                        }, 10);
                    }
                });
                vscode.postMessage({ command: '__VIEWER_READY__' });
                function bytesToTypedArray(bytes, depth) {
                    const buf = bytes.buffer;
                    const offset = bytes.byteOffset;
                    const length = bytes.byteLength;
                    switch (depth) {
                        case 0: return new Uint8Array(buf, offset, length);    // CV_8U
                        case 1: return new Int8Array(buf, offset, length);     // CV_8S
                        case 2: return new Uint16Array(buf, offset, length / 2);   // CV_16U
                        case 3: return new Int16Array(buf, offset, length / 2);    // CV_16S
                        case 4: return new Int32Array(buf, offset, length / 4);    // CV_32S
                        case 5: return new Float32Array(buf, offset, length / 4);  // CV_32F
                        case 6: return new Float64Array(buf, offset, length / 8);  // CV_64F
                        default: return new Uint8Array(buf, offset, length);
                    }
                }
                let rawData = null;
                let renderMode = 'byte';
                let cachedMinMax = null;
                let scale = 1;
                let isDragging = false;
                let startX = 0;
                let startY = 0;
                let offsetX = 0;
                let offsetY = 0;

                // Make controls draggable
                let controlsDragging = false;
                let controlsStartX = 0;
                let controlsStartY = 0;

                controls.addEventListener('mousedown', (e) => {
                    if (e.target === controls) {
                        controlsDragging = true;
                        controlsStartX = e.clientX - controls.offsetLeft;
                        controlsStartY = e.clientY - controls.offsetTop;
                        e.preventDefault();
                    }
                });

                document.addEventListener('mousemove', (e) => {
                    if (controlsDragging) {
                        controls.style.left = (e.clientX - controlsStartX) + 'px';
                        controls.style.top = (e.clientY - controlsStartY) + 'px';
                    }
                });

                document.addEventListener('mouseup', () => {
                    controlsDragging = false;
                });

                // Create off-screen canvas for the original image
                const offscreenCanvas = document.createElement('canvas');
                offscreenCanvas.width = cols;
                offscreenCanvas.height = rows;
                const offscreenCtx = offscreenCanvas.getContext('2d');
                const imgData = offscreenCtx.createImageData(cols, rows);

                function initializeImageViewer(rawBytes) {
                    rawData = bytesToTypedArray(rawBytes, depth);
                    updateOffscreenFromRaw();
                    resetView();
                }

                function clampByte(v) {
                    if (v < 0) return 0;
                    if (v > 255) return 255;
                    return v | 0;
                }

                function getMinMax() {
                    if (cachedMinMax) return cachedMinMax;
                    let min = Infinity;
                    let max = -Infinity;
                    const len = rawData.length;
                    for (let i = 0; i < len; i++) {
                        const v = rawData[i];
                        if (v < min) min = v;
                        if (v > max) max = v;
                    }
                    if (min === Infinity || max === -Infinity) {
                        min = 0; max = 1;
                    }
                    cachedMinMax = { min, max };
                    return cachedMinMax;
                }

                function mapToByte(v) {
                    if (renderMode === 'norm01') {
                        return clampByte(v * 255);
                    }
                    if (renderMode === 'minmax') {
                        const mm = getMinMax();
                        const denom = (mm.max - mm.min) || 1;
                        return clampByte(((v - mm.min) / denom) * 255);
                    }
                    if (renderMode === 'clamp255') {
                        return clampByte(v);
                    }
                    // 'byte' default
                    return clampByte(v);
                }

                function updateOffscreenFromRaw() {
                    if (!rawData) return;
                    // Fill image data based on selected render mode
                    cachedMinMax = null;
                    if (renderMode === 'minmax') getMinMax();

                    const data = imgData.data;
                    const len = rows * cols;
                    
                    if (depth === 0 && renderMode === 'byte') {
                        // Fast path for CV_8U + byte mode
                        if (channels === 1) {
                            for (let i = 0; i < len; i++) {
                                const val = rawData[i];
                                const outIdx = i << 2;
                                data[outIdx] = data[outIdx + 1] = data[outIdx + 2] = val;
                                data[outIdx + 3] = 255;
                            }
                        } else if (channels === 3) {
                            for (let i = 0; i < len; i++) {
                                const inIdx = i * 3;
                                const outIdx = i << 2;
                                data[outIdx] = rawData[inIdx + 2];
                                data[outIdx + 1] = rawData[inIdx + 1];
                                data[outIdx + 2] = rawData[inIdx];
                                data[outIdx + 3] = 255;
                            }
                        }
                    } else {
                        // General path
                        for (let i = 0; i < len; i++) {
                            const outIdx = i << 2;
                            if (channels === 1) {
                                const value = mapToByte(rawData[i]);
                                data[outIdx] = data[outIdx + 1] = data[outIdx + 2] = value;
                            } else {
                                const inIdx = i * channels;
                                data[outIdx] = mapToByte(rawData[inIdx + 2]);
                                data[outIdx + 1] = mapToByte(rawData[inIdx + 1]);
                                data[outIdx + 2] = mapToByte(rawData[inIdx]);
                            }
                            data[outIdx + 3] = 255;
                        }
                    }
                    offscreenCtx.putImageData(imgData, 0, 0);
                }

                let hasAutoFit = false;
                function updateCanvasSize() {
                    const container = canvas.parentElement;
                    if (!container) return;
                    canvas.width = container.clientWidth;
                    canvas.height = container.clientHeight;
                    if (!hasAutoFit && rows > 0 && cols > 0) {
                        // 计算缩放比例：保持宽高比，使图像完整显示并尽可能填满容器
                        const scaleX = canvas.width / cols;
                        const scaleY = canvas.height / rows;
                        const fitScale = Math.min(scaleX, scaleY); // 'contain' 模式；若想 'cover' 则用 Math.max
                        scale = Math.max(0.1, Math.min(80, fitScale)); // 限制在合理范围内
                        // 居中偏移
                        const imageDisplayWidth = cols * scale;
                        const imageDisplayHeight = rows * scale;
                        offsetX = (canvas.width - imageDisplayWidth) / 2;
                        offsetY = (canvas.height - imageDisplayHeight) / 2;
                        hasAutoFit = true; // 只自动适配一次
                    }
                    gridCanvas.width = canvas.width;
                    gridCanvas.height = canvas.height;
                    draw();
                    drawGrid();
                }

                // 先实现缺失的对比度计算函数
                function getContrastYIQ(r, g, b) {
                // 标准YIQ公式计算亮度，判断是否为浅色背景（返回true则用黑色文本，否则白色）
                const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
                return yiq >= 128; // 亮度≥128为浅色，用黑色文本
                }
                function drawGrid() {
                    if (scale < 10) {
                    gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
                    return;
                    }
                    gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
                    gridCtx.strokeStyle = 'rgba(128,128,128,0.5)';
                    gridCtx.lineWidth = 0.5;
                    // ===== 计算可见网格范围 =====
                    const startCol = Math.max(0, Math.floor((-offsetX) / scale));
                    const endCol   = Math.min(cols, Math.ceil((gridCanvas.width - offsetX) / scale));
                    const startRow = Math.max(0, Math.floor((-offsetY) / scale));
                    const endRow   = Math.min(rows, Math.ceil((gridCanvas.height - offsetY) / scale));
                    // ===== 绘制网格线（只画可见）=====
                    gridCtx.beginPath();
                    for (let x = startCol; x <= endCol; x++) {
                    const px = x * scale + offsetX;
                    gridCtx.moveTo(px, startRow * scale + offsetY);
                    gridCtx.lineTo(px, endRow * scale + offsetY);
                    }
                    for (let y = startRow; y <= endRow; y++) {
                    const py = y * scale + offsetY;
                    gridCtx.moveTo(startCol * scale + offsetX, py);
                    gridCtx.lineTo(endCol * scale + offsetX, py);
                    }
                    gridCtx.stroke();
                    // ===== scale < 60 不画 RGB =====
                    if (scale < 60) return;
                    // ===== 文本样式 =====
                    const fontSize = Math.floor(scale / 5);
                    gridCtx.font = \`\${fontSize}px Arial\`;
                    gridCtx.textAlign = 'center';
                    gridCtx.textBaseline = 'middle';
                    // =====只绘制可见像素值 =====
                    for (let y = startRow; y < endRow; y++) {
                    for (let x = startCol; x < endCol; x++) {
                        const cellX = x * scale + offsetX;
                        const cellY = y * scale + offsetY;
                        const cx = cellX + scale / 2;
                        const idx = (y * cols + x) * channels;
                        if (channels === 3) {
                        const r = rawData[idx + 2];
                        const g = rawData[idx + 1];
                        const b = rawData[idx];
                        gridCtx.fillStyle =
                            getContrastYIQ(r, g, b) ? 'black' : 'white';
                        gridCtx.fillText(r, cx, cellY + scale * 0.30);
                        gridCtx.fillText(g, cx, cellY + scale * 0.50);
                        gridCtx.fillText(b, cx, cellY + scale * 0.70);

                        } else if (channels === 1) {
                        const v = rawData[idx];
                        gridCtx.fillStyle =
                            getContrastYIQ(v, v, v) ? 'black' : 'white';
                        gridCtx.fillText(v, cx, cellY + scale / 2);
                        }
                    }
                    }
                }


                function draw() {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    // Calculate scaled dimensions
                    const scaledWidth = cols * scale;
                    const scaledHeight = rows * scale;
                    // Draw from top-left corner with offset
                    const x = offsetX;
                    const y = offsetY;
                    ctx.imageSmoothingEnabled = scale < 4; // Disable smoothing when zoomed in
                    ctx.drawImage(offscreenCanvas, x, y, scaledWidth, scaledHeight);
                    // Draw grid when zoomed in
                    drawGrid();
                    // Update zoom level display
                    zoomLevelDisplay.textContent = \`Scale: \${Math.round(scale * 100)}% | \`;
                    ResolutionDisplay.textContent = \`Size: \${cols}x${rows}\`;
                }

                function resetView() {
                    hasAutoFit = false;
                    updateCanvasSize();
                    draw();
                }
                document.getElementById('reset').addEventListener('click', () => {
                    resetView();
                });

                // Download PNG
                document.getElementById('downloadPng').addEventListener('click', () => {
                    const link = document.createElement('a');
                    link.download = 'image.png';
                    link.href = offscreenCanvas.toDataURL('image/png');
                    link.click();
                });

                canvas.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    const rect = canvas.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;
                    // 当前鼠标在图像坐标系中的位置（未缩放前的坐标）
                    const imageXBefore = (mouseX - offsetX) / scale;
                    const imageYBefore = (mouseY - offsetY) / scale;
                    const zoomFactor = e.deltaY > 0 ? 0.8 : 1.25;
                    const newScale = Math.max(0.1, Math.min(80, scale * zoomFactor));// Increased max zoom to 80x
                    // 缩放后，让图像坐标 (imageXBefore, imageYBefore) 仍然对齐到鼠标位置
                    const newOffsetX = mouseX - imageXBefore * newScale;
                    const newOffsetY = mouseY - imageYBefore * newScale;
                    scale = newScale;
                    offsetX = newOffsetX;
                    offsetY = newOffsetY;

                    draw();
                });

                canvas.addEventListener('mousedown', (e) => {
                    if (e.target === canvas) {
                        isDragging = true;
                        startX = e.clientX - offsetX;
                        startY = e.clientY - offsetY;
                    }
                });

                canvas.addEventListener('mousemove', (e) => {
                    if (isDragging) {
                        offsetX = e.clientX - startX;
                        offsetY = e.clientY - startY;
                        draw();
                    }

                    // Update pixel info
                    const rect = canvas.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;
                    
                    // Convert mouse coordinates to image coordinates
                    const imageX = Math.floor((mouseX - offsetX) / scale);
                    const imageY = Math.floor((mouseY - offsetY) / scale);

                    if (imageX >= 0 && imageX < cols && imageY >= 0 && imageY < rows) {
                        const idx = (imageY * cols + imageX) * channels;
                        let pixelInfoText = \`Position: (\${imageX}, \${imageY}) | \`;

                        if (channels === 1) {
                            const value = rawData[idx];
                            pixelInfoText += \`Grayscale: \${value}\`;
                        } else if (channels === 3) {
                            const r = rawData[idx + 2];
                            const g = rawData[idx + 1];
                            const b = rawData[idx];
                            pixelInfoText += \`RGB: (\${r}, \${g}, \${b})\`;
                        }
                        pixelInfo.textContent = pixelInfoText;
                    } else {
                        pixelInfo.textContent = '';
                    }
                });

                canvas.addEventListener('mouseup', () => {
                    isDragging = false;
                });

                canvas.addEventListener('mouseleave', () => {
                    isDragging = false;
                });

                window.addEventListener('resize', () => {
                    // hasAutoFit = false;
                    updateCanvasSize();
                    draw();
                });

                // Initialize
                hasAutoFit = false;
                updateCanvasSize();
                draw();
            })();
            </script>
        </body>
        </html>
    `;
}

function getNonce() {
    let text = "";
    const possible =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
