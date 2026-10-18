'use strict';
const $=id=>document.getElementById(id);
const hosted=location.hostname.endsWith('.github.io');
let serverBase='',serverToken='',connected=false,connecting=false,rec=null,recordingStarting=false,queueDB,syncing=false,currentJob=null;
const memoryQueue=new Map();
let pairing;
let analysisSession='';
try{serverToken=sessionStorage.getItem('voice-session')||'';}catch{}
// A Safari/Home Screen session may block or isolate cookies and browser storage.
const linkCode=location.pathname.match(/^\/connect\/([^/]+)(?:\/|$)/)?.[1];
if(linkCode)serverToken=linkCode;
try { const value=new URLSearchParams(location.hash.slice(1)).get('pair'); if(value) pairing=JSON.parse(value); } catch {}
function notice(message,persistent=false){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(notice.timeout);if(!persistent)notice.timeout=setTimeout(()=>$('notice').hidden=true,6000);}
function safeAction(fn){return async event=>{try{await fn(event);}catch(e){notice(e.message);}};}
function showConnection(on){connected=on;$('connectionDot').classList.toggle('on',on);$('connectionText').textContent=on?'맥북에 연결됨':'맥북 연결 대기';}
async function request(path,options={}){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
  try{return await fetch(serverBase+path,{credentials:'same-origin',...options,signal:controller.signal,headers:{...options.headers,...(serverToken?{'Authorization':'Bearer '+serverToken}:{})}});}
  catch{showConnection(false);throw new Error('맥북 연결을 기다리고 있습니다. 녹음은 이 기기에 보관됩니다.');}
  finally{clearTimeout(timeout);}
}
async function api(path,body){const response=await request(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){if(response.status===401)showConnection(false);const error=new Error(data.error||'처리를 완료하지 못했습니다.');error.status=response.status;throw error;}return data;}
function renderAnalysis(analysis){
  const panel=$('analysisPanel');if(!panel)return;
  if(!analysis||(analysisSession&&analysis.session!==analysisSession)||rec||recordingStarting||(uploadMeter.total&&uploadMeter.confirmed<uploadMeter.total)){panel.hidden=true;return;}
  panel.hidden=false;$('analysisText').textContent=analysis.text;
  $('analysisTip').textContent=analysis.tip||'';$('analysisTip').hidden=!analysis.tip;
}
async function refresh(){const data=await api('/api/status');showConnection(true);renderAnalysis(data.analysis);if(!currentJob)$('ttsStatus').textContent=data.voice_ready?'':'몇 문장 녹음하면 목소리가 자동으로 준비됩니다.';return data;}
async function connect(){
  if(connecting)return;connecting=true;
  try{
    if(pairing?.code){const code=pairing.code;await api('/api/login',{code});serverToken=code;try{sessionStorage.setItem('voice-session',code);}catch{}pairing=null;history.replaceState(null,'',location.pathname+location.search);}
    await refresh();await syncQueue();
  }catch(e){$('connectionText').textContent=e.status===401?'개인 연결 링크로 열어주세요.':'맥북 연결 대기';}
  finally{connecting=false;}
}
function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('my-voice-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pending', {keyPath:'id'});
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function queueTransaction(mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = queueDB.transaction('pending', mode), request = action(transaction.objectStore('pending'));
    transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  });
}
async function queuedRows() {
  let stored=[];
  if(queueDB)stored=await queueTransaction('readonly',store=>store.getAll());
  return [...new Map([...stored,...memoryQueue.values()].map(row=>[row.id,row])).values()];
}
async function pendingCount() {
  let count=memoryQueue.size;
  try{count=(await queuedRows()).length;}catch{}
  $('pendingCount').textContent=count?`자동 전송 대기 ${count}개`:'';
  return count;
}
async function saveChunk(row,current) {
  // Safari can reject Blob values in IndexedDB. Store transferable WAV bytes instead.
  try{
    if(!queueDB)throw new Error('Storage unavailable');
    await queueTransaction('readwrite',store=>store.put(row));
  }catch{
    // Keep this page's bytes for direct upload; never launch a file download.
    memoryQueue.set(row.id,row);
    const bytes=[...memoryQueue.values()].reduce((n,item)=>n+(item.audio?.byteLength||item.blob?.size||0),0);
    if(bytes>=24*1024*1024){
      current.failed=true;
      notice('맥북 전송을 기다리며 녹음을 일시 중단합니다. 이 화면을 유지하면 자동으로 재전송합니다.',true);
      if(!current.stopping)void stopRecording().catch(error=>notice(error.message,true));
    }
  }
  trackUpload(row);uploadMeter.state='uploading';renderUpload();
  current.saved++;
  await pendingCount();
  void syncQueue();
}
function encodeWav(samples, rate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const write = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); }
  return new Blob([bytes], {type:'audio/wav'});
}
const uploadMeter={rows:new Map(),total:0,confirmed:0,current:0,state:'idle'};
function trackUpload(row){
  if(!uploadMeter.rows.has(row.id)){
    const bytes=row.audio?.byteLength||row.blob?.size||0;
    uploadMeter.rows.set(row.id,bytes);uploadMeter.total+=bytes;
  }
}
function renderUpload(){
  const panel=$('uploadPanel');if(!panel)return;
  panel.hidden=!uploadMeter.total;
  if(!uploadMeter.total)return;
  const complete=uploadMeter.confirmed>=uploadMeter.total;
  const percent=complete?100:Math.min(99,Math.floor(100*(uploadMeter.confirmed+uploadMeter.current)/uploadMeter.total));
  $('uploadProgress').value=percent;$('uploadPercent').textContent=percent+'%';
  const active=rec||recordingStarting;
  $('uploadText').textContent=complete?(active?'전송 완료 · 녹음 중':'전송 완료 · 맥북에 저장됨'):
    uploadMeter.state==='confirming'?'맥북 저장 확인 중':uploadMeter.state==='waiting'?'연결 대기 · 자동 재전송':'맥북으로 전송 중';
  $('uploadHint').textContent=complete?(active?'마지막 녹음은 종료 후 전송됩니다.':'화면을 닫아도 됩니다.'):'전송이 끝날 때까지 이 화면을 유지해주세요.';
}
function uploadRecording(row){
  trackUpload(row);uploadMeter.current=0;uploadMeter.state='uploading';renderUpload();
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST',serverBase+'/api/recordings');xhr.timeout=60000;
    xhr.setRequestHeader('Content-Type','audio/wav');xhr.setRequestHeader('X-Recording-ID',row.id);xhr.setRequestHeader('X-Session-ID',row.session);
    if(serverToken)xhr.setRequestHeader('Authorization','Bearer '+serverToken);
    xhr.upload.onprogress=event=>{
      if(event.lengthComputable){uploadMeter.current=Math.min(uploadMeter.rows.get(row.id),event.loaded);renderUpload();}
    };
    xhr.upload.onload=()=>{uploadMeter.state='confirming';renderUpload();};
    xhr.onload=()=>{
      uploadMeter.current=0;
      const ok=xhr.status>=200&&xhr.status<300;
      if(ok){if(!rec)analysisSession=row.session;uploadMeter.confirmed+=uploadMeter.rows.get(row.id);uploadMeter.rows.set(row.id,0);}
      else uploadMeter.state='waiting';
      renderUpload();resolve({ok,status:xhr.status});
    };
    xhr.onerror=xhr.ontimeout=xhr.onabort=()=>{
      uploadMeter.current=0;uploadMeter.state='waiting';showConnection(false);renderUpload();
      reject(new Error('연결 대기 중입니다. 녹음은 자동으로 재전송합니다.'));
    };
    xhr.send(row.audio||row.blob);
  });
}
async function syncQueue() {
  if (syncing || !connected) return;
  syncing = true;
  try {
    let pending;
    try{pending=await queuedRows();}catch{pending=[...memoryQueue.values()];}
    pending.forEach(trackUpload);renderUpload();
    for (const row of pending) {
      const response=await uploadRecording(row);
      if (!response.ok) {
        if (response.status === 401) { connected = false; showConnection(false); }
        throw new Error('녹음을 임시 보관 중입니다. 맥북 연결 후 자동 전송합니다.');
      }
      if(queueDB)await queueTransaction('readwrite', store => store.delete(row.id));
      memoryQueue.delete(row.id);
      await pendingCount();
    }
    if (pending.length) await refresh();
  } catch (error) { notice(error.message); } finally { syncing = false; await pendingCount(); }
}
async function startRecording() {
  if (rec || recordingStarting) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('마이크는 localhost 또는 HTTPS에서 사용할 수 있습니다. 맥북은 http://localhost:8840로 접속하세요.');
  await connect();
  if(!connected)throw new Error('맥북 연결이 필요합니다. 개인 연결 링크로 열어주세요.');
  if(memoryQueue.size)throw new Error('이전 녹음을 맥북으로 자동 전송 중입니다. 잠시 후 다시 시작해주세요.');
  if(!(await pendingCount())){uploadMeter.rows.clear();uploadMeter.total=0;uploadMeter.confirmed=0;uploadMeter.current=0;}
  recordingStarting = true;renderUpload(); $('startRecord').disabled = true;
  let stream, context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1, echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
    context = new AudioContext(); await context.resume(); await context.audioWorklet.addModule(new URL('recorder-worklet.js', location.href));
    const source = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'voice-recorder'), analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const session = crypto.randomUUID(), started = Date.now();
    rec = {context, source, node, analyser, stream, session, started, saving:Promise.resolve(), stopping:false, saved:0, failed:false};
    const current = rec;analysisSession=session;$('analysisPanel').hidden=true;
    node.port.onmessage = ({data}) => {
      if (data.samples) {
        const blob=encodeWav(data.samples,context.sampleRate);
        current.saving=current.saving.then(async()=>{
          const row={id:crypto.randomUUID(),session,audio:await blob.arrayBuffer()};
          await saveChunk(row,current);
        });
      }
      if (data.stopped) current.stoppedResolve?.();
    };
    source.connect(node); node.connect(context.destination); source.connect(analyser);
    current.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      $('timer').textContent = `${String(Math.floor(elapsed / 3600)).padStart(2,'0')}:${String(Math.floor(elapsed / 60) % 60).padStart(2,'0')}:${String(elapsed % 60).padStart(2,'0')}`;
    }, 1000);
    stream.getAudioTracks()[0].onended = () => { if (!current.stopping) { notice('마이크 연결이 끝났습니다. 받은 녹음을 저장합니다.'); void stopRecording(); } };
    context.onstatechange = () => { if (context.state === 'suspended' && !current.stopping) notice('기기가 녹음을 일시 중지했습니다. 화면을 열고 녹음을 종료한 뒤 다시 시작해주세요.', true); };
    $('stopRecord').disabled = false; $('recordState').textContent = '녹음 중'; document.body.classList.add('recording');
    if (navigator.storage?.persist) void navigator.storage.persist();
    if (navigator.wakeLock) { try { current.wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
    drawLive();
  } catch (error) { stream?.getTracks().forEach(t => t.stop()); if (context) await context.close(); rec = null; $('startRecord').disabled = false; throw new Error(`녹음을 시작하지 못했습니다. 마이크 권한을 확인해주세요. (${error.message})`); }
  finally { recordingStarting = false; }
}
async function stopRecording() {
  if (!rec || rec.stopping) return;
  const current = rec; current.stopping = true; $('stopRecord').disabled = true; $('recordState').textContent = '마지막 녹음 저장 중';
  $('uploadHint').textContent='마지막 녹음을 준비하고 있습니다. 이 화면을 유지해주세요.';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('마지막 오디오 조각을 받지 못했습니다. 이전에 자동 저장한 녹음은 보존됩니다.')), 5000);
      current.stoppedResolve = () => { clearTimeout(timeout); resolve(); };
      current.node.port.postMessage('stop');
      if (current.context.state === 'suspended') void current.context.resume();
    });
    await current.saving;
  } finally {
    clearInterval(current.timer); current.stream.getTracks().forEach(t => t.stop());
    current.source.disconnect(); current.node.disconnect(); await current.context.close();
    await current.wakeLock?.release(); rec = null;renderUpload();
    $('startRecord').disabled = false; document.body.classList.remove('recording');
    $('recordState').textContent = current.failed ? '자동 전송 대기' : '녹음 종료'; drawLive();
  }
  await syncQueue();notice(await pendingCount()?'맥북 연결 후 자동 전송합니다. 이 화면을 유지해주세요.':'맥북에 녹음을 저장했습니다.');
}
function canvasSetup(canvas) {
  const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; }
  const context = canvas.getContext('2d'); context.setTransform(ratio,0,0,ratio,0,0); context.clearRect(0,0,width,height);
  return {context, width, height};
}
function drawLive() {
  const {context, width, height} = canvasSetup($('liveWave'));
  const data = new Uint8Array(64);
  if (rec) rec.analyser.getByteTimeDomainData(data); else data.fill(128);
  context.strokeStyle = '#8aab72'; context.lineWidth = 2; context.beginPath();
  data.forEach((value, i) => { const x = i / (data.length-1) * width, y = height / 2 + (value-128) / 128 * height / 2; i ? context.lineTo(x,y) : context.moveTo(x,y); }); context.stroke();
  if (rec) requestAnimationFrame(drawLive);
}
$('startRecord').onclick=safeAction(startRecording);$('stopRecord').onclick=safeAction(stopRecording);
$('speak').onclick=safeAction(async()=>{
  const text=$('ttsText').value.trim();if(!text){$('ttsText').focus();return;}
  $('speak').disabled=true;$('ttsAudio').pause();$('ttsAudio').hidden=true;$('ttsStatus').textContent='음성 생성 중…';
  try{
    const result=await api('/api/tts',{text});currentJob=result.id;
    while(true){
      await new Promise(resolve=>setTimeout(resolve,2000));
      const job=await api('/api/jobs/'+currentJob);
      if(job.status==='error')throw new Error(job.error);
      if(job.status==='done'){
        if($('ttsAudio').src.startsWith('blob:'))URL.revokeObjectURL($('ttsAudio').src);
        const response=await request(job.audio);if(!response.ok)throw new Error('생성한 음성을 불러오지 못했습니다.');
        $('ttsAudio').src=URL.createObjectURL(await response.blob());$('ttsAudio').hidden=false;$('ttsStatus').textContent='';
        try{await $('ttsAudio').play();}catch{$('ttsStatus').textContent='아래 오디오의 재생 버튼을 눌러주세요.';}break;
      }
    }
  }catch(e){$('ttsStatus').textContent=e.message;}
  finally{currentJob=null;$('speak').disabled=false;}
});
window.addEventListener('online',()=>void connect());
window.addEventListener('hashchange',()=>{if(location.hash.startsWith('#pair='))location.reload();});
window.addEventListener('beforeunload',event=>{if(rec||Number($('pendingCount').textContent.match(/\d+/)?.[0])){event.preventDefault();event.returnValue='';}});
setInterval(()=>{if(!hosted)void connect();},5000);
(async()=>{
  if(hosted){
    try{
      const response=await fetch('./server-config.json',{cache:'no-store'});const config=await response.json();
      const destination=new URL(pairing?.server||config.server);
      if(destination.protocol!=='https:'||destination.username||destination.password)throw new Error('HTTPS required');
      if(pairing?.code){
        serverBase=destination.origin;serverToken=pairing.code;
        queueDB=await openQueue();const count=await pendingCount();
        if(count){await api('/api/login',{code:pairing.code});connected=true;await syncQueue();if(await pendingCount())return;}
      }
      location.replace(destination.origin+'/'+location.hash);return;
    }catch{$('connectionText').textContent='맥북 연결 준비 중';}
  }
  try{queueDB=await openQueue();await pendingCount();}catch{queueDB=null;}
  drawLive();if(!hosted)await connect();
})();
