async function startOrJoinVoiceFromRoom(roomId, roomName){
  try{
    const { data, error } = await sb.rpc('start_or_join_voice_session', { p_room_id: roomId });
    if(error){ toast('تعذر بدء الدردشة الصوتية: '+error.message, 'error'); return; }
    const session = data[0];
    openVoiceRoomPage(session.session_id, roomId, roomName);
  }catch(e){ toast('خطأ: '+e.message, 'error'); }
}

async function openVoiceRoomPage(sessionId, roomId, roomName){
  activeVoiceSessionId = sessionId;
  const c = document.getElementById('viewContainer');
  c.innerHTML = `
    <div class="voice-room-page">
      <div class="voice-room-header">
        <button class="btn btn-sm" onclick="leaveVoiceRoomPage()"><i class="fa-solid fa-arrow-right"></i></button>
        <div><div class="name">${escapeHtml(roomName)}</div><div class="desc"><i class="fa-solid fa-microphone-lines"></i> دردشة صوتية</div></div>
      </div>
      <div class="voice-room-participants" id="voiceParticipantsGrid"><div class="empty-state"><div class="spinner"></div></div></div>
      <div class="voice-room-controls">
        <button class="voice-ctrl-btn" id="voiceMicBtn" onclick="toggleVoiceMic()"><i class="fa-solid fa-microphone"></i></button>
        <button class="voice-ctrl-btn danger" onclick="leaveVoiceRoomPage()"><i class="fa-solid fa-phone-slash"></i></button>
      </div>
    </div>`;

  try{
    await connectToLiveKitRoom('voice', sessionId, {
      wantAudio: true,
      onParticipantsChanged: renderVoiceParticipants,
    });
    renderVoiceParticipants();
  }catch(e){
    document.getElementById('voiceParticipantsGrid').innerHTML = `<div class="empty-state" style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

function renderVoiceParticipants(){
  const grid = document.getElementById('voiceParticipantsGrid');
  if(!grid || !lkCurrentRoom) return;
  const participants = [lkCurrentRoom.localParticipant, ...Array.from(lkCurrentRoom.remoteParticipants.values())];
  grid.innerHTML = participants.map(p=>{
    const speaking = p.isSpeaking ? 'speaking' : '';
    const initials = (p.name || p.identity || '?')[0]?.toUpperCase() || '?';
    return `<div class="voice-participant ${speaking}"><div class="voice-avatar">${initials}</div><div class="voice-name">${escapeHtml(p.name||'مستخدم')}</div></div>`;
  }).join('');
}

let voiceMicEnabled = true;
function toggleVoiceMic(){
  voiceMicEnabled = !voiceMicEnabled;
  lkToggleMic(voiceMicEnabled);
  const btn = document.getElementById('voiceMicBtn');
  if(btn) btn.innerHTML = voiceMicEnabled ? '<i class="fa-solid fa-microphone"></i>' : '<i class="fa-solid fa-microphone-slash"></i>';
  btn?.classList.toggle('muted', !voiceMicEnabled);
}

async function leaveVoiceRoomPage(){
  await disconnectLiveKitRoom();
  if(activeVoiceSessionId){
    sb.rpc('leave_voice_session', { p_session_id: activeVoiceSessionId }).then(()=>pollActiveVoiceSessions());
    activeVoiceSessionId = null;
  }
  nav('rooms');
}

/* ================= MEETINGS (زي Google Meet) ================= */
let activeMeetingId = null;
let activeMeetingIsHost = false;
let meetingRequestsPollInterval = null;
let preJoinWantMic = true;
let preJoinWantCam = true;
let preJoinLocalStream = null;
let preJoinPendingAction = null;

function openStartMeetingModal(){
  document.getElementById('meetingTitleInput').value = '';
  document.getElementById('meetingRequireApprovalCheck').checked = true;
  document.getElementById('startMeetingOverlay').classList.add('active');
}
function closeStartMeetingModal(){
  document.getElementById('startMeetingOverlay').classList.remove('active');
}

function submitStartMeeting(){
  const title = document.getElementById('meetingTitleInput').value.trim() || 'ميتنج بدون عنوان';
  const requireApproval = document.getElementById('meetingRequireApprovalCheck').checked;
  closeStartMeetingModal();
  preJoinPendingAction = { mode:'create', title, requireApproval };
  openPreJoinScreen();
}

function openJoinMeetingModal(){
  document.getElementById('joinMeetingCodeInput').value = '';
  document.getElementById('joinMeetingOverlay').classList.add('active');
}
function closeJoinMeetingModal(){
  document.getElementById('joinMeetingOverlay').classList.remove('active');
}

function submitJoinMeetingByCode(){
  const raw = document.getElementById('joinMeetingCodeInput').value.trim();
  if(!raw){ toast('حط لينك أو كود الميتنج', 'error'); return; }
  let meetingId = raw;
  const match = raw.match(/[?&]meet=([a-f0-9-]{36})/i);
  if(match) meetingId = match[1];
  closeJoinMeetingModal();
  preJoinPendingAction = { mode:'join', meetingId };
  openPreJoinScreen();
}

/* ---- شاشة اختيار الكاميرا/المايك قبل الدخول ---- */
async function openPreJoinScreen(){
  preJoinWantMic = true;
  preJoinWantCam = true;
  document.getElementById('preJoinMicBtn').classList.remove('muted');
  document.getElementById('preJoinCamBtn').classList.remove('muted');
  document.getElementById('preJoinOverlay').classList.add('active');
  await refreshPreJoinPreview();
}

async function refreshPreJoinPreview(){
  const placeholder = document.getElementById('preJoinAvatarPlaceholder');
  const preview = document.getElementById('preJoinVideoPreview');
  if(preJoinLocalStream){
    preJoinLocalStream.getTracks().forEach(t=>t.stop());
    preJoinLocalStream = null;
  }
  const existingVideo = preview.querySelector('video');
  if(existingVideo) existingVideo.remove();

  if(!preJoinWantCam){
    placeholder.style.display = 'flex';
    return;
  }
  try{
    preJoinLocalStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
    const video = document.createElement('video');
    video.srcObject = preJoinLocalStream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    preview.insertBefore(video, placeholder);
    placeholder.style.display = 'none';
  }catch(e){
    toast('تعذر تشغيل الكاميرا: '+e.message, 'error');
    preJoinWantCam = false;
    document.getElementById('preJoinCamBtn').classList.add('muted');
    placeholder.style.display = 'flex';
  }
}

function togglePreJoinMic(){
  preJoinWantMic = !preJoinWantMic;
  document.getElementById('preJoinMicBtn').classList.toggle('muted', !preJoinWantMic);
}
function togglePreJoinCam(){
  preJoinWantCam = !preJoinWantCam;
  document.getElementById('preJoinCamBtn').classList.toggle('muted', !preJoinWantCam);
  refreshPreJoinPreview();
}

function closePreJoinScreen(){
  if(preJoinLocalStream){
    preJoinLocalStream.getTracks().forEach(t=>t.stop());
    preJoinLocalStream = null;
  }
  document.getElementById('preJoinOverlay').classList.remove('active');
}

async function confirmPreJoinAndEnter(){
  const wantMic = preJoinWantMic;
  const wantCam = preJoinWantCam;
  closePreJoinScreen();
  const action = preJoinPendingAction;
  preJoinPendingAction = null;
  if(!action) return;

  if(action.mode === 'create'){
    const { data, error } = await sb.rpc('create_meeting', { p_title: action.title, p_require_approval: action.requireApproval });
    if(error){ toast('تعذر إنشاء الميتنج: '+error.message, 'error'); return; }
    const meeting = data[0];
    openMeetingPage(meeting.meeting_id, action.title, true, wantMic, wantCam);
  } else if(action.mode === 'live-create'){
    const { data, error } = await sb.rpc('start_live_stream', { p_title: action.title });
    if(error){ toast('تعذر بدء البث: '+error.message, 'error'); return; }
    const live = data[0];
    openLivePage(live.live_id, action.title, true, wantMic, wantCam);
  } else if(action.__skipRequest){
    const { data: meetingRow } = await sb.from('meetings').select('title, host_id').eq('id', action.meetingId).single();
    openMeetingPage(action.meetingId, meetingRow?.title, meetingRow?.host_id === currentUser.id, wantMic, wantCam);
  } else {
    const { data: status, error } = await sb.rpc('request_join_meeting', { p_meeting_id: action.meetingId });
    if(error){ toast('تعذر الانضمام: '+error.message, 'error'); return; }
    if(status === 'pending'){
      showMeetingWaitingRoom(action.meetingId);
    } else {
      const { data: meetingRow } = await sb.from('meetings').select('title, host_id').eq('id', action.meetingId).single();
      openMeetingPage(action.meetingId, meetingRow?.title, meetingRow?.host_id === currentUser.id, wantMic, wantCam);
    }
  }
}

function showMeetingWaitingRoom(meetingId){
  const c = document.getElementById('viewContainer');
  c.innerHTML = `
    <div class="meeting-waiting-room">
      <div class="spinner-lg"></div>
      <h2>مستنيين موافقة صاحب الميتنج</h2>
      <p>هيدخلك تلقائي أول ما يوافق</p>
      <button class="btn btn-ghost" onclick="cancelMeetingWaitingRoom()">إلغاء</button>
    </div>`;
  let attempts = 0;
  const poll = setInterval(async ()=>{
    attempts++;
    const { data: participant } = await sb.from('meeting_participants').select('status').eq('meeting_id', meetingId).eq('user_id', currentUser.id).single();
    if(participant?.status === 'approved'){
      clearInterval(poll);
      const { data: meetingRow } = await sb.from('meetings').select('title, host_id, status').eq('id', meetingId).single();
      if(meetingRow?.status !== 'active'){ toast('الميتنج خلص', 'error'); nav('feed'); return; }
      openMeetingPage(meetingId, meetingRow?.title, meetingRow?.host_id === currentUser.id, true, false);
    } else if(participant?.status === 'rejected'){
      clearInterval(poll);
      toast('تم رفض طلب انضمامك للميتنج', 'error');
      nav('feed');
    }
    if(attempts > 150){ clearInterval(poll); toast('انتهت مهلة الانتظار', 'error'); nav('feed'); }
  }, 2000);
  window._meetingWaitPoll = poll;
}
function cancelMeetingWaitingRoom(){
  if(window._meetingWaitPoll) clearInterval(window._meetingWaitPoll);
  nav('feed');
}

/* ---- صفحة الميتنج الرئيسية ---- */
async function openMeetingPage(meetingId, title, isHost, wantMic, wantCam){
  activeMeetingId = meetingId;
  activeMeetingIsHost = isHost;
  const c = document.getElementById('viewContainer');
  c.innerHTML = `
    <div class="meeting-page">
      <div class="meeting-header">
        <div><div class="name">${escapeHtml(title || 'ميتنج')}</div><div class="desc" id="meetingParticipantCount">جاري الاتصال...</div></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" onclick="shareMeetingLink('${meetingId}')"><i class="fa-solid fa-share-nodes"></i> مشاركة</button>
          ${isHost ? `<button class="btn btn-sm" onclick="toggleMeetingRequestsPanel()" id="meetingRequestsBtn" style="position:relative"><i class="fa-solid fa-user-clock"></i> طلبات <span class="badge" id="meetingRequestsBadge" style="display:none">0</span></button>` : ''}
        </div>
      </div>
      <div class="meeting-grid" id="meetingParticipantsGrid"><div class="empty-state"><div class="spinner"></div></div></div>
      <div class="meeting-controls">
        <button class="voice-ctrl-btn" id="meetingMicBtn" onclick="toggleMeetingMic()"><i class="fa-solid fa-microphone"></i></button>
        <button class="voice-ctrl-btn" id="meetingCamBtn" onclick="toggleMeetingCam()"><i class="fa-solid fa-video"></i></button>
        <button class="voice-ctrl-btn danger" onclick="confirmLeaveOrEndMeeting()"><i class="fa-solid fa-phone-slash"></i></button>
      </div>
      <div class="meeting-requests-panel" id="meetingRequestsPanel">
        <div class="meeting-requests-header">
          <span>طلبات الانضمام</span>
          <button class="icon-btn" onclick="toggleMeetingRequestsPanel()"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="meetingRequestsList"><div class="empty-state" style="padding:20px;font-size:12px">مفيش طلبات دلوقتي</div></div>
      </div>
    </div>`;

  meetingMicEnabled = wantMic;
  meetingCamEnabled = wantCam;
  document.getElementById('meetingMicBtn').classList.toggle('muted', !wantMic);
  document.getElementById('meetingCamBtn').classList.toggle('muted', !wantCam);

  try{
    await connectToLiveKitRoom('meeting', meetingId, {
      wantAudio: wantMic,
      wantVideo: wantCam,
      onTrackSubscribed: ()=>renderMeetingParticipants(),
      onParticipantsChanged: renderMeetingParticipants,
    });
    renderMeetingParticipants();
  }catch(e){
    document.getElementById('meetingParticipantsGrid').innerHTML = `<div class="empty-state" style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }

  if(isHost){
    if(meetingRequestsPollInterval) clearInterval(meetingRequestsPollInterval);
    refreshMeetingRequests();
    meetingRequestsPollInterval = setInterval(refreshMeetingRequests, 4000);
  }
}

function renderMeetingParticipants(){
  const grid = document.getElementById('meetingParticipantsGrid');
  const countEl = document.getElementById('meetingParticipantCount');
  if(!grid || !lkCurrentRoom) return;
  const participants = [lkCurrentRoom.localParticipant, ...Array.from(lkCurrentRoom.remoteParticipants.values())];
  if(countEl) countEl.textContent = `${participants.length} مشارك`;

  grid.innerHTML = participants.map(p=>{
    const initials = (p.name || '?')[0]?.toUpperCase() || '?';
    return `<div class="meeting-tile" id="meeting-tile-${p.identity}">
      <div class="meeting-tile-video-slot"></div>
      <div class="meeting-tile-fallback"><div class="voice-avatar">${initials}</div></div>
      <div class="meeting-tile-name">${escapeHtml(p.name||'مستخدم')}</div>
    </div>`;
  }).join('');

  participants.forEach(p=>{
    const tile = document.getElementById(`meeting-tile-${p.identity}`);
    if(!tile) return;
    const videoSlot = tile.querySelector('.meeting-tile-video-slot');
    const fallback = tile.querySelector('.meeting-tile-fallback');
    const videoPub = [...p.videoTrackPublications.values()][0];
    if(videoPub && videoPub.track && videoPub.isSubscribed){
      videoSlot.innerHTML = '';
      const el = videoPub.track.attach();
      el.style.width = '100%'; el.style.height = '100%'; el.style.objectFit = 'cover';
      videoSlot.appendChild(el);
      videoSlot.style.display = 'block';
      fallback.style.display = 'none';
    } else {
      videoSlot.style.display = 'none';
      fallback.style.display = 'flex';
    }
  });
}

let meetingMicEnabled = true;
let meetingCamEnabled = true;
function toggleMeetingMic(){
  meetingMicEnabled = !meetingMicEnabled;
  lkToggleMic(meetingMicEnabled);
  document.getElementById('meetingMicBtn').classList.toggle('muted', !meetingMicEnabled);
}
function toggleMeetingCam(){
  meetingCamEnabled = !meetingCamEnabled;
  lkToggleCamera(meetingCamEnabled);
  document.getElementById('meetingCamBtn').classList.toggle('muted', !meetingCamEnabled);
  renderMeetingParticipants();
}

/* ---- زرار المشاركة: بينسخ لينك دخول الميتنج مباشرة ---- */
function shareMeetingLink(meetingId){
  shareMeetingLinkGeneric('meet', meetingId);
}

/* ---- لوحة طلبات الانضمام (للـ host بس) ---- */
function toggleMeetingRequestsPanel(){
  document.getElementById('meetingRequestsPanel')?.classList.toggle('active');
}

async function refreshMeetingRequests(){
  if(!activeMeetingId || !activeMeetingIsHost) return;
  const { data } = await sb.rpc('get_pending_join_requests', { p_meeting_id: activeMeetingId });
  const badge = document.getElementById('meetingRequestsBadge');
  const list = document.getElementById('meetingRequestsList');
  if(!data || !data.length){
    if(badge) badge.style.display = 'none';
    if(list) list.innerHTML = `<div class="empty-state" style="padding:20px;font-size:12px">مفيش طلبات دلوقتي</div>`;
    return;
  }
  if(badge){ badge.style.display='inline-block'; badge.textContent = data.length; }
  if(list){
    list.innerHTML = data.map(r=>`
      <div class="meeting-request-item">
        <div class="voice-avatar" style="width:36px;height:36px;font-size:14px">${(r.username||'?')[0].toUpperCase()}</div>
        <span style="flex:1;font-size:13px">@${escapeHtml(r.username)}</span>
        <button class="icon-btn" style="color:var(--teal)" onclick="respondJoinRequest('${r.user_id}', true)"><i class="fa-solid fa-check"></i></button>
        <button class="icon-btn" style="color:var(--red)" onclick="respondJoinRequest('${r.user_id}', false)"><i class="fa-solid fa-xmark"></i></button>
      </div>`).join('');
  }
}

async function respondJoinRequest(userId, approve){
  const { error } = await sb.rpc('respond_to_join_request', { p_meeting_id: activeMeetingId, p_user_id: userId, p_approve: approve });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  refreshMeetingRequests();
}

async function confirmLeaveOrEndMeeting(){
  if(activeMeetingIsHost){
    if(!await customConfirm('تنهي الميتنج للجميع؟ (لو عايز تسيب من غيرك، دوس إلغاء وقفل الصفحة بس)', true)) return;
    await sb.rpc('end_meeting', { p_meeting_id: activeMeetingId });
  } else {
    await sb.rpc('leave_meeting', { p_meeting_id: activeMeetingId });
  }
  await leaveMeetingPage();
}

async function leaveMeetingPage(){
  await disconnectLiveKitRoom();
  if(meetingRequestsPollInterval){ clearInterval(meetingRequestsPollInterval); meetingRequestsPollInterval = null; }
  activeMeetingId = null;
  activeMeetingIsHost = false;
  nav('feed');
}

/* ---- الأونر/الأدمن يدخل أي ميتنج شغال في أي وقت ---- */
async function adminJoinAnyMeeting(meetingId){
  preJoinPendingAction = { mode:'join', meetingId, __skipRequest: true };
  openPreJoinScreen();
}

/* ---- فتح ميتنج تلقائيًا لو اليوزر دخل بلينك فيه ?meet=xxx ---- */
function checkUrlMeetingOnLoad(){
  const params = new URLSearchParams(location.search);
  const meetId = params.get('meet');
  if(meetId && currentUser){
    preJoinPendingAction = { mode:'join', meetingId: meetId };
    openPreJoinScreen();
  }
}

/* ================= LIVE STREAMS (بث مباشر من صفحة المنشورات) ================= */
let activeLiveId = null;
let activeLiveIsHost = false;
let liveViewerPollInterval = null;

function openStartLiveModal(){
  document.getElementById('liveTitleInput').value = '';
  document.getElementById('startLiveOverlay').classList.add('active');
}
function closeStartLiveModal(){
  document.getElementById('startLiveOverlay').classList.remove('active');
}

function submitStartLive(){
  const title = document.getElementById('liveTitleInput').value.trim() || 'بث مباشر';
  closeStartLiveModal();
  preJoinPendingAction = { mode:'live-create', title };
  openPreJoinScreen();
}

async function loadActiveLivesRow(){
  const row = document.getElementById('activeLivesRow');
  if(!row) return;
  const { data } = await sb.rpc('get_active_live_streams');
  if(!data || !data.length){ row.innerHTML = ''; return; }
  row.innerHTML = `<div class="live-row">` + data.map(l=>`
    <div class="live-row-item" onclick="joinLiveAsViewer('${l.id}')">
      <div class="live-row-avatar">${(l.host_username||'?')[0].toUpperCase()}<span class="live-dot"></span></div>
      <div class="live-row-name">@${escapeHtml(l.host_username)}</div>
    </div>`).join('') + `</div>`;
}

async function joinLiveAsViewer(liveId){
  // ميزة اللايف مُعطَّلة مؤقتًا
  showEndedLivePage(null);
}

async function showEndedLivePage(hostUsername){
  const c = document.getElementById('viewContainer');
  const isDisabled = !hostUsername && hostUsername !== '';
  c.innerHTML = `
    <div class="ended-live-page">
      <div class="ended-live-icon"><i class="fa-solid fa-tower-broadcast"></i></div>
      <h2>${isDisabled ? 'ميزة البث المباشر قيد التطوير' : 'البث انتهى'}</h2>
      <p>${isDisabled
        ? 'هتكون متاحة قريبًا، بس المجتمع لسه بيكبر'
        : (hostUsername ? `بث @${escapeHtml(hostUsername)} خلص، بس المجتمع لسه بيكبر` : 'البث ده خلص، بس المجتمع لسه بيكبر')
      }</p>
      <div class="ended-live-stat" id="endedLiveStat"><div class="spinner"></div></div>
      <button class="btn btn-primary" onclick="nav('feed')">رجوع للمنشورات</button>
    </div>`;
  const { count } = await sb.from('profiles').select('*', {count:'exact', head:true});
  const statEl = document.getElementById('endedLiveStat');
  if(statEl) statEl.innerHTML = `<div class="n">${count||0}</div><div class="l">عضو في DevVerse دلوقتي</div>`;
}

async function openLivePage(liveId, title, isHost, wantMic, wantCam){
  activeLiveId = liveId;
  activeLiveIsHost = isHost;
  const c = document.getElementById('viewContainer');
  c.innerHTML = `
    <div class="live-page">
      <div class="live-video-area" id="liveVideoArea">
        <div class="empty-state" style="color:#fff"><div class="spinner"></div></div>
      </div>
      <div class="live-top-bar">
        <div class="live-host-chip"><span class="live-dot"></span> مباشر</div>
        <div class="live-title-chip">${escapeHtml(title||'بث مباشر')}</div>
        <div class="live-viewer-chip" id="liveViewerCount"><i class="fa-solid fa-eye"></i> 0</div>
        <button class="icon-btn" style="margin-right:auto;color:#fff" onclick="shareMeetingLinkGeneric('live', '${liveId}')"><i class="fa-solid fa-share-nodes"></i></button>
        <button class="icon-btn" style="color:#fff" onclick="leaveLivePage()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      ${isHost ? `
      <div class="live-host-controls">
        <button class="voice-ctrl-btn" id="liveMicBtn" onclick="toggleLiveMic()"><i class="fa-solid fa-microphone"></i></button>
        <button class="voice-ctrl-btn" id="liveCamBtn" onclick="toggleLiveCam()"><i class="fa-solid fa-video"></i></button>
        <button class="voice-ctrl-btn danger" onclick="confirmEndLive()"><i class="fa-solid fa-stop"></i></button>
      </div>` : ''}
    </div>`;

  liveMicEnabled = !!wantMic;
  liveCamEnabled = !!wantCam;

  try{
    await connectToLiveKitRoom('live', liveId, {
      wantAudio: isHost && wantMic,
      wantVideo: isHost && wantCam,
      onTrackSubscribed: attachLiveHostVideo,
      onParticipantsChanged: updateLiveViewerCount,
    });
    attachLiveHostVideo();
    updateLiveViewerCount();
  }catch(e){
    document.getElementById('liveVideoArea').innerHTML = `<div class="empty-state" style="color:#fff">${escapeHtml(e.message)}</div>`;
  }

  if(liveViewerPollInterval) clearInterval(liveViewerPollInterval);
  liveViewerPollInterval = setInterval(updateLiveViewerCount, 5000);
}

function attachLiveHostVideo(){
  const area = document.getElementById('liveVideoArea');
  if(!area || !lkCurrentRoom) return;
  // نلاقي أول مشارك عنده فيديو شغال (المفروض يكون المذيع بس)
  const all = [lkCurrentRoom.localParticipant, ...Array.from(lkCurrentRoom.remoteParticipants.values())];
  const withVideo = all.find(p => [...p.videoTrackPublications.values()].some(pub=>pub.track && pub.isSubscribed));
  if(!withVideo){
    area.innerHTML = `<div class="empty-state" style="color:#fff"><i class="fa-solid fa-video-slash" style="font-size:32px;margin-bottom:10px"></i><div>المذيع لسه مفعّلش الكاميرا</div></div>`;
    return;
  }
  const videoPub = [...withVideo.videoTrackPublications.values()][0];
  area.innerHTML = '';
  const el = videoPub.track.attach();
  el.style.width = '100%'; el.style.height = '100%'; el.style.objectFit = 'contain';
  area.appendChild(el);
}

function updateLiveViewerCount(){
  const el = document.getElementById('liveViewerCount');
  if(!el || !lkCurrentRoom) return;
  const count = 1 + lkCurrentRoom.remoteParticipants.size;
  el.innerHTML = `<i class="fa-solid fa-eye"></i> ${count}`;
  if(activeLiveIsHost && activeLiveId){
    sb.from('live_streams').update({ viewer_count: count - 1 }).eq('id', activeLiveId).then(()=>{});
  }
}

let liveMicEnabled = true;
let liveCamEnabled = true;
function toggleLiveMic(){
  liveMicEnabled = !liveMicEnabled;
  lkToggleMic(liveMicEnabled);
  document.getElementById('liveMicBtn')?.classList.toggle('muted', !liveMicEnabled);
}
function toggleLiveCam(){
  liveCamEnabled = !liveCamEnabled;
  lkToggleCamera(liveCamEnabled);
  document.getElementById('liveCamBtn')?.classList.toggle('muted', !liveCamEnabled);
  setTimeout(attachLiveHostVideo, 300);
}

async function confirmEndLive(){
  if(!await customConfirm('تنهي البث المباشر؟', true)) return;
  await sb.rpc('end_live_stream', { p_live_id: activeLiveId });
  await leaveLivePage();
}

async function leaveLivePage(){
  await disconnectLiveKitRoom();
  if(liveViewerPollInterval){ clearInterval(liveViewerPollInterval); liveViewerPollInterval = null; }
  activeLiveId = null;
  activeLiveIsHost = false;
  nav('feed');
}

/* دالة مشاركة عامة تستخدم لأي نوع (meeting/live) بنفس أسلوب shareMeetingLink */
function shareMeetingLinkGeneric(kind, id){
  const param = kind === 'live' ? 'live' : 'meet';
  const link = `${location.origin}${location.pathname}?${param}=${id}`;
  if(navigator.share){
    navigator.share({ title: kind==='live' ? 'شاهد البث المباشر' : 'انضم للميتنج', url: link }).catch(()=>{});
  } else {
    copyText(link);
    toast('تم نسخ اللينك', 'success');
  }
}

function checkUrlLiveOnLoad(){
  const params = new URLSearchParams(location.search);
  const liveId = params.get('live');
  if(liveId && currentUser){
    joinLiveAsViewer(liveId);
  }
}

/* ================= LOCAL STORAGE (IndexedDB) ================= */
/*
  قاعدة بيانات محلية على جهاز المستخدم بس، مش على السيرفر:
  - cached_messages: كاش رسايل الغرف والمحادثات الخاصة (يقلل "اختفاء الرسايل وقت التنقل بين الغرف")
  - nicknames: اسم مستعار يحطه المستخدم لأي حد تاني، يظهرله هو بس
  - local_prefs: تفضيلات محلية زي "اسمي المعروض محليًا"
*/
const LOCAL_DB_NAME = 'devverse_local';
const LOCAL_DB_VERSION = 1;
let localDbInstance = null;

function openLocalDb(){
  if(localDbInstance) return Promise.resolve(localDbInstance);
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains('cached_messages')){
        const store = db.createObjectStore('cached_messages', { keyPath: 'id' });
        store.createIndex('conversation_id', 'conversation_id', { unique:false });
        store.createIndex('created_at', 'created_at', { unique:false });
      }
      if(!db.objectStoreNames.contains('conversation_meta')){
        db.createObjectStore('conversation_meta', { keyPath: 'conversation_id' });
      }
      if(!db.objectStoreNames.contains('nicknames')){
        db.createObjectStore('nicknames', { keyPath: 'user_id' });
      }
      if(!db.objectStoreNames.contains('local_prefs')){
        db.createObjectStore('local_prefs', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e)=>{ localDbInstance = e.target.result; resolve(localDbInstance); };
    req.onerror = (e)=>{ console.warn('IndexedDB open failed', e); reject(e); };
  });
}

async function idbPut(storeName, value){
  try{
    const db = await openLocalDb();
    return new Promise((resolve)=>{
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = ()=>resolve(true);
      tx.onerror = ()=>resolve(false);
    });
  }catch(e){ return false; }
}

async function idbGet(storeName, key){
  try{
    const db = await openLocalDb();
    return new Promise((resolve)=>{
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = ()=>resolve(req.result || null);
      req.onerror = ()=>resolve(null);
    });
  }catch(e){ return null; }
}

async function idbGetAllByIndex(storeName, indexName, indexValue){
  try{
    const db = await openLocalDb();
    return new Promise((resolve)=>{
      const tx = db.transaction(storeName, 'readonly');
      const idx = tx.objectStore(storeName).index(indexName);
      const req = idx.getAll(indexValue);
      req.onsuccess = ()=>resolve(req.result || []);
      req.onerror = ()=>resolve([]);
    });
  }catch(e){ return []; }
}

async function idbDeleteByIndex(storeName, indexName, indexValue){
  try{
    const db = await openLocalDb();
    return new Promise((resolve)=>{
      const tx = db.transaction(storeName, 'readwrite');
      const idx = tx.objectStore(storeName).index(indexName);
      const req = idx.openCursor(IDBKeyRange.only(indexValue));
      req.onsuccess = (e)=>{
        const cursor = e.target.result;
        if(cursor){ cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = ()=>resolve(true);
      tx.onerror = ()=>resolve(false);
    });
  }catch(e){ return false; }
}

async function idbClearStore(storeName){
  try{
    const db = await openLocalDb();
    return new Promise((resolve)=>{
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = ()=>resolve(true);
      tx.onerror = ()=>resolve(false);
    });
  }catch(e){ return false; }
}

/* ---- كاش الرسايل: نحفظ آخر نسخة من كل رسالة عشان تفضل ظاهرة فورًا وقت التنقل بين الغرف ---- */
function conversationIdFor(ctx, id){
  return ctx==='room' ? `room:${id}` : `dm:${id}`;
}

async function cacheMessages(conversationId, msgs){
  if(!msgs || !msgs.length) return;
  try{
    const db = await openLocalDb();
    const tx = db.transaction('cached_messages', 'readwrite');
    const store = tx.objectStore('cached_messages');
    msgs.forEach(m=>{
      // نخزن نسخة خفيفة بس (من غير الكائنات المتداخلة الكبيرة زي profiles الكاملة) لتوفير المساحة
      store.put({
        id: m.id,
        conversation_id: conversationId,
        sender_id: m.sender_id,
        room_id: m.room_id||null,
        receiver_id: m.receiver_id||null,
        content: m.content,
        message_type: m.message_type,
        telegram_file_id: m.telegram_file_id||null,
        duration_seconds: m.duration_seconds||null,
        is_removed: m.is_removed,
        is_pinned: m.is_pinned||false,
        created_at: m.created_at,
        edited_at: m.edited_at||null,
        reply_to_id: m.reply_to_id||null,
        sender_username: m.profiles?.username || null,
      });
    });
    await new Promise((resolve)=>{ tx.oncomplete = resolve; tx.onerror = resolve; });
    await idbPut('conversation_meta', { conversation_id: conversationId, last_message_id: msgs[msgs.length-1].id, last_cached_at: new Date().toISOString() });
  }catch(e){ console.warn('cacheMessages failed', e); }
}

async function getCachedMessages(conversationId){
  return (await idbGetAllByIndex('cached_messages', 'conversation_id', conversationId))
    .sort((a,b)=> new Date(a.created_at) - new Date(b.created_at));
}

/* ---- الأسماء المستعارة (Nicknames) — محلية بالكامل، محدش يشوفها غير صاحبها ---- */
async function setNickname(userId, nickname){
  if(!nickname || !nickname.trim()){
    const db = await openLocalDb();
    const tx = db.transaction('nicknames', 'readwrite');
    tx.objectStore('nicknames').delete(userId);
    return;
  }
  await idbPut('nicknames', { user_id: userId, nickname: nickname.trim() });
}

async function getNickname(userId){
  const row = await idbGet('nicknames', userId);
  return row ? row.nickname : null;
}

/* اسمي المعروض لي محليًا بس (منفصل عن full_name الحقيقي على السيرفر) */
async function setLocalDisplayName(name){
  await idbPut('local_prefs', { key:'my_local_display_name', value: name });
}
async function getLocalDisplayName(){
  const row = await idbGet('local_prefs', 'my_local_display_name');
  return row ? row.value : null;
}

/* ---- مسح شات معيّن محليًا (من الإعدادات) ---- */
async function clearLocalConversation(conversationId){
  await idbDeleteByIndex('cached_messages', 'conversation_id', conversationId);
  const db = await openLocalDb();
  const tx = db.transaction('conversation_meta', 'readwrite');
  tx.objectStore('conversation_meta').delete(conversationId);
}

async function clearAllLocalChatData(){
  await idbClearStore('cached_messages');
  await idbClearStore('conversation_meta');
}

/* ---- حساب حجم التخزين المحلي المستخدم (تقريبي) ---- */
async function estimateLocalStorageUsage(){
  if(navigator.storage && navigator.storage.estimate){
    try{
      const est = await navigator.storage.estimate();
      return { usageBytes: est.usage||0, quotaBytes: est.quota||0 };
    }catch(e){ /* fallback below */ }
  }
  // fallback تقريبي: نعد عدد الرسايل المخزنة ونقدر حجمها
  const db = await openLocalDb();
  return new Promise((resolve)=>{
    const tx = db.transaction('cached_messages', 'readonly');
    const req = tx.objectStore('cached_messages').count();
    req.onsuccess = ()=> resolve({ usageBytes: (req.result||0) * 500, quotaBytes: null, approximateCount: req.result||0 });
    req.onerror = ()=> resolve({ usageBytes: 0, quotaBytes: null });
  });
}

function formatBytes(bytes){
  if(!bytes || bytes < 1024) return `${bytes||0} بايت`;
  if(bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} ك.ب`;
  return `${(bytes/(1024*1024)).toFixed(1)} م.ب`;
}

/* ---- Modal الإعدادات المحلية ---- */
async function openLocalSettingsModal(){
  document.getElementById('localSettingsOverlay')?.classList.add('active');
  const usernameEl = document.getElementById('settingsCurrentUsername');
  if(usernameEl) usernameEl.textContent = '@' + (currentProfile?.username || '');
  const sizeText = document.getElementById('localStorageSizeText');
  sizeText.textContent = '...جاري الحساب';
  const usage = await estimateLocalStorageUsage();
  sizeText.textContent = formatBytes(usage.usageBytes) + (usage.quotaBytes ? ` / ${formatBytes(usage.quotaBytes)}` : '');
}

function closeLocalSettingsModal(){
  document.getElementById('localSettingsOverlay')?.classList.remove('active');
}

async function openChangeDisplayNamePrompt(){
  const newName = await customPrompt('اسمك الظاهر (اليوزرنيم @' + (currentProfile.username||'') + ' هيفضل زي ما هو):', currentProfile.full_name || '');
  if(newName===null) return;
  const trimmed = newName.trim();
  if(!trimmed){ toast('الاسم مينفعش يبقى فاضي', 'error'); return; }
  const { error } = await sb.from('profiles').update({ full_name: trimmed }).eq('id', currentUser.id);
  if(error){ toast('تعذر تغيير الاسم: '+error.message, 'error'); return; }
  currentProfile.full_name = trimmed;
  const miniNameEl = document.getElementById('miniName');
  if(miniNameEl) miniNameEl.textContent = trimmed;
  toast('اتغيّر اسمك بنجاح', 'success');
}

async function confirmClearAllLocalChats(){
  if(!await customConfirm('هيتم مسح كل الرسايل المخزنة على جهازك بس (مش على السيرفر). المحادثات هترجع تتحمل من السيرفر عادي في المرة الجاية.', true)) return;
  await clearAllLocalChatData();
  toast('اتمسحت كل المحادثات المخزنة محليًا', 'success');
  const sizeText = document.getElementById('localStorageSizeText');
  if(sizeText){
    const usage = await estimateLocalStorageUsage();
    sizeText.textContent = formatBytes(usage.usageBytes) + (usage.quotaBytes ? ` / ${formatBytes(usage.quotaBytes)}` : '');
  }
}

async function confirmClearAllNicknames(){
  if(!await customConfirm('هيتم مسح كل الأسماء المستعارة اللي حطيتها لمستخدمين تانيين.', true)) return;
  await idbClearStore('nicknames');
  toast('اتمسحت كل الأسماء المستعارة', 'success');
}

async function confirmClearLocalConversation(ctx, id){
  if(!await customConfirm('هيتم مسح الرسايل المخزنة على جهازك لهذه المحادثة بس (مش من السيرفر). الرسايل هترجع تتحمل عادي في المرة الجاية.', true)) return;
  await clearLocalConversation(conversationIdFor(ctx, id));
  toast('اتمسحت المحادثة من التخزين المحلي', 'success');
}

/* ================= UTILS ================= */
/* لون ثابت مميز لكل مستخدم بناءً على الـ ID بتاعه (نفس المستخدم دايمًا نفس اللون) */
const USER_REPLY_COLORS = ['#8B5CF6','#EC4899','#F59E0B','#10B981','#3B82F6','#EF4444','#14B8A6','#F97316','#6366F1','#84CC16'];
function colorForUser(userId){
  if(!userId) return USER_REPLY_COLORS[0];
  let hash = 0;
  for(let i=0;i<userId.length;i++){ hash = (hash*31 + userId.charCodeAt(i)) >>> 0; }
  return USER_REPLY_COLORS[hash % USER_REPLY_COLORS.length];
}

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function timeAgo(iso){
  const s = Math.floor((Date.now() - new Date(iso).getTime())/1000);
  if(s<60) return 'الآن';
  if(s<3600) return Math.floor(s/60)+' د';
  if(s<86400) return Math.floor(s/3600)+' س';
  return Math.floor(s/86400)+' يوم';
}

function formatMsgTime(iso){
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' });
  const isToday = d.toDateString() === now.toDateString();
  if(isToday) return time;
  const yesterday = new Date(now); yesterday.setDate(now.getDate()-1);
  if(d.toDateString() === yesterday.toDateString()) return `أمس ${time}`;
  const dateStr = d.toLocaleDateString('ar-EG', { day:'numeric', month:'short', year: d.getFullYear()!==now.getFullYear() ? 'numeric' : undefined });
  return `${dateStr} ${time}`;
}

/* ================= PWA / PUSH NOTIFICATIONS ================= */
const VAPID_PUBLIC_KEY = 'BHVZyQYWtyaTD2v6CaD3vh1TS_2dvgfiJUIRxodfxPgjlHZnLFTXuveCRDuaPeZ9CKox2oEpi8oi1PU76leyu5k';

function urlB64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for(let i=0; i<raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function registerServiceWorker(){
  if(!('serviceWorker' in navigator)) return null;
  try{ return await navigator.serviceWorker.register('/sw.js'); }
  catch(e){ console.warn('SW registration failed', e); return null; }
}

async function setupPushNotifications(){
  updateNotifToggleUI();
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const reg = await registerServiceWorker();
  if(!reg){ console.warn('Push setup: service worker registration failed'); return; }
  if(Notification.permission === 'granted'){
    await subscribeToPush(reg);
  }
}

async function subscribeToPush(reg){
  try{
    let sub = await reg.pushManager.getSubscription();
    if(!sub){
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const json = sub.toJSON();
    await sb.from('push_subscriptions').upsert({
      user_id: currentUser.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    }, { onConflict: 'endpoint' });
    return true;
  }catch(e){
    console.warn('Push subscribe failed', e);
    return false;
  }
}

function handleNotifBtnClick(){
  if(Notification.permission === 'granted') openNotifGuide();
  else requestNotificationPermission();
}

async function requestNotificationPermission(){
  if(!('Notification' in window)){ toast('المتصفح ده مش بيدعم الإشعارات', 'error'); return; }
  if(Notification.permission === 'denied'){
    toast('الإشعارات متمنوعة من إعدادات المتصفح — لازم تفعّلها يدويًا من هناك', 'error');
    return;
  }
  const perm = await Notification.requestPermission();
  if(perm !== 'granted'){ updateNotifToggleUI(); return; }
  const reg = await registerServiceWorker();
  if(!reg) return;
  const ok = await subscribeToPush(reg);
  if(ok){
    toast('تم تفعيل الإشعارات', 'success');
    openNotifGuide();
  }
  updateNotifToggleUI();
}

const NOTIF_GUIDE_CONTENT = {
  samsung: `
    <b>1.</b> الإعدادات ← العناية بالجهاز والبطارية ← البطارية ← حدود استخدام الخلفية<br>
    تأكد إن <b>Chrome</b> مش في قايمة "التطبيقات النائمة" أو "المُقيّدة تلقائيًا" — لو موجود امسحه.<br><br>
    <b>2.</b> الإعدادات ← التطبيقات ← Chrome ← البطارية<br>
    اختار <b>"بدون قيود" (Unrestricted)</b> بدل "محسّن".`,
  xiaomi: `
    <b>1.</b> الإعدادات ← التطبيقات ← إدارة التطبيقات ← Chrome<br>
    فعّل <b>"البدء التلقائي" (Autostart)</b>.<br><br>
    <b>2.</b> من نفس الصفحة ← توفير البطارية<br>
    اختار <b>"بدون قيود" (No restrictions)</b> بدل الوضع الموفّر.`,
  huawei: `
    <b>1.</b> الإعدادات ← البطارية ← إطلاق التطبيقات (App launch)<br>
    دور على Chrome وشيّل الوضع التلقائي، وفعّل يدويًا: <b>البدء التلقائي</b>، <b>البدء الثانوي</b>، و<b>التشغيل في الخلفية</b> الثلاثة.`,
  other: `
    <b>1.</b> افتح إعدادات البطارية بتاعة جهازك ودور على أي إعداد اسمه "تحسين البطارية" أو "Battery Optimization".<br>
    <b>2.</b> دور على Chrome (أو المتصفح اللي بتستخدمه) واستثنيه من التحسين، أو اختار "بدون قيود".`,
  ios: `
    على آيفون، الإشعارات في الخلفية بتشتغل بس لو الموقع <b>مضاف للشاشة الرئيسية</b> (Add to Home Screen) وبتفتحه من الأيقونة دي مش من المتصفح مباشرة.<br><br>
    لو مضفتوش لسه: دوس زرار المشاركة في Safari ← "إضافة إلى الشاشة الرئيسية".`,
};

function detectDeviceForNotifGuide(){
  const ua = navigator.userAgent || '';
  if(/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if(/SM-|Samsung/i.test(ua)) return 'samsung';
  if(/Xiaomi|Redmi|MI /i.test(ua)) return 'xiaomi';
  if(/Huawei|Honor/i.test(ua)) return 'huawei';
  return 'other';
}

function openNotifGuide(){
  document.getElementById('notifGuideOverlay').classList.add('active');
  showNotifGuideFor(detectDeviceForNotifGuide());
}
function closeNotifGuide(){
  document.getElementById('notifGuideOverlay').classList.remove('active');
}
function showNotifGuideFor(device){
  document.getElementById('notifGuideContent').innerHTML = NOTIF_GUIDE_CONTENT[device] || NOTIF_GUIDE_CONTENT.other;
  ['samsung','xiaomi','huawei','other','ios'].forEach(d=>{
    document.getElementById('notifTab'+d.charAt(0).toUpperCase()+d.slice(1))?.classList.toggle('active', d===device);
  });
}

function updateNotifToggleUI(){
  const supported = ('Notification' in window) && ('serviceWorker' in navigator) && ('PushManager' in window);
  const granted = supported && Notification.permission === 'granted';
  for(const id of ['notifToggleBtn','notifToggleBtnMobile']){
    const btn = document.getElementById(id);
    if(!btn) continue;
    if(!supported){ btn.style.display = 'none'; continue; }
    btn.style.display = 'block';
    btn.innerHTML = granted ? '<i class="fa-solid fa-bell"></i> الإشعارات مفعّلة (اضغط لخطوات الإعداد)' : '<i class="fa-solid fa-bell-slash"></i> فعّل الإشعارات';
    btn.classList.toggle('active', granted);
  }
}

/* ================= THEME ================= */
function toggleTheme(){
  const isLight = document.body.classList.toggle('light-mode');
  try{ localStorage.setItem('dv-theme', isLight ? 'light' : 'dark'); }catch(e){}
  const icon = isLight ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
  const btn1 = document.getElementById('themeToggleBtn'); if(btn1) btn1.innerHTML = icon;
  const btn2 = document.getElementById('themeToggleBtnLanding'); if(btn2) btn2.innerHTML = icon;
}
(function applySavedTheme(){
  let saved = null;
  try{ saved = localStorage.getItem('dv-theme'); }catch(e){}
  if(saved === 'light'){
    document.body.classList.add('light-mode');
    const btn1 = document.getElementById('themeToggleBtn'); if(btn1) btn1.innerHTML = '<i class="fa-solid fa-sun"></i>';
    const btn2 = document.getElementById('themeToggleBtnLanding'); if(btn2) btn2.innerHTML = '<i class="fa-solid fa-sun"></i>';
  }
})();

loadCategoriesForLanding();
async function loadCategoriesForLanding(){
  const { data } = await sb.from('categories').select('*').order('sort_order');
  if(data){ categories = data; document.getElementById('sectionGrid').innerHTML = data.map(c=>`<div class="section-chip">${c.name_ar}</div>`).join(''); loadLandingStats(); }
}
initSession();
