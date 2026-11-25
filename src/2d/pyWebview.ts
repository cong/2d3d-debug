export function getHtml(): string {
    return `
    <!DOCTYPE html>
    <html lang="en">
    
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1.0">
        <style>
            html,
            body {
                margin: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
                background: #1e1e1e;
                font-family: Arial, Helvetica, sans-serif;
            }
    
            #container {
                position: relative;
                width: 100vw;
                height: 100vh;
                overflow: hidden;
            }
    
            canvas {
                position: absolute;
                top: 0;
                left: 0;
            }
    
            #grid {
                pointer-events: none;
                z-index: 2;
            }
    
            #controls {
                position: absolute;
                top: 10px;
                left: 10px;
                background: rgba(255, 255, 255, .92);
                padding: 10px;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
                cursor: move;
                user-select: none;
                z-index: 1000;
            }
    
            button {
                margin-right: 5px;
                padding: 6px 10px;
                cursor: pointer;
                border: 1px solid #bbb;
                border-radius: 5px;
                background: #fff;
                transition: .15s;
            }
    
            button:hover {
                background: #f0f0f0;
            }
    
            button.active {
                background: #2563eb;
                color: #fff;
                border-color: #2563eb;
            }
    
            #status {
                margin-left: 6px;
                font-size: 12px;
            }
    
            #pixel {
                position: absolute;
                bottom: 10px;
                left: 10px;
                background: rgba(255, 255, 255, .92);
                color: #000;
                padding: 10px;
                border-radius: 6px;
                box-shadow: 0 2px 5px rgba(0, 0, 0, .2);
                font-size: 12px;
            }
        </style>
    </head>
    
    <body>
        <div id="container"><canvas id="canvas"></canvas><canvas id="grid"></canvas></div>
        <div id="controls"><button id="fit">Reset</button><button id="save">Save PNG</button><button
                id="swap">RGB ⇄ BGR</button><span id="status">Loading...</span></div>
        <div id="pixel"></div>
        <script>
(function () {
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const grid = document.getElementById('grid');
    const ctx = canvas.getContext('2d');
    const gtx = grid.getContext('2d');
    const container = document.getElementById('container');
    const pixel = document.getElementById('pixel');
    const status = document.getElementById('status');
    const controls = document.getElementById('controls');
    const swapBtn = document.getElementById('swap');
    const img = new Image();
    const pixelCanvas = document.createElement('canvas');
    const pixelContext = pixelCanvas.getContext('2d');
    let swappedCanvas = null;
    let drawFrame = 0;
    let rawPixels = null;
    let rgbMode = true;
    let scale = 1,
        offsetX = 0,
        offsetY = 0,
        dragging = false,
        dragX = 0,
        dragY = 0,
        ctrlDragging = false,
        ctrlDX = 0,
        ctrlDY = 0;

    window.addEventListener('message', e => {
        if (e.data.command === 'show') {
            img.src = e.data.uri + '?t=' + Date.now();
        }
    });
    vscode.postMessage({ command: '__VIEWER_READY__' });

    img.onerror = () => { status.textContent = "Could not load image."; };
    img.onload = () => {
        pixelCanvas.width = img.width;
        pixelCanvas.height = img.height;
        pixelContext.drawImage(img, 0, 0);
        rawPixels = pixelContext.getImageData(0, 0, img.width, img.height);
        swappedCanvas = null;
        resizeCanvas();
        fitImage();
        draw();
    };

    function resizeCanvas() {
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
        grid.width = canvas.width;
        grid.height = canvas.height;
    }

    window.addEventListener('resize', () => {
        resizeCanvas();
        draw();
    });

    function fitImage() {
        if (!img.width) return;
        const sx = canvas.width / img.width,
            sy = canvas.height / img.height;
        scale = Math.min(sx, sy);
        offsetX = (canvas.width - img.width * scale) / 2;
        offsetY = (canvas.height - img.height * scale) / 2;
    }

    function getDisplayImage() {
        if (rgbMode) return pixelCanvas;
        if (!swappedCanvas) {
            const data = new Uint8ClampedArray(rawPixels.data);
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                data[i] = data[i + 2];
                data[i + 2] = r;
            }
            swappedCanvas = document.createElement('canvas');
            swappedCanvas.width = rawPixels.width;
            swappedCanvas.height = rawPixels.height;
            swappedCanvas.getContext('2d').putImageData(
                new ImageData(data, rawPixels.width, rawPixels.height), 0, 0
            );
        }
        return swappedCanvas;
    }

    function scheduleDraw() {
        if (drawFrame) return;
        drawFrame = requestAnimationFrame(() => {
            drawFrame = 0;
            draw();
        });
    }

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (rawPixels) {
            ctx.imageSmoothingEnabled = scale < 6;
            ctx.drawImage(getDisplayImage(), offsetX, offsetY, img.width * scale, img.height * scale);
        }
        drawGrid();
        status.textContent = 'Scale:' + Math.round(scale * 100) + '% | Size:' + img.width + 'x' + img.height + ' | ' + (rgbMode ? 'RGB' : 'BGR');
        swapBtn.classList.toggle('active', !rgbMode);
    }

    function drawGrid() {
        gtx.clearRect(0, 0, grid.width, grid.height);
        if (scale < 12 || !rawPixels) return;
        gtx.strokeStyle = 'rgba(255,255,255,0.16)';
        gtx.lineWidth = 1;
        const firstColumn = Math.max(0, Math.ceil(-offsetX / scale));
        const lastColumn = Math.min(rawPixels.width, Math.floor((grid.width - offsetX) / scale));
        const firstRow = Math.max(0, Math.ceil(-offsetY / scale));
        const lastRow = Math.min(rawPixels.height, Math.floor((grid.height - offsetY) / scale));
        gtx.beginPath();
        for (let x = firstColumn; x <= lastColumn; x++) {
            const px = offsetX + x * scale;
            gtx.moveTo(px, offsetY);
            gtx.lineTo(px, offsetY + rawPixels.height * scale);
        }
        for (let y = firstRow; y <= lastRow; y++) {
            const py = offsetY + y * scale;
            gtx.moveTo(offsetX, py);
            gtx.lineTo(offsetX + rawPixels.width * scale, py);
        }
        gtx.stroke();
    }

    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left,
            my = e.clientY - rect.top;
        const ix = (mx - offsetX) / scale,
            iy = (my - offsetY) / scale;
        const ns = Math.max(0.05, Math.min(80, scale * (e.deltaY < 0 ? 1.2 : 0.84)));
        offsetX = mx - ix * ns;
        offsetY = my - iy * ns;
        scale = ns;
        scheduleDraw();
    }, { passive: false });

    canvas.addEventListener('mousedown', e => {
        dragging = true;
        dragX = e.clientX - offsetX;
        dragY = e.clientY - offsetY;
    });

    window.addEventListener('mouseup', () => {
        dragging = false;
        ctrlDragging = false;
    });

    window.addEventListener('mousemove', e => {
        if (dragging) {
            offsetX = e.clientX - dragX;
            offsetY = e.clientY - dragY;
            scheduleDraw();
        }
        if (ctrlDragging) {
            controls.style.left = (e.clientX - ctrlDX) + 'px';
            controls.style.top = (e.clientY - ctrlDY) + 'px';
        }
        updatePixelInfo(e);
    });

    function updatePixelInfo(e) {
        if (!img.width || !rawPixels) return;
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left - offsetX) / scale),
            y = Math.floor((e.clientY - rect.top - offsetY) / scale);
        if (x >= 0 && x < img.width && y >= 0 && y < img.height) {
            const idx = (y * img.width + x) * 4;
            let r = rawPixels.data[idx],
                g = rawPixels.data[idx + 1],
                b = rawPixels.data[idx + 2];
            if (!rgbMode) {
                const t = r;
                r = b;
                b = t;
            }
            pixel.textContent = 'Position:(' + x + ',' + y + ') | ' + (rgbMode ? 'RGB' : 'BGR') + ':(' + r + ',' + g + ',' + b + ')';
        } else {
            pixel.textContent = '';
        }
    }

    controls.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        ctrlDragging = true;
        ctrlDX = e.clientX - controls.offsetLeft;
        ctrlDY = e.clientY - controls.offsetTop;
    });

    document.getElementById('fit').onclick = () => {
        fitImage();
        draw();
    };
    document.getElementById('save').onclick = () => {
        const a = document.createElement('a');
        a.download = 'image.png';
        a.href = canvas.toDataURL('image/png');
        a.click();
    };
    swapBtn.onclick = () => {
        rgbMode = !rgbMode;
        draw();
    };
})();
</script>
    </body>
    
    </html>`;
    }