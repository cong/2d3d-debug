// Coalesce requests and let OrbitControls schedule the next frame while damping moves.
const renderScheduler = `
function createRenderScheduler(render) {
    let frame = 0;
    return function scheduleRender() {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            render();
        });
    };
}
`;

// Function to generate the webview content for the point cloud

export function getLoadingHtml(): string {
    return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>3D Point Viewer</title>
      <style>
          body { margin: 0; overflow: hidden; font-family: Arial, sans-serif; background: #1a1a2e; color: white; }
          #loadingInfo {
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              text-align: center;
              background: rgba(0, 0, 0, 0.7);
              padding: 20px;
              border-radius: 8px;
              z-index: 1000;
          }
          #loadingInfo h3 { margin: 0 0 10px; font-size: 18px; }
          #loadingInfo p { margin: 5px 0; opacity: 0.8; }
  
          /* 复用你原有的 UI 元素样式（隐藏直到数据加载） */
          #info, #controls, #axisView, #colorbar {
              display: none;
          }
          #info {
              position: absolute;
              top: 10px;
              left: 10px;
              background: rgba(0, 0, 0, 0.7);
              color: white;
              padding: 10px 15px;
              border-radius: 5px;
              font-size: 14px;
              z-index: 100;
          }
          #info h3 { margin: 0 0 8px 0; font-size: 16px; }
          #info p { margin: 4px 0; }
          #controls {
              position: absolute;
              top: 10px;
              right: 10px;
              background: rgba(0, 0, 0, 0.7);
              color: white;
              padding: 10px 15px;
              border-radius: 5px;
              z-index: 100;
          }
          #controls button {
              background: #4a9eff;
              color: white;
              border: none;
              padding: 8px 12px;
              margin: 3px;
              border-radius: 4px;
              cursor: pointer;
              font-size: 12px;
          }
          #controls button:hover { background: #3a8eef; }
          #controls button.active { background: #2a7edf; }
          #controls label { font-size: 12px; margin-right: 5px; }
          #controls input[type="number"] {
              width: 60px;
              padding: 4px;
              border: 1px solid #555;
              border-radius: 3px;
              background: #333;
              color: white;
              font-size: 12px;
          }
          #axisView {
              position: absolute;
              bottom: 10px;
              right: 10px;
              width: 120px;
              height: 120px;
              background: rgba(20, 20, 30, 0.9);
              border-radius: 5px;
              border: 1px solid rgba(255, 255, 255, 0.3);
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
          }
          #axisView svg {
              width: 100%;
              height: 100%;
              display: block;
          }
          #colorbar {
              position: absolute;
              bottom: 140px;
              right: 10px;
              background: rgba(0, 0, 0, 0.7);
              color: white;
              padding: 10px;
              border-radius: 5px;
              display: none;
          }
          #colorbar-gradient {
              width: 20px;
              height: 120px;
              background: linear-gradient(to top, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000);
              margin-right: 10px;
          }
          #colorbar-labels {
              display: flex;
              flex-direction: column;
              justify-content: space-between;
              height: 120px;
              font-size: 11px;
          }
          #colorbar-container { display: flex; }
      </style>
      <script type="importmap">
      {
          "imports": {
              "three": "https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.module.js",
              "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.149.0/examples/jsm/"
          }
      }
      </script>
  </head>
  <body>
      <div id="loadingInfo">
          <h3>Loading Point Cloud</h3>
          <p>Please wait while data is being prepared...</p>
      </div>
  
      <!-- 预留 UI 容器（初始隐藏） -->
      <div id="info">
          <h3>Point Cloud Viewer</h3>
          <p>Points: <span id="pointCount">0</span></p>
          <p>X Range: <span id="boundsX">-</span></p>
          <p>Y Range: <span id="boundsY">-</span></p>
          <p>Z Range: <span id="boundsZ">-</span></p>
      </div>
      <div id="controls">
          <div style="margin-bottom: 8px;">
              <label>Point Size:</label>
              <input type="number" id="pointSizeInput" value="0.1" step="0.05" min="0.01" max="20">
          </div>
          <button id="btnResetView">Reset View</button>
          <button id="btnSavePointCloud" style="margin-top: 8px; background: #28a745;">Save PCD</button>
      </div>
      <div id="axisView"></div>
      <div id="colorbar">
          <div id="colorbar-container">
              <div id="colorbar-gradient"></div>
              <div id="colorbar-labels">
                  <span id="colorbar-max">1.0</span>
                  <span id="colorbar-mid">0.5</span>
                  <span id="colorbar-min">0.0</span>
              </div>
          </div>
      </div>
  
      <script type="module">
          import * as THREE from 'three';
          import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  
          let points, sourceColors, totalCount;
          let scene, camera, renderer, controls, pointsObj;
  
          const vscode = acquireVsCodeApi();
  
          // ======================
          // 核心：监听主进程消息
          // ======================
          window.addEventListener('message', event => {
              const message = event.data;
              if (message.type === 'initCloud' && !points) {
                  points = new Float32Array(message.points);
                  sourceColors = message.colors ? new Uint8Array(message.colors) : null;
                  totalCount = message.totalCount;
                  initializeViewer();
              } else if (message.type === 'error') {
                  document.getElementById('loadingInfo').innerHTML = 
                      '<h3>Error</h3><p>' + message.message + '</p>';
              }
          });
  
          ${renderScheduler}

          function initializeViewer() {
              const pointCount = points.length / 3;
              // 隐藏 loading
              document.getElementById('loadingInfo').style.display = 'none';
              // 显示 UI
              document.getElementById('info').style.display = 'block';
              document.getElementById('controls').style.display = 'block';
              document.getElementById('axisView').style.display = 'block';
  
              // Calculate bounds
                let minX = Infinity, maxX = -Infinity;
                let minY = Infinity, maxY = -Infinity;
                let minZ = Infinity, maxZ = -Infinity;

              const positions = new Float32Array(points.length);
              for (let i = 0; i < points.length; i += 3) {
                  const x = points[i], y = points[i + 1], z = points[i + 2];
                  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                  minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                  minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                  minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
              }
              if (!Number.isFinite(minX)) minX = maxX = minY = maxY = minZ = maxZ = 0;
              for (let i = 0; i < points.length; i += 3) {
                  positions[i] = Number.isFinite(points[i]) ? points[i] : minX;
                  positions[i + 1] = Number.isFinite(points[i + 2]) ? points[i + 2] : minZ;
                  positions[i + 2] = Number.isFinite(points[i + 1]) ? -points[i + 1] : -minY;
              }

              document.getElementById('pointCount').textContent =
                  totalCount > pointCount ? pointCount + ' / ' + totalCount : pointCount;
              document.getElementById('boundsX').textContent = \`[\${minX.toFixed(2)}, \${maxX.toFixed(2)}]\`;
              document.getElementById('boundsY').textContent = \`[\${minY.toFixed(2)}, \${maxY.toFixed(2)}]\`;
              document.getElementById('boundsZ').textContent = \`[\${minZ.toFixed(2)}, \${maxZ.toFixed(2)}]\`;
  
              scene = new THREE.Scene();
              scene.background = new THREE.Color(0x1a1a2e);
  
              camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100000);
              renderer = new THREE.WebGLRenderer({ antialias: true });
              renderer.setSize(window.innerWidth, window.innerHeight);
              document.body.appendChild(renderer.domElement);
  
              const geometry = new THREE.BufferGeometry();
              const colors = new Float32Array(points.length);

              geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
              geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  
              const size_range = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
              let currentPointSize = Math.min(0.1, size_range / 1000);
              currentPointSize = Math.max(0.001, currentPointSize);
              document.getElementById('pointSizeInput').value = currentPointSize;
  
              const material = new THREE.PointsMaterial({
                  size: currentPointSize,
                  vertexColors: true,
                  sizeAttenuation: true
              });
  
              pointsObj = new THREE.Points(geometry, material);
              scene.add(pointsObj);
  
              controls = new OrbitControls(camera, renderer.domElement);
  
              function resetView() {
                  const centerX = (minX + maxX) / 2;
                  const centerY = (minZ + maxZ) / 2;
                  const centerZ = -(minY + maxY) / 2;
                  const dist = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
                  camera.position.set(centerX + dist, centerY + dist, centerZ + dist);
                  camera.lookAt(centerX, centerY, centerZ);
                  controls.target.set(centerX, centerY, centerZ);
                  controls.update();
              }
  
              resetView();
  
              function updateColors(mode) {
                  const colorAttr = geometry.attributes.color;
                  const colorbar = document.getElementById('colorbar');
                  const colorbarMax = document.getElementById('colorbar-max');
                  const colorbarMid = document.getElementById('colorbar-mid');
                  const colorbarMin = document.getElementById('colorbar-min');
  
                  if (mode === 'color') {
                      colorbar.style.display = 'none';
                      for (let i = 0; i < pointCount; i++) {
                          const offset = i * 3;
                          colorAttr.setXYZ(i, sourceColors[offset] / 255,
                              sourceColors[offset + 1] / 255, sourceColors[offset + 2] / 255);
                      }
                  } else if (mode === 'solid') {
                      colorbar.style.display = 'none';
                      for (let i = 0; i < pointCount; i++) {
                          colorAttr.setXYZ(i, 0.5, 0.7, 1.0);
                      }
                  } else {
                      colorbar.style.display = 'block';
                      let min, max;
                      if (mode === 'x') { min = minX; max = maxX; }
                      else if (mode === 'y') { min = minY; max = maxY; }
                      else if (mode === 'z') { min = minZ; max = maxZ; }
  
                      colorbarMax.textContent = max.toFixed(2);
                      colorbarMid.textContent = ((min + max) / 2).toFixed(2);
                      colorbarMin.textContent = min.toFixed(2);
  
                      const range = max - min || 1;
                      for (let i = 0; i < pointCount; i++) {
                          const offset = i * 3;
                          const val = mode === 'x' ? positions[offset]
                              : mode === 'y' ? -positions[offset + 2] : positions[offset + 1];
                          const t = (val - min) / range;
  
                          let jetR = 0, jetG = 0, jetB = 0;
                          if (t < 0.25) { jetR = 0; jetG = 4 * t; jetB = 1; }
                          else if (t < 0.5) { jetR = 0; jetG = 1; jetB = 1 - 4 * (t - 0.25); }
                          else if (t < 0.75) { jetR = 4 * (t - 0.5); jetG = 1; jetB = 0; }
                          else { jetR = 1; jetG = 1 - 4 * (t - 0.75); jetB = 0; }
  
                          colorAttr.setXYZ(i, jetR, jetG, jetB);
                      }
                  }
                  colorAttr.needsUpdate = true;
              }
  
              if (sourceColors) updateColors('color');
              else updateColors('z');
  
              document.getElementById('btnResetView').onclick = () => {
                  resetView();
                  scheduleRender();
              };
              document.getElementById('pointSizeInput').oninput = (e) => {
                  material.size = parseFloat(e.target.value) || currentPointSize;
                  scheduleRender();
              };
              document.getElementById('btnSavePointCloud').onclick = () => {
                  vscode.postMessage({ command: 'savePcd' });
              };
  
              // Axis view SVG (简化版，可按需增强)
              const axisContainer = document.getElementById('axisView');
              const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
              svg.setAttribute('viewBox', '0 0 120 120');
              axisContainer.appendChild(svg);
  
            //   function updateAxisView() {
            //       svg.innerHTML = '';
            //       // 简化：固定 XYZ 轴（实际可按相机方向更新）
            //       drawArrow(svg, 60, 60, 90, 60, '#ff3333', 'X');
            //       drawArrow(svg, 60, 60, 60, 30, '#33ff33', 'Y');
            //       drawArrow(svg, 60, 60, 60, 90, '#3333ff', 'Z');
            //   }
                // Function to update axis arrows based on camera direction
                function updateAxisView() {
                    // Clear previous content
                    svg.innerHTML = '';
                    
                    // Get camera basis vectors
                    const cameraDir = new THREE.Vector3();
                    camera.getWorldDirection(cameraDir);
                    const cameraUp = camera.up.clone();
                    const cameraRight = new THREE.Vector3();
                    cameraRight.crossVectors(cameraDir, cameraUp).normalize();
                    const cameraUpCorrected = new THREE.Vector3();
                    cameraUpCorrected.crossVectors(cameraRight, cameraDir).normalize();
                    
                    // Define axis directions in world space
                    const worldX = new THREE.Vector3(1, 0, 0);
                    const worldY = new THREE.Vector3(0, 0, -1); // Y is forward (negative Z in Three.js)
                    const worldZ = new THREE.Vector3(0, 1, 0);
                    
                    // Project to 2D using camera basis
                    // Project onto the plane perpendicular to camera direction
                    function project3DTo2D(worldVec) {
                        // Project onto camera right and up vectors
                        const projRight = worldVec.dot(cameraRight);
                        const projUp = worldVec.dot(cameraUpCorrected);
                        return { x: projRight, y: projUp };
                    }
                    
                    const centerX = 60, centerY = 60;
                    const axisLength = 30;
                    
                    // Project axes
                    const xProj = project3DTo2D(worldX);
                    const yProj = project3DTo2D(worldY);
                    const zProj = project3DTo2D(worldZ);
                    
                    // Normalize and scale
                    const scale = axisLength;
                    const xEnd = {
                        x: centerX + xProj.x * scale,
                        y: centerY - xProj.y * scale // Flip Y for SVG
                    };
                    const yEnd = {
                        x: centerX + yProj.x * scale,
                        y: centerY - yProj.y * scale
                    };
                    const zEnd = {
                        x: centerX + zProj.x * scale,
                        y: centerY - zProj.y * scale
                    };
                    
                    // Draw arrows
                    drawArrow(svg, centerX, centerY, xEnd.x, xEnd.y, '#ff3333', 'X');
                    drawArrow(svg, centerX, centerY, yEnd.x, yEnd.y, '#33ff33', 'Y');
                    drawArrow(svg, centerX, centerY, zEnd.x, zEnd.y, '#3333ff', 'Z');
                }
  
              function drawArrow(svg, x1, y1, x2, y2, color, label) {
                  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
                  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
                  line.setAttribute('stroke', color); line.setAttribute('stroke-width', '2');
                  svg.appendChild(line);
                  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                  text.setAttribute('x', x2 + 5); text.setAttribute('y', y2 - 5);
                  text.setAttribute('fill', color); text.setAttribute('font-size', '12');
                  text.textContent = label;
                  svg.appendChild(text);
              }
  
              const scheduleRender = createRenderScheduler(() => {
                  updateAxisView();
                  renderer.render(scene, camera);
              });
              controls.addEventListener('change', scheduleRender);
              scheduleRender();

              window.addEventListener('resize', () => {
                  camera.aspect = window.innerWidth / window.innerHeight;
                  camera.updateProjectionMatrix();
                  renderer.setSize(window.innerWidth, window.innerHeight);
                  scheduleRender();
              });
          }
          vscode.postMessage({ command: '__VIEWER_READY__' });
      </script>
  </body>
  </html>
  `;
}

export function getLoadingHtmlO3D(): string {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>Open3D Viewer Ultimate</title>
    
    <style>
    html,body{
        margin:0;
        padding:0;
        overflow:hidden;
        width:100%;
        height:100%;
        background:#1a1a2e;
        color:#fff;
        font-family:Arial,Helvetica,sans-serif;
    }
    
    #loadingInfo{
        position:absolute;
        left:50%;
        top:50%;
        transform:translate(-50%,-50%);
        background:rgba(0,0,0,.75);
        padding:20px 28px;
        border-radius:8px;
        z-index:1000;
        text-align:center;
    }
    
    #info,#controls,#axisView,#colorbar{
        display:none;
    }
    
    #info{
        position:absolute;
        top:10px;
        left:10px;
        background:rgba(0,0,0,.72);
        padding:10px 14px;
        border-radius:6px;
        font-size:13px;
        z-index:100;
    }
    
    #info h3{
        margin:0 0 8px 0;
        font-size:15px;
    }
    
    #info p{
        margin:3px 0;
    }
    
    #controls{
        position:absolute;
        top:10px;
        right:10px;
        background:rgba(0,0,0,.72);
        padding:10px 14px;
        border-radius:6px;
        z-index:100;
        min-width:170px;
    }
    
    #controls button{
        width:100%;
        margin-top:6px;
        padding:8px;
        border:none;
        border-radius:4px;
        cursor:pointer;
        color:#fff;
        background:#4a9eff;
    }
    
    #controls button:hover{
        background:#318cff;
    }
    
    #controls input{
        width:70px;
        margin-left:8px;
        background:#222;
        color:#fff;
        border:1px solid #555;
        border-radius:4px;
        padding:4px;
    }
    
    #axisView{
        position:absolute;
        right:10px;
        bottom:10px;
        width:120px;
        height:120px;
        background:rgba(0,0,0,.45);
        border:1px solid rgba(255,255,255,.2);
        border-radius:6px;
        z-index:100;
    }
    
    #axisView svg{
        width:100%;
        height:100%;
    }
    
    #colorbar{
        position:absolute;
        right:10px;
        bottom:140px;
        background:rgba(0,0,0,.72);
        padding:10px;
        border-radius:6px;
        z-index:100;
    }
    
    #cbWrap{
        display:flex;
    }
    
    #cbGrad{
        width:20px;
        height:120px;
        background:linear-gradient(to top,#0000ff,#00ffff,#00ff00,#ffff00,#ff0000);
    }
    
    #cbText{
        margin-left:8px;
        height:120px;
        display:flex;
        flex-direction:column;
        justify-content:space-between;
        font-size:11px;
    }
    </style>
    
    <script type="importmap">
    {
     "imports":{
       "three":"https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.module.js",
       "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.149.0/examples/jsm/"
     }
    }
    </script>
    </head>
    
    <body>
    
    <div id="loadingInfo">
        <h3>Loading Point Cloud</h3>
        <p>Please wait...</p>
    </div>
    
    <div id="info">
        <h3>Point Cloud Viewer</h3>
        <p>Points: <span id="pointCount">0</span></p>
        <p>X: <span id="boundsX">-</span></p>
        <p>Y: <span id="boundsY">-</span></p>
        <p>Z: <span id="boundsZ">-</span></p>
    </div>
    
    <div id="controls">
        <div>
            Size:
            <input id="pointSizeInput" type="number" step="0.01" min="0.001" value="0.05">
        </div>
        <button id="btnResetView">Reset View</button>
        <button id="btnSavePointCloud">Save PCD</button>
    </div>
    
    <div id="axisView"></div>
    
    <div id="colorbar">
        <div id="cbWrap">
            <div id="cbGrad"></div>
            <div id="cbText">
                <span id="cbMax">1</span>
                <span id="cbMid">0.5</span>
                <span id="cbMin">0</span>
            </div>
        </div>
    </div>
    
    <script type="module">
    
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    
    const vscode = acquireVsCodeApi();
    
    let scene=null;
    let camera=null;
    let renderer=null;
    let controls=null;
    let pointsObj=null;
    
    ${renderScheduler}

    const scheduleRender = createRenderScheduler(() => {
        controls.update();
        updateAxis();
        renderer.render(scene, camera);
    });
    
    window.addEventListener('message',(event)=>{
    
        const msg = event.data;
    
        if (msg.type === 'initCloud' && !renderer) {
            initializeViewer(new Float32Array(msg.points),
                msg.colors ? new Uint8Array(msg.colors) : null, msg.totalCount);
        }
    
        if(msg.type === 'error'){
            document.getElementById('loadingInfo').innerHTML =
                '<h3>Error</h3><p>'+msg.message+'</p>';
        }
    });
    
    function initializeViewer(rawPoints, rawColors, totalCount){
    
        document.getElementById('loadingInfo').style.display='none';
        document.getElementById('info').style.display='block';
        document.getElementById('controls').style.display='block';
        document.getElementById('axisView').style.display='block';
    
        const pointCount = Math.floor(rawPoints.length / 3);
    
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e);
    
        camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth/window.innerHeight,
            0.1,
            100000
        );
    
        renderer = new THREE.WebGLRenderer({
            antialias:true
        });
    
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setSize(window.innerWidth,window.innerHeight);
    
        document.body.appendChild(renderer.domElement);
    
        controls = new OrbitControls(camera,renderer.domElement);
        controls.enableDamping = true;
    
        const positions = new Float32Array(pointCount * 3);
    
        let minX=Infinity,maxX=-Infinity;
        let minY=Infinity,maxY=-Infinity;
        let minZ=Infinity,maxZ=-Infinity;
    
        for(let i=0;i<pointCount;i++){
    
            const x = rawPoints[i*3];
            const y = rawPoints[i*3+1];
            const z = rawPoints[i*3+2];
    
            // Open3D -> Three.js
            positions[i*3]   = x;
            positions[i*3+1] = z;
            positions[i*3+2] = -y;
    
            if(x<minX) minX=x;
            if(x>maxX) maxX=x;
    
            if(y<minY) minY=y;
            if(y>maxY) maxY=y;
    
            if(z<minZ) minZ=z;
            if(z>maxZ) maxZ=z;
        }
    
        let colorArr = new Float32Array(pointCount * 3);
    
        if(rawColors){
    
            for(let i=0;i<rawColors.length;i++){
                colorArr[i] = rawColors[i] / 255.0;
            }
    
            document.getElementById('colorbar').style.display='none';
    
        }else{
    
            document.getElementById('colorbar').style.display='block';
    
            document.getElementById('cbMax').textContent = maxZ.toFixed(2);
            document.getElementById('cbMid').textContent = ((minZ+maxZ)/2).toFixed(2);
            document.getElementById('cbMin').textContent = minZ.toFixed(2);
    
            const range = (maxZ-minZ) || 1;
    
            for(let i=0;i<pointCount;i++){
    
                const z = rawPoints[i*3+2];
                const t = (z-minZ)/range;
    
                let r=0,g=0,b=0;
    
                if(t<0.25){
                    r=0; g=4*t; b=1;
                }else if(t<0.5){
                    r=0; g=1; b=1-4*(t-0.25);
                }else if(t<0.75){
                    r=4*(t-0.5); g=1; b=0;
                }else{
                    r=1; g=1-4*(t-0.75); b=0;
                }
    
                colorArr[i*3]   = r;
                colorArr[i*3+1] = g;
                colorArr[i*3+2] = b;
            }
        }
    
        const geometry = new THREE.BufferGeometry();
    
        geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(positions,3)
        );
    
        geometry.setAttribute(
            'color',
            new THREE.BufferAttribute(colorArr,3)
        );
    
        const sizeRange = Math.max(
            maxX-minX,
            maxY-minY,
            maxZ-minZ
        ) || 1;
    
        const defaultSize = Math.max(0.01,sizeRange/500);
    
        document.getElementById('pointSizeInput').value =
            defaultSize.toFixed(3);
    
        const material = new THREE.PointsMaterial({
            size:defaultSize,
            vertexColors:true,
            sizeAttenuation:true
        });
    
        pointsObj = new THREE.Points(geometry,material);
        scene.add(pointsObj);
    
        updateInfo(pointCount,minX,maxX,minY,maxY,minZ,maxZ);
        if (totalCount > pointCount) {
            document.getElementById("pointCount").textContent = pointCount + " / " + totalCount;
        }
    
        function resetView(){
    
            const cx = (minX+maxX)/2;
            const cy = (minZ+maxZ)/2;
            const cz = -(minY+maxY)/2;
    
            const dist = Math.max(
                maxX-minX,
                maxY-minY,
                maxZ-minZ
            ) || 1;
    
            camera.position.set(
                cx+dist,
                cy+dist,
                cz+dist
            );
    
            controls.target.set(cx,cy,cz);
            controls.update();
        }
    
        resetView();
    
        document.getElementById('btnResetView').onclick = () => {
            resetView();
            scheduleRender();
        };
    
        document.getElementById('pointSizeInput').oninput = (e)=>{
            material.size = parseFloat(e.target.value) || defaultSize;
            scheduleRender();
        };
    
        document.getElementById('btnSavePointCloud').onclick = ()=>{
            vscode.postMessage({command:'savePcd'});
        };
    
        setupAxisWidget();
    
        controls.addEventListener("change", scheduleRender);
        scheduleRender();
    }
    
    function updateInfo(count,minX,maxX,minY,maxY,minZ,maxZ){
    
        document.getElementById('pointCount').textContent = String(count);
        document.getElementById('boundsX').textContent =
            '['+minX.toFixed(2)+', '+maxX.toFixed(2)+']';
    
        document.getElementById('boundsY').textContent =
            '['+minY.toFixed(2)+', '+maxY.toFixed(2)+']';
    
        document.getElementById('boundsZ').textContent =
            '['+minZ.toFixed(2)+', '+maxZ.toFixed(2)+']';
    }
    
    let axisSvg=null;
    let axisLines=[];
    let axisTexts=[];
    
    function setupAxisWidget(){
    
        const box = document.getElementById('axisView');
        box.innerHTML='';
    
        axisSvg = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg'
        );
    
        axisSvg.setAttribute('viewBox','0 0 120 120');
        box.appendChild(axisSvg);
    
        const names=['X','Y','Z'];
        const colors=['#ff3333','#33ff33','#3399ff'];
    
        for(let i=0;i<3;i++){
    
            const line=document.createElementNS(
                'http://www.w3.org/2000/svg','line');
    
            line.setAttribute('stroke',colors[i]);
            line.setAttribute('stroke-width','2');
    
            axisSvg.appendChild(line);
            axisLines.push(line);
    
            const text=document.createElementNS(
                'http://www.w3.org/2000/svg','text');
    
            text.setAttribute('fill',colors[i]);
            text.setAttribute('font-size','12');
            text.textContent=names[i];
    
            axisSvg.appendChild(text);
            axisTexts.push(text);
        }
    }
    
    function updateAxis(){
    
        if(!camera || !axisSvg) return;
    
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
    
        const up = camera.up.clone();
    
        const right = new THREE.Vector3();
        right.crossVectors(dir,up).normalize();
    
        const up2 = new THREE.Vector3();
        up2.crossVectors(right,dir).normalize();
    
        const basis = [
            new THREE.Vector3(1,0,0),
            new THREE.Vector3(0,1,0),
            new THREE.Vector3(0,0,1)
        ];
    
        const cx=60, cy=60, len=30;
    
        for(let i=0;i<3;i++){
    
            const p = basis[i];
    
            const px = p.dot(right);
            const py = p.dot(up2);
    
            const x2 = cx + px*len;
            const y2 = cy - py*len;
    
            axisLines[i].setAttribute('x1',cx);
            axisLines[i].setAttribute('y1',cy);
            axisLines[i].setAttribute('x2',x2);
            axisLines[i].setAttribute('y2',y2);
    
            axisTexts[i].setAttribute('x',x2+4);
            axisTexts[i].setAttribute('y',y2-4);
        }
    }
    
    window.addEventListener('resize',()=>{
    
        if(!camera || !renderer) return;
    
        camera.aspect =
            window.innerWidth/window.innerHeight;
    
        camera.updateProjectionMatrix();
    
        renderer.setSize(
            window.innerWidth,
            window.innerHeight
        );
        scheduleRender();
    });
    
    vscode.postMessage({ command: '__VIEWER_READY__' });
    </script>
    </body>
    </html>
    `;
}
