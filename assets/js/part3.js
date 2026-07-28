function bindDragDropUpload(containerId, sendFileFn){
  const box = document.getElementById(containerId);
  if(!box || box.dataset.dragBound) return;
  box.dataset.dragBound = '1';

  let dragCounter = 0;

  box.addEventListener('dragenter', (e)=>{
    e.preventDefault();
    dragCounter++;
    box.classList.add('drag-over');
  });
  box.addEventListener('dragover', (e)=>{ e.preventDefault(); });
  box.addEventListener('dragleave', (e)=>{
    e.preventDefault();
    dragCounter--;
    if(dragCounter <= 0){ dragCounter = 0; box.classList.remove('drag-over'); }
  });
  box.addEventListener('drop', (e)=>{
    e.preventDefault();
    dragCounter = 0;
    box.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if(!files || !files.length) return;
    // نبعت أول ملف بس (زي واتساب/تيليجرام وقت السحب المباشر)
    const fakeInput = { files: [files[0]], value: '' };
    sendFileFn(fakeInput);
  });
}

function bindRoomInfiniteScroll(){
  const box = document.getElementById('chatMessages');
  if(!box || box.dataset.infiniteBound) return;
  box.dataset.infiniteBound = '1';
  box.addEventListener('scroll', ()=>{
    if(box.scrollTop < 80) loadOlderRoomMessages();
    updateRoomScrollDownBtn();
  });
}

let roomUnseenWhileScrolledUp = 0;
function updateRoomScrollDownBtn(){
  const box = document.getElementById('chatMessages');
  const btn = document.getElementById('roomScrollDownBtn');
  if(!box || !btn) return;
  const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  const isNearBottom = distanceFromBottom < 150;
  btn.classList.toggle('visible', !isNearBottom);
  if(isNearBottom){
    roomUnseenWhileScrolledUp = 0;
    document.getElementById('roomScrollDownBadge').style.display = 'none';
  }
}

function scrollRoomToBottom(){
  const box = document.getElementById('chatMessages');
  if(!box) return;
  box.scrollTo({ top: box.scrollHeight, behavior:'smooth' });
  roomUnseenWhileScrolledUp = 0;
  document.getElementById('roomScrollDownBadge').style.display = 'none';
}

async function loadOlderRoomMessages(){
  if(loadingOlderRoomMessages || !roomHasMoreOlder || !currentRoomMessages.length || !activeRoomId) return;
  loadingOlderRoomMessages = true;
  const box = document.getElementById('chatMessages');
  const loadingEl = document.createElement('div');
  loadingEl.className = 'older-msgs-loading';
  loadingEl.innerHTML = `<div class="spinner"></div>`;
  box.prepend(loadingEl);

  const oldestCreatedAt = currentRoomMessages[0].created_at;
  const { data: olderDesc } = await sb.from('chat_messages')
    .select('*, profiles!sender_id(username, avatar_file_id), reply:reply_to_id(id, sender_id, content, profiles!sender_id(username))')
    .eq('room_id', activeRoomId)
    .lt('created_at', oldestCreatedAt)
    .order('created_at', { ascending:false })
    .limit(100);
  loadingEl.remove();

  const older = (olderDesc||[]).slice().reverse();
  if(!older.length){ roomHasMoreOlder = false; loadingOlderRoomMessages = false; return; }
  if(older.length < 100) roomHasMoreOlder = false;

  currentRoomMessages = [...older, ...currentRoomMessages];
  cacheMessages(conversationIdFor('room', activeRoomId), older);

  // نحافظ على موضع السكرول الحالي عشان الشاشة متقفزش تحت وانت بتقرا رسايل قديمة
  const prevScrollHeight = box.scrollHeight;
  const prevScrollTop = box.scrollTop;
  prependMessages(box, older);
  box.scrollTop = box.scrollHeight - prevScrollHeight + prevScrollTop;

  loadingOlderRoomMessages = false;
}

function prependMessages(box, older){
  const fragment = older.map(m=>renderOneMessage(m, m.profiles?.username, m.profiles?.avatar_file_id)).join('');
  box.insertAdjacentHTML('afterbegin', fragment);
  older.forEach(m=>{
    if(m.profiles?.avatar_file_id) loadAvatarInto(`msgav-${m.id}`, m.profiles.avatar_file_id);
    if(!m.is_removed && m.telegram_file_id) loadMessageMedia(m);
    if(!m.is_removed) loadMessageReactions(m.id);
  });
  applyLocalNicknamesToSenders(box);
}

/* يحوّل سجل الكاش المحلي (نسخة خفيفة) لشكل قريب من كائن الرسالة الحقيقي عشان renderOneMessage تقدر تستخدمه */
async function applyLocalNicknamesToSenders(container){
  const senderEls = container.querySelectorAll('.sender[data-sender-id]');
  const uniqueIds = [...new Set([...senderEls].map(el=>el.dataset.senderId))];
  for(const uid of uniqueIds){
    const nick = await getNickname(uid);
    if(!nick) continue;
    container.querySelectorAll(`.sender[data-sender-id="${uid}"]`).forEach(el=>{
      el.textContent = '@' + nick;
      el.title = 'اسم مستعار محلي';
    });
  }
}

function fromCachedMessage(c){
  return {
    id: c.id,
    sender_id: c.sender_id,
    room_id: c.room_id,
    receiver_id: c.receiver_id,
    content: c.content,
    message_type: c.message_type,
    telegram_file_id: c.telegram_file_id,
    duration_seconds: c.duration_seconds,
    is_removed: c.is_removed,
    is_pinned: c.is_pinned,
    created_at: c.created_at,
    edited_at: c.edited_at,
    reply_to_id: c.reply_to_id,
    reply: null, // الرد المقتبس مش متخزن في الكاش الخفيف، هيظهر لما السيرفر يرد
    profiles: c.sender_username ? { username: c.sender_username } : null,
  };
}

function findFirstUnreadMessageId(msgs, lastReadAt){
  if(!lastReadAt) return null; // أول مرة يدخل الغرفة، مفيش خط لأن كل حاجة "جديدة" عليه أصلاً
  const cutoff = new Date(lastReadAt).getTime();
  const firstUnread = msgs.find(m => m.sender_id !== currentUser.id && new Date(m.created_at).getTime() > cutoff);
  return firstUnread ? firstUnread.id : null;
}

function canModerateRoom(){
  return ['owner','super_admin','admin','moderator'].includes(currentProfile.role) || (activeRoomCreatorId && activeRoomCreatorId === currentUser.id);
}

function canDeleteMessage(m){
  return m.sender_id === currentUser.id
    || ['owner','super_admin','admin','moderator'].includes(currentProfile.role)
    || (activeRoomCreatorId && activeRoomCreatorId === currentUser.id);
}

function renderMessages(msgs, firstUnreadId){
  const box = document.getElementById('chatMessages');
  if(!box) return;
  box.innerHTML = msgs.map(m=>{
    const divider = (firstUnreadId && m.id===firstUnreadId) ? `<div class="unread-divider">رسائل غير مقروءة</div>` : '';
    return divider + renderOneMessage(m, m.profiles?.username, m.profiles?.avatar_file_id);
  }).join('');
  bindMsgLongPress(box);
  msgs.forEach(m=>{
    if(m.profiles?.avatar_file_id) loadAvatarInto(`msgav-${m.id}`, m.profiles.avatar_file_id);
    if(!m.is_removed && m.telegram_file_id) loadMessageMedia(m);
    if(!m.is_removed) loadMessageReactions(m.id);
  });
  applyLocalNicknamesToSenders(box);
  // لو فيه خط فاصل، نقف عنده بدل ما نروح لآخر رسالة على طول (زي واتساب)
  if(firstUnreadId){
    const dividerEl = box.querySelector('.unread-divider');
    if(dividerEl){ dividerEl.scrollIntoView({ block:'center' }); updateRoomScrollDownBtn(); return; }
  }
  box.scrollTop = box.scrollHeight;
  updateRoomScrollDownBtn();
}

function renderOneMessage(m, username, avatarFileId){
  const mine = m.sender_id===currentUser.id;
  const initials = (username||'?')[0]?.toUpperCase()||'?';
  const usernameEsc = escapeHtml((username||'')).replace(/'/g,"\\'");
  const isMedia = !m.is_removed && (m.message_type==='image' || m.message_type==='video');
  return `
    <div class="msg-row ${mine?'mine':''}" data-msg-id="${m.id}">
      <div class="msg-avatar" id="msgav-${m.id}" onclick="viewProfile('${m.sender_id}')">${initials}</div>
      <i class="fa-solid fa-reply msg-reply-hint"></i>
      <div style="display:flex;flex-direction:column;max-width:66%">
        <div class="msg ${mine?'mine':''} ${isMedia?'has-media':''}" id="msgel-${m.id}" style="position:relative;max-width:100%" data-msg-id="${m.id}" data-ctx="room" data-username="${usernameEsc}">
          ${!m.is_removed ? `<div class="sender" id="sendername-${m.id}" data-sender-id="${m.sender_id}" style="cursor:pointer" onclick="event.stopPropagation();viewProfile('${m.sender_id}')">@${username||''}</div>` : ''}
          ${m.is_removed ? `<i style="color:var(--ink-faint)">تم حذف هذه الرسالة</i>` : `
            ${m.reply ? `<div class="msg-quote-ref" style="border-right-color:${colorForUser(m.reply.sender_id)}" onclick="event.stopPropagation();scrollToMessage('${m.reply.id||''}')"><i class="fa-solid fa-arrow-turn-up msg-quote-arrow" style="color:${colorForUser(m.reply.sender_id)}"></i><span style="color:${colorForUser(m.reply.sender_id)};font-weight:700">@${m.reply.profiles?.username||''}</span>: ${renderMentionText(escapeHtml((m.reply.content||'').slice(0,50)))}</div>` : ''}
            <div class="no-select" style="position:relative">${renderMessageBody(m)}${isMedia?`<span class="msg-media-time-overlay">${formatMsgTime(m.created_at)}${m.edited_at?" · معدّلة":""}</span>`:''}</div>
            ${!isMedia ? `<div class="msg-timestamp-row" style="font-size:10px;color:${mine?'rgba(255,255,255,.7)':'var(--ink-faint)'};margin-top:3px;text-align:left">${formatMsgTime(m.created_at)}${m.edited_at?" · معدّلة":""}${m.is_pinned?' · <i class="fa-solid fa-thumbtack"></i>':''}</div>` : ''}
          `}
        </div>
        <div class="msg-reaction-row ${mine?'mine':''}" id="msgreact-${m.id}"></div>
      </div>
    </div>`;
}

async function openMessageInfo(msgId){
  document.getElementById('messageInfoOverlay')?.classList.add('active');
  const listEl = document.getElementById('messageInfoList');
  if(listEl) listEl.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  const { data: readers, error } = await sb.rpc('get_message_read_by', { p_message_id: msgId });
  if(!listEl) return;
  if(error){ listEl.innerHTML = `<div class="empty-state" style="color:var(--red)">تعذر التحميل: ${escapeHtml(error.message)}</div>`; return; }
  if(!readers?.length){ listEl.innerHTML = `<div class="empty-state">محدش شاف الرسالة دي لسه</div>`; return; }
  listEl.innerHTML = readers.map((r, i)=>`
    <div class="member-row" style="animation:fadeInUp 0.3s var(--ease-out) ${i * 0.04}s both">
      <div class="avatar" id="msginfo-av-${r.user_id}" style="width:28px;height:28px;font-size:12px;cursor:pointer" onclick="closeMessageInfo();viewProfile('${r.user_id}')">${(r.username||'?')[0].toUpperCase()}</div>
      <div class="name" style="cursor:pointer;flex:1" onclick="closeMessageInfo();viewProfile('${r.user_id}')">${escapeHtml(r.full_name||r.username||'مستخدم')}</div>
      <div class="meta" style="font-size:11px;color:var(--ink-faint)">${formatMsgTime(r.read_at)}</div>
    </div>`).join('');
  readers.forEach(r=>{ if(r.avatar_file_id) loadAvatarInto(`msginfo-av-${r.user_id}`, r.avatar_file_id); });
}
function closeMessageInfo(){
  document.getElementById('messageInfoOverlay')?.classList.remove('active');
}

function renderMessageBody(m){
  if(m.message_type==='voice'){
    return `<div class="msg-voice" id="msgmedia-${m.id}"><i class="fa-solid fa-microphone"></i> <span style="font-size:12px;color:var(--ink-faint)">${m.duration_seconds?formatDuration(m.duration_seconds):''}</span></div>`;
  }
  if(m.message_type==='image'){
    return `<div class="msg-media" id="msgmedia-${m.id}">${escapeHtml(m.content||'')}</div>`;
  }
  if(m.message_type==='video'){
    return `<div class="msg-media" id="msgmedia-${m.id}">${escapeHtml(m.content||'')}</div>`;
  }
  if(m.message_type==='document'){
    return `<div id="msgmedia-${m.id}"><i class="fa-solid fa-paperclip"></i> ${escapeHtml(m.content||'ملف')}</div>`;
  }
  return renderMentionText(escapeHtml(m.content||''));
}

/* يلوّن أي @username داخل نص متمّ عليه escapeHtml بالفعل */
function renderMentionText(escapedText){
  if(!escapedText) return escapedText;
  return escapedText.replace(/@([A-Za-z0-9_\u0600-\u06FF]+)/g, '<span class="mention-tag">@$1</span>');
}

function scrollToMessage(msgId){
  if(!msgId) return;
  const el = document.getElementById(`msgel-${msgId}`);
  if(!el){ toast('الرسالة مش محمّلة في الشاشة دلوقتي', 'error'); return; }
  el.scrollIntoView({ behavior:'smooth', block:'center' });
  el.classList.add('msg-flash-highlight');
  setTimeout(()=>el.classList.remove('msg-flash-highlight'), 1600);
}

function formatDuration(sec){
  const m = Math.floor(sec/60), s = sec%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

async function loadMessageMedia(m){
  const el = document.getElementById(`msgmedia-${m.id}`);
  if(!el) return;
  if(m.message_type==='video'){
    el.innerHTML = `<div class="video-play-placeholder" style="height:160px" onclick="playStreamedMessageVideo('${m.id}', '${escapeHtml(m.telegram_file_id)}')">
      <i class="fa-solid fa-circle-play"></i>
    </div>`;
    return;
  }
  if(m.message_type==='voice'){
    const streamUrl = await getTelegramStreamUrl(m.telegram_file_id);
    if(!streamUrl) return;
    el.innerHTML = `<audio controls src="${streamUrl}"></audio> <span style="font-size:12px;color:var(--ink-faint)">${m.duration_seconds?formatDuration(m.duration_seconds):''}</span>`;
    return;
  }
  const cached = getCachedFile(m.telegram_file_id);
  const url = cached || await getTelegramFileBlobUrl(m.telegram_file_id);
  if(!url) return;
  if(!cached){
    try{
      const res = await fetch(url); const blob = await res.blob();
      const dataUrl = await blobToDataURL(blob);
      setCachedFile(m.telegram_file_id, dataUrl);
    }catch(e){ /* best-effort caching only */ }
  }
  el.innerHTML = `<img src="${url}" onclick="event.stopPropagation();openImageViewer('${url}')">`;
}

async function playStreamedMessageVideo(msgId, fileId){
  const el = document.getElementById(`msgmedia-${msgId}`);
  if(!el) return;
  const streamUrl = await getTelegramStreamUrl(fileId);
  if(!streamUrl){ toast('تعذر تشغيل الفيديو', 'error'); return; }
  el.innerHTML = `<video src="${streamUrl}" controls playsinline onclick="event.stopPropagation();openVideoViewer('${streamUrl}')"></video>`;
}

async function togglePinMessage(msgId, pinTo){
  const { error } = await sb.from('chat_messages').update({ is_pinned: pinTo }).eq('id', msgId);
  if(error){ toast('خطأ: '+error.message, 'error'); }
}

async function editMessage(msgId, currentContent){
  const newContent = await customPrompt('عدّل رسالتك:', currentContent);
  if(newContent===null || !newContent.trim() || newContent===currentContent) return;
  const { error } = await sb.from('chat_messages').update({ content: newContent.trim(), edited_at: new Date().toISOString() }).eq('id', msgId);
  if(error){ toast('تعذر التعديل: '+error.message, 'error'); }
}

async function deleteMessage(msgId){
  if(!await customConfirm('تحذف الرسالة دي؟', true)) return;
  const { error } = await sb.from('chat_messages').update({ is_removed: true }).eq('id', msgId);
  if(error){ toast('تعذر الحذف: '+error.message, 'error'); }
}

function setReplyTarget(msgId, username, preview){
  replyingTo = msgId;
  const bar = document.getElementById('replyBar');
  if(bar){ bar.style.display='flex'; document.getElementById('replyBarText').textContent = `رد على @${username}: ${preview}`; }
}
function cancelReply(){
  replyingTo = null;
  const bar = document.getElementById('replyBar');
  if(bar) bar.style.display='none';
}

function isScrolledNearBottom(box){
  if(!box) return true;
  return (box.scrollHeight - box.scrollTop - box.clientHeight) < 120;
}

let roomPollInterval = null;
let lastSeenRoomMsgAt = {};

function subscribeToRoom(roomId){
  if(roomChannel) sb.removeChannel(roomChannel);
  roomChannel = sb.channel('room-'+roomId)
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'chat_messages', filter:`room_id=eq.${roomId}` }, async (payload)=>{
      await appendRoomMessageIfNew(payload.new.id);
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'chat_messages', filter:`room_id=eq.${roomId}` }, async (payload)=>{
      await patchRoomMessage(payload.new.id, roomId);
    }).subscribe();
  if(roomPollInterval) clearInterval(roomPollInterval);
  roomPollInterval = setInterval(()=> pollRoomMessages(roomId), 3000);
}

async function appendRoomMessageIfNew(msgId){
  const box = document.getElementById('chatMessages');
  if(!box) return;
  if(document.getElementById(`msgav-${msgId}`)) return;
  const wasNearBottom = isScrolledNearBottom(box);
  const { data: full } = await sb.from('chat_messages')
    .select('*, profiles!sender_id(username, avatar_file_id), reply:reply_to_id(id, sender_id, content, profiles!sender_id(username))')
    .eq('id', msgId).single();
  if(!full) return;
  if(document.getElementById(`msgav-${full.id}`)) return;
  box.insertAdjacentHTML('beforeend', renderOneMessage(full, full.profiles?.username, full.profiles?.avatar_file_id));
  if(full.profiles?.avatar_file_id) loadAvatarInto(`msgav-${full.id}`, full.profiles.avatar_file_id);
  if(full.telegram_file_id) loadMessageMedia(full);
  if(wasNearBottom) box.scrollTop = box.scrollHeight;
  if(full.room_id) lastSeenRoomMsgAt[full.room_id] = full.created_at;
}

async function patchRoomMessage(msgId, roomId){
  const { data: full } = await sb.from('chat_messages')
    .select('*, profiles!sender_id(username, avatar_file_id), reply:reply_to_id(id, sender_id, content, profiles!sender_id(username))')
    .eq('id', msgId).single();
  if(!full) return;
  const row = document.getElementById(`msgav-${full.id}`)?.closest('.msg-row');
  if(row) row.outerHTML = renderOneMessage(full, full.profiles?.username, full.profiles?.avatar_file_id);
  if(full.profiles?.avatar_file_id) loadAvatarInto(`msgav-${full.id}`, full.profiles.avatar_file_id);
  if(!full.is_removed && full.telegram_file_id) loadMessageMedia(full);
  refreshPinnedBanner(roomId);
}

async function pollRoomMessages(roomId){
  if(roomId !== activeRoomId) return;
  const since = lastSeenRoomMsgAt[roomId];
  if(!since) return;
  const { data: rows } = await sb.from('chat_messages')
    .select('id, created_at')
    .eq('room_id', roomId)
    .gt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(50);
  if(!rows?.length) return;
  for(const row of rows){
    await appendRoomMessageIfNew(row.id);
  }
}

async function refreshPinnedBanner(roomId){
  const { data: pinned } = await sb.from('chat_messages').select('id, content').eq('room_id', roomId).eq('is_pinned', true).eq('is_removed', false).order('created_at', {ascending:false}).limit(1);
  const banner = document.getElementById('pinnedBanner');
  if(!banner) return;
  if(!pinned?.length){ banner.innerHTML=''; return; }
  const last = pinned[0];
  banner.innerHTML = `<div style="padding:8px 20px;background:rgba(99,102,241,.08);border-bottom:1px solid var(--border);font-size:12px;display:flex;align-items:center;gap:8px">
    <span><i class="fa-solid fa-thumbtack"></i></span><span style="flex:1">${escapeHtml((last.content||'').slice(0,80))}</span>
    <span style="cursor:pointer;color:var(--ink-faint)" onclick="togglePinMessage('${last.id}', false)">إلغاء التثبيت</span>
  </div>`;
}

let typingChannel = null;
let typingTimeout = null;
let typingUsers = new Map();
function subscribeToTyping(roomId){
  if(typingChannel) sb.removeChannel(typingChannel);
  typingUsers = new Map();
  typingChannel = sb.channel('typing-'+roomId)
    .on('broadcast', { event:'typing' }, (payload)=>{
      const { user_id, username } = payload.payload;
      if(user_id === currentUser.id) return;
      typingUsers.set(user_id, username);
      renderTypingIndicator();
      clearTimeout(typingUsers.get('_timeout_'+user_id));
      const t = setTimeout(()=>{ typingUsers.delete(user_id); renderTypingIndicator(); }, 3000);
      typingUsers.set('_timeout_'+user_id, t);
    }).subscribe();
}

function renderTypingIndicator(){
  const el = document.getElementById('typingIndicator');
  if(!el) return;
  const names = [...typingUsers.entries()].filter(([k])=>!k.startsWith('_timeout_')).map(([,v])=>v);
  if(!names.length){ el.innerHTML = ''; el.classList.remove('typing-indicator-active'); return; }
  el.classList.add('typing-indicator-active');
  el.innerHTML = `${escapeHtml(names.join('، '))} بيكتب<span class="typing-dots"><span></span><span></span><span></span></span>`;
}

function broadcastTyping(){
  if(!typingChannel || !activeRoomId) return;
  clearTimeout(typingTimeout);
  typingChannel.send({ type:'broadcast', event:'typing', payload:{ user_id: currentUser.id, username: currentProfile.username } });
}

let sendingChatMessage = false;
async function sendChatMessage(){
  if(sendingChatMessage) return;
  const input = document.getElementById('chatInput');
  const content = input.value.trim();
  if(!content || !activeRoomId) return;
  sendingChatMessage = true;
  input.disabled = true;
  const { error } = await sb.from('chat_messages').insert({ room_id: activeRoomId, sender_id: currentUser.id, content, message_type:'text', reply_to_id: replyingTo });
  input.disabled = false;
  sendingChatMessage = false;
  if(error){ toast('تعذر الإرسال: '+error.message, 'error'); return; }
  input.value='';
  input.style.height = 'auto';
  input.focus();
  cancelReply();
}

async function sendChatFile(input){
  const file = input.files[0];
  if(!file || !activeRoomId) return;
  try{
    const kind = file.type.startsWith('image')?'photo':file.type.startsWith('video')?'video':'document';
    const up = await uploadToTelegram(file, kind, { type:'room', roomId: activeRoomId });
    const { error } = await sb.from('chat_messages').insert({
      room_id: activeRoomId, sender_id: currentUser.id, message_type: kind==='photo'?'image':kind,
      telegram_file_id: up.file_id, telegram_message_id: up.telegram_message_id || null, content: file.name
    });
    if(error) throw error;
    input.value = '';
  }catch(e){ toast('فشل رفع الملف: '+e.message, 'error'); }
}

/* ================= VOICE MESSAGES ================= */
let voiceRecorder = null;
let voiceChunks = [];
let voiceStartTime = 0;
let voiceTimerInterval = null;
let voiceStream = null;

async function startVoiceRecording(context){
  if(voiceRecorder && voiceRecorder.state==='recording') return;
  if(!navigator.mediaDevices || !window.MediaRecorder){
    toast('تسجيل الصوت مش مدعوم في المتصفح ده', 'error'); return;
  }
  try{
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }catch(e){
    toast('محتاجين إذن الميكروفون عشان تبعت رسالة صوتية', 'error'); return;
  }
  voiceChunks = [];
  voiceRecorder = new MediaRecorder(voiceStream);
  voiceRecorder.ondataavailable = (e)=>{ if(e.data.size>0) voiceChunks.push(e.data); };
  voiceRecorder.start();
  voiceStartTime = Date.now();
  const barId = context==='room' ? 'roomRecordBar' : 'dmRecordBar';
  const timeId = context==='room' ? 'roomRecordTime' : 'dmRecordTime';
  document.getElementById(barId)?.classList.add('active');
  voiceTimerInterval = setInterval(()=>{
    const sec = Math.floor((Date.now()-voiceStartTime)/1000);
    const el = document.getElementById(timeId);
    if(el) el.textContent = formatDuration(sec);
  }, 250);
}

function cancelVoiceRecording(context){
  if(voiceRecorder && voiceRecorder.state==='recording'){
    voiceRecorder.onstop = null;
    voiceRecorder.stop();
  }
  cleanupVoiceRecording(context);
}

function cleanupVoiceRecording(context){
  clearInterval(voiceTimerInterval);
  voiceTimerInterval = null;
  if(voiceStream){ voiceStream.getTracks().forEach(t=>t.stop()); voiceStream = null; }
  const barId = context==='room' ? 'roomRecordBar' : 'dmRecordBar';
  document.getElementById(barId)?.classList.remove('active');
  voiceRecorder = null;
  voiceChunks = [];
}

async function stopVoiceRecording(context){
  if(!voiceRecorder || voiceRecorder.state!=='recording'){ cleanupVoiceRecording(context); return; }
  const durationSec = Math.round((Date.now()-voiceStartTime)/1000);
  const finalizedBlob = await new Promise((resolve)=>{
    voiceRecorder.onstop = ()=> resolve(new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' }));
    voiceRecorder.stop();
  });
  cleanupVoiceRecording(context);
  if(durationSec < 1){ toast('التسجيل قصير جدًا', 'error'); return; }
  const file = new File([finalizedBlob], `voice-${Date.now()}.webm`, { type: finalizedBlob.type });
  try{
    const uploadContext = context==='room' ? { type:'room', roomId: activeRoomId } : { type:'dm', otherUserId: activeDmUserId };
    const up = await uploadToTelegram(file, 'voice', uploadContext);
    if(context==='room'){
      if(!activeRoomId) return;
      const { error } = await sb.from('chat_messages').insert({
        room_id: activeRoomId, sender_id: currentUser.id, message_type:'voice',
        telegram_file_id: up.file_id, telegram_message_id: up.telegram_message_id || null, duration_seconds: durationSec, reply_to_id: replyingTo
      });
      if(error) throw error;
      cancelReply();
    } else {
      if(!activeDmUserId) return;
      const { error } = await sb.from('chat_messages').insert({
        sender_id: currentUser.id, receiver_id: activeDmUserId, message_type:'voice',
        telegram_file_id: up.file_id, telegram_message_id: up.telegram_message_id || null, duration_seconds: durationSec, reply_to_id: dmReplyingTo
      });
      if(error) throw error;
      cancelDmReply();
    }
  }catch(e){ toast('فشل إرسال الرسالة الصوتية: '+e.message, 'error'); }
}

/* ================= PROFILE ================= */
async function renderProfile(container, userId){
  const isOwn = userId === currentUser.id;
  let p;
  if(isOwn){ p = currentProfile; }
  else{
    const { data, error } = await sb.from('profiles').select('*').eq('id', userId).single();
    if(error || !data){ container.innerHTML = `<div class="view"><div class="empty-state">تعذر تحميل هذا المستخدم</div></div>`; return; }
    p = data;
  }
  let isFollowing = false;
  if(!isOwn){
    const { data: f } = await sb.from('user_follows').select('*').eq('follower_id', currentUser.id).eq('following_id', p.id).maybeSingle();
    isFollowing = !!f;
  }
  const [{count:followers}, {count:following}] = await Promise.all([
    sb.from('user_follows').select('*',{count:'exact',head:true}).eq('following_id', p.id),
    sb.from('user_follows').select('*',{count:'exact',head:true}).eq('follower_id', p.id),
  ]);
  const links = [
    p.github_url ? `<a href="${escapeHtml(p.github_url)}" target="_blank"><i class="fa-brands fa-github"></i> GitHub</a>` : '',
    p.linkedin_url ? `<a href="${escapeHtml(p.linkedin_url)}" target="_blank"><i class="fa-brands fa-linkedin"></i> LinkedIn</a>` : '',
    p.portfolio_url ? `<a href="${escapeHtml(p.portfolio_url)}" target="_blank"><i class="fa-solid fa-briefcase"></i> Portfolio</a>` : '',
    p.website_url ? `<a href="${escapeHtml(p.website_url)}" target="_blank"><i class="fa-solid fa-globe"></i> Website</a>` : '',
  ].filter(Boolean).join('');
  container.innerHTML = `
    <div class="view">
      <div class="profile-header">
        <div class="profile-cover" id="profileCover" ${isOwn?'onclick="document.getElementById(\'coverUploadInput\').click()"':''}>
          ${isOwn ? `<span class="cover-hint"><i class="fa-solid fa-camera"></i> غيّر صورة الغلاف</span><input type="file" id="coverUploadInput" accept="image/*" style="display:none" onchange="uploadCover(this)">` : ''}
        </div>
        <div class="profile-body">
          <div class="profile-top">
            <div class="avatar-lg" id="profileAvatarLg" style="position:relative;cursor:${isOwn?'pointer':'default'}" ${isOwn?'onclick="document.getElementById(\'avatarUploadInput\').click()"':''}>${(p.username||'?')[0].toUpperCase()}</div>
            <div>
              <h2 style="font-family:var(--font-display);font-size:22px" id="profileDisplayName">${escapeHtml(p.full_name||p.username)}</h2>
              <div style="color:var(--ink-faint);font-family:var(--font-mono);font-size:13px">@${p.username} · ${p.role}</div>
            </div>
            ${isOwn ? `<input type="file" id="avatarUploadInput" accept="image/*" style="display:none" onchange="uploadAvatar(this)">` : ''}
          </div>
          <div style="color:var(--ink-dim);font-size:14px">${escapeHtml(p.bio||(isOwn?'مفيش نبذة لسه — اضغط تعديل عشان تضيف واحدة':''))}</div>
          ${links ? `<div class="social-links">${links}</div>` : ''}
          <div class="profile-stats">
            <div><div class="n">${p.xp??0}</div><div class="l">XP</div></div>
            <div><div class="n">${p.level??0}</div><div class="l">Level</div></div>
            <div><div class="n">${p.reputation}</div><div class="l">Reputation</div></div>
            <div><div class="n">${followers||0}</div><div class="l">متابِع</div></div>
            <div><div class="n">${following||0}</div><div class="l">يتابع</div></div>
          </div>
          ${renderXpProgressBar(p.xp??0, p.level??0)}
          <div style="margin-top:12px">${(p.skills||[]).map(s=>`<span class="tag">${escapeHtml(s)}</span>`).join('') || '<span style="color:var(--ink-faint);font-size:12px">مفيش مهارات مضافة</span>'}</div>
          ${isOwn
            ? `<button class="btn btn-sm" style="margin-top:16px" onclick="editProfile()">تعديل الملف الشخصي</button>
               <button class="btn btn-sm" style="margin-top:16px" onclick="openLocalDisplayNamePrompt()"><i class="fa-solid fa-pen"></i> اسمي المحلي</button>
               <button class="btn btn-sm" style="margin-top:16px" onclick="openLocalSettingsModal()"><i class="fa-solid fa-gear"></i> الإعدادات</button>`
            : `<button class="btn btn-sm ${isFollowing?'':'btn-primary'}" style="margin-top:16px" onclick="toggleFollow('${p.id}', ${isFollowing})">${isFollowing?'إلغاء المتابعة':'متابعة'}</button>
               <button class="btn btn-sm" style="margin-top:16px" onclick="openDmConversation('${p.id}','${escapeHtml(p.username)}')"><i class="fa-solid fa-envelope"></i> رسالة</button>
               <button class="btn btn-sm" style="margin-top:16px" onclick="openNicknamePrompt('${p.id}','${escapeHtml(p.username).replace(/'/g,"\\'")}','${escapeHtml(p.full_name||p.username).replace(/'/g,"\\'")}')"><i class="fa-solid fa-tag"></i> اسم مستعار</button>`}
        </div>
      </div>
      <div class="profile-tabs">
        <div class="profile-tab active" data-ptab="posts" onclick="switchProfileTab('posts','${p.id}',${isOwn})">المنشورات</div>
        <div class="profile-tab" data-ptab="portfolio" onclick="switchProfileTab('portfolio','${p.id}',${isOwn})">معرض المشاريع</div>
        <div class="profile-tab" data-ptab="gallery" onclick="switchProfileTab('gallery','${p.id}',${isOwn})">معرض الصور</div>
        <div class="profile-tab" data-ptab="media" onclick="switchProfileTab('media','${p.id}',${isOwn})">الوسائط</div>
        <div class="profile-tab" data-ptab="activity" onclick="switchProfileTab('activity','${p.id}',${isOwn})">النشاط</div>
      </div>
      <div id="profileTabContent"><div class="empty-state"><div class="spinner"></div></div></div>
    </div>`;
  if(p.avatar_file_id) loadAvatarInto('profileAvatarLg', p.avatar_file_id);
  if(p.cover_file_id) loadCoverInto('profileCover', p.cover_file_id);
  applyLocalNameToProfileHeader(p, isOwn);
  switchProfileTab('posts', p.id, isOwn);
}

async function applyLocalNameToProfileHeader(p, isOwn){
  const nameEl = document.getElementById('profileDisplayName');
  if(!nameEl) return;
  if(isOwn){
    const localName = await getLocalDisplayName();
    if(localName) nameEl.textContent = localName;
  }else{
    const nick = await getNickname(p.id);
    if(nick) nameEl.textContent = nick;
  }
}

async function openLocalDisplayNamePrompt(){
  const current = await getLocalDisplayName();
  const name = await customPrompt('اسمك اللي هيظهرلك أنت بس في التطبيق (محلي على جهازك، مش هيتغير عند حد تاني):', current || currentProfile.full_name || currentProfile.username);
  if(name===null) return;
  await setLocalDisplayName(name.trim());
  const nameEl = document.getElementById('profileDisplayName');
  if(nameEl) nameEl.textContent = name.trim() || currentProfile.full_name || currentProfile.username;
  toast('اتحفظ اسمك المحلي', 'success');
}

async function openNicknamePrompt(userId, username, currentFullName){
  const current = await getNickname(userId);
  const nickname = await customPrompt(`اسم مستعار لـ @${username} (يظهرلك أنت بس، محلي على جهازك):`, current || '');
  if(nickname===null) return;
  await setNickname(userId, nickname);
  const nameEl = document.getElementById('profileDisplayName');
  if(nameEl) nameEl.textContent = nickname.trim() || currentFullName;
  toast(nickname.trim() ? 'اتحفظ الاسم المستعار' : 'اتشال الاسم المستعار', 'success');
}

async function loadCoverInto(elId, fileId){
  const el = document.getElementById(elId);
  if(!el) return;
  const cached = getCachedFile(fileId);
  if(cached){ el.style.backgroundImage = `url(${cached})`; el.style.backgroundSize='cover'; el.style.backgroundPosition='center'; return; }
  const url = await getTelegramFileBlobUrl(fileId);
  if(url) { el.style.backgroundImage = `url(${url})`; el.style.backgroundSize='cover'; el.style.backgroundPosition='center'; }
}

async function uploadCover(input){
  const file = input.files[0];
  if(!file) return;
  try{
    const up = await uploadToTelegram(file, 'photo', { type:'profile' });
    const { error } = await sb.from('profiles').update({ cover_file_id: up.file_id }).eq('id', currentUser.id);
    if(error) throw error;
    currentProfile.cover_file_id = up.file_id;
    toast('تم تحديث صورة الغلاف', 'success');
    loadCoverInto('profileCover', up.file_id);
  }catch(e){ toast('فشل رفع صورة الغلاف: '+e.message, 'error'); }
}

async function switchProfileTab(tab, userId, isOwn){
  document.querySelectorAll('.profile-tab').forEach(t=>t.classList.toggle('active', t.dataset.ptab===tab));
  const el = document.getElementById('profileTabContent');
  el.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  if(tab==='posts'){
    const { data: posts } = await sb.from('posts').select('*').eq('author_id', userId).eq('is_removed', false).order('created_at', {ascending:false});
    el.innerHTML = (posts&&posts.length) ? posts.map((post, i)=>`
      <div class="post-card" style="animation-delay:${i * 0.04}s"><div class="post-content">${escapeHtml(post.content||'')}</div><div class="meta" style="font-family:var(--font-mono);font-size:12px;color:var(--ink-faint)">${timeAgo(post.created_at)}</div></div>
    `).join('') : `<div class="empty-state">${isOwn?'لسه معملتش أي منشورات':'مفيش منشورات لسه'}</div>`;
  } else if(tab==='portfolio'){
    const { data: items } = await sb.from('portfolio_items').select('*').eq('user_id', userId).order('sort_order');
    el.innerHTML = (isOwn ? `<button class="btn btn-sm" style="margin-bottom:14px" onclick="addPortfolioItem('${userId}')">+ إضافة مشروع</button>` : '') +
      `<div class="portfolio-grid">${(items||[]).map((it, i)=>`
        <div class="portfolio-card" style="animation:fadeInUp 0.4s var(--ease-out) ${i * 0.05}s both">
          <h4>${escapeHtml(it.title)}</h4>
          <p>${escapeHtml(it.description||'')}</p>
          ${it.project_url?`<a href="${escapeHtml(it.project_url)}" target="_blank">عرض المشروع <i class="fa-solid fa-arrow-up-right-from-square"></i></a>`:''}
          ${isOwn?`<div style="margin-top:8px"><span style="font-size:11px;color:var(--red);cursor:pointer" onclick="deletePortfolioItem('${it.id}','${userId}')">حذف</span></div>`:''}
        </div>`).join('') || '<div class="empty-state">لسه مفيش مشاريع مضافة</div>'}</div>`;
  } else if(tab==='gallery'){
    const { data: items } = await sb.from('gallery_items').select('*').eq('user_id', userId).order('created_at',{ascending:false});
    el.innerHTML = (isOwn ? `<button class="btn btn-sm" style="margin-bottom:14px" onclick="document.getElementById('galleryUploadInput').click()">+ رفع صورة</button><input type="file" id="galleryUploadInput" accept="image/*" style="display:none" onchange="addGalleryItem(this,'${userId}')">` : '') +
      `<div class="gallery-grid" id="galleryGrid">${(items&&items.length) ? items.map(it=>`<div id="gal-${it.id}"></div>`).join('') : '<div class="empty-state">لسه مفيش صور</div>'}</div>`;
    (items||[]).forEach(it=>loadGalleryThumb(it.id, it.image_file_id, isOwn));
  } else if(tab==='media'){
    const [{data:postMedia}, {data:galleryMedia}] = await Promise.all([
      sb.from('posts').select('id, post_type, telegram_file_id, created_at').eq('author_id', userId).eq('is_removed', false).in('post_type', ['image','video']).not('telegram_file_id','is',null).order('created_at',{ascending:false}),
      sb.from('gallery_items').select('id, image_file_id, created_at').eq('user_id', userId).order('created_at',{ascending:false}),
    ]);
    const combined = [
      ...(postMedia||[]).map(p=>({ key:'post-'+p.id, fileId:p.telegram_file_id, type:p.post_type, time:p.created_at, source:'post', refId:p.id })),
      ...(galleryMedia||[]).map(g=>({ key:'gal-'+g.id, fileId:g.image_file_id, type:'image', time:g.created_at, source:'gallery', refId:g.id })),
    ].sort((a,b)=> new Date(b.time)-new Date(a.time));
    el.innerHTML = combined.length
      ? `<div class="gallery-grid" id="mediaGrid">${combined.map(it=>`<div id="med-${it.key}"></div>`).join('')}</div>`
      : `<div class="empty-state">لسه مفيش وسائط</div>`;
    combined.forEach(it=>loadProfileMediaThumb(it));
  } else if(tab==='activity'){
    const [{data:posts},{data:articles}] = await Promise.all([
      sb.from('posts').select('id, content, created_at').eq('author_id', userId).eq('is_removed', false).order('created_at',{ascending:false}).limit(15),
      sb.from('articles').select('id, title, created_at').eq('author_id', userId).eq('is_draft', false).order('created_at',{ascending:false}).limit(15),
    ]);
    const events = [
      ...(posts||[]).map(p=>({type:'post', time:p.created_at, text:'نشر: '+(p.content||'').slice(0,60)})),
      ...(articles||[]).map(a=>({type:'article', time:a.created_at, text:'كتب مقال: '+a.title})),
    ].sort((a,b)=>new Date(b.time)-new Date(a.time));
    el.innerHTML = events.length ? events.map((e, i)=>`
      <div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;animation:fadeIn 0.3s var(--ease) ${i * 0.04}s both">
        <span>${e.type==='post'?'<i class="fa-solid fa-pen-to-square"></i>':'<i class="fa-solid fa-newspaper"></i>'}</span><div style="flex:1">${escapeHtml(e.text)}</div><span style="color:var(--ink-faint);font-size:11px;font-family:var(--font-mono)">${timeAgo(e.time)}</span>
      </div>`).join('') : `<div class="empty-state">لسه مفيش نشاط</div>`;
  }
}

async function addPortfolioItem(userId){
  const title = await customPrompt('اسم المشروع:');
  if(!title) return;
  const description = await customPrompt('وصف قصير:') || '';
  const project_url = await customPrompt('رابط المشروع (اختياري):') || null;
  const { error } = await sb.from('portfolio_items').insert({ user_id: currentUser.id, title, description, project_url });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم إضافة المشروع', 'success');
  switchProfileTab('portfolio', userId, true);
}

async function deletePortfolioItem(itemId, userId){
  if(!await customConfirm('تحذف المشروع ده؟', true)) return;
  await sb.from('portfolio_items').delete().eq('id', itemId);
  switchProfileTab('portfolio', userId, true);
}

async function addGalleryItem(input, userId){
  const file = input.files[0];
  if(!file) return;
  try{
    const up = await uploadToTelegram(file, 'photo', { type:'profile' });
    const { error } = await sb.from('gallery_items').insert({ user_id: currentUser.id, image_file_id: up.file_id, telegram_message_id: up.telegram_message_id || null });
    if(error) throw error;
    toast('تمت الإضافة', 'success');
    switchProfileTab('gallery', userId, true);
  }catch(e){ toast('فشل الرفع: '+e.message, 'error'); }
}

async function loadGalleryThumb(itemId, fileId, isOwn){
  const url = getCachedFile(fileId) || await getTelegramFileBlobUrl(fileId);
  if(url && !getCachedFile(fileId)){ /* post/gallery images aren't persisted to cache to save quota, only fetched */ }
  const holder = document.getElementById(`gal-${itemId}`);
  if(!holder || !url) return;
  holder.innerHTML = `<img class="gallery-thumb" src="${url}">${isOwn?`<div style="text-align:center;font-size:11px;color:var(--red);cursor:pointer;margin-top:2px" onclick="deleteGalleryItem('${itemId}')">حذف</div>`:''}`;
}

async function deleteGalleryItem(itemId){
  if(!await customConfirm('تحذف الصورة دي؟', true)) return;
  await sb.from('gallery_items').delete().eq('id', itemId);
  document.getElementById(`gal-${itemId}`)?.parentElement?.removeChild(document.getElementById(`gal-${itemId}`));
}

async function loadProfileMediaThumb(it){
  const holder = document.getElementById(`med-${it.key}`);
  if(!holder) return;
  if(it.type==='video'){
    holder.innerHTML = `<div class="video-play-placeholder gallery-thumb" onclick="openProfileMediaVideo('${it.key}','${escapeHtml(it.fileId)}')"><i class="fa-solid fa-circle-play"></i></div>`;
    return;
  }
  const url = getCachedFile(it.fileId) || await getTelegramFileBlobUrl(it.fileId);
  if(!url) return;
  holder.innerHTML = `<img class="gallery-thumb" src="${url}" onclick="window.open('${url}','_blank')">`;
}

async function openProfileMediaVideo(key, fileId){
  const holder = document.getElementById(`med-${key}`);
  if(!holder) return;
  const streamUrl = await getTelegramStreamUrl(fileId);
  if(!streamUrl){ toast('تعذر تشغيل الفيديو', 'error'); return; }
  holder.innerHTML = `<video src="${streamUrl}" controls autoplay playsinline class="gallery-thumb"></video>`;
}

async function uploadAvatar(input){
  const file = input.files[0];
  if(!file) return;
  try{
    const up = await uploadToTelegram(file, 'photo', { type:'profile' });
    const { error } = await sb.from('profiles').update({ avatar_file_id: up.file_id }).eq('id', currentUser.id);
    if(error) throw error;
    currentProfile.avatar_file_id = up.file_id;
    toast('تم تحديث الصورة الشخصية', 'success');
    loadAvatarInto('profileAvatarLg', up.file_id);
    loadAvatarInto('miniAvatar', up.file_id);
  }catch(e){ toast('فشل رفع الصورة: '+e.message, 'error'); }
}

async function toggleFollow(targetId, currentlyFollowing){
  if(currentlyFollowing){
    await sb.from('user_follows').delete().eq('follower_id', currentUser.id).eq('following_id', targetId);
  }else{
    await sb.from('user_follows').insert({ follower_id: currentUser.id, following_id: targetId });
  }
  renderProfile(document.getElementById('viewContainer'), targetId);
}

