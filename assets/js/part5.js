async function adminToggleRoomDisabled(roomId, disable){
  if(disable && !await customConfirm('تعطّل الغرفة دي؟ الأعضاء مش هيقدروا يبعتوا رسايل فيها لحد ما تفعّلها تاني')) return;
  const { error } = await sb.rpc('admin_set_room_disabled', { p_room_id: roomId, p_disabled: disable });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast(disable ? 'تم تعطيل الغرفة' : 'تم تفعيل الغرفة', 'success');
  switchAdminTab('allrooms');
}

async function adminDeleteRoomConfirm(roomId, roomName){
  if(!await customConfirm(`متأكد إنك عايز تمسح غرفة "${roomName}" نهائيًا؟ هيتمسح كل رسايلها وأعضاءها. الإجراء ده مينفعش يترجع.`, true)) return;
  const { error } = await sb.rpc('admin_delete_room', { p_room_id: roomId });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم حذف الغرفة', 'success');
  switchAdminTab('allrooms');
}

async function toggleBanUser(userId, currentlyBanned){
  const { error } = await sb.rpc('admin_set_ban', { p_user_id: userId, p_banned: !currentlyBanned });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast(currentlyBanned ? 'تم فك الحظر' : 'تم حظر المستخدم', 'success');
  switchAdminTab('users');
}

async function deleteUserAccount(userId, username){
  if(!await customConfirm(`متأكد إنك عايز تمسح حساب @${username} نهائيًا؟ الإجراء ده مينفعش يترجع.`, true)) return;
  try{
    const { data:{ session } } = await sb.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-user-actions`, {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${session.access_token}`, 'apikey':SUPABASE_ANON_KEY, 'Content-Type':'application/json' },
      body: JSON.stringify({ action:'delete', target_user_id: userId })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'فشل الحذف');
    toast('تم حذف الحساب نهائيًا', 'success');
    switchAdminTab('users');
  }catch(e){ toast('خطأ: '+e.message, 'error'); }
}

async function reviewRoom(roomId, status){
  const { error } = await sb.from('chat_rooms').update({ status, reviewed_by: currentUser.id, reviewed_at: new Date().toISOString() }).eq('id', roomId);
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  if(status==='approved'){
    sb.from('chat_rooms').select('creator_id').eq('id', roomId).single().then(({data})=>{
      if(data?.creator_id) sb.rpc('grant_xp', { p_user_id: data.creator_id, p_amount: XP_RULES.room_approved, p_reason: 'قبول غرفة' }).catch(()=>{});
    });
  }
  toast(status==='approved'?'تم قبول الغرفة':'تم رفض الغرفة', 'success');
  switchAdminTab('rooms');
  checkAdminBadge();
}

async function reviewReport(reportId, status){
  const { error } = await sb.from('reports').update({ status, reviewed_by: currentUser.id, reviewed_at: new Date().toISOString() }).eq('id', reportId);
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم تحديث البلاغ', 'success');
  switchAdminTab('reports');
}

async function removeReportedContent(reportId, targetType, targetId){
  if(!await customConfirm('هتحذف المحتوى المُبلّغ عنه ده نهائيًا من الموقع؟', true)) return;
  const { error: rpcError } = await sb.rpc('admin_remove_reported_content', { p_target_type: targetType, p_target_id: targetId });
  if(rpcError){ toast('خطأ: '+rpcError.message, 'error'); return; }
  await sb.from('reports').update({ status:'actioned', reviewed_by: currentUser.id, reviewed_at: new Date().toISOString() }).eq('id', reportId);
  toast('تم حذف المحتوى', 'success');
  switchAdminTab('reports');
}

async function changeUserRole(userId, role){
  const { error } = await sb.from('profiles').update({ role }).eq('id', userId);
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم تحديث الصلاحية', 'success');
}

/* ================= NOTIFICATIONS ================= */
let notificationsChannel = null;

/*
  كانت checkNotifications() بتتنادى مرة واحدة بس وقت تسجيل الدخول، فمفيش أي تحديث
  لحظي للنقطة الحمراء أو قايمة الإشعارات لو حصل إشعار جديد بعد كده (لايك، رد، منشن، إلخ).
  دلوقتي بنستخدم Realtime عشان أي إشعار جديد يظهر فورًا من غير ما المستخدم يعمل refresh.
*/
function subscribeToNotifications(){
  if(!currentUser) return;
  if(notificationsChannel) sb.removeChannel(notificationsChannel);
  notificationsChannel = sb.channel('notifications-'+currentUser.id)
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'notifications', filter:`user_id=eq.${currentUser.id}` }, ()=>{
      checkNotifications();
      // لو البانل مفتوح فعلاً، نحدّث القايمة كمان
      const panel = document.getElementById('notifPanel');
      if(panel && panel.style.display==='block') refreshOpenNotificationsPanel();
    })
    .subscribe();
}

async function refreshOpenNotificationsPanel(){
  const panel = document.getElementById('notifPanel');
  if(!panel) return;
  const { data: notifs } = await sb.from('notifications').select('*').eq('user_id', currentUser.id).order('created_at',{ascending:false}).limit(20);
  lastNotifications = notifs || [];
  panel.innerHTML = lastNotifications.length ? lastNotifications.map((n)=>`
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;${n.is_read?'opacity:.6':''};transition:background 0.15s" onmouseover="this.style.background='var(--surface-hover)'" onmouseout="this.style.background='transparent'" onclick="handleNotificationClick('${n.id}')">
      <div style="font-size:13px">${escapeHtml(n.content)}</div>
      <div style="font-size:11px;color:var(--ink-faint);font-family:var(--font-mono);margin-top:3px">${timeAgo(n.created_at)}</div>
    </div>`).join('') : `<div style="padding:16px;color:var(--ink-faint);font-size:13px;text-align:center">مفيش إشعارات</div>`;
}

async function checkNotifications(){
  const { count } = await sb.from('notifications').select('*', {count:'exact', head:true}).eq('user_id', currentUser.id).eq('is_read', false);
  document.getElementById('notifDot').style.display = count > 0 ? 'block' : 'none';
}

let lastNotifications = [];
async function toggleNotifications(){
  const panel = document.getElementById('notifPanel');
  if(panel.style.display==='block'){ panel.style.display='none'; return; }
  const { data: notifs } = await sb.from('notifications').select('*').eq('user_id', currentUser.id).order('created_at',{ascending:false}).limit(20);
  lastNotifications = notifs || [];
  if(!lastNotifications.length){
    panel.innerHTML = `<div style="padding:16px;color:var(--ink-faint);font-size:13px;text-align:center">مفيش إشعارات</div>`;
  }else{
    panel.innerHTML = lastNotifications.map((n, i)=>`
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;${n.is_read?'opacity:.6':''};transition:background 0.15s" onmouseover="this.style.background='var(--surface-hover)'" onmouseout="this.style.background='transparent'" onclick="handleNotificationClick('${n.id}')">
        <div style="font-size:13px">${escapeHtml(n.content)}</div>
        <div style="font-size:11px;color:var(--ink-faint);font-family:var(--font-mono);margin-top:3px">${timeAgo(n.created_at)}</div>
      </div>`).join('');
  }
  panel.style.display='block';
  await sb.from('notifications').update({ is_read:true }).eq('user_id', currentUser.id);
  checkNotifications();
  if(['owner','super_admin','admin','moderator'].includes(currentProfile.role)) checkAdminBadge();
}

function handleNotificationClick(id){
  const n = lastNotifications.find(x=>x.id===id);
  document.getElementById('notifPanel').style.display='none';
  if(!n) return;
  if(n.type==='system' && n.content.includes('طلب غرفة')){
    nav('ctrl-x9k2');
    setTimeout(()=>switchAdminTab('rooms'), 50);
  }else if(n.type==='room_approved' || n.type==='room_rejected'){
    nav('rooms');
  }
}

/* ================= SEARCH ================= */
let searchTimeout;
function handleSearch(q){
  clearTimeout(searchTimeout);
  const box = document.getElementById('searchResults');
  if(!q.trim()){ box.style.display='none'; return; }
  searchTimeout = setTimeout(async ()=>{
    const [{data:users}, {data:posts}, {data:articles}] = await Promise.all([
      sb.from('profiles').select('id, username, full_name, avatar_file_id').or(`username.ilike.%${q}%,full_name.ilike.%${q}%`).limit(5),
      sb.from('posts').select('id, content').textSearch('search_vector', q, {config:'arabic', type:'plain'}).eq('is_removed', false).limit(5),
      sb.from('articles').select('id, title').textSearch('search_vector', q, {config:'arabic', type:'plain'}).eq('is_draft', false).limit(5),
    ]);
    const noResults = !(users?.length || posts?.length || articles?.length);
    if(noResults){
      box.innerHTML = `<div style="padding:16px;color:var(--ink-faint);font-size:13px;text-align:center">مفيش نتائج لـ "${escapeHtml(q)}"</div>`;
      box.style.display='block'; return;
    }
    let html = '';
    if(users?.length){
      html += `<div style="padding:8px 14px;font-size:11px;color:var(--ink-faint);font-family:var(--font-mono)">مستخدمين</div>`;
      html += users.map(u=>`
        <div style="display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='var(--surface-hover)'" onmouseout="this.style.background='transparent'" onmousedown="viewProfile('${u.id}')">
          <div class="avatar" style="width:30px;height:30px;font-size:12px">${(u.username||'?')[0].toUpperCase()}</div>
          <div><div style="font-size:13px;font-weight:600">${escapeHtml(u.full_name||u.username)}</div><div style="font-size:11px;color:var(--ink-faint)">@${escapeHtml(u.username)}</div></div>
        </div>`).join('');
    }
    if(posts?.length){
      html += `<div style="padding:8px 14px;font-size:11px;color:var(--ink-faint);font-family:var(--font-mono);border-top:1px solid var(--border)">منشورات</div>`;
      html += posts.map(p=>`<div style="padding:8px 14px;font-size:13px;color:var(--ink-dim)">${escapeHtml((p.content||'').slice(0,70))}</div>`).join('');
    }
    if(articles?.length){
      html += `<div style="padding:8px 14px;font-size:11px;color:var(--ink-faint);font-family:var(--font-mono);border-top:1px solid var(--border)">مقالات</div>`;
      html += articles.map(a=>`<div style="padding:8px 14px;font-size:13px;color:var(--ink-dim);cursor:pointer" onmouseover="this.style.background='var(--surface-hover)'" onmouseout="this.style.background='transparent'" onmousedown="nav('articles')">${escapeHtml(a.title)}</div>`).join('');
    }
    box.innerHTML = html;
    box.style.display='block';
  }, 400);
}

/* ================= AI ASSISTANT PICKER (PixelAi / PixelCode — Binary Beast) ================= */
// المحادثة الفعلية بقت في pixelai.html و pixelcode.html، كل واحدة بتفتح في تبويب منفصل
// ومربوطة مباشرة بـ ai-assistant edge function. هنا بس بنعرض قائمة الاختيار.
function toggleAiPicker(){ document.getElementById('aiPickerOverlay').classList.toggle('active'); }
function closeAiPicker(){ document.getElementById('aiPickerOverlay').classList.remove('active'); }

/* ================= MESSAGE ACTIONS (long-press bar + swipe reply + forward + save) ================= */
let mabCurrentMsgEl = null;
let mabBackdropEl = null;
let mabBarEl = null;

const QUICK_REACTIONS = ['👍','❤️','😂','😮','😢'];
let mabReactionBarEl = null;

function ensureMabDom(){
  if(!mabBackdropEl){
    mabBackdropEl = document.createElement('div');
    mabBackdropEl.className = 'msg-action-backdrop';
    mabBackdropEl.onclick = closeMsgActionBar;
    document.body.appendChild(mabBackdropEl);
  }
  if(!mabBarEl){
    mabBarEl = document.createElement('div');
    mabBarEl.className = 'msg-action-bar';
    document.body.appendChild(mabBarEl);
  }
  if(!mabReactionBarEl){
    mabReactionBarEl = document.createElement('div');
    mabReactionBarEl.className = 'msg-reaction-bar';
    document.body.appendChild(mabReactionBarEl);
  }
}

function getMsgDataById(msgId){
  // Pull whatever we can from the DOM node's dataset + rendered content, since we don't keep a full in-memory store.
  const el = document.getElementById(`msgel-${msgId}`);
  if(!el) return null;
  return el;
}

async function openMsgActionBar(msgId){
  const el = document.getElementById(`msgel-${msgId}`);
  if(!el) return;
  ensureMabDom();
  const ctx = el.dataset.ctx; // 'room' | 'dm'
  const username = el.dataset.username || '';
  const row = el.closest('.msg-row');
  const mine = row?.classList.contains('mine');

  // fetch the full message row for accurate state (is_removed, is_pinned, message_type, content)
  const { data: m } = await sb.from('chat_messages').select('*').eq('id', msgId).single();
  if(!m || m.is_removed) return;

  const isTextMsg = m.message_type === 'text' || !m.message_type;
  const canEdit = mine && isTextMsg;
  const canDel = ctx==='dm' ? mine : canDeleteMessage(m);
  const canPin = ctx==='room' && canModerateRoom();

  const btns = [];
  btns.push(`<span class="mab-btn" title="رد" onclick="mabReply('${msgId}','${ctx}')"><i class="fa-solid fa-reply"></i></span>`);
  if(isTextMsg) btns.push(`<span class="mab-btn" title="نسخ" onclick="mabCopy('${msgId}')"><i class="fa-solid fa-copy"></i></span>`);
  btns.push(`<span class="mab-btn" title="حفظ" onclick="mabSave('${msgId}')"><i class="fa-solid fa-bookmark"></i></span>`);
  btns.push(`<span class="mab-btn" title="إعادة توجيه" onclick="mabForward('${msgId}')"><i class="fa-solid fa-share"></i></span>`);
  if(canPin) btns.push(`<span class="mab-btn ${m.is_pinned?'active-state':''}" title="${m.is_pinned?'إلغاء التثبيت':'تثبيت'}" onclick="mabPin('${msgId}',${!m.is_pinned})"><i class="fa-solid fa-thumbtack"></i></span>`);
  if(ctx==='room') btns.push(`<span class="mab-btn" title="معلومات الرسالة" onclick="mabInfo('${msgId}')"><i class="fa-solid fa-circle-info"></i></span>`);
  if(canEdit) btns.push(`<span class="mab-btn" title="تعديل" onclick="mabEdit('${msgId}','${ctx}')"><i class="fa-solid fa-pencil"></i></span>`);
  if(canDel) btns.push(`<span class="mab-btn danger" title="حذف" onclick="mabDelete('${msgId}','${ctx}')"><i class="fa-solid fa-trash"></i></span>`);

  mabBarEl.innerHTML = btns.join('');

  // شريط الإيموجيات السريعة + زرار "+" لفتح لوحة إيموجي كاملة
  const reactionBtns = QUICK_REACTIONS.map(em=>
    `<span class="mrb-emoji" onclick="toggleReaction('${msgId}','${em}')">${em}</span>`
  ).join('');
  mabReactionBarEl.innerHTML = reactionBtns + `<span class="mrb-emoji mrb-more" onclick="openFullEmojiPicker('${msgId}')"><i class="fa-solid fa-plus"></i></span>`;

  mabCurrentMsgEl = el;
  el.classList.add('action-target');
  positionMabBar(el);
  positionMabReactionBar(el);
  mabBackdropEl.classList.add('active');
  mabBarEl.classList.add('active');
  mabReactionBarEl.classList.add('active');
  if(navigator.vibrate) try{ navigator.vibrate(12); }catch(e){}
}

function positionMabBar(el){
  const rect = el.getBoundingClientRect();
  const barW = Math.min(320, btnsWidthEstimate());
  let left = rect.left + rect.width/2 - barW/2;
  left = Math.max(8, Math.min(left, window.innerWidth - barW - 8));
  let top = rect.top - 54;
  if(top < 8) top = rect.bottom + 10;
  mabBarEl.style.left = left + 'px';
  mabBarEl.style.top = top + 'px';
  mabBarEl.dataset.placedBelow = (top === rect.bottom + 10) ? '1' : '0';
}

function positionMabReactionBar(el){
  const rect = el.getBoundingClientRect();
  const reactionW = Math.min(280, mabReactionBarEl.children.length * 40 + 16);
  let left = rect.left + rect.width/2 - reactionW/2;
  left = Math.max(8, Math.min(left, window.innerWidth - reactionW - 8));
  // شريط الإيموجي بيتحط فوق شريط الأدوات (لو شريط الأدوات فوق الرسالة) أو فوق الرسالة مباشرة (لو شريط الأدوات نزل تحت لضيق المساحة)
  const belowMode = mabBarEl.dataset.placedBelow === '1';
  let top = belowMode ? (rect.top - 54) : (rect.top - 54 - 50);
  if(top < 8) top = belowMode ? (rect.bottom + 64) : (rect.top - 54);
  mabReactionBarEl.style.left = left + 'px';
  mabReactionBarEl.style.top = top + 'px';
}
function btnsWidthEstimate(){
  const n = mabBarEl ? mabBarEl.children.length : 6;
  return n * 40 + 10;
}

function closeMsgActionBar(){
  if(mabCurrentMsgEl) mabCurrentMsgEl.classList.remove('action-target');
  mabCurrentMsgEl = null;
  mabBackdropEl?.classList.remove('active');
  mabBarEl?.classList.remove('active');
  mabReactionBarEl?.classList.remove('active');
}

function mabReply(msgId, ctx){
  const el = document.getElementById(`msgel-${msgId}`);
  const username = el?.dataset.username || '';
  const preview = (el?.querySelector('.no-select')?.textContent || 'وسائط').slice(0,60);
  if(ctx==='dm') setDmReplyTarget(msgId, username, preview);
  else setReplyTarget(msgId, username, preview);
  closeMsgActionBar();
}

async function mabCopy(msgId){
  const { data: m } = await sb.from('chat_messages').select('content').eq('id', msgId).single();
  copyText(m?.content || '');
  closeMsgActionBar();
}

async function mabSave(msgId){
  closeMsgActionBar();
  const { data: m } = await sb.from('chat_messages').select('*').eq('id', msgId).single();
  if(!m) return;
  const { data: existing } = await sb.from('bookmarks').select('id').eq('user_id', currentUser.id).eq('target_type','message').eq('target_id', msgId).maybeSingle();
  if(existing){ toast('الرسالة دي محفوظة بالفعل', 'success'); return; }
  const { error } = await sb.from('bookmarks').insert({
    user_id: currentUser.id,
    target_type: 'message',
    target_id: msgId,
    saved_content: m.content || null,
    saved_message_type: m.message_type || 'text',
    saved_telegram_file_id: m.telegram_file_id || null,
    saved_duration_seconds: m.duration_seconds || null,
  });
  if(error){ toast('تعذر الحفظ: '+error.message, 'error'); return; }
  toast('اتحفظت الرسالة', 'success');
}

function mabPin(msgId, pinTo){
  togglePinMessage(msgId, pinTo);
  closeMsgActionBar();
}

function mabInfo(msgId){
  closeMsgActionBar();
  openMessageInfo(msgId);
}

function mabEdit(msgId, ctx){
  closeMsgActionBar();
  sb.from('chat_messages').select('content').eq('id', msgId).single().then(({data:m})=>{
    if(ctx==='dm') editDmMessage(msgId, m?.content||'');
    else editMessage(msgId, m?.content||'');
  });
}

/* ---- Reactions ---- */
async function toggleReaction(msgId, emoji){
  closeMsgActionBar();
  const { data: existing } = await sb.from('message_reactions').select('id').eq('message_id', msgId).eq('user_id', currentUser.id).eq('emoji', emoji).maybeSingle();
  if(existing){
    await sb.from('message_reactions').delete().eq('id', existing.id);
  }else{
    const { error } = await sb.from('message_reactions').insert({ message_id: msgId, user_id: currentUser.id, emoji });
    if(error){ toast('تعذر إضافة التفاعل: '+error.message, 'error'); return; }
  }
  loadMessageReactions(msgId);
}

const EXTENDED_EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','🙏','💯','😍','😅','🤔','😎','👀','✅','💡','🚀','😴','🤝'];

function openFullEmojiPicker(msgId){
  closeMsgActionBar();
  ensureEmojiPickerDom();
  const grid = document.getElementById('emojiPickerGrid');
  grid.innerHTML = EXTENDED_EMOJIS.map(em=>`<span class="epk-emoji" onclick="toggleReaction('${msgId}','${em}');closeEmojiPicker()">${em}</span>`).join('');
  document.getElementById('emojiPickerOverlay').classList.add('active');
}

function ensureEmojiPickerDom(){
  if(document.getElementById('emojiPickerOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'emojiPickerOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:340px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h2 style="margin:0;font-size:15px"><i class="fa-solid fa-face-smile"></i> اختر تفاعل</h2>
        <button class="icon-btn" onclick="closeEmojiPicker()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="emojiPickerGrid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;font-size:26px;text-align:center"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) closeEmojiPicker(); });
}
function closeEmojiPicker(){
  document.getElementById('emojiPickerOverlay')?.classList.remove('active');
}

/* ---- Media Viewer (fullscreen للصور والفيديوهات في الشات) ---- */
function ensureMediaViewerDom(){
  if(document.getElementById('mediaViewerOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'mediaViewerOverlay';
  overlay.className = 'media-viewer-overlay';
  overlay.innerHTML = `
    <button class="media-viewer-close" onclick="closeMediaViewer()"><i class="fa-solid fa-xmark"></i></button>
    <div class="media-viewer-content" id="mediaViewerContent"></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) closeMediaViewer(); });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeMediaViewer(); });
}

function openImageViewer(url){
  ensureMediaViewerDom();
  document.getElementById('mediaViewerContent').innerHTML = `<img src="${url}" alt="">`;
  document.getElementById('mediaViewerOverlay').classList.add('active');
}

function openVideoViewer(url){
  ensureMediaViewerDom();
  document.getElementById('mediaViewerContent').innerHTML = `<video src="${url}" controls autoplay playsinline></video>`;
  document.getElementById('mediaViewerOverlay').classList.add('active');
}

function closeMediaViewer(){
  const overlay = document.getElementById('mediaViewerOverlay');
  if(!overlay) return;
  overlay.classList.remove('active');
  // نوقف تشغيل أي فيديو شغال عشان الصوت ميستمرش بعد القفل
  const video = overlay.querySelector('video');
  if(video){ video.pause(); }
  setTimeout(()=>{ document.getElementById('mediaViewerContent').innerHTML = ''; }, 200);
}

/* ---- Mentions autocomplete ---- */
let mentionActiveIndex = -1;
let mentionCandidates = [];
let mentionQueryStart = -1; // موقع الـ @ في النص

function ensureMentionDropdownDom(){
  if(document.getElementById('mentionDropdown')) return;
  const el = document.createElement('div');
  el.id = 'mentionDropdown';
  el.className = 'mention-dropdown';
  document.body.appendChild(el);
}

async function getMentionCandidates(ctx){
  if(ctx==='dm'){
    return activeDmUserId ? [{ id: activeDmUserId, username: activeDmUsername }] : [];
  }
  if(!activeRoomId) return [];
  const { data } = await sb.from('chat_room_members').select('user_id, profiles(id, username)').eq('room_id', activeRoomId).limit(100);
  return (data||[]).map(r=>r.profiles).filter(p=>p && p.id !== currentUser.id);
}

async function handleMentionInput(inputId, ctx){
  const input = document.getElementById(inputId);
  const caret = input.selectionStart;
  const textBeforeCaret = input.value.slice(0, caret);
  const match = textBeforeCaret.match(/(?:^|\s)@([A-Za-z0-9_\u0600-\u06FF]*)$/);
  if(!match){
    closeMentionDropdown();
    return;
  }
  const query = match[1].toLowerCase();
  mentionQueryStart = caret - query.length - 1; // موقع الـ @ نفسها

  const all = await getMentionCandidates(ctx);
  mentionCandidates = all.filter(p=>p.username.toLowerCase().startsWith(query)).slice(0, 6);
  if(!mentionCandidates.length){
    closeMentionDropdown();
    return;
  }
  mentionActiveIndex = 0;
  renderMentionDropdown(inputId);
}

function renderMentionDropdown(inputId){
  ensureMentionDropdownDom();
  const dropdown = document.getElementById('mentionDropdown');
  const input = document.getElementById(inputId);
  dropdown.innerHTML = mentionCandidates.map((c,i)=>
    `<div class="mention-option ${i===mentionActiveIndex?'active':''}" onclick="applyMention('${inputId}', ${i})">@${escapeHtml(c.username)}</div>`
  ).join('');
  const rect = input.getBoundingClientRect();
  dropdown.style.left = rect.left + 'px';
  dropdown.style.width = Math.min(240, rect.width) + 'px';
  dropdown.style.top = (rect.top - Math.min(mentionCandidates.length, 6) * 38 - 8) + 'px';
  dropdown.classList.add('active');
}

function closeMentionDropdown(){
  mentionCandidates = [];
  mentionActiveIndex = -1;
  mentionQueryStart = -1;
  document.getElementById('mentionDropdown')?.classList.remove('active');
}

function applyMention(inputId, index){
  const input = document.getElementById(inputId);
  const candidate = mentionCandidates[index];
  if(!candidate || mentionQueryStart < 0) return;
  const caret = input.selectionStart;
  const before = input.value.slice(0, mentionQueryStart);
  const after = input.value.slice(caret);
  const newValue = `${before}@${candidate.username} ${after}`;
  input.value = newValue;
  const newCaret = (before + '@' + candidate.username + ' ').length;
  input.focus();
  input.setSelectionRange(newCaret, newCaret);
  closeMentionDropdown();
}

function autoResizeTextarea(el){
  el.style.height = 'auto';
  const maxHeight = 120; // أقصى ارتفاع تقريبًا 5 أسطر، بعدها بيبقى فيه سكرول داخلي
  el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
}

function handleMentionKeydown(event, inputId){
  const dropdownActive = document.getElementById('mentionDropdown')?.classList.contains('active');
  if(dropdownActive && mentionCandidates.length){
    if(event.key==='ArrowDown'){ event.preventDefault(); mentionActiveIndex = (mentionActiveIndex+1) % mentionCandidates.length; renderMentionDropdown(inputId); return; }
    if(event.key==='ArrowUp'){ event.preventDefault(); mentionActiveIndex = (mentionActiveIndex-1+mentionCandidates.length) % mentionCandidates.length; renderMentionDropdown(inputId); return; }
    if(event.key==='Enter' || event.key==='Tab'){ event.preventDefault(); applyMention(inputId, mentionActiveIndex); return; }
    if(event.key==='Escape'){ closeMentionDropdown(); return; }
  }
  if(event.key==='Enter' && !event.shiftKey){
    event.preventDefault();
    if(inputId==='chatInput') sendChatMessage();
    else if(inputId==='dmInput') sendDmMessage();
  }
}

async function loadMessageReactions(msgId){
  const holder = document.getElementById(`msgreact-${msgId}`);
  if(!holder) return;
  const { data: reactions } = await sb.from('message_reactions').select('emoji, user_id, profiles(username)').eq('message_id', msgId);
  if(!reactions || !reactions.length){ holder.innerHTML = ''; return; }
  const grouped = {};
  reactions.forEach(r=>{
    if(!grouped[r.emoji]) grouped[r.emoji] = [];
    grouped[r.emoji].push({ id: r.user_id, username: r.profiles?.username || 'مستخدم' });
  });
  holder.innerHTML = Object.entries(grouped).map(([emoji, users])=>{
    const mine = users.some(u=>u.id===currentUser.id);
    const usersData = escapeHtml(JSON.stringify(users)).replace(/'/g, "&#39;");
    return `<span class="msg-reaction-pill ${mine?'mine':''}"
      onclick="toggleReaction('${msgId}','${emoji}')"
      onpointerdown="startReactionLongPress(this, '${emoji}')"
      onpointerup="cancelReactionLongPress()"
      onpointerleave="cancelReactionLongPress()"
      data-users='${usersData}'>${emoji} <span class="cnt">${users.length}</span></span>`;
  }).join('');
}

let reactionLongPressTimer = null;
function startReactionLongPress(el, emoji){
  clearTimeout(reactionLongPressTimer);
  reactionLongPressTimer = setTimeout(()=>{
    showReactionDetails(el, emoji);
  }, 450);
}
function cancelReactionLongPress(){
  clearTimeout(reactionLongPressTimer);
}

function showReactionDetails(el, emoji){
  let users = [];
  try{ users = JSON.parse(el.dataset.users.replace(/&#39;/g, "'")); }catch(e){ return; }
  ensureReactionDetailsDom();
  document.getElementById('reactionDetailsTitle').innerHTML = `${emoji} تفاعل ${users.length} شخص`;
  document.getElementById('reactionDetailsList').innerHTML = users.map(u=>`
    <div class="reaction-detail-row" onclick="closeReactionDetails();viewProfile('${u.id}')">
      <span class="voice-avatar" style="width:32px;height:32px;font-size:13px">${(u.username||'?')[0].toUpperCase()}</span>
      <span>@${escapeHtml(u.username)}</span>
    </div>`).join('');
  document.getElementById('reactionDetailsOverlay').classList.add('active');
  if(navigator.vibrate) try{ navigator.vibrate(15); }catch(e){}
}

function ensureReactionDetailsDom(){
  if(document.getElementById('reactionDetailsOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'reactionDetailsOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:320px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h2 style="margin:0;font-size:15px" id="reactionDetailsTitle"></h2>
        <button class="icon-btn" onclick="closeReactionDetails()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="reactionDetailsList" style="max-height:50vh;overflow-y:auto"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) closeReactionDetails(); });
}
function closeReactionDetails(){
  document.getElementById('reactionDetailsOverlay')?.classList.remove('active');
}

function mabDelete(msgId, ctx){
  closeMsgActionBar();
  if(ctx==='dm') deleteDmMessage(msgId);
  else deleteMessage(msgId);
}

/* ---- Forward ---- */
let forwardMsgId = null;
let forwardTargetsCache = [];
async function mabForward(msgId){
  closeMsgActionBar();
  forwardMsgId = msgId;
  document.getElementById('forwardMsgOverlay')?.classList.add('active');
  document.getElementById('forwardSearchInput').value = '';
  const listEl = document.getElementById('forwardTargetsList');
  listEl.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

  const [{data:memberships}, {data:dmRows}] = await Promise.all([
    sb.from('chat_room_members').select('room_id').eq('user_id', currentUser.id),
    sb.from('chat_messages').select('sender_id, receiver_id').is('room_id', null).or(`sender_id.eq.${currentUser.id},receiver_id.eq.${currentUser.id}`).limit(300),
  ]);
  const roomIds = (memberships||[]).map(m=>m.room_id);
  const { data: rooms } = roomIds.length ? await sb.from('chat_rooms').select('id, name').in('id', roomIds).eq('status','approved') : { data: [] };

  const dmOthers = new Set();
  (dmRows||[]).forEach(r=>{
    const other = r.sender_id===currentUser.id ? r.receiver_id : r.sender_id;
    if(other) dmOthers.add(other);
  });
  const otherIds = [...dmOthers];
  const { data: profs } = otherIds.length ? await sb.from('profiles').select('id, username').in('id', otherIds) : { data: [] };

  forwardTargetsCache = [
    ...(rooms||[]).map(r=>({ type:'room', id:r.id, label: r.name })),
    ...(profs||[]).map(p=>({ type:'dm', id:p.id, label: '@'+p.username })),
  ];
  renderForwardTargets(forwardTargetsCache);
}

function renderForwardTargets(list){
  const listEl = document.getElementById('forwardTargetsList');
  if(!list.length){ listEl.innerHTML = `<div class="empty-state">مفيش غرف أو محادثات لسه</div>`; return; }
  listEl.innerHTML = list.map(t=>`
    <div class="room-card" style="cursor:pointer;display:flex;align-items:center;gap:10px" onclick="doForward('${t.type}','${t.id}')">
      <div class="avatar" style="width:32px;height:32px;font-size:13px">${t.type==='room'?'<i class="fa-solid fa-comment-dots"></i>':escapeHtml(t.label[1]||'?').toUpperCase()}</div>
      <div class="room-info"><div class="name">${escapeHtml(t.label)}</div><div class="desc">${t.type==='room'?'غرفة':'رسالة خاصة'}</div></div>
    </div>`).join('');
}

function filterForwardTargets(q){
  const query = (q||'').trim().toLowerCase();
  if(!query){ renderForwardTargets(forwardTargetsCache); return; }
  renderForwardTargets(forwardTargetsCache.filter(t=>t.label.toLowerCase().includes(query)));
}

async function doForward(type, targetId){
  if(!forwardMsgId) return;
  const { data: m } = await sb.from('chat_messages').select('*').eq('id', forwardMsgId).single();
  if(!m) return;
  const payload = {
    sender_id: currentUser.id,
    content: m.content || null,
    message_type: m.message_type || 'text',
    telegram_file_id: m.telegram_file_id || null,
    duration_seconds: m.duration_seconds || null,
    forwarded_from_id: forwardMsgId,
  };
  if(type==='room') payload.room_id = targetId;
  else payload.receiver_id = targetId;
  const { error } = await sb.from('chat_messages').insert(payload);
  closeForwardModal();
  if(error){ toast('تعذر إعادة التوجيه: '+error.message, 'error'); return; }
  toast('اتبعتت الرسالة', 'success');
}

function closeForwardModal(){
  document.getElementById('forwardMsgOverlay')?.classList.remove('active');
  forwardMsgId = null;
}

/* ---- Long press (unified for room + dm) ---- */
let mabLongPressTimer = null;
let mabLongPressTarget = null;
function bindMsgLongPress(container){
  if(!container || container.dataset.mabBound) return;
  container.dataset.mabBound = '1';
  container.addEventListener('pointerdown', (e)=>{
    const msgEl = e.target.closest('.msg');
    if(!msgEl || msgEl.closest('.msg')?.querySelector) { /* noop guard */ }
    if(!msgEl) return;
    mabLongPressTarget = msgEl;
    clearTimeout(mabLongPressTimer);
    mabLongPressTimer = setTimeout(()=>{
      const msgId = msgEl.dataset.msgId;
      if(msgId) openMsgActionBar(msgId);
    }, 500);
    startSwipeTrack(e, msgEl);
  });
  ['pointerup','pointerleave','pointercancel'].forEach(evt=>{
    container.addEventListener(evt, ()=>{ clearTimeout(mabLongPressTimer); });
  });
}

/* ---- Swipe to reply ---- */
let swipeStartX = null;
let swipeEl = null;
let swipeRow = null;
let swipeArmed = false;
function startSwipeTrack(e, msgEl){
  swipeEl = msgEl;
  swipeRow = msgEl.closest('.msg-row');
  swipeStartX = e.clientX;
  swipeArmed = false;
  const onMove = (ev)=>{
    if(!swipeEl || swipeStartX===null) return;
    const dx = ev.clientX - swipeStartX;
    // Only allow rightward drag (RTL reply gesture), cap it, ignore tiny jitter
    const clamped = Math.max(0, Math.min(dx, 70));
    if(clamped > 6){
      clearTimeout(mabLongPressTimer); // dragging cancels long-press
      swipeEl.classList.add('swiping');
      swipeEl.style.transform = `translateX(${clamped}px)`;
      swipeArmed = clamped > 46;
      swipeRow?.classList.toggle('reply-armed', swipeArmed);
    }
  };
  const onUp = ()=>{
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if(swipeEl){
      swipeEl.classList.remove('swiping');
      swipeEl.style.transform = '';
    }
    swipeRow?.classList.remove('reply-armed');
    if(swipeArmed && swipeEl){
      const msgId = swipeEl.dataset.msgId;
      const ctx = swipeEl.dataset.ctx;
      if(msgId) mabReply(msgId, ctx);
    }
    swipeEl = null; swipeRow = null; swipeStartX = null; swipeArmed = false;
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function renderXpProgressBar(xp, level){
  const currentFloor = xpForLevel(level);
  const nextCeil = xpForLevel(level + 1);
  const span = Math.max(1, nextCeil - currentFloor);
  const progressed = Math.max(0, Math.min(xp - currentFloor, span));
  const pct = Math.round((progressed / span) * 100);
  return `
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-faint);font-family:var(--font-mono);margin-bottom:5px">
        <span>Level ${level}</span>
        <span>${xp} / ${nextCeil} XP لمستوى ${level + 1}</span>
      </div>
      <div class="xp-bar-track">
        <div class="xp-bar-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

/* ================= XP SYSTEM ================= */
/* قيم بسيطة جدًا ومقصودة عشان الرفع يبقى تدريجي وياخد وقت */
/*
  قواعد الـ XP (بعد التحديث):
  ✅ نشر بوست/استطلاع: 2 XP
  ✅ نشر مقال: 5 XP
  ✅ إعجاب تستلمه على بوست أو مقال: 1 XP (بيروح لصاحب المحتوى)
  ✅ قبول غرفة: 3 XP
  ❌ رسايل الغرف: مش بتدي XP
  ❌ رسايل الخاصة: مش بتدي XP
  ❌ التعليقات: مش بتدي XP
*/
const XP_RULES = {
  post: 2,
  article: 5,
  like_received: 1,
  room_approved: 3,
};

function xpForLevel(level){
  // نفس معادلة الباك إند بالظبط: المستوى 1 هو نقطة البداية (0 XP)
  if(level <= 1) return 0;
  return Math.round(100 * Math.pow(level - 1, 1.6));
}
function levelFromXp(xp){
  let lvl = 1;
  while(xp >= xpForLevel(lvl + 1)) lvl++;
  return lvl;
}

async function awardXp(amount, reason){
  if(!currentUser || !amount) return;
  try{
    const { error } = await sb.rpc('grant_xp', { p_user_id: currentUser.id, p_amount: amount, p_reason: reason || null });
    if(error){ console.warn('XP award failed', error.message); return; }
    if(currentProfile) currentProfile.xp = (currentProfile.xp||0) + amount;
  }catch(e){ console.warn('XP award failed', e); }
}

/* ================= VOICE/VIDEO CORE (طبقة مشتركة تدعم LiveKit + Daily.co مع fallback تلقائي) ================= */
/*
  دي الطبقة الأساسية اللي بتستخدمها الدردشة الصوتية + الميتنج + اللايف مع بعض.
  بتجرب LiveKit الأول، ولو فشل الاتصال بيه (مشكلة شبكة/CSP/سيرفر) بتحاول تلقائيًا على Daily.co.
  كل واحدة من دول بتنادي connectToLiveKitRoom() بـ kind مختلفة، وبترجع "room" موحّد
  بواجهة استخدام واحدة (disconnect, setMicrophoneEnabled, إلخ) بغض النظر عن المزوّد الفعلي.
*/
let lkCurrentRoom = null;      // الكائن الموحّد الحالي (نوع واحد متصل في نفس الوقت)
let lkCurrentKind = null;      // 'voice' | 'meeting' | 'live'
let lkCurrentProvider = null;  // 'livekit' | 'daily'
let lkLocalTracks = { audio: null, video: null };

async function fetchProviderToken(functionName, kind, targetId){
  const { data:{ session } } = await sb.auth.getSession();
  if(!session) throw new Error('لازم تكون مسجل دخول');
  let res;
  try{
    res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ kind, target_id: targetId }),
    });
  }catch(networkErr){
    // "Failed to fetch" الحقيقي بيحصل هنا لو في مشكلة CORS/CSP/شبكة قبل ما نوصل للسيرفر أصلًا
    throw new Error(`تعذر الوصول لخدمة الاتصال (${functionName}) — تأكد من اتصال الإنترنت وإعدادات CSP. تفاصيل: ${networkErr.message}`);
  }
  let data;
  try{ data = await res.json(); }catch(e){ throw new Error('رد غير متوقع من السيرفر'); }
  if(!res.ok){
    if(data.error === 'livekit_not_configured' || data.error === 'daily_not_configured'){
      throw new Error('خدمة الصوت والفيديو مش متفعّلة على السيرفر لسه');
    }
    throw new Error(data.message || data.error || 'تعذر الحصول على إذن الدخول');
  }
  return data; // { token, url, room_name, can_publish, provider? }
}

/*
  بتحاول الاتصال بـ LiveKit، ولو فشل (أي سبب: توكن، شبكة، CSP، سيرفر واقع) بتحاول تلقائيًا Daily.co.
  بترجع كائن موحّد فيه: disconnect(), setMicrophoneEnabled(), setCameraEnabled(), localParticipant, remoteParticipants
*/
async function connectToLiveKitRoom(kind, targetId, { onTrackSubscribed, onParticipantsChanged, wantVideo, wantAudio } = {}){
  let lastError = null;

  // === محاولة 1: LiveKit ===
  try{
    if(typeof LivekitClient === 'undefined') throw new Error('مكتبة LiveKit مش محمّلة');
    const { token, url, can_publish } = await fetchProviderToken('livekit-token', kind, targetId);

    const room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      onTrackSubscribed?.(track, publication, participant);
    });
    room.on(LivekitClient.RoomEvent.ParticipantConnected, () => onParticipantsChanged?.());
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => onParticipantsChanged?.());
    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      if(lkCurrentProvider === 'livekit'){ lkCurrentRoom = null; lkCurrentKind = null; lkCurrentProvider = null; }
    });

    await room.connect(url, token);

    if(can_publish){
      if(wantAudio){ try{ await room.localParticipant.setMicrophoneEnabled(true); }catch(e){ toast('تعذر تفعيل الميكروفون: '+e.message, 'error'); } }
      if(wantVideo){ try{ await room.localParticipant.setCameraEnabled(true); }catch(e){ toast('تعذر تفعيل الكاميرا: '+e.message, 'error'); } }
    }

    lkCurrentRoom = room;
    lkCurrentKind = kind;
    lkCurrentProvider = 'livekit';
    return room;
  }catch(e){
    lastError = e;
    console.warn('LiveKit connection failed, falling back to Daily.co:', e.message);
  }

  // === محاولة 2: Daily.co (fallback) ===
  try{
    if(typeof DailyIframe === 'undefined') throw new Error('مكتبة Daily.co مش محمّلة');
    const { token, url } = await fetchProviderToken('daily-token', kind, targetId);

    const callFrame = DailyIframe.createCallObject();
    await callFrame.join({ url, token });

    if(wantAudio === false) callFrame.setLocalAudio(false);
    if(wantVideo === false) callFrame.setLocalVideo(false);

    // نغلّف Daily بواجهة استخدام موحّدة زي LiveKit عشان باقي الكود يشتغل من غير تعديل
    const wrapped = {
      _daily: callFrame,
      localParticipant: {
        setMicrophoneEnabled: async (v) => callFrame.setLocalAudio(v),
        setCameraEnabled: async (v) => callFrame.setLocalVideo(v),
      },
      get remoteParticipants(){
        const all = callFrame.participants();
        const map = new Map();
        Object.values(all).forEach(p => { if(!p.local) map.set(p.session_id, p); });
        return map;
      },
      disconnect: async () => { await callFrame.leave(); callFrame.destroy(); },
    };

    callFrame.on('participant-joined', () => onParticipantsChanged?.());
    callFrame.on('participant-left', () => onParticipantsChanged?.());
    callFrame.on('left-meeting', () => {
      if(lkCurrentProvider === 'daily'){ lkCurrentRoom = null; lkCurrentKind = null; lkCurrentProvider = null; }
    });

    lkCurrentRoom = wrapped;
    lkCurrentKind = kind;
    lkCurrentProvider = 'daily';
    toast('تم الاتصال عبر خدمة بديلة (Daily.co)', 'success');
    return wrapped;
  }catch(e2){
    throw new Error(`تعذر الاتصال بخدمة الصوت/الفيديو عبر LiveKit أو البديل Daily.co.\nLiveKit: ${lastError?.message || 'غير معروف'}\nDaily.co: ${e2.message}`);
  }
}

async function disconnectLiveKitRoom(){
  if(lkCurrentRoom){
    try{ await lkCurrentRoom.disconnect(); }catch(e){}
    lkCurrentRoom = null;
    lkCurrentKind = null;
    lkCurrentProvider = null;
  }
}

function lkToggleMic(enabled){
  if(!lkCurrentRoom) return;
  lkCurrentRoom.localParticipant.setMicrophoneEnabled(enabled).catch(e=>toast('خطأ: '+e.message,'error'));
}
function lkToggleCamera(enabled){
  if(!lkCurrentRoom) return;
  lkCurrentRoom.localParticipant.setCameraEnabled(enabled).catch(e=>toast('خطأ: '+e.message,'error'));
}

/* ---- مشاركة الشاشة: موحّدة بين LiveKit وDaily.co ---- */
async function lkToggleScreenShare(enabled){
  if(!lkCurrentRoom) throw new Error('مش متصل بغرفة');
  if(lkCurrentProvider === 'livekit'){
    await lkCurrentRoom.localParticipant.setScreenShareEnabled(enabled);
  } else if(lkCurrentProvider === 'daily'){
    if(enabled) await lkCurrentRoom._daily.startScreenShare();
    else await lkCurrentRoom._daily.stopScreenShare();
  }
}


/* ================= VOICE ROOMS (دردشة صوتية داخل الغرف + فقاعة عامة) ================= */
let voiceBubbleChannel = null;
let activeVoiceSessionId = null;

function ensureVoiceBubbleDom(){
  if(document.getElementById('voiceBubble')) return;
  const el = document.createElement('div');
  el.id = 'voiceBubble';
  el.className = 'voice-bubble';
  el.innerHTML = `<i class="fa-solid fa-microphone-lines"></i><span id="voiceBubbleText"></span>`;
  el.onclick = openVoiceBubblePanel;
  document.body.appendChild(el);
}

async function pollActiveVoiceSessions(){
  if(!currentUser) return;
  const { data, error } = await sb.rpc('get_active_voice_sessions');
  if(error) return;
  ensureVoiceBubbleDom();
  const bubble = document.getElementById('voiceBubble');
  const textEl = document.getElementById('voiceBubbleText');
  if(!data || !data.length){
    bubble.classList.remove('active');
    return;
  }
  const totalParticipants = data.reduce((sum,s)=>sum + Number(s.participant_count||0), 0);
  textEl.textContent = data.length === 1
    ? `${data[0].room_name} · ${data[0].participant_count}`
    : `${data.length} غرف صوتية · ${totalParticipants}`;
  bubble.dataset.sessions = JSON.stringify(data);
  bubble.classList.add('active');
}

// بديل الـ polling: نستمع لتغييرات voice_sessions/voice_participants لحظيًا،
// وبنعمل تحديث فوري بس لما يحصل تغيير فعلي (مش كل X ثانية بشكل دائم)
function startVoiceBubblePolling(){
  if(voiceBubbleChannel) return;
  pollActiveVoiceSessions(); // مسحة أولى وقت الدخول
  voiceBubbleChannel = sb.channel('voice-bubble-global')
    .on('postgres_changes', { event:'*', schema:'public', table:'voice_sessions' }, ()=>{
      pollActiveVoiceSessions();
    })
    .on('postgres_changes', { event:'*', schema:'public', table:'voice_participants' }, ()=>{
      pollActiveVoiceSessions();
    })
    .subscribe();
}

function openVoiceBubblePanel(){
  const bubble = document.getElementById('voiceBubble');
  const sessions = JSON.parse(bubble.dataset.sessions || '[]');
  if(sessions.length === 1){
    openVoiceRoomPage(sessions[0].session_id, sessions[0].room_id, sessions[0].room_name);
    return;
  }
  // أكتر من غرفة صوتية نشطة، نعرض قائمة يختار منها
  ensureVoiceListDom();
  const list = document.getElementById('voiceSessionsList');
  list.innerHTML = sessions.map(s=>`
    <div class="room-card" style="cursor:pointer" onclick="closeVoiceListModal();openVoiceRoomPage('${s.session_id}','${s.room_id}','${escapeHtml(s.room_name).replace(/'/g,"\\'")}')">
      <div class="room-info"><div class="name">${escapeHtml(s.room_name)}</div><div class="desc"><i class="fa-solid fa-microphone-lines"></i> ${s.participant_count} في الدردشة الصوتية</div></div>
    </div>`).join('');
  document.getElementById('voiceListOverlay').classList.add('active');
}

function ensureVoiceListDom(){
  if(document.getElementById('voiceListOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'voiceListOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:380px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h2 style="margin:0"><i class="fa-solid fa-microphone-lines"></i> الدردشات الصوتية النشطة</h2>
        <button class="icon-btn" onclick="closeVoiceListModal()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="voiceSessionsList" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) closeVoiceListModal(); });
}
function closeVoiceListModal(){
  document.getElementById('voiceListOverlay')?.classList.remove('active');
}

/* بدء أو الانضمام للدردشة الصوتية جوه غرفة معينة (بيتنادى من زرار داخل صفحة الغرفة النصية) */
