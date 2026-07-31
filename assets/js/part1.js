
/* ================= CONFIG ================= */
const SUPABASE_URL = "https://ccshmpaejvwpsthbvsww.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjc2htcGFlanZ3cHN0aGJ2c3d3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0MDEwOTcsImV4cCI6MjA5OTk3NzA5N30.n_6bRGfV9dWGNrRxLQ-XkYOMWiVAAU8twPfTaEEOvxc";
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, storageKey: 'devverse-auth' }
});

let currentUser = null;
let currentProfile = null;
let categories = [];
let activeCategoryFilter = null;
let activeRoomId = null;
let activeRoomCreatorId = null;
let roomChannel = null;

/* ================= FILE CACHE (IndexedDB) — توفير البيانات ================= */
/*
  نظام كاش موحّد لكل الملفات (صور/فيديوهات/أفاتار) بيتخزن كـ Blob حقيقي في IndexedDB،
  بدل base64 في localStorage (اللي سعته محدودة جدًا ~5-10MB وبيكبّر حجم البيانات 33%).
  المميزات:
  - سعة كبيرة (مئات الميجابايت حسب الجهاز)
  - تخزين Blob مباشر بدون تحويل لـ base64 (أسرع وأخف)
  - حد أقصى للحجم الكلي مع حذف الأقدم استخدامًا (LRU) لما يمتلئ
  - يشتغل لكل أنواع الملفات: صور البوستات، الأفاتار، صور الشات، الجاليري
*/
const FILE_CACHE_DB_NAME = 'devverse-file-cache';
const FILE_CACHE_STORE = 'files';
const FILE_CACHE_MAX_BYTES = 150 * 1024 * 1024; // 150MB حد أقصى تقريبي
let fileCacheDbPromise = null;

function openFileCacheDb(){
  if(fileCacheDbPromise) return fileCacheDbPromise;
  fileCacheDbPromise = new Promise((resolve, reject)=>{
    if(!window.indexedDB){ resolve(null); return; }
    const req = indexedDB.open(FILE_CACHE_DB_NAME, 1);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains(FILE_CACHE_STORE)){
        const store = db.createObjectStore(FILE_CACHE_STORE, { keyPath:'fileId' });
        store.createIndex('lastUsed', 'lastUsed');
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>resolve(null); // لو IndexedDB اتمنع (خصوصية صارمة مثلاً)، نكمل من غير كاش بدل ما نكسر الموقع
  });
  return fileCacheDbPromise;
}

async function getCachedFileBlob(fileId){
  try{
    const db = await openFileCacheDb();
    if(!db) return null;
    return await new Promise((resolve)=>{
      const tx = db.transaction(FILE_CACHE_STORE, 'readwrite');
      const store = tx.objectStore(FILE_CACHE_STORE);
      const req = store.get(fileId);
      req.onsuccess = ()=>{
        const rec = req.result;
        if(!rec){ resolve(null); return; }
        rec.lastUsed = Date.now(); // نحدّث وقت الاستخدام عشان الـ LRU
        store.put(rec);
        resolve(rec.blob);
      };
      req.onerror = ()=>resolve(null);
    });
  }catch(e){ return null; }
}

async function setCachedFileBlob(fileId, blob){
  try{
    const db = await openFileCacheDb();
    if(!db || !blob) return;
    const tx = db.transaction(FILE_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(FILE_CACHE_STORE);
    store.put({ fileId, blob, size: blob.size||0, lastUsed: Date.now() });
    evictFileCacheIfNeeded(); // مش منتظرين النتيجة، بتحصل في الخلفية
  }catch(e){ /* الكاش تحسين وليس أساسي — أي خطأ هنا لازم يتجاهل بأمان */ }
}

async function evictFileCacheIfNeeded(){
  try{
    const db = await openFileCacheDb();
    if(!db) return;
    const tx = db.transaction(FILE_CACHE_STORE, 'readonly');
    const store = tx.objectStore(FILE_CACHE_STORE);
    const all = await new Promise((resolve)=>{
      const req = store.getAll();
      req.onsuccess = ()=>resolve(req.result||[]);
      req.onerror = ()=>resolve([]);
    });
    const totalSize = all.reduce((s,r)=>s+(r.size||0), 0);
    if(totalSize <= FILE_CACHE_MAX_BYTES) return;
    // نحذف الأقدم استخدامًا لحد ما نرجع تحت الحد
    all.sort((a,b)=>a.lastUsed - b.lastUsed);
    let toFree = totalSize - FILE_CACHE_MAX_BYTES;
    const delTx = db.transaction(FILE_CACHE_STORE, 'readwrite');
    const delStore = delTx.objectStore(FILE_CACHE_STORE);
    for(const rec of all){
      if(toFree <= 0) break;
      delStore.delete(rec.fileId);
      toFree -= (rec.size||0);
    }
  }catch(e){ /* غير حرج — نتجاهل أي فشل في التنظيف */ }
}

/*
  الدالة الرئيسية: بتجيب أي ملف (صورة/فيديو/أفاتار) من الكاش لو موجود،
  أو تحمّله من السيرفر وتخزّنه للمرة الجاية. بترجع object URL جاهز للاستخدام في src.
*/
async function getFileUrlCached(fileId){
  if(!fileId) return null;
  const cachedBlob = await getCachedFileBlob(fileId);
  if(cachedBlob) return URL.createObjectURL(cachedBlob);

  const { data:{ session } } = await sb.auth.getSession();
  if(!session) return null;
  try{
    const res = await fetch(`${SUPABASE_URL}/functions/v1/telegram-file-url`, {
      method:'POST',
      headers:{ 'Authorization': `Bearer ${session.access_token}`, 'apikey': SUPABASE_ANON_KEY, 'Content-Type':'application/json' },
      body: JSON.stringify({ file_id: fileId })
    });
    if(!res.ok) return null;
    const blob = await res.blob();
    setCachedFileBlob(fileId, blob); // تخزين بدون انتظار، عشان الصورة تتعرض فورًا
    return URL.createObjectURL(blob);
  }catch(e){ return null; }
}

/* توافق مع الكود القديم اللي كان بيستخدم localStorage — بترجع null دايمًا الآن،
   لأن الكاش بقى async بالكامل عبر IndexedDB (getFileUrlCached) */
function getCachedFile(fileId){ return null; }
function setCachedFile(fileId, dataUrl){ /* تم استبدالها بـ setCachedFileBlob — موجودة فقط لعدم كسر أي استدعاء قديم */ }
function blobToDataURL(blob){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* ================= ANIMATION INFRASTRUCTURE ================= */
// Animated counter for stat numbers
function animateCountUp(el, target, duration = 1200) {
  if (!el) return;
  const start = parseInt((el.textContent || '0').replace(/\D/g, '')) || 0;
  const end = parseInt(target) || 0;
  if (start === end) {
    el.textContent = end;
    return;
  }
  const startTime = performance.now();
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const value = Math.round(start + (end - start) * easeOut(progress));
    el.textContent = value;
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = end;
  }
  requestAnimationFrame(tick);
}

// Intersection observer — fires callbacks when elements enter viewport
const _io = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in-view');
      _io.unobserve(entry.target);
    }
  });
}, { threshold: 0.15, rootMargin: '0px 0px -50px 0px' });

function observeReveal(selector = '.reveal') {
  document.querySelectorAll(selector).forEach(el => {
    if (!el.classList.contains('in-view')) _io.observe(el);
  });
}

// Page transition helper
function transitionView(callback) {
  const container = document.getElementById('viewContainer');
  if (!container) { callback(); return; }
  // Skip transition on first load
  if (!container.children.length) {
    callback();
    requestAnimationFrame(() => {
      if (container.firstElementChild) container.firstElementChild.classList.add('view-entering');
    });
    return;
  }
  // Apply exit animation
  const current = container.firstElementChild;
  if (current) {
    current.classList.add('view-transitioning');
    setTimeout(() => {
      callback();
      requestAnimationFrame(() => {
        const next = container.firstElementChild;
        if (next) {
          next.classList.add('view-entering');
          // Auto-stagger direct children
          const staggerable = next.querySelectorAll('.post-card, .article-card, .room-card, .member-row, .invite-row, .feature-card, .step, .stat, .section-chip');
          if (staggerable.length > 1) {
            staggerable.forEach((el, i) => {
              el.style.animationDelay = (i * 0.05) + 's';
              el.style.animationName = 'fadeInUp';
              el.style.animationDuration = '0.4s';
              el.style.animationFillMode = 'both';
              el.style.animationTimingFunction = 'cubic-bezier(0.16, 1, 0.3, 1)';
            });
          }
          setTimeout(() => {
            if (next) {
              next.classList.remove('view-entering');
            }
          }, 350);
        }
      });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }, 160);
  } else {
    callback();
  }
}

// Button ripple effect
function attachRipples(root = document) {
  root.querySelectorAll('.btn, .icon-btn, .section-chip, .feature-card, .article-card, .room-card, .nav-item').forEach(el => {
    if (el.dataset.ripple) return;
    el.dataset.ripple = '1';
    el.addEventListener('mousedown', (e) => {
      const rect = el.getBoundingClientRect();
      const ripple = document.createElement('span');
      const size = Math.max(rect.width, rect.height);
      ripple.style.cssText = `
        position: absolute;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.15;
        pointer-events: none;
        width: ${size}px;
        height: ${size}px;
        left: ${e.clientX - rect.left - size/2}px;
        top: ${e.clientY - rect.top - size/2}px;
        transform: scale(0);
        animation: ripple 0.6s var(--ease) forwards;
        z-index: 0;
      `;
      // Make sure the parent has position: relative
      const cs = getComputedStyle(el);
      if (cs.position === 'static') el.style.position = 'relative';
      if (cs.overflow !== 'hidden') el.style.overflow = 'hidden';
      el.appendChild(ripple);
      setTimeout(() => ripple.remove(), 650);
    });
  });
}

// Nav scroll detection for landing nav
function attachNavScroll() {
  const nav = document.getElementById('landingNav');
  if (!nav) return;
  const handler = () => {
    if (window.scrollY > 30) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  };
  window.addEventListener('scroll', handler, { passive: true });
  handler();
}

// Reveal-on-scroll for landing page sections
function attachRevealOnScroll() {
  const landing = document.getElementById('landing');
  if (!landing) return;
  const sections = landing.querySelectorAll('section, .stat, .feature-card, .step, .section-chip');
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        entry.target.style.animation = 'fadeInUp 0.6s var(--ease-out) both';
        entry.target.style.animationDelay = (i * 0.05) + 's';
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });
  sections.forEach(s => obs.observe(s));
}

// Initialize landing page animations
document.addEventListener('DOMContentLoaded', () => {
  attachNavScroll();
  attachRevealOnScroll();
  attachRipples();
  initDraggableFab();
  // Re-attach ripples whenever new content is added
  const observer = new MutationObserver(() => attachRipples());
  observer.observe(document.body, { childList: true, subtree: true });
});

/* ================= DRAGGABLE AI FAB ================= */
function initDraggableFab() {
  const fab = document.getElementById('aiFab');
  if (!fab) return;

  const STORAGE_KEY = 'dv-ai-fab-pos';
  const EDGE_MARGIN = 16;
  const TOPBAR_HEIGHT = 70;
  const DRAG_THRESHOLD = 6; // px — below this counts as a click, not a drag

  // Restore saved position, otherwise use the default from CSS
  const applyPosition = (top, left) => {
    fab.style.top = top + 'px';
    fab.style.left = left + 'px';
    fab.style.right = 'auto';
  };

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const { top, left } = JSON.parse(saved);
      // Sanity check: make sure the saved position is still on-screen
      // (handles users who changed monitors / window sizes)
      const vw = window.innerWidth, vh = window.innerHeight;
      const fabW = fab.offsetWidth || 54, fabH = fab.offsetHeight || 54;
      const clampedTop = Math.max(TOPBAR_HEIGHT, Math.min(top, vh - fabH - EDGE_MARGIN));
      const clampedLeft = Math.max(EDGE_MARGIN, Math.min(left, vw - fabW - EDGE_MARGIN));
      applyPosition(clampedTop, clampedLeft);
    }
  } catch (e) { /* localStorage unavailable — keep the CSS default */ }

  // Clamp the position so the button always stays fully on-screen
  const clampToViewport = (top, left) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const fabW = fab.offsetWidth || 54, fabH = fab.offsetHeight || 54;
    const cTop = Math.max(TOPBAR_HEIGHT, Math.min(top, vh - fabH - EDGE_MARGIN));
    const cLeft = Math.max(EDGE_MARGIN, Math.min(left, vw - fabW - EDGE_MARGIN));
    return { top: cTop, left: cLeft };
  };

  // Snap to the nearest horizontal edge (left/right) and update the panel position
  const snapToEdge = () => {
    const rect = fab.getBoundingClientRect();
    const vw = window.innerWidth;
    const centerX = rect.left + rect.width / 2;
    const left = centerX < vw / 2 ? EDGE_MARGIN : vw - rect.width - EDGE_MARGIN;
    const { top } = clampToViewport(rect.top, left);
    fab.classList.add('snap-back');
    applyPosition(top, left);
    setTimeout(() => fab.classList.remove('snap-back'), 320);

    // Move the AI panel to follow the new fab position (only if the panel is open)
    syncPanelPosition();

    // Persist the new position
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ top, left })); } catch (e) {}
  };

  // The picker modal is centered on screen via CSS, so it doesn't need to
  // follow the fab's position the way the old single panel did.
  const syncPanelPosition = () => {};

  let dragState = null;

  const onPointerDown = (e) => {
    // Ignore right-clicks / middle-clicks
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    fab.setPointerCapture(e.pointerId);
    const rect = fab.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originTop: rect.top,
      originLeft: rect.left,
      moved: false,
    };
    // If the picker is open, close it on drag start so the user can drop the fab
    // in a new spot without it blocking the way
    const picker = document.getElementById('aiPickerOverlay');
    if (picker && picker.classList.contains('active')) picker.classList.remove('active');
  };

  const onPointerMove = (e) => {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    // Only start moving after we've passed the threshold — avoids jitter on a click
    if (!dragState.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      dragState.moved = true;
      fab.classList.add('dragging');
    }
    if (dragState.moved) {
      const newTop = dragState.originTop + dy;
      const newLeft = dragState.originLeft + dx;
      const { top, left } = clampToViewport(newTop, newLeft);
      applyPosition(top, left);
    }
  };

  const onPointerUp = (e) => {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    try { fab.releasePointerCapture(e.pointerId); } catch (err) {}
    const wasDragged = dragState.moved;
    dragState = null;
    if (wasDragged) {
      fab.classList.remove('dragging');
      snapToEdge();
    } else {
      // No movement — treat as a click and open the assistant picker
      toggleAiPicker();
    }
  };

  const onPointerCancel = (e) => {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    try { fab.releasePointerCapture(e.pointerId); } catch (err) {}
    if (dragState.moved) {
      fab.classList.remove('dragging');
      snapToEdge();
    }
    dragState = null;
  };

  // Suppress the browser's default click — we handle open/close via pointerup
  // ourselves (so that a real click is detected only when no drag happened).
  const swallowClick = (e) => {
    // We already toggled the panel in pointerup; nothing to do here.
    // But also stop the event from triggering anything else that might be listening.
    e.stopPropagation();
  };

  fab.addEventListener('pointerdown', onPointerDown);
  fab.addEventListener('pointermove', onPointerMove);
  fab.addEventListener('pointerup', onPointerUp);
  fab.addEventListener('pointercancel', onPointerCancel);
  fab.addEventListener('click', swallowClick);

  // Re-clamp on resize so the button doesn't end up off-screen if the user
  // shrinks the window after placing the fab.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const rect = fab.getBoundingClientRect();
      const { top, left } = clampToViewport(rect.top, rect.left);
      applyPosition(top, left);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ top, left })); } catch (e) {}
    }, 150);
  });
}



/* ================= CUSTOM PROMPT / CONFIRM MODAL ================= */
let _promptResolve = null;
let _promptIsConfirm = false;

function _showPromptModal({ message, defaultValue = '', isConfirm = false, danger = false }) {
  return new Promise(resolve => {
    _promptResolve = resolve;
    _promptIsConfirm = isConfirm;
    document.getElementById('promptModalTitle').textContent = message || '';
    const fieldWrap = document.getElementById('promptModalFieldWrap');
    const input = document.getElementById('promptModalInput');
    const icon = document.getElementById('promptModalIcon');
    const okBtn = document.getElementById('promptModalOk');
    if (isConfirm) {
      fieldWrap.style.display = 'none';
      icon.innerHTML = danger ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-circle-question"></i>';
      icon.style.background = danger ? 'rgba(232,93,93,.15)' : '';
      icon.style.color = danger ? 'var(--red)' : '';
      okBtn.textContent = danger ? 'تأكيد الحذف' : 'تأكيد';
      okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    } else {
      fieldWrap.style.display = 'block';
      input.value = defaultValue || '';
      icon.innerHTML = '<i class="fa-solid fa-pen"></i>';
      icon.style.background = '';
      icon.style.color = '';
      okBtn.textContent = 'تأكيد';
      okBtn.className = 'btn btn-primary';
    }
    document.getElementById('promptModalOverlay').classList.add('active');
    setTimeout(() => { if (!isConfirm) input.focus(); }, 50);
  });
}

function closePromptModal(confirmed) {
  document.getElementById('promptModalOverlay').classList.remove('active');
  const resolve = _promptResolve;
  _promptResolve = null;
  if (!resolve) return;
  if (_promptIsConfirm) {
    resolve(!!confirmed);
  } else {
    const input = document.getElementById('promptModalInput');
    resolve(confirmed ? input.value.trim() : null);
  }
}

function customPrompt(message, defaultValue = '') {
  return _showPromptModal({ message, defaultValue, isConfirm: false });
}

function customConfirm(message, danger = false) {
  return _showPromptModal({ message, isConfirm: true, danger });
}

/* ================= TOAST ================= */
const TOAST_ICONS = {
  success: 'fa-circle-check',
  error: 'fa-circle-exclamation',
  '': 'fa-circle-info',
};
function toast(msg, type=''){
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const iconClass = TOAST_ICONS[type] || TOAST_ICONS[''];
  el.innerHTML = `
    <span class="toast-ic"><i class="fa-solid ${iconClass}"></i></span>
    <span class="toast-msg"></span>
    <button class="toast-close" onclick="dismissToast(this.parentElement)"><i class="fa-solid fa-xmark"></i></button>
    <span class="toast-progress"></span>`;
  el.querySelector('.toast-msg').textContent = msg;
  wrap.appendChild(el);
  setTimeout(()=>dismissToast(el), 3500);
}
function dismissToast(el){
  if(!el || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  setTimeout(()=>el.remove(), 260);
}

/* ================= LANDING TERMINAL ANIMATION ================= */
const fakeLog = [
  {p:'~/devverse', c:'new_post --category ai', o:'✓ نُشر: "أفضل مكتبات NLP عربي 2026"'},
  {p:'~/devverse', c:'join --room cybersecurity', o:'✓ بانتظار موافقة الأدمن...'},
  {p:'~/devverse', c:'article publish', o:'✓ تم نشر: "مقدمة في Rust للمبتدئين"'},
  {p:'~/devverse', c:'follow @sara_dev', o:'✓ بدأت متابعة sara_dev'},
  {p:'~/devverse', c:'ai explain --file main.py', o:'✓ تم شرح الكود بواسطة المساعد الذكي'},
];
let logIdx = 0;
function typeTerminalLine(){
  const body = document.getElementById('terminalBody');
  if(!body) return;
  const entry = fakeLog[logIdx % fakeLog.length];
  const line = document.createElement('div');
  line.className = 'terminal-line';
  line.innerHTML = `<span class="prompt">$</span> <span class="path">${entry.p}</span> <span class="cmd">${entry.c}</span>`;
  const out = document.createElement('div');
  out.className = 'terminal-line out';
  out.textContent = entry.o;
  body.appendChild(line); body.appendChild(out);
  body.scrollTop = body.scrollHeight;
  if(body.children.length > 14){ body.removeChild(body.firstChild); body.removeChild(body.firstChild); }
  logIdx++;
}
setInterval(typeTerminalLine, 2600);
typeTerminalLine();

/* ================= AUTH MODAL ================= */
function openAuth(which){
  document.getElementById('authOverlay').classList.add('active');
  document.getElementById('loginForm').style.display = which==='login' ? 'block':'none';
  document.getElementById('signupForm').style.display = which==='signup' ? 'block':'none';
  document.getElementById('confirmForm').style.display = which==='confirm' ? 'block':'none';
  document.getElementById('magicForm').style.display = which==='magic' ? 'block':'none';
  if(which==='login') prefillRememberedEmail();
}
function closeAuth(){ document.getElementById('authOverlay').classList.remove('active'); }

let pendingConfirmEmail = null;
async function doSignup(){
  const username = document.getElementById('signupUsername').value.trim();
  const full_name = document.getElementById('signupFullname').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const errEl = document.getElementById('signupError');
  errEl.style.display='none';
  if(!username || !email || password.length < 6){
    errEl.textContent = 'من فضلك املأ كل الحقول (كلمة المرور 6 أحرف على الأقل)';
    errEl.style.display='block'; return;
  }
  const { data, error } = await sb.auth.signUp({
    email, password,
    options:{ data:{ username, full_name }, emailRedirectTo: window.location.origin + window.location.pathname }
  });
  if(error){ errEl.textContent = translateError(error.message); errEl.style.display='block'; return; }
  pendingConfirmEmail = email;
  document.getElementById('confirmSub').textContent = `بعتنالك لينك تأكيد على ${email} — افتح إيميلك ودوس عليه عشان تفعّل حسابك`;
  openAuth('confirm');
}

async function resendConfirmCode(){
  if(!pendingConfirmEmail){ toast('من فضلك سجّل حساب الأول', 'error'); return; }
  const { error } = await sb.auth.resend({ type: 'signup', email: pendingConfirmEmail, options:{ emailRedirectTo: window.location.origin + window.location.pathname } });
  if(error){ toast('تعذر إعادة الإرسال: '+error.message, 'error'); return; }
  toast('تم إرسال لينك جديد', 'success');
}

async function doLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const remember = document.getElementById('rememberEmailCheck').checked;
  const errEl = document.getElementById('loginError');
  errEl.style.display='none';
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if(error){ errEl.textContent = translateError(error.message); errEl.style.display='block'; return; }
  try{
    if(remember) localStorage.setItem('dv-remembered-email', email);
    else localStorage.removeItem('dv-remembered-email');
  }catch(e){ /* localStorage unavailable — not critical, skip silently */ }
  closeAuth();
  await initSession();
}

function prefillRememberedEmail(){
  try{
    const saved = localStorage.getItem('dv-remembered-email');
    if(saved){
      const emailInput = document.getElementById('loginEmail');
      if(emailInput) emailInput.value = saved;
      const checkbox = document.getElementById('rememberEmailCheck');
      if(checkbox) checkbox.checked = true;
    }
  }catch(e){ /* localStorage unavailable — skip silently */ }
}

async function doGoogleAuth(){
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
  if(error){ toast('تعذر بدء الدخول بجوجل: '+error.message, 'error'); }
}

async function doGithubAuth(){
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: window.location.href }
  });
  if(error){ toast('تعذر بدء الدخول بـ GitHub: '+error.message, 'error'); }
}

async function doMagicLink(){
  const email = document.getElementById('magicEmail').value.trim();
  const username = document.getElementById('magicUsername').value.trim();
  const errEl = document.getElementById('magicError');
  errEl.style.display='none';
  if(!email){ errEl.textContent = 'من فضلك اكتب إيميلك'; errEl.style.display='block'; return; }
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
      data: username ? { username } : undefined
    }
  });
  if(error){ errEl.textContent = translateError(error.message); errEl.style.display='block'; return; }
  toast('بعتنالك لينك الدخول على إيميلك، افتحه ودوس عليه', 'success');
}

async function doLogout(){
  await sb.auth.signOut();
  currentUser = null; currentProfile = null;
  if(unreadBadgesInterval){ clearInterval(unreadBadgesInterval); unreadBadgesInterval = null; }
  if(roomsListChannel){ sb.removeChannel(roomsListChannel); roomsListChannel = null; }
  if(roomChannel){ sb.removeChannel(roomChannel); roomChannel = null; }
  if(dmChannel){ sb.removeChannel(dmChannel); dmChannel = null; }
  if(notificationsChannel){ sb.removeChannel(notificationsChannel); notificationsChannel = null; }
  activeRoomId = null;
  myRoomStatusSnapshot = {};
  document.getElementById('app').classList.remove('active');
  document.getElementById('landing').style.display = 'flex';
}

function translateError(msg){
  if(msg.includes('banned') || msg.includes('user_banned')) return 'حسابك محظور من المنصة، تواصل مع الإدارة لو فيه استفسار';
  if(msg.includes('Invalid login')) return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
  if(msg.includes('already registered')) return 'البريد الإلكتروني مستخدم بالفعل';
  if(msg.includes('Password')) return 'كلمة المرور ضعيفة جدًا';
  return msg;
}

/* ================= SESSION / PROFILE ================= */
async function initSession(){
  const { data:{ session } } = await sb.auth.getSession();
  if(!session){ return; }
  currentUser = session.user;
  const { data: profile, error } = await sb.from('profiles').select('*').eq('id', currentUser.id).single();
  if(error || !profile){ toast('تعذر تحميل الملف الشخصي', 'error'); return; }
  if(profile.is_banned){
    await sb.auth.signOut();
    currentUser = null; currentProfile = null;
    toast('حسابك محظور من المنصة، تواصل مع الإدارة لو فيه استفسار', 'error');
    return;
  }
  currentProfile = profile;
  document.getElementById('landing').style.display = 'none';
  document.getElementById('app').classList.add('active');
  document.getElementById('miniName').textContent = profile.full_name || profile.username;
  document.getElementById('miniRole').textContent = profile.role;
  document.getElementById('miniAvatar').textContent = (profile.username||'?')[0].toUpperCase();
  if(profile.avatar_file_id) loadAvatarInto('miniAvatar', profile.avatar_file_id);
  if(['owner','super_admin','admin','moderator'].includes(profile.role)){
    document.getElementById('adminNavItem').style.display = 'flex';
    document.getElementById('adminNavItemMobile').style.display = 'block';
  }
  await loadCategories();
  if(!checkUrlPostHash()) nav('feed');
  checkNotifications();
  subscribeToNotifications();
  if(['owner','super_admin','admin','moderator'].includes(profile.role)) checkAdminBadge();
  checkUnreadBadges();
  if(unreadBadgesInterval) clearInterval(unreadBadgesInterval);
  unreadBadgesInterval = setInterval(checkUnreadBadges, 20000);
  startVoiceBubblePolling();
  checkUrlInviteOnLoad();
  checkUrlMeetingOnLoad();
  checkUrlLiveOnLoad();
  checkUrlDeepLink();
  setupPushNotifications();
  subscribeToRoomsList();
}

async function checkUrlDeepLink(){
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  const dmUserId = params.get('dm');
  if(roomId){
    const { data: room } = await sb.from('chat_rooms').select('name').eq('id', roomId).single();
    if(room){ openRoomChat(roomId, room.name); }
    const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.replaceState({}, '', url.toString());
  } else if(dmUserId){
    const { data: p } = await sb.from('profiles').select('username').eq('id', dmUserId).single();
    if(p){ openDmConversation(dmUserId, p.username); }
    const url = new URL(window.location.href); url.searchParams.delete('dm'); window.history.replaceState({}, '', url.toString());
  }
}

let unreadBadgesInterval = null;

async function checkUnreadBadges(){
  const [{data:roomCount}, {data:dmCount}, {count:mentionCount}] = await Promise.all([
    sb.rpc('get_unread_room_count'),
    sb.rpc('get_unread_dm_count'),
    sb.from('notifications').select('id', {count:'exact', head:true}).eq('user_id', currentUser.id).eq('type','mention').eq('is_read', false),
  ]);
  const rc = roomCount || 0;
  const dc = dmCount || 0;
  const mc = mentionCount || 0;
  for(const id of ['roomsBadge','roomsBadgeMobile']){
    const el = document.getElementById(id);
    if(!el) continue;
    if(rc > 0){ el.style.display='inline-block'; el.textContent = rc; }
    else{ el.style.display='none'; }
  }
  for(const id of ['dmBadge','dmBadgeMobile']){
    const el = document.getElementById(id);
    if(!el) continue;
    if(dc > 0){ el.style.display='inline-block'; el.textContent = dc; }
    else{ el.style.display='none'; }
  }
  for(const id of ['roomsMentionDot','roomsMentionDotMobile']){
    const el = document.getElementById(id);
    if(!el) continue;
    el.style.display = mc > 0 ? 'inline-block' : 'none';
  }
}

async function checkAdminBadge(){
  const [{count:pendingRooms}, {count:pendingReports}] = await Promise.all([
    sb.from('chat_rooms').select('id', {count:'exact', head:true}).eq('status','pending'),
    sb.from('reports').select('*', {count:'exact', head:true}).eq('status','pending'),
  ]);
  const total = (pendingRooms||0) + (pendingReports||0);
  const badge = document.getElementById('adminBadge');
  if(total > 0){ badge.style.display='inline-block'; badge.textContent = total; }
  else{ badge.style.display='none'; }
  const moreDot = document.getElementById('moreDot');
  if(moreDot) moreDot.style.display = total > 0 ? 'block' : 'none';
}

function toggleMoreSheet(){
  document.getElementById('moreSheetOverlay').classList.toggle('active');
}

/* ================= CATEGORIES ================= */
async function loadCategories(){
  const { data, error } = await sb.from('categories').select('*').order('sort_order');
  if(error) return;
  categories = data;
  const sideEl = document.getElementById('sidebarCategories');
  sideEl.innerHTML = categories.map(c=>`<div class="nav-item" onclick="filterByCategory('${c.id}')">${c.name_ar}</div>`).join('');
  const mobileEl = document.getElementById('mobileCategories');
  if(mobileEl) mobileEl.innerHTML = categories.map(c=>`<div class="nav-item" onclick="toggleMoreSheet(); filterByCategory('${c.id}')">${c.name_ar}</div>`).join('');
  const gridEl = document.getElementById('sectionGrid');
  if(gridEl) gridEl.innerHTML = categories.map(c=>`<div class="section-chip">${c.name_ar}</div>`).join('');
  loadLandingStats();
}

async function loadLandingStats(){
  const [{count:u}, {count:p}, {count:a}, {count:r}] = await Promise.all([
    sb.from('profiles').select('*', {count:'exact', head:true}),
    sb.from('posts').select('*', {count:'exact', head:true}),
    sb.from('articles').select('*', {count:'exact', head:true}).eq('is_draft', false),
    sb.from('chat_rooms').select('id', {count:'exact', head:true}).eq('status','approved'),
  ]);
  // Animate count up
  animateCountUp(document.getElementById('statUsers'), u || 0);
  animateCountUp(document.getElementById('statPosts'), p || 0);
  animateCountUp(document.getElementById('statArticles'), a || 0);
  animateCountUp(document.getElementById('statRooms'), r || 0);
}

function filterByCategory(catId){
  activeCategoryFilter = catId;
  nav('feed');
}

/* ================= NAV / ROUTER ================= */
let viewedProfileId = null;
function nav(view){
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const navEl = document.querySelectorAll(`.nav-item[data-view="${view}"]`);
  navEl.forEach(n=>n.classList.add('active'));
  
  // Haptic feedback effect
  const activeIslandItem = document.querySelector(`.island-item[data-view="${view}"]`);
  if(activeIslandItem) {
    activeIslandItem.style.transform = 'scale(0.95)';
    setTimeout(() => activeIslandItem.style.transform = '', 150);
  }
  const c = document.getElementById('viewContainer');
  if(view!=='rooms' && roomChannel){ sb.removeChannel(roomChannel); roomChannel = null; activeRoomId = null; }
  if(view!=='messages' && dmChannel){ sb.removeChannel(dmChannel); dmChannel = null; activeDmUserId = null; }
  if(view==='profile') viewedProfileId = null; // clicking the nav item always means "my own profile"

  // Use page transition for smooth view changes
  transitionView(() => {
    if(view==='feed') renderFeed(c);
    else if(view==='articles') renderArticles(c);
    else if(view==='rooms') renderRooms(c);
    else if(view==='profile') renderProfile(c, currentUser.id);
    else if(view==='ctrl-x9k2') renderAdmin(c);
    else if(view==='bookmarks') renderBookmarks(c);
    else if(view==='messages') renderMessagesList(c);
  });
}

function viewProfile(userId){
  if(!userId) return;
  viewedProfileId = userId;
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  transitionView(() => {
    renderProfile(document.getElementById('viewContainer'), userId);
  });
}

/* ================= FEED ================= */
async function renderFeed(container){
  container.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div>
          <h1>الرئيسية</h1>
          <div class="sub">${activeCategoryFilter ? 'قسم: ' + (categories.find(c=>c.id===activeCategoryFilter)?.name_ar||'') : 'أحدث المنشورات من كل الأقسام'}</div>
        </div>
        ${activeCategoryFilter ? '<button class="btn btn-sm" onclick="activeCategoryFilter=null;nav(\'feed\')">إلغاء الفلتر</button>' : ''}
      </div>
      <div class="composer">
        <textarea id="postContent" placeholder="شارك حاجة مع المجتمع... (بوست، سؤال، كود)"></textarea>
        <input type="text" id="postTags" placeholder="وسوم مفصولة بفاصلة (اختياري) مثال: react, ai" style="width:100%; background:transparent; border:none; border-top:1px dashed var(--border); color:var(--ink-dim); font-size:12px; padding:8px 0 0; margin-top:8px; font-family:var(--font-mono)">
        <div class="composer-bar">
          <select class="chip-select" id="postCategory">
            <option value="">بدون قسم</option>
            ${categories.map(c=>`<option value="${c.id}">${c.name_ar}</option>`).join('')}
          </select>
          <select class="chip-select" id="postType">
            <option value="text">نص</option>
            <option value="code">كود</option>
            <option value="poll">استطلاع رأي</option>
          </select>
          <label class="file-label"><i class="fa-solid fa-paperclip"></i> صورة/فيديو<input type="file" id="postFile" accept="image/*,video/*" style="display:none" onchange="handlePostFileChosen(this)"></label>
          <span id="postFileLabel" style="font-size:12px;color:var(--teal)"></span>
          <button class="btn btn-ghost btn-sm" onclick="toast('ميزة البث المباشر ستكون متاحة قريبًا 🎬', 'success')"><i class="fa-solid fa-tower-broadcast" style="color:var(--ink-faint)"></i> لايف</button>
          <button class="btn btn-primary btn-sm" style="margin-right:auto" onclick="submitPost()">نشر</button>
        </div>
      </div>
      <div id="activeLivesRow"></div>
      ${activeTagFilter ? `<div style="margin-bottom:14px;font-size:13px;color:var(--ink-dim)">وسم: <b style="color:var(--accent)">#${escapeHtml(activeTagFilter)}</b> <a style="color:var(--red);cursor:pointer" onclick="activeTagFilter=null;nav('feed')">إلغاء</a></div>` : ''}
      <div id="postsList"><div class="empty-state"><div class="spinner"></div><div style="margin-top:12px">جاري التحميل...</div></div></div>
    </div>`;
  loadPosts();
  // loadActiveLivesRow(); // مُعطَّل مؤقتًا - ميزة اللايف قيد التطوير
}
async function renderSinglePost(container, postId){
  container.innerHTML = `
    <div class="view">
      <div class="view-header">
        <div><h1>منشور</h1><div class="sub">بتشوف منشور واحد بس من لينك المشاركة</div></div>
        <button class="btn btn-sm" onclick="clearSinglePostView()">← رجوع لكل المنشورات</button>
      </div>
      <div id="postsList"><div class="empty-state"><div class="spinner"></div></div></div>
    </div>`;
  loadPosts(postId);
}

function clearSinglePostView(){
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState({}, '', url.toString());
  nav('feed');
}

let activeTagFilter = null;

function checkUrlPostHash(){
  const match = window.location.hash.match(/^#post-(.+)$/);
  if(match){
    const c = document.getElementById('viewContainer');
    renderSinglePost(c, match[1]);
    return true;
  }
  return false;
}
function filterByTag(tag){ activeTagFilter = tag; activeCategoryFilter = null; nav('feed'); }

let pendingPostFile = null;
function handlePostFileChosen(input){
  pendingPostFile = input.files[0] || null;
  document.getElementById('postFileLabel').textContent = pendingPostFile ? pendingPostFile.name : '';
}

function showUploadProgress(file){
  document.getElementById('uploadFileName').textContent = file.name;
  document.getElementById('uploadProgressFill').style.width = '0%';
  document.getElementById('uploadProgressPct').textContent = '0%';
  document.getElementById('uploadProgressStatus').textContent = 'جاري الرفع...';
  document.getElementById('uploadOverlay').classList.add('active');
}
function updateUploadProgress(pct){
  document.getElementById('uploadProgressFill').style.width = pct + '%';
  document.getElementById('uploadProgressPct').textContent = pct + '%';
  if(pct >= 100) document.getElementById('uploadProgressStatus').textContent = 'جاري المعالجة...';
}
function hideUploadProgress(){
  document.getElementById('uploadOverlay').classList.remove('active');
}

/*
  ضغط الصور تلقائيًا قبل الرفع — جزء من نظام توفير البيانات.
  بيصغّر أبعاد الصورة لحد أقصى معقول (1600px أطول ضلع) ويعيد ترميزها بجودة JPEG 82%،
  فبيقلل حجم الملف بشكل كبير (خصوصًا صور الكاميرا اللي بتبقى 4-12 ميجابايت) من غير
  فرق محسوس في الجودة على شاشة أو حتى طباعة عادية.
  - بيتخطى الصور الصغيرة أصلًا (أقل من MAX_DIMENSION وأقل من حجم معين) عشان منضيعش وقت
  - بيتخطى GIF عشان الضغط بيكسر الحركة (Canvas بيدي فريم واحد بس)
  - أي فشل في الضغط (متصفح قديم، ملف تالف) بيرجع الملف الأصلي زي ما هو بدل ما يوقف الرفع
*/
const IMAGE_COMPRESS_MAX_DIMENSION = 1600;
const IMAGE_COMPRESS_QUALITY = 0.82;
const IMAGE_COMPRESS_MIN_SIZE_BYTES = 300 * 1024; // أقل من 300KB مش مستاهل نضغطها

async function compressImageIfNeeded(file){
  if(!file || !file.type?.startsWith('image/')) return file;
  if(file.type === 'image/gif') return file; // الضغط بيوقف الحركة
  if(file.size < IMAGE_COMPRESS_MIN_SIZE_BYTES) return file; // صغيرة أصلًا، مش مستاهلة

  try{
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    if(width <= IMAGE_COMPRESS_MAX_DIMENSION && height <= IMAGE_COMPRESS_MAX_DIMENSION && file.size < 1.5*1024*1024){
      bitmap.close?.();
      return file; // الأبعاد والحجم معقولين أصلًا
    }
    const scale = Math.min(1, IMAGE_COMPRESS_MAX_DIMENSION / Math.max(width, height));
    const targetW = Math.round(width * scale);
    const targetH = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();

    const blob = await new Promise(resolve=>{
      canvas.toBlob(resolve, 'image/jpeg', IMAGE_COMPRESS_QUALITY);
    });
    if(!blob || blob.size >= file.size) return file; // لو الضغط ماوفّرش حاجة فعليًا، نسيب الأصلي

    const newName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], newName, { type:'image/jpeg', lastModified: Date.now() });
  }catch(e){
    console.warn('image compression failed, uploading original:', e.message);
    return file; // أي فشل: نرفع الملف الأصلي بدل ما نوقف المستخدم
  }
}

async function uploadToTelegram(file, kind, context){
  if(kind === 'photo'){
    file = await compressImageIfNeeded(file);
  }
  const form = new FormData();
  form.append('file', file);
  form.append('kind', kind);
  if(context?.type){
    form.append('context_type', context.type);
    if(context.roomId) form.append('context_room_id', context.roomId);
    if(context.otherUserId) form.append('context_other_user_id', context.otherUserId);
  }
  const { data:{ session } } = await sb.auth.getSession();
  showUploadProgress(file);
  try{
    const data = await new Promise((resolve, reject)=>{
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${SUPABASE_URL}/functions/v1/telegram-upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
      xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
      xhr.upload.onprogress = (e)=>{
        if(e.lengthComputable){
          const pct = Math.round((e.loaded / e.total) * 100);
          updateUploadProgress(pct);
        }
      };
      xhr.onload = ()=>{
        let parsed;
        try{ parsed = JSON.parse(xhr.responseText); }catch(e){ parsed = null; }
        if(xhr.status >= 200 && xhr.status < 300 && parsed){ resolve(parsed); }
        else{ reject(new Error(parsed?.error || 'فشل رفع الملف')); }
      };
      xhr.onerror = ()=> reject(new Error('فشل رفع الملف — تأكد من اتصال الإنترنت'));
      xhr.send(form);
    });
    return data;
  } finally {
    hideUploadProgress();
  }
}

async function getTelegramFileBlobUrl(file_id){
  return await getFileUrlCached(file_id);
}

/*
  ملاحظة مهمة: كانت الدالة دي بترجع URL فيه access_token الحالي كـ query param.
  المشكلة إن Supabase بيجدد الـ access_token تلقائيًا كل ساعة، فنفس الملف كان بياخد
  URL مختلف بعد كل تجديد، وده كان يلغي أي كاش HTTP من المتصفح تمامًا حتى لو نفس الصورة
  اتعرضت قبل كده. دلوقتي بنستخدم نفس نظام getFileUrlCached (IndexedDB) بدل الاعتماد
  على كاش المتصفح، فالملف بيتحمّل مرة واحدة بس بغض النظر عن تجديد الجلسة.
*/
async function getTelegramStreamUrl(file_id){
  return await getFileUrlCached(file_id);
}

async function submitPost(){
  const content = document.getElementById('postContent').value.trim();
  const category_id = document.getElementById('postCategory').value || null;
  const post_type = document.getElementById('postType').value;
  const tagsRaw = document.getElementById('postTags').value.trim();
  const tags = tagsRaw ? tagsRaw.split(',').map(t=>t.trim().replace(/^#/,'')).filter(Boolean) : [];

  if(post_type === 'poll'){
    const question = document.getElementById('postContent').value.trim() || await customPrompt('سؤال الاستطلاع:');
    if(!question){ toast('اكتب سؤال الاستطلاع', 'error'); return; }
    const options = [];
    for(let i=1; i<=6; i++){
      const opt = await customPrompt(`اختيار رقم ${i} (اسيبه فاضي عشان توقف):`);
      if(!opt) break;
      options.push(opt.trim());
    }
    if(options.length < 2){ toast('لازم اختيارين على الأقل', 'error'); return; }
    try{
      const { data: post, error: postErr } = await sb.from('posts').insert({ author_id: currentUser.id, category_id, content: question, post_type:'poll', tags }).select().single();
      if(postErr) throw postErr;
      const { data: poll, error: pollErr } = await sb.from('polls').insert({ post_id: post.id, question }).select().single();
      if(pollErr) throw pollErr;
      const { error: optErr } = await sb.from('poll_options').insert(options.map((option_text, i)=>({ poll_id: poll.id, option_text, sort_order:i })));
      if(optErr) throw optErr;
      toast('تم نشر الاستطلاع', 'success');
      awardXp(XP_RULES.post, 'نشر استطلاع');
      document.getElementById('postContent').value=''; document.getElementById('postTags').value='';
      loadPosts();
    }catch(e){ toast('خطأ: '+e.message, 'error'); }
    return;
  }

  if(!content && !pendingPostFile){ toast('اكتب حاجة الأول', 'error'); return; }

  let telegram_file_id = null;
  let telegram_message_id = null;
  let finalType = post_type;
  try{
    if(pendingPostFile){
      const kind = pendingPostFile.type.startsWith('video') ? 'video' : 'photo';
      const up = await uploadToTelegram(pendingPostFile, kind, { type:'post' });
      telegram_file_id = up.file_id;
      telegram_message_id = up.telegram_message_id || null;
      finalType = kind === 'video' ? 'video' : 'image';
    }
    const { error } = await sb.from('posts').insert({
      author_id: currentUser.id, category_id, content,
      post_type: finalType, telegram_file_id, telegram_message_id, tags,
      code_language: post_type==='code' ? 'auto' : null
    });
    if(error) throw error;
    toast('تم النشر بنجاح', 'success');
    awardXp(XP_RULES.post, 'نشر منشور');
    document.getElementById('postContent').value='';
    document.getElementById('postTags').value='';
    pendingPostFile = null;
    document.getElementById('postFileLabel').textContent='';
    loadPosts();
  }catch(e){ toast('خطأ: '+e.message, 'error'); }
}

let postsCurrentOffset = 0;
const POSTS_PAGE_SIZE = 15;
let postsHasMore = true;
let postsLoadingMore = false;

async function loadPosts(singlePostId){
  postsCurrentOffset = 0;
  postsHasMore = true;
  await loadPostsPage(singlePostId, true);
}

async function loadMorePosts(){
  if(postsLoadingMore || !postsHasMore) return;
  await loadPostsPage(null, false);
}

async function loadPostsPage(singlePostId, isFirstPage){
  postsLoadingMore = true;
  const listEl = document.getElementById('postsList');
  const rangeFrom = postsCurrentOffset;
  const rangeTo = postsCurrentOffset + POSTS_PAGE_SIZE - 1;

  let q = sb.from('posts').select('*, profiles!posts_author_id_fkey(username, full_name, role, avatar_file_id), categories(name_ar), repost:repost_of(id, content, post_type, telegram_file_id, created_at, profiles!posts_author_id_fkey(username, full_name))').eq('is_removed', false).order('is_pinned', {ascending:false}).order('created_at', {ascending:false}).range(rangeFrom, rangeTo);
  if(singlePostId) q = sb.from('posts').select('*, profiles!posts_author_id_fkey(username, full_name, role, avatar_file_id), categories(name_ar), repost:repost_of(id, content, post_type, telegram_file_id, created_at, profiles!posts_author_id_fkey(username, full_name))').eq('is_removed', false).eq('id', singlePostId);
  else if(activeCategoryFilter) q = q.eq('category_id', activeCategoryFilter);
  else if(activeTagFilter) q = q.contains('tags', [activeTagFilter]);
  const { data: posts, error } = await q;
  postsLoadingMore = false;

  if(error){
    if(isFirstPage) listEl.innerHTML = `<div class="empty-state">تعذر تحميل المنشورات: ${escapeHtml(error.message)}</div>`;
    return;
  }
  if(!posts.length){
    postsHasMore = false;
    document.getElementById('loadMorePostsBtn')?.remove();
    if(isFirstPage){
      listEl.innerHTML = singlePostId
        ? `<div class="empty-state"><div class="icon"><i class="fa-solid fa-triangle-exclamation"></i></div>المنشور ده مش موجود، أو اتحذف</div>`
        : `<div class="empty-state"><div class="icon"><i class="fa-solid fa-inbox"></i></div>لسه مفيش منشورات — كن أول من ينشر!</div>`;
    }
    return;
  }
  if(posts.length < POSTS_PAGE_SIZE) postsHasMore = false;
  postsCurrentOffset += posts.length;

  const postIds = posts.map(p=>p.id);
  // نداء واحد لكل عدادات اللايك/الكومنت بدل نداء منفصل لكل بوست (كان بيعمل ضعف عدد البوستات من الـ requests)
  const [{ data: likes }, { data: bookmarksData }, { data: counts }] = await Promise.all([
    sb.from('post_likes').select('post_id').eq('user_id', currentUser.id).in('post_id', postIds),
    sb.from('bookmarks').select('target_id').eq('user_id', currentUser.id).eq('target_type','post').in('target_id', postIds),
    sb.rpc('get_posts_counts', { p_post_ids: postIds }),
  ]);
  const likedSet = new Set((likes||[]).map(l=>l.post_id));
  const bookmarkedSet = new Set((bookmarksData||[]).map(b=>b.target_id));
  const countsMap = new Map((counts||[]).map(c=>[c.post_id, c]));

  if(isFirstPage) listEl.innerHTML = '';
  document.getElementById('loadMorePostsBtn')?.remove();

  posts.forEach((p, idx) => {
    const el = document.createElement('div');
    el.className = 'post-card';
    el.style.animationDelay = (idx * 0.05) + 's';
    const author = p.profiles?.full_name || p.profiles?.username || 'مستخدم';
    const initials = (p.profiles?.username||'?')[0].toUpperCase();
    const tagsHtml = (p.tags&&p.tags.length) ? `<div style="margin-bottom:10px">${p.tags.map(t=>`<span class="tag" style="cursor:pointer" onclick="filterByTag('${t}')">#${escapeHtml(t)}</span>`).join('')}</div>` : '';
    const repostHtml = p.repost ? `
      <div style="border:1px solid var(--border); border-radius:10px; padding:12px; margin-bottom:12px; background:var(--surface)">
        <div style="font-size:12px; color:var(--ink-faint); margin-bottom:6px">@${p.repost.profiles?.username||''} · ${timeAgo(p.repost.created_at)}</div>
        <div style="font-size:13.5px">${escapeHtml(p.repost.content||'')}</div>
        ${p.repost.telegram_file_id ? `<div class="post-file" id="file-${p.repost.id}-in-${p.id}" data-lazy-file="${p.repost.id}-in-${p.id}" data-lazy-type="${p.repost.post_type}" data-lazy-fileid="${escapeHtml(p.repost.telegram_file_id)}" style="margin-top:8px"><div style="padding:16px;text-align:center;color:var(--ink-faint);font-size:12px"><i class="fa-solid fa-paperclip"></i> هيتحمّل لما توصله</div></div>` : ''}
      </div>` : '';
    const canManage = p.author_id===currentUser.id || ['owner','super_admin','admin','moderator'].includes(currentProfile.role);
    const pCounts = countsMap.get(p.id);
    const likeCount = pCounts ? Number(pCounts.like_count) : 0;
    const commentCount = pCounts ? Number(pCounts.comment_count) : 0;
    el.innerHTML = `
      <div class="post-head">
        <div class="avatar" style="width:32px;height:32px;font-size:12px;cursor:pointer" onclick="viewProfile('${p.author_id}')" id="avatar-post-${p.id}">${initials}</div>
        <div style="cursor:pointer" onclick="viewProfile('${p.author_id}')"><div class="name">${author}</div><div class="meta">@${p.profiles?.username||''} · ${timeAgo(p.created_at)}</div></div>
        ${p.is_pinned ? `<div class="post-cat" style="color:var(--accent)"><i class="fa-solid fa-thumbtack"></i> مثبت</div>` : ''}
        ${p.categories ? `<div class="post-cat">${p.categories.name_ar}</div>` : ''}
      </div>
      ${p.repost_of ? '<div style="font-size:12px;color:var(--ink-faint);margin-bottom:8px"><i class="fa-solid fa-retweet"></i> أعاد نشر منشور</div>' : ''}
      ${repostHtml}
      ${p.content ? `<div class="post-content no-select ${p.post_type==='code'?'code':''}">${p.post_type==='code'?escapeHtml(p.content||''):linkifyText(escapeHtml(p.content||''))}</div>` : ''}
      ${tagsHtml}
      ${p.post_type==='poll' ? `<div id="poll-${p.id}"><div class="empty-state" style="padding:16px"><div class="spinner"></div></div></div>` : ''}
      ${p.telegram_file_id ? `<div class="post-file" id="file-${p.id}" data-lazy-file="${p.id}" data-lazy-type="${p.post_type}" data-lazy-fileid="${escapeHtml(p.telegram_file_id)}"><div style="padding:20px;text-align:center;color:var(--ink-faint);font-size:12px"><i class="fa-solid fa-paperclip"></i> هيتحمّل لما توصله</div></div>` : ''}
      <div class="post-actions">
        <div class="act ${likedSet.has(p.id)?'liked':''}" onclick="toggleLike('${p.id}', this)"><i class="fa-solid fa-heart"></i> <span id="likecount-${p.id}">${likeCount||''}</span></div>
        <div class="act" onclick="toggleComments('${p.id}')"><i class="fa-solid fa-comment-dots"></i> تعليق <span id="commentcount-${p.id}">${commentCount>0?commentCount:''}</span></div>
        <div class="act ${bookmarkedSet.has(p.id)?'liked':''}" onclick="toggleBookmark('${p.id}', this)"><i class="fa-solid fa-bookmark"></i> حفظ</div>
        <div class="act" onclick="repostPost('${p.id}')"><i class="fa-solid fa-retweet"></i> إعادة نشر</div>
        <div class="act" onclick="sharePost('${p.id}')"><i class="fa-solid fa-share-nodes"></i> مشاركة</div>
        ${p.content ? `<div class="act copy-btn" data-copy-text="${escapeHtml(p.content)}" onclick="copyTextFromDataAttr(this)"><i class="fa-solid fa-copy"></i> نسخ</div>` : ''}
        ${canManage ? `<div class="act ${p.is_pinned?'liked':''}" onclick="pinPost('${p.id}', ${!p.is_pinned})"><i class="fa-solid fa-thumbtack"></i> ${p.is_pinned?'إلغاء التثبيت':'تثبيت'}</div>` : ''}
        ${canManage ? `<div class="act" style="color:var(--red)" onclick="deletePost('${p.id}')"><i class="fa-solid fa-trash"></i> حذف</div>` : ''}
      </div>
      <div class="comments-box" id="comments-${p.id}"></div>`;
    listEl.appendChild(el);
    if(p.profiles?.avatar_file_id) loadAvatarInto(`avatar-post-${p.id}`, p.profiles.avatar_file_id);
    if(p.post_type==='poll') loadPollWidget(p.id);
  });

  if(postsHasMore && !singlePostId){
    const btnWrap = document.createElement('div');
    btnWrap.id = 'loadMorePostsBtn';
    btnWrap.style.textAlign = 'center';
    btnWrap.style.padding = '16px';
    btnWrap.innerHTML = `<button class="btn btn-sm" onclick="loadMorePosts()"><i class="fa-solid fa-arrow-down"></i> حمّل أكتر</button>`;
    listEl.appendChild(btnWrap);
  }
  observeLazyFiles();
}

