async function editProfile(){
  const bio = await customPrompt('النبذة الشخصية:', currentProfile.bio||'');
  if(bio===null) return;
  const skillsStr = await customPrompt('مهاراتك (افصل بفاصلة):', (currentProfile.skills||[]).join(', ')) || '';
  const skills = skillsStr.split(',').map(s=>s.trim()).filter(Boolean);
  const github_url = await customPrompt('رابط GitHub (اختياري):', currentProfile.github_url||'') || null;
  const linkedin_url = await customPrompt('رابط LinkedIn (اختياري):', currentProfile.linkedin_url||'') || null;
  const portfolio_url = await customPrompt('رابط Portfolio (اختياري):', currentProfile.portfolio_url||'') || null;
  sb.from('profiles').update({ bio, skills, github_url, linkedin_url, portfolio_url }).eq('id', currentUser.id).then(({error})=>{
    if(error){ toast('خطأ: '+error.message, 'error'); return; }
    Object.assign(currentProfile, { bio, skills, github_url, linkedin_url, portfolio_url });
    toast('تم تحديث الملف الشخصي', 'success');
    nav('profile');
  });
}

/* ================= BOOKMARKS ================= */
async function renderBookmarks(container){
  container.innerHTML = `<div class="view">
    <div class="view-header"><h1>المحفوظات</h1></div>
    <div id="bookmarksList"><div class="empty-state"><div class="spinner"></div></div></div>
  </div>`;
  const { data: marks, error } = await sb.from('bookmarks').select('*').eq('user_id', currentUser.id).order('created_at', {ascending:false}).limit(200);
  const listEl = document.getElementById('bookmarksList');
  if(error){ listEl.innerHTML = `<div class="empty-state">تعذر التحميل: ${escapeHtml(error.message)}</div>`; return; }
  if(!marks.length){ listEl.innerHTML = `<div class="empty-state"><div class="icon"><i class="fa-solid fa-bookmark"></i></div>لسه مفيش حاجة محفوظة</div>`; return; }
  const postIds = marks.filter(m=>m.target_type==='post').map(m=>m.target_id);
  const articleIds = marks.filter(m=>m.target_type==='article').map(m=>m.target_id);
  const msgMarks = marks.filter(m=>m.target_type==='message');
  const [{data:posts}, {data:articles}] = await Promise.all([
    postIds.length ? sb.from('posts').select('id, content, created_at, profiles!posts_author_id_fkey(username)').in('id', postIds) : Promise.resolve({data:[]}),
    articleIds.length ? sb.from('articles').select('id, title, created_at, profiles!author_id(username)').in('id', articleIds) : Promise.resolve({data:[]}),
  ]);
  const msgBodyPreview = (mk)=>{
    if(mk.saved_message_type==='voice') return '<i class="fa-solid fa-microphone"></i> رسالة صوتية' + (mk.saved_duration_seconds?` (${formatDuration(mk.saved_duration_seconds)})`:'');
    if(mk.saved_message_type==='image') return '<i class="fa-solid fa-camera"></i> صورة';
    if(mk.saved_message_type==='video') return '<i class="fa-solid fa-clapperboard"></i> فيديو';
    if(mk.saved_message_type==='document') return '<i class="fa-solid fa-paperclip"></i> ' + escapeHtml(mk.saved_content||'ملف');
    return escapeHtml(mk.saved_content||'');
  };
  listEl.innerHTML =
    (posts||[]).map(p=>`<div class="post-card"><div class="meta" style="margin-bottom:6px">منشور من @${p.profiles?.username||''}</div><div class="post-content">${escapeHtml(p.content||'')}</div></div>`).join('') +
    (articles||[]).map(a=>`<div class="article-card"><h3>${escapeHtml(a.title)}</h3><div class="article-meta">@${a.profiles?.username||''}</div></div>`).join('') +
    msgMarks.map(mk=>`<div class="post-card" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="flex:1"><div class="meta" style="margin-bottom:6px"><i class="fa-solid fa-message"></i> رسالة محفوظة</div><div class="post-content">${msgBodyPreview(mk)}</div></div>
        <span style="cursor:pointer;color:var(--red);flex-shrink:0" onclick="unsaveMessageBookmark('${mk.id}')" title="إزالة من المحفوظات"><i class="fa-solid fa-xmark"></i></span>
      </div>`).join('');
}

async function unsaveMessageBookmark(bookmarkId){
  const { error } = await sb.from('bookmarks').delete().eq('id', bookmarkId).eq('user_id', currentUser.id);
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  renderBookmarks(document.getElementById('viewContainer'));
}

/* ================= DIRECT MESSAGES ================= */
async function renderMessagesList(container){
  container.innerHTML = `<div class="view">
    <div class="view-header"><h1>الرسائل الخاصة</h1></div>
    <div id="dmConversationsList"><div class="empty-state"><div class="spinner"></div></div></div>
  </div>`;
  const { data: msgs, error } = await sb.from('chat_messages').select('id, content, message_type, sender_id, receiver_id, created_at').is('room_id', null).or(`sender_id.eq.${currentUser.id},receiver_id.eq.${currentUser.id}`).order('created_at', {ascending:false}).limit(200);
  const listEl = document.getElementById('dmConversationsList');
  if(error){ listEl.innerHTML = `<div class="empty-state" style="color:var(--red)">تعذر التحميل: ${escapeHtml(error.message)}</div>`; toast('خطأ: '+error.message,'error'); return; }
  const others = new Map();
  for(const m of (msgs||[])){
    const otherId = m.sender_id===currentUser.id ? m.receiver_id : m.sender_id;
    if(!others.has(otherId)) others.set(otherId, m);
  }
  if(!others.size){ listEl.innerHTML = `<div class="empty-state"><div class="icon"><i class="fa-solid fa-envelope"></i></div>لسه مفيش محادثات — ابعت رسالة من بروفايل أي حد</div>`; return; }
  const otherIds = [...others.keys()];
  const { data: profs } = await sb.from('profiles').select('id, username, full_name, avatar_file_id').in('id', otherIds);
  const profMap = new Map((profs||[]).map(p=>[p.id,p]));
  const previewFor = (m)=> m.message_type==='voice' ? '<i class="fa-solid fa-microphone"></i> رسالة صوتية' : m.message_type==='image' ? '<i class="fa-solid fa-camera"></i> صورة' : m.message_type==='video' ? '<i class="fa-solid fa-clapperboard"></i> فيديو' : m.message_type==='document' ? '<i class="fa-solid fa-paperclip"></i> ملف' : (m.content||'');
  listEl.innerHTML = otherIds.map(oid=>{
    const p = profMap.get(oid); const lastMsg = others.get(oid);
    return `<div class="room-card" style="cursor:pointer;display:flex;align-items:center;gap:12px" onclick="openDmConversation('${oid}','${escapeHtml(p?.username||'')}')">
      <div class="avatar" id="dmlist-av-${oid}" onclick="event.stopPropagation();viewProfile('${oid}')">${(p?.username||'?')[0].toUpperCase()}</div>
      <div class="room-info"><div class="name">${escapeHtml(p?.full_name||p?.username||'مستخدم')}</div><div class="desc">${escapeHtml(previewFor(lastMsg).slice(0,50))}</div></div>
    </div>`;
  }).join('');
  otherIds.forEach(oid=>{ const p = profMap.get(oid); if(p?.avatar_file_id) loadAvatarInto(`dmlist-av-${oid}`, p.avatar_file_id); });
}

let activeDmUserId = null;
let activeDmUsername = null;
let dmChannel = null;
async function openDmConversation(otherId, otherUsername){
  activeDmUserId = otherId;
  activeDmUsername = otherUsername;
  const c = document.getElementById('viewContainer');
  c.innerHTML = `<div class="chat-view">
    <div style="flex:1;display:flex;flex-direction:column;min-width:0">
      <div class="dm-chat-header">
        <button class="btn btn-sm" onclick="nav('messages')"><i class="fa-solid fa-arrow-right"></i></button>
        <span class="avatar dm-header-avatar" id="dmHeaderAvatar" onclick="viewProfile('${otherId}')">${(otherUsername||'?')[0].toUpperCase()}</span>
        <span style="cursor:pointer;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" onclick="viewProfile('${otherId}')">@${escapeHtml(otherUsername)}</span>
        <div style="position:relative;flex-shrink:0">
          <button class="btn btn-sm" onclick="toggleDmOptionsMenu()"><i class="fa-solid fa-ellipsis-vertical"></i></button>
          <div id="dmOptionsMenu" class="dropdown-menu" style="display:none">
            <div class="dropdown-item" onclick="hideDmOptionsMenu();confirmClearLocalConversation('dm','${otherId}')"><i class="fa-solid fa-broom"></i> مسح المحادثة من جهازي</div>
            <div class="dropdown-item" onclick="hideDmOptionsMenu();confirmBlockDmUser('${otherId}','${escapeHtml(otherUsername).replace(/'/g,"\\'")}')"><i class="fa-solid fa-ban"></i> حظر المستخدم</div>
            <div class="dropdown-item" style="color:var(--red)" onclick="hideDmOptionsMenu();confirmDeleteDmConversation('${otherId}')"><i class="fa-solid fa-trash"></i> حذف المحادثة</div>
          </div>
        </div>
      </div>
      <div id="dmBlockBanner"></div>
      <div id="dmPinnedBanner"></div>
      <div class="chat-messages" id="dmMessages"><div class="empty-state"><div class="spinner"></div></div></div>
      <button class="scroll-to-bottom-btn" id="dmScrollDownBtn" onclick="scrollDmToBottom()"><i class="fa-solid fa-chevron-down"></i><span class="scroll-down-badge" id="dmScrollDownBadge" style="display:none"></span></button>
      <div id="dmTypingIndicator" style="padding:4px 20px;font-size:12px;color:var(--ink-faint);min-height:20px"></div>
      <div id="dmReplyBar" style="display:none;align-items:center;gap:8px;padding:8px 16px;background:var(--surface);border-top:1px solid var(--border);font-size:12px;color:var(--ink-dim)">
        <span id="dmReplyBarText" style="flex:1"></span>
        <button class="icon-btn" style="width:24px;height:24px" onclick="cancelDmReply()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="dmRecordBar" class="record-bar"><span class="record-dot"></span><span id="dmRecordTime">0:00</span> جاري التسجيل...
        <button class="btn btn-sm" onclick="cancelVoiceRecording('dm')">إلغاء</button>
        <button class="btn btn-primary btn-sm" onclick="stopVoiceRecording('dm')">إرسال</button>
      </div>
      <div class="chat-input-bar" id="dmInputBar">
        <label class="file-label"><i class="fa-solid fa-paperclip"></i><input type="file" id="dmFile" style="display:none" onchange="sendDmFile(this)"></label>
        <span class="mic-btn" id="dmMicBtn" onclick="startVoiceRecording('dm')"><i class="fa-solid fa-microphone"></i></span>
        <textarea id="dmInput" rows="1" placeholder="اكتب رسالة... (Shift+Enter لسطر جديد)" oninput="handleMentionInput('dmInput','dm');autoResizeTextarea(this)" onkeydown="handleMentionKeydown(event,'dmInput')"></textarea>
        <button class="btn btn-primary btn-sm" onclick="sendDmMessage()">إرسال</button>
      </div>
    </div>
  </div>`;
  checkDmBlockStatus(otherId);
  const { data: p } = await sb.from('profiles').select('avatar_file_id').eq('id', otherId).single();
  if(p?.avatar_file_id) loadAvatarInto('dmHeaderAvatar', p.avatar_file_id);
  const { data: myLastRead } = await sb.rpc('get_my_dm_last_read', { p_other_user_id: otherId });
  await loadDmMessages(myLastRead || null);
  if(dmChannel){ sb.removeChannel(dmChannel); dmChannel = null; }
  dmChannel = sb.channel('dm-'+[currentUser.id,otherId].sort().join('-'))
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'chat_messages' }, async (payload)=>{
      const m = payload.new;
      if(m.room_id) return;
      const belongsHere = (m.sender_id===currentUser.id && m.receiver_id===activeDmUserId) || (m.sender_id===activeDmUserId && m.receiver_id===currentUser.id);
      if(!belongsHere) return;
      await appendDmMessageIfNew(m.id);
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'chat_messages' }, async (payload)=>{
      const m = payload.new;
      if(m.room_id) return;
      const belongsHere = (m.sender_id===currentUser.id && m.receiver_id===activeDmUserId) || (m.sender_id===activeDmUserId && m.receiver_id===currentUser.id);
      if(!belongsHere) return;
      await patchDmMessage(m.id);
    })
    // تحديث "شوهدت" لحظيًا بدل ما نستعلم كل شوية
    .on('postgres_changes', { event:'*', schema:'public', table:'dm_reads', filter:`user_id=eq.${otherId}` }, (payload)=>{
      if(payload.new?.other_user_id !== currentUser.id) return;
      refreshDmReadReceipts(otherId);
    })
    .on('broadcast', { event:'typing' }, (payload)=>{
      if(payload.payload.user_id !== activeDmUserId) return;
      const el = document.getElementById('dmTypingIndicator');
      if(!el) return;
      el.classList.add('typing-indicator-active');
      el.innerHTML = `بيكتب<span class="typing-dots"><span></span><span></span><span></span></span>`;
      clearTimeout(window._dmTypingTimeout);
      window._dmTypingTimeout = setTimeout(()=>{ el.innerHTML=''; el.classList.remove('typing-indicator-active'); }, 3000);
    }).subscribe();
  bindDragDropUpload('dmMessages', sendDmFile);
}

let lastSeenDmMsgAt = {};

async function appendDmMessageIfNew(msgId){
  const box = document.getElementById('dmMessages');
  if(!box) return;
  if(document.getElementById(`msgav-${msgId}`)) return;
  const wasNearBottom = isScrolledNearBottom(box);
  const { data: full } = await sb.from('chat_messages')
    .select('*, profiles!sender_id(username, avatar_file_id), reply:reply_to_id(id, sender_id, content, profiles!sender_id(username))')
    .eq('id', msgId).single();
  if(!full) return;
  if(document.getElementById(`msgav-${full.id}`)) return;
  if(box.querySelector('.empty-state')) box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', renderOneDmMessage(full));
  if(full.profiles?.avatar_file_id) loadAvatarInto(`msgav-${full.id}`, full.profiles?.avatar_file_id);
  if(full.telegram_file_id) loadMessageMedia(full);
  if(wasNearBottom) box.scrollTop = box.scrollHeight;
  if(activeDmUserId) lastSeenDmMsgAt[activeDmUserId] = full.created_at;
  if(full.sender_id===activeDmUserId) sb.rpc('mark_dm_read', { p_other_user_id: activeDmUserId }).then(()=>checkUnreadBadges());
}

async function patchDmMessage(msgId){
  const { data: full } = await sb.from('chat_messages')
    .select('*, profiles!sender_id(username, avatar_file_id), reply:reply_to_id(id, sender_id, content, profiles!sender_id(username))')
    .eq('id', msgId).single();
  if(!full) return;
  const row = document.getElementById(`msgav-${full.id}`)?.closest('.msg-row');
  if(row) row.outerHTML = renderOneDmMessage(full);
  if(full.profiles?.avatar_file_id) loadAvatarInto(`msgav-${full.id}`, full.profiles?.avatar_file_id);
  if(!full.is_removed && full.telegram_file_id) loadMessageMedia(full);
}

async function refreshDmReadReceipts(otherId){
  const { data: lastRead } = await sb.rpc('get_dm_last_read', { p_other_user_id: otherId });
  if(lastRead === dmOtherLastRead) return;
  dmOtherLastRead = lastRead || null;
  loadDmMessages();
}

function broadcastDmTyping(){
  if(!dmChannel || !activeDmUserId) return;
  dmChannel.send({ type:'broadcast', event:'typing', payload:{ user_id: currentUser.id } });
}

let dmReplyingTo = null;
function setDmReplyTarget(msgId, username, preview){
  dmReplyingTo = msgId;
  const bar = document.getElementById('dmReplyBar');
  if(bar){ bar.style.display='flex'; document.getElementById('dmReplyBarText').textContent = `رد على @${username}: ${preview}`; }
}
function cancelDmReply(){
  dmReplyingTo = null;
  const bar = document.getElementById('dmReplyBar');
  if(bar) bar.style.display='none';
}

let currentDmMessages = [];
let dmHasMoreOlder = true;
let loadingOlderDmMessages = false;

async function loadDmMessages(myLastReadAt){
  const box = document.getElementById('dmMessages');
  if(!box) return;
  currentDmMessages = [];
  dmHasMoreOlder = true;
  // اعرض الكاش المحلي فورًا (لو موجود) عشان الرسايل متختفيش وقت التنقل بين المحادثات
  if(activeDmUserId){
    const conversationId = conversationIdFor('dm', activeDmUserId);
    const cached = await getCachedMessages(conversationId);
    if(cached.length){
      box.innerHTML = cached.map(c=>renderOneDmMessage(fromCachedMessage(c))).join('');
      box.scrollTop = box.scrollHeight;
    }
  }
  if(activeDmUserId){
    const { data: lastRead } = await sb.rpc('get_dm_last_read', { p_other_user_id: activeDmUserId });
    dmOtherLastRead = lastRead || null;
  }
  const { data: msgsDesc, error } = await sb.from('chat_messages')
    .select('*, profiles!sender_id(username, avatar_file_id), reply:reply_to_id(id, sender_id, content, profiles!sender_id(username))')
    .is('room_id', null)
    .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeDmUserId}),and(sender_id.eq.${activeDmUserId},receiver_id.eq.${currentUser.id})`)
    .order('created_at', { ascending:false })
    .limit(150);
  if(error){ if(!box.innerHTML) box.innerHTML = `<div class="empty-state" style="color:var(--red)">تعذر تحميل الرسائل: ${escapeHtml(error.message)}</div>`; toast('خطأ: '+error.message,'error'); return; }
  const convo = (msgsDesc||[]).slice().reverse();
  currentDmMessages = convo;
  if((msgsDesc||[]).length < 150) dmHasMoreOlder = false;
  const firstUnreadId = myLastReadAt ? findFirstUnreadMessageId(convo, myLastReadAt) : null;
  box.innerHTML = convo.length ? convo.map(m=>{
    const divider = (firstUnreadId && m.id===firstUnreadId) ? `<div class="unread-divider">رسائل غير مقروءة</div>` : '';
    return divider + renderOneDmMessage(m);
  }).join('') : `<div class="empty-state" style="padding:20px">ابدأ المحادثة <i class="fa-solid fa-hand"></i></div>`;
  bindMsgLongPress(box);
  if(activeDmUserId) cacheMessages(conversationIdFor('dm', activeDmUserId), convo);
  convo.forEach(m=>{
    if(m.profiles?.avatar_file_id) loadAvatarInto(`msgav-${m.id}`, m.profiles?.avatar_file_id);
    if(!m.is_removed && m.telegram_file_id) loadMessageMedia(m);
    if(!m.is_removed) loadMessageReactions(m.id);
  });
  if(firstUnreadId){
    const dividerEl = box.querySelector('.unread-divider');
    if(dividerEl){ dividerEl.scrollIntoView({ block:'center' }); }
  } else {
    box.scrollTop = box.scrollHeight;
  }
  if(activeDmUserId) sb.rpc('mark_dm_read', { p_other_user_id: activeDmUserId }).then(()=>checkUnreadBadges());
  bindDmInfiniteScroll();
  updateDmScrollDownBtn();
  if(activeDmUserId) lastSeenDmMsgAt[activeDmUserId] = convo.length ? convo[convo.length-1].created_at : new Date(0).toISOString();
}

function bindDmInfiniteScroll(){
  const box = document.getElementById('dmMessages');
  if(!box || box.dataset.infiniteBound) return;
  box.dataset.infiniteBound = '1';
  box.addEventListener('scroll', ()=>{
    if(box.scrollTop < 80) loadOlderDmMessages();
    updateDmScrollDownBtn();
  });
}

function updateDmScrollDownBtn(){
  const box = document.getElementById('dmMessages');
  const btn = document.getElementById('dmScrollDownBtn');
  if(!box || !btn) return;
  const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  const isNearBottom = distanceFromBottom < 150;
  btn.classList.toggle('visible', !isNearBottom);
  if(isNearBottom) document.getElementById('dmScrollDownBadge').style.display = 'none';
}

function scrollDmToBottom(){
  const box = document.getElementById('dmMessages');
  if(!box) return;
  box.scrollTo({ top: box.scrollHeight, behavior:'smooth' });
  document.getElementById('dmScrollDownBadge').style.display = 'none';
}

async function loadOlderDmMessages(){
  if(loadingOlderDmMessages || !dmHasMoreOlder || !currentDmMessages.length || !activeDmUserId) return;
  loadingOlderDmMessages = true;
  const box = document.getElementById('dmMessages');
  const loadingEl = document.createElement('div');
  loadingEl.className = 'older-msgs-loading';
  loadingEl.innerHTML = `<div class="spinner"></div>`;
  box.prepend(loadingEl);

  const oldestCreatedAt = currentDmMessages[0].created_at;
  const { data: olderDesc } = await sb.from('chat_messages')
    .select('*, profiles!sender_id(username, avatar_file_id), reply:reply_to_id(id, sender_id, content, profiles!sender_id(username))')
    .is('room_id', null)
    .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeDmUserId}),and(sender_id.eq.${activeDmUserId},receiver_id.eq.${currentUser.id})`)
    .lt('created_at', oldestCreatedAt)
    .order('created_at', { ascending:false })
    .limit(150);
  loadingEl.remove();

  const older = (olderDesc||[]).slice().reverse();
  if(!older.length){ dmHasMoreOlder = false; loadingOlderDmMessages = false; return; }
  if(older.length < 150) dmHasMoreOlder = false;

  currentDmMessages = [...older, ...currentDmMessages];
  cacheMessages(conversationIdFor('dm', activeDmUserId), older);

  const prevScrollHeight = box.scrollHeight;
  const prevScrollTop = box.scrollTop;
  const fragment = older.map(m=>renderOneDmMessage(m)).join('');
  box.insertAdjacentHTML('afterbegin', fragment);
  older.forEach(m=>{
    if(m.profiles?.avatar_file_id) loadAvatarInto(`msgav-${m.id}`, m.profiles?.avatar_file_id);
    if(!m.is_removed && m.telegram_file_id) loadMessageMedia(m);
    if(!m.is_removed) loadMessageReactions(m.id);
  });
  applyLocalNicknamesToSenders(box);
  box.scrollTop = box.scrollHeight - prevScrollHeight + prevScrollTop;

  loadingOlderDmMessages = false;
}

let dmOtherLastRead = null;

function renderOneDmMessage(m){
  const mine = m.sender_id===currentUser.id;
  const username = m.profiles?.username || (mine ? currentProfile.username : activeDmUsername);
  const initials = (username||'?')[0]?.toUpperCase()||'?';
  const seen = mine && dmOtherLastRead && new Date(m.created_at) <= new Date(dmOtherLastRead);
  const receiptIcon = mine ? `<i class="fa-solid ${seen?'fa-check-double':'fa-check'}" style="font-size:11px;margin-left:4px;color:${seen?(mine?'#fff':'var(--teal)'):(mine?'rgba(255,255,255,.7)':'var(--ink-faint)')}" title="${seen?'اتشافت':'اتبعتت'}"></i>` : '';
  const usernameEsc = escapeHtml((username||'')).replace(/'/g,"\\'");
  const isMedia = !m.is_removed && (m.message_type==='image' || m.message_type==='video');
  return `
    <div class="msg-row ${mine?'mine':''}" data-msg-id="${m.id}">
      <div class="msg-avatar" id="msgav-${m.id}" onclick="viewProfile('${m.sender_id}')">${initials}</div>
      <i class="fa-solid fa-reply msg-reply-hint"></i>
      <div style="display:flex;flex-direction:column;max-width:66%">
        <div class="msg ${mine?'mine':''} ${isMedia?'has-media':''}" id="msgel-${m.id}" style="position:relative;max-width:100%" data-msg-id="${m.id}" data-ctx="dm" data-username="${usernameEsc}">
          ${m.is_removed ? `<i style="color:var(--ink-faint)">تم حذف هذه الرسالة</i>` : `
            ${m.reply ? `<div class="msg-quote-ref" style="border-right-color:${colorForUser(m.reply.sender_id)}" onclick="event.stopPropagation();scrollToMessage('${m.reply.id||''}')"><i class="fa-solid fa-arrow-turn-up msg-quote-arrow" style="color:${colorForUser(m.reply.sender_id)}"></i><span style="color:${colorForUser(m.reply.sender_id)};font-weight:700">@${m.reply.profiles?.username||''}</span>: ${renderMentionText(escapeHtml((m.reply.content||'').slice(0,50)))}</div>` : ''}
            <div class="no-select" style="position:relative">${renderMessageBody(m)}${isMedia?`<span class="msg-media-time-overlay">${formatMsgTime(m.created_at)}${m.edited_at?" · معدّلة":""}${mine?` ${seen?'<i class="fa-solid fa-check-double"></i>':'<i class="fa-solid fa-check"></i>'}`:''}</span>`:''}</div>
            ${!isMedia ? `<div class="msg-timestamp-row" style="font-size:10px;color:${mine?'rgba(255,255,255,.7)':'var(--ink-faint)'};margin-top:3px;text-align:left;display:flex;align-items:center;justify-content:flex-end">${formatMsgTime(m.created_at)}${m.edited_at?" · معدّلة":""}${receiptIcon}</div>` : ''}
          `}
        </div>
        <div class="msg-reaction-row ${mine?'mine':''}" id="msgreact-${m.id}"></div>
      </div>
    </div>`;
}

async function editDmMessage(msgId, currentContent){
  const newContent = await customPrompt('عدّل رسالتك:', currentContent);
  if(newContent===null || !newContent.trim() || newContent===currentContent) return;
  const { error } = await sb.from('chat_messages').update({ content: newContent.trim(), edited_at: new Date().toISOString() }).eq('id', msgId);
  if(error){ toast('تعذر التعديل: '+error.message, 'error'); }
}

async function deleteDmMessage(msgId){
  if(!await customConfirm('تحذف الرسالة دي؟', true)) return;
  const { error } = await sb.from('chat_messages').update({ is_removed: true }).eq('id', msgId);
  if(error){ toast('تعذر الحذف: '+error.message, 'error'); }
}

function toggleDmOptionsMenu(){
  const menu = document.getElementById('dmOptionsMenu');
  if(menu) menu.style.display = menu.style.display==='none' ? 'block' : 'none';
}
function hideDmOptionsMenu(){
  const menu = document.getElementById('dmOptionsMenu');
  if(menu) menu.style.display = 'none';
}
document.addEventListener('click', (e)=>{
  const menu = document.getElementById('dmOptionsMenu');
  if(!menu || menu.style.display==='none') return;
  if(!menu.contains(e.target) && !e.target.closest('button[onclick="toggleDmOptionsMenu()"]')) hideDmOptionsMenu();
});

async function checkDmBlockStatus(otherId){
  const { data, error } = await sb.rpc('get_dm_block_status', { p_other_user_id: otherId });
  const banner = document.getElementById('dmBlockBanner');
  const inputBar = document.getElementById('dmInputBar');
  if(error || !banner || !inputBar) return;
  const status = Array.isArray(data) ? data[0] : data;
  if(status?.i_blocked_them){
    banner.innerHTML = `<div style="padding:8px 20px;background:rgba(232,93,93,.1);color:var(--red);font-size:12px;display:flex;align-items:center;gap:8px">
      <span style="flex:1">انت حاظر المستخدم ده — مش هيوصلك رسايل منه</span>
      <span style="cursor:pointer;text-decoration:underline" onclick="confirmUnblockDmUser('${otherId}')">إلغاء الحظر</span>
    </div>`;
    inputBar.style.display = 'none';
  } else if(status?.they_blocked_me){
    banner.innerHTML = `<div style="padding:8px 20px;background:rgba(232,93,93,.1);color:var(--red);font-size:12px">مينفعش تبعت رسالة للمستخدم ده</div>`;
    inputBar.style.display = 'none';
  } else {
    banner.innerHTML = '';
    inputBar.style.display = 'flex';
  }
}

async function confirmBlockDmUser(otherId, otherUsername){
  if(!await customConfirm(`تحظر @${otherUsername}؟ مش هيقدر يبعتلك رسايل تاني.`, true)) return;
  const wipeAlso = await customConfirm('تمسح المحادثة القديمة معاه كمان؟');
  const { error } = await sb.rpc('block_dm_user', { p_user_id: otherId, p_delete_conversation: !!wipeAlso });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم الحظر', 'success');
  if(wipeAlso) nav('messages');
  else checkDmBlockStatus(otherId);
}

async function confirmUnblockDmUser(otherId){
  if(!await customConfirm('تلغي الحظر عن المستخدم ده؟')) return;
  const { error } = await sb.rpc('unblock_dm_user', { p_user_id: otherId });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم إلغاء الحظر', 'success');
  checkDmBlockStatus(otherId);
}

async function confirmDeleteDmConversation(otherId){
  if(!await customConfirm('هيتم مسح الرسايل اللي بعتها انت في المحادثة دي نهائيًا (رسايل الطرف التاني هتفضل عنده). الإجراء ده مينفعش يترجع.', true)) return;
  const { error } = await sb.rpc('delete_dm_conversation', { p_other_user_id: otherId });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم حذف رسايلك من المحادثة', 'success');
  nav('messages');
}

async function sendDmMessage(){
  const input = document.getElementById('dmInput');
  const content = input.value.trim();
  if(!content || !activeDmUserId) return;
  input.disabled = true;
  const { error } = await sb.from('chat_messages').insert({ sender_id: currentUser.id, receiver_id: activeDmUserId, content, message_type:'text', reply_to_id: dmReplyingTo });
  input.disabled = false;
  if(error){ toast('تعذر الإرسال: '+error.message, 'error'); return; }
  input.value='';
  input.style.height = 'auto';
  input.focus();
  cancelDmReply();
}

async function sendDmFile(input){
  const file = input.files[0];
  if(!file || !activeDmUserId) return;
  try{
    const kind = file.type.startsWith('image')?'photo':file.type.startsWith('video')?'video':'document';
    const up = await uploadToTelegram(file, kind, { type:'dm', otherUserId: activeDmUserId });
    const { error } = await sb.from('chat_messages').insert({
      sender_id: currentUser.id, receiver_id: activeDmUserId, message_type: kind==='photo'?'image':kind,
      telegram_file_id: up.file_id, telegram_message_id: up.telegram_message_id || null, content: file.name
    });
    if(error) throw error;
    input.value = '';
  }catch(e){ toast('فشل رفع الملف: '+e.message, 'error'); }
}

/* ================= ADMIN ================= */
async function renderAdmin(container){
  container.innerHTML = `
    <div class="view" style="max-width:900px">
      <div class="view-header"><h1>لوحة التحكم</h1></div>
      <div class="admin-tabs">
        <div class="admin-tab active" data-tab="overview" onclick="switchAdminTab('overview')">نظرة عامة</div>
        <div class="admin-tab" data-tab="rooms" onclick="switchAdminTab('rooms')">طلبات الغرف</div>
        <div class="admin-tab" data-tab="allrooms" onclick="switchAdminTab('allrooms')">كل الغرف</div>
        <div class="admin-tab" data-tab="reports" onclick="switchAdminTab('reports')">البلاغات</div>
        <div class="admin-tab" data-tab="users" onclick="switchAdminTab('users')">المستخدمين</div>
        <div class="admin-tab" data-tab="meetings" onclick="switchAdminTab('meetings')">الميتنجات</div>
        <div class="admin-tab" data-tab="storage" onclick="switchAdminTab('storage')">التخزين</div>
      </div>
      <div id="adminContent"></div>
    </div>`;
  switchAdminTab('overview');
}

async function switchAdminTab(tab){
  document.querySelectorAll('.admin-tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===tab));
  const el = document.getElementById('adminContent');
  el.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  if(tab==='overview'){
    const [{count:users},{count:posts},{count:articles},{count:rooms},{count:pendingRooms},{count:pendingReports},{count:banned}] = await Promise.all([
      sb.from('profiles').select('id',{count:'exact',head:true}),
      sb.from('posts').select('id',{count:'exact',head:true}).eq('is_removed',false),
      sb.from('articles').select('id',{count:'exact',head:true}).eq('is_draft',false),
      sb.from('chat_rooms').select('id',{count:'exact',head:true}).eq('status','approved'),
      sb.from('chat_rooms').select('id',{count:'exact',head:true}).eq('status','pending'),
      sb.from('reports').select('id',{count:'exact',head:true}).eq('status','pending'),
      sb.from('profiles').select('id',{count:'exact',head:true}).eq('is_banned',true),
    ]);
    const stat = (n,l)=>`<div style="background:linear-gradient(180deg, var(--bg-elevated), var(--surface));border:1px solid var(--border);border-radius:var(--r-md);padding:18px;text-align:center;animation:fadeInUp 0.4s var(--ease-out) both;transition:all 0.2s" onmouseover="this.style.transform='translateY(-3px)';this.style.borderColor='var(--accent)'" onmouseout="this.style.transform='translateY(0)';this.style.borderColor='var(--border)'"><div style="font-family:var(--font-mono);font-size:26px;font-weight:700;background:linear-gradient(135deg, var(--ink), var(--ink-2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent">${n??0}</div><div style="font-size:12px;color:var(--ink-faint);margin-top:6px">${l}</div></div>`;
    el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px">
      ${stat(users,'مستخدم')}${stat(posts,'منشور')}${stat(articles,'مقال منشور')}${stat(rooms,'غرفة مفعّلة')}
      ${stat(pendingRooms,'طلب غرفة معلّق')}${stat(pendingReports,'بلاغ معلّق')}${stat(banned,'مستخدم محظور')}
    </div>`;
  } else if(tab==='rooms'){
    const { data: rooms, error } = await sb.from('chat_rooms').select('id, name, description, creator_id, created_at, profiles!creator_id(username)').eq('status','pending').order('created_at');
    if(error){ el.innerHTML = `<div class="empty-state" style="color:var(--red)">خطأ: ${escapeHtml(error.message)}</div>`; toast('خطأ في تحميل الطلبات: '+error.message, 'error'); return; }
    el.innerHTML = (rooms&&rooms.length) ? rooms.map((r, i)=>`
      <div class="room-card" style="animation-delay:${i * 0.04}s">
        <div class="room-info"><div class="name">${escapeHtml(r.name)} ${r.creator_id ? `<span id="pc-${r.id}"></span>`:''}</div><div class="desc">${escapeHtml(r.description||'')} — طلب بواسطة @${r.profiles?.username}</div></div>
        <button class="btn btn-sm" onclick="viewRoomPasscode('${r.id}')"><i class="fa-solid fa-key"></i> كلمة السر</button>
        <button class="btn btn-sm" style="background:var(--teal);border-color:var(--teal);color:#0B0E14" onclick="reviewRoom('${r.id}','approved')">قبول</button>
        <button class="btn btn-danger btn-sm" onclick="reviewRoom('${r.id}','rejected')">رفض</button>
      </div>`).join('') : `<div class="empty-state">مفيش طلبات جديدة</div>`;
  } else if(tab==='allrooms'){
    const { data: rooms, error } = await sb.rpc('admin_list_all_rooms');
    if(error){ el.innerHTML = `<div class="empty-state" style="color:var(--red)">خطأ: ${escapeHtml(error.message)}</div>`; toast('خطأ: '+error.message, 'error'); return; }
    el.innerHTML = (rooms&&rooms.length) ? rooms.map((r, i)=>`
      <div class="room-card" style="animation-delay:${i * 0.04}s">
        <div class="room-info">
          <div class="name">${escapeHtml(r.name)} <span class="room-number-tag">#${r.room_number}</span>
            <span class="status-pill ${r.status}">${r.status==='pending'?'معلّقة':r.status==='approved'?'مفعّلة':'مرفوضة'}</span>
            ${r.is_disabled?'<span class="status-pill rejected">معطّلة</span>':''}
          </div>
          <div class="desc">${escapeHtml(r.description||'')} — بواسطة @${r.creator_username||'—'} · ${r.member_count} عضو</div>
        </div>
        <button class="btn btn-sm" onclick="adminEnterRoom('${r.id}','${escapeHtml(r.name).replace(/'/g,"\\'")}')">دخول</button>
        <button class="btn btn-sm" onclick="adminEditRoomPrompt('${r.id}','${escapeHtml(r.name).replace(/'/g,"\\'")}','${escapeHtml(r.description||'').replace(/'/g,"\\'")}')"><i class="fa-solid fa-pencil"></i> تعديل</button>
        <button class="btn btn-sm" onclick="adminToggleRoomDisabled('${r.id}', ${!r.is_disabled})">${r.is_disabled?'تفعيل':'تعطيل'}</button>
        <button class="btn btn-danger btn-sm" onclick="adminDeleteRoomConfirm('${r.id}','${escapeHtml(r.name).replace(/'/g,"\\'")}')">حذف نهائي</button>
      </div>`).join('') : `<div class="empty-state">مفيش غرف خالص</div>`;
  } else if(tab==='reports'){
    const { data: reports, error } = await sb.from('reports').select('*, profiles!reports_reporter_id_fkey(username)').eq('status','pending').order('created_at');
    if(error){ el.innerHTML = `<div class="empty-state" style="color:var(--red)">خطأ: ${escapeHtml(error.message)}</div>`; toast('خطأ في تحميل البلاغات: '+error.message, 'error'); return; }
    el.innerHTML = (reports&&reports.length) ? reports.map((r, i)=>`
      <div class="room-card" style="animation-delay:${i * 0.04}s">
        <div class="room-info"><div class="name">بلاغ على ${r.target_type}</div><div class="desc">${escapeHtml(r.reason)} — بواسطة @${r.profiles?.username}</div></div>
        <button class="btn btn-sm" onclick="reviewReport('${r.id}','dismissed')">تجاهل</button>
        <button class="btn btn-danger btn-sm" onclick="removeReportedContent('${r.id}','${r.target_type}','${r.target_id}')">حذف المحتوى</button>
      </div>`).join('') : `<div class="empty-state">مفيش بلاغات جديدة</div>`;
  } else if(tab==='users'){
    const { data: users, error } = await sb.from('profiles').select('*').order('created_at', {ascending:false}).limit(50);
    if(error){ el.innerHTML = `<div class="empty-state" style="color:var(--red)">خطأ: ${escapeHtml(error.message)}</div>`; toast('خطأ في تحميل المستخدمين: '+error.message, 'error'); return; }
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">` + (users||[]).map((u, i)=>`
      <div class="room-card" style="animation-delay:${i * 0.04}s;flex-wrap:wrap">
        <div class="room-info">
          <div class="name">${escapeHtml(u.full_name||u.username)} <span style="color:var(--ink-faint);font-size:12px">@${u.username}</span> ${u.is_banned?'<span class="status-pill rejected">محظور</span>':''}</div>
          <div class="desc">${u.role} · Level ${u.level??0} · XP ${u.xp??0}</div>
        </div>
        ${u.role!=='owner' ? `
          <select class="chip-select" onchange="changeUserRole('${u.id}', this.value)">
            ${['new_member','member','premium','mentor','verified_expert','moderator','admin'].map(r=>`<option value="${r}" ${r===u.role?'selected':''}>${r}</option>`).join('')}
          </select>
          <button class="btn btn-sm" onclick="openGrantXpPrompt('${u.id}','${escapeHtml(u.username).replace(/'/g,"\\'")}')"><i class="fa-solid fa-star"></i> منح XP</button>
          <button class="btn btn-sm" onclick="toggleBanUser('${u.id}', ${u.is_banned})">${u.is_banned?'فك الحظر':'حظر'}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteUserAccount('${u.id}', '${escapeHtml(u.username)}')">حذف نهائي</button>
        ` : `
          <button class="btn btn-sm" onclick="openGrantXpPrompt('${u.id}','${escapeHtml(u.username).replace(/'/g,"\\'")}')"><i class="fa-solid fa-star"></i> منح XP</button>
          <span style="color:var(--ink-faint);font-size:12px">حساب المالك — محمي</span>`}
      </div>`).join('') + `</div>`;
  } else if(tab==='meetings'){
    const { data: meetings, error } = await sb.from('meetings').select('id, title, host_id, status, created_at, profiles!host_id(username)').eq('status','active').order('created_at',{ascending:false});
    if(error){ el.innerHTML = `<div class="empty-state" style="color:var(--red)">خطأ: ${escapeHtml(error.message)}</div>`; return; }
    if(!meetings || !meetings.length){ el.innerHTML = `<div class="empty-state">مفيش ميتنجات شغالة دلوقتي</div>`; return; }
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">` + meetings.map((m,i)=>`
      <div class="room-card" style="animation-delay:${i * 0.04}s">
        <div class="room-info">
          <div class="name">${escapeHtml(m.title||'ميتنج بدون عنوان')}</div>
          <div class="desc">بواسطة @${escapeHtml(m.profiles?.username||'')} · ${formatMsgTime(m.created_at)}</div>
        </div>
        <button class="btn btn-sm" onclick="adminJoinAnyMeeting('${m.id}')"><i class="fa-solid fa-right-to-bracket"></i> دخول</button>
      </div>`).join('') + `</div>`;
  } else if(tab==='storage'){
    const [{count:pending}, {count:cleaned}, {count:failed}] = await Promise.all([
      sb.from('file_cleanup_queue').select('*',{count:'exact',head:true}).is('cleaned_at', null),
      sb.from('file_cleanup_queue').select('*',{count:'exact',head:true}).not('cleaned_at','is', null),
      sb.from('file_cleanup_queue').select('*',{count:'exact',head:true}).is('cleaned_at', null).not('cleanup_error','is', null),
    ]);
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
        <div class="room-card" style="flex-direction:column;align-items:flex-start;gap:4px">
          <div style="font-size:22px;font-weight:800">${pending||0}</div>
          <div style="font-size:12px;color:var(--ink-faint)">مستني التنظيف (لسه في فترة السماح)</div>
        </div>
        <div class="room-card" style="flex-direction:column;align-items:flex-start;gap:4px">
          <div style="font-size:22px;font-weight:800;color:var(--teal)">${cleaned||0}</div>
          <div style="font-size:12px;color:var(--ink-faint)">اتنظف بنجاح</div>
        </div>
        <div class="room-card" style="flex-direction:column;align-items:flex-start;gap:4px">
          <div style="font-size:22px;font-weight:800;color:var(--red)">${failed||0}</div>
          <div style="font-size:12px;color:var(--ink-faint)">فشل التنظيف</div>
        </div>
      </div>
      <div style="color:var(--ink-faint);font-size:12.5px;margin-bottom:12px">
        الملفات بتتحذف تلقائيًا من التخزين السحابي بعد 7 أيام من حذف المحتوى بتاعها (فترة سماح للتراجع). في job مجدول يشتغل كل يوم لوحده، بس تقدر كمان تشغّله يدويًا دلوقتي.
      </div>
      <button class="btn btn-primary btn-sm" onclick="runManualCleanup()"><i class="fa-solid fa-broom"></i> شغّل التنظيف دلوقتي</button>
      <div id="manualCleanupResult" style="margin-top:12px;font-size:12.5px;color:var(--ink-faint)"></div>`;
  }
}

async function runManualCleanup(){
  const resultEl = document.getElementById('manualCleanupResult');
  resultEl.innerHTML = `<div class="spinner"></div>`;
  try{
    const { data:{ session } } = await sb.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/cleanup-storage`, {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    const data = await res.json();
    if(!res.ok){ resultEl.innerHTML = `<span style="color:var(--red)">خطأ: ${escapeHtml(data.error||'فشل غير معروف')}</span>`; return; }
    resultEl.innerHTML = `<span style="color:var(--teal)">اتنظف ${data.cleaned||0} ملف${data.failed?` (فشل ${data.failed})`:''}</span>`;
    switchAdminTab('storage');
  }catch(e){
    resultEl.innerHTML = `<span style="color:var(--red)">خطأ: ${escapeHtml(e.message)}</span>`;
  }
}

async function openGrantXpPrompt(userId, username){
  const amountStr = await customPrompt(`قد ايه XP عايز تدي أو تخصم لـ @${username}؟ (رقم سالب للخصم، مثال: -20)`, '10');
  if(amountStr===null) return;
  const amount = parseInt(amountStr, 10);
  if(!amount || isNaN(amount)){ toast('اكتب رقم صحيح مش صفر', 'error'); return; }
  const reason = await customPrompt('سبب المنح (اختياري):', '') || 'منحة من الإدارة';
  const { error } = await sb.rpc('grant_xp', { p_user_id: userId, p_amount: amount, p_reason: reason });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast(amount>0 ? `اتمنح ${amount} XP لـ @${username}` : `اتخصم ${Math.abs(amount)} XP من @${username}`, 'success');
  switchAdminTab('users');
}

async function viewRoomPasscode(roomId){
  const { data, error } = await sb.rpc('get_room_passcode', { p_room_id: roomId });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  alert(data ? `كلمة سر الغرفة: ${data}` : 'الغرفة دي بدون كلمة سر');
}

async function adminEnterRoom(roomId, roomName){
  const { error } = await sb.rpc('admin_join_any_room', { p_room_id: roomId });
  if(error){ toast('تعذر الدخول: '+error.message, 'error'); return; }
  openRoomChat(roomId, roomName);
}

async function adminEditRoomPrompt(roomId, currentName, currentDesc){
  const newName = await customPrompt('اسم الغرفة:', currentName);
  if(newName === null || !newName.trim()) return;
  const newDesc = await customPrompt('وصف الغرفة:', currentDesc);
  if(newDesc === null) return;
  const { error } = await sb.rpc('admin_edit_room', { p_room_id: roomId, p_name: newName.trim(), p_description: newDesc.trim() });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم تعديل الغرفة', 'success');
  switchAdminTab('allrooms');
}

