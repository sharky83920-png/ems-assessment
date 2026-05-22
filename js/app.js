// app.js — 主應用邏輯
// 角色路由用 URL hash：
//   #/         啟動頁
//   #/i/XXXX   教官端（XXXX 為教室代碼）
//   #/s/XXXX   學員端

let PROTOCOLS = null;
const state = {
  role: null,          // 'admin' | 'teach' | 'student'
  roomCode: null,
  protocolId: 'medical',
  currentStepId: null,
  sync: null,
  broadcasting: true,
  voiceUtterance: null,
  studentVoiceUnlocked: false, // 教官端控制：學員是否能朗讀（預設鎖定）
};

// 學員端記住的全域語音鎖狀態
let studentVoiceUnlocked = false;
// 大螢幕模式：忽略教官端的語音鎖、總是出聲
let bigScreenMode = false;

// ============= 啟動 =============
async function init() {
  try {
    const res = await fetch('data/protocols.json');
    PROTOCOLS = await res.json();
  } catch (e) {
    alert('無法載入 protocols.json：' + e.message);
    return;
  }
  // 啟動內容同步（會自動接 Firebase 或退回 local）
  ContentSync.init();
  // 當內容雲端變動時，重新渲染目前畫面 + 推送給學員
  ContentSync.subscribeContentChange(() => {
    if (!document.getElementById('view-instructor').classList.contains('hidden')) {
      renderStepList();
      if (state.currentStepId) renderStepDetail();
    }
    if (!document.getElementById('view-teach').classList.contains('hidden')) {
      renderTeachDock();
      updateTeachDockActive();
    }
    // 學員端：自己也是訂閱者，畫面需要重新渲染
    if (!document.getElementById('view-student').classList.contains('hidden') && state.lastStudentMsg) {
      // 用快取的 stepId 重新整理畫面（如果學員端有當前步驟）
      handleSyncMessage({ ...state.lastStudentMsg, _refresh: true });
    }
    // 教官端：把當前步驟重新廣播一次，讓學員拿到新內容
    if ((state.role === 'admin' || state.role === 'teach') && state.currentStepId && state.broadcasting) {
      broadcastCurrentStep(false);
    }
  });

  setTimeout(() => {
    const indicator = document.getElementById('sync-mode-indicator');
    if (indicator) {
      try { const test = Sync.create('PROBE'); test.destroy(); } catch {}
      const cloudMode = Sync.getSyncMode() === 'cloud' && ContentSync.isCloudMode();
      indicator.textContent = cloudMode
        ? '☁️ 雲端同步 · 內容與訊號都跨裝置即時同步'
        : '💻 本機模式 · 僅當下瀏覽器有效';
    }
  }, 600);
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);

  // 匯入檔監聽
  const importInput = document.getElementById('import-file');
  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await Storage.importAllData(data);
        alert('匯入完成，重新整理頁面以套用。');
        location.reload();
      } catch (err) {
        alert('匯入失敗：' + err.message);
      }
    });
  }
}

function routeFromHash() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/([istb])\/([A-Z0-9]{4})$/);
  if (m) {
    const roleMap = { i: 'admin', t: 'teach', s: 'student', b: 'bigscreen' };
    const role = roleMap[m[1]];
    const room = m[2];
    enterRoom(role, room);
  } else {
    showView('home');
  }
}

function showView(name) {
  ['home', 'instructor', 'teach', 'student'].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name);
  });
}

// ============= 進入角色 =============
function enterRole(role) {
  if (role === 'teach') {
    const code = Sync.generateRoomCode();
    location.hash = `#/t/${code}`;
  } else if (role === 'admin') {
    const code = Sync.generateRoomCode();
    location.hash = `#/i/${code}`;
  } else if (role === 'bigscreen') {
    promptStudentJoin('bigscreen');
  } else {
    promptStudentJoin('student');
  }
}

// 從上課模式切換到後台（保留同一個 room）
function switchToAdmin() {
  if (!state.roomCode) return;
  location.hash = `#/i/${state.roomCode}`;
}

// 從後台切回上課模式
function switchToTeach() {
  if (!state.roomCode) return;
  location.hash = `#/t/${state.roomCode}`;
}

let pendingJoinMode = 'student'; // 'student' | 'bigscreen'

function promptStudentJoin(mode = 'student') {
  pendingJoinMode = mode;
  document.getElementById('join-room-input').value = '';
  const title = document.querySelector('#modal-join h2');
  if (title) title.textContent = mode === 'bigscreen' ? '大螢幕加入教室' : '加入教室';
  document.getElementById('modal-join').classList.remove('hidden');
  setTimeout(() => document.getElementById('join-room-input').focus(), 50);
}

function confirmJoin() {
  const code = document.getElementById('join-room-input').value.toUpperCase().trim();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    alert('請輸入 4 位英數代碼');
    return;
  }
  closeModal('modal-join');
  const prefix = pendingJoinMode === 'bigscreen' ? 'b' : 's';
  location.hash = `#/${prefix}/${code}`;
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function enterRoom(role, roomCode) {
  // 切換模式時重用同一個 sync（避免斷線）
  if (state.sync && state.roomCode !== roomCode) {
    state.sync.destroy();
    state.sync = null;
  }
  state.role = role;
  state.roomCode = roomCode;
  if (!state.sync) state.sync = Sync.create(roomCode);

  if (role === 'admin') {
    document.getElementById('instructor-room-code').textContent = roomCode;
    showView('instructor');
    renderStepList();
    if (!state.currentStepId) {
      const steps = getMergedSteps(state.protocolId);
      if (steps.length) selectStep(steps[0].id);
    } else {
      selectStep(state.currentStepId);
    }
  } else if (role === 'teach') {
    document.getElementById('teach-room-code').textContent = roomCode;
    document.querySelectorAll('.protocol-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.protocol === state.protocolId);
    });
    showView('teach');
    renderTeachDock();
    if (state.currentStepId) {
      updateTeachDockActive();
      if (state.broadcasting) broadcastCurrentStep();
    }
  } else {
    // student 或 bigscreen 都共用學員視圖，差別只在音訊
    bigScreenMode = (role === 'bigscreen');
    document.getElementById('student-room-code').textContent = roomCode;
    document.body.classList.toggle('mode-bigscreen', bigScreenMode);
    const unlockOverlay = document.getElementById('bigscreen-unlock');
    if (unlockOverlay) {
      unlockOverlay.classList.toggle('hidden', !bigScreenMode || window.__studentInteracted);
    }
    showView('student');
    state.sync.onMessage(handleSyncMessage);
  }
}

function leaveRoom() {
  if (state.sync) { state.sync.destroy(); state.sync = null; }
  if (state.voiceUtterance) { window.speechSynthesis.cancel(); state.voiceUtterance = null; }
  state.role = null;
  state.roomCode = null;
  location.hash = '#/';
}

// ============= 教官：步驟列表渲染 =============
function switchProtocol(protocolId) {
  state.protocolId = protocolId;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.protocol === protocolId);
  });
  renderStepList();
  const steps = getMergedSteps(protocolId);
  if (steps.length) selectStep(steps[0].id);
}

function renderStepList() {
  const list = document.getElementById('step-list');
  const steps = getMergedSteps(state.protocolId);
  const isTrauma = state.protocolId === 'trauma';
  list.innerHTML = steps.map((step, idx) => {
    const merged = getMergedStep(step);
    return `
      <li class="step-item ${isTrauma ? 'trauma' : ''}" data-step-id="${step.id}">
        <span class="step-num">${step.order}</span>
        <span class="step-title-small" onclick="selectStep('${step.id}')">${escapeHtml(merged.title)}</span>
        <span class="step-actions">
          <button class="step-action-btn" title="上移" onclick="moveStep('${step.id}', -1)" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button class="step-action-btn" title="下移" onclick="moveStep('${step.id}', 1)" ${idx === steps.length - 1 ? 'disabled' : ''}>▼</button>
        </span>
      </li>
    `;
  }).join('') + `
    <li class="step-add-row">
      <button class="step-add-btn" onclick="addNewStep()">＋ 新增步驟</button>
    </li>
  `;
}

function selectStep(stepId) {
  state.currentStepId = stepId;
  document.querySelectorAll('.step-item').forEach(el => {
    el.classList.toggle('active', el.dataset.stepId === stepId);
  });
  if (!document.getElementById('view-instructor').classList.contains('hidden')) {
    renderStepDetail();
  }
  if (!document.getElementById('view-teach').classList.contains('hidden')) {
    updateTeachDockActive();
  }
  if (state.broadcasting) broadcastCurrentStep(false);
}

// ============= 教官上課模式：渲染 =============
function renderTeachDock() {
  const dock = document.getElementById('teach-step-dock');
  if (!dock) return;
  const steps = getMergedSteps(state.protocolId);
  const isTrauma = state.protocolId === 'trauma';
  dock.innerHTML = steps.map(s => {
    const merged = getMergedStep(s);
    const hasVoice = !!(merged.voiceScript && merged.voiceScript.trim());
    return `
      <div class="dock-cell ${isTrauma ? 'trauma' : ''}" role="button" tabindex="0"
           data-step-id="${s.id}"
           onclick="selectStep('${s.id}')"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectStep('${s.id}')}">
        <button class="dock-cell-voice" title="播放此步驟的口述語音"
                onclick="event.stopPropagation(); playStepVoice('${s.id}')"
                ${hasVoice ? '' : 'disabled'}>
          <span class="dock-cell-voice-icon">🔊</span>
        </button>
        <span class="dock-cell-num">${s.order}</span>
        <span class="dock-cell-title">${escapeHtml(merged.title)}</span>
      </div>
    `;
  }).join('');
  updateTeachDockActive();
}

function updateTeachDockActive() {
  document.querySelectorAll('#teach-step-dock .dock-cell').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.stepId === state.currentStepId);
  });
  const active = document.querySelector('#teach-step-dock .dock-cell.active');
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function teachSwitchProtocol(protocolId) {
  state.protocolId = protocolId;
  state.currentStepId = null;
  document.querySelectorAll('.protocol-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.protocol === protocolId);
  });
  renderTeachDock();
}

// 取出合併後（預設 - 已刪除 + 使用者新增、依使用者順序排序、重編 order）的步驟列表
function getMergedSteps(protocolId) {
  const defaults = PROTOCOLS.protocols[protocolId].steps;
  const deleted = Storage.getDeletedStepIds();
  const extras = Storage.getExtraSteps(protocolId);
  const customOrder = Storage.getCustomOrder(protocolId);

  let merged = [
    ...defaults.filter(s => !deleted.has(s.id)),
    ...extras
  ];

  if (customOrder && Array.isArray(customOrder)) {
    const byId = Object.fromEntries(merged.map(s => [s.id, s]));
    const ordered = [];
    customOrder.forEach(id => { if (byId[id]) { ordered.push(byId[id]); delete byId[id]; } });
    Object.values(byId).forEach(s => ordered.push(s));
    merged = ordered;
  }

  return merged.map((s, i) => ({ ...s, order: i + 1 }));
}

function getCurrentStep() {
  if (!state.currentStepId) return null;
  return getMergedSteps(state.protocolId).find(s => s.id === state.currentStepId);
}

// 合併編輯後內容
function getMergedStep(step) {
  const edits = Storage.getStepEdits()[step.id] || {};
  return { ...step, ...edits };
}

async function renderStepDetail() {
  const step = getCurrentStep();
  if (!step) return;
  const merged = getMergedStep(step);
  const isTrauma = state.protocolId === 'trauma';

  const imageUrl = await Storage.getMediaUrl(step.id, 'image');
  const videoUrl = await Storage.getMediaUrl(step.id, 'video');

  const imageHTML = imageUrl
    ? `<img src="${imageUrl}" alt="" />`
    : `<div class="placeholder">📷 尚未上傳圖片<br><small>點下方「編輯素材」加入</small></div>`;

  const videoHTML = videoUrl
    ? `<video src="${videoUrl}" controls></video>`
    : `<div class="placeholder">🎬 尚未上傳影片<br><small>點下方「編輯素材」加入</small></div>`;

  document.getElementById('step-detail').innerHTML = `
    <div class="step-header">
      <div class="step-big-num ${isTrauma ? 'trauma' : ''}">${step.order}</div>
      <div class="step-big-title">${merged.title}</div>
    </div>

    <div class="detail-grid">
      <div class="detail-card points">
        <h3>✓ 口述(動作)內容</h3>
        <ul>${merged.keyPoints.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      </div>
      <div class="detail-card errors">
        <h3>⚠ 學員常見錯誤</h3>
        <ul>${merged.commonErrors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      </div>
      <div class="detail-card voice">
        <h3>🔊 語音腳本 <small style="color:var(--text-dim);font-weight:normal">（按下方播放鍵朗讀）</small></h3>
        <p class="voice-script">${escapeHtml(merged.voiceScript)}</p>
      </div>
      <div class="detail-card media">
        <h3>📷 素材</h3>
        <div class="media-row">
          <div class="media-slot ${imageUrl ? 'has-content' : ''}">${imageHTML}</div>
          <div class="media-slot ${videoUrl ? 'has-content' : ''}">${videoHTML}</div>
        </div>
        <button class="ctrl-btn primary media-edit-btn" onclick="openMediaEditor('${step.id}')">編輯素材</button>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============= 教官：步驟切換按鈕 =============
function prevStep() {
  const steps = getMergedSteps(state.protocolId);
  const idx = steps.findIndex(s => s.id === state.currentStepId);
  if (idx > 0) selectStep(steps[idx - 1].id);
}

function nextStep() {
  const steps = getMergedSteps(state.protocolId);
  const idx = steps.findIndex(s => s.id === state.currentStepId);
  if (idx < steps.length - 1) selectStep(steps[idx + 1].id);
}

// ============= 步驟新增 / 刪除 / 重排 =============
function addNewStep() {
  const newId = `u${Date.now().toString(36)}`;
  const extras = Storage.getExtraSteps(state.protocolId);
  extras.push({
    id: newId,
    order: 999,
    title: '新步驟（請編輯）',
    voiceScript: '',
    keyPoints: [],
    commonErrors: [],
    image: '',
    video: '',
    durationSec: 10
  });
  Storage.setExtraSteps(state.protocolId, extras);
  renderStepList();
  selectStep(newId);
  openMediaEditor(newId);
}

function deleteCurrentEditingStep() {
  if (!editingStepId) return;
  const step = getMergedSteps(state.protocolId).find(s => s.id === editingStepId);
  if (!step) return;
  if (!confirm(`確定刪除步驟「${step.title}」？\n素材與文字編輯都會一併移除，無法復原。`)) return;

  const extras = Storage.getExtraSteps(state.protocolId);
  const isUserAdded = extras.some(s => s.id === editingStepId);

  if (isUserAdded) {
    Storage.setExtraSteps(state.protocolId, extras.filter(s => s.id !== editingStepId));
  } else {
    const deleted = Storage.getDeletedStepIds();
    deleted.add(editingStepId);
    Storage.setDeletedStepIds(deleted);
  }

  // 清掉文字編輯與素材
  const edits = Storage.getStepEdits();
  delete edits[editingStepId];
  localStorage.setItem('ems-step-edits', JSON.stringify(edits));
  Storage.deleteMedia(editingStepId, 'image');
  Storage.deleteMedia(editingStepId, 'video');

  closeModal('modal-edit-media');
  const steps = getMergedSteps(state.protocolId);
  state.currentStepId = steps.length ? steps[0].id : null;
  renderStepList();
  if (state.currentStepId) renderStepDetail();
  if (state.broadcasting) broadcastCurrentStep();
}

function moveStep(stepId, delta) {
  const steps = getMergedSteps(state.protocolId);
  const idx = steps.findIndex(s => s.id === stepId);
  const newIdx = idx + delta;
  if (idx < 0 || newIdx < 0 || newIdx >= steps.length) return;
  const ids = steps.map(s => s.id);
  [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];
  Storage.setCustomOrder(state.protocolId, ids);
  renderStepList();
  // 維持選取
  document.querySelectorAll('.step-item').forEach(el => {
    el.classList.toggle('active', el.dataset.stepId === state.currentStepId);
  });
}

// ============= 語音 =============
function toggleVoice() {
  const synth = window.speechSynthesis;
  if (synth.speaking) {
    synth.cancel();
    state.voiceUtterance = null;
    state.playingStepId = null;
    updateVoiceBtn(false);
    updateDockVoiceStates();
    return;
  }
  const step = getCurrentStep();
  if (!step) return;
  playStepVoice(step.id);
}

function playStepVoice(stepId) {
  const step = getMergedSteps(state.protocolId).find(s => s.id === stepId);
  if (!step) return;
  const merged = getMergedStep(step);
  if (!merged.voiceScript || !merged.voiceScript.trim()) return;

  // 切到該步驟（更新本地高亮，但不發出無聲廣播——稍後一次發帶聲廣播）
  state.currentStepId = stepId;
  updateTeachDockActive();
  document.querySelectorAll('.step-item').forEach(el => {
    el.classList.toggle('active', el.dataset.stepId === stepId);
  });
  if (!document.getElementById('view-instructor').classList.contains('hidden')) {
    renderStepDetail();
  }

  // 教官端本地不播——只觸發學員端朗讀
  state.playingStepId = stepId;
  updateDockVoiceStates();
  broadcastCurrentStep(true);

  // 過一段時間自動清掉「播放中」視覺（估算朗讀完成時間）
  const estimateMs = Math.max(1500, merged.voiceScript.length * 220);
  clearTimeout(state.playingTimer);
  state.playingTimer = setTimeout(() => {
    if (state.playingStepId === stepId) {
      state.playingStepId = null;
      updateDockVoiceStates();
    }
  }, estimateMs);
}

function updateDockVoiceStates() {
  document.querySelectorAll('.dock-cell').forEach(cell => {
    cell.classList.toggle('playing', cell.dataset.stepId === state.playingStepId);
  });
}

function updateVoiceBtn(playing) {
  const btn = document.getElementById('btn-play-voice');
  if (btn) {
    btn.textContent = playing ? '⏸ 停止語音' : '🔊 播放語音';
    btn.classList.toggle('active', playing);
  }
  const teachBtn = document.getElementById('teach-voice');
  if (teachBtn) {
    teachBtn.querySelector('.big-ctrl-icon').textContent = playing ? '⏸' : '🔊';
    teachBtn.querySelector('.big-ctrl-label').textContent = playing ? '停止語音' : '播放語音';
    teachBtn.classList.toggle('active', playing);
  }
}

// ============= 廣播控制 =============
function toggleBroadcast() {
  state.broadcasting = !state.broadcasting;
  const btn = document.getElementById('btn-stop-broadcast');
  if (state.broadcasting) {
    btn.textContent = '📡 廣播中';
    btn.classList.remove('active');
    broadcastCurrentStep();
  } else {
    btn.textContent = '⏸ 已暫停廣播';
    btn.classList.add('active');
  }
}

function broadcastCurrentStep(withVoice = false) {
  if (!state.sync) return;
  const step = getCurrentStep();
  if (!step) return;
  const merged = getMergedStep(step);
  const payload = {
    type: 'step',
    protocolId: state.protocolId,
    stepId: step.id,
    order: step.order,
    title: merged.title,
    keyPoints: merged.keyPoints,
    commonErrors: merged.commonErrors,
    voiceUnlocked: state.studentVoiceUnlocked,
  };
  if (withVoice && merged.voiceScript && merged.voiceScript.trim()) {
    payload.voiceScript = merged.voiceScript;
    payload.playVoice = true;
  }
  state.sync.broadcast(payload);
}

// 教官端：切換學員語音鎖
function toggleStudentVoiceLock() {
  state.studentVoiceUnlocked = !state.studentVoiceUnlocked;
  updateVoiceLockButtons();
  // 立即廣播狀態變化（獨立訊息，學員無論在哪個步驟都會收到）
  if (state.sync) {
    state.sync.broadcast({
      type: 'voice-mode',
      voiceUnlocked: state.studentVoiceUnlocked,
      ts: Date.now()
    });
  }
}

function updateVoiceLockButtons() {
  const unlocked = state.studentVoiceUnlocked;
  document.querySelectorAll('.voice-lock-btn').forEach(btn => {
    btn.classList.toggle('unlocked', unlocked);
    btn.querySelector('.lock-icon').textContent = unlocked ? '🔓' : '🔒';
    btn.querySelector('.lock-label').textContent = unlocked ? '學員語音：開啟' : '學員語音：鎖定';
  });
}

// ============= 學員端：接收訊息 =============
async function handleSyncMessage(msg) {
  if (!msg) return;

  // 語音鎖狀態變更
  if (msg.type === 'voice-mode') {
    studentVoiceUnlocked = !!msg.voiceUnlocked;
    updateStudentLockIndicator();
    return;
  }

  if (msg.type !== 'step') return;

  // 記住最後訊息（給 ContentSync 變動時用）
  state.lastStudentMsg = { ...msg, _refresh: undefined };

  // 每次 step 廣播也夾帶最新鎖狀態
  if (typeof msg.voiceUnlocked === 'boolean') {
    studentVoiceUnlocked = msg.voiceUnlocked;
    updateStudentLockIndicator();
  }

  document.getElementById('sync-status').textContent = '✅ 已連線';
  document.getElementById('sync-status').classList.add('connected');

  const isTrauma = msg.protocolId === 'trauma';
  const imageUrl = await Storage.getMediaUrl(msg.stepId, 'image');
  const videoUrl = await Storage.getMediaUrl(msg.stepId, 'video');

  let mediaHTML;
  if (videoUrl) {
    mediaHTML = `<video src="${videoUrl}" autoplay loop muted playsinline></video>`;
  } else if (imageUrl) {
    mediaHTML = `<img src="${imageUrl}" alt="" />`;
  } else {
    mediaHTML = `<div class="no-media-icon">📋</div>`;
  }

  document.getElementById('student-main').innerHTML = `
    <div class="student-step">
      <div class="student-step-header">
        <div class="student-step-num ${isTrauma ? 'trauma' : ''}">${msg.order}</div>
        <div class="student-step-title">${escapeHtml(msg.title)}</div>
      </div>
      <div class="student-media">${mediaHTML}</div>
      <div class="student-points">
        <h3>口述(動作)內容</h3>
        <ul>${msg.keyPoints.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      </div>
    </div>
  `;

  // 朗讀條件：①教官按了喇叭 ② 大螢幕無視鎖 / 學員手機需鎖打開 ③ 非「內容變動重新渲染」
  const canPlay = msg.playVoice && msg.voiceScript && !msg._refresh &&
                  (bigScreenMode || studentVoiceUnlocked);
  if (canPlay) {
    window.speechSynthesis.cancel();
    if (window.__studentInteracted) {
      const u = new SpeechSynthesisUtterance(msg.voiceScript);
      u.lang = 'zh-TW';
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } else {
      document.getElementById('sync-status').textContent = '🔇 請點畫面任一處解鎖音效';
    }
  }
}

function updateStudentLockIndicator() {
  const status = document.getElementById('sync-status');
  if (!status) return;
  if (bigScreenMode) {
    status.textContent = window.__studentInteracted
      ? '📺 大螢幕模式 · 已連線'
      : '📺 大螢幕模式 · 請點畫面解鎖音效';
    status.classList.add('connected');
    return;
  }
  if (!studentVoiceUnlocked) {
    status.textContent = '🔒 語音鎖定中（教官未開啟）';
    status.classList.remove('connected');
  } else if (window.__studentInteracted) {
    status.textContent = '🔓 語音已開啟';
    status.classList.add('connected');
  } else {
    status.textContent = '🔓 已開啟 — 請點畫面解鎖音效';
  }
}

// 學員第一次點任何位置後允許播語音
document.addEventListener('click', () => { window.__studentInteracted = true; }, { once: true });

// 大螢幕：點覆蓋層按鈕解鎖音訊（必須在 click handler 內同步觸發 speechSynthesis 才算合法解鎖）
function unlockBigscreenAudio() {
  window.__studentInteracted = true;
  try {
    const warmup = new SpeechSynthesisUtterance(' ');
    warmup.volume = 0;
    warmup.lang = 'zh-TW';
    window.speechSynthesis.speak(warmup);
  } catch (e) {}
  const overlay = document.getElementById('bigscreen-unlock');
  if (overlay) overlay.classList.add('hidden');
  updateStudentLockIndicator();
}

// ============= 加入資訊（QR & URL） =============
function showJoinInfo() {
  const base = location.href.split('#')[0];
  const url = `${base}#/s/${state.roomCode}`;
  document.getElementById('join-url').textContent = url;
  document.getElementById('big-room-code').textContent = state.roomCode;
  // QR 用免費公開 API 產圖（不需 JS lib）；圖片載入失敗會顯示原 fallback 文字
  const container = document.getElementById('qr-container');
  const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(url)}`;
  const img = new Image();
  img.alt = 'QR Code';
  img.style.maxWidth = '100%';
  img.onload = () => {
    container.innerHTML = '';
    container.appendChild(img);
  };
  img.onerror = () => {
    container.innerHTML = '<div class="qr-fallback">📡 QR 服務無法連線<br><small>請改用方法二（網址或代碼）</small></div>';
  };
  img.src = qrApi;
  document.getElementById('modal-join-info').classList.remove('hidden');
}

function copyJoinUrl() {
  const url = document.getElementById('join-url').textContent;
  navigator.clipboard.writeText(url).then(
    () => alert('已複製：' + url),
    () => alert('複製失敗，請手動選取網址')
  );
}

// ============= 素材編輯 =============
let editingStepId = null;

async function openMediaEditor(stepId) {
  editingStepId = stepId;
  const step = getMergedSteps(state.protocolId).find(s => s.id === stepId);
  if (!step) return;
  const merged = getMergedStep(step);
  document.getElementById('edit-step-title-display').textContent = merged.title;
  document.getElementById('edit-title').value = merged.title;
  document.getElementById('edit-key-points').value = merged.keyPoints.join('\n');
  document.getElementById('edit-common-errors').value = merged.commonErrors.join('\n');
  document.getElementById('edit-voice-script').value = merged.voiceScript;
  await refreshMediaPreviews();
  document.getElementById('modal-edit-media').classList.remove('hidden');
}

async function refreshMediaPreviews() {
  const imgUrl = await Storage.getMediaUrl(editingStepId, 'image');
  const vidUrl = await Storage.getMediaUrl(editingStepId, 'video');
  document.getElementById('media-image-preview').innerHTML = imgUrl
    ? `<img src="${imgUrl}" />`
    : '<div style="color:var(--text-dim)">尚未上傳</div>';
  document.getElementById('media-video-preview').innerHTML = vidUrl
    ? `<video src="${vidUrl}" controls></video>`
    : '<div style="color:var(--text-dim)">尚未上傳</div>';
}

async function handleMediaUpload(kind) {
  const input = document.getElementById(`upload-${kind}`);
  const file = input.files[0];
  if (!file) return;
  const previewEl = document.getElementById(`media-${kind}-preview`);
  if (previewEl) previewEl.innerHTML = `<div style="color:var(--text-dim);text-align:center">上傳中... 0%</div>`;
  await Storage.saveMedia(editingStepId, kind, file, (pct) => {
    if (previewEl) previewEl.innerHTML = `<div style="color:var(--text-dim);text-align:center">上傳中... ${Math.round(pct)}%</div>`;
  });
  await refreshMediaPreviews();
}

async function clearMedia(kind) {
  if (!confirm(`確定清除${kind === 'image' ? '圖片' : '影片'}？`)) return;
  await Storage.deleteMedia(editingStepId, kind);
  await refreshMediaPreviews();
}

async function saveStepEdits() {
  const title = document.getElementById('edit-title').value.trim();
  const keyPoints = document.getElementById('edit-key-points').value
    .split('\n').map(s => s.trim()).filter(Boolean);
  const commonErrors = document.getElementById('edit-common-errors').value
    .split('\n').map(s => s.trim()).filter(Boolean);
  const script = document.getElementById('edit-voice-script').value.trim();

  if (title) Storage.saveStepEdit(editingStepId, 'title', title);
  if (keyPoints.length) Storage.saveStepEdit(editingStepId, 'keyPoints', keyPoints);
  Storage.saveStepEdit(editingStepId, 'commonErrors', commonErrors); // 允許清空
  if (script) Storage.saveStepEdit(editingStepId, 'voiceScript', script);

  closeModal('modal-edit-media');
  renderStepList(); // 標題可能變了
  document.querySelectorAll('.step-item').forEach(el => {
    el.classList.toggle('active', el.dataset.stepId === state.currentStepId);
  });
  await renderStepDetail();
  if (state.broadcasting) broadcastCurrentStep();
}

function resetStepToDefault() {
  if (!confirm('確定還原此步驟所有編輯（含上傳的圖片影片）為預設？此動作無法復原。')) return;
  const edits = Storage.getStepEdits();
  delete edits[editingStepId];
  localStorage.setItem('ems-step-edits', JSON.stringify(edits));
  Storage.deleteMedia(editingStepId, 'image');
  Storage.deleteMedia(editingStepId, 'video');
  closeModal('modal-edit-media');
  renderStepList();
  document.querySelectorAll('.step-item').forEach(el => {
    el.classList.toggle('active', el.dataset.stepId === state.currentStepId);
  });
  renderStepDetail();
  if (state.broadcasting) broadcastCurrentStep();
}

// ============= 匯出 / 匯入 =============
async function exportData() {
  try {
    const data = await Storage.exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ems-assessment-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('匯出失敗：' + e.message);
  }
}

function importData() {
  document.getElementById('import-file').click();
}

// ============= 啟動 =============
window.addEventListener('DOMContentLoaded', init);

// 暴露給 HTML inline handlers
window.enterRole = enterRole;
window.promptStudentJoin = promptStudentJoin;
window.confirmJoin = confirmJoin;
window.closeModal = closeModal;
window.leaveRoom = leaveRoom;
window.switchProtocol = switchProtocol;
window.selectStep = selectStep;
window.prevStep = prevStep;
window.nextStep = nextStep;
window.toggleVoice = toggleVoice;
window.toggleBroadcast = toggleBroadcast;
window.showJoinInfo = showJoinInfo;
window.copyJoinUrl = copyJoinUrl;
window.openMediaEditor = openMediaEditor;
window.handleMediaUpload = handleMediaUpload;
window.clearMedia = clearMedia;
window.saveStepEdits = saveStepEdits;
window.resetStepToDefault = resetStepToDefault;
window.addNewStep = addNewStep;
window.deleteCurrentEditingStep = deleteCurrentEditingStep;
window.moveStep = moveStep;
window.switchToAdmin = switchToAdmin;
window.switchToTeach = switchToTeach;
window.teachSwitchProtocol = teachSwitchProtocol;
window.playStepVoice = playStepVoice;
window.toggleStudentVoiceLock = toggleStudentVoiceLock;
window.exportData = exportData;
window.importData = importData;
window.unlockBigscreenAudio = unlockBigscreenAudio;
