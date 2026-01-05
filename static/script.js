/* RT-Viewer Mobile & Universal Edition */
const state = {
    caseId: null,
    manifest: null,
    ctVolume: null,
    currentSlice: 0,
    roiVisible: true,
    doseUnit: 'Gy',
    normalizationDose: 60.0,
    viewport: {
        el: document.getElementById('dicomMain'),
        doseCanvas: document.getElementById('doseCanvasMain'),
        structCanvas: document.getElementById('structCanvasMain'),
        doseVolume: null,
        doseMeta: null,
        structData: null
    }
};

const ui = {
    caseSel: document.getElementById('caseSelector'),
    doseSel: document.getElementById('selDoseMain'),
    opacity: document.getElementById('doseOpacity'),
    sliceInfo: document.getElementById('sliceInfo'),
    loadingBar: document.getElementById('loadingBar'),
    toggleROI: document.getElementById('toggleROI'),
    readout: document.getElementById('doseReadout')
};

/**
 * 初期化処理
 */
function init() {
    // Cornerstoneの初期設定
    cornerstone.enable(state.viewport.el);
    
    // Hammer.js によるタッチジェスチャーの設定
    const mc = new Hammer.Manager(state.viewport.el);
    mc.add(new Hammer.Pan({ direction: Hammer.DIRECTION_ALL, threshold: 5 }));
    mc.add(new Hammer.Pinch()).recognizeWith(mc.get('pan'));

    let lastDeltaY = 0;
    let startWW = 0, startWC = 0;
    let isVertical = false;

    // タッチ開始時
    mc.on('panstart', (e) => {
        // 縦移動か横移動かを判定
        isVertical = Math.abs(e.velocityY) > Math.abs(e.velocityX);
        const vp = cornerstone.getViewport(state.viewport.el);
        if (vp) { 
            startWW = vp.voi.windowWidth; 
            startWC = vp.voi.windowCenter; 
        }
        lastDeltaY = 0;
    });

    // タッチ移動中
    mc.on('panmove', (e) => {
        if (isVertical) {
            // 1. 縦スワイプ: スライス移動
            const sensitivity = 15; // 15pxごとに1枚移動
            const delta = Math.round(e.deltaY / sensitivity);
            if (delta !== lastDeltaY) {
                changeSlice(delta - lastDeltaY);
                lastDeltaY = delta;
            }
        } else {
            // 2. 横スワイプ: ウィンドウレベル調整
            const vp = cornerstone.getViewport(state.viewport.el);
            if (vp) {
                vp.voi.windowWidth = Math.max(1, startWW + e.deltaX);
                vp.voi.windowCenter = startWC + e.deltaY;
                cornerstone.setViewport(state.viewport.el, vp);
            }
        }
    });

    // 3. ピンチ操作: ズーム
    mc.on('pinchmove', (e) => {
        const vp = cornerstone.getViewport(state.viewport.el);
        if (vp) {
            vp.scale *= e.scale;
            e.scale = 1; 
            cornerstone.setViewport(state.viewport.el, vp);
        }
    });

    // リサイズ対応（PCでの表示崩れ防止）
    window.addEventListener('resize', () => {
        cornerstone.resize(state.viewport.el);
        redrawOverlay();
    });

    // レンダリング完了時にオーバーレイ（線量・ROI）を再描画
    state.viewport.el.addEventListener('cornerstoneimagerendered', () => redrawOverlay());

    // UIイベントの紐付け
    ui.caseSel.onchange = (e) => loadCase(e.target.value);
    ui.doseSel.onchange = (e) => loadDose(e.target.value);
    ui.opacity.oninput = () => redrawOverlay();
    ui.toggleROI.onclick = () => {
        state.roiVisible = !state.roiVisible;
        ui.toggleROI.textContent = `ROI: ${state.roiVisible ? 'ON' : 'OFF'}`;
        redrawOverlay();
    };

    loadCaseList();
}

/**
 * 症例リストのロード
 */
async function loadCaseList() {
    try {
        const r = await fetch('./static/data/cases.json');
        const list = await r.json();
        ui.caseSel.innerHTML = list.map(id => `<option value="${id}">${id}</option>`).join('');
        if (list.length > 0) loadCase(list[0]);
    } catch (e) { console.error("Case List Load Error", e); }
}

/**
 * 症例データのロード
 */
async function loadCase(caseId) {
    state.caseId = caseId;
    ui.loadingBar.style.width = "30%";
    
    const mf = await fetch(`./static/data/${caseId}/manifest.json`).then(r=>r.json());
    state.manifest = mf;

    // CTバイナリの取得とデコード
    const ctBin = await fetchBinary(`./static/data/${caseId}/ct.bin`, mf.ct.chunks);
    const rawBytes = new Uint8Array(ctBin);
    state.ctVolume = new Int16Array(rawBytes.length);
    const lut = mf.ct.lut;
    for(let i=0; i<rawBytes.length; i++) { 
        state.ctVolume[i] = lut[rawBytes[i]]; 
    }
    
    state.currentSlice = Math.floor(mf.ct.count / 2);
    
    // プラン選択肢の更新
    ui.doseSel.innerHTML = "<option value=''>None</option>" + 
        Object.keys(mf.doses).map(d => `<option value="${d}">${d}</option>`).join('');
    
    // 初期データのロード
    const doseKeys = Object.keys(mf.doses);
    if (doseKeys.length > 0) await loadDose(doseKeys[0]);
    
    const structKeys = Object.keys(mf.structs);
    if (structKeys.length > 0) {
        const fn = mf.structs[structKeys[0]];
        state.viewport.structData = await fetch(`./static/data/${caseId}/${fn}`).then(r=>r.json());
    }

    ui.loadingBar.style.width = "100%";
    setTimeout(() => ui.loadingBar.style.width = "0%", 500);
    
    cornerstone.resize(state.viewport.el);
    drawSlice();
}

/**
 * 線量データのロード
 */
async function loadDose(doseId) {
    if(!doseId) { 
        state.viewport.doseVolume = null; 
        state.viewport.doseMeta = null;
        redrawOverlay(); 
        return; 
    }
    const meta = state.manifest.doses[doseId];
    state.viewport.doseMeta = meta;
    const bin = await fetchBinary(`./static/data/${state.caseId}/${meta.filename}`, meta.chunks);
    state.viewport.doseVolume = new Float32Array(bin);
    redrawOverlay();
}

/**
 * スライス変更ロジック
 */
function changeSlice(delta) {
    const max = state.manifest.ct.count - 1;
    state.currentSlice = Math.max(0, Math.min(max, state.currentSlice + delta));
    drawSlice();
}

/**
 * 画像描画
 */
function drawSlice() {
    if (!state.ctVolume) return;
    const meta = state.manifest.ct;
    const start = state.currentSlice * meta.rows * meta.cols;
    const px = state.ctVolume.subarray(start, start + meta.rows * meta.cols);
    
    const img = {
        imageId: `ct:${state.caseId}:${state.currentSlice}`,
        minPixelValue: -1024, maxPixelValue: 3000,
        rows: meta.rows, columns: meta.cols, height: meta.rows, width: meta.cols,
        getPixelData: () => px, sizeInBytes: px.byteLength,
        color: false, columnPixelSpacing: meta.spacing[0], rowPixelSpacing: meta.spacing[1],
        slope: 1.0, intercept: 0.0, windowCenter: 40, windowWidth: 400,
        render: cornerstone.renderGrayscaleImage, get: () => undefined
    };
    
    cornerstone.displayImage(state.viewport.el, img);
    ui.sliceInfo.textContent = `Slice: ${state.currentSlice} / ${meta.count-1}`;
}

/**
 * 線量分布・構造物の再描画
 */
function redrawOverlay() {
    const vp = state.viewport;
    const el = vp.el;
    const enEl = cornerstone.getEnabledElement(el);
    if (!enEl || !enEl.image) return;

    // キャンバスサイズを実際の要素サイズに同期
    const w = el.offsetWidth, h = el.offsetHeight;
    if (vp.doseCanvas.width !== w) {
        vp.doseCanvas.width = w; vp.doseCanvas.height = h;
        vp.structCanvas.width = w; vp.structCanvas.height = h;
    }
    
    const dCtx = vp.doseCanvas.getContext('2d');
    const sCtx = vp.structCanvas.getContext('2d');
    dCtx.clearRect(0,0,w,h);
    sCtx.clearRect(0,0,w,h);

    const ctZ = state.manifest.ct.z_positions[state.currentSlice];

    // 1. 線量描画
    if (vp.doseVolume && vp.doseMeta) {
        const dMeta = vp.doseMeta;
        let bestZ=-1, minD=999;
        dMeta.z_positions.forEach((dz, i) => { 
            const dist = Math.abs(dz - ctZ);
            if(dist < minD) { minD = dist; bestZ = i; } 
        });

        if (minD < 2.0) {
            const start = bestZ * dMeta.rows * dMeta.cols;
            const doseSlice = vp.doseVolume.subarray(start, start + dMeta.rows * dMeta.cols);
            const offCanvas = document.createElement('canvas'); 
            offCanvas.width = dMeta.cols; offCanvas.height = dMeta.rows;
            const offCtx = offCanvas.getContext('2d'); 
            const imgData = offCtx.createImageData(dMeta.cols, dMeta.rows);
            
            // 簡易的な閾値処理
            const threshold = 5.0; 
            for(let i=0; i<doseSlice.length; i++) {
                const v = doseSlice[i];
                if(v >= threshold) {
                    const p = i*4;
                    const color = getDoseColor(v, 70); // 70Gyを最大値として色付け
                    imgData.data[p]=color[0]; imgData.data[p+1]=color[1]; imgData.data[p+2]=color[2]; imgData.data[p+3]=200;
                }
            }
            offCtx.putImageData(imgData, 0, 0);
            
            dCtx.save();
            dCtx.globalAlpha = ui.opacity.value;
            cornerstone.setToPixelCoordinateSystem(enEl, dCtx);
            const ctMeta = state.manifest.ct;
            const dx = (dMeta.origin[0] - ctMeta.origin[0]) / ctMeta.spacing[0];
            const dy = (dMeta.origin[1] - ctMeta.origin[1]) / ctMeta.spacing[1];
            const dw = dMeta.cols * (dMeta.spacing[0] / ctMeta.spacing[0]);
            const dh = dMeta.rows * (dMeta.spacing[1] / ctMeta.spacing[1]);
            dCtx.drawImage(offCanvas, dx, dy, dw, dh);
            dCtx.restore();
        }
    }

    // 2. 構造物描画
    if (vp.structData && state.roiVisible) {
        sCtx.save();
        cornerstone.setToPixelCoordinateSystem(enEl, sCtx);
        sCtx.lineWidth = 1.5 / enEl.viewport.scale;
        Object.keys(vp.structData).forEach(roi => {
            const s = vp.structData[roi];
            const pts = s.contours[ctZ.toFixed(2)];
            if (pts) {
                sCtx.strokeStyle = s.color;
                sCtx.beginPath();
                pts.forEach(poly => {
                    sCtx.moveTo(poly[0][0], poly[0][1]);
                    for(let i=1; i<poly.length; i++) sCtx.lineTo(poly[i][0], poly[i][1]);
                    sCtx.closePath();
                });
                sCtx.stroke();
            }
        });
        sCtx.restore();
    }
}

/**
 * 線量値のカラーマップ関数
 */
function getDoseColor(v, max) {
    const r = v / max;
    if (r < 0.25) return [0, r * 4 * 255, 255];
    if (r < 0.5) return [0, 255, (1 - (r - 0.25) * 4) * 255];
    if (r < 0.75) return [(r - 0.5) * 4 * 255, 255, 0];
    return [255, (1 - (r - 0.75) * 4) * 255, 0];
}

/**
 * バイナリファイルの取得（gzipped対応）
 */
async function fetchBinary(url, chunks) {
    const realUrl = url.endsWith('.gz') ? url : url + '.gz';
    const r = await fetch(realUrl);
    const buf = await r.arrayBuffer();
    try {
        return pako.inflate(new Uint8Array(buf)).buffer;
    } catch (e) {
        return buf;
    }
}

init();
