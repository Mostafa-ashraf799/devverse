let lazyFileObserver = null;
function observeLazyFiles(){
  if(!lazyFileObserver){
    lazyFileObserver = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        if(entry.isIntersecting){
          const el = entry.target;
          lazyFileObserver.unobserve(el);
          loadPostFile(el.dataset.lazyFile, el.dataset.lazyType, el.dataset.lazyFileid);
        }
      });
    }, { rootMargin: '300px' });
  }
  document.querySelectorAll('[data-lazy-file]').forEach(el=>lazyFileObserver.observe(el));
}

async function toggleBookmark(postId, el){
  const saved = el.classList.contains('liked');
  if(saved){
    await sb.from('bookmarks').delete().eq('user_id', currentUser.id).eq('target_type','post').eq('target_id', postId);
    el.classList.remove('liked'); toast('اتشال من المحفوظات');
  }else{
    const { error } = await sb.from('bookmarks').insert({ user_id: currentUser.id, target_type:'post', target_id: postId });
    if(error){ toast('خطأ: '+error.message, 'error'); return; }
    el.classList.add('liked'); toast('اتحفظ', 'success');
  }
}

async function copyText(text){
  if(!text){ toast('مفيش نص يتنسخ', 'error'); return; }
  // محاولة 1: Clipboard API الحديثة (بتحتاج HTTPS + user activation)
  try{
    if(navigator.clipboard && window.isSecureContext){
      await navigator.clipboard.writeText(text);
      toast('تم النسخ', 'success');
      return;
    }
  }catch(e){ console.warn('clipboard API failed:', e.message); }
  // محاولة 2: الطريقة القديمة execCommand (بتشتغل حتى بدون HTTPS أو في سياقات مقيّدة)
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if(ok){ toast('تم النسخ', 'success'); return; }
  }catch(e){ console.warn('execCommand copy failed:', e.message); }
  // محاولة 3: نعرض النص للمستخدم ينسخه يدويًا
  await customPrompt('انسخ النص يدويًا:', text);
}

/*
  بتقرأ النص من data-copy-text attribute بدل ما يتمرر مباشرة جوه onclick.
  السبب: لو النص فيه علامة اقتباس مزدوجة ("), تمريره مباشرة عن طريق
  onclick="copyText(${JSON.stringify(text)})" كان بيكسر الـ HTML attribute نفسه
  ويقطع الـ onclick عند أول علامة اقتباس، فزرار النسخ كان بيفشل بصمت مع أي
  محتوى فيه علامات اقتباس (سبب شكوى المستخدمين إن النسخ "شغال أحيانًا ومش شغال أحيانًا").
  data attribute بيتعامل معاها المتصفح بأمان تلقائيًا عن طريق HTML entity decoding.
*/
function copyTextFromDataAttr(el){
  const text = el.dataset.copyText || '';
  copyText(text);
}

async function sharePost(postId){
  const url = `${window.location.origin}${window.location.pathname}#post-${postId}`;
  await copyText(url);
}

async function repostPost(postId){
  if(!await customConfirm('تعيد نشر المنشور ده في فيدك؟')) return;
  const { error } = await sb.from('posts').insert({ author_id: currentUser.id, content: null, post_type:'text', repost_of: postId });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم إعادة النشر', 'success');
  loadPosts();
}

async function loadPollWidget(postId){
  const holder = document.getElementById(`poll-${postId}`);
  if(!holder) return;
  const { data: poll } = await sb.from('polls').select('id, question').eq('post_id', postId).maybeSingle();
  if(!poll){ holder.innerHTML=''; return; }
  const { data: myVote } = await sb.from('poll_votes').select('option_id').eq('poll_id', poll.id).eq('user_id', currentUser.id).maybeSingle();
  const { data: results } = await sb.rpc('get_poll_results', { p_poll_id: poll.id });
  const total = (results||[]).reduce((s,r)=>s+Number(r.votes),0);
  holder.innerHTML = `<div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px;background:var(--surface)">
    ${(results||[]).map(r=>{
      const pct = total ? Math.round((Number(r.votes)/total)*100) : 0;
      const isMine = myVote?.option_id === r.option_id;
      return `<div style="margin-bottom:8px;cursor:pointer" onclick="voteOnPoll('${poll.id}','${r.option_id}','${postId}')">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>${isMine?'<i class="fa-solid fa-circle-check"></i> ':''}${escapeHtml(r.option_text)}</span><span style="color:var(--ink-faint)">${pct}%</span></div>
        <div style="background:var(--bg);border-radius:6px;height:8px;overflow:hidden"><div style="background:${isMine?'var(--accent)':'var(--ink-faint)'};height:100%;width:${pct}%;transition:width 0.5s var(--ease-out)"></div></div>
      </div>`;
    }).join('')}
    <div style="font-size:11px;color:var(--ink-faint);margin-top:6px">${total} صوت</div>
  </div>`;
}

async function voteOnPoll(pollId, optionId, postId){
  const { error } = await sb.from('poll_votes').upsert({ poll_id: pollId, option_id: optionId, user_id: currentUser.id }, { onConflict:'poll_id,user_id' });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  loadPollWidget(postId);
}

function applyAvatarBg(el, url){
  el.style.backgroundImage = `url(${url})`; el.style.backgroundSize='cover'; el.style.backgroundPosition='center'; el.textContent='';
}

async function loadAvatarInto(elId, fileId){
  const el = document.getElementById(elId);
  if(!el || !fileId) return;
  const url = await getFileUrlCached(fileId);
  if(url) applyAvatarBg(el, url);
}

async function loadPostFile(postId, type, fileId){
  const holder = document.getElementById(`file-${postId}`);
  if(!holder) return;
  if(type==='video'){
    holder.innerHTML = `<div class="video-play-placeholder" onclick="playStreamedVideo('${postId}', '${escapeHtml(fileId)}')">
      <i class="fa-solid fa-circle-play"></i>
    </div>`;
    return;
  }
  const url = await getFileUrlCached(fileId);
  if(!url){ holder.innerHTML = `<div style="padding:16px;color:var(--ink-faint);font-size:12px">تعذر تحميل الملف</div>`; return; }
  holder.innerHTML = `<img src="${url}" loading="lazy">`;
}

async function playStreamedVideo(holderId, fileId){
  const holder = document.getElementById(`file-${holderId}`);
  if(!holder) return;
  const streamUrl = await getTelegramStreamUrl(fileId);
  if(!streamUrl){ toast('تعذر تشغيل الفيديو', 'error'); return; }
  holder.innerHTML = `<video src="${streamUrl}" controls autoplay playsinline></video>`;
}

async function loadLikeCount(postId){
  const { count } = await sb.from('post_likes').select('*', {count:'exact', head:true}).eq('post_id', postId);
  const elx = document.getElementById(`likecount-${postId}`);
  if(elx) elx.textContent = count || 0;
}

async function loadCommentCount(postId){
  const { count } = await sb.from('post_comments').select('*', {count:'exact', head:true}).eq('post_id', postId);
  const elx = document.getElementById(`commentcount-${postId}`);
  if(elx) elx.textContent = count > 0 ? count : '';
}

async function deletePost(postId){
  if(!await customConfirm('متأكد إنك عايز تحذف المنشور ده؟', true)) return;
  const { error } = await sb.from('posts').update({ is_removed: true }).eq('id', postId);
  if(error){ toast('تعذر الحذف: '+error.message, 'error'); return; }
  toast('تم حذف المنشور', 'success');
  loadPosts();
}

async function pinPost(postId, pinTo){
  const { error } = await sb.from('posts').update({ is_pinned: pinTo }).eq('id', postId);
  if(error){ toast('تعذر التثبيت: '+error.message, 'error'); return; }
  toast(pinTo ? 'تم تثبيت المنشور' : 'تم إلغاء التثبيت', 'success');
  loadPosts();
}

async function toggleLike(postId, el){
  const liked = el.classList.contains('liked');
  if(liked){
    await sb.from('post_likes').delete().eq('post_id', postId).eq('user_id', currentUser.id);
    el.classList.remove('liked');
  }else{
    await sb.from('post_likes').insert({ post_id: postId, user_id: currentUser.id });
    el.classList.add('liked');
    // XP بتروح لصاحب البوست مش للي عمل اللايك
    sb.from('posts').select('author_id').eq('id', postId).single().then(({data})=>{
      if(data?.author_id && data.author_id !== currentUser.id){
        sb.rpc('grant_xp', { p_user_id: data.author_id, p_amount: XP_RULES.like_received, p_reason: 'لايك على منشور' }).catch(()=>{});
      }
    });
  }
  loadLikeCount(postId);
}

async function toggleComments(postId){
  const box = document.getElementById(`comments-${postId}`);
  box.classList.toggle('open');
  if(!box.classList.contains('open')) return;
  box.innerHTML = `<div class="empty-state" style="padding:10px"><div class="spinner"></div></div>`;
  const { data: comments } = await sb.from('post_comments').select('*, profiles(username)').eq('post_id', postId).eq('is_removed', false).order('created_at').limit(200);
  box.innerHTML = (comments||[]).map(c=>`<div class="comment"><b class="name" style="cursor:pointer" onclick="viewProfile('${c.author_id}')">@${c.profiles?.username||''}</b> ${linkifyText(escapeHtml(c.content))}</div>`).join('')
    + `<div class="comment-input"><input type="text" placeholder="اكتب تعليق..." onkeydown="if(event.key==='Enter')submitComment('${postId}', this)"></div>`;
}

async function submitComment(postId, input){
  const content = input.value.trim();
  if(!content) return;
  const { error } = await sb.from('post_comments').insert({ post_id: postId, author_id: currentUser.id, content });
  if(error){ toast('تعذر إرسال التعليق', 'error'); return; }
  input.value='';
  toggleComments(postId); toggleComments(postId);
}

/* ================= ARTICLES ================= */
let articlesCurrentOffset = 0;
const ARTICLES_PAGE_SIZE = 12;
let articlesHasMore = true;

async function renderArticles(container){
  articlesCurrentOffset = 0;
  articlesHasMore = true;
  container.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div><h1>المقالات</h1><div class="sub">مقالات تقنية من المجتمع</div></div>
        <button class="btn btn-primary btn-sm" onclick="openArticleEditor()"><i class="fa-solid fa-pen"></i> كتابة مقال</button>
      </div>
      <div id="articlesList"><div class="empty-state"><div class="spinner"></div></div></div>
    </div>`;
  await loadArticlesPage(true);
}

async function loadMoreArticles(){
  await loadArticlesPage(false);
}

async function loadArticlesPage(isFirstPage){
  const listEl = document.getElementById('articlesList');
  try{
    const rangeFrom = articlesCurrentOffset;
    const rangeTo = articlesCurrentOffset + ARTICLES_PAGE_SIZE - 1;
    const { data: articles, error } = await sb.from('articles').select('*, profiles!author_id(username, full_name)').eq('is_draft', false).eq('is_removed', false).order('is_pinned', {ascending:false}).order('created_at', {ascending:false}).range(rangeFrom, rangeTo);
    if(error){ if(isFirstPage) listEl.innerHTML = `<div class="empty-state" style="color:var(--red)"><div class="icon"><i class="fa-solid fa-triangle-exclamation"></i></div>تعذر تحميل المقالات: ${escapeHtml(error.message)}</div>`; return; }
    if(!articles?.length){
      articlesHasMore = false;
      document.getElementById('loadMoreArticlesBtn')?.remove();
      if(isFirstPage) listEl.innerHTML = `<div class="empty-state"><div class="icon"><i class="fa-solid fa-pen-to-square"></i></div>لسه مفيش مقالات منشورة</div>`;
      return;
    }
    if(articles.length < ARTICLES_PAGE_SIZE) articlesHasMore = false;
    articlesCurrentOffset += articles.length;

    const cardsHtml = articles.map((a, i)=>`
      <div class="article-card" style="animation-delay:${i * 0.05}s" onclick="openArticleReader('${a.id}')">
        ${a.is_pinned ? `<div style="color:var(--accent);font-size:12px;margin-bottom:6px"><i class="fa-solid fa-thumbtack"></i> مثبت</div>` : ''}
        <h3>${escapeHtml(a.title)}</h3>
        <div class="article-meta">${a.profiles?.full_name||a.profiles?.username} · ${timeAgo(a.created_at)} · ${a.views} مشاهدة</div>
        <div class="article-excerpt">${escapeHtml((a.content_markdown||'').slice(0,160))}...</div>
      </div>`).join('');

    if(isFirstPage) listEl.innerHTML = cardsHtml;
    else{
      document.getElementById('loadMoreArticlesBtn')?.remove();
      listEl.insertAdjacentHTML('beforeend', cardsHtml);
    }

    if(articlesHasMore){
      listEl.insertAdjacentHTML('beforeend', `<div id="loadMoreArticlesBtn" style="text-align:center;padding:16px"><button class="btn btn-sm" onclick="loadMoreArticles()"><i class="fa-solid fa-arrow-down"></i> حمّل أكتر</button></div>`);
    }
  }catch(e){
    // أي خطأ JS غير متوقع (زي فشل تحميل مكتبة، أو undefined) هيبان هنا واضح بدل ما يختفي بصمت
    console.error('renderArticles crashed:', e);
    if(isFirstPage) listEl.innerHTML = `<div class="empty-state" style="color:var(--red)"><div class="icon"><i class="fa-solid fa-triangle-exclamation"></i></div>حصل خطأ غير متوقع أثناء تحميل المقالات: ${escapeHtml(e.message)}<br><span style="font-size:11px;color:var(--ink-faint)">افتح الـ Console (F12) للتفاصيل الكاملة</span></div>`;
  }
}

async function openArticleReader(articleId){
  const c = document.getElementById('viewContainer');
  c.innerHTML = `<div class="view"><div class="empty-state"><div class="spinner"></div></div></div>`;
  try{
    sb.rpc('increment_article_views', { p_article_id: articleId });
    const { data: a, error } = await sb.from('articles').select('*, profiles!author_id(username, full_name, avatar_file_id)').eq('id', articleId).single();
    if(error || !a){ c.innerHTML = `<div class="view"><div class="empty-state">تعذر تحميل المقال${error?': '+escapeHtml(error.message):''}</div></div>`; return; }
    const { count: likeCount } = await sb.from('article_likes').select('*',{count:'exact',head:true}).eq('article_id', articleId);
    const { data: myLike } = await sb.from('article_likes').select('*').eq('article_id', articleId).eq('user_id', currentUser.id).maybeSingle();
    const { data: bookmark } = await sb.from('bookmarks').select('*').eq('user_id', currentUser.id).eq('target_type','article').eq('target_id', articleId).maybeSingle();
    const { data: comments } = await sb.from('article_comments').select('*, profiles(username)').eq('article_id', articleId).eq('is_removed', false).order('created_at').limit(200);
    const canManage = a.author_id===currentUser.id || ['owner','super_admin','admin','moderator'].includes(currentProfile.role);
    c.innerHTML = `<div class="view">
      <button class="btn btn-sm" style="margin-bottom:16px" onclick="nav('articles')"><i class="fa-solid fa-arrow-right"></i> رجوع للمقالات</button>
      ${a.is_pinned ? `<div style="color:var(--accent);font-size:12px;margin-bottom:8px"><i class="fa-solid fa-thumbtack"></i> مثبت</div>` : ''}
      <h1 style="font-family:var(--font-display);font-size:26px;margin-bottom:8px">${escapeHtml(a.title)}</h1>
      <div class="article-meta" style="margin-bottom:20px">${escapeHtml(a.profiles?.full_name||a.profiles?.username||'')} · ${timeAgo(a.created_at)} · ${a.views+1} مشاهدة</div>
      <div style="white-space:pre-wrap;line-height:1.9;font-size:15px;margin-bottom:20px">${linkifyText(escapeHtml(a.content_markdown||''))}</div>
      <div class="post-actions" style="margin-bottom:20px">
        <div class="act ${myLike?'liked':''}" id="articleLikeAct" onclick="toggleArticleLike('${articleId}', this)"><i class="fa-solid fa-heart"></i> <span id="articleLikeCount">${likeCount||0}</span></div>
        <div class="act ${bookmark?'liked':''}" onclick="toggleArticleBookmark('${articleId}', this)"><i class="fa-solid fa-bookmark"></i> حفظ</div>
        <div class="act" onclick="shareArticle('${articleId}')"><i class="fa-solid fa-share-nodes"></i> مشاركة</div>
        <div class="act copy-btn" data-copy-text="${escapeHtml(a.content_markdown||'')}" onclick="copyTextFromDataAttr(this)"><i class="fa-solid fa-copy"></i> نسخ</div>
        ${canManage ? `<div class="act ${a.is_pinned?'liked':''}" onclick="pinArticle('${articleId}', ${!a.is_pinned})"><i class="fa-solid fa-thumbtack"></i> ${a.is_pinned?'إلغاء التثبيت':'تثبيت'}</div>` : ''}
        ${canManage ? `<div class="act" style="color:var(--red)" onclick="deleteArticle('${articleId}')"><i class="fa-solid fa-trash"></i> حذف</div>` : ''}
      </div>
      <div class="view-header"><h1 style="font-size:16px">التعليقات</h1></div>
      <div id="articleComments">${(comments||[]).map(cm=>`<div class="comment"><b class="name" style="cursor:pointer" onclick="viewProfile('${cm.author_id}')">@${cm.profiles?.username||''}</b> ${linkifyText(escapeHtml(cm.content))}</div>`).join('')}</div>
      <div class="comment-input" style="margin-top:10px"><input type="text" id="articleCommentInput" placeholder="اكتب تعليق..." onkeydown="if(event.key==='Enter')submitArticleComment('${articleId}')"></div>
    </div>`;
  }catch(e){
    console.error('openArticleReader crashed:', e);
    c.innerHTML = `<div class="view"><div class="empty-state" style="color:var(--red)">حصل خطأ غير متوقع أثناء تحميل المقال: ${escapeHtml(e.message)}</div></div>`;
  }
}

async function toggleArticleLike(articleId, el){
  const liked = el.classList.contains('liked');
  if(liked){ await sb.from('article_likes').delete().eq('article_id', articleId).eq('user_id', currentUser.id); el.classList.remove('liked'); }
  else{
    await sb.from('article_likes').insert({ article_id: articleId, user_id: currentUser.id });
    el.classList.add('liked');
    sb.from('articles').select('author_id').eq('id', articleId).single().then(({data})=>{
      if(data?.author_id && data.author_id !== currentUser.id){
        sb.rpc('grant_xp', { p_user_id: data.author_id, p_amount: XP_RULES.like_received, p_reason: 'لايك على مقال' }).catch(()=>{});
      }
    });
  }
  const { count } = await sb.from('article_likes').select('*',{count:'exact',head:true}).eq('article_id', articleId);
  document.getElementById('articleLikeCount').textContent = count||0;
}

async function toggleArticleBookmark(articleId, el){
  const saved = el.classList.contains('liked');
  if(saved){ await sb.from('bookmarks').delete().eq('user_id', currentUser.id).eq('target_type','article').eq('target_id', articleId); el.classList.remove('liked'); toast('اتشال من المحفوظات'); }
  else{ await sb.from('bookmarks').insert({ user_id: currentUser.id, target_type:'article', target_id: articleId }); el.classList.add('liked'); toast('اتحفظ','success'); }
}

async function shareArticle(articleId){
  const url = `${window.location.origin}${window.location.pathname}#article-${articleId}`;
  await copyText(url);
}

async function deleteArticle(articleId){
  if(!await customConfirm('متأكد إنك عايز تحذف المقال ده؟', true)) return;
  const { error } = await sb.from('articles').update({ is_removed: true }).eq('id', articleId);
  if(error){ toast('تعذر الحذف: '+error.message, 'error'); return; }
  toast('تم حذف المقال', 'success');
  nav('articles');
}

async function pinArticle(articleId, pinTo){
  const { error } = await sb.from('articles').update({ is_pinned: pinTo }).eq('id', articleId);
  if(error){ toast('تعذر التثبيت: '+error.message, 'error'); return; }
  toast(pinTo ? 'تم تثبيت المقال' : 'تم إلغاء التثبيت', 'success');
  openArticleReader(articleId);
}

async function submitArticleComment(articleId){
  const input = document.getElementById('articleCommentInput');
  const content = input.value.trim();
  if(!content) return;
  const { error } = await sb.from('article_comments').insert({ article_id: articleId, author_id: currentUser.id, content });
  if(error){ toast('تعذر إرسال التعليق: '+error.message, 'error'); return; }
  input.value='';
  openArticleReader(articleId);
}

function openArticleEditor(){
  const c = document.getElementById('viewContainer');
  c.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div><h1>كتابة مقال</h1><div class="sub">اكتب مقالك بالتفصيل، وانشره لما يكون جاهز</div></div>
        <button class="btn btn-sm" onclick="nav('articles')">إلغاء</button>
      </div>
      <input type="text" id="articleEditorTitle" placeholder="عنوان المقال" style="width:100%;font-size:16px;font-weight:700;margin-bottom:12px">
      <textarea id="articleEditorContent" placeholder="اكتب محتوى المقال هنا... (بيدعم Markdown)" style="width:100%;min-height:360px;resize:vertical;line-height:1.7"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-primary" id="articlePublishBtn" onclick="submitArticleFromEditor()"><i class="fa-solid fa-paper-plane"></i> نشر المقال</button>
      </div>
    </div>`;
}

let articlePublishing = false;
async function submitArticleFromEditor(){
  if(articlePublishing) return; // منع الضغط المتكرر أثناء النشر
  const title = document.getElementById('articleEditorTitle').value.trim();
  const content = document.getElementById('articleEditorContent').value.trim();
  if(!title){ toast('لازم تكتب عنوان', 'error'); return; }
  if(!content){ toast('لازم تكتب محتوى المقال', 'error'); return; }

  articlePublishing = true;
  const btn = document.getElementById('articlePublishBtn');
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:14px;height:14px"></div> جاري النشر...`;

  const slug = title.trim().toLowerCase().replace(/[^ء-ي a-z0-9]/gi,'').replace(/\s+/g,'-') + '-' + Date.now();
  const { error } = await sb.from('articles').insert({ author_id: currentUser.id, title, slug, content_markdown: content, is_draft:false });

  articlePublishing = false;
  if(error){
    toast('تعذر النشر: '+error.message, 'error');
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> نشر المقال`;
    return;
  }
  toast('تم نشر المقال بنجاح', 'success');
  awardXp(XP_RULES.article, 'نشر مقال');
  nav('articles');
}

/* ================= CHAT ROOMS ================= */
let roomsListChannel = null;
async function renderRooms(container){
  container.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div><h1>غرف الدردشة</h1><div class="sub">الغرف اللي انت عضو فيها بس — ادخل غرفة جديدة بلينك دعوة</div></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" onclick="promptJoinByInvite()"><i class="fa-solid fa-link"></i> دخول بلينك دعوة</button>
          <button class="btn btn-primary btn-sm" onclick="requestNewRoom()">+ طلب غرفة جديدة</button>
        </div>
      </div>
      <div id="roomsList"><div class="empty-state"><div class="spinner"></div></div></div>
    </div>`;
  await loadRoomsList();
}

async function loadRoomsList(){
  const listEl = document.getElementById('roomsList');
  if(!listEl) return;
  const { data: rooms, error } = await sb.from('chat_rooms')
    .select('id, name, description, category_id, creator_id, status, room_number, created_at')
    .order('created_at', {ascending:false});
  if(error){ listEl.innerHTML = `<div class="empty-state" style="color:var(--red)">تعذر تحميل الغرف: ${escapeHtml(error.message)}</div>`; toast('خطأ: '+error.message, 'error'); return; }
  if(!rooms?.length){ listEl.innerHTML = `<div class="empty-state"><div class="icon"><i class="fa-solid fa-comment-dots"></i></div>لسه مفيش غرف — اطلب أول غرفة أو ادخل بلينك دعوة</div>`; return; }
  const categoryIds = [...new Set(rooms.map(r=>r.category_id).filter(Boolean))];
  let categoryMap = new Map();
  if(categoryIds.length){
    const { data: cats } = await sb.from('categories').select('id, name_ar').in('id', categoryIds);
    categoryMap = new Map((cats||[]).map(c=>[c.id, c.name_ar]));
  }
  listEl.innerHTML = rooms.map((r, i)=>`
    <div class="room-card" style="animation-delay:${i * 0.04}s">
      <div class="room-info">
        <div class="name">${escapeHtml(r.name)} <span class="room-number-tag">#${r.room_number}</span> ${categoryMap.has(r.category_id)?`<span class="post-cat">${escapeHtml(categoryMap.get(r.category_id))}</span>`:''} <span id="roomUnread-${r.id}"></span></div>
        <div class="desc">${escapeHtml(r.description||'')}</div>
      </div>
      <span class="status-pill ${r.status}">${r.status==='pending'?'بانتظار الموافقة':r.status==='approved'?'مفعّلة':r.status==='rejected'?'مرفوضة':r.status}</span>
      ${r.status==='approved' ? `<button class="btn btn-sm" onclick="openRoomChat('${r.id}','${escapeHtml(r.name).replace(/'/g,"\\'")}')">دخول</button>` : ''}
      ${(r.creator_id===currentUser.id && r.status==='approved') ? `<button class="btn btn-sm" onclick="createInviteFlow('${r.id}')"><i class="fa-solid fa-link"></i> لينك دعوة</button>` : ''}
      ${r.creator_id===currentUser.id ? `<button class="btn btn-sm" onclick="openRoomAdminPanel('${r.id}','${escapeHtml(r.name).replace(/'/g,"\\'")}')"><i class="fa-solid fa-gear"></i> إدارة</button>` : ''}
    </div>`).join('');
  loadRoomsUnreadCounts();
}

async function loadRoomsUnreadCounts(){
  const { data: counts } = await sb.rpc('get_unread_room_counts');
  (counts||[]).forEach(row=>{
    const el = document.getElementById(`roomUnread-${row.room_id}`);
    if(el) el.innerHTML = `<span class="room-unread-badge">${row.unread_count}</span>`;
  });
}

let myRoomStatusSnapshot = {};

async function pollMyRooms(){
  if(!currentUser) return;
  const { data: rooms, error } = await sb.from('chat_rooms')
    .select('id, name, status')
    .eq('creator_id', currentUser.id);
  if(error || !rooms) return;
  let anyChanged = false;
  for(const r of rooms){
    const prev = myRoomStatusSnapshot[r.id];
    if(prev !== undefined && prev !== r.status){
      anyChanged = true;
      if(r.status === 'approved') toast(`تمت الموافقة على غرفة "${r.name}"`, 'success');
      else if(r.status === 'rejected') toast(`تم رفض طلب غرفة "${r.name}"`, 'error');
    }
    myRoomStatusSnapshot[r.id] = r.status;
  }
  if(document.getElementById('roomsList') && anyChanged) loadRoomsList();
  checkUnreadBadges();
}

function subscribeToRoomsList(){
  if(roomsListChannel){ sb.removeChannel(roomsListChannel); roomsListChannel = null; }
  roomsListChannel = sb.channel('rooms-list-'+currentUser.id)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'chat_rooms', filter:`creator_id=eq.${currentUser.id}` }, ()=>{
      pollMyRooms();
    })
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'chat_room_members', filter:`user_id=eq.${currentUser.id}` }, ()=>{
      loadRoomsList();
      checkUnreadBadges();
    })
    .subscribe();
  pollMyRooms(); // مسحة أولى وقت الدخول بس، مش دايمة
}

async function promptJoinByInvite(){
  const input = await customPrompt('الصق لينك الدعوة أو الكود بتاعه:');
  if(!input) return;
  let code = input.trim();
  const match = code.match(/[?&]invite=([^&\s]+)/);
  if(match) code = match[1];
  joinRoomByCode(code);
}

async function joinRoomByCode(code){
  const { data: roomId, error } = await sb.rpc('join_room_via_invite', { p_code: code });
  if(error){
    const msg = error.message.includes('invite not found') ? 'لينك الدعوة غلط'
      : error.message.includes('invite revoked') ? 'لينك الدعوة ده ملغي'
      : error.message.includes('invite expired') ? 'لينك الدعوة انتهى'
      : error.message.includes('invite exhausted') ? 'لينك الدعوة وصل للحد الأقصى للاستخدام'
      : error.message.includes('banned from room') ? 'انت متطرود من الغرفة دي'
      : error.message;
    toast('تعذر الدخول: '+msg, 'error');
    return;
  }
  const { data: room } = await sb.from('chat_rooms').select('name').eq('id', roomId).single();
  toast('اتضفت للغرفة بنجاح', 'success');
  checkUnreadBadges();
  openRoomChat(roomId, room?.name || '');
}

function checkUrlInviteOnLoad(){
  const params = new URLSearchParams(window.location.search);
  const code = params.get('invite');
  if(code && currentUser){
    joinRoomByCode(code);
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url.toString());
  }
}

async function requestNewRoom(){
  const name = await customPrompt('اسم الغرفة:');
  if(!name) return;
  const description = await customPrompt('وصف قصير للغرفة:') || '';
  sb.from('chat_rooms').insert({ name, description, creator_id: currentUser.id, status:'pending' })
    .then(({error})=>{
      if(error){ toast('خطأ: '+error.message, 'error'); return; }
      toast('تم إرسال الطلب — بانتظار موافقة الأدمن', 'success');
      nav('rooms');
    });
}

async function openRoomMembersModal(roomId, roomName){
  document.getElementById('roomMembersModalTitle').textContent = `أعضاء ${roomName}`;
  document.getElementById('roomMembersOverlay').classList.add('active');
  const listEl = document.getElementById('roomMembersModalList');
  listEl.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  const { data: members, error } = await sb.rpc('list_room_members', { p_room_id: roomId });
  const { data: room } = await sb.from('chat_rooms').select('creator_id').eq('id', roomId).single();
  if(error){ listEl.innerHTML = `<div class="empty-state" style="color:var(--red)">تعذر التحميل: ${escapeHtml(error.message)}</div>`; return; }
  if(!members?.length){ listEl.innerHTML = `<div class="empty-state">مفيش أعضاء</div>`; return; }
  listEl.innerHTML = members.map((m, i)=>`
    <div class="member-row" style="animation:fadeInUp 0.3s var(--ease-out) ${i * 0.04}s both">
      <div class="avatar" id="rmm-av-${m.user_id}" style="width:32px;height:32px;font-size:13px;cursor:pointer" onclick="closeRoomMembersModal();viewProfile('${m.user_id}')">${(m.username||'?')[0].toUpperCase()}</div>
      <div class="name" style="cursor:pointer" onclick="closeRoomMembersModal();viewProfile('${m.user_id}')">${escapeHtml(m.full_name||m.username||'مستخدم')} ${m.user_id===room?.creator_id?' <i class="fa-solid fa-crown"></i>':''}</div>
    </div>`).join('');
  members.forEach(m=>{ if(m.avatar_file_id) loadAvatarInto(`rmm-av-${m.user_id}`, m.avatar_file_id); });
}

function closeRoomMembersModal(){
  document.getElementById('roomMembersOverlay').classList.remove('active');
}

async function openRoomChat(roomId, roomName){
  activeRoomId = roomId;
  replyingTo = null;
  const { data: roomInfo } = await sb.from('chat_rooms').select('creator_id, room_number, is_disabled').eq('id', roomId).single();
  activeRoomCreatorId = roomInfo?.creator_id || null;
  const isRoomAdmin = activeRoomCreatorId === currentUser.id;
  const { data: membership } = await sb.from('chat_room_members').select('is_muted, last_read_at').eq('room_id', roomId).eq('user_id', currentUser.id).single();
  const isMuted = membership?.is_muted || false;
  const roomLastReadAt = membership?.last_read_at || null;
  const c = document.getElementById('viewContainer');
  c.innerHTML = `
    <div class="chat-view">
      <div class="rooms-rail" id="roomsRail"></div>
      <div style="flex:1;display:flex;flex-direction:column;min-width:0">
        <div class="dm-chat-header">
          <button class="btn btn-sm" onclick="nav('rooms')"><i class="fa-solid fa-arrow-right"></i></button>
          <span style="cursor:pointer;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" onclick="openRoomMembersModal('${roomId}','${escapeHtml(roomName).replace(/'/g,"\\'")}')">${escapeHtml(roomName)} <span class="room-number-tag">#${roomInfo?.room_number ?? ''}</span> <i class="fa-solid fa-users"></i></span>
          <button class="btn btn-sm" onclick="startOrJoinVoiceFromRoom('${roomId}','${escapeHtml(roomName).replace(/'/g,"\\'")}')"><i class="fa-solid fa-microphone-lines"></i></button>
          ${isRoomAdmin ? `<button class="btn btn-sm" onclick="openRoomAdminPanel('${roomId}','${escapeHtml(roomName).replace(/'/g,"\\'")}')"><i class="fa-solid fa-gear"></i> إدارة</button>` : ''}
          <div style="position:relative;flex-shrink:0">
            <button class="btn btn-sm" onclick="toggleRoomOptionsMenu()"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            <div id="roomOptionsMenu" class="dropdown-menu" style="display:none">
              <div class="dropdown-item" id="roomMuteBtn" onclick="toggleRoomMute('${roomId}')">${isMuted ? '<i class="fa-solid fa-bell-slash"></i> إلغاء كتم الإشعارات' : '<i class="fa-solid fa-bell"></i> كتم الإشعارات'}</div>
              <div class="dropdown-item" onclick="hideRoomOptionsMenu();confirmClearLocalConversation('room','${roomId}')"><i class="fa-solid fa-broom"></i> مسح المحادثة من جهازي</div>
              ${isRoomAdmin
                ? `<div class="dropdown-item" style="color:var(--red)" onclick="hideRoomOptionsMenu();confirmDeleteRoom('${roomId}','${escapeHtml(roomName).replace(/'/g,"\\'")}')"><i class="fa-solid fa-trash"></i> حذف الغرفة</div>`
                : `<div class="dropdown-item" style="color:var(--red)" onclick="hideRoomOptionsMenu();confirmLeaveRoom('${roomId}')"><i class="fa-solid fa-right-from-bracket"></i> مغادرة الغرفة</div>`
              }
            </div>
          </div>
        </div>
        ${roomInfo?.is_disabled ? `<div style="padding:8px 20px;background:rgba(232,93,93,.1);color:var(--red);font-size:12px">هذه الغرفة معطّلة من الإدارة — الأعضاء العاديين مايقدروش يبعتوا رسايل فيها</div>` : ''}
        <div id="pinnedBanner"></div>
        <div class="chat-messages" id="chatMessages"></div>
        <button class="scroll-to-bottom-btn" id="roomScrollDownBtn" onclick="scrollRoomToBottom()"><i class="fa-solid fa-chevron-down"></i><span class="scroll-down-badge" id="roomScrollDownBadge" style="display:none"></span></button>
        <div id="typingIndicator" style="padding:4px 20px;font-size:12px;color:var(--ink-faint);min-height:20px"></div>
        <div id="replyBar" style="display:none;align-items:center;gap:8px;padding:8px 16px;background:var(--surface);border-top:1px solid var(--border);font-size:12px;color:var(--ink-dim)">
          <span id="replyBarText" style="flex:1"></span>
          <button class="icon-btn" style="width:24px;height:24px" onclick="cancelReply()"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="roomRecordBar" class="record-bar"><span class="record-dot"></span><span id="roomRecordTime">0:00</span> جاري التسجيل...
          <button class="btn btn-sm" onclick="cancelVoiceRecording('room')">إلغاء</button>
          <button class="btn btn-primary btn-sm" onclick="stopVoiceRecording('room')">إرسال</button>
        </div>
        <div class="chat-input-bar">
          <label class="file-label"><i class="fa-solid fa-paperclip"></i><input type="file" id="chatFile" style="display:none" onchange="sendChatFile(this)"></label>
          <span class="mic-btn" id="roomMicBtn" onclick="startVoiceRecording('room')"><i class="fa-solid fa-microphone"></i></span>
          <textarea id="chatInput" rows="1" placeholder="اكتب رسالة... (Shift+Enter لسطر جديد)" oninput="broadcastTyping();handleMentionInput('chatInput','room');autoResizeTextarea(this)" onkeydown="handleMentionKeydown(event,'chatInput')"></textarea>
          <button class="btn btn-primary btn-sm" onclick="sendChatMessage()">إرسال</button>
        </div>
      </div>
    </div>`;
  loadRoomsRail();
  loadRoomMessages(roomId, roomLastReadAt);
  subscribeToRoom(roomId);
  subscribeToTyping(roomId);
  bindDragDropUpload('chatMessages', sendChatFile);
}

function toggleRoomOptionsMenu(){
  const menu = document.getElementById('roomOptionsMenu');
  if(menu) menu.style.display = menu.style.display==='none' ? 'block' : 'none';
}
function hideRoomOptionsMenu(){
  const menu = document.getElementById('roomOptionsMenu');
  if(menu) menu.style.display = 'none';
}
document.addEventListener('click', (e)=>{
  const menu = document.getElementById('roomOptionsMenu');
  if(!menu || menu.style.display==='none') return;
  if(!menu.contains(e.target) && !e.target.closest('button[onclick="toggleRoomOptionsMenu()"]')) hideRoomOptionsMenu();
});

async function toggleRoomMute(roomId){
  const btn = document.getElementById('roomMuteBtn');
  const currentlyMuted = btn?.textContent.includes('إلغاء كتم');
  const { error } = await sb.rpc('toggle_room_mute', { p_room_id: roomId, p_muted: !currentlyMuted });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  if(btn) btn.innerHTML = currentlyMuted ? '<i class="fa-solid fa-bell"></i> كتم الإشعارات' : '<i class="fa-solid fa-bell-slash"></i> إلغاء كتم الإشعارات';
  hideRoomOptionsMenu();
}

async function confirmLeaveRoom(roomId){
  if(!await customConfirm('تغادر الغرفة دي؟ محتاج لينك دعوة جديد عشان ترجع تاني.', true)) return;
  const { error } = await sb.rpc('leave_room', { p_room_id: roomId });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('غادرت الغرفة', 'success');
  nav('rooms');
}

async function confirmDeleteRoom(roomId, roomName){
  if(!await customConfirm(`تمسح غرفة "${roomName}" نهائيًا؟ هيتمسح كل رسايلها وأعضاءها. الإجراء ده مينفعش يترجع.`, true)) return;
  const { error } = await sb.rpc('creator_delete_room', { p_room_id: roomId });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم حذف الغرفة', 'success');
  nav('rooms');
}

async function loadRoomsRail(){
  const { data: memberships } = await sb.from('chat_room_members').select('room_id').eq('user_id', currentUser.id);
  const roomIds = (memberships||[]).map(m=>m.room_id);
  if(!roomIds.length){ document.getElementById('roomsRail').innerHTML = ''; return; }
  const { data: rooms } = await sb.from('chat_rooms').select('id, name, creator_id, status').in('id', roomIds).eq('status', 'approved');
  document.getElementById('roomsRail').innerHTML = (rooms||[]).map(r=>
    `<div class="room-item ${r.id===activeRoomId?'active':''}" onclick="openRoomChat('${r.id}','${escapeHtml(r.name).replace(/'/g,"\\'")}')">${escapeHtml(r.name)}</div>`
  ).join('');
}

async function openRoomAdminPanel(roomId, roomName){
  const c = document.getElementById('viewContainer');
  c.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div><h1>إدارة غرفة: ${escapeHtml(roomName)}</h1><div class="sub">لينكات الدعوة والأعضاء</div></div>
        <button class="btn btn-sm" onclick="openRoomChat('${roomId}','${escapeHtml(roomName).replace(/'/g,"\\'")}')"><i class="fa-solid fa-arrow-right"></i> رجوع للغرفة</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:18px">
        <button class="btn btn-primary btn-sm" onclick="createInviteFlow('${roomId}')">+ إنشاء لينك دعوة</button>
      </div>
      <h3 style="margin-bottom:10px;font-size:15px">لينكات الدعوة</h3>
      <div id="roomInvitesList"><div class="empty-state"><div class="spinner"></div></div></div>
      <h3 style="margin:22px 0 10px;font-size:15px">الأعضاء</h3>
      <div id="roomMembersList"><div class="empty-state"><div class="spinner"></div></div></div>
    </div>`;
  loadRoomInvites(roomId);
  loadRoomMembers(roomId);
}

async function createInviteFlow(roomId){
  const usesInput = await customPrompt('أقصى عدد استخدام للينك (سيبها فاضية = بلا حدود):');
  if(usesInput === null) return;
  const maxUses = usesInput.trim() ? parseInt(usesInput.trim(), 10) : null;
  const hoursInput = await customPrompt('اللينك يخلص بعد كام ساعة؟ (سيبها فاضية = ما يخلصش):');
  if(hoursInput === null) return;
  const expiresHours = hoursInput.trim() ? parseInt(hoursInput.trim(), 10) : null;
  const { data, error } = await sb.rpc('create_room_invite', { p_room_id: roomId, p_max_uses: maxUses, p_expires_in_hours: expiresHours });
  if(error){ toast('تعذر إنشاء اللينك: '+error.message, 'error'); return; }
  const invite = Array.isArray(data) ? data[0] : data;
  const link = `${window.location.origin}${window.location.pathname}?invite=${invite.code}`;
  await copyText(link);
  toast('تم إنشاء اللينك', 'success');
  loadRoomInvites(roomId);
}

async function loadRoomInvites(roomId){
  const { data: invites, error } = await sb.rpc('list_room_invites', { p_room_id: roomId });
  const el = document.getElementById('roomInvitesList');
  if(!el) return;
  if(error){ el.innerHTML = `<div class="empty-state" style="color:var(--red)">تعذر التحميل: ${escapeHtml(error.message)}</div>`; return; }
  if(!invites?.length){ el.innerHTML = `<div class="empty-state" style="padding:20px">لسه مفيش لينكات دعوة — أنشئ واحد</div>`; return; }
  el.innerHTML = invites.map((inv, i)=>{
    const link = `${window.location.origin}${window.location.pathname}?invite=${inv.code}`;
    const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
    const exhausted = inv.max_uses !== null && inv.uses_count >= inv.max_uses;
    const dead = !inv.is_active || expired || exhausted;
    return `<div class="invite-row ${dead?'revoked':''}" style="animation:fadeInUp 0.3s var(--ease-out) ${i * 0.04}s both">
      <div style="flex:1">
        <div class="code">${escapeHtml(link)}</div>
        <div class="meta">استُخدم ${inv.uses_count}${inv.max_uses!==null?` / ${inv.max_uses}`:''} مرة
          ${inv.expires_at?` · ينتهي ${new Date(inv.expires_at).toLocaleString('ar-EG')}`:''}
          ${!inv.is_active?' · ملغي':expired?' · منتهي':exhausted?' · وصل للحد الأقصى':' · فعّال'}
        </div>
      </div>
      <button class="btn btn-sm" onclick="copyInviteLink('${link}')">نسخ</button>
      ${inv.is_active ? `<button class="btn btn-sm" style="color:var(--red)" onclick="revokeInvite('${inv.id}','${roomId}')">إلغاء</button>` : ''}
    </div>`;
  }).join('');
}

async function copyInviteLink(link){
  await copyText(link);
}

async function revokeInvite(inviteId, roomId){
  if(!await customConfirm('تلغي لينك الدعوة ده؟ محدش هيقدر يدخل بيه تاني')) return;
  const { error } = await sb.rpc('revoke_room_invite', { p_invite_id: inviteId });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  loadRoomInvites(roomId);
}

async function loadRoomMembers(roomId){
  const { data: members, error } = await sb.rpc('list_room_members', { p_room_id: roomId });
  const el = document.getElementById('roomMembersList');
  if(!el) return;
  if(error){ el.innerHTML = `<div class="empty-state" style="color:var(--red)">تعذر التحميل: ${escapeHtml(error.message)}</div>`; return; }
  const { data: room } = await sb.from('chat_rooms').select('creator_id').eq('id', roomId).single();
  el.innerHTML = (members||[]).map((m, i)=>`
    <div class="member-row" style="animation:fadeInUp 0.3s var(--ease-out) ${i * 0.04}s both">
      <div class="avatar" id="memav-${m.user_id}" style="width:28px;height:28px;font-size:12px;cursor:pointer" onclick="viewProfile('${m.user_id}')">${(m.username||'?')[0].toUpperCase()}</div>
      <div class="name" style="cursor:pointer" onclick="viewProfile('${m.user_id}')">${escapeHtml(m.full_name||m.username||'مستخدم')} ${m.user_id===room?.creator_id?' <i class="fa-solid fa-crown"></i>':''}</div>
      ${m.user_id!==room?.creator_id ? `
        <button class="btn btn-sm" onclick="kickMember('${roomId}','${m.user_id}', false)">طرد</button>
        <button class="btn btn-sm" style="color:var(--red)" onclick="kickMember('${roomId}','${m.user_id}', true)">طرد + حظر</button>
      ` : ''}
    </div>`).join('');
  (members||[]).forEach(m=>{ if(m.avatar_file_id) loadAvatarInto(`memav-${m.user_id}`, m.avatar_file_id); });
}

async function kickMember(roomId, userId, ban){
  if(!await customConfirm(ban ? 'تطرد وتحظر العضو ده؟ مش هيقدر يدخل الغرفة تاني حتى بلينك جديد' : 'تطرد العضو ده من الغرفة؟', true)) return;
  const { error } = await sb.rpc('kick_room_member', { p_room_id: roomId, p_user_id: userId, p_ban: ban });
  if(error){ toast('خطأ: '+error.message, 'error'); return; }
  toast('تم', 'success');
  loadRoomMembers(roomId);
}

let replyingTo = null;
let currentRoomMessages = []; // الرسايل المحمّلة حاليًا للغرفة المفتوحة (بترتيب تصاعدي: الأقدم فالأحدث)
let roomHasMoreOlder = true; // هل لسه فيه رسايل أقدم نقدر نجيبها من السيرفر؟
let loadingOlderRoomMessages = false;

async function loadRoomMessages(roomId, lastReadAt){
  const conversationId = conversationIdFor('room', roomId);
  currentRoomMessages = [];
  roomHasMoreOlder = true;
  // اعرض الكاش المحلي فورًا (لو موجود) عشان الرسايل متختفيش وقت التنقل بين الغرف
  const cached = await getCachedMessages(conversationId);
  if(cached.length){
    renderMessages(cached.map(fromCachedMessage), null);
  }
  // نجيب آخر 100 رسالة (الأحدث) مش أول 100 — عشان الغرف اللي فيها رسايل كتير توصل لآخر رسالة فعليًا
  const { data: msgsDesc } = await sb.from('chat_messages').select('*, profiles!sender_id(username, avatar_file_id), reply:reply_to_id(id, sender_id, content, profiles!sender_id(username))').eq('room_id', roomId).order('created_at', { ascending:false }).limit(100);
  const msgs = (msgsDesc||[]).slice().reverse(); // نرجعها للترتيب الطبيعي (الأقدم فالأحدث) للعرض
  currentRoomMessages = msgs;
  if((msgsDesc||[]).length < 100) roomHasMoreOlder = false;
  const firstUnreadId = findFirstUnreadMessageId(msgs, lastReadAt);
  renderMessages(msgs, firstUnreadId);
  cacheMessages(conversationId, msgs);
  refreshPinnedBanner(roomId);
  lastSeenRoomMsgAt[roomId] = msgs.length ? msgs[msgs.length-1].created_at : new Date(0).toISOString();
  sb.rpc('mark_room_read', { p_room_id: roomId }).then(()=>checkUnreadBadges());
  bindRoomInfiniteScroll();
}

/* ---- Drag & Drop لرفع الملفات في الشات ---- */
