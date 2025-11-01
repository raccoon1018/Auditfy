// Auditfy Editor • app.js
// v1.5.4
// - 계정(아바타) 버튼 토글/열림 동작 확실히 복구
// - Cloud→FileHub 가져오기 안정화 (mime 미지정/URL만 제공 케이스 대응)
// - “프로젝트 저장소로 업로드” 버튼을 Export 모달에 (로그인시에만) 동적 추가 + 작동
// - QuickEdit: 파일간 자동 페이드 인/아웃 유지
// - 효과 탭에 “페이드 인/아웃” 모달 추가: 자동 겹침 재배치 및 페이드 적용
// - 기타 자잘한 버그 픽스(상태바 경로, 모달 닫힘 등)

/////////////////////////////
// 공통 helpers
/////////////////////////////
const $  = (s, r=document)=> r.querySelector(s);
const $$ = (s, r=document)=> [...r.querySelectorAll(s)];
const log = (...a)=> console.log('%c[Auditfy]', 'color:#7cf', ...a);
const err = (...a)=> console.error('%c[Auditfy ERROR]', 'color:#f66', ...a);
const logs = [];
const recorderState = { stream:null, recorder:null, chunks:[], timer:null, start:0 };
const STATUS_TEXT = { logged:'준비됨', guest:'로그인하면 Cloud 프로젝트를 저장해 보세요' };
const YT_STREAM_ENDPOINT = 'https://piped.video/api/v1/streams/';
function logEvent(t){ logs.push(`[${new Date().toLocaleTimeString()}] ${t}`); }
function snack(msg){ const el=$('#snack'); if(!el) return; el.textContent=msg; el.classList.add('show'); clearTimeout(snack._t); snack._t=setTimeout(()=>el.classList.remove('show'),1600); }
function showModal(sel){ const el=$(sel); if(el) el.classList.add('open'); }
function hideModal(sel){ const el=$(sel); if(el) el.classList.remove('open'); }
function showLoading(on){ const el=$('#loading'); if(el) el.classList.toggle('open', !!on); }
function bind(sel, ev, fn){ const el=$(sel); if(!el){ return null; } el.addEventListener(ev, fn); return el; }
const clone = (o)=> (typeof structuredClone==='function'? structuredClone(o): JSON.parse(JSON.stringify(o)));

/////////////////////////////
// Supabase 세션 캐시/헬퍼
/////////////////////////////
let cachedSession=null;
let sessionPromise=null;
(function seedCachedSession(){
  try{
    const raw=localStorage.getItem('auditfy._session');
    if(raw) cachedSession=JSON.parse(raw);
  }catch{
    cachedSession=null;
  }
})();
function updateSessionCache(sess){
  cachedSession = sess || null;
  try{
    if(cachedSession) localStorage.setItem('auditfy._session', JSON.stringify(cachedSession));
    else localStorage.removeItem('auditfy._session');
  }catch{}
  return cachedSession;
}
function loadSession(force=false){
  if(force){ cachedSession=null; sessionPromise=null; }
  if(sessionPromise) return sessionPromise;
  if(!(window.Cloud && typeof Cloud.session==='function')){
    return Promise.resolve(updateSessionCache(null));
  }
  try{
    const result = Cloud.session();
    if(result && typeof result.then==='function'){
      sessionPromise = result
        .then(sess=>updateSessionCache(sess))
        .catch(err=>{ console.warn('[Auditfy] Cloud.session 실패', err); return updateSessionCache(null); })
        .finally(()=>{ sessionPromise=null; });
      return sessionPromise;
    }
    return Promise.resolve(updateSessionCache(result));
  }catch(err){
    console.warn('[Auditfy] Cloud.session 예외', err);
    return Promise.resolve(updateSessionCache(null));
  }
}
function getSessionSync(){ return cachedSession; }

function inputModal({
  title='입력',
  label='이름',
  placeholder='',
  defaultValue='',
  okText='확인',
  cancelText='취소'
}={}){
  return new Promise(resolve=>{
    const wrap=document.createElement('div');
    wrap.className='modal open';
    wrap.innerHTML=`
      <div class="card" style="min-width:320px;max-width:420px">
        <div class="hd">${title}</div>
        <div class="bd" style="display:flex;flex-direction:column;gap:10px">
          <label style="display:flex;flex-direction:column;gap:6px">
            <span style="font-weight:600">${label}</span>
            <input class="in" type="text" placeholder="${placeholder||''}" />
          </label>
        </div>
        <div class="ft">
          <button data-role="cancel" class="btn">${cancelText}</button>
          <button data-role="ok" class="btn grad">${okText}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const input = wrap.querySelector('input');
    const okBtn = wrap.querySelector('[data-role="ok"]');
    const cancelBtn = wrap.querySelector('[data-role="cancel"]');

    input.value = defaultValue || '';
    setTimeout(()=>{ input.focus(); input.select(); }, 50);

    const cleanup = (val)=>{
      wrap.classList.remove('open');
      setTimeout(()=> wrap.remove(), 160);
      resolve(val);
    };

    okBtn.addEventListener('click', ()=>{
      const val = input.value.trim();
      cleanup(val ? val : null);
    });
    cancelBtn.addEventListener('click', ()=> cleanup(null));
    wrap.addEventListener('click', (e)=>{ if(e.target===wrap) cleanup(null); });
    input.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){ e.preventDefault(); okBtn.click(); }
      if(e.key==='Escape'){ e.preventDefault(); cleanup(null); }
    });
  });
}

/////////////////////////////
// 편집 상태/이펙트 상태
/////////////////////////////
const DEFAULT_FX = {
  autoLevel:true, targetRMS:0.20,
  peakNorm:true, peakCeil:0.95,
  comp:true, compThr:0.50, compRatio:4.0,
  limit:true, limitCeil:0.98,
  eqLow:0, eqHigh:0,
  revMix:0.20, revTime:1.2,
  delayTime:0.25, delayFb:0.25, delayMix:0.20
};
const state = {
  activeTab:'file',
  theme:'dark', followSystem:false,
  files:[],        // {id,name,file,url,audio,buffer,duration}
  clips:[],        // {id,fileId,track,start,duration,color,fadeIn,fadeOut,gain=1}
  tracks:3,
  pxPerSec:10,
  snap:true,
  activeTool:'select', selClip:null,
  playing:false, loop:false, playheadSec:0,
  playStartContextTime:0, playStartProjectTime:0,
  ctx:null, master:null, analyser:null, nodes:[],
  fx: clone(DEFAULT_FX),
  // 네비게이션 가드
  dirty:false,
  projectId:null,
  projectTitle:'Untitled'
};

function ensureProjectId(){
  if(!state.projectId){
    state.projectId = 'p_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  }
  return state.projectId;
}

function updateProjectTitle(name){
  const title = (name && name.trim()) ? name.trim() : 'Untitled';
  state.projectTitle = title;
  const el=$('#projectName'); if(el) el.textContent=title;
  document.title = `Auditfy • ${title}`;
  const input=$('#renameInput'); if(input && document.activeElement!==input) input.value=title;
}

let panTargetClipId=null;
let hpfTargetClipId=null;

/////////////////////////////
// 부트
/////////////////////////////
window.addEventListener('DOMContentLoaded', ()=>{
  try{
    // Cloud 초기화 시도
    if(window.Cloud && Cloud.init) Cloud.init();

    const params = new URLSearchParams(location.search);
    const incomingId = params.get('pid');
    const incomingTitle = params.get('title');
    if(incomingId) state.projectId = incomingId;
    updateProjectTitle(incomingTitle || state.projectTitle);

    initTheme(); initTabs(); initRuler(); calibratePx();
    initTracks(state.tracks);
    initLeftbar(); initFileHub(); initSourceModal(); initProjectModals(); initYouTubeTools(); initRecorderControls(); initDnDToTimeline(); initTopbar();
    initQuickEdit(); initExport(); initEditOps(); initContextMenu(); initShortcutsUI();
    initEffectsModals(); ensureFadeModal(); ensureFadeButton(); initWheelScroll(); initRulerDrag(); initTimelineDrag();
    setZoom(state.pxPerSec); setPlayhead(0); resizeTimeline();

    // FileHub 버튼 라벨 보정(클라우드/기기)
    setupFileHubButtons();

    // 계정/설정 패널 렌더 (최초)
    renderAccountDock();
    syncAuthState();

    let authTries = 0;
    const authTimer = setInterval(()=>{
      syncAuthState();
      if(isLoggedIn() || ++authTries>40) clearInterval(authTimer);
    }, 150);

    window.addEventListener('storage', (evt)=>{
      if(!evt.key) return;
      if(['auditfy._session','auditfy.session','auditfy.loggedIn','auditfy.userPlan'].includes(evt.key)){
        syncAuthState(true);
        renderAccountDock(false);
      }
    });

    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) syncAuthState(); });

    if(incomingId && window.Cloud?.projects?.downloadProject){
      loadProjectFromCloud(incomingId).catch(e=>err('Cloud project load failed', e));
    }

    window.addEventListener('resize', ()=>{ calibratePx(); setPlayhead(state.playheadSec); });
    log('boot ok • Cloud/Account/Settings wired'); snack('Ready'); logEvent('Boot OK');
  }catch(e){ err('boot failed', e); snack('초기화 오류: 콘솔 확인'); }
});

/////////////////////////////
// 테마/탭
/////////////////////////////
function initTheme(){
  const saved=localStorage.getItem('auditfy.theme'); const follow=localStorage.getItem('auditfy.follow')==='1';
  state.followSystem = !!follow;
  let theme='dark';
  if(state.followSystem){
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
  }else if(saved==='light'||saved==='dark'){ theme=saved; }
  applyTheme(theme);

  const themeSelect=$('#themeSelect'), followBtn=$('#themeFollow');
  if(themeSelect){
    themeSelect.dataset.val=state.theme;
    const lab=themeSelect.querySelector('.sel-label'); if(lab) lab.textContent = state.theme==='dark'?'다크':'라이트';
    themeSelect.addEventListener('click', (e)=>{ themeSelect.classList.toggle('open'); e.stopPropagation(); });
    themeSelect.querySelectorAll('.opt').forEach(opt=>{
      opt.addEventListener('click', (e)=>{
        e.stopPropagation(); state.theme=opt.dataset.val; state.followSystem=false;
        localStorage.setItem('auditfy.theme', state.theme); localStorage.setItem('auditfy.follow','0');
        applyTheme(state.theme); themeSelect.classList.remove('open');
        const l=themeSelect.querySelector('.sel-label'); if(l) l.textContent = state.theme==='dark'?'다크':'라이트';
        if(followBtn) followBtn.classList.remove('on'); snack(`테마: ${state.theme}`);
      });
    });
    document.addEventListener('click', ()=> themeSelect.classList.remove('open'));
  }
  if(followBtn){
    followBtn.classList.toggle('on', state.followSystem);
    followBtn.addEventListener('click', ()=>{
      state.followSystem=!state.followSystem;
      localStorage.setItem('auditfy.follow', state.followSystem?'1':'0');
      if(state.followSystem){
        const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
        const sys = mql && mql.matches ? 'light' : 'dark';
        applyTheme(sys);
        if(themeSelect){ themeSelect.dataset.val=sys; const l=themeSelect.querySelector('.sel-label'); if(l) l.textContent = sys==='dark'?'다크':'라이트'; }
        snack('시스템 설정을 따릅니다');
      }else{ localStorage.setItem('auditfy.theme', state.theme); snack('시스템 설정 반영 해제'); }
      followBtn.classList.toggle('on', state.followSystem);
    });
  }
  const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  if(mql){
    const onChange = (e)=>{ if(state.followSystem){ applyTheme(e.matches?'light':'dark'); snack('시스템 테마 변경'); } };
    if(typeof mql.addEventListener==='function') mql.addEventListener('change', onChange);
    else if(typeof mql.addListener==='function') mql.addListener(onChange);
  }

  bind('#fxResetBtn','click', ()=>{ state.fx=clone(DEFAULT_FX); snack('효과 설정 초기화'); });
}
function applyTheme(theme){ state.theme=theme; document.body.classList.toggle('theme-light', theme==='light'); }
function initTabs(){ $$('.tab').forEach(t=> t.addEventListener('click', ()=> setActiveTab(t.dataset.tab))); setActiveTab(state.activeTab); }
function setActiveTab(name){
  state.activeTab=name; $$('.tab').forEach(t=> t.classList.toggle('active', t.dataset.tab===name));
  $$('.panel').forEach(p=> p.classList.remove('active')); const p=$('#panel-'+name); if(p) p.classList.add('active');
}

/////////////////////////////
// 프로젝트 길이
/////////////////////////////
function getProjectEndSec(){ let end=0; for(const c of state.clips){ const e=c.start + c.duration; if(e>end) end=e; } return end; }

/////////////////////////////
// 룰러/보정
/////////////////////////////
function initRuler(){
  const inner=$('#rulerInner'); if(!inner) return; inner.innerHTML='';
  const totalSec = Math.max(180, Math.ceil(getProjectEndSec()+30));
  for(let s=0;s<=totalSec;s+=5){
    const tick=document.createElement('div');
    tick.className='tick';
    tick.dataset.sec=String(s);
    tick.style.position='absolute'; tick.style.left=(s*state.pxPerSec)+'px';
    tick.style.top='0'; tick.style.bottom='0'; tick.style.borderLeft='1px solid var(--line)';
    const label=document.createElement('div'); label.textContent=s; label.style.position='absolute'; label.style.top='4px'; label.style.left='4px';
    label.style.color='var(--fg-weak)'; label.style.fontSize='12px'; tick.appendChild(label);
    inner.appendChild(tick);
  }
}
function measureEffectivePxPerSec(){
  const ticks = $$('#rulerInner .tick');
  if(ticks.length<2) return state.pxPerSec;
  const a = ticks[0];
  let b = ticks.find(t=> parseFloat(t.dataset.sec)>=60) || ticks[ticks.length-1];
  const sa = parseFloat(a.dataset.sec); const sb = parseFloat(b.dataset.sec);
  if(!isFinite(sa) || !isFinite(sb) || sb<=sa) return state.pxPerSec;
  const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
  const dx = Math.abs(rb.left - ra.left); const ds = (sb - sa);
  const eff = dx / ds;
  return (isFinite(eff) && eff>0.1) ? eff : state.pxPerSec;
}
function calibratePx(){
  const eff = measureEffectivePxPerSec();
  if(Math.abs(eff - state.pxPerSec) > state.pxPerSec*0.01){
    state.pxPerSec = eff;
    initRuler();
    state.clips.forEach(renderClip);
  }
}

/////////////////////////////
// 레이아웃
/////////////////////////////
function resizeTimeline(){
  const tl=$('#timeline'); if(!tl) return;
  const min = Math.max(600, (getProjectEndSec()+10)*state.pxPerSec);
  tl.style.minWidth = min + 'px';
}

function setZoom(pxPerSec){
  const MIN_ZOOM = 10;
  const MAX_ZOOM = 400;
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pxPerSec||MIN_ZOOM));
  state.pxPerSec = next;

  const chip=$('#chipZoom');
  if(chip){
    const pct = Math.round((next/40)*100);
    chip.textContent = `ZOOM ${pct}%`;
  }

  initRuler();
  resizeTimeline();
  state.clips.forEach(renderClip);
  setPlayhead(state.playheadSec);
  calibratePx();
}

/////////////////////////////
// 왼쪽 툴바
/////////////////////////////
function initLeftbar(){
  state.activeTool='select';
  $$('.ltBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $$('.ltBtn').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
      state.activeTool = btn.dataset.tool; snack(`툴: ${state.activeTool}`);
    });
  });
}

/////////////////////////////
// FileHub (드래그&드롭 + 기기/클라우드 불러오기)
/////////////////////////////
function setupFileHubButtons(){
  const btn=$('#btnSourcePicker');
  if(btn && !btn.textContent.trim()) btn.textContent='불러오기';
}
function initFileHub(){
  const addInput = $('#addFilesInput'); const dropZone = $('#dropZone');

  if(addInput){
    addInput.addEventListener('change', async (e)=>{ const files=[...e.target.files]; await addFilesToHub(files); addInput.value=''; });
  }
  if(dropZone){
    ['dragenter','dragover','dragleave','drop'].forEach(ev=> dropZone.addEventListener(ev, (e)=>{ e.preventDefault(); e.stopPropagation(); }));
    dropZone.addEventListener('drop', async (e)=>{ const files=[...e.dataTransfer.files].filter(f=>f.type.startsWith('audio/')); await addFilesToHub(files); });
  }
}

function initSourceModal(){
  bind('#btnSourcePicker','click', ()=> showModal('#sourceModal'));
  bind('#sourceClose','click', ()=> hideModal('#sourceModal'));
  bind('#sourceDevice','click', ()=>{ hideModal('#sourceModal'); $('#addFilesInput')?.click(); });
  bind('#sourceCloud','click', ()=>{ hideModal('#sourceModal'); requireLogin(()=> openCloudPicker({mode:'audio'})); });
  bind('#sourceYoutube','click', ()=>{ hideModal('#sourceModal'); $('#youtubeInput')?.focus(); showModal('#youtubeModal'); });
  bind('#sourceRecord','click', ()=>{ hideModal('#sourceModal'); showModal('#recordModal'); });
  bind('#loginPromptClose','click', ()=> hideModal('#loginRequiredModal'));
  bind('#loginPromptGo','click', ()=> hideModal('#loginRequiredModal'));
}

function initProjectModals(){
  bind('#openBtn','click', ()=> showModal('#projectOpenModal'));
  bind('#openModalClose','click', ()=> hideModal('#projectOpenModal'));
  bind('#openFromDevice','click', ()=>{ hideModal('#projectOpenModal'); $('#openProjectInput')?.click(); });
  bind('#openFromCloud','click', ()=>{ hideModal('#projectOpenModal'); requireLogin(()=> openCloudPicker({mode:'project'})); });

  bind('#saveBtn','click', ()=> showModal('#projectSaveModal'));
  bind('#saveModalClose','click', ()=> hideModal('#projectSaveModal'));
  bind('#saveJsonLocal','click', ()=>{ hideModal('#projectSaveModal'); saveProjectToJson(); });
  bind('#saveZipLocal','click', ()=>{ hideModal('#projectSaveModal'); saveProjectToZip(); });
  bind('#saveToRepo','click', ()=>{
    hideModal('#projectSaveModal');
    if(!requireLogin(()=> uploadProjectToRepo())){
      return;
    }
  });
}

function initYouTubeTools(){
  bind('#youtubeCancel','click', ()=>{ hideModal('#youtubeModal'); const inp=$('#youtubeInput'); if(inp) inp.value=''; });
  bind('#youtubeImport','click', async ()=>{
    const inp=$('#youtubeInput');
    const url=inp?.value.trim();
    if(!url){ snack('YouTube URL을 입력하세요'); return; }
    await importFromYouTube(url);
  });
  const ytInput=$('#youtubeInput');
  if(ytInput){
    ytInput.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){ e.preventDefault(); $('#youtubeImport')?.click(); }
    });
  }
}

function initRecorderControls(){
  bind('#recordStart','click', startRecording);
  bind('#recordStop','click', stopRecording);
  bind('#recordClose','click', ()=>{ hideModal('#recordModal'); if(recorderState.recorder){ stopRecording(); } });
  const modal=$('#recordModal');
  if(modal){
    modal.addEventListener('transitionend', ()=>{ if(!modal.classList.contains('open') && recorderState.recorder){ stopRecording(); } });
  }
}

async function startRecording(){
  if(recorderState.recorder){ snack('이미 녹음 중입니다'); return; }
  if(!(navigator.mediaDevices?.getUserMedia)){ snack('이 브라우저에서는 녹음을 지원하지 않습니다'); return; }
  try{
    const preview=$('#recordPreview');
    if(preview){ preview.pause(); preview.removeAttribute('src'); preview.style.display='none'; }
    const mimeCandidates=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm'];
    let mime = '';
    if(window.MediaRecorder?.isTypeSupported){ mime = mimeCandidates.find(t=> MediaRecorder.isTypeSupported(t)) || ''; }
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    const recorder = mime ? new MediaRecorder(stream, {mimeType:mime}) : new MediaRecorder(stream);
    recorderState.stream = stream;
    recorderState.recorder = recorder;
    recorderState.chunks = [];
    recorder.ondataavailable = (e)=>{ if(e.data && e.data.size){ recorderState.chunks.push(e.data); } };
    recorder.onstop = handleRecordingStop;
    recorder.start();
    recorderState.start = Date.now();
    clearInterval(recorderState.timer);
    recorderState.timer = setInterval(updateRecordTimer, 200);
    updateRecordUI(true);
    snack('녹음을 시작했습니다');
  }catch(e){
    err('record start failed', e);
    snack('마이크 권한을 확인하세요');
    resetRecorderState();
  }
}

function updateRecordTimer(){
  if(!recorderState.recorder) return;
  const timer=$('#recordTimer');
  if(!timer) return;
  const sec = Math.floor((Date.now() - (recorderState.start||Date.now()))/1000);
  const mm = String(Math.floor(sec/60)).padStart(2,'0');
  const ss = String(sec%60).padStart(2,'0');
  timer.textContent = `${mm}:${ss}`;
}

function updateRecordUI(isRecording){
  const statusEl=$('#recordStatus');
  const dot=statusEl?.querySelector('.dot');
  const txt=statusEl?.querySelector('span');
  if(statusEl){ statusEl.classList.toggle('off', !isRecording); }
  if(dot){ dot.style.background = isRecording ? 'var(--danger)' : 'var(--fg-weak)'; }
  if(txt){ txt.textContent = isRecording ? '녹음 중' : '대기 중'; }
  const startBtn=$('#recordStart'); if(startBtn) startBtn.disabled = !!isRecording;
  const stopBtn=$('#recordStop'); if(stopBtn) stopBtn.disabled = !isRecording;
  if(!isRecording){
    const timer=$('#recordTimer'); if(timer) timer.textContent='00:00';
    clearInterval(recorderState.timer); recorderState.timer=null;
  }
}

function resetRecorderState(){
  updateRecordUI(false);
  if(recorderState.stream){ recorderState.stream.getTracks().forEach(t=> t.stop()); }
  recorderState.stream=null; recorderState.recorder=null; recorderState.chunks=[];
  clearInterval(recorderState.timer); recorderState.timer=null;
}

async function handleRecordingStop(){
  const stopBtn=$('#recordStop'); if(stopBtn) stopBtn.disabled=true;
  clearInterval(recorderState.timer); recorderState.timer=null;
  updateRecordUI(false);
  if(recorderState.stream){ recorderState.stream.getTracks().forEach(t=> t.stop()); }
  const chunks=recorderState.chunks.slice();
  recorderState.chunks=[];
  const recorder=recorderState.recorder;
  recorderState.recorder=null; recorderState.stream=null;

  if(!chunks.length){ snack('녹음된 데이터가 없습니다'); return; }
  const mime = recorder?.mimeType || chunks[0].type || 'audio/webm';
  const blob = new Blob(chunks, {type:mime});
  const stamp=new Date();
  const name=`auditfy_record_${stamp.getFullYear()}${String(stamp.getMonth()+1).padStart(2,'0')}${String(stamp.getDate()).padStart(2,'0')}_${String(stamp.getHours()).padStart(2,'0')}${String(stamp.getMinutes()).padStart(2,'0')}${String(stamp.getSeconds()).padStart(2,'0')}.webm`;
  const file=new File([blob], name, {type:mime});
  await addFilesToHub([file]);
  const preview=$('#recordPreview');
  if(preview){
    preview.style.display='block';
    preview.src = URL.createObjectURL(blob);
    preview.onended = ()=> URL.revokeObjectURL(preview.src);
  }
  snack('녹음 파일을 FileHub에 추가했습니다');
  logEvent('Record capture');
}

function stopRecording(){
  if(!recorderState.recorder){ snack('녹음 중이 아닙니다'); return; }
  const txt=$('#recordStatus span'); if(txt) txt.textContent='처리 중...';
  const stopBtn=$('#recordStop'); if(stopBtn) stopBtn.disabled=true;
  try{ recorderState.recorder.stop(); }
  catch(e){ err('record stop fail', e); resetRecorderState(); }
}

async function importFromYouTube(url){
  const videoId = extractYouTubeId(url);
  if(!videoId){ snack('유효한 YouTube URL을 입력하세요'); return; }
  try{
    showLoading(true);
    const metaResp = await fetch(`${YT_STREAM_ENDPOINT}${videoId}`);
    if(!metaResp.ok) throw new Error(`meta http ${metaResp.status}`);
    const meta = await metaResp.json();
    const streams = Array.isArray(meta.audioStreams) ? meta.audioStreams.slice() : [];
    if(!streams.length) throw new Error('audio stream not found');
    streams.sort((a,b)=> (parseInt(b.bitrate||0,10)||0) - (parseInt(a.bitrate||0,10)||0));
    const pick = streams.find(s=> s.url) || streams[0];
    const audioResp = await fetch(pick.url);
    if(!audioResp.ok) throw new Error(`audio http ${audioResp.status}`);
    const blob = await audioResp.blob();
    const titleBase = (meta.title || `youtube_${videoId}`).replace(/[\\/:*?"<>|]+/g,'_').substring(0,60) || `youtube_${videoId}`;
    const extFromMime = (pick.mimeType || blob.type || '').split(/[;/]/)[1] || (pick.container ? pick.container.replace(/^[.]/,'') : 'webm');
    const ext = (extFromMime || 'webm').replace(/[^a-z0-9]/ig,'');
    const fileName = `${titleBase}.${ext}`;
    const file = new File([blob], fileName, {type: blob.type || pick.mimeType || 'audio/webm'});
    await addFilesToHub([file]);
    const inp=$('#youtubeInput'); if(inp) inp.value='';
    hideModal('#youtubeModal');
    snack('YouTube 오디오를 추가했습니다');
    logEvent(`YouTube import ${videoId}`);
  }catch(e){
    err('youtube import failed', e);
    snack('YouTube에서 불러오지 못했습니다');
  }finally{ showLoading(false); }
}

function extractYouTubeId(input){
  if(!input) return '';
  const trimmed=input.trim();
  if(/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try{
    const url=new URL(trimmed);
    if(url.hostname.includes('youtu.be')) return url.pathname.replace(/^\//,'').slice(0,11);
    if(url.searchParams.has('v')) return url.searchParams.get('v').slice(0,11);
  }catch{}
  const match = trimmed.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : '';
}
async function addFilesToHub(files){
  if(!files || !files.length){ snack('오디오 파일이 아닙니다'); return []; }
  const list = $('#fhList'); if(!list) return [];
  const added=[];
  for(const f of files){
    const id='f'+Math.random().toString(36).slice(2,8); const url=URL.createObjectURL(f); const audio=new Audio(url);
    const buf = await fileToBuffer(f).then(decodeBuffer).catch(e=>{ err('decode fail',e); return null; });
    const duration = buf ? buf.duration : 10;
    const wave = buf ? buildWaveform(buf) : null;
    const rec = {id,name:f.name,file:f,url,audio,buffer:buf,duration,wave}; state.files.push(rec);
    added.push(rec);

    const trashSVG = `
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;

    const item=document.createElement('div'); item.className='fh-item'; item.setAttribute('draggable','true'); item.dataset.id=rec.id;
    item.innerHTML=`
      <svg class="ic" viewBox="0 0 24 24"><path d="M8 6v10M12 6v8M16 6v12"/></svg>
      <div class="name">${f.name}</div><div class="sp"></div>
      <button class="fh-del" title="삭제" aria-label="삭제">${trashSVG}</button>`;
    item.addEventListener('dragstart', ev=> ev.dataTransfer.setData('text/plain', rec.id));
    item.querySelector('.fh-del').addEventListener('click', async (ev)=>{
      ev.stopPropagation();
      const ok = await confirmModal(`"${rec.name}" 파일과 타임라인의 관련 클립을 삭제할까요?`);
      if(!ok) return;
      state.clips = state.clips.filter(c=> c.fileId!==rec.id);
      $('#clips').innerHTML = '<div id="markers"></div><div id="playhead"></div>';
      state.clips.forEach(renderClip);
      state.files = state.files.filter(x=> x.id!==rec.id);
      URL.revokeObjectURL(rec.url);
      item.remove();
      updateTotalLen(); initRuler(); calibratePx(); resizeTimeline(); snack('파일 삭제됨');
      state.dirty=true;
    });
    list.appendChild(item);
  }
  snack(`${files.length}개 추가됨`); logEvent(`File added x${files.length}`);
  state.dirty=true;
  return added;
}

/////////////////////////////
// 좌표 계산/드래그
/////////////////////////////
function toSecOnTimeline(clientX){
  const wrap = $('#laneWrap'); const r = wrap.getBoundingClientRect();
  return Math.max(0, (clientX - r.left + wrap.scrollLeft) / state.pxPerSec);
}
function toSecOnRuler(clientX){
  const wrap = $('#laneWrap'); const r = $('#ruler').getBoundingClientRect();
  return Math.max(0, (clientX - r.left + wrap.scrollLeft) / state.pxPerSec);
}
function initTimelineDrag(){
  const timeline=$('#timeline'); if(!timeline) return;
  timeline.addEventListener('mousedown', (e)=>{
    if(e.target.closest('.clip')) return;
    setPlayhead(toSecOnTimeline(e.clientX));
    const mm=(ev)=> setPlayhead(toSecOnTimeline(ev.clientX));
    const up=()=>{ window.removeEventListener('mousemove',mm); window.removeEventListener('mouseup',up); };
    window.addEventListener('mousemove',mm); window.addEventListener('mouseup',up);
  });
}
function initRulerDrag(){
  const r=$('#ruler'); if(!r) return;
  r.addEventListener('mousedown',(e)=>{
    setPlayhead(toSecOnRuler(e.clientX));
    const mm=(ev)=> setPlayhead(toSecOnRuler(ev.clientX));
    const up=()=>{ window.removeEventListener('mousemove',mm); window.removeEventListener('mouseup',up); };
    window.addEventListener('mousemove',mm); window.addEventListener('mouseup',up);
  });
}

/////////////////////////////
// 타임라인 DnD/스크롤
/////////////////////////////
function initDnDToTimeline(){
  const timeline=$('#timeline'); if(!timeline) return;
  timeline.addEventListener('dragover', e=> e.preventDefault());
  timeline.addEventListener('drop', e=>{
    e.preventDefault();
    const fileId = e.dataTransfer.getData('text/plain'); const rec = state.files.find(f=>f.id===fileId);
    if(!rec){ snack('알 수 없는 파일'); return; }
    const laneWrap = $('#laneWrap'); const lwRect = laneWrap.getBoundingClientRect();
    const y = e.clientY - lwRect.top + laneWrap.scrollTop;
    const track=Math.max(0, Math.min(state.tracks-1, Math.floor((y-6)/56)));
    const timelineRect = timeline.getBoundingClientRect();
    const rawSec = (e.clientX - timelineRect.left + laneWrap.scrollLeft) / state.pxPerSec;
    let startSec = Math.max(0, state.snap ? Math.round(rawSec*2)/2 : rawSec);
    const trackEmpty = !state.clips.some(c=> c.track===track);
    if(trackEmpty) startSec = 0;
    const newClip = addClip({fileId:rec.id, track, start:startSec, duration:Math.max(1, rec.duration||10)});
    if(newClip) setPlayhead(startSec);
  });
}
function initWheelScroll(){
  const wrap=$('#laneWrap'); if(!wrap) return;
  wrap.addEventListener('wheel', (e)=>{
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    wrap.scrollLeft += dx;
    e.preventDefault();
  }, {passive:false});
}

/////////////////////////////
// 클립
/////////////////////////////
function addClip({fileId, track, start, duration}){
  const id='c'+Math.random().toString(36).slice(2,8);
  const color=pickColor();
  const clip=ensureClipDefaults({id,fileId,track,start,duration,color,fadeIn:0,fadeOut:0,gain:1,pan:0,hpf:0,chorus:false,phaseInvert:false});
  state.clips.push(clip); renderClip(clip); updateTotalLen(); initRuler(); calibratePx(); resizeTimeline(); snack('클립 추가'); logEvent(`Clip add ${clip.id}`);
  state.dirty=true;
  return clip;
}

function ensureClipDefaults(clip){
  if(!clip) return clip;
  if(typeof clip.fadeIn!=='number') clip.fadeIn=0;
  if(typeof clip.fadeOut!=='number') clip.fadeOut=0;
  if(typeof clip.gain!=='number' || !isFinite(clip.gain)) clip.gain=1;
  if(typeof clip.pan!=='number' || !isFinite(clip.pan)) clip.pan=0;
  if(typeof clip.hpf!=='number' || !isFinite(clip.hpf)) clip.hpf=0;
  clip.chorus = !!clip.chorus;
  clip.phaseInvert = !!clip.phaseInvert;
  if(typeof clip.duration!=='number' || !isFinite(clip.duration)) clip.duration=1;
  return clip;
}
function renderClip(clip){
  ensureClipDefaults(clip);
  const rec=state.files.find(f=>f.id===clip.fileId); const elOld=$('#'+clip.id); if(elOld) elOld.remove();
  const el=document.createElement('div'); el.className='clip'; el.id=clip.id;
  const widthPx = Math.max(24, clip.duration*state.pxPerSec);
  el.style.left=(clip.start*state.pxPerSec)+'px'; el.style.top=(clip.track*56 + 6)+'px';
  el.style.width=widthPx+'px';
  el.style.background=`linear-gradient(90deg, ${clip.color}bb, ${clip.color})`;
  el.innerHTML=`<div class="hL" data-h="L"></div><div class="label">${rec?rec.name:'(clip)'}</div><div class="hR" data-h="R"></div>`;
  const clipsWrap=$('#clips'); if(!clipsWrap) return; clipsWrap.appendChild(el);

  const canvas=document.createElement('canvas'); canvas.className='clipWave';
  canvas.width = Math.max(16, Math.floor(widthPx));
  canvas.height = 36;
  const labelEl=el.querySelector('.label');
  if(labelEl) el.insertBefore(canvas, labelEl);
  drawClipWaveform(canvas, clip);

  el.addEventListener('mousedown', ()=>{ state.selClip=clip.id; drawXray(clip); });

  el.addEventListener('mousedown', (e)=>{
    e.stopPropagation();
    if(state.activeTool==='erase'){ confirmDeleteClip(clip); return; }
    if(state.activeTool==='cut' && !e.target.dataset.h){ splitClipAtPlayhead(clip); return; }

    const sx=e.clientX, sy=e.clientY;
    const baseStart=clip.start, baseTrack=clip.track, baseDur=clip.duration;
    const isL=e.target.dataset.h==='L', isR=e.target.dataset.h==='R';
    const laneWrap=$('#laneWrap');

    const mm=(ev)=>{
      const dx=ev.clientX - sx; const dy=ev.clientY - sy;
      if(isL){
        let ns = baseStart + dx/state.pxPerSec; ns=Math.max(0, Math.min(ns, baseStart+baseDur-0.2));
        let nd = baseDur - (ns-baseStart); if(state.snap){ ns=Math.round(ns*2)/2; nd=Math.round(nd*2)/2; }
        clip.start=ns; clip.duration=nd;
      }else if(isR){
        let nd = baseDur + dx/state.pxPerSec; nd=Math.max(0.2, nd); if(state.snap) nd=Math.round(nd*2)/2; clip.duration=nd;
      }else{
        if(state.activeTool!=='move' && state.activeTool!=='select') return;
        let ns = baseStart + (dx + (laneWrap.scrollLeft - (laneWrap._scrollStart||0)))/state.pxPerSec;
        if(state.snap) ns=Math.round(ns*2)/2; clip.start=Math.max(0,ns);
        const lwRect=laneWrap.getBoundingClientRect(); const y=(sy + dy) - lwRect.top + laneWrap.scrollTop;
        let t=Math.max(0, Math.floor((y-6)/56)); t=Math.min(state.tracks-1, t); clip.track=t;
      }
      renderClip(clip); updateTotalLen(); drawXray(clip);
      state.dirty=true;
    };
    const up=()=>{ window.removeEventListener('mousemove',mm); window.removeEventListener('mouseup',up); };
    laneWrap._scrollStart = laneWrap.scrollLeft;
    window.addEventListener('mousemove',mm); window.addEventListener('mouseup',up);
  });

  el.addEventListener('contextmenu', (e)=>{
    e.preventDefault(); state.selClip=clip.id; drawXray(clip);
    openClipMenu(e.clientX, e.clientY, clip);
  });
}
function confirmDeleteClip(clip){
  confirmModal(`"${clip.id}" 삭제할까요?`).then(ok=>{
    if(!ok) return; state.clips = state.clips.filter(c=>c.id!==clip.id); $('#'+clip.id)?.remove();
    updateTotalLen(); resizeTimeline(); snack('삭제됨'); logEvent(`Clip del ${clip.id}`); state.dirty=true;
  });
}
function splitClipAtPlayhead(clip){
  const rel = state.playheadSec - clip.start;
  if(rel<=0 || rel>=clip.duration){ snack('플레이헤드가 클립 범위 밖'); return; }
  const leftDur=rel, rightDur=clip.duration - rel;
  clip.duration=leftDur; renderClip(clip);
  const right=ensureClipDefaults({...clip, id:'c'+Math.random().toString(36).slice(2,8), start:clip.start+leftDur, duration:rightDur});
  state.clips.push(right); renderClip(right); snack('분할됨'); updateTotalLen(); resizeTimeline(); logEvent(`Clip split ${clip.id}`); state.dirty=true;
}
function duplicateClip(clip){
  const dup=ensureClipDefaults({...clip, id:'c'+Math.random().toString(36).slice(2,8), start:clip.start+clip.duration+0.1});
  state.clips.push(dup); renderClip(dup); updateTotalLen(); resizeTimeline(); snack('복제됨'); logEvent(`Clip dup ${clip.id}`); state.dirty=true;
}

/////////////////////////////
// 컨텍스트 메뉴
/////////////////////////////
function initContextMenu(){
  document.addEventListener('click', ()=> $('#clipMenu')?.classList.remove('open'));
  const menu=$('#clipMenu');
  if(menu){
    menu.addEventListener('click', (e)=>{
      const act=e.target.dataset.act; const clip=state.clips.find(c=> c.id===state.selClip); if(!clip) return;
      if(act==='dup') duplicateClip(clip);
      if(act==='split') splitClipAtPlayhead(clip);
      if(act==='del') confirmDeleteClip(clip);
      menu.classList.remove('open');
    });
  }
}
function openClipMenu(x,y){ const menu=$('#clipMenu'); if(!menu) return; menu.style.left=x+'px'; menu.style.top=y+'px'; menu.classList.add('open'); }

/////////////////////////////
// 편집/도구 (+ 검사/정리)
/////////////////////////////
let clipboardClip=null;
function initEditOps(){
  bind('#btnSplit','click', ()=>{
    if(!state.selClip){ snack('선택 없음'); return; }
    const c=state.clips.find(x=>x.id===state.selClip); if(c) splitClipAtPlayhead(c);
  });
  bind('#btnAlign','click', ()=>{
    if(!state.selClip){ snack('선택 없음'); return; }
    const c=state.clips.find(x=>x.id===state.selClip); if(!c) return;
    c.start = state.snap ? Math.round(state.playheadSec*2)/2 : state.playheadSec; renderClip(c); updateTotalLen(); resizeTimeline(); snack('커서 정렬'); state.dirty=true;
  });
  bind('#btnCut','click', ()=>{
    if(!state.selClip){ snack('선택 없음'); return; }
    const c=state.clips.find(x=>x.id===state.selClip); if(!c) return;
    const rel=state.playheadSec - c.start; if(rel<=0||rel>=c.duration){ snack('커서 밖'); return; }
    const rightDur=c.duration-rel; c.start=state.playheadSec; c.duration=rightDur; renderClip(c); updateTotalLen(); resizeTimeline(); snack('왼쪽 잘라내기'); state.dirty=true;
  });
  bind('#btnCopy','click', ()=>{ if(!state.selClip){ snack('선택 없음'); return; } clipboardClip = clone(state.clips.find(c=>c.id===state.selClip)); snack('복사됨'); });
  bind('#btnPaste','click', ()=>{
    if(!clipboardClip){ snack('클립보드 비어있음'); return; }
    const nc=ensureClipDefaults({...clipboardClip, id:'c'+Math.random().toString(36).slice(2,8), start:state.playheadSec});
    state.clips.push(nc); renderClip(nc); updateTotalLen(); resizeTimeline(); snack('붙여넣기'); state.dirty=true;
  });
  bind('#btnXFade','click', ()=>{
    if(!state.selClip){ snack('선택 없음'); return; }
    const c=state.clips.find(x=>x.id===state.selClip); if(!c) return;
    c.fadeIn=Math.min(2,c.fadeIn+.5); c.fadeOut=Math.min(2,c.fadeOut+.5); snack(`페이드 In/Out: ${c.fadeIn}/${c.fadeOut}`); state.dirty=true;
  });

  // level/effects
  bind('#btnAutoLoud','click', ()=> showModal('#levelModal'));
  bind('#btnPeakNorm','click', ()=> showModal('#peakModal'));
  stepperInit('#lvTarget', state.fx.targetRMS, (v)=> state.fx.targetRMS=v);
  stepperInit('#pkCeil', state.fx.peakCeil, (v)=> state.fx.peakCeil=v);
  toggleInit('#autoLevelOn', state.fx.autoLevel, (on)=> state.fx.autoLevel=on);
  toggleInit('#peakNormOn', state.fx.peakNorm, (on)=> state.fx.peakNorm=on);
  bind('#btnLevelAll','click', applyAutoLevelAll);
  bind('#btnPeakAll','click', applyPeakNormalizeAll);

  bind('#btnGainMatch','click', ()=>{
    if(!state.selClip){ snack('선택 없음'); return; }
    const c=state.clips.find(x=>x.id===state.selClip); const rec=getRec(c); if(!c||!rec||!rec.buffer){ snack('버퍼 없음'); return; }
    const rms = calcRMS(rec.buffer, c.start, c.duration);
    const allRMS = avgRMSProject();
    const g = (allRMS>1e-6) ? (allRMS / Math.max(rms,1e-6)) : 1;
    c.gain = g; snack(`게인 매치: x${g.toFixed(2)}`); state.dirty=true;
  });
  bind('#btnGate','click', ()=>{
    if(!state.selClip){ snack('선택 없음'); return; }
    const c=state.clips.find(x=>x.id===state.selClip); const rec=getRec(c); if(!c||!rec||!rec.buffer){ snack('버퍼 없음'); return; }
    const {lead,tail}=detectSilence(rec.buffer, c.start, c.duration, 0.02);
    c.start += lead; c.duration = Math.max(0.2, c.duration - lead - tail);
    renderClip(c); updateTotalLen(); resizeTimeline(); snack(`무음 트림: +${lead.toFixed(2)}s / -${tail.toFixed(2)}s`); state.dirty=true;
  });

  bind('#btnPan','click', openPanModal);
  bind('#btnHPF','click', openHpfModal);
  bind('#btnPhase','click', togglePhaseInvert);
  bind('#btnChorus','click', toggleChorus);

  // transport / zoom / snap / tracks
  bind('#btnPlay','click', playPause); bind('#stopBtn','click', stopPlay);
  bind('#btnLoop','click', ()=>{ state.loop=!state.loop; snack(`루프 ${state.loop?'On':'Off'}`); });
  bind('#zoomIn','click', ()=> setZoom(state.pxPerSec+10)); bind('#zoomOut','click', ()=> setZoom(Math.max(10,state.pxPerSec-10)));
  bind('#btnSnap','click', ()=>{ state.snap=!state.snap; $('#snapState') && ($('#snapState').textContent=state.snap?'켜짐':'꺼짐'); });

  bind('#addTrackBtn','click', ()=>{ state.tracks++; initTracks(state.tracks); snack('트랙 추가'); state.dirty=true; });
  bind('#delTrackBtn','click', async ()=>{
    if(state.tracks<=1){ snack('최소 1개 필요'); return; }
    const last = state.tracks-1; const has = state.clips.some(c=>c.track===last);
    if(has){
      const ok = await confirmModal(`Track ${state.tracks} 를 삭제하면 해당 트랙의 클립도 삭제됩니다. 진행할까요?`);
      if(!ok) return;
      state.clips = state.clips.filter(c=> c.track!==last);
      const clipsWrap=$('#clips'); if(clipsWrap) clipsWrap.innerHTML='<div id="markers"></div><div id="playhead"></div>';
      state.clips.forEach(renderClip);
    }
    state.tracks--; initTracks(state.tracks); snack('트랙 제거'); state.dirty=true;
  });

  bind('#btnMark','click', ()=> addMarkerAt(state.playheadSec));

  // 오디오 검사/파일 정리
  bind('#btnAudit','click', runAudioAudit);
  bind('#btnCleanup','click', cleanupUnusedFiles);
}
function addMarkerAt(sec){
  const x=sec*state.pxPerSec; const m=document.createElement('div'); m.className='marker'; m.style.left=x+'px';
  const clipsWrap=$('#clips'); if(!clipsWrap) return; clipsWrap.appendChild(m);
  const cnt=$$('.marker').length; const mc=$('#markerCount'); if(mc) mc.textContent=String(cnt); snack(`마커 #${cnt} 추가`);
  state.dirty=true;
}

/////////////////////////////
// QuickEdit
/////////////////////////////
function initQuickEdit(){
  bind('#btnQuickEdit','click', openQuickEdit);
  bind('#qeCancel','click', ()=> hideModal('#quickEditModal'));
  bind('#qeApply','click', applyQuickEdit);
  bind('#qeSelectAll','click', ()=>{
    const any=!!$('#qeList .qe-item:not(.active)'); $$('#qeList .qe-item').forEach(el=> el.classList.toggle('active', any));
    updateQeCount();
  });
  sliderInit('#qeXfade'); stepperInit('#qeLevelTarget', state.fx.targetRMS, (v)=> state.fx.targetRMS=v);
  toggleInit('#qeAutoLevel', state.fx.autoLevel, (on)=> state.fx.autoLevel=on);
  toggleInit('#qeClear', true);
}
function updateQeCount(){
  const cnt=$$('#qeList .qe-item.active').length; const el=$('#qeCount'); if(el) el.textContent=`선택 ${cnt}`;
}
function openQuickEdit(){
  const list=$('#qeList'); if(!list) return; list.innerHTML='';
  state.files.forEach(f=>{
    const row=document.createElement('div'); row.className='fh-item qe-item'; row.draggable=true; row.dataset.id=f.id;
    row.innerHTML=`<svg class="ic" viewBox="0 0 24 24"><path d="M8 6v10M12 6v8M16 6v12"/></svg><div class="name">${f.name}</div>`;
    row.addEventListener('click', ()=>{ row.classList.toggle('active'); updateQeCount(); });
    row.addEventListener('dragstart', ev=>{ ev.dataTransfer.setData('text/plain', f.id); row.classList.add('dragging'); });
    row.addEventListener('dragend', ()=> row.classList.remove('dragging'));
    list.appendChild(row);
  });
  list.addEventListener('dragover', e=>{
    e.preventDefault(); const dragging=list.querySelector('.dragging'); if(!dragging) return;
    const after=getDragAfterElement(list, e.clientY); if(after==null) list.appendChild(dragging); else list.insertBefore(dragging, after);
  });
  updateQeCount();
  showModal('#quickEditModal');
}
function getDragAfterElement(container,y){
  const els=[...container.querySelectorAll('.qe-item:not(.dragging)')];
  return els.reduce((closest,child)=>{ const box=child.getBoundingClientRect(); const off=y-(box.top+box.height/2);
    if(off<0 && off>closest.offset) return {offset:off, element:child}; return closest; }, {offset:-Infinity}).element;
}
function applyQuickEdit(){
  const sel=$$('#qeList .qe-item.active'); if(!sel.length){ snack('선택된 파일이 없습니다'); return; }
  const clear=$('#qeClear')?.classList.contains('on'); const xfade=sliderVal('#qeXfade'); const autoL=$('#qeAutoLevel')?.classList.contains('on');
  if(clear){ state.clips=[]; const clipsWrap=$('#clips'); if(clipsWrap) clipsWrap.innerHTML='<div id="markers"></div><div id="playhead"></div>'; }
  let t=0; const track=0;
  sel.forEach((el,i)=>{
    const fid=el.dataset.id; const rec=state.files.find(f=> f.id===fid); const dur=Math.max(1,(rec?.duration||10));
    const start=Math.max(0, t - (i>0?xfade:0)); const clip={fileId:fid, track, start, duration:dur};
    addClip(clip); const c=state.clips[state.clips.length-1]; const fade=xfade>0?xfade/2:0; c.fadeIn=fade; c.fadeOut=fade;
    if(autoL){ const rms = rec?.buffer ? calcRMS(rec.buffer,0,rec.buffer.duration) : 0.2; c.gain = (state.fx.targetRMS/Math.max(rms,1e-6)); }
    t = start + dur;
  });
  hideModal('#quickEditModal'); setActiveTab('home'); snack(`QuickEdit 적용(전환 ${xfade}s, ${sel.length}개)`); state.dirty=true;
}

/////////////////////////////
// 슬라이더/스테퍼/토글
/////////////////////////////
function sliderInit(sel){
  const root=$(sel); if(!root) return;
  const min=parseFloat(root.dataset.min), max=parseFloat(root.dataset.max), step=parseFloat(root.dataset.step);
  let val=parseFloat(root.dataset.val); const track=root.querySelector('.track'), bar=root.querySelector('.bar'), knob=root.querySelector('.knob'), label=root.querySelector('.val');
  const update=()=>{ const pct=(val-min)/(max-min); if(bar) bar.style.width=(pct*100)+'%'; if(knob) knob.style.left=`calc(${pct*100}% - 11px)`; if(label) label.textContent=(step%1)?val.toFixed(1):String(val); root.dataset.val=val; };
  const onPos=(clientX)=>{ const r=track.getBoundingClientRect(); const pct=Math.min(1,Math.max(0,(clientX-r.left)/r.width));
    let v=min + pct*(max-min); v=Math.round(v/step)*step; val=Math.min(max,Math.max(min,v)); update(); };
  track.addEventListener('mousedown',(e)=>{ onPos(e.clientX); const mm=(ev)=>onPos(ev.clientX); const up=()=>{window.removeEventListener('mousemove',mm); window.removeEventListener('mouseup',up);};
    window.addEventListener('mousemove',mm); window.addEventListener('mouseup',up); });
  update();
}
function sliderVal(sel){ const r=$(sel); return r?parseFloat(r.dataset.val)||0:0; }
function stepperInit(sel, initial, onChange){
  const root=$(sel); if(!root) return; const step=parseFloat(root.dataset.step)||0.05;
  const min=parseFloat(root.dataset.min); const max=parseFloat(root.dataset.max);
  const valEl=root.querySelector('.val'); let v=(initial!=null?initial:parseFloat(valEl?.textContent)||0);
  const clamp=(val)=>{
    let x=val;
    if(!isNaN(min)) x=Math.max(min,x);
    if(!isNaN(max)) x=Math.min(max,x);
    return x;
  };
  const fmt=(val)=> Math.abs(step)<1 ? clamp(val).toFixed(2) : String(Math.round(clamp(val)));
  const render=(trigger=true)=>{
    v = clamp(v);
    if(valEl) valEl.textContent = fmt(v);
    if(trigger && onChange) onChange(v);
  };
  root.querySelectorAll('button').forEach(btn=> btn.addEventListener('click', ()=>{ v += (btn.dataset.d==='+1'?step:-step); render(true); }));
  root._setValue = (nv)=>{ v = nv; render(true); };
  root._setValueSilent = (nv)=>{ v = nv; render(false); };
  root._getValue = ()=> clamp(v);
  render(false);
}
function toggleInit(sel, def=false, onChange){
  const el=$(sel); if(!el) return; if(def) el.classList.add('on');
  el.addEventListener('click', ()=>{ el.classList.toggle('on'); if(onChange) onChange(el.classList.contains('on')); });
}

function stepperSetValue(sel, value, silent=false){
  const root=$(sel);
  if(!root) return;
  if(silent && typeof root._setValueSilent==='function'){ root._setValueSilent(value); }
  else if(typeof root._setValue==='function'){ root._setValue(value); }
}

function stepperGetValue(sel){
  const root=$(sel);
  if(!root) return 0;
  if(typeof root._getValue==='function') return root._getValue();
  const val=parseFloat(root.querySelector('.val')?.textContent||'0');
  return isNaN(val)?0:val;
}

/////////////////////////////
// 상단바/도크/홈 네비
/////////////////////////////
function initTopbar(){
  const settingsDock=$('#settingsDock'), accountDock=$('#accountDock'), avatar=$('#avatar'), settingsBtn=$('#settingsBtn');
  if(settingsBtn) settingsBtn.addEventListener('click',(e)=>{ e.stopPropagation(); renderAccountDock(false); accountDock?.classList.remove('open'); settingsDock?.classList.toggle('open'); });
  // 아바타: 확실한 토글 로직
  if(avatar) avatar.addEventListener('click',(e)=>{
    e.stopPropagation();
    $('#settingsDock')?.classList.remove('open');
    if (accountDock?.classList.contains('open')) {
      accountDock.classList.remove('open');
    } else {
      renderAccountDock();                 // 최신 세션 반영
      accountDock?.classList.add('open');  // 열기
    }
  });
  document.addEventListener('click',(e)=>{
    if(settingsDock && !settingsDock.contains(e.target) && !settingsBtn?.contains(e.target)) settingsDock.classList.remove('open');
    if(accountDock && !accountDock.contains(e.target) && !avatar?.contains(e.target)) accountDock.classList.remove('open');
  });

  bind('#renameBtn','click', ()=>{
    $('#renameInput').value = state.projectTitle || 'Untitled';
    showModal('#renameModal');
  });
  bind('#renameCancel','click', ()=> hideModal('#renameModal'));
  bind('#renameOk','click', ()=>{
    const val = $('#renameInput').value.trim();
    updateProjectTitle(val);
    snack('프로젝트명 변경');
    state.dirty=true;
    hideModal('#renameModal');
  });

  bind('#newBtn','click', async ()=>{
    if(state.clips.length && !(await confirmModal('현재 편집 내용을 삭제하고 새 프로젝트를 시작할까요?'))) return;
    state.clips=[]; const clipsWrap=$('#clips'); if(clipsWrap) clipsWrap.innerHTML='<div id="markers"></div><div id="playhead"></div>'; setPlayhead(0); updateTotalLen(); initRuler(); calibratePx(); resizeTimeline(); snack('새 프로젝트');
    state.dirty=false;
  });
  bind('#openProjectInput','change', async (e)=>{
    const f=e.target.files[0]; if(!f) return;
    if(f.name.toLowerCase().endsWith('.zip')){ await importProjectZip(f); }
    else{ const js=JSON.parse(await (new Response(f)).text()); loadProjectJSON(js); }
    e.target.value=''; state.dirty=false;
  });
  bind('#exportBtn','click', ()=> showModal('#exportModal'));

  bind('#btnHome','click', async ()=>{
    if(state.dirty){
      const ok=await confirmModal('저장되지 않은 변경 사항이 있습니다. 프로젝트 목록으로 이동할까요?'); if(!ok) return;
    }
    location.href='/projects.html';
  });
}

function getSelectedClip(showSnack=true){
  if(!state.selClip){ if(showSnack) snack('선택 없음'); return null; }
  const clip=state.clips.find(c=> c.id===state.selClip);
  if(!clip && showSnack) snack('선택 없음');
  return clip ? ensureClipDefaults(clip) : null;
}

function applyAutoLevelAll(){
  const target = state.fx.targetRMS || 0.2;
  let touched=0;
  for(const clip of state.clips){
    const rec=getRec(clip); if(!rec?.buffer) continue;
    const rms = calcRMS(rec.buffer, 0, rec.buffer.duration);
    if(rms>1e-6){
      clip.gain = Math.min(6, Math.max(0.05, target / rms));
      touched++;
    }
  }
  if(!touched){ snack('조정할 클립이 없습니다'); return; }
  state.dirty=true; snack(`전체 자동 레벨 적용 (${touched})`);
}

function applyPeakNormalizeAll(){
  const ceil = state.fx.peakCeil || 0.95;
  let touched=0;
  for(const clip of state.clips){
    const rec=getRec(clip); if(!rec?.buffer) continue;
    const pk = calcPeak(rec.buffer, 0, rec.buffer.duration);
    if(pk>1e-6){
      clip.gain = Math.min(4, Math.max(0.05, ceil / pk));
      touched++;
    }
  }
  if(!touched){ snack('정규화할 피크가 없습니다'); return; }
  state.dirty=true; snack(`전체 피크 정규화 완료 (${touched})`);
}

function openPanModal(){
  const clip=getSelectedClip(true); if(!clip) return;
  panTargetClipId = clip.id;
  stepperSetValue('#panStepper', clip.pan || 0, true);
  showModal('#panModal');
}

function openHpfModal(){
  const clip=getSelectedClip(true); if(!clip) return;
  hpfTargetClipId = clip.id;
  stepperSetValue('#hpfStepper', clip.hpf || 0, true);
  showModal('#hpfModal');
}

function togglePhaseInvert(){
  const clip=getSelectedClip(true); if(!clip) return;
  clip.phaseInvert = !clip.phaseInvert;
  snack(clip.phaseInvert ? '위상 반전 적용' : '위상 반전 해제');
  renderClip(clip);
  state.dirty=true;
}

function toggleChorus(){
  const clip=getSelectedClip(true); if(!clip) return;
  clip.chorus = !clip.chorus;
  snack(clip.chorus ? '코러스 효과 적용' : '코러스 효과 해제');
  renderClip(clip);
  state.dirty=true;
}

/////////////////////////////
// 확인/단축키/로그
/////////////////////////////
function confirmModal(text){
  return new Promise(res=>{
    const m=$('#confirmModal'); const t=$('#confirmText'); if(t) t.textContent=text||'이 작업을 진행할까요?'; showModal('#confirmModal');
    const y=$('#confirmYes'), n=$('#confirmNo');
    const done=v=>{ hideModal('#confirmModal'); y&&y.removeEventListener('click',yes); n&&n.removeEventListener('click',no); res(v); };
    const yes=()=>done(true), no=()=>done(false); y&&y.addEventListener('click',yes); n&&n.addEventListener('click',no);
  });
}
function shortcutsHTML(){
  return `
  <div style="display:grid;grid-template-columns:120px 1fr;gap:6px">
    <div><b>스페이스</b></div><div>재생/일시정지</div>
    <div><b>Delete</b></div><div>선택 클립 삭제</div>
    <div><b>Ctrl/Cmd+C</b></div><div>복사</div>
    <div><b>Ctrl/Cmd+V</b></div><div>붙여넣기</div>
    <div><b>Ctrl/Cmd+=/-</b></div><div>줌 인/아웃</div>
    <div><b>마우스 휠</b></div><div>타임라인 좌우 스크롤</div>
    <div><b>룰러 드래그</b></div><div>플레이헤드 이동</div>
  </div>`;
}
function initShortcutsUI(){
  bind('#btnShortcuts','click', ()=>{ const b=$('#scBody'); if(b) b.innerHTML = shortcutsHTML(); showModal('#shortcutsModal'); });
  bind('#btnLog','click', ()=>{ const lb=$('#logBody'); if(lb) lb.innerHTML = `<pre style="white-space:pre-wrap">${logs.join('\n')||'(없음)'}</pre>`; showModal('#logModal'); });

  window.addEventListener('keydown', e=>{
    if(e.code==='Space'){ e.preventDefault(); playPause(); }
    if((e.metaKey||e.ctrlKey) && (e.key==='='||e.key==='+')){ e.preventDefault(); setZoom(state.pxPerSec+10); }
    if((e.metaKey||e.ctrlKey) && e.key==='-'){ e.preventDefault(); setZoom(Math.max(10,state.pxPerSec-10)); }
    if(e.code==='Delete' || e.code==='Backspace'){
      if(state.selClip){ const c=state.clips.find(x=>x.id===state.selClip); if(c) confirmDeleteClip(c); }
    }
    if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='c'){ if(state.selClip){ clipboardClip=clone(state.clips.find(c=>c.id===state.selClip)); snack('복사됨'); } }
    if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='v'){ if(clipboardClip){ const nc=ensureClipDefaults({...clipboardClip, id:'c'+Math.random().toString(36).slice(2,8), start:state.playheadSec}); state.clips.push(nc); renderClip(nc); updateTotalLen(); resizeTimeline(); snack('붙여넣기'); state.dirty=true; } }
  });
}

/////////////////////////////
// X-ray/오디오
/////////////////////////////
function drawXray(clip){
  const cv=$('#xrayWave'), meta=$('#xrayMeta'); if(!cv) return;
  const rec=getRec(clip); const ctx=cv.getContext('2d'); ctx.clearRect(0,0,cv.width,cv.height);
  if(!rec || !rec.buffer){ if(meta) meta.textContent='(버퍼 없음)'; return; }
  const ch=rec.buffer.getChannelData(0); const w=cv.width, h=cv.height; const sr=rec.buffer.sampleRate;
  const startS=Math.floor(clip.start*sr), len=Math.floor(clip.duration*sr), step=Math.max(1, Math.floor(len/w));
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent'); ctx.beginPath();
  for(let x=0;x<w;x++){ let lo=1, hi=-1; const i0=startS + x*step; for(let i=i0;i<i0+step && i<startS+len;i++){ const v=ch[i]||0; if(v<lo) lo=v; if(v>hi) hi=v; }
    const y1=(1-lo)*.5*h, y2=(1-hi)*.5*h; ctx.moveTo(x, y1); ctx.lineTo(x, y2); }
  ctx.stroke(); if(meta) meta.textContent=`${rec.name} • ${clip.duration.toFixed(2)}s`;
}
function getRec(clip){ return state.files.find(f=> f.id===clip.fileId); }

function ensureCtx(){
  if(state.ctx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx=new Ctx();
  const master=ctx.createGain(); master.gain.value=1;
  const analyser=ctx.createAnalyser(); analyser.fftSize=256;
  master.connect(analyser).connect(ctx.destination);
  state.ctx=ctx; state.master=master; state.analyser=analyser;
}
function createIR(ctx, time=1.2){
  const sr=ctx.sampleRate, len=Math.max(1,Math.floor(time*sr)); const ir=ctx.createBuffer(2,len,sr);
  for(let c=0;c<2;c++){ const d=ir.getChannelData(c); for(let i=0;i<len;i++){ d[i] = (Math.random()*2-1) * Math.pow(1-i/len, 2.5); } }
  return ir;
}
function buildFXChain(ctx){
  const input=ctx.createGain();
  const low=ctx.createBiquadFilter(); low.type='lowshelf'; low.frequency.value=120; low.gain.value=state.fx.eqLow;
  const high=ctx.createBiquadFilter(); high.type='highshelf'; high.frequency.value=6000; high.gain.value=state.fx.eqHigh;
  input.connect(low).connect(high);

  const delay=ctx.createDelay(1.0); delay.delayTime.value=state.fx.delayTime;
  const fb=ctx.createGain(); fb.gain.value=state.fx.delayFb;
  const dry1=ctx.createGain(); dry1.gain.value=1 - state.fx.delayMix;
  const wet1=ctx.createGain(); wet1.gain.value=state.fx.delayMix;
  high.connect(dry1);
  high.connect(delay); delay.connect(fb).connect(delay);
  delay.connect(wet1);

  const conv=ctx.createConvolver(); conv.buffer=createIR(ctx, state.fx.revTime);
  const dry2=ctx.createGain(); dry2.gain.value=1 - state.fx.revMix;
  const wet2=ctx.createGain(); wet2.gain.value=state.fx.revMix;
  const reverbIn=ctx.createGain();
  dry1.connect(dry2); wet1.connect(reverbIn);
  reverbIn.connect(conv); conv.connect(wet2);

  const comp=ctx.createDynamicsCompressor();
  comp.threshold.value = -20 * state.fx.compThr;
  comp.ratio.value = state.fx.compRatio;

  const limit=ctx.createDynamicsCompressor();
  limit.threshold.value = -20 * (1 - state.fx.limitCeil + 0.02);
  limit.ratio.value = 20;

  const sum=ctx.createGain(); sum.gain.value=1;
  dry2.connect(sum); wet2.connect(sum);
  const out=ctx.createGain();
  sum.connect(comp);
  (state.fx.comp?comp:sum).connect(limit);
  (state.fx.limit?limit:(state.fx.comp?comp:sum)).connect(out);
  return {input, output:out};
}
function scheduleProject(ctx, inputNode, startFromSec=0){
  const rt = !!(window.AudioContext && ctx instanceof (window.AudioContext||window.webkitAudioContext));
  for(const clip of state.clips){
    const rec=getRec(clip); if(!rec||!rec.buffer) continue;
    const clipStartSec = clip.start - startFromSec;
    const end = clip.start + clip.duration;
    if(rt && end <= startFromSec) continue;

    const src=ctx.createBufferSource(); src.buffer=rec.buffer; src.playbackRate.value=1.0;
    const gain=ctx.createGain(); let g=clip.gain||1;

    if(state.fx.autoLevel){ const rms=calcRMS(rec.buffer,0,rec.buffer.duration); if(rms>1e-6) g=Math.min(g, state.fx.targetRMS/Math.max(rms,1e-6)); }
    if(state.fx.peakNorm){ const pk=calcPeak(rec.buffer,0,rec.buffer.duration); if(pk>1e-6) g=Math.min(g, state.fx.peakCeil/Math.max(pk,1e-6)); }
    g = clip.phaseInvert ? -Math.abs(g) : Math.abs(g);
    gain.gain.value=g;

    const dur=clip.duration;
    const fadeIn=Math.min(clip.fadeIn||0, dur/2);
    const fadeOut=Math.min(clip.fadeOut||0, dur/2);

    const when = rt ? (state.ctx.currentTime + Math.max(0, clipStartSec)) : Math.max(0, clipStartSec);
    const offset = Math.max(0, startFromSec - clip.start);
    const playDur = Math.max(0, dur - offset);

    if(fadeIn>0 || fadeOut>0){
      const gn=gain.gain; const t0=when; const t1=when+Math.min(fadeIn, playDur/2); const t2=when+Math.max(0, playDur - Math.min(fadeOut, playDur/2)); const t3=when+playDur;
      gn.setValueAtTime(0, t0); gn.linearRampToValueAtTime(g, t1); gn.setValueAtTime(g, t2); gn.linearRampToValueAtTime(.0001, t3);
    }

    const extras=[];
    let chainTail=gain;

    if(clip.hpf && clip.hpf > 0){
      const hpf=ctx.createBiquadFilter();
      hpf.type='highpass';
      hpf.frequency.value = clip.hpf;
      chainTail.connect(hpf);
      chainTail = hpf;
    }

    if(typeof clip.pan==='number' && Math.abs(clip.pan)>0.001){
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, clip.pan));
      chainTail.connect(panner);
      chainTail = panner;
    }

    if(clip.chorus){
      const dry = ctx.createGain(); dry.gain.value=0.78;
      const wet = ctx.createGain(); wet.gain.value=0.42;
      const delay = ctx.createDelay(0.05); delay.delayTime.value=0.018;
      const lfo = ctx.createOscillator(); lfo.frequency.value=0.35;
      const depth = ctx.createGain(); depth.gain.value=0.006;
      lfo.connect(depth).connect(delay.delayTime);
      const sum = ctx.createGain();
      chainTail.connect(dry);
      chainTail.connect(delay);
      delay.connect(wet);
      dry.connect(sum);
      wet.connect(sum);
      const stopAt = when + Math.max(0.1, playDur+0.1);
      try{ lfo.start(when); lfo.stop(stopAt); }catch{}
      extras.push(lfo);
      chainTail = sum;
    }

    chainTail.connect(inputNode);
    src.connect(gain);
    try{ src.start(when, offset, playDur); }catch(e){ err('src.start', e); }
    if(rt) state.nodes.push({src,gain,extras});
  }
}

/////////////////////////////
// 프리뷰/트랜스포트
/////////////////////////////
function ensureCtxIfNeeded(){ if(!state.ctx){ ensureCtx(); } }
function playPause(){
  if(state.playing){ pausePlay(); return; }
  ensureCtxIfNeeded(); stopNodes();
  const chain = buildFXChain(state.ctx);
  chain.output.connect(state.master);

  state.playStartContextTime = state.ctx.currentTime;
  state.playStartProjectTime = state.playheadSec;

  scheduleProject(state.ctx, chain.input, state.playheadSec);
  state.playing=true; tickPlay(); snack('재생'); logEvent('Play');
}
function tickPlay(){
  if(!state.playing) return;

  const elapsed = state.ctx.currentTime - state.playStartContextTime;
  setPlayhead(state.playStartProjectTime + Math.max(0, elapsed));

  // VU
  const L=$('#vuL'), R=$('#vuR');
  if(state.analyser && L && R){
    const arr=new Uint8Array(state.analyser.frequencyBinCount); state.analyser.getByteTimeDomainData(arr);
    const peak = arr.reduce((m,v)=> Math.max(m, Math.abs(v-128)), 0)/128;
    const h=Math.max(2, Math.floor(peak*12)); L.style.height=h+'px'; R.style.height=h+'px';
  }

  const end=getProjectEndSec();
  if(state.playheadSec>=end){
    if(state.loop){
      setPlayhead(0);
      state.playStartContextTime = state.ctx.currentTime;
      state.playStartProjectTime = 0;
      playPause();
      return;
    }
    stopPlay(); return;
  }
  state._raf = requestAnimationFrame(tickPlay);
}
function pausePlay(){ state.playing=false; cancelAnimationFrame(state._raf); stopNodes(true); snack('일시정지'); logEvent('Pause'); }
function stopPlay(){ state.playing=false; cancelAnimationFrame(state._raf); stopNodes(); setPlayhead(0); snack('정지'); logEvent('Stop'); }
function stopNodes(){
  for(const n of state.nodes){
    try{ n.src.stop(0); }catch{}
    if(Array.isArray(n.extras)){
      for(const ex of n.extras){
        if(!ex) continue;
        try{ ex.stop ? ex.stop(0) : ex.disconnect?.(); }catch{}
        try{ ex.disconnect?.(); }catch{}
      }
    }
  }
  state.nodes=[];
}
function setPlayhead(sec){
  state.playheadSec=Math.max(0,sec);
  const ph=$('#playhead'); if(ph) ph.style.left=(state.playheadSec*state.pxPerSec)+'px';
  const cur=$('#cursorTime'); if(cur) cur.textContent=formatTime(Math.round(state.playheadSec));
  const stc=$('#statusTC'); if(stc) stc.textContent=formatTime(Math.round(state.playheadSec));
  const wrap=$('#laneWrap'); if(wrap){
    const x=state.playheadSec*state.pxPerSec;
    const left=wrap.scrollLeft, right=left+wrap.clientWidth;
    if(x<left+100) wrap.scrollLeft = Math.max(0, x-100);
    if(x>right-100) wrap.scrollLeft = x - wrap.clientWidth + 100;
  }
}

/////////////////////////////
// 수학/유틸
/////////////////////////////
function updateTotalLen(){ const end=getProjectEndSec(); const tl=$('#totalLen'); if(tl) tl.textContent=formatTime(end); const sl=$('#statusLen'); if(sl) sl.textContent=formatTime(end); }
function formatTime(sec){ sec=Math.max(0,Math.round(sec)); const m=Math.floor(sec/60), s=sec%60; return `${m}:${s.toString().padStart(2,'0')}`; }
function pickColor(){ const p=['#5f7cff','#9b7cff','#22c55e','#ef4444','#eab308','#06b6d4','#f97316','#a855f7']; return p[state.clips.length%p.length]; }
function calcRMS(buf, start=0, dur=buf.duration){ const sr=buf.sampleRate; const s0=Math.max(0,Math.floor(start*sr)); const n=Math.max(1, Math.floor(dur*sr)); let sum=0, cnt=0;
  for(let ch=0;ch<buf.numberOfChannels;ch++){ const d=buf.getChannelData(ch); for(let i=0;i<n && s0+i<d.length;i++){ const v=d[s0+i]; sum+=v*v; cnt++; } }
  return Math.sqrt(sum/Math.max(1,cnt)); }
function calcPeak(buf, start=0, dur=buf.duration){ const sr=buf.sampleRate; const s0=Math.max(0,Math.floor(start*sr)); const n=Math.max(1, Math.floor(dur*sr)); let pk=0;
  for(let ch=0;ch<buf.numberOfChannels;ch++){ const d=buf.getChannelData(ch); for(let i=0;i<n && s0+i<d.length;i++){ const v=Math.abs(d[s0+i]); if(v>pk) pk=v; } } return pk; }
function avgRMSProject(){ const arr=state.clips.map(c=>{ const r=getRec(c); return r?.buffer?calcRMS(r.buffer, c.start, c.duration):0.2; }); return arr.length? (arr.reduce((a,b)=>a+b,0)/arr.length):0.2; }
function detectSilence(buf, start, dur, th){ const sr=buf.sampleRate; const d0=Math.max(0,Math.floor(start*sr)); const n=Math.max(1, Math.floor(dur*sr));
  const ch=buf.getChannelData(0); let i=0; while(i<n){ if(Math.abs(ch[d0+i]||0)>th) break; i++; } let j=n-1; while(j>i){ if(Math.abs(ch[d0+j]||0)>th) break; j--; }
  const lead=i/sr; const tail=(n-1-j)/sr; return {lead,tail}; }

function buildWaveform(buffer, buckets=2048){
  const totalBuckets = Math.max(64, Math.min(buckets, buffer.length));
  const data = new Float32Array(totalBuckets*2);
  const channels = Array.from({length: buffer.numberOfChannels}, (_,i)=> buffer.getChannelData(i));
  const bucketLen = Math.max(1, Math.floor(buffer.length / totalBuckets));
  for(let b=0;b<totalBuckets;b++){
    const start = b*bucketLen;
    const end = b===totalBuckets-1 ? buffer.length : Math.min(buffer.length, start + bucketLen);
    let min=1, max=-1;
    for(let i=start;i<end;i++){
      let sample=0;
      for(const ch of channels){ sample += ch[i] || 0; }
      sample /= channels.length || 1;
      if(sample<min) min=sample;
      if(sample>max) max=sample;
    }
    if(min===1 && max===-1){ min=0; max=0; }
    const idx=b*2; data[idx]=min; data[idx+1]=max;
  }
  return {data, buckets:totalBuckets, duration: buffer.duration};
}

function drawClipWaveform(canvas, clip){
  if(!canvas) return;
  const ctx=canvas.getContext('2d');
  if(!ctx) return;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const rec=getRec(clip);
  if(!rec || !rec.buffer){
    ctx.fillStyle='rgba(255,255,255,0.12)';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    return;
  }
  if(!rec.wave) rec.wave = buildWaveform(rec.buffer);
  const wave = rec.wave;
  if(!wave || !wave.data){ return; }
  const data = wave.data;
  const totalBuckets = wave.buckets;
  const totalDur = rec.buffer.duration || clip.duration || 1;
  const startRatio = Math.max(0, Math.min(1, clip.start / totalDur));
  const endRatio = Math.max(startRatio, Math.min(1, (clip.start + clip.duration) / totalDur));
  const startIndex = Math.floor(totalBuckets * startRatio);
  const endIndex = Math.max(startIndex + 1, Math.floor(totalBuckets * endRatio));
  const width = canvas.width;
  const height = canvas.height;
  const step = Math.max(1, Math.floor((endIndex - startIndex) / width));
  ctx.beginPath();
  ctx.strokeStyle='rgba(255,255,255,0.78)';
  ctx.lineWidth=1;
  for(let x=0; x<width; x++){
    const bucket = startIndex + x*step;
    if(bucket >= endIndex) break;
    let min=1, max=-1;
    for(let i=0;i<step && bucket+i<endIndex;i++){
      const idx = (bucket+i)*2;
      if(idx+1 >= data.length) break;
      const bMin = data[idx];
      const bMax = data[idx+1];
      if(bMin<min) min=bMin;
      if(bMax>max) max=bMax;
    }
    const y1 = (1 - (max||0)) * 0.5 * height;
    const y2 = (1 - (min||0)) * 0.5 * height;
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
  }
  ctx.stroke();
}

/////////////////////////////
// Export (MP3 품질은 플랜에 맞춰 자동)
/////////////////////////////
function initExport(){
  toggleInit('#toggleDateName', false);

  bind('#exportClose','click', ()=> hideModal('#exportModal'));

  bind('#btnExportWav','click', async ()=>{
    hideModal('#exportModal'); showLoading(true);
    try{
      const out = await renderOfflineMix();
      const wav = encodeWav(out);
      const name = makeExportName('wav'); downloadBlob(new Blob([wav],{type:'audio/wav'}), name);
      snack('WAV 내보내기 완료'); logEvent('Export WAV');
    }catch(e){ err(e); snack('WAV 내보내기 실패'); }
    showLoading(false);
  });

  bind('#btnExportMp3','click', async ()=>{
    hideModal('#exportModal'); showLoading(true);
    try{
      const out = await renderOfflineMix();
      await ensureLame();
      const kbps = getMp3BitrateByPlan(); // 플랜에 따른 비트레이트 자동
      const mp3 = encodeMp3(out, kbps);
      const name = makeExportName('mp3'); downloadBlob(new Blob(mp3,{type:'audio/mpeg'}), name);
      snack(`MP3(${kbps}kbps) 내보내기 완료`); logEvent('Export MP3');
    }catch(e){ err(e); snack('MP3 내보내기 실패'); }
    showLoading(false);
  });

  bind('#btnExportProject','click', async ()=>{
    hideModal('#exportModal'); showLoading(true);
    try{
      const blob = await makeProjectZipBlob();
      downloadBlob(blob, `auditfy_project_${Date.now()}.zip`);
      ensureProjectId();
      await recordProjectSave({blob});
      snack('프로젝트 ZIP 내보내기 완료');
    }catch(e){ err(e); snack('프로젝트 내보내기 실패'); }
    showLoading(false);
  });

}
function makeExportName(ext){
  const useDate = $('#toggleDateName')?.classList.contains('on');
  if(!useDate) return `auditfy_${Date.now()}.${ext}`;
  const d=new Date(); const mm=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); const rand=Math.random().toString(36).slice(2,4);
  // 프로젝트명 프리픽스(있으면)
  const name = ($('#projectName')?.textContent || 'Auditfy').replace(/[\\/:*?"<>|]+/g,'_');
  return `${name}_${mm}${dd}${rand}.${ext}`;
}
function downloadBlob(blob, name){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }

async function renderOfflineMix(){
  ensureCtxIfNeeded();
  const sr = state.ctx.sampleRate;
  const endSec = getProjectEndSec();
  const len = Math.max(1, Math.ceil(endSec*sr)+1);
  const OffCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx=new OffCtx(2, len, sr);

  const chain = buildFXChain(ctx);
  chain.output.connect(ctx.destination);
  scheduleProject(ctx, chain.input, 0);
  const rendered = await ctx.startRendering();
  return rendered;
}

function encodeWav(audioBuffer){
  const numCh=audioBuffer.numberOfChannels, sr=audioBuffer.sampleRate, len=audioBuffer.length;
  const dataLen=len*numCh*2; const total=44+dataLen; const ab=new ArrayBuffer(total); const dv=new DataView(ab); let off=0;
  const wStr=s=>{ for(let i=0;i<s.length;i++) dv.setUint8(off++, s.charCodeAt(i)); };
  const w16=v=>{ dv.setUint16(off, v, true); off+=2; }; const w32=v=>{ dv.setUint32(off, v, true); off+=4; };
  wStr('RIFF'); w32(total-8); wStr('WAVE'); wStr('fmt '); w32(16); w16(1); w16(numCh); w32(sr); w32(sr*numCh*2); w16(numCh*2); w16(16); wStr('data'); w32(dataLen);
  const ch=[]; for(let i=0;i<numCh;i++) ch.push(audioBuffer.getChannelData(i));
  for(let i=0;i<len;i++){ for(let c=0;c<numCh;c++){ let s=Math.max(-1, Math.min(1, ch[c][i])); dv.setInt16(off, s<0?s*0x8000:s*0x7FFF, true); off+=2; } }
  return ab;
}
async function ensureLame(){
  if(window.lamejs) return;
  await new Promise((res,rej)=>{
    const s=document.createElement('script'); s.src='https://unpkg.com/lamejs@1.2.0/lame.min.js'; s.onload=res; s.onerror=rej; document.body.appendChild(s);
  });
}
function getMp3BitrateByPlan(){
  const plan = getSessionSync()?.plan || 'Free';
  if(plan==='Plus' || plan==='Pro' || plan==='Unlimited') return 320;
  return 256; // Free
}
function encodeMp3(audioBuffer, kbps=256){
  const sr=audioBuffer.sampleRate; const ch=audioBuffer.numberOfChannels; const left=audioBuffer.getChannelData(0);
  const right=ch>1? audioBuffer.getChannelData(1) : left;
  const samples = audioBuffer.length;
  const mp3enc = new lamejs.Mp3Encoder(2, sr, kbps);
  const block = 1152; const mp3Data=[];
  const toInt16 = (f32)=>{ const s=new Int16Array(f32.length); for(let i=0;i<f32.length;i++){ let x=Math.max(-1,Math.min(1,f32[i])); s[i]=x<0? x*0x8000 : x*0x7FFF; } return s; };

  for(let i=0;i<samples;i+=block){
    const l = toInt16(left.slice(i, i+block));
    const r = toInt16(right.slice(i, i+block));
    const mp3buf = mp3enc.encodeBuffer(l, r);
    if(mp3buf.length>0) mp3Data.push(new Int8Array(mp3buf));
  }
  const end=mp3enc.flush(); if(end.length>0) mp3Data.push(new Int8Array(end));
  return mp3Data;
}

/////////////////////////////
// 이펙트 모달
/////////////////////////////
function initEffectsModals(){
  bind('#btnComp','click', ()=>{ showModal('#compModal'); });
  bind('#btnLimit','click',()=>{ showModal('#limitModal'); });
  bind('#btnEQ','click',   ()=>{ showModal('#eqModal'); });
  bind('#btnRev','click',  ()=>{ showModal('#revModal'); });
  bind('#btnDelay','click',()=>{ showModal('#delayModal'); });

  stepperInit('#compThr', state.fx.compThr, v=> state.fx.compThr=v);
  stepperInit('#compRatio', state.fx.compRatio, v=> state.fx.compRatio=v);
  stepperInit('#limitCeil', state.fx.limitCeil, v=> state.fx.limitCeil=v);
  stepperInit('#eqLow', state.fx.eqLow, v=> state.fx.eqLow=v);
  stepperInit('#eqHigh', state.fx.eqHigh, v=> state.fx.eqHigh=v);
  stepperInit('#revMix', state.fx.revMix, v=> state.fx.revMix=v);
  stepperInit('#revTime', state.fx.revTime, v=> state.fx.revTime=v);
  stepperInit('#delayTime', state.fx.delayTime, v=> state.fx.delayTime=v);
  stepperInit('#delayFb', state.fx.delayFb, v=> state.fx.delayFb=v);
  stepperInit('#delayMix', state.fx.delayMix, v=> state.fx.delayMix=v);

  stepperInit('#panStepper', 0, (v)=>{
    if(!panTargetClipId) return;
    const clip=state.clips.find(c=> c.id===panTargetClipId);
    if(!clip) return;
    clip.pan = Math.max(-1, Math.min(1, v));
    renderClip(clip);
    state.dirty=true;
  });
  stepperInit('#hpfStepper', 120, (v)=>{
    if(!hpfTargetClipId) return;
    const clip=state.clips.find(c=> c.id===hpfTargetClipId);
    if(!clip) return;
    clip.hpf = Math.max(0, v);
    state.dirty=true;
  });
}

/////////////////////////////
// “페이드 인/아웃” 모달 & 버튼 (효과 탭)
/////////////////////////////
function ensureFadeButton(){
  const panel = $('#panel-effect .miniGroup');
  if(!panel) return;
  if(!$('#btnFadeAuto')){
    const btn = document.createElement('button');
    btn.id='btnFadeAuto'; btn.className='miniBtn';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 12h16M4 18h10M4 6h6"/></svg><span class="t">페이드 인/아웃</span>`;
    panel.appendChild(btn);
    btn.addEventListener('click', ()=> showModal('#fadeModal'));
  }
}
function ensureFadeModal(){
  if($('#fadeModal')) return;
  const wrap=document.createElement('div');
  wrap.id='fadeModal'; wrap.className='modal';
  wrap.innerHTML=`
  <div class="card">
    <div class="hd">페이드 인/아웃 자동 적용</div>
    <div class="bd" style="display:flex;flex-direction:column;gap:12px">
      <div>페이드 길이(초)
        <div id="fadeLen" class="ui-slider" data-min="0" data-max="10" data-step="0.5" data-val="2">
          <div class="track" style="position:relative;height:10px;border:1px solid var(--line);border-radius:6px;background:rgba(255,255,255,.06)">
            <div class="bar" style="position:absolute;inset:0;width:20%;background:linear-gradient(90deg,var(--gradA),var(--gradB));border-radius:6px"></div>
            <div class="knob" style="position:absolute;top:-6px;width:22px;height:22px;border-radius:999px;border:1px solid var(--line);background:var(--bg-elev)"></div>
          </div>
          <div style="margin-top:6px"><span class="val">2</span> s</div>
        </div>
      </div>
      <div id="fadeOverlap" class="ui-toggle on">겹치게 재배치(자동 크로스페이드)</div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <div><b>대상</b></div>
        <label class="ui-toggle on"   id="fadeScopeSel" data-scope="selected">선택 클립만</label>
        <label class="ui-toggle"       id="fadeScopeTrack" data-scope="track">현재 트랙</label>
        <label class="ui-toggle"       id="fadeScopeAll" data-scope="all">모든 트랙</label>
      </div>
    </div>
    <div class="ft">
      <button id="fadeCancel" class="btn">취소</button>
      <button id="fadeApply" class="btn grad">적용</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  // wiring
  sliderInit('#fadeLen');
  toggleInit('#fadeOverlap', true);
  // scope toggles (exclusive)
  ['#fadeScopeSel','#fadeScopeTrack','#fadeScopeAll'].forEach(id=>{
    const el=$(id); if(!el) return;
    el.addEventListener('click', ()=>{
      ['#fadeScopeSel','#fadeScopeTrack','#fadeScopeAll'].forEach(k=> $(k)?.classList.remove('on'));
      el.classList.add('on');
    });
  });
  bind('#fadeCancel','click', ()=> hideModal('#fadeModal'));
  bind('#fadeApply','click', ()=>{
    const len = sliderVal('#fadeLen');
    const overlap = $('#fadeOverlap')?.classList.contains('on');
    let scope = 'selected';
    if($('#fadeScopeTrack')?.classList.contains('on')) scope='track';
    if($('#fadeScopeAll')?.classList.contains('on')) scope='all';
    applyAutoFade(len, overlap, scope);
    hideModal('#fadeModal');
  });
}
function applyAutoFade(len=2, overlap=true, scope='selected'){
  const half = Math.max(0, len/2);
  const applyPair=(a,b)=>{
    if(!a||!b) return;
    const endA = a.start + a.duration;
    if(overlap){
      // b를 당겨서 겹치기
      b.start = Math.max(0, endA - len);
    }
    a.fadeOut = Math.max(a.fadeOut||0, half);
    b.fadeIn  = Math.max(b.fadeIn||0, half);
    renderClip(a); renderClip(b);
  };
  const applyTrack=(trackIdx)=>{
    const list = state.clips.filter(c=>c.track===trackIdx).sort((x,y)=> x.start - y.start);
    for(let i=0;i<list.length-1;i++){ applyPair(list[i], list[i+1]); }
  };

  if(scope==='selected' && state.selClip){
    const c = state.clips.find(x=>x.id===state.selClip); if(!c){ snack('선택 없음'); return; }
    const list = state.clips.filter(x=> x.track===c.track).sort((x,y)=> x.start-y.start);
    const idx = list.findIndex(x=>x.id===c.id);
    applyPair(list[idx-1], list[idx]);
    applyPair(list[idx], list[idx+1]);
  }else if(scope==='track' && state.selClip){
    const c = state.clips.find(x=>x.id===state.selClip); if(!c){ snack('선택 없음'); return; }
    applyTrack(c.track);
  }else{
    for(let t=0;t<state.tracks;t++) applyTrack(t);
  }
  updateTotalLen(); resizeTimeline(); snack(`페이드 적용 • ${len.toFixed(2)}s ${overlap?'크로스페이드':''}`); state.dirty=true;
}

/////////////////////////////
// 프로젝트 JSON/ZIP
/////////////////////////////
function makeProjectJSON(){
  const title = state.projectTitle || $('#projectName')?.textContent || 'Untitled';
  return {
    version:'1.5.4',
    name: title,
    id: ensureProjectId(),
    tracks: state.tracks,
    pxPerSec: state.pxPerSec,
    fx: state.fx,
    files: state.files.map(f=> ({id:f.id, name:f.name})),
    clips: state.clips.map(c=> ({...c}))
  };
}
function sanitizeFileBase(name){
  return (name || 'audio')
    .replace(/[\\/:*?"<>|]/g,'_')
    .replace(/\s+/g,' ')
    .trim() || 'audio';
}
function splitNameAndExt(name){
  if(!name) return { base:'audio', ext:'' };
  const trimmed=String(name).trim();
  const idx=trimmed.lastIndexOf('.');
  if(idx<=0) return { base:trimmed, ext:'' };
  return { base:trimmed.slice(0, idx), ext:trimmed.slice(idx+1) };
}
function sanitizeExt(ext){
  return String(ext || '')
    .replace(/[^a-z0-9]/ig,'')
    .toLowerCase();
}
function guessExtFromMime(mime){
  if(!mime) return '';
  const m=String(mime).toLowerCase();
  if(m.includes('wav')) return 'wav';
  if(m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if(m.includes('m4a')) return 'm4a';
  if(m.includes('aac')) return 'aac';
  if(m.includes('ogg') || m.includes('opus')) return 'ogg';
  if(m.includes('flac')) return 'flac';
  if(m.includes('webm')) return 'webm';
  return '';
}
function guessMimeFromExt(ext){
  switch((ext||'').toLowerCase()){
    case 'wav': return 'audio/wav';
    case 'mp3': return 'audio/mpeg';
    case 'm4a': return 'audio/mp4';
    case 'aac': return 'audio/aac';
    case 'ogg':
    case 'oga':
    case 'opus': return 'audio/ogg';
    case 'flac': return 'audio/flac';
    case 'webm': return 'audio/webm';
    default: return 'audio/*';
  }
}
function buildZipEntryDescriptor(rec, index){
  const rawName = rec?.name || `audio_${index+1}`;
  const { base, ext } = splitNameAndExt(rawName);
  let cleanExt = sanitizeExt(ext);
  if(!cleanExt){
    cleanExt = guessExtFromMime(rec?.file?.type || rec?.mime) || (rec?.buffer ? 'wav' : '');
  }
  if(!cleanExt) cleanExt='wav';
  const cleanBase = sanitizeFileBase(base || rawName);
  const idFragment = String(rec?.id || `f${index+1}`)
    .replace(/[^a-z0-9_-]/ig,'')
    .slice(-12) || `f${index+1}`;
  const zipName = `${index+1}_${idFragment}_${cleanBase}.${cleanExt}`;
  const mime = rec?.file?.type || rec?.mime || guessMimeFromExt(cleanExt);
  return { zipName, mime };
}
async function makeProjectZipBlob(){
  await ensureZip();
  const zip = new JSZip();
  const meta = makeProjectJSON();
  const filesMeta = [];
  const audioFolder = zip.folder('audio');
  let fileIndex = 0;
  for(const rec of state.files){
    try{
      const ab = await exportFileArrayBuffer(rec);
      if(!ab) continue;
      const descriptor = buildZipEntryDescriptor(rec, fileIndex);
      audioFolder.file(descriptor.zipName, ab);
      const sizeHint = typeof ab?.byteLength === 'number' ? ab.byteLength : (ab?.length || rec.file?.size || 0);
      filesMeta.push({
        id: rec.id,
        name: rec.name,
        zipPath: descriptor.zipName,
        mime: descriptor.mime,
        size: sizeHint
      });
      fileIndex++;
    }catch(e){ err('zip add fail', e); }
  }
  meta.files = filesMeta;
  zip.file('auditfy.project.json', JSON.stringify(meta, null, 2));
  return zip.generateAsync({type:'blob'});
}

async function exportFileArrayBuffer(rec){
  if(rec.file){ return await fileToBuffer(rec.file); }
  if(rec.buffer){ return encodeWav(rec.buffer); }
  if(rec.url){
    const res = await fetch(rec.url);
    if(!res.ok) throw new Error('audio fetch failed');
    return await res.arrayBuffer();
  }
  return null;
}

function resetFileHub(){
  state.files.forEach(rec=>{
    if(rec?.url){
      try{ URL.revokeObjectURL(rec.url); }
      catch{}
    }
  });
  state.files = [];
  const list=$('#fhList');
  if(list) list.innerHTML='';
}

async function recordProjectSave({blob}={}){
  const sess = window.Cloud?.session?.();
  if(!sess || !sess.email || !window.Cloud?.projects?.saveZip || !blob){
    return;
  }
  const meta={
    id: ensureProjectId(),
    name: state.projectTitle || 'Untitled'
  };

  try{
    const resp = await Cloud.projects.saveZip({ id: meta.id, name: meta.name || 'Untitled', blob });
    if(resp?.ok && resp.project){
      if(resp.project.id) state.projectId = resp.project.id;
      if(resp.project.displayName) updateProjectTitle(resp.project.displayName);
      return;
    }
    if(resp?.error) snack(resp.error);
  }catch(e){ err('Cloud.projects.saveZip 실패', e); }
}

function saveProjectToJson(){
  const json = makeProjectJSON();
  const blob = new Blob([JSON.stringify(json, null, 2)], {type:'application/json'});
  const safe = ($('#projectName')?.textContent?.trim() || 'auditfy_project').replace(/[\\/:*?"<>|]+/g,'_');
  downloadBlob(blob, `${safe || 'auditfy_project'}.json`);
  snack('프로젝트 JSON을 저장했습니다');
  state.dirty=false;
}

async function saveProjectToZip(){
  showLoading(true);
  try{
    const blob = await makeProjectZipBlob();
    const safe = ($('#projectName')?.textContent?.trim() || 'auditfy_project').replace(/[\\/:*?"<>|]+/g,'_');
    downloadBlob(blob, `${safe || 'auditfy_project'}.zip`);
    snack('프로젝트 ZIP을 저장했습니다');
    state.dirty=false;
  }catch(e){ err('save zip', e); snack('프로젝트 ZIP 저장 실패'); }
  showLoading(false);
}

async function uploadProjectToRepo(){
  showLoading(true);
  try{
    const blob = await makeProjectZipBlob();
    const pname = ($('#projectName')?.textContent?.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g,'_');
    if(window.Cloud?.projects?.saveZip){
      const resp = await Cloud.projects.saveZip({
        id: ensureProjectId(),
        name: pname || 'Untitled',
        blob
      });
      if(!resp?.ok){ throw new Error(resp?.error || '프로젝트 저장에 실패했습니다.'); }
      if(resp.project){
        if(resp.project.id) state.projectId = resp.project.id;
        if(resp.project.displayName) updateProjectTitle(resp.project.displayName);
      }
    }else{
      await cloudUploadFile('/projects', blob, `auditfy_${pname || 'project'}.zip`);
    }
    snack('프로젝트 저장소로 업로드했습니다');
    state.dirty=false;
    logEvent('Project uploaded to Cloud');
  }catch(e){ err('project upload fail', e); snack('프로젝트 저장소 업로드 실패'); }
  showLoading(false);
}

function loadProjectJSON(js){
  if(js && js.name) updateProjectTitle(js.name);
  if(js && js.id) state.projectId = js.id;
  state.tracks = js.tracks||3; initTracks(state.tracks);
  state.pxPerSec = js.pxPerSec||10; setZoom(state.pxPerSec);
  state.fx = {...clone(DEFAULT_FX), ...(js.fx||{})};
  const idMap = new Map();
  for(const jf of (js.files||[])){
    const found = state.files.find(f=> f.name===jf.name);
    if(found){ idMap.set(jf.id, found.id); }
  }
  state.clips = (js.clips||[]).map(c=> ensureClipDefaults({...c, fileId: idMap.get(c.fileId)||c.fileId}));
  const clipsWrap=$('#clips'); if(clipsWrap) clipsWrap.innerHTML='<div id="markers"></div><div id="playhead"></div>';
  state.clips.forEach(renderClip);
  updateTotalLen(); initRuler(); calibratePx(); resizeTimeline(); setPlayhead(0);
  snack('프로젝트 로드 완료(파일 매칭 필요할 수 있음)');
}
async function importProjectZip(file){
  await ensureZip();
  const zip = await JSZip.loadAsync(file);
  const meta = JSON.parse(await zip.file('auditfy.project.json').async('string'));
  if(meta?.name) updateProjectTitle(meta.name);
  if(meta?.id) state.projectId = meta.id;
  resetFileHub();

  const audioImports = [];
  if(Array.isArray(meta?.files) && meta.files.length){
    for(const info of meta.files){
      try{
        const rawKey = String(info.zipPath || info.path || info.name || '').replace(/^audio\//,'');
        const entry = rawKey ? (zip.file(`audio/${rawKey}`) || zip.file(rawKey)) : null;
        if(!entry){
          console.warn('[importProjectZip] missing audio entry for', info);
          continue;
        }
        const blob = await entry.async('blob');
        const fileName = info.name || rawKey || `audio_${audioImports.length+1}.wav`;
        const { ext } = splitNameAndExt(fileName);
        const mime = info.mime || blob.type || guessMimeFromExt(ext) || 'audio/*';
        audioImports.push({ meta: info, file: new File([blob], fileName, { type: mime }) });
      }catch(err){
        console.error('[importProjectZip] audio decode failed', err);
      }
    }
  }

  if(!audioImports.length){
    for(const name in zip.files){
      if(!name.startsWith('audio/') || zip.files[name].dir) continue;
      const blob = await zip.files[name].async('blob');
      const base = name.substring('audio/'.length);
      const { ext } = splitNameAndExt(base);
      const mime = blob.type || guessMimeFromExt(ext) || 'audio/*';
      audioImports.push({ meta: { id: base, name: base }, file: new File([blob], base, { type: mime }) });
    }
  }

  const addedRecords = await addFilesToHub(audioImports.map(entry=> entry.file)) || [];
  const idMap = new Map();
  for(let i=0;i<audioImports.length;i++){
    const metaInfo = audioImports[i]?.meta;
    const rec = addedRecords[i];
    if(metaInfo?.id && rec?.id){
      idMap.set(metaInfo.id, rec.id);
    }
  }
  if(idMap.size===0 && Array.isArray(meta?.files)){
    const byName = new Map(state.files.map(f=> [f.name, f.id]));
    for(const info of meta.files){
      if(info?.id && !idMap.has(info.id)){
        const target = byName.get(info.name);
        if(target) idMap.set(info.id, target);
      }
    }
  }
  state.tracks = meta.tracks||3; initTracks(state.tracks);
  state.pxPerSec = meta.pxPerSec||10; setZoom(state.pxPerSec);
  state.fx = {...clone(DEFAULT_FX), ...(meta.fx||{})};
  state.clips = (meta.clips||[]).map(c=> ensureClipDefaults({...c, fileId: idMap.get(c.fileId)||c.fileId}));
  const clipsWrap=$('#clips'); if(clipsWrap) clipsWrap.innerHTML='<div id="markers"></div><div id="playhead"></div>';
  state.clips.forEach(renderClip);
  updateTotalLen(); initRuler(); calibratePx(); resizeTimeline(); setPlayhead(0);
  snack('프로젝트 ZIP 로드 완료');
}

async function loadProjectFromCloud(projectId){
  try{
    showLoading(true);
    const resp = await window.Cloud.projects.downloadProject(projectId);
    if(!resp?.ok){ snack(resp?.error || '프로젝트를 불러올 수 없습니다.'); return; }
    let blob;
    if(resp.url){
      const res = await fetch(resp.url);
      if(!res.ok) throw new Error('프로젝트를 다운로드할 수 없습니다.');
      blob = await res.blob();
    }else if(resp.blob){
      blob = resp.blob;
    }
    if(!blob) throw new Error('프로젝트 데이터를 찾을 수 없습니다.');
    const fileName = resp.fileName || `${resp.name || 'project'}.zip`;
    const file = new File([blob], fileName, { type: 'application/zip' });
    await importProjectZip(file);
    state.dirty=false;
  }catch(e){ err('load cloud project', e); snack('프로젝트를 불러올 수 없습니다.'); }
  finally{ showLoading(false); }
}

/////////////////////////////
// 트랙
/////////////////////////////
function initTracks(n){
  const col=$('#tracksCol'); if(!col) return; col.innerHTML='';
  for(let i=1;i<=n;i++){ const row=document.createElement('div'); row.className='track-row'; row.textContent=`Track ${i}`; col.appendChild(row); }
}

/////////////////////////////
// 파일 IO/지연 로더
/////////////////////////////
function fileToBuffer(file){ return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsArrayBuffer(file); }); }
function decodeBuffer(arr){
  return new Promise((res,rej)=>{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx=new Ctx();
    const copy = arr.slice ? arr.slice(0) : arr;
    ctx.decodeAudioData(copy, (buf)=>{ ctx.close(); res(buf); }, (e)=>{ ctx.close(); rej(e); });
  });
}
async function ensureZip(){
  if(window.JSZip) return;
  await new Promise((res,rej)=>{
    const s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'; s.onload=res; s.onerror=rej; document.body.appendChild(s);
  });
}

/////////////////////////////
// Cloud 가져오기 모달/로직
/////////////////////////////
function ensureCloudPickerDOM(){
  if($('#cloudPickerModal')) return;
  const wrap=document.createElement('div');
  wrap.id='cloudPickerModal'; wrap.className='modal';
  wrap.innerHTML=`
  <div class="card" style="min-width:680px;max-width:920px">
    <div class="hd">Auditfy Cloud에서 불러오기</div>
    <div class="bd" style="display:grid;grid-template-columns:220px 1fr;gap:12px">
      <div style="display:flex;flex-direction:column;gap:8px">
        <div><strong>폴더</strong></div>
        <div id="cpTree" class="fh-list" style="height:300px"></div>
        <div style="display:flex;gap:8px">
          <button id="cpUp" class="btn">상위 폴더</button>
          <button id="cpNewFolder" class="btn">폴더 생성</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>파일(오디오만 표시)</strong>
          <span id="cpHint" class="chip">선택 0</span>
        </div>
        <div id="cpList" class="fh-list" style="height:300px"></div>
      </div>
    </div>
    <div class="ft">
      <button id="cpCancel" class="btn">취소</button>
      <button id="cpImport" class="btn grad">가져오기</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
}
let _cp={ curPath:'/', sel:new Set(), folders:[], files:[], mode:'audio', onImport:null, allowMulti:true };
async function openCloudPicker(opts={}){
  const sess=await loadSession();
  if(!sess){
    location.href='/auth.html?next=/index.html';
    return;
  }
  ensureCloudPickerDOM();
  _cp.mode = opts.mode || 'audio';
  _cp.onImport = opts.onImport || null;
  _cp.allowMulti = opts.allowMulti!=null ? !!opts.allowMulti : (_cp.mode==='audio');
  _cp.sel.clear(); updateCpHint();
  if(_cp.mode==='project' && (!_cp.curPath || _cp.curPath==='/' )){
    _cp.curPath = '/projects';
  }
  await cpLoad(_cp.curPath||'/');
  showModal('#cloudPickerModal');
  const hd=$('#cloudPickerModal .hd');
  if(hd){ hd.textContent = _cp.mode==='project' ? '프로젝트 저장소에서 불러오기' : 'Auditfy Cloud에서 불러오기'; }
  if(!openCloudPicker._bound){
    bind('#cpCancel','click', ()=> hideModal('#cloudPickerModal'));
    bind('#cpImport','click', cpImportSelected);
    bind('#cpUp','click', async ()=>{
      const p = _cp.curPath.replace(/\/+$/,'');
      const up = p.lastIndexOf('/')<=0 ? '/' : p.slice(0, p.lastIndexOf('/'));
      await cpLoad(up||'/');
    });
    bind('#cpNewFolder','click', async ()=>{
      const name = await inputModal({
        title:'새 폴더',
        label:'폴더 이름',
        placeholder:'예: 보이스 녹음',
        okText:'생성'
      });
      if(!name) return;
      try{
        if(!(await Cloud.mkdir(_cp.curPath, name)).ok) throw new Error('mkdir failed');
        await cpLoad(_cp.curPath);
      }catch(e){ snack('폴더 생성 실패'); }
    });
    openCloudPicker._bound=true;
  }
}
function updateCpHint(){ const el=$('#cpHint'); if(el) el.textContent=`선택 ${_cp.sel.size}`; }
async function cpLoad(path){
  _cp.curPath=path || '/';
  try{
    showLoading(true);
    const resp = await Cloud.list(_cp.curPath); // {ok, items:[{id,name,type,mime,size}], used, quota}
    if(!resp || !resp.ok){ snack('Cloud 목록을 불러올 수 없습니다'); return; }
    const folders = resp.items.filter(it=> it.type==='folder');
    const files = resp.items.filter(it=>{
      if (it.type !== 'file') return false;
      if(_cp.mode==='project'){
        return /\.(zip|auditfy\.project\.json|auditfy\.json)$/i.test(it.name || '');
      }
      const hasAudioMime = /^audio\//.test(it.mime || '');
      const hasAudioExt  = /\.(wav|mp3|m4a|aac|flac|ogg|oga|opus)$/i.test(it.name || '');
      return hasAudioMime || hasAudioExt;
    });
    _cp.folders = folders; _cp.files=files;

    const tree=$('#cpTree'); const list=$('#cpList');
    if(tree){ tree.innerHTML=''; folders.forEach(fd=>{
      const row=document.createElement('div'); row.className='fh-item'; row.innerHTML=`<div class="name">${fd.name}</div>`;
      row.addEventListener('click', ()=> cpLoad((_cp.curPath.replace(/\/+$/,'')==='/'?'':_cp.curPath.replace(/\/+$/,'')) + '/' + fd.name));
      tree.appendChild(row);
    }); }
    if(list){ list.innerHTML=''; files.forEach(fi=>{
      const row=document.createElement('div'); row.className='fh-item'; row.dataset.id=fi.id; row.dataset.name=fi.name;
      row.innerHTML=`<svg class="ic" viewBox="0 0 24 24"><path d="M8 6v10M12 6v8M16 6v12"/></svg><div class="name">${fi.name}</div>`;
      row.addEventListener('click', ()=>{
        if(!_cp.allowMulti){
          _cp.sel.clear();
          list.querySelectorAll('.fh-item.active').forEach(el=> el.classList.remove('active'));
        }
        if(_cp.sel.has(fi.id)){
          _cp.sel.delete(fi.id); row.classList.remove('active');
        }else{
          _cp.sel.add(fi.id); row.classList.add('active');
        }
        updateCpHint();
      });
      row.addEventListener('contextmenu', async (e)=>{
        e.preventDefault();
        const act = await simpleContext(e.clientX,e.clientY,[
          {k:'preview', t:'미리듣기'},
          {k:'rename', t:'이름 변경'},
          {k:'removeSel', t:'선택 해제'}
        ]);
        if(act==='preview'){ try{
            showLoading(true);
            const file = await Cloud.download(fi.id); // Blob or {blob,url}
            const blob = file?.blob || file;
            const url = file?.url || (blob ? URL.createObjectURL(blob) : null);
            if(!url) throw new Error('no url');
            const a=new Audio(url); a.controls=true; a.onended=()=> URL.revokeObjectURL?.(url);
            const body=$('#infoBody'); if(body) body.innerHTML=''; if(body) body.appendChild(a);
            showModal('#infoModal');
          }finally{ showLoading(false); } }
        if(act==='rename'){
          const nv = await inputModal({
            title:'이름 변경',
            label:'파일 이름',
            placeholder:'새 이름을 입력하세요',
            defaultValue:fi.name,
            okText:'저장'
          });
          if(!nv || nv === fi.name) return;
          try{ await Cloud.rename(fi.id, nv); await cpLoad(_cp.curPath); }catch{ snack('이름 변경 실패'); }
        }
        if(act==='removeSel'){ _cp.sel.delete(fi.id); row.classList.remove('active'); updateCpHint(); }
      });
      list.appendChild(row);
    }); }
    // 하단 상태바 경로 표시
    const st=$('#statusPath'); if(st) st.textContent = _cp.curPath || '/';
  }catch(e){
    err(e); snack('Cloud 오류');
  }finally{ showLoading(false); }
}
async function cpImportSelected(){
  if(!_cp.sel.size){ snack('선택된 파일이 없습니다'); return; }
  try{
    showLoading(true);
    if(_cp.mode==='project'){
      const id=[..._cp.sel][0];
      const item=_cp.files.find(f=>f.id===id);
      const got=await Cloud.download(id);
      let blob=got?.blob || got;
      let name=got?.name || item?.name || `auditfy_project_${Date.now()}.zip`;
      if (!blob || typeof blob === 'string' || got?.url) {
        const url = got?.url || (typeof blob === 'string' ? blob : null);
        if (!url) throw new Error('Cloud.download() returned no blob/url');
        const res = await fetch(url);
        blob = await res.blob();
      }
      const file = new File([blob], name, {type: blob.type || 'application/octet-stream'});
      if(/\.zip$/i.test(name)){
        await importProjectZip(file);
      }else{
        const text = await blob.text();
        const json = JSON.parse(text);
        loadProjectJSON(json);
      }
      state.dirty=false;
      _cp.sel.clear();
      updateCpHint();
      hideModal('#cloudPickerModal');
      return;
    }

    const files=[];
    for(const id of _cp.sel){
      const got  = await Cloud.download(id);
      let blob   = got?.blob || got;
      let name   = got?.name || (_cp.files.find(f=>f.id===id)?.name) || `cloud_${id}.wav`;

      if (!blob || typeof blob === 'string' || got?.url) {
        const url = got?.url || (typeof blob === 'string' ? blob : null);
        if (!url) throw new Error('Cloud.download() returned no blob/url');
        const res = await fetch(url);                  // CORS 허용된 URL
        blob = await res.blob();
      }
      files.push(new File([blob], name, { type: blob.type || 'audio/*' }));
    }
    await addFilesToHub(files);
    hideModal('#cloudPickerModal');
    _cp.sel.clear();
    updateCpHint();
  }catch(e){ err(e); snack('가져오기 실패'); }
  finally{ showLoading(false); }
}
function simpleContext(x,y,items){
  return new Promise(res=>{
    let m=document.getElementById('tmpCtx'); if(m) m.remove();
    m=document.createElement('div'); m.id='tmpCtx'; m.style.position='fixed'; m.style.left=x+'px'; m.style.top=y+'px';
    m.style.background='var(--bg-elev)'; m.style.border='1px solid var(--line)'; m.style.borderRadius='10px'; m.style.zIndex='300';
    m.innerHTML = items.map(it=>`<div class="mi" data-k="${it.k}" style="padding:8px 12px;border-bottom:1px dashed var(--line);cursor:pointer">${it.t}</div>`).join('');
    m.querySelectorAll('.mi').forEach(el=> el.addEventListener('click', ()=>{ const k=el.dataset.k; cleanup(); res(k);} ));
    const cleanup=()=>{ m.remove(); document.removeEventListener('click', onDoc); };
    const onDoc=(e)=>{ if(!m.contains(e.target)) { cleanup(); res(null); } };
    document.addEventListener('click', onDoc);
    document.body.appendChild(m);
  });
}

/////////////////////////////
// 계정 도크 렌더/로그아웃/Cloud 버튼
/////////////////////////////
async function renderAccountDock(forceRefresh=false){
  const dock=$('#accountDock'); if(!dock) return;
  const sess = await loadSession(!!forceRefresh);
  const plan = sess?.plan || 'Free';
  let html = '';
  if(sess){
    html += `
      <div class="row"><div class="title">안녕하세요, ${sess.name||'사용자'}님</div><div style="color:var(--fg-weak);font-size:12px">${plan} 플랜</div></div>
      <div class="row"><div id="dockCloud" class="btn">Auditfy Cloud 〉</div></div>
      <div class="row"><div id="dockLogout" class="btn" style="color:var(--danger);justify-content:center">로그아웃</div></div>
    `;
  }else{
    html += `
      <div class="row"><div class="title">Auditfy 계정</div><div style="color:var(--fg-weak);font-size:12px">로그인하면 Cloud 이용 가능</div></div>
      <div class="row" style="display:flex;gap:8px">
        <a class="btn grad" href="/auth.html?next=/index.html" style="flex:1;text-align:center">로그인</a>
        <a class="btn" href="/auth.html?next=/index.html#signup" style="flex:1;text-align:center">회원가입</a>
      </div>
    `;
  }
  dock.innerHTML = html;
  bind('#dockCloud','click', openCloudPicker);
  bind('#dockLogout','click', async()=>{
    try{ await Cloud.logout?.(); }
    catch(err){ console.warn('[Auditfy] 로그아웃 실패', err); }
    await loadSession(true);
    snack('로그아웃됨');
    renderAccountDock(true);
    syncAuthState(true);
  });
  syncAuthState();
}

/////////////////////////////
// 오디오 검사 & 파일 정리
/////////////////////////////
function runAudioAudit(){
  const body=$('#infoBody'); if(!body) return;
  let html = `<div style="display:grid;grid-template-columns:1fr 90px 90px;gap:6px">
    <div><b>파일</b></div><div><b>길이(s)</b></div><div><b>사용중</b></div>`;
  for(const f of state.files){
    const used = state.clips.some(c=> c.fileId===f.id);
    html += `<div>${f.name}</div><div>${(f.duration||0).toFixed(2)}</div><div>${used?'예':'아니오'}</div>`;
  }
  html += `</div>`;
  body.innerHTML = html;
  showModal('#infoModal');
}
async function cleanupUnusedFiles(){
  const unused = state.files.filter(f=> !state.clips.some(c=> c.fileId===f.id));
  if(unused.length===0){ snack('정리할 파일이 없습니다'); return; }
  const ok = await confirmModal(`타임라인에서 사용하지 않는 파일 ${unused.length}개를 삭제할까요?`);
  if(!ok) return;
  unused.forEach(u=>{
    const item = $(`.fh-item[data-id="${u.id}"]`); if(item) item.remove();
    URL.revokeObjectURL(u.url);
  });
  state.files = state.files.filter(f=> !unused.includes(f));
  snack(`${unused.length}개 정리됨`); state.dirty=true;
}

/////////////////////////////
// 로그인 여부
/////////////////////////////
function isLoggedIn(){ return !!getSessionSync(); }

function syncAuthState(force=false){
  loadSession(!!force).then(sess=>{
    const logged = !!sess;
    document.body.dataset.auth = logged ? 'user' : 'guest';
    $$('.cloudOnly').forEach(el=>{ el.style.display = logged ? '' : 'none'; });
    const status = $('#statusPath');
    if(status){
      if(!status.dataset.defaultText) status.dataset.defaultText = status.textContent || STATUS_TEXT.logged;
      status.textContent = logged ? status.dataset.defaultText : STATUS_TEXT.guest;
    }
  });
}

function requireLogin(next){
  if(isLoggedIn()){
    if(typeof next==='function') next();
    return true;
  }
  loadSession().then(sess=>{
    if(sess){
      if(typeof next==='function') next();
    }else{
      showModal('#loginRequiredModal');
    }
  });
  return false;
}

/////////////////////////////
// Cloud 업로드 유틸 & Export 모달 버튼 주입
/////////////////////////////
async function cloudUploadFile(path, blob, name){
  if(window.Cloud?.upload) return Cloud.upload(path, blob, name);
  if(window.Cloud?.putFile) return Cloud.putFile(path, name, blob);
  if(window.Cloud?.save)    return Cloud.save(path, name, blob);
  throw new Error('Cloud 업로드 API 없음');
}
/////////////////////////////
// 끝
/////////////////////////////
