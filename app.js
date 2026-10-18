'use strict';
const $ = id => document.getElementById(id);
const hosted = location.hostname.endsWith('.github.io');
let serverBase = hosted ? (localStorage.getItem('voice-server') || 'http://127.0.0.1:8840') : '';
let serverToken = hosted ? (sessionStorage.getItem('voice-token') || '') : '';
const audioURLs = new Set();
const emotions = {neutral:'일상', happy:'기쁨', question:'의문', surprise:'감탄', calm:'차분함', sad:'슬픔', firm:'단호함'};
let appState = null, connected = false, rec = null, recordingStarting = false, audioBuffer = null, sourceUrl = null;
let queueDB, syncing = false, selectedRecording = '', selectionToken = 0, previewTimer, currentJob, trainingJob;
const practice = ['딱딱한 땅콩 껍질을 꼭꼭 눌렀다.', '정말? 벌써 봄이 왔다고?', '우와! 이렇게 아름다울 수가 있어!', '빨간 꽃과 파란 꽃이 나란히 피었어요.', '괜찮아. 오늘은 천천히 쉬어도 돼.', '밖에 있는 책을 읽고 같이 걸을까?', '쌀쌀한 새벽, 짧은 꿈을 꿨어요.'];
let practiceIndex = 0;
function notice(message, persistent = false) {
  $('notice').textContent = message; $('notice').hidden = false;
  clearTimeout(notice.timeout);
  if (!persistent) notice.timeout = setTimeout(() => $('notice').hidden = true, 6500);
}
function safeAction(fn) { return async event => { try { await fn(event); } catch (error) { notice(error.message); } }; }
async function api(path, body, options = {}) {
  const response = await request(path, {...options,
    ...(body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json', ...options.headers}, body:JSON.stringify(body)})});
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { connected = false; showConnection(false); $('settingsPanel').hidden = false; }
    throw new Error(data.error || '요청을 처리하지 못했습니다.');
  }
  return data;
}
async function request(path, options = {}) {
  try {
    return await fetch(serverBase + path, {credentials:'same-origin', ...options,
      headers:{...options.headers, ...(serverToken ? {'Authorization':'Bearer '+serverToken} : {})}});
  } catch {
    showConnection(false);
    throw new Error('맥북 서버에 연결하지 못했습니다. 서버 실행 상태와 주소를 확인하고, 브라우저의 로컬 네트워크 접근을 허용해주세요.');
  }
}
async function audioURL(path, track = false) {
  if (!hosted) return path;
  const response = await request(path);
  if (!response.ok) throw new Error('음성을 불러오지 못했습니다. 연결 코드를 다시 입력해주세요.');
  const url = URL.createObjectURL(await response.blob()); if (track) audioURLs.add(url); return url;
}
function showConnection(on) { $('connectionDot').classList.toggle('on', on); $('connectionText').textContent = on ? '맥북에 연결됨' : '맥북 연결 필요'; }
function formatSeconds(value) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
function dateLabel(value) { return new Date(value * 1000).toLocaleString('ko-KR', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}); }
async function refresh() {
  appState = await api('/api/state'); connected = true; showConnection(true);
  $('dataPath').textContent = appState.data_dir;
  const minutes = appState.recordings.reduce((sum, r) => sum + r.duration, 0) / 60;
  const approved = appState.clips.filter(c => c.approved);
  $('totalDuration').replaceChildren(document.createTextNode(minutes.toFixed(1)), Object.assign(document.createElement('span'), {textContent:'분'}));
  $('clipCount').replaceChildren(document.createTextNode(String(approved.length)), Object.assign(document.createElement('span'), {textContent:'개'}));
  $('emotionCount').replaceChildren(document.createTextNode(String(new Set(approved.map(c => c.emotion)).size)), Object.assign(document.createElement('span'), {textContent:'/ 7'}));
  $('voiceStatus').textContent = appState.reference ? '참조 목소리 준비됨' : appState.recordings.length ? '목소리를 모으는 중' : '첫 녹음 기다리는 중';
  const select = $('recordingSelect'), previous = select.value;
  select.replaceChildren(new Option(appState.recordings.length ? '편집할 녹음을 골라주세요' : '아직 녹음이 없어요', ''));
  for (const r of appState.recordings) select.add(new Option(`${dateLabel(r.created)} · ${formatSeconds(r.duration)}`, r.id));
  if (appState.recordings.some(r => r.id === previous)) select.value = previous;
  renderClips();
  $('profileSelect').replaceChildren(new Option('기본 모델 · 참조 음성 복제', ''));
  for (const p of appState.profiles) $('profileSelect').add(new Option(`${dateLabel(p.created)} · ${p.samples}개 · ${p.steps}스텝 · 청취 검증 필요`, p.id));
  $('profileSelect').value = appState.active_profile;
  if (!trainingJob) {
    $('trainingStatus').textContent = appState.training_ready ? `학습 엔진 준비됨 · 완료 모델 ${appState.profiles.length}개` : 'scripts/setup-training.sh로 추가 학습 엔진을 설치해주세요.';
    const running = appState.active_jobs.find(j => j.kind === 'train');
    if (running) void watchTraining(running.id);
  }
  if (!currentJob) $('ttsStatus').textContent = !appState.engine_ready ? '음성 엔진 설치가 필요합니다. scripts/setup-tts.sh를 실행하세요.' : appState.reference ? '로컬 엔진 준비 · 처음 생성할 때 모델을 다운로드하므로 시간이 걸립니다.' : '검수한 학습 구간을 참조 목소리로 먼저 지정해주세요.';
}
function renderClips() {
  const list = $('clipList');
  if (!appState.clips.length) return;
  for (const url of audioURLs) URL.revokeObjectURL(url);
  audioURLs.clear();
  list.replaceChildren();
  for (const c of appState.clips) {
    const item = document.createElement('article'); item.className = 'clip-item';
    const content = document.createElement('div');
    const text = document.createElement('p'); text.textContent = c.text || '대본 없는 보관 구간';
    const meta = document.createElement('span'); meta.className = 'small';
    const quality = c.peak > .98 ? ' · 소리 포화 주의' : c.rms < .008 ? ' · 음량이 작아요' : '';
    meta.textContent = `${emotions[c.emotion]} · ${(c.end-c.start).toFixed(1)}초 · ${c.approved ? '검수 완료' : '보관용'} · ${c.split === 'train' ? '학습용' : '평가용'}${c.tags ? ' · '+c.tags : ''}${quality}`;
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
    if (hosted) {
      audio.hidden = true;
      const load = document.createElement('button'); load.className = 'text-button'; load.textContent = '▷ 음성 듣기';
      load.onclick = safeAction(async () => { audio.src = await audioURL(`/audio/clips/${c.id}.wav`, true); audio.hidden = false; load.hidden = true; await audio.play(); });
      content.append(text, meta, load, audio);
    } else { audio.src = `/audio/clips/${c.id}.wav`; content.append(text, meta, audio); }
    const actions = document.createElement('div'); actions.className = 'clip-actions';
    const button = document.createElement('button'); button.textContent = c.id === appState.reference ? '✓ 참조 목소리' : '참조로 지정';
    button.classList.toggle('selected', c.id === appState.reference); button.disabled = !c.approved || c.split !== 'train';
    button.addEventListener('click', safeAction(async () => { await api('/api/reference', {id:c.id}); await refresh(); notice('참조 목소리를 지정했습니다.'); }));
    actions.append(button); item.append(content, actions); list.append(item);
  }
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
async function pendingCount() {
  const count = await queueTransaction('readonly', store => store.count());
  $('pendingCount').textContent = count ? `기기에 업로드 대기 ${count}개` : '모든 녹음 저장됨';
  return count;
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
async function syncQueue() {
  if (syncing || !queueDB || !connected) return;
  syncing = true;
  try {
    const pending = await queueTransaction('readonly', store => store.getAll());
    for (const row of pending) {
      const response = await request('/api/recordings', {method:'POST', body:row.blob,
        headers:{'Content-Type':'audio/wav', 'X-Recording-ID':row.id, 'X-Session-ID':row.session}});
      if (!response.ok) {
        if (response.status === 401) { connected = false; showConnection(false); }
        throw new Error('녹음이 기기에 보관 중입니다. 맥북 연결 후 다시 업로드해주세요.');
      }
      await queueTransaction('readwrite', store => store.delete(row.id));
      await pendingCount();
    }
    if (pending.length) await refresh();
  } catch (error) { notice(error.message); } finally { syncing = false; await pendingCount(); }
}
async function startRecording() {
  if (rec || recordingStarting) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('마이크는 localhost 또는 HTTPS에서 사용할 수 있습니다. 맥북은 http://localhost:8840로 접속하세요.');
  if (!queueDB) throw new Error('브라우저 저장소를 사용할 수 없습니다. 저장소 사용을 허용해주세요.');
  recordingStarting = true; $('startRecord').disabled = true;
  let stream, context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1, echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
    context = new AudioContext(); await context.resume(); await context.audioWorklet.addModule(new URL('recorder-worklet.js', location.href));
    const source = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'voice-recorder'), analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const session = crypto.randomUUID(), started = Date.now();
    rec = {context, source, node, analyser, stream, session, started, saving:Promise.resolve(), stopping:false, saved:0, failed:false};
    const current = rec;
    node.port.onmessage = ({data}) => {
      if (data.samples) {
        const blob = encodeWav(data.samples, context.sampleRate), row = {id:crypto.randomUUID(), session, blob};
        current.saving = current.saving.then(async () => {
          try { await queueTransaction('readwrite', store => store.put(row)); current.saved++; await pendingCount(); void syncQueue(); }
          catch (error) {
            // Retain the failed chunk as a downloadable file if IndexedDB fills up.
            current.failed = true;
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `recovered-${row.id}.wav`; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 60000);
            notice('브라우저 저장공간이 부족합니다. 복구 WAV를 다운로드했습니다. 녹음을 중단합니다.', true);
            if (!current.stopping) void stopRecording();
          }
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
    await current.wakeLock?.release(); rec = null;
    $('startRecord').disabled = false; document.body.classList.remove('recording');
    $('recordState').textContent = current.failed ? '저장 오류 · 복구 파일 확인' : '녹음 종료'; drawLive();
  }
  await syncQueue(); notice('녹음을 종료했습니다. 아래에서 필요한 구간을 골라주세요.');
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
async function selectRecording() {
  const token = ++selectionToken; selectedRecording = $('recordingSelect').value; audioBuffer = null;
  $('saveClip').disabled = true; $('previewClip').disabled = true; $('sourceAudio').hidden = true;
  clearTimeout(previewTimer); $('sourceAudio').pause();
  if (sourceUrl) { URL.revokeObjectURL(sourceUrl); sourceUrl = null; }
  drawEditor(); if (!selectedRecording) return;
  const response = await request(`/audio/recordings/${selectedRecording}.wav`);
  if (!response.ok) throw new Error('녹음 파일을 불러오지 못했습니다.');
  const blob = await response.blob(), ctx = new AudioContext();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { await ctx.close(); }
  if (token !== selectionToken) return;
  audioBuffer = decoded; sourceUrl = URL.createObjectURL(blob); $('sourceAudio').src = sourceUrl; $('sourceAudio').hidden = false;
  $('clipStart').value = 0; $('clipEnd').value = Math.min(10, audioBuffer.duration).toFixed(2);
  $('clipEnd').max = $('clipStart').max = audioBuffer.duration;
  $('saveClip').disabled = false; $('previewClip').disabled = false; drawEditor();
}
function drawEditor() {
  const {context, width, height} = canvasSetup($('editWave'));
  $('waveEmpty').style.display = audioBuffer ? 'none' : '';
  if (!audioBuffer) return;
  const samples = audioBuffer.getChannelData(0), step = Math.max(1, Math.floor(samples.length / width));
  context.fillStyle = '#dce8cf';
  const startX = Number($('clipStart').value) / audioBuffer.duration * width, endX = Number($('clipEnd').value) / audioBuffer.duration * width;
  context.fillRect(startX,0,endX-startX,height); context.strokeStyle = '#8ba772'; context.lineWidth = 1;
  context.beginPath();
  for (let x = 0; x < width; x += 2) {
    let peak = 0; for (let j = x * step; j < Math.min((x+2)*step,samples.length); j++) peak = Math.max(peak, Math.abs(samples[j]));
    const h = Math.max(1, peak * height * .9); context.moveTo(x,(height-h)/2); context.lineTo(x,(height+h)/2);
  }
  context.stroke(); context.fillStyle = '#6e8b57'; context.fillRect(startX,0,2,height); context.fillRect(endX-2,0,2,height);
}
let dragStart;
$('editWave').addEventListener('pointerdown', event => {
  if (!audioBuffer) return;
  const box = event.currentTarget.getBoundingClientRect(); dragStart = Math.max(0,Math.min(audioBuffer.duration,(event.clientX-box.left)/box.width*audioBuffer.duration));
  event.currentTarget.setPointerCapture(event.pointerId);
});
$('editWave').addEventListener('pointermove', event => {
  if (dragStart === undefined || !audioBuffer) return;
  const box = event.currentTarget.getBoundingClientRect(), position = Math.max(0,Math.min(audioBuffer.duration,(event.clientX-box.left)/box.width*audioBuffer.duration));
  $('clipStart').value = Math.min(dragStart,position).toFixed(2); $('clipEnd').value = Math.max(dragStart,position).toFixed(2); drawEditor();
});
for (const name of ['pointerup','pointercancel']) $('editWave').addEventListener(name, () => { dragStart = undefined; });
for (const id of ['clipStart','clipEnd']) $(id).addEventListener('input', drawEditor);
$('settingsToggle').onclick = () => $('settingsPanel').hidden = !$('settingsPanel').hidden;
$('loginForm').addEventListener('submit', safeAction(async event => {
  event.preventDefault();
  if (hosted) {
    connected = false;
    const address = new URL($('serverAddress').value);
    if (address.username || address.password || address.search || address.hash || !['http:', 'https:'].includes(address.protocol)) throw new Error('인증정보 없이 http:// 또는 https:// 서버 주소를 입력해주세요.');
    if (address.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(address.hostname)) throw new Error('다른 기기의 맥북 주소는 HTTPS를 사용해주세요.');
    serverBase = address.origin; serverToken = '';
  }
  const code = $('connectionCode').value;
  await api('/api/login',{code});
  if (hosted) { serverToken = code; sessionStorage.setItem('voice-token', code); localStorage.setItem('voice-server', serverBase); }
  $('connectionCode').value = '';
  await refresh(); $('settingsPanel').hidden = true; await syncQueue(); notice('맥북에 연결했습니다.');
}));
$('startRecord').onclick = safeAction(startRecording); $('stopRecord').onclick = safeAction(stopRecording);
$('retryUpload').onclick = safeAction(async () => { await refresh(); await syncQueue(); });
$('refresh').onclick = safeAction(refresh); $('recordingSelect').onchange = safeAction(selectRecording);
$('promptButton').onclick = () => { practiceIndex = (practiceIndex+1)%practice.length; $('practiceText').textContent = practice[practiceIndex]; };
$('previewClip').onclick = safeAction(async () => {
  const start = Number($('clipStart').value), end = Number($('clipEnd').value);
  if (!(end > start && start >= 0 && end <= audioBuffer.duration + .01)) throw new Error('올바른 시작·종료 시간을 지정해주세요.');
  clearTimeout(previewTimer); $('sourceAudio').currentTime = start; await $('sourceAudio').play();
  previewTimer = setTimeout(() => $('sourceAudio').pause(), (end-start)*1000);
});
$('saveClip').onclick = safeAction(async () => {
  if (!selectedRecording || !audioBuffer) return;
  $('saveClip').disabled = true;
  try {
    await api('/api/clips', {recording_id:selectedRecording, start:Number($('clipStart').value), end:Number($('clipEnd').value),
      text:$('transcript').value, emotion:$('clipEmotion').value, tags:$('clipTags').value, approved:$('approved').checked});
    await refresh(); $('transcript').value = ''; $('approved').checked = false; notice('선택한 구간을 맥북에 저장했습니다.');
  } finally { $('saveClip').disabled = false; }
});
$('exportDataset').onclick = safeAction(async () => { const result = await api('/api/export',{}); notice(`${result.message} · ${result.path}`, true); });
async function watchTraining(id) {
  if (trainingJob) return;
  trainingJob = id; $('train').disabled = true; $('cancelTrain').hidden = false; $('trainingProgress').hidden = false;
  try {
    while (true) {
      const job = await api('/api/jobs/'+id);
      $('trainingStatus').textContent = job.status === 'done' ? '학습 완료. 모델을 선택하고 같은 문장으로 비교해주세요.' : '맥북에서 추가 학습 중… 학습 로그를 아래에 표시합니다.';
      $('trainingProgress').textContent = job.progress || '모델과 음성 데이터를 준비하고 있습니다.';
      if (job.status === 'error') throw new Error(job.error);
      if (job.status === 'done') { await refresh(); notice('추가 학습을 마쳤습니다. 적용할 모델을 직접 선택해주세요.'); break; }
      await new Promise(resolve => setTimeout(resolve,3000));
    }
  } catch (error) { $('trainingStatus').textContent = error.message; notice(error.message); }
  finally { trainingJob = null; $('train').disabled = false; $('cancelTrain').hidden = true; }
}
$('train').onclick = safeAction(async () => { const result = await api('/api/train', {steps:Number($('trainingSteps').value)}); await watchTraining(result.id); });
$('cancelTrain').onclick = safeAction(async () => { await api('/api/train/cancel',{id:trainingJob}); notice('학습 중단을 요청했습니다. 이전 모델과 원본은 보존됩니다.'); });
$('profileSelect').onchange = safeAction(async () => { await api('/api/profile',{id:$('profileSelect').value}); await refresh(); notice('재생 모델을 변경했습니다.'); });
$('speak').onclick = safeAction(async () => {
  $('speak').disabled = true; $('feedbackPanel').hidden = true; $('ttsAudio').pause(); $('ttsAudio').hidden = true;
  $('ttsStatus').textContent = '내 목소리를 생성하고 있어요. 첫 실행에는 모델 다운로드가 필요합니다.';
  try {
    const result = await api('/api/tts',{text:$('ttsText').value,emotion:$('ttsEmotion').value}); currentJob = result.id;
    let failures = 0;
    while (true) {
      await new Promise(resolve => setTimeout(resolve,2500));
      let job;
      try { job = await api('/api/jobs/'+currentJob); failures = 0; }
      catch (error) { if (++failures >= 5) throw error; $('ttsStatus').textContent = '맥북에 다시 연결하는 중… 생성 작업은 맥북에서 계속됩니다.'; continue; }
      if (job.status === 'error') throw new Error(job.error);
      if (job.status === 'done') {
        if ($('ttsAudio').src.startsWith('blob:')) URL.revokeObjectURL($('ttsAudio').src);
        $('ttsAudio').src = await audioURL(job.audio); $('ttsAudio').hidden = false; $('feedbackPanel').hidden = false;
        $('ttsStatus').textContent = '생성이 끝났어요. 발음과 억양을 듣고 개선 메모를 남겨주세요.';
        try { await $('ttsAudio').play(); } catch { $('ttsStatus').textContent += ' 오디오의 재생 버튼을 눌러주세요.'; }
        break;
      }
    }
  } catch (error) { $('ttsStatus').textContent = error.message; throw error; }
  finally { $('speak').disabled = false; }
});
$('saveFeedback').onclick = safeAction(async () => {
  await api('/api/feedback',{job_id:currentJob,rating:Number($('rating').value),note:$('feedbackNote').value});
  $('feedbackNote').value = ''; notice('평가를 저장했습니다. 개선 기록은 맥북 데이터베이스에 누적됩니다.');
});
window.addEventListener('online', () => { if (!hosted || serverToken) void refresh().then(syncQueue).catch(() => {}); });
window.addEventListener('resize', () => { drawEditor(); if (!rec) drawLive(); });
window.addEventListener('beforeunload', event => { if (rec || Number($('pendingCount').textContent.match(/\d+/)?.[0])) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { void syncQueue(); },15000);
(async () => {
  try { queueDB = await openQueue(); await pendingCount(); } catch { notice('브라우저 저장소를 사용할 수 없어 녹음할 수 없습니다.',true); $('startRecord').disabled = true; }
  drawLive(); drawEditor();
  if (hosted) {
    $('serverAddressRow').hidden = false; $('serverAddress').value = serverBase;
    $('settingsPanel').hidden = false;
    $('ttsStatus').textContent = 'GitHub 배포 화면입니다. 맥북 서버 주소와 연결 코드를 입력하면 저장·학습·재생을 사용할 수 있습니다.';
    if (!serverToken) { showConnection(false); return; }
  }
  try { await refresh(); await syncQueue(); } catch (error) { notice(error.message); }
})();
