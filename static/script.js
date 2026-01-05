/* RT-Viewer Ultimate Script (v2.3: Absolute Z Fix) */
/**
 * RT-Viewer: DICOM RT Processing Logic
 * (c) 2025 [Your Name/Handle]
 * For educational reference only. Clinical use is strictly prohibited.
 * Based on the logic of "Anonymized DICOM Conversion" to ensure privacy.
 */

const state = {
    caseId: null, manifest: null, ctVolume: null,
    doseUnit: 'Gy', normalizationDse: 60.0,
    viewports: {
        left: { el: document.getElementById('dicomLeft'), doseCanvas: document.getElementById('doseCanvasLeft'), structCanvas: document.getElementById('structCanvasLeft'), doseId: "", structId: "", structData: null, doseVolume: null, doseMeta: null, roiVisibility: {}, roiListEl: document.getElementById('roiListLeft'), drawCache: {} },
        right: { el: document.getElementById('dicomRight'), doseCanvas: document.getElementById('doseCanvasRight'), structCanvas: document.getElementById('structCanvasRight'), doseId: "", structId: "", structData: null, doseVolume: null, doseMeta: null, roiVisibility: {}, roiListEl: document.getElementById('roiListRight'), drawCache: {} }
    }
};

const ui = {
    caseSel: document.getElementById('caseSelector'), slider: document.getElementById('sliceSlider'), sliceInfo: document.getElementById('sliceInfo'),
    doseMin: document.getElementById('doseMin'), doseMax: document.getElementById('doseMax'), dispMin: document.getElementById('dispMin'), dispMax: document.getElementById('dispMax'),
    opacity: document.getElementById('doseOpacity'), loadingBar: document.getElementById('loadingBar'), unitGy: document.getElementById('unitGy'), unitPct: document.getElementById('unitPct'), normDose: document.getElementById('normDose'),
    left: { structSel: document.getElementById('selStructLeft'), doseSel: document.getElementById('selDoseLeft') },
    right: { structSel: document.getElementById('selStructRight'), doseSel: document.getElementById('selDoseRight') }
};

function init() {
    cornerstoneTools.external.cornerstone = cornerstone;
    cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
    cornerstoneTools.external.Hammer = Hammer;
    cornerstoneTools.init();
    
    ['left', 'right'].forEach(k => {
        const el = state.viewports[k].el;
        cornerstone.enable(el);
        const tools = [cornerstoneTools.WwwcTool, cornerstoneTools.PanTool, cornerstoneTools.ZoomTool];
        tools.forEach(t => cornerstoneTools.addTool(t));
        cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
        cornerstoneTools.setToolActive('Zoom', { mouseButtonMask: 2 });
        cornerstoneTools.setToolActive('Pan', { mouseButtonMask: 4 });

        el.addEventListener('cornerstoneimagerendered', () => redrawOverlay(k));
        
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!state.ctVolume) return;
            const direction = e.deltaY > 0 ? 1 : -1;
            let current = parseInt(ui.slider.value);
            let max = parseInt(ui.slider.max);
            let next = current + direction;
            if(next < 0) next = 0; if(next > max) next = max;
            if(next !== current) { ui.slider.value = next; drawSlice(next); }
        });
        
        el.addEventListener('mousemove', (e) => {
            if (!state.manifest) return;
            const pt = cornerstone.pageToPixel(el, e.pageX, e.pageY);
            const ctMeta = state.manifest.ct;
            const worldX = pt.x * ctMeta.spacing[0] + ctMeta.origin[0];
            const worldY = pt.y * ctMeta.spacing[1] + ctMeta.origin[1];
            updateDoseReadout(worldX, worldY);
        });
    });

    const syncPZ = new cornerstoneTools.Synchronizer("cornerstoneimagerendered", cornerstoneTools.panZoomSynchronizer);
    const syncWC = new cornerstoneTools.Synchronizer("cornerstoneimagerendered", cornerstoneTools.wwwcSynchronizer);
    syncPZ.add(state.viewports.left.el); syncPZ.add(state.viewports.right.el);
    syncWC.add(state.viewports.left.el); syncWC.add(state.viewports.right.el);

    loadCaseList();
    
    ui.caseSel.addEventListener('change', (e) => loadCase(e.target.value));
    ui.slider.addEventListener('input', (e) => drawSlice(parseInt(e.target.value)));
    ui.doseMin.addEventListener('input', updateVisuals);
    ui.doseMax.addEventListener('input', updateVisuals);
    ui.opacity.addEventListener('input', updateVisuals);
    ui.unitGy.addEventListener('change', () => switchUnit('Gy'));
    ui.unitPct.addEventListener('change', () => switchUnit('%'));
    ui.normDose.addEventListener('change', () => { setSliderRange(state.doseUnit); updateVisuals(); });
    
    ['left', 'right'].forEach(k => {
        ui[k].doseSel.addEventListener('change', (e) => loadDose(k, e.target.value));
        ui[k].structSel.addEventListener('change', (e) => loadStruct(k, e.target.value));
    });
}

async function loadCaseList() {
    try {
        const r = await fetch('./static/data/cases.json');
        const list = await r.json();
        ui.caseSel.innerHTML = "";
        list.forEach(id => {
            let o = document.createElement('option'); o.value = id; o.text = id; ui.caseSel.add(o);
        });
        if (list.length > 0) loadCase(list[0]);
    } catch (e) { console.error("Load Error", e); }
}

async function fetchBinary(url, chunks) {
    const realUrl = url.endsWith('.gz') ? url : url + '.gz';
    let combined;
    if (!chunks || chunks <= 1) {
        const buf = await fetch(realUrl).then(r => r.arrayBuffer());
        combined = new Uint8Array(buf);
    } else {
        const promises = [];
        for(let i=0; i<chunks; i++) promises.push(fetch(`${realUrl}.${i}`).then(r=>r.arrayBuffer()));
        const buffers = await Promise.all(promises);
        const total = buffers.reduce((a,b)=>a+b.byteLength,0);
        combined = new Uint8Array(total);
        let offset=0;
        buffers.forEach(b=>{ combined.set(new Uint8Array(b), offset); offset+=b.byteLength; });
    }
    try { return pako.inflate(combined).buffer; }
    catch (e) { return combined.buffer; }
}

async function loadCase(caseId) {
    state.caseId = caseId;
    ui.loadingBar.style.width = "30%";
    const mf = await fetch(`./static/data/${caseId}/manifest.json`).then(r=>r.json());
    state.manifest = mf;
    const ctBin = await fetchBinary(`./static/data/${caseId}/ct.bin`, mf.ct.chunks);
    const rawBytes = new Uint8Array(ctBin);
    const volumeLen = rawBytes.length;
    state.ctVolume = new Int16Array(volumeLen);
    const lut = mf.ct.lut;
    for(let i=0; i<volumeLen; i++) { state.ctVolume[i] = lut[rawBytes[i]]; }
    ui.slider.max = mf.ct.count - 1;
    ui.slider.value = Math.floor(mf.ct.count / 2);
    
    const doseKeys = Object.keys(mf.doses);
    const structKeys = Object.keys(mf.structs);
    ['left', 'right'].forEach(k => {
        ui[k].doseSel.innerHTML = "<option value=''>None</option>";
        doseKeys.forEach(d => { let o=document.createElement('option'); o.value=d; o.text=d; ui[k].doseSel.add(o); });
        ui[k].structSel.innerHTML = "<option value=''>None</option>";
        structKeys.forEach(s => { let o=document.createElement('option'); o.value=s; o.text=s; ui[k].structSel.add(o); });
    });

    if(doseKeys.length > 0) await loadDose('left', doseKeys[0]);
    if(doseKeys.length > 1) await loadDose('right', doseKeys[1]); else if(doseKeys.length > 0) await loadDose('right', doseKeys[0]);
    if(structKeys.length > 0) { await loadStruct('left', structKeys[0]); await loadStruct('right', structKeys[0]); }
    
    ui.loadingBar.style.width = "100%";
    setTimeout(() => ui.loadingBar.style.width = "0%", 500);
    if(doseKeys.length > 0) {
        const presc = mf.doses[doseKeys[0]].prescription || 60;
        state.normalizationDose = presc; ui.normDose.value = presc;
        setSliderRange('Gy'); updateVisuals();
    }
    ['left', 'right'].forEach(k => cornerstone.resize(state.viewports[k].el));
    drawSlice(parseInt(ui.slider.value));
}

async function loadDose(key, doseId) {
    const vp = state.viewports[key];
    vp.doseId = doseId; ui[key].doseSel.value = doseId;
    if(!doseId) { vp.doseVolume = null; vp.doseMeta = null; redrawOverlay(key); return; }
    const meta = state.manifest.doses[doseId];
    vp.doseMeta = meta;
    const bin = await fetchBinary(`./static/data/${state.caseId}/${meta.filename}`, meta.chunks);
    vp.doseVolume = new Float32Array(bin);
    redrawOverlay(key);
}

async function loadStruct(key, structId) {
    const vp = state.viewports[key];
    vp.structId = structId; ui[key].structSel.value = structId;
    if(!structId) { vp.structData = null; redrawOverlay(key); return; }
    const fn = state.manifest.structs[structId];
    vp.structData = await fetch(`./static/data/${state.caseId}/${fn}`).then(r=>r.json());
    vp.roiListEl.innerHTML = "";
    const btnRow = document.createElement('div');
    btnRow.style.padding = "5px"; btnRow.style.borderBottom = "1px solid #333"; btnRow.style.marginBottom = "5px";
    const btn = document.createElement('button');
    btn.className = "btn-tiny full-width"; btn.textContent = "👁️ ALL ON/OFF";
    btn.onclick = () => window.toggleAllROI(key);
    btnRow.appendChild(btn); vp.roiListEl.appendChild(btnRow);
    Object.keys(vp.structData).forEach(n => {
        if(vp.roiVisibility[n] === undefined) vp.roiVisibility[n] = true;
        const d = document.createElement('div'); d.className = 'roi-item';
        const chk = document.createElement('input'); chk.type='checkbox'; chk.checked = vp.roiVisibility[n];
        chk.onchange = () => { vp.roiVisibility[n] = chk.checked; redrawOverlay(key); };
        const box = document.createElement('div'); box.className='roi-color-box'; box.style.background = vp.structData[n].color;
        const name = document.createElement('span'); name.className='roi-name'; name.textContent = n;
        d.append(chk, box, name); vp.roiListEl.appendChild(d);
    });
    redrawOverlay(key);
}

function drawSlice(idx) {
    if (!state.ctVolume) return;
    const meta = state.manifest.ct;
    const start = idx * meta.rows * meta.cols;
    const px = state.ctVolume.subarray(start, start + meta.rows * meta.cols);
    ['left', 'right'].forEach(k => {
        const el = state.viewports[k].el;
        const img = {
            imageId: `ct:${state.caseId}:${idx}:${k}`,
            minPixelValue: -1024, maxPixelValue: 3000,
            rows: meta.rows, columns: meta.cols, height: meta.rows, width: meta.cols,
            getPixelData: () => px, sizeInBytes: px.byteLength,
            color: false, columnPixelSpacing: meta.spacing[0], rowPixelSpacing: meta.spacing[1],
            slope: 1.0, intercept: 0.0, windowCenter: 40, windowWidth: 400,
            render: cornerstone.renderGrayscaleImage, get: () => undefined
        };
        try { const vp = cornerstone.getViewport(el); if(vp) { img.windowCenter=vp.voi.windowCenter; img.windowWidth=vp.voi.windowWidth; } } catch(e){}
        cornerstone.displayImage(el, img);
        redrawOverlay(k);
    });
    ui.sliceInfo.textContent = `${idx} / ${meta.count-1}`;
}

// ★修正点: 絶対Z座標を使ってマッチング
function redrawOverlay(key) {
    const vp = state.viewports[key];
    const el = vp.el;
    const enEl = cornerstone.getEnabledElement(el);
    if (!enEl || !enEl.image) return;
    const w = el.clientWidth, h = el.clientHeight;
    if (vp.doseCanvas.width !== w) { vp.doseCanvas.width = w; vp.doseCanvas.height = h; }
    if (vp.structCanvas.width !== w) { vp.structCanvas.width = w; vp.structCanvas.height = h; }
    const dCtx = vp.doseCanvas.getContext('2d');
    const sCtx = vp.structCanvas.getContext('2d');
    dCtx.clearRect(0,0,w,h); sCtx.clearRect(0,0,w,h);
    
    // --- 線量描画 ---
    if (vp.doseVolume) {
        // 現在のCTの物理Z座標
        const ctZ = state.manifest.ct.z_positions[parseInt(ui.slider.value)];
        
        let bestZ=-1, minD=999;
        // 線量の絶対Z座標リストから、最も近いものを探す
        const doseZPositions = vp.doseMeta.z_positions || [];
        doseZPositions.forEach((dz, i) => {
            if(Math.abs(dz - ctZ) < minD) { minD = Math.abs(dz - ctZ); bestZ = i; }
        });
        
        // 誤差2mm以内なら表示
        if (minD < 2.0 && bestZ !== -1) {
            const dMeta = vp.doseMeta;
            const start = bestZ * dMeta.rows * dMeta.cols;
            const doseSlice = vp.doseVolume.subarray(start, start + dMeta.rows * dMeta.cols);
            const c = document.createElement('canvas'); c.width = dMeta.cols; c.height = dMeta.rows;
            const cx = c.getContext('2d'); const imgData = cx.createImageData(dMeta.cols, dMeta.rows);
            
            let minV, maxV;
            const norm = parseFloat(ui.normDose.value) || 60;
            if(state.doseUnit === 'Gy') { minV = parseFloat(ui.doseMin.value); maxV = parseFloat(ui.doseMax.value); }
            else { minV = (parseFloat(ui.doseMin.value)/100)*norm; maxV = (parseFloat(ui.doseMax.value)/100)*norm; }
            
            for(let i=0; i<doseSlice.length; i++) {
                const v = doseSlice[i];
                if(v >= minV) {
                    const color = getDoseColor(v, maxV);
                    const p = i*4;
                    imgData.data[p]=color[0]; imgData.data[p+1]=color[1]; imgData.data[p+2]=color[2]; imgData.data[p+3]=200;
                }
            }
            cx.putImageData(imgData, 0, 0);
            dCtx.save(); dCtx.globalAlpha = ui.opacity.value; dCtx.imageSmoothingEnabled = true;
            cornerstone.setToPixelCoordinateSystem(enEl, dCtx);
            const ctMeta = state.manifest.ct;
            const dx = (dMeta.origin[0] - ctMeta.origin[0]) / ctMeta.spacing[0];
            const dy = (dMeta.origin[1] - ctMeta.origin[1]) / ctMeta.spacing[1];
            const dw = dMeta.cols * (dMeta.spacing[0] / ctMeta.spacing[0]);
            const dh = dMeta.rows * (dMeta.spacing[1] / ctMeta.spacing[1]);
            dCtx.drawImage(c, dx, dy, dw, dh);
            dCtx.restore();
        }
    }
    
    // --- ストラクチャ描画 ---
    if (vp.structData) {
        sCtx.save(); cornerstone.setToPixelCoordinateSystem(enEl, sCtx);
        sCtx.lineWidth = 2.0 / enEl.viewport.scale;
        const ctZ = state.manifest.ct.z_positions[parseInt(ui.slider.value)];
        Object.keys(vp.structData).forEach(roi => {
            if (vp.roiVisibility[roi] === false) return;
            const s = vp.structData[roi];
            let pts = s.contours[ctZ.toFixed(2)];
            if (!pts) {
                const keys = Object.keys(s.contours);
                for(let k of keys) { if(Math.abs(parseFloat(k)-ctZ) < 0.1) { pts = s.contours[k]; break; } }
            }
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

function updateDoseReadout(wx, wy) {
    ['left', 'right'].forEach(k => {
        const el = document.getElementById(k==='left'?'doseValLeft':'doseValRight');
        el.textContent = "";
        const vp = state.viewports[k];
        if(!vp.doseVolume) return;
        const dMeta = vp.doseMeta;
        const dCol = Math.floor((wx - dMeta.origin[0]) / dMeta.spacing[0]);
        const dRow = Math.floor((wy - dMeta.origin[1]) / dMeta.spacing[1]);
        const ctZ = state.manifest.ct.z_positions[parseInt(ui.slider.value)];
        let bestZ=-1, minD=999;
        
        // Z検索も絶対座標で
        const doseZPositions = vp.doseMeta.z_positions || [];
        doseZPositions.forEach((dz, i) => { if(Math.abs(dz - ctZ) < minD) { minD = Math.abs(dz - ctZ); bestZ = i; } });
        
        if(minD < 2.0 && dCol>=0 && dCol<dMeta.cols && dRow>=0 && dRow<dMeta.rows) {
            const idx = bestZ * dMeta.rows * dMeta.cols + dRow * dMeta.cols + dCol;
            const val = vp.doseVolume[idx];
            if(val !== undefined) {
                if(state.doseUnit==='Gy') el.textContent = val.toFixed(2) + " Gy";
                else el.textContent = ((val/parseFloat(ui.normDose.value))*100).toFixed(1) + " %";
            }
        }
    });
}

function getDoseColor(v, max) {
    const r = v/max;
    if(r<0.25) return [0, r*4*255, 255];
    if(r<0.5) return [0, 255, (1-(r-0.25)*4)*255];
    if(r<0.75) return [(r-0.5)*4*255, 255, 0];
    return [255, (1-(r-0.75)*4)*255, 0];
}

function updateVisuals() {
    ui.dispMin.textContent = ui.doseMin.value;
    ui.dispMax.textContent = ui.doseMax.value;
    ['left', 'right'].forEach(k => redrawOverlay(k));
}

function switchUnit(u) {
    state.doseUnit = u;
    const norm = parseFloat(ui.normDose.value);
    if(u === 'Gy') { ui.doseMin.value = (parseInt(ui.doseMin.value)/100)*norm; ui.doseMax.value = (parseInt(ui.doseMax.value)/100)*norm; }
    else { ui.doseMin.value = (parseFloat(ui.doseMin.value)/norm)*100; ui.doseMax.value = (parseFloat(ui.doseMax.value)/norm)*100; }
    setSliderRange(u); updateVisuals();
}

function setSliderRange(u) {
    if(u==='Gy') { const m = Math.ceil(parseFloat(ui.normDose.value)*1.3); ui.doseMin.max = m; ui.doseMax.max = m; }
    else { ui.doseMin.max = 130; ui.doseMax.max = 130; }
}

window.setWL = (ww, wc) => {
    ['left', 'right'].forEach(k => {
        const vp = cornerstone.getViewport(state.viewports[k].el);
        if(vp) { vp.voi.windowWidth=ww; vp.voi.windowCenter=wc; cornerstone.setViewport(state.viewports[k].el, vp); }
    });
};

// --- ここから追加：ズーム操作関数 ---
window.changeZoom = (delta) => {
    ['left', 'right'].forEach(k => {
        const el = state.viewports[k].el;
        if (!el) return;

        // 1. 現在のビューポート情報を取得
        const viewport = cornerstone.getViewport(el);
        if (viewport) {
            // 2. スケールを変更
            const oldScale = viewport.scale;
            viewport.scale += delta;
            
            // 3. 最小/最大制限（0.1倍〜10倍程度）
            if (viewport.scale < 0.1) viewport.scale = 0.1;
            if (viewport.scale > 10.0) viewport.scale = 10.0;
            
            // 4. 新しい状態を適用
            cornerstone.setViewport(el, viewport);

            // 5. 【重要】画面を強制的に更新
            // これを入れないと、数値は変わっても見た目が変わりません
            cornerstone.updateImage(el);
        }
    });
};
// --- ここまで追加 ---

window.toggleAllROI = (key) => {
    const vp = state.viewports[key];
    if(!vp.structData) return;
    const allKeys = Object.keys(vp.structData);
    const anyOff = allKeys.some(k => vp.roiVisibility[k] === false);
    const targetState = anyOff; 
    allKeys.forEach(k => vp.roiVisibility[k] = targetState);
    const checkboxes = vp.roiListEl.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = targetState);
    redrawOverlay(key);
};

init();
