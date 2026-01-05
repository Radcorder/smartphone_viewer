/* RT-Viewer Mobile Edition */
const state = {
    caseId: null, manifest: null, ctVolume: null,
    currentSlice: 0,
    roiVisible: true,
    viewport: {
        el: document.getElementById('dicomMain'),
        doseCanvas: document.getElementById('doseCanvasMain'),
        structCanvas: document.getElementById('structCanvasMain'),
        doseVolume: null, doseMeta: null, structData: null
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

function init() {
    cornerstone.enable(state.viewport.el);
    
    // Hammer.js の設定
    const mc = new Hammer.Manager(state.viewport.el);
    mc.add(new Hammer.Pan({ direction: Hammer.DIRECTION_ALL, threshold: 5 }));
    mc.add(new Hammer.Pinch()).recognizeWith(mc.get('pan'));

    let lastDeltaY = 0;
    let startWW = 0, startWC = 0;
    let isVertical = false;

    mc.on('panstart', (e) => {
        isVertical = Math.abs(e.velocityY) > Math.abs(e.velocityX);
        const vp = cornerstone.getViewport(state.viewport.el);
        if (vp) { startWW = vp.voi.windowWidth; startWC = vp.voi.windowCenter; }
        lastDeltaY = 0;
    });

    mc.on('panmove', (e) => {
        if (isVertical) {
            // 縦スワイプ: スライス移動 (感度調整: 15pxで1枚)
            const delta = Math.round(e.deltaY / 15);
            if (delta !== lastDeltaY) {
                changeSlice(delta - lastDeltaY);
                lastDeltaY = delta;
            }
        } else {
            // 横スワイプ: ウィンドウレベル調整
            const vp = cornerstone.getViewport(state.viewport.el);
            if (vp) {
                vp.voi.windowWidth = startWW + e.deltaX;
                vp.voi.windowCenter = startWC + e.deltaY;
                cornerstone.setViewport(state.viewport.el, vp);
            }
        }
    });

    mc.on('pinchmove', (e) => {
        const vp = cornerstone.getViewport(state.viewport.el);
        if (vp) {
            vp.scale *= e.scale;
            e.scale = 1; // 連続変化を抑える
            cornerstone.setViewport(state.viewport.el, vp);
        }
    });

    // 1画面用イベント
    state.viewport.el.addEventListener('cornerstoneimagerendered', () => redrawOverlay());

    // UIイベント
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

async function loadCaseList() {
    const r = await fetch('./static/data/cases.json');
    const list = await r.json();
    ui.caseSel.innerHTML = list.map(id => `<option value="${id}">${id}</option>`).join('');
    if (list.length > 0) loadCase(list[0]);
}

async function loadCase(caseId) {
    state.caseId = caseId;
    ui.loadingBar.style.width = "30%";
    const mf = await fetch(`./static/data/${caseId}/manifest.json`).then(r=>r.json());
    state.manifest = mf;

    // CTデータ読み込み
    const ctBin = await fetchBinary(`./static/data/${caseId}/ct.bin`, mf.ct.chunks);
    state.ctVolume = new Int16Array(ctBin);
    const lut = mf.ct.lut;
    for(let i=0; i<state.ctVolume.length; i++) { state.ctVolume[i] = lut[state.ctVolume[i]]; }
    
    state.currentSlice = Math.floor(mf.ct.count / 2);
    
    // Dose/Struct 選択肢更新 (1画面分)
    ui.doseSel.innerHTML = "<option value=''>None</option>" + 
        Object.keys(mf.doses).map(d => `<option value="${d}">${d}</option>`).join('');
    
    // 最初のデータを自動ロード
    const firstDose = Object.keys(mf.doses)[0];
    if (firstDose) await loadDose(firstDose);
    
    const firstStruct = Object.keys(mf.structs)[0];
    if (firstStruct) {
        const fn = mf.structs[firstStruct];
        state.viewport.structData = await fetch(`./static/data/${caseId}/${fn}`).then(r=>r.json());
    }

    ui.loadingBar.style.width = "100%";
    setTimeout(() => ui.loadingBar.style.width = "0%", 500);
    drawSlice();
}

async function loadDose(doseId) {
    if(!doseId) { state.viewport.doseVolume = null; redrawOverlay(); return; }
    const meta = state.manifest.doses[doseId];
    state.viewport.doseMeta = meta;
    const bin = await fetchBinary(`./static/data/${state.caseId}/${meta.filename}`, meta.chunks);
    state.viewport.doseVolume = new Float32Array(bin);
    redrawOverlay();
}

function changeSlice(delta) {
    const max = state.manifest.ct.count - 1;
    state.currentSlice = Math.max(0, Math.min(max, state.currentSlice + delta));
    drawSlice();
}

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

function redrawOverlay() {
    const vp = state.viewport;
    const el = vp.el;
    const enEl = cornerstone.getEnabledElement(el);
    if (!enEl || !enEl.image) return;

    const w = el.clientWidth, h = el.clientHeight;
    [vp.doseCanvas, vp.structCanvas].forEach(c => { if(c.width !== w) { c.width = w; c.height = h; }});
    
    const dCtx = vp.doseCanvas.getContext('2d');
    const sCtx = vp.structCanvas.getContext('2d');
    dCtx.clearRect(0,0,w,h); sCtx.clearRect(0,0,w,h);

    const ctZ = state.manifest.ct.z_positions[state.currentSlice];

    // Dose Render
    if (vp.doseVolume) {
        const dMeta = vp.doseMeta;
        let bestZ=-1, minD=999;
        dMeta.z_positions.forEach((dz, i) => { if(Math.abs(dz - ctZ) < minD) { minD = Math.abs(dz - ctZ); bestZ = i; } });

        if (minD < 2.0) {
            const start = bestZ * dMeta.rows * dMeta.cols;
            const doseSlice = vp.doseVolume.subarray(start, start + dMeta.rows * dMeta.cols);
            const c = document.createElement('canvas'); c.width = dMeta.cols; c.height = dMeta.rows;
            const cx = c.getContext('2d'); const imgData = cx.createImageData(c.width, c.height);
            
            const threshold = 10.0; // 固定閾値
            for(let i=0; i<doseSlice.length; i++) {
                const v = doseSlice[i];
                if(v >= threshold) {
                    const r = v/70; // 簡易カラーマップ
                    const p = i*4;
                    imgData.data[p]=255*r; imgData.data[p+1]=255*(1-r); imgData.data[p+2]=100; imgData.data[p+3]=200;
                }
            }
            cx.putImageData(imgData, 0, 0);
            dCtx.save(); dCtx.globalAlpha = ui.opacity.value;
            cornerstone.setToPixelCoordinateSystem(enEl, dCtx);
            const ctMeta = state.manifest.ct;
            dCtx.drawImage(c, (dMeta.origin[0]-ctMeta.origin[0])/ctMeta.spacing[0], (dMeta.origin[1]-ctMeta.origin[1])/ctMeta.spacing[1], dMeta.cols*(dMeta.spacing[0]/ctMeta.spacing[0]), dMeta.rows*(dMeta.spacing[1]/ctMeta.spacing[1]));
            dCtx.restore();
        }
    }

    // Structure Render
    if (vp.structData && state.roiVisible) {
        sCtx.save(); cornerstone.setToPixelCoordinateSystem(enEl, sCtx);
        sCtx.lineWidth = 1.5 / enEl.viewport.scale;
        Object.keys(vp.structData).forEach(roi => {
            const s = vp.structData[roi];
            const pts = s.contours[ctZ.toFixed(2)];
            if (pts) {
                sCtx.strokeStyle = s.color; sCtx.beginPath();
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

// 共通ヘルパー (fetchBinary, pakoなどは元のロジックを継承)
async function fetchBinary(url, chunks) {
    const realUrl = url.endsWith('.gz') ? url : url + '.gz';
    const buf = await fetch(realUrl).then(r => r.arrayBuffer());
    try { return pako.inflate(new Uint8Array(buf)).buffer; }
    catch (e) { return buf; }
}

init();
