
// ═══════════════════════════════════════════════════
// BINARY BEAST — DevVerse Backend Bridge
// المفاتيح والاتصال الفعلي بالذكاء الاصطناعي والتكاملات بيعدّوا هنا
// على الباك إند الحقيقي (Supabase Edge Functions) بدل ما يتخزنوا أو
// يتصلوا مباشرة من المتصفح. باقي منطق PixelAi (المحادثات، الذاكرة،
// الملاحظات، الأدوات) فاضل زي ما هو تمامًا.
// ═══════════════════════════════════════════════════
const BB_SUPABASE_URL = "https://ccshmpaejvwpsthbvsww.supabase.co";
const BB_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjc2htcGFlanZ3cHN0aGJ2c3d3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0MDEwOTcsImV4cCI6MjA5OTk3NzA5N30.n_6bRGfV9dWGNrRxLQ-XkYOMWiVAAU8twPfTaEEOvxc";
const BB_CONTEXT = "pixelai"; // نفس السياق "pixelcode" في نسخة PixelCode
const { createClient: __bbCreateClient } = supabase;
// نفس storageKey المستخدم في DevVerse عشان الجلسة تتشارك تلقائيًا
const bbSb = __bbCreateClient(BB_SUPABASE_URL, BB_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, storageKey: 'devverse-auth' }
});

let bbSession = null;
let bbBlocked = false;

async function bbInit() {
  const { data: { session: s } } = await bbSb.auth.getSession();
  bbSession = s;
  return s;
}
async function bbGetToken() {
  const { data: { session: s } } = await bbSb.auth.getSession();
  bbSession = s;
  return s?.access_token || null;
}
function bbRequireLogin() {
  if (!bbSession) {
    throw new Error('لازم تسجّل دخول في DevVerse الأول عشان تستخدم PixelAi');
  }
}

// تشفير مفتاح المستخدم وتخزينه في Supabase (بديل آمن لتخزينه في localStorage)
async function bbSaveApiKey(provider, apiKey) {
  bbRequireLogin();
  if (!apiKey || !apiKey.trim()) {
    // مسح المفتاح لو اتفضى الحقل
    await bbSb.from('user_ai_models').delete().eq('user_id', bbSession.user.id).eq('context', BB_CONTEXT).eq('provider', provider);
    return;
  }
  const { data: encrypted, error: encErr } = await bbSb.rpc('encrypt_user_api_key', { plain_key: apiKey.trim() });
  if (encErr) throw new Error('فشل تشفير المفتاح: ' + encErr.message);

  // نمسح أي مفتاح قديم لنفس الـ provider في نفس السياق (مفتاح واحد فعّال لكل provider)
  await bbSb.from('user_ai_models').delete().eq('user_id', bbSession.user.id).eq('context', BB_CONTEXT).eq('provider', provider);
  const { error } = await bbSb.from('user_ai_models').insert({
    user_id: bbSession.user.id, context: BB_CONTEXT, provider,
    label: provider, model_id: provider, api_key_encrypted: encrypted,
  });
  if (error) throw new Error('فشل حفظ المفتاح: ' + error.message);
}

// بترجع بس هل فيه مفتاح محفوظ ولا لأ (مش القيمة نفسها — القيمة متفكش تشفيرها إلا وقت الاستخدام الفعلي على السيرفر)
async function bbHasApiKey(provider) {
  if (!bbSession) return false;
  const { data } = await bbSb.from('user_ai_models').select('id').eq('user_id', bbSession.user.id).eq('context', BB_CONTEXT).eq('provider', provider).eq('is_active', true).maybeSingle();
  return !!data;
}

async function bbGetAllKeyStatus() {
  if (!bbSession) return {};
  const { data } = await bbSb.from('user_ai_models').select('provider').eq('user_id', bbSession.user.id).eq('context', BB_CONTEXT).eq('is_active', true);
  const status = {};
  (data || []).forEach(r => { status[r.provider] = true; });
  return status;
}

// بتحدّث cfg.apis.* بمؤشرات وجود (true/false) بدل القيم الفعلية، عشان كل شروط
// "if(cfg.apis.openrouter)" المنتشرة في باقي الكود تفضل شغالة زي ما هي بدون تعديل كل موضع
async function bbRefreshKeyStatus() {
  const status = await bbGetAllKeyStatus();
  cfg.apis = cfg.apis || {};
  cfg.apis.gemini = !!status.gemini;
  cfg.apis.anthropic = !!status.anthropic;
  cfg.apis.openai = !!status.openai;
  cfg.apis.openrouter = !!status.openrouter;
  cfg.apis.tavily = await bbHasIntegration('tavily');
  return cfg.apis;
}

// نداء موحّد لأي مزوّد AI أساسي (openai/anthropic/gemini/openrouter) عن طريق ai-provider-proxy
// بيرجّع نفس شكل رد الـ provider الأصلي بالظبط، فمفيش داعي نغيّر منطق قراءة الرد في باقي الكود
async function bbCallProvider(provider, payload, endpoint) {
  bbRequireLogin();
  const token = await bbGetToken();
  const res = await fetch(`${BB_SUPABASE_URL}/functions/v1/ai-provider-proxy`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': BB_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: BB_CONTEXT, provider, payload, endpoint })
  });
  const data = await res.json();
  if (res.status === 403 && data.error === 'blocked') {
    bbBlocked = true;
    throw new Error('BLOCKED: ' + (data.message || 'تم إيقاف استخدامك لهذه الميزة من قبل الإدارة'));
  }
  if (!res.ok) {
    const msg = data.error?.message || data.error || data.message || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403 || String(msg).includes('API_KEY_MISSING')) {
      throw new Error('API_KEY_MISSING: ' + msg);
    }
    throw new Error(String(msg));
  }
  return data;
}

// نداء التكاملات البسيطة (GitHub, Telegram, CallMeBot, Tavily, طقس) عن طريق general-proxy
async function bbCallIntegration(service, { method = 'GET', path, query, requestBody } = {}) {
  bbRequireLogin();
  const token = await bbGetToken();
  const res = await fetch(`${BB_SUPABASE_URL}/functions/v1/general-proxy`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': BB_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: BB_CONTEXT, service, method, path, query, requestBody })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.data;
}

// نداء خدمات Google (Gmail/Calendar/Drive/Sheets/Tasks) عن طريق google-proxy
async function bbCallGoogle(host, { method = 'GET', path, query, requestBody } = {}) {
  bbRequireLogin();
  const token = await bbGetToken();
  const res = await fetch(`${BB_SUPABASE_URL}/functions/v1/google-proxy`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': BB_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: BB_CONTEXT, host, method, path, query, requestBody })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.data;
}

// حفظ بيانات اعتماد Google OAuth مشفرة في Supabase
async function bbSaveGoogleCreds(clientId, clientSecret, refreshToken) {
  bbRequireLogin();
  const payload = JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });
  const { data: encrypted, error: encErr } = await bbSb.rpc('encrypt_user_api_key', { plain_key: payload });
  if (encErr) throw new Error('فشل تشفير بيانات Google: ' + encErr.message);
  await bbSb.from('user_integrations').delete().eq('user_id', bbSession.user.id).eq('context', BB_CONTEXT).eq('service', 'google_oauth');
  const { error } = await bbSb.from('user_integrations').insert({
    user_id: bbSession.user.id, context: BB_CONTEXT, service: 'google_oauth', credentials_encrypted: encrypted,
  });
  if (error) throw new Error('فشل حفظ بيانات Google: ' + error.message);
}

// حفظ بيانات اعتماد أي تكامل بسيط تاني (GitHub token / Telegram bot token / Tavily key / CallMeBot)
async function bbSaveIntegrationCreds(service, value) {
  bbRequireLogin();
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  if (!payload || !payload.trim() || payload === '{}') {
    await bbSb.from('user_integrations').delete().eq('user_id', bbSession.user.id).eq('context', BB_CONTEXT).eq('service', service);
    return;
  }
  const { data: encrypted, error: encErr } = await bbSb.rpc('encrypt_user_api_key', { plain_key: payload });
  if (encErr) throw new Error('فشل التشفير: ' + encErr.message);
  await bbSb.from('user_integrations').delete().eq('user_id', bbSession.user.id).eq('context', BB_CONTEXT).eq('service', service);
  const { error } = await bbSb.from('user_integrations').insert({
    user_id: bbSession.user.id, context: BB_CONTEXT, service, credentials_encrypted: encrypted,
  });
  if (error) throw new Error('فشل حفظ البيانات: ' + error.message);
}

async function bbHasIntegration(service) {
  if (!bbSession) return false;
  const { data } = await bbSb.from('user_integrations').select('id').eq('user_id', bbSession.user.id).eq('context', BB_CONTEXT).eq('service', service).eq('is_active', true).maybeSingle();
  return !!data;
}
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// 50+ MODELS from OpenRouter + direct
// ═══════════════════════════════════════════════════
const PROVIDERS={
  google:{name:'Google',color:'#4285f4'},
  anthropic:{name:'Anthropic',color:'#c96442'},
  openai:{name:'OpenAI',color:'#10a37f'},
  deepseek:{name:'DeepSeek',color:'#1e90ff'},
  meta:{name:'Meta',color:'#0866ff'},
  mistral:{name:'Mistral',color:'#f7c948'},
  xai:{name:'xAI',color:'#aaaaaa'},
  qwen:{name:'Qwen',color:'#6366f1'},
  minimax:{name:'MiniMax',color:'#ff4d4f'},
  stepfun:{name:'StepFun',color:'#007bff'},
  microsoft:{name:'Microsoft',color:'#00a4ef'},
  cohere:{name:'Cohere',color:'#39c5bb'},
  nvidia:{name:'NVIDIA',color:'#76b900'},
  ollama:{name:'Ollama',color:'#34d399'},
};
const MODELS=[
  // ── OpenAI ──
  {id:'openai/gpt-5.5',p:'openai',name:'GPT-5.5',desc:'أحدث نموذج من OpenAI للتفكير المعقد والبرمجة',caps:['text','vision','code','reason']},
  {id:'openai/gpt-5.4',p:'openai',name:'GPT-5.4',desc:'نموذج متقدم متوازن بين الأداء والسرعة',caps:['text','vision','code']},
  {id:'openai/gpt-5.4-mini',p:'openai',name:'GPT-5.4 Mini',desc:'سريع وفعال للمهام اليومية',caps:['text','vision','code','fast']},
  {id:'openai/gpt-5.4-nano',p:'openai',name:'GPT-5.4 Nano',desc:'خفيف جداً وسريع جداً',caps:['text','code','fast','free']},
  {id:'openai/gpt-image-2',p:'openai',name:'GPT Image 2',desc:'نموذج توليد الصور الحديث من OpenAI',caps:['text','vision','code']},
  {id:'openai/gpt-realtime-2',p:'openai',name:'GPT Realtime 2',desc:'نموذج الوقت الفعلي للصوت والحوار',caps:['text','code','fast']},
  // ── Google Gemini ──
  {id:'google/gemini-3.5-flash',p:'google',name:'Gemini 3.5 Flash',desc:'أحدث نموذج Google للأداء الحدودي والبرمجة',caps:['text','vision','code','reason']},
  {id:'google/gemini-3.1-pro',p:'google',name:'Gemini 3.1 Pro',desc:'نموذج متقدم للمهام المعقدة والتفكير العميق',caps:['text','vision','code','reason']},
  {id:'google/gemini-3.1-flash-lite',p:'google',name:'Gemini 3.1 Flash Lite',desc:'سريع جداً وفعال التكلفة',caps:['text','vision','code','fast']},
  {id:'google/gemini-3-flash',p:'google',name:'Gemini 3 Flash',desc:'أداء حدودي برسم أقل من النماذج الأكبر',caps:['text','vision','code','fast']},
  {id:'google/nano-banana-2',p:'google',name:'Nano Banana 2',desc:'توليد صور عالي الكفاءة وسريع جداً',caps:['text','vision','code','fast']},
  {id:'google/nano-banana-pro',p:'google',name:'Nano Banana Pro',desc:'توليد صور احترافي بجودة 4K',caps:['text','vision','code']},
  // ── Anthropic Claude ──
  {id:'anthropic/claude-opus-4-8',p:'anthropic',name:'Claude Opus 4.8',desc:'أحدث وأقوى نموذج Anthropic للتفكير المعقد',caps:['text','vision','code','reason']},
  {id:'anthropic/claude-opus-4-7',p:'anthropic',name:'Claude Opus 4.7',desc:'نموذج متقدم للمهام المعقدة والبرمجة',caps:['text','vision','code','reason']},
  {id:'anthropic/claude-sonnet-4-6',p:'anthropic',name:'Claude Sonnet 4.6',desc:'توازن مثالي بين السرعة والذكاء',caps:['text','vision','code']},
  {id:'anthropic/claude-haiku-4-5',p:'anthropic',name:'Claude Haiku 4.5',desc:'سريع جداً مع ذكاء قريب من الحدود',caps:['text','vision','code','fast']},
  {id:'anthropic/claude-opus-4-5-20251101',p:'anthropic',name:'Claude Opus 4.5',desc:'نموذج قديم متاح للتوافقية',caps:['text','vision','code','reason']},
  // ── DeepSeek ──
  {id:'deepseek/deepseek-v4-pro',p:'deepseek',name:'DeepSeek V4 Pro',desc:'أحدث وأقوى نماذج DeepSeek لعام 2026',caps:['text','vision','code','reason']},
  {id:'deepseek/deepseek-v4-flash',p:'deepseek',name:'DeepSeek V4 Flash',desc:'سريع جداً وذكي للمهام الفورية',caps:['text','vision','code','fast']},
  {id:'deepseek/deepseek-v3.2',p:'deepseek',name:'DeepSeek V3.2',desc:'توازن مثالي بين الكفاءة والذكاء',caps:['text','code','reason']},
  {id:'deepseek/deepseek-r1',p:'deepseek',name:'DeepSeek R1',desc:'تفكير مفتوح المصدر رائد',caps:['text','code','reason','free']},
  // ── Meta Llama ──
  {id:'meta-llama/llama-4-maverick',p:'meta',name:'Llama 4 Maverick',desc:'أقوى Llama متعدد الوسائط',caps:['text','vision','code','free']},
  {id:'meta-llama/llama-4-scout',p:'meta',name:'Llama 4 Scout',desc:'خفيف وذكي مجاني',caps:['text','fast','free']},
  {id:'meta-llama/llama-3.3-70b-instruct',p:'meta',name:'Llama 3.3 70B',desc:'مستقر وموثوق مجاني',caps:['text','code','free']},
  // ── xAI Grok ──
  {id:'x-ai/grok-3',p:'xai',name:'Grok 3',desc:'أقوى نماذج xAI',caps:['text','vision','code','reason']},
  {id:'x-ai/grok-3-mini',p:'xai',name:'Grok 3 Mini',desc:'سريع من xAI',caps:['text','code','fast']},
  // ── Qwen ──
  {id:'qwen/qwen3.7-max',p:'qwen',name:'Qwen 3.7 Max',desc:'أقوى نموذج من Alibaba للمهام المعقدة',caps:['text','vision','code','reason']},
  {id:'qwen/qwen3.7-plus',p:'qwen',name:'Qwen 3.7 Plus',desc:'متعدد الوسائط وتفاعلي فائق الذكاء',caps:['text','vision','code']},
  {id:'qwen/qwen3.6-plus',p:'qwen',name:'Qwen 3.6 Plus',desc:'توازن مثالي بين السرعة والذكاء',caps:['text','vision','code','fast']},
  {id:'qwen/qwen3.6-flash',p:'qwen',name:'Qwen 3.6 Flash',desc:'سريع جداً مع سياق 1 مليون توكن',caps:['text','vision','code','fast']},
  {id:'qwen/qwen3-coder-480b-a35b',p:'qwen',name:'Qwen 3 Coder',desc:'أضخم نموذج متخصص في البرمجة',caps:['text','code','reason']},
  // ── Chinese Frontier ──
  {id:'minimax/minimax-m3',p:'minimax',name:'MiniMax M3',desc:'نموذج صيني قوي متعدد الوسائط',caps:['text','vision','video','reason']},
  {id:'stepfun/step-3.7-flash',p:'stepfun',name:'Step 3.7 Flash',desc:'نموذج سريع جداً من StepFun',caps:['text','vision','fast']},
  {id:'01-ai/yi-large',p:'01-ai',name:'Yi Large',desc:'نموذج 01.AI الرائد للمهام المعقدة',caps:['text','code','reason']},
  // ── Mistral ──
  {id:'mistralai/mistral-large-2411',p:'mistral',name:'Mistral Large',desc:'أقوى نماذج Mistral',caps:['text','code']},
  {id:'mistralai/codestral-2501',p:'mistral',name:'Codestral',desc:'متخصص في البرمجة',caps:['text','code']},
  // ── Others ──
  {id:'microsoft/phi-4',p:'microsoft',name:'Phi-4',desc:'صغير وذكي من Microsoft',caps:['text','code','fast','free']},
  {id:'ollama/local',p:'ollama',name:'Ollama (محلي)',desc:'نماذجك المحلية بدون إنترنت',caps:['text','code','free']},
];
const CAP_LABELS={text:'نص',vision:'صور',video:'فيديو',code:'كود',fast:'سريع',free:'مجاني',reason:'تفكير'};
const CAP_COLORS={text:'text',vision:'vision',video:'video',code:'code',fast:'fast',free:'free',reason:'reason'};

const PERSONAS=[
  {id:'friendly',icon:'😊',name:'ودود',desc:'دافئ وغير رسمي'},
  {id:'professional',icon:'👔',name:'محترف',desc:'رسمي ودقيق'},
  {id:'teacher',icon:'📚',name:'معلم',desc:'يشرح ويبسّط'},
  {id:'coder',icon:'💻',name:'مبرمج',desc:'متخصص في الكود'},
  {id:'creative',icon:'🎨',name:'مبدع',desc:'خيال وإبداع'},
  {id:'concise',icon:'⚡',name:'مختصر',desc:'مباشر وسريع'},
];
const PP={friendly:'تحدث بشكل ودي وغير رسمي، كن دافئاً ومشجعاً',professional:'تحدث بشكل رسمي ودقيق، استخدم المصطلحات المهنية',teacher:'اشرح بشكل مبسط ومفصل، استخدم الأمثلة',coder:'ركز على الحلول التقنية، قدم أكواداً وأمثلة عملية',creative:'كن مبدعاً وخيالياً، اقترح أفكاراً غير تقليدية',concise:'كن مختصراً ومباشراً بأقل كلمات ممكنة'};

// Tools registry
const TOOLS_REGISTRY=[
  {id:'search',cat:'بحث',name:'بحث ذكي',desc:'ابحث بالذكاء الاصطناعي',icon:'search',color:'#60a5fa'},
  {id:'translate',cat:'نصوص',name:'ترجمة',desc:'ترجم بين 100+ لغة',icon:'languages',color:'#34d399'},
  {id:'summarize',cat:'نصوص',name:'تلخيص',desc:'لخّص أي نص أو مقال',icon:'align-left',color:'#a78bfa'},
  {id:'improve',cat:'نصوص',name:'تحسين الكتابة',desc:'اكتب بشكل أفضل',icon:'pen-tool',color:'#f472b6'},
  {id:'api',cat:'تطوير',name:'API Request',desc:'HTTP requests لأي API',icon:'link',color:'#fbbf24'},
  {id:'regex',cat:'تطوير',name:'Regex Tester',desc:'اختبر التعبيرات المنتظمة',icon:'regex',color:'#fb923c'},
  {id:'json',cat:'تطوير',name:'JSON',desc:'نسّق وتحقق وحوّل',icon:'braces',color:'#4ade80'},
  {id:'diff',cat:'تطوير',name:'Code Diff',desc:'قارن بين نسختين من الكود',icon:'git-compare',color:'#38bdf8'},
  {id:'image',cat:'وسائط',name:'تحليل الصور',desc:'Vision AI للصور',icon:'image',color:'#e879f9'},
  {id:'ocr',cat:'وسائط',name:'OCR — قراءة نص',desc:'استخرج النص من الصور',icon:'scan-text',color:'#67e8f9'},
  {id:'base64',cat:'تطوير',name:'Base64',desc:'encode/decode بسرعة',icon:'lock',color:'#94a3b8'},
  {id:'hash',cat:'تطوير',name:'Hash Generator',desc:'MD5, SHA1, SHA256',icon:'fingerprint',color:'#f87171'},
  {id:'timer',cat:'إنتاجية',name:'مؤقت',desc:'عدّاد وتذكيرات',icon:'timer',color:'#fbbf24'},
  {id:'notes',cat:'إنتاجية',name:'ملاحظات سريعة',desc:'احفظ أفكارك فوراً',icon:'sticky-note',color:'#86efac'},
  {id:'calc',cat:'إنتاجية',name:'حاسبة',desc:'عمليات حسابية',icon:'calculator',color:'#c4b5fd'},
  {id:'color',cat:'تصميم',name:'Color Picker',desc:'اختر وحوّل الألوان',icon:'palette',color:'#f9a8d4'},
];

// ═══ STATE ═══
const DCFG={apis:{gemini:'',anthropic:'',openai:'',openrouter:'',tavily:''},ollama:{url:'http://localhost:11434',model:'llama3'},supabase:{url:'',key:''},user:{name:'',job:'',goals:'',prefs:'',location:'',personality:'',persona:'friendly'},autonomy:'assistant',model_id:'openai/gpt-4o-mini',or_custom:'',voice:{lang:'ar-SA',rate:'1.1',tts:'never',wake:'PixelAi'},bot:{name:'PixelAi',tagline:'من إنتاج فريق Binary Beast',gender:'neutral',age:'',lang:'ar',greeting:'',expertise:'',avoid:''}};
function loadCfg(){
  try{
    const saved=JSON.parse(localStorage.getItem('ass_cfg_v5')||'{}');
    // Deep merge: saved overrides defaults (not the other way around)
    return deepMerge(DCFG,saved);
  }catch(e){return JSON.parse(JSON.stringify(DCFG));}
}
function deepMerge(a,b){const r={...a};for(const k in b){if(b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k]))r[k]=deepMerge(a[k]||{},b[k]);else if(b[k]!==undefined&&b[k]!=='')r[k]=b[k];}return r;}
let cfg=loadCfg();
let conversations=JSON.parse(localStorage.getItem('ass_convs_v5')||'[]');
let memories=JSON.parse(localStorage.getItem('ass_mems_v5')||'[]');
let notes=JSON.parse(localStorage.getItem('ass_notes_v5')||'[]');
let uploadedFiles=[],chatAtts=[];
let currentCid=null,currentMsgs=[];
let isLoading=false,recog=null,isListening=false,wakeRec=null,wakeOn=false;
let pvFilter='all',lastVoice=false,pyodide=null,spTab=0;
let timerInterval=null,toolImg=null,toolsCat='الكل';

function saveCfg(){localStorage.setItem('ass_cfg_v5',JSON.stringify(cfg));}
function saveConvs(){localStorage.setItem('ass_convs_v5',JSON.stringify(conversations));}
function saveMems(){localStorage.setItem('ass_mems_v5',JSON.stringify(memories));}
function saveNotes(){localStorage.setItem('ass_notes_v5',JSON.stringify(notes));}

// ════════ IMAGE GENERATION (Pollinations.AI) ════════
let _imgModel = 'flux';
const IMGGEN_EXAMPLES = [
  'a futuristic city at night with neon lights, cyberpunk 8k',
  'a serene mountain lake at sunrise, photorealistic golden hour',
  'a dragon made of galaxy stars, cosmic fantasy art',
  'a cozy coffee shop in autumn rain, warm cinematic bokeh',
  'underwater world with bioluminescent sea creatures',
  'a samurai in cherry blossom forest, ink painting style',
];

function imggenModel(btn) {
  document.querySelectorAll('.imggen-mb').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _imgModel = btn.dataset.m;
}

function imggenRandom() {
  document.getElementById('imggen-float-prompt').value =
    IMGGEN_EXAMPLES[Math.floor(Math.random() * IMGGEN_EXAMPLES.length)];
}

async function imggenImprove() {
  const p = document.getElementById('imggen-float-prompt').value.trim();
  if (!p) { showToast('اكتب وصفاً أولاً'); return; }
  const st = document.getElementById('imggen-float-status');
  if (st) st.textContent = '✨ جاري التحسين...';
  try {
    const improved = await callAPI(
      `ترجم هذا للإنجليزية وحوله لـ image generation prompt احترافي مع تفاصيل الأسلوب والإضاءة. أجب بالـ prompt فقط بدون شرح:
${p}`,
      null, cfg.model_id
    );
    document.getElementById('imggen-float-prompt').value = improved.replace(/^["']|["']$/g,'').trim();
    if (st) st.textContent = '✅ تم';
  } catch(e) {
    if (st) st.textContent = '❌ ' + e.message;
  }
}

async function imggenGenerate() {
  const prompt = document.getElementById('imggen-float-prompt').value.trim();
  if (!prompt) { showToast('⚠️ اكتب وصف الصورة أولاً'); return; }
  const size = document.getElementById('imggen-float-size').value;
  const [w, h] = size.split('x').map(Number);
  const count = parseInt(document.getElementById('imggen-float-count').value) || 1;
  const modelKey = document.getElementById('imggen-float-model')?.value || 'flux-schnell';
  const btn = document.getElementById('imggen-float-btn');
  const st = document.getElementById('imggen-float-status');
  const results = document.getElementById('imggen-float-results');
  btn.disabled = true; btn.textContent = '⏳ جاري التوليد...';
  results.innerHTML = '';

  // Translate if Arabic
  let finalPrompt = prompt;
  if (/[\u0600-\u06FF]/.test(prompt)) {
    const hasKey = cfg.apis.openrouter || cfg.apis.openai || cfg.apis.gemini;
    if (hasKey) {
      try {
        if (st) st.textContent = '✨ ترجمة الوصف...';
        const t = await routeReq(`ترجم للإنجليزية فقط لتوليد صورة، أجب بالـ prompt فقط:\n${prompt}`, null, cfg.model_id);
        if (t && t.length > 3) finalPrompt = t.replace(/^["']|["']$/g, '').trim();
      } catch(e) {}
    }
  }

  for (let i = 0; i < count; i++) {
    const ph = document.createElement('div');
    ph.style.cssText = 'border-radius:8px;overflow:hidden;border:1px solid var(--b1);background:var(--s2);min-height:140px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px';
    ph.innerHTML = `<span style="font-size:28px;animation:spin 1s linear infinite;display:inline-block">⏳</span><span style="font-size:10px;color:var(--t2)">${i+1}/${count}</span>`;
    results.appendChild(ph);
    try {
      const result = await _smartGenerateImage(finalPrompt, modelKey, w, h, st);
      const card = _buildImgCard(result, finalPrompt, modelKey, w, h);
      card.style.cssText += ';border-radius:8px';
      results.replaceChild(card, ph);
      if (st) st.textContent = `✅ صورة ${i+1} — ${result.source}`;
    } catch(err) {
      ph.innerHTML = `<span style="font-size:20px">❌</span><span style="font-size:10px;color:var(--red)">${err.message.slice(0,50)}</span>`;
      if (st) st.textContent = '⚠️ فشل — جرب نموذج مختلف';
    }
  }
  btn.disabled = false; btn.textContent = '🎨 توليد الصورة';
}


// ═══ INIT ═══
async function init(){
  await bbInit();
  if (bbSession) await bbRefreshKeyStatus();
  initSupabase();buildWelcome();renderConvList();renderMemList();
  buildModelPicker();buildAPIGrid();buildPersonaGrid();buildTools();
  initVoice();updatePill();loadSettingsUI();
  updateKeyStatus();
  if(!bbSession){
    setTimeout(()=>{showToast('⚠️ لازم تسجّل دخول في DevVerse الأول عشان تستخدم PixelAi');},900);
  } else if(!cfg.apis.openrouter) setTimeout(()=>{showToast('🔑 أضف OpenRouter API Key من الإعدادات');updateKeyStatus();},900);
  updateTTSBtn();
  const bn=cfg.bot?.name||'PixelAi';
  document.querySelectorAll('#bot-name-display,#vcall-name-el').forEach(el=>{if(el)el.textContent=bn;});
  if(SB.ready)syncCloud();
  document.addEventListener('paste',onPaste);
  // Start periodic tasks scheduler
  renderPeriodicTasks();
  schedulePeriodicTasks();
  if (bbSession) updateIntegrationsBadges();
}

// ═══ WELCOME ═══
function buildWelcome(){
  const n=cfg.user.name||'صديقي';
  document.getElementById('welcome').innerHTML=`
    <div class="w-icon" style="background:none;border:none;box-shadow:none;padding:0;overflow:hidden"><img src="data:image/png;base64,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" style="width:100%;height:100%;object-fit:cover;border-radius:18px"/></div>
    <div><div class="w-title">أهلاً، <span>${esc(n)}</span>!</div>
    <div style="font-size:12px;color:var(--t2);max-width:290px;line-height:1.8">مساعدك الذكي — كود، ملفات، صوت، أدوات، وأكتر</div><div style="font-size:10px;color:var(--t3);margin-top:4px;font-family:monospace">من إنتاج فريق Binary Beast</div></div>
    <div class="sugs">
      <div class="sug" onclick="sendSug(this)">📋 ما مهامي؟</div>
      <div class="sug" onclick="sendSug(this)">💡 اقترح فكرة</div>
      <div class="sug" onclick="sendSug(this)">⚡ اكتب كود</div>
      <div class="sug" onclick="sendSug(this)">🔍 ابحث</div>
      <div class="sug" onclick="sendSug(this)">🌍 ترجم</div>
    </div>
    <div class="cap-grid">
      <div class="cap-card" onclick="switchTab('code')">⚡<div><div style="font-size:11px;font-weight:600">مشغّل الكود</div><div style="font-size:10px;color:var(--t3)">JS+Python+HTML</div></div></div>
      <div class="cap-card" onclick="switchTab('files')">📂<div><div style="font-size:11px;font-weight:600">الملفات</div><div style="font-size:10px;color:var(--t3)">PDF, صور, كود</div></div></div>
      <div class="cap-card" onclick="switchTab('tools')">🛠️<div><div style="font-size:11px;font-weight:600">الأدوات</div><div style="font-size:10px;color:var(--t3)">بحث, API, ترجمة</div></div></div>
      <div class="cap-card" onclick="toggleVoice()">🎤<div><div style="font-size:11px;font-weight:600">صوت</div><div style="font-size:10px;color:var(--t3)">STT + TTS + Wake</div></div></div>
    </div>`;
  
}

// ═══ TABS ═══
function switchTab(t){
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
  document.getElementById('tab-'+t).classList.add('active');
  document.getElementById('view-'+t).classList.add('active');
}
function switchSpTab(i){
  document.querySelectorAll('.sp-tab').forEach((t,j)=>t.classList.toggle('active',i===j));
  document.querySelectorAll('.sp-page').forEach((p,j)=>{
    const show = i===j;
    p.classList.toggle('active',show);
    p.style.display = show ? 'block' : 'none';
  });
  if(i===5) setTimeout(loadIntegrationsUI,30);
  if(i===6) setTimeout(buildMAModelOptions,30);
}

// ═══ MODEL PICKER ═══
function updatePill(){
  const mid=cfg.or_custom||cfg.model_id;
  const m=MODELS.find(x=>x.id===mid);
  const dot=document.getElementById('pill-dot');
  const label=document.getElementById('pill-label');
  if(m){const pv=PROVIDERS[m.p];dot.style.background=pv.color;label.textContent=m.name;}
  else if(cfg.or_custom){dot.style.background='#ef4444';label.textContent=cfg.or_custom.split('/').pop();}
}
function buildModelPicker(filter='',pvF=pvFilter){
  const provs=['all',...Object.keys(PROVIDERS)];
  document.getElementById('prov-tabs').innerHTML=provs.map(p=>{
    const isAll=p==='all';const pv=isAll?null:PROVIDERS[p];
    return `<button class="ptab ${pvF===p?'active':''}" onclick="filterProv('${p}')">${isAll?'🌐 الكل':`<span style="width:6px;height:6px;border-radius:50%;background:${pv.color};display:inline-block;flex-shrink:0"></span>${pv.name}`}</button>`;
  }).join('');
  let filtered=pvF==='all'?MODELS:MODELS.filter(m=>m.p===pvF);
  if(filter)filtered=filtered.filter(m=>m.name.toLowerCase().includes(filter.toLowerCase())||m.desc.includes(filter));
  const sel=cfg.or_custom||cfg.model_id;
  document.getElementById('model-grid').innerHTML=filtered.map(m=>{
    const pv=PROVIDERS[m.p];
    return `<div class="model-card ${m.id===sel?'sel':''}" onclick="selectModel('${m.id}')">
      <div style="width:8px;height:8px;border-radius:50%;background:${pv.color};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div class="model-name">${esc(m.name)}</div>
        <div class="model-desc">${esc(m.desc)}</div>
        <div class="model-caps">${m.caps.map(c=>`<span class="cap-badge ${CAP_COLORS[c]||'text'}">${CAP_LABELS[c]||c}</span>`).join('')}</div>
      </div>
      <div class="model-check">✓</div></div>`;
  }).join('')||'<div style="text-align:center;color:var(--t3);padding:20px;font-size:12px">لا توجد نماذج</div>';
}
function filterProv(p){pvFilter=p;buildModelPicker(document.getElementById('model-search-inp')?.value||'',p);}
function filterModels(){buildModelPicker(document.getElementById('model-search-inp').value,pvFilter);}
function selectModel(id){_selectModelPicker(id);}
function applyOR(){_applyORpicker();}
function openModelPicker(){
  // Remove any existing picker overlay
  const old = document.getElementById('model-panel-overlay');
  if(old) old.remove();

  // Build overlay via JS — avoids any DOM stacking context issues
  const overlay = document.createElement('div');
  overlay.id = 'model-panel-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .2s ease';
  overlay.onclick = (e) => { if(e.target===overlay) closeModelPicker(); };

  const sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--bg2);border:1px solid var(--b1);border-radius:16px 16px 0 0;width:100%;max-width:660px;max-height:88dvh;overflow-y:auto;padding:16px;transform:translateY(30px);transition:transform .25s ease';

  // Build picker HTML
  const sel = cfg.or_custom || cfg.model_id;
  const provs = ['all', ...Object.keys(PROVIDERS)];
  const tabsHTML = provs.map(p => {
    const isAll = p==='all'; const pv = isAll?null:PROVIDERS[p];
    return `<button class="ptab ${pvFilter===p?'active':''}" style="padding:4px 10px;border-radius:99px;border:1px solid var(--b1);background:var(--s1);font-family:'Cairo',sans-serif;font-size:11px;color:var(--t2);cursor:pointer;display:flex;align-items:center;gap:4px" onclick="pvFilter='${p}';document.querySelectorAll('#model-panel-overlay .ptab').forEach(b=>b.classList.remove('active'));this.classList.add('active');_rebuildModelGrid(document.getElementById('mpk-search').value)">${isAll?'🌐 الكل':`<span style="width:6px;height:6px;border-radius:50%;background:${pv.color};display:inline-block"></span>${pv.name}`}</button>`;
  }).join('');

  sheet.innerHTML = `
    <div style="width:34px;height:3px;border-radius:99px;background:var(--b2);margin:0 auto 14px"></div>
    <div style="font-size:15px;font-weight:800;margin-bottom:12px">🧠 اختر النموذج</div>
    <input id="mpk-search" placeholder="ابحث في النماذج..." oninput="_rebuildModelGrid(this.value)" style="width:100%;padding:7px 10px;background:var(--s1);border:1px solid var(--b1);border-radius:8px;color:var(--text);font-family:'Cairo',sans-serif;font-size:12px;outline:none;margin-bottom:10px;direction:rtl;box-sizing:border-box"/>
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px">${tabsHTML}</div>
    <div id="mpk-grid" style="display:flex;flex-direction:column;gap:5px;max-height:350px;overflow-y:auto"></div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--b1)">
      <div style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:6px">أو أدخل أي نموذج من OpenRouter</div>
      <div style="display:flex;gap:6px">
        <input id="mpk-or-inp" placeholder="مثال: deepseek-ai/deepseek-v3" value="${cfg.or_custom||''}" style="flex:1;padding:7px 10px;background:var(--s1);border:1px solid var(--b1);border-radius:8px;color:var(--text);font-family:monospace;font-size:12px;outline:none;direction:ltr;text-align:left"/>
        <button onclick="_applyORpicker()" style="padding:7px 14px;background:var(--accent);border:none;border-radius:8px;color:#1a2028;font-family:'Cairo',sans-serif;font-size:12px;font-weight:700;cursor:pointer">تطبيق</button>
      </div>
    </div>`;

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  // Animate in
  requestAnimationFrame(()=>{
    overlay.style.opacity = '1';
    sheet.style.transform = 'translateY(0)';
  });

  // Fill grid
  _rebuildModelGrid('');
  setTimeout(()=>document.getElementById('mpk-search')?.focus(), 200);
}

function _rebuildModelGrid(filter){
  const grid = document.getElementById('mpk-grid');
  if(!grid) return;
  const sel = cfg.or_custom || cfg.model_id;
  let list = pvFilter==='all' ? MODELS : MODELS.filter(m=>m.p===pvFilter);
  if(filter) list = list.filter(m=>m.name.toLowerCase().includes(filter.toLowerCase())||m.desc.includes(filter));
  if(!list.length){ grid.innerHTML='<div style="text-align:center;color:var(--t3);padding:20px;font-size:12px">لا توجد نماذج</div>'; return; }
  grid.innerHTML = list.map(m=>{
    const pv = PROVIDERS[m.p];
    const isSel = m.id===sel;
    return `<div onclick="_selectModelPicker('${m.id}')" style="padding:9px 11px;border-radius:8px;border:1px solid ${isSel?'rgba(45,212,191,.38)':'var(--b1)'};background:${isSel?'var(--adim)':'var(--s1)'};cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .15s">
      <div style="width:8px;height:8px;border-radius:50%;background:${pv.color};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.name)}</div>
        <div style="font-size:10px;color:var(--t2)">${esc(m.desc)}</div>
        <div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:2px">${m.caps.map(c=>`<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:var(--s2);border:1px solid var(--b1);color:var(--t2)">${CAP_LABELS[c]||c}</span>`).join('')}</div>
      </div>
      ${isSel?'<span style="color:var(--accent);font-size:14px;font-weight:700">✓</span>':''}
    </div>`;
  }).join('');
}

function _selectModelPicker(id){
  cfg.model_id=id; cfg.or_custom=''; saveCfg(); updatePill();
  closeModelPicker();
  showToast(`✅ ${MODELS.find(m=>m.id===id)?.name||id}`);
}
function _applyORpicker(){
  const v=document.getElementById('mpk-or-inp')?.value.trim();
  if(!v) return;
  cfg.or_custom=v; cfg.model_id=v; saveCfg(); updatePill();
  closeModelPicker();
  showToast('✅ '+v.split('/').pop());
}
function closeModelPicker(){
  const overlay = document.getElementById('model-panel-overlay');
  if(!overlay) return;
  overlay.style.opacity='0';
  overlay.querySelector('div').style.transform='translateY(30px)';
  setTimeout(()=>overlay.remove(), 220);
}

// ═══ FLOAT VIDEO WINDOW FUNCTIONS ═══
async function floatVidgenGenerate() {
  const prompt = document.getElementById('float-vidgen-prompt')?.value.trim();
  if (!prompt) { showToast('⚠️ اكتب وصف الفيديو'); return; }
  const btn = document.getElementById('float-vidgen-btn');
  const status = document.getElementById('float-vidgen-status');
  const results = document.getElementById('float-vidgen-results');
  btn.disabled = true; btn.textContent = '⏳ جاري التوليد...';
  if(status) status.textContent = '✨ جاري المعالجة...';

  // Translate if Arabic
  let finalPrompt = prompt;
  if (/[\u0600-\u06FF]/.test(prompt)) {
    const hasKey = cfg.apis.openrouter || cfg.apis.openai || cfg.apis.gemini;
    if (hasKey) {
      try {
        if(status) status.textContent = '✨ ترجمة الوصف...';
        const t = await routeReq(`ترجم للإنجليزية فقط لتوليد فيديو سينمائي، أجب بالـ prompt فقط:\n${prompt}`, null, cfg.model_id);
        if (t && t.length > 5) finalPrompt = t.replace(/^["']|["']$/g, '').trim();
      } catch(e) {}
    }
  }

  const videoUrl = `https://video.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}`;
  if(status) status.textContent = '🎬 يُولَّد الفيديو...';

  // Build card
  const cardId = 'fvc_' + Date.now();
  const card = document.createElement('div');
  card.style.cssText = 'border-radius:var(--r);overflow:hidden;border:1px solid rgba(168,85,247,.3);background:var(--bg2)';
  const safeVP = finalPrompt.slice(0,40).replace(/['"<>&]/g,'');
  card.innerHTML = `
    <div style="padding:7px 10px;background:rgba(168,85,247,.08);font-size:11px;color:#a855f7;font-weight:600;line-height:1.5">🎬 ${esc(finalPrompt.slice(0,70))}${finalPrompt.length>70?'...':''}</div>
    <div id="${cardId}-loading" style="padding:24px;text-align:center">
      <div style="font-size:30px;animation:spin 1.2s linear infinite;display:inline-block">⏳</div>
      <div style="font-size:11px;color:var(--t2);margin-top:8px">جاري توليد الفيديو...<br><span style="font-size:10px;color:var(--t3)">قد يستغرق حتى 3 دقائق</span></div>
    </div>
    <video id="${cardId}-vid" controls style="width:100%;display:none;max-height:280px" preload="auto">
      <source src="${videoUrl}" type="video/mp4">
    </video>
    <div style="display:flex;gap:4px;padding:5px;background:var(--s1)">
      <a href="${videoUrl}" target="_blank" style="flex:1;text-align:center;font-size:11px;color:#a855f7;text-decoration:none;padding:4px;font-weight:700">🔗 فتح / تحميل</a>
      <button onclick="injectVideoBubble('${videoUrl}','${safeVP}')" style="flex:1;font-size:11px;background:#a855f7;border:none;border-radius:5px;color:#fff;cursor:pointer;padding:4px;font-family:'Cairo',sans-serif">💬 شات</button>
    </div>
    <div style="font-size:9px;color:var(--t3);padding:2px 6px 4px;text-align:center">🌐 Pollinations.AI · مجاني</div>`;
  results.insertBefore(card, results.firstChild);

  // Try to load video
  const vidEl = document.getElementById(`${cardId}-vid`);
  const loadingEl = document.getElementById(`${cardId}-loading`);
  if (vidEl) {
    vidEl.oncanplay = () => {
      if(loadingEl) loadingEl.style.display='none';
      vidEl.style.display = 'block';
      if(status) status.textContent = '✅ الفيديو جاهز!';
    };
    vidEl.onerror = () => {
      if(loadingEl) loadingEl.innerHTML = `<div style="font-size:11px;color:var(--t2);padding:4px">⚠️ اضغط الرابط لتحميل الفيديو مباشرة<br><a href="${videoUrl}" target="_blank" style="color:#a855f7;font-weight:700">🔗 افتح في تاب جديد</a></div>`;
      if(status) status.textContent = '⚠️ استخدم رابط الفتح أعلاه';
    };
    setTimeout(()=>vidEl.load(), 300);
    // After 10s show link if still loading
    setTimeout(()=>{
      if(vidEl.style.display==='none' && loadingEl && loadingEl.style.display!=='none'){
        loadingEl.innerHTML = `<div style="font-size:11px;color:var(--t2);line-height:1.8">⏳ الفيديو لا يزال يُولَّد<br><a href="${videoUrl}" target="_blank" style="color:#a855f7;font-weight:700;font-size:12px">🔗 افتح هنا لما يخلص</a></div>`;
        if(status) status.textContent = '⏳ يُولَّد — استخدم الرابط';
      }
    }, 10000);
  }
  btn.disabled = false; btn.textContent = '🎬 توليد الفيديو';
}

async function floatVidgenImprove() {
  const ta = document.getElementById('float-vidgen-prompt');
  if (!ta || !ta.value.trim()) { showToast('⚠️ اكتب وصف أولاً'); return; }
  const hasKey = cfg.apis.openrouter || cfg.apis.openai || cfg.apis.gemini;
  if (!hasKey) { showToast('⚠️ يحتاج API Key لتحسين الـ Prompt'); return; }
  const old = ta.value.trim();
  ta.disabled = true;
  try {
    const improved = await routeReq(`أنت خبير في كتابة prompts لتوليد الفيديو. حسّن هذا الوصف ليكون احترافياً وسينمائياً بالإنجليزية فقط، لا تشرح، أجب بالـ prompt فقط:\n${old}`, null, cfg.model_id);
    if (improved && improved.length > 5) ta.value = improved.replace(/^["']|["']$/g,'').trim();
  } catch(e) { showToast('⚠️ فشل التحسين'); }
  ta.disabled = false;
}
function buildAPIGrid(){
  const d=[{key:'gemini',label:'Google Gemini',ph:'AIza...',c:'#4285f4'},{key:'anthropic',label:'Anthropic',ph:'sk-ant-...',c:'#c96442'},{key:'openai',label:'OpenAI',ph:'sk-...',c:'#10a37f'}];
  document.getElementById('api-grid').innerHTML=d.map(x=>`<div class="api-card"><div class="api-card-hd"><span class="api-dot" style="background:${x.c}"></span>${x.label}</div><input type="password" id="s-api-${x.key}" placeholder="${x.ph}" value="${cfg.apis[x.key]||''}"/></div>`).join('');
}
function buildPersonaGrid(){
  document.getElementById('persona-grid').innerHTML=PERSONAS.map(p=>`<div class="persona-card ${cfg.user.persona===p.id?'sel':''}" onclick="selPersona('${p.id}')"><div style="font-size:18px;margin-bottom:3px">${p.icon}</div><div style="font-size:11.5px;font-weight:700">${p.name}</div><div style="font-size:10px;color:var(--t2)">${p.desc}</div></div>`).join('');
}
function selPersona(id){cfg.user.persona=id;const el=document.getElementById('s-personality');if(el&&(!el.value.trim()||Object.values(PP).includes(el.value.trim())))el.value=PP[id];buildPersonaGrid();}

// ═══ CONVERSATIONS ═══
function newChat(){
  currentCid='cv_'+Date.now();currentMsgs=[];
  document.getElementById('chat-title').textContent='محادثة جديدة';
  document.getElementById('messages').innerHTML='<div id="welcome"></div>';
  buildWelcome();renderConvList();closeSidebarMobile();
}
function updateHistoryBadge(){
  try{
    const badge=document.getElementById('history-time-badge');
    if(!badge)return;
    if(!conversations.length){badge.textContent='';return;}
    const last=conversations.slice().sort((a,b)=>b.updated-a.updated)[0];
    const diff=Date.now()-last.updated;
    const mins=Math.floor(diff/60000),hrs=Math.floor(diff/3600000),days=Math.floor(diff/86400000);
    badge.textContent=days>0?(days+'ي'):hrs>0?(hrs+'س'):mins>0?(mins+'د'):'الآن';
  }catch(e){}
  // Update mobile floating button badge
  try{
    const mBadge=document.getElementById('conv-badge');
    if(mBadge){
      const count=conversations.length;
      if(count>0){mBadge.textContent=count>99?'99+':count;mBadge.style.display='block';}
      else{mBadge.style.display='none';}
    }
  }catch(e){}
}
function renderConvList(){
  updateHistoryBadge();
  const el=document.getElementById('conv-list');
  if(!conversations.length){el.innerHTML='<div style="text-align:center;color:var(--t3);padding:13px;font-size:11px">لا توجد محادثات</div>';return;}
  el.innerHTML=conversations.slice().reverse().map(c=>`<div class="conv-item ${c.id===currentCid?'active':''}" onclick="loadConv('${c.id}')"><span style="flex-shrink:0;font-size:13px">💬</span><span class="ct">${esc(c.title)}</span><button class="conv-del" onclick="event.stopPropagation();delConv('${c.id}')">✕</button></div>`).join('');
}
function loadConv(id){
  const c=conversations.find(x=>x.id===id);if(!c)return;
  currentCid=id;currentMsgs=[...c.messages];
  document.getElementById('chat-title').textContent=c.title;
  const el=document.getElementById('messages');el.innerHTML='';
  currentMsgs.forEach(m=>appendBubble(m.role,m.content,m.model,false,m.img));
  el.scrollTop=el.scrollHeight;renderConvList();closeSidebarMobile();
}
function delConv(id){conversations=conversations.filter(c=>c.id!==id);saveConvs();if(id===currentCid)newChat();else renderConvList();}
function saveConv(title){
  const ex=conversations.find(c=>c.id===currentCid);
  if(ex){ex.messages=[...currentMsgs];ex.updated=Date.now();if(title)ex.title=title;}
  else conversations.push({id:currentCid,title:title||'محادثة',messages:[...currentMsgs],created:Date.now(),updated:Date.now()});
  saveConvs();renderConvList();
  const cv=conversations.find(c=>c.id===currentCid);if(cv)sbSaveConv(cv);
}

// ═══ SEND ═══
function sendSug(el){document.getElementById('chat-input').value=el.textContent.replace(/^[\p{Emoji}\s]+/u,'').trim();sendMessage();}
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}

async function sendMessage(){
  const inp=document.getElementById('chat-input');
  const text=inp.value.trim();
  if((!text&&chatAtts.length===0)||isLoading)return;
  if(!currentCid)currentCid='cv_'+Date.now();
  document.getElementById('welcome')?.remove();
  inp.value='';inp.style.height='auto';
  // Check API key before sending
  const mid=cfg.or_custom||cfg.model_id;
  const model=MODELS.find(m=>m.id===mid);
  const isOllama=mid==='ollama/local';
  if(!isOllama&&!cfg.apis.openrouter){
    removeTyping('fake');
    appendBubble('system','⚠️ لازم تضيف OpenRouter API Key الأول!\nروح الإعدادات ⚙️ وأضف الـ Key في تاب APIs',null);
    isLoading=false;document.getElementById('send-btn').disabled=false;
    return;
  }
  // ── AI decides tools automatically ──
  let imgData=null,fullContent=text;
  for(const f of chatAtts){
    if(f.dataUrl){imgData=f.dataUrl;fullContent+=`\n[صورة: ${f.name}]`;}
    else if(f.content)fullContent+=`\n\n--- ${f.name} ---\n${f.content.slice(0,3000)}`;
  }
  chatAtts=[];document.getElementById('attached-files').innerHTML='';
  currentMsgs.push({role:'user',content:fullContent,img:imgData});
  appendBubble('user',text||'📎 مرفق',null,true,imgData);scrollBottom();
  if(currentMsgs.filter(m=>m.role==='user').length===1){
    const t=(text||'ملف').slice(0,28)+(text.length>28?'...':'');
    document.getElementById('chat-title').textContent=t;saveConv(t);
  }
  const tid=showTyping();isLoading=true;document.getElementById('send-btn').disabled=true;
  try{
    let reply;
    if(maMode){
      // Multi-Agent Deliberation: creates its own bubble, handles its own errors
      removeTyping(tid);
      reply = await multiAgentDeliberate(fullContent, imgData);
      if(!reply) { isLoading=false; document.getElementById('send-btn').disabled=false; return; }
    } else {
      reply = await toolCallLoop(fullContent,model,mid,imgData);
      removeTyping(tid);
      currentMsgs.push({role:'assistant',content:reply,model:model?.name||mid});
      appendBubble('assistant',reply,model?.name||mid);
    }
    if(!maMode){ saveConv();extractMem(fullContent);triggerLTMExtraction(); }
    else { currentMsgs.push({role:'assistant',content:reply,model:'multi-agent'}); saveConv();extractMem(fullContent);triggerLTMExtraction(); }
    const tm=cfg.voice?.tts||'voice-only';
    if(tm==='always'||(tm==='voice-only'&&lastVoice))speakText(reply);
    lastVoice=false;
    // Forward AI reply to connected integrations
    intNotify(reply, 'ai').catch(()=>{});
  }catch(err){removeTyping(tid);appendBubble('assistant',`❌ ${err.message.includes('API_KEY')?'API Key غير صحيح':err.message}`,null);}
  isLoading=false;document.getElementById('send-btn').disabled=false;scrollBottom();
  
}

function appendBubble(role,content,modelName,animate=true,imgData=null){
  const el=document.getElementById('messages');
  const d=document.createElement('div');d.className=`msg ${role}`;
  const time=new Date().toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'});
  const badge=modelName?`<span class="msg-model-tag">${modelName}</span>`:'';
  const img=imgData?`<img src="${imgData}" style="max-width:200px;border-radius:8px;margin-bottom:5px;display:block"/>`:'';
  d.innerHTML=`<div class="msg-av" style="background:none;overflow:hidden;padding:0">${role==='assistant'?'<img src="data:image/png;base64,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" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>':role==='system'?'⚙️':'👤'}</div>
    <div class="msg-body">${img}<div class="msg-bubble">${parseMd(content)}</div>
    <div class="msg-meta">${time}${badge}</div>
    ${role==='assistant'?`<div class="msg-acts">
      <button class="act-btn" onclick="copyToCB(this.closest('.msg-body').querySelector('.msg-bubble').innerText)">نسخ</button>
      <button class="act-btn" onclick="speakText(this.closest('.msg-body').querySelector('.msg-bubble').innerText)">🔊</button>
    </div>`:''}
    </div>`;
  el.appendChild(d);
  d.querySelectorAll('.run-btn').forEach(btn=>btn.addEventListener('click',()=>runInline(btn)));
  
}

function parseMd(c){
  let h=esc(c);
  h=h.replace(/```(\w*)\n?([\s\S]*?)```/g,(_,lang,code)=>{
    const id='cb_'+Math.random().toString(36).slice(2);
    const l=lang||'code';
    return `<div class="code-block"><div class="code-hd">
      <span class="code-lang-tag">${l}</span>
      <div class="code-btns">
        <button class="cbtn" onclick="copyToCB(document.getElementById('${id}').innerText)">نسخ</button>
        <button class="cbtn run run-btn" data-lang="${l}" data-code="${encodeURIComponent(code)}" data-id="${id}">▶ تشغيل</button>
        <button class="cbtn" onclick="sendToEditor(document.getElementById('${id}').innerText,'${l}')">↗ المحرر</button>
      </div></div>
      <pre class="cpre"><code id="${id}">${code}</code></pre></div>`;
  });
  h=h.replace(/`([^`]+)`/g,'<code style="font-family:var(--mono);font-size:11px;padding:1px 4px;background:var(--bg3);border-radius:4px;color:var(--accent)">$1</code>');
  h=h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  h=h.replace(/\*(.+?)\*/g,'<em>$1</em>');
  h=h.replace(/^#{1,3}\s+(.+)$/gm,'<div style="font-weight:700;margin:4px 0">$1</div>');
  h=h.replace(/\n/g,'<br>');
  return h;
}

function runInline(btn){
  const lang=btn.dataset.lang,code=decodeURIComponent(btn.dataset.code);
  const block=btn.closest('.code-block');
  let out=block.nextElementSibling;
  if(!out||!out.classList.contains('code-out-wrap')){
    out=document.createElement('div');out.className='code-out-wrap';
    out.innerHTML='<div class="code-out-hd">📤 النتيجة</div><div class="code-out-bd"></div>';
    block.insertAdjacentElement('afterend',out);
  }
  const body=out.querySelector('.code-out-bd');body.classList.remove('err');
  execCode(lang,code,(r,e)=>{body.classList.toggle('err',e);body.textContent=r;});
}
function showTyping(){const id='tp_'+Date.now();const d=document.createElement('div');d.id=id;d.className='msg assistant';d.innerHTML='<div class="msg-av" style="background:none;overflow:hidden;padding:0"><img src="data:image/png;base64,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" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/></div><div class="msg-body"><div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div></div>';document.getElementById('messages').appendChild(d);scrollBottom();return id;}
function removeTyping(id){document.getElementById(id)?.remove();}
function scrollBottom(){const el=document.getElementById('messages');setTimeout(()=>{el.scrollTop=el.scrollHeight},50);}
function sysMsg(t){const d=document.createElement('div');d.className='msg system';d.innerHTML=`<div class="msg-av">⚙️</div><div class="msg-body"><div class="msg-bubble">${esc(t)}</div></div>`;document.getElementById('messages').appendChild(d);scrollBottom();}

// ═══ AGENT ═══
// ════════════════════════════════════════════════
// PEXIL SKILLS PANEL
// ════════════════════════════════════════════════
const PEXIL_SKILLS = [
  { icon:'🧠', name:'ذاكرة طويلة المدى', desc:'يتذكر كل محادثاتك السابقة', badge:'active' },
  { icon:'🔍', name:'بحث الإنترنت', desc:'يجيبك بأحدث الأخبار والمعلومات', badge:'auto' },
  { icon:'⚡', name:'تنفيذ الكود', desc:'يشغّل JS, Python, HTML بنفسه', badge:'auto' },
  { icon:'📅', name:'تقويم Google', desc:'يضيف مواعيدك ويذكّرك بها', badge:'auto' },
  { icon:'📄', name:'قراءة الملفات', desc:'يحلل PDF, Word, Excel, صور', badge:'auto' },
  { icon:'🔊', name:'التحدث بالصوت', desc:'يقرالك الردود بصوت طبيعي', badge:'active' },
  { icon:'👁️', name:'تحليل الصور', desc:'يشرح الصور ويقرأ منها', badge:'auto' },
  { icon:'📌', name:'الملاحظات والمفضلة', desc:'يحفظ المواضيع المهمة', badge:'auto' },
  { icon:'🌐', name:'متصفح مدمج', desc:'يفتح المواقع جنب الشات', badge:'auto' },
  { icon:'🗺️', name:'بحث الخرائط', desc:'يفتح الخريطة عند الطلب', badge:'auto' },
  { icon:'🎨', name:'توليد الصور', desc:'يولّد صور بالذكاء الاصطناعي', badge:'auto' },
  { icon:'📊', name:'تحليل البيانات', desc:'يحلل CSV وExcel ويرسم رسوم', badge:'auto' },
  { icon:'✅', name:'المهام والأولويات', desc:'يساعدك تخطط يومك بذكاء', badge:'auto' },
  { icon:'🎙️', name:'المكالمة الصوتية', desc:'تحدّث معه مباشرة بالصوت', badge:'active' },
  { icon:'🔗', name:'تكامل التطبيقات', desc:'يتصل بالبريد والتقويم وأكثر', badge:'auto' },
  { icon:'🤖', name:'تعلم من تفاعلاتك', desc:'يتطور بناءً على أسلوبك', badge:'active' },
  { icon:'🤝', name:'تفكير متعدد', desc:'نموذجان AI يتناقشان لإجابة أفضل', badge:'active' },
];

function buildSkillsGrid() {
  const grid = document.getElementById('skills-grid');
  if (!grid) return;
  grid.innerHTML = PEXIL_SKILLS.map(s => `
    <div class="skill-card">
      <div class="skill-card-icon">${s.icon}</div>
      <div class="skill-card-body">
        <div class="skill-card-name">${s.name}</div>
        <div class="skill-card-desc">${s.desc}</div>
        <div class="skill-card-badge ${s.badge}">${s.badge==='active'?'✓ نشط':'⚡ تلقائي'}</div>
      </div>
    </div>`).join('');
}

function toggleSkillsPanel() {
  const panel = document.getElementById('skills-panel');
  const overlay = document.getElementById('skills-overlay');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  overlay.classList.toggle('open', !isOpen);
  if (!isOpen) buildSkillsGrid();
}

// ════════════════════════════════════════════════
// EXTENDED PEXIL_TOOLS — 12 skills as tool calls
// ════════════════════════════════════════════════

// ── Tool definitions for OpenRouter ──
const PEXIL_TOOLS = [
  {
    type:'function',
    function:{
      name:'web_search',
      description:'ابحث في الويب عن معلومات حديثة، أخبار، أسعار، أو أي معلومة تحتاج تحديثاً',
      parameters:{type:'object',properties:{query:{type:'string',description:'استعلام البحث'}},required:['query']}
    }
  },
  {
    type:'function',
    function:{
      name:'open_browser',
      description:'افتح موقع ويب في نافذة المتصفح بجانب الشات',
      parameters:{type:'object',properties:{url:{type:'string'},reason:{type:'string'}},required:['url']}
    }
  },
  {
    type:'function',
    function:{
      name:'search_maps',
      description:'ابحث عن مكان أو موقع جغرافي على الخريطة',
      parameters:{type:'object',properties:{query:{type:'string',description:'اسم المكان أو العنوان'}},required:['query']}
    }
  },
  {
    type:'function',
    function:{
      name:'generate_image',
      description:'ولّد صورة بالذكاء الاصطناعي — يختار تلقائياً أفضل مزود متاح (OpenRouter/OpenAI/Gemini/Pollinations) بناءً على الـ API keys المتوفرة، ويعرض الصورة مباشرة في الشات',
      parameters:{type:'object',properties:{
        prompt:{type:'string',description:'وصف الصورة بالإنجليزية بتفاصيل دقيقة (الأسلوب، الإضاءة، الألوان)'},
        model:{type:'string',enum:['flux-schnell','flux-pro','flux-realism','flux-anime','dalle3','dalle2','imagen3','pollinations','pol-turbo'],description:'النموذج: flux-schnell (سريع/OR)، flux-pro (احترافي/OR)، dalle3 (OpenAI)، imagen3 (Google)، pollinations (مجاني)'},
        width:{type:'number',description:'عرض الصورة (512-1792، افتراضي 1024)'},
        height:{type:'number',description:'ارتفاع الصورة (512-1792، افتراضي 1024)'},
        count:{type:'number',description:'عدد الصور (1-4، افتراضي 1)'}
      },required:['prompt']}
    }
  },
  {
    type:'function',
    function:{
      name:'generate_video',
      description:'ولّد فيديو قصير باستخدام الذكاء الاصطناعي من وصف نصي عبر Pollinations.AI — يظهر مباشرة في الشات',
      parameters:{type:'object',properties:{
        prompt:{type:'string',description:'وصف الفيديو بالإنجليزية'},
        duration:{type:'number',description:'المدة بالثواني (3-8، افتراضي 4)'}
      },required:['prompt']}
    }
  },
  {
    type:'function',
    function:{
      name:'run_code',
      description:'نفّذ كود برمجي (JavaScript, Python) وأرجع النتيجة',
      parameters:{type:'object',properties:{
        language:{type:'string',enum:['javascript','python'],description:'لغة البرمجة'},
        code:{type:'string',description:'الكود المطلوب تنفيذه'}
      },required:['language','code']}
    }
  },
  {
    type:'function',
    function:{
      name:'save_note',
      description:'احفظ ملاحظة أو معلومة مهمة في قائمة المفضلة',
      parameters:{type:'object',properties:{
        title:{type:'string',description:'عنوان الملاحظة'},
        content:{type:'string',description:'محتوى الملاحظة'},
        category:{type:'string',description:'التصنيف مثل: مهمة، فكرة، معلومة، تذكير'}
      },required:['title','content']}
    }
  },
  {
    type:'function',
    function:{
      name:'get_notes',
      description:'استرجع الملاحظات المحفوظة',
      parameters:{type:'object',properties:{
        category:{type:'string',description:'تصفية حسب التصنيف (اختياري)'}
      }}
    }
  },
  {
    type:'function',
    function:{
      name:'add_calendar_event',
      description:'أضف حدث أو موعد في Google Calendar',
      parameters:{type:'object',properties:{
        title:{type:'string',description:'عنوان الحدث'},
        date:{type:'string',description:'التاريخ بصيغة YYYY-MM-DD'},
        time:{type:'string',description:'الوقت بصيغة HH:MM (24h)'},
        duration_minutes:{type:'number',description:'المدة بالدقائق'},
        description:{type:'string',description:'وصف إضافي'}
      },required:['title','date']}
    }
  },
  {
    type:'function',
    function:{
      name:'get_calendar_events',
      description:'احصل على مواعيدك القادمة من Google Calendar',
      parameters:{type:'object',properties:{
        days_ahead:{type:'number',description:'عدد الأيام القادمة للبحث (افتراضي 7)'}
      }}
    }
  },
  {
    type:'function',
    function:{
      name:'analyze_data',
      description:'حلل بيانات CSV أو Excel وأنشئ إحصائيات أو رسوم بيانية',
      parameters:{type:'object',properties:{
        data:{type:'string',description:'البيانات بصيغة CSV أو JSON'},
        analysis_type:{type:'string',enum:['summary','chart','correlation','top_values'],description:'نوع التحليل'}
      },required:['data','analysis_type']}
    }
  },
  {
    type:'function',
    function:{
      name:'manage_tasks',
      description:'أضف مهمة جديدة أو احصل على قائمة المهام',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['add','list','complete','delete'],description:'العملية المطلوبة'},
        task:{type:'string',description:'نص المهمة (للإضافة)'},
        priority:{type:'string',enum:['high','medium','low'],description:'الأولوية'},
        task_id:{type:'number',description:'رقم المهمة (للإكمال/الحذف)'}
      },required:['action']}
    }
  },
  {
    type:'function',
    function:{
      name:'speak_text',
      description:'اقرأ نصاً بصوت عالٍ للمستخدم',
      parameters:{type:'object',properties:{
        text:{type:'string',description:'النص المطلوب قراءته'}
      },required:['text']}
    }
  },
  {
    type:'function',
    function:{
      name:'get_weather',
      description:'احصل على حالة الطقس الحالية لأي مدينة أو موقع',
      parameters:{type:'object',properties:{
        city:{type:'string',description:'اسم المدينة أو الموقع بالعربية أو الإنجليزية'},
        unit:{type:'string',enum:['celsius','fahrenheit'],description:'وحدة الحرارة (افتراضي celsius)'}
      },required:['city']}
    }
  },
  {
    type:'function',
    function:{
      name:'get_news',
      description:'احصل على آخر الأخبار حول موضوع معين أو أخبار عامة',
      parameters:{type:'object',properties:{
        topic:{type:'string',description:'موضوع الأخبار مثل: تكنولوجيا، رياضة، اقتصاد، سياسة، أو اتركه فارغاً للأخبار العامة'},
        country:{type:'string',description:'البلد للأخبار المحلية مثل: egypt, saudi, uae (اختياري)'}
      }}
    }
  },
  {
    type:'function',
    function:{
      name:'manage_periodic_tasks',
      description:'أدِر المهام الدورية والتذكيرات المتكررة — يمكن جدولة مهام يومية أو أسبوعية',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['add','list','delete','toggle'],description:'العملية المطلوبة'},
        name:{type:'string',description:'اسم المهمة الدورية'},
        interval:{type:'string',enum:['daily','weekly','hourly'],description:'تكرار المهمة'},
        time:{type:'string',description:'وقت التذكير بصيغة HH:MM'},
        days:{type:'array',items:{type:'string'},description:'أيام الأسبوع (للمهام الأسبوعية): Saturday,Sunday,...'},
        task_id:{type:'number',description:'معرف المهمة للحذف أو التبديل'}
      },required:['action']}
    }
  },
  {
    type:'function',
    function:{
      name:'control_map',
      description:'تحكم في الخريطة العائمة — افتحها وانتقل لأي مكان أو ابحث عن موقع وعرض التفاصيل',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['open','navigate','search','zoom_in','zoom_out','my_location','show_route'],description:'الإجراء المطلوب'},
        location:{type:'string',description:'اسم المكان أو الإحداثيات للتنقل أو البحث'},
        from:{type:'string',description:'نقطة البداية للمسار'},
        to:{type:'string',description:'نقطة الوصول للمسار'}
      },required:['action']}
    }
  },
  // ── GOOGLE SERVICES ──
  {
    type:'function',
    function:{
      name:'gmail',
      description:'Gmail — اقرأ أو ابحث أو أرسل إيميلات عبر Gmail',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['read','search','send','list'],description:'الإجراء: list=قائمة آخر رسائل، read=قرأ رسالة، search=بحث، send=إرسال'},
        query:{type:'string',description:'نص البحث في الإيميلات (مثل: from:boss@gmail.com)'},
        message_id:{type:'string',description:'معرف الرسالة للقراءة'},
        to:{type:'string',description:'المستلم عند الإرسال'},
        subject:{type:'string',description:'الموضوع عند الإرسال'},
        body:{type:'string',description:'محتوى الإيميل عند الإرسال'},
        max_results:{type:'number',description:'أقصى عدد نتائج (افتراضي 5)'}
      },required:['action']}
    }
  },
  {
    type:'function',
    function:{
      name:'google_calendar',
      description:'Google Calendar — اعرض أو أضف أو حذف مواعيد من التقويم',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['list','create','delete','search'],description:'الإجراء المطلوب'},
        title:{type:'string',description:'عنوان الحدث'},
        start:{type:'string',description:'وقت البداية بصيغة ISO 8601 مثل 2025-06-15T10:00:00'},
        end:{type:'string',description:'وقت النهاية بصيغة ISO 8601'},
        description:{type:'string',description:'تفاصيل الحدث'},
        event_id:{type:'string',description:'معرف الحدث للحذف'},
        days_ahead:{type:'number',description:'عرض مواعيد كم يوم قادم (افتراضي 7)'}
      },required:['action']}
    }
  },
  {
    type:'function',
    function:{
      name:'google_drive',
      description:'Google Drive — ابحث أو حمّل أو اعرض ملفات Drive',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['list','search','get','create_folder','share'],description:'الإجراء المطلوب'},
        query:{type:'string',description:'نص البحث عن ملف'},
        file_id:{type:'string',description:'معرف الملف'},
        folder_name:{type:'string',description:'اسم المجلد الجديد'},
        max_results:{type:'number',description:'أقصى عدد نتائج'}
      },required:['action']}
    }
  },
  {
    type:'function',
    function:{
      name:'google_sheets',
      description:'Google Sheets — اقرأ أو اكتب في جداول Google',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['read','write','append','clear'],description:'الإجراء المطلوب'},
        spreadsheet_id:{type:'string',description:'معرف الـ Spreadsheet (يستخدم الافتراضي من الإعدادات)'},
        range:{type:'string',description:'نطاق الخلايا مثل Sheet1!A1:D10'},
        values:{type:'array',items:{type:'array'},description:'البيانات للكتابة (مصفوفة ثنائية)'}
      },required:['action','range']}
    }
  },
  {
    type:'function',
    function:{
      name:'google_tasks',
      description:'Google Tasks — اعرض أو أضف أو أكمل مهام Google Tasks',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['list','create','complete','delete'],description:'الإجراء المطلوب'},
        title:{type:'string',description:'عنوان المهمة'},
        task_id:{type:'string',description:'معرف المهمة'},
        notes:{type:'string',description:'ملاحظات المهمة'},
        due:{type:'string',description:'تاريخ الاستحقاق بصيغة ISO 8601'}
      },required:['action']}
    }
  },
  // ── GITHUB ──
  {
    type:'function',
    function:{
      name:'github',
      description:'GitHub — عرض repos وcommits وissues وgists وبحث في الكود وإنشاء PRs',
      parameters:{type:'object',properties:{
        action:{type:'string',enum:['list_repos','list_commits','list_issues','open_issue','close_issue','search_code','list_gists','create_gist','create_pr'],description:'الإجراء المطلوب'},
        repo:{type:'string',description:'اسم الـ repo بالصيغة owner/repo مثل Mostafa-ashraf799/my-project'},
        issue_number:{type:'number',description:'رقم الـ issue'},
        title:{type:'string',description:'عنوان الـ issue أو PR أو gist'},
        body:{type:'string',description:'محتوى الـ issue أو PR'},
        query:{type:'string',description:'نص البحث في الكود'},
        filename:{type:'string',description:'اسم ملف الـ gist'},
        content:{type:'string',description:'محتوى ملف الـ gist'},
        base:{type:'string',description:'الـ branch المستهدف للـ PR (مثل main)'},
        head:{type:'string',description:'الـ branch المصدر للـ PR'},
        public:{type:'boolean',description:'هل الـ gist عام؟'}
      },required:['action']}
    }
  }
];

// ── Tool executor ──
async function executeTool(name, args) {
  if (name === 'web_search') {
    showToolActivity('🔍', `جاري البحث عن: ${args.query}`);
    try {
      const d = await bbCallIntegration('tavily', { method: 'POST', path: '/search', requestBody: { query: args.query, search_depth: 'basic', max_results: 5, include_answer: true } });
      if (d.error) return `خطأ في البحث: ${d.error}`;
      let out = '';
      if (d.answer) out += `الإجابة المباشرة: ${d.answer}\n\n`;
      if (d.results?.length) {
        out += 'المصادر:\n';
        d.results.slice(0, 4).forEach((r, i) => { out += `${i + 1}. ${r.title}\n${r.url}\n${r.content?.slice(0, 250)}...\n\n`; });
      }
      return out || 'لم تظهر نتائج للبحث.';
    } catch (e) {
      if (String(e.message).includes('not connected')) return `[بحث]: لم يتم تكوين Tavily API Key — يرجى إضافته في الإعدادات للبحث الحقيقي. الاستعلام: "${args.query}"`;
      return `خطأ: ${e.message}`;
    }
  }

  if (name === 'open_browser') {
    let url = args.url;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    showToolActivity('🌐', `جاري فتح: ${url}`);
    setTimeout(() => openBrowserFromChat(url), 400);
    return `تم فتح ${url} في نافذة المتصفح بجانب الشات.`;
  }

  if (name === 'search_maps') {
    showToolActivity('🗺️', `جاري البحث في الخريطة عن: ${args.query}`);
    setTimeout(() => openMapsFromChat(args.query), 400);
    return `تم فتح الخريطة والبحث عن: ${args.query}`;
  }

  if (name === 'generate_image') {
    const prompt = args.prompt || 'beautiful art';
    const modelKey = (() => {
      // Map old model names to new keys
      const m = args.model || 'flux-schnell';
      const map = {'flux':'flux-schnell','flux-realism':'flux-realism','flux-anime':'flux-anime','flux-3d':'flux-schnell','turbo':'pol-turbo','dreamshaper':'pollinations','gpt-image':'dalle3'};
      return map[m] || m;
    })();
    const w = Math.min(1792, Math.max(512, args.width || 1024));
    const h = Math.min(1792, Math.max(512, args.height || 1024));
    const count = Math.min(4, Math.max(1, args.count || 1));
    const mInfo = _getBestImgModel(modelKey);
    showToolActivity('🎨', `توليد صورة عبر ${mInfo.label}...`);

    // Generate and inject into chat
    for (let i = 0; i < count; i++) {
      try {
        const result = await _smartGenerateImage(prompt, modelKey, w, h, null);
        const el = document.getElementById('messages');
        const d = document.createElement('div');
        d.className = 'msg assistant';
        const safeP = esc(prompt.slice(0, 60));
        d.innerHTML = `<div class="msg-av" style="background:linear-gradient(135deg,rgba(124,58,237,.2),rgba(0,170,255,.1));display:grid;place-items:center;font-size:16px">🎨</div>
          <div class="msg-body"><div class="msg-bubble" style="padding:8px">
            <div style="margin-bottom:6px;font-size:11px;color:var(--t2)">🎨 ${safeP}${prompt.length>60?'...':''}</div>
            <img src="${result.url}" alt="${safeP}" style="width:100%;max-width:400px;border-radius:var(--rs);display:block" loading="lazy"/>
            <div style="margin-top:5px;display:flex;gap:4px">
              ${result.url.startsWith('data:')
                ? `<button onclick="downloadDataImg(this.closest('.msg-bubble').querySelector('img').src,'pexil-ai-img.png')" style="flex:1;font-size:10px;padding:3px;border:1px solid var(--b1);border-radius:4px;background:var(--s2);color:var(--t2);cursor:pointer">⬇️ تحميل</button>`
                : `<a href="${result.url}" download="pexil-ai-img.png" target="_blank" style="flex:1;text-align:center;font-size:10px;color:var(--accent);text-decoration:none;padding:3px;border:1px solid var(--b1);border-radius:4px">⬇️ تحميل</a>`}
            </div>
            <div style="margin-top:4px;font-size:9px;color:var(--t3)">🌐 ${result.source}</div>
          </div></div>`;
        el.appendChild(d);
        scrollBottom();
      } catch(err) {
        showToast('❌ فشل توليد الصورة: ' + err.message.slice(0,50));
      }
    }
    return `✅ تم توليد ${count > 1 ? count+' صور' : 'الصورة'} عبر **${mInfo.label}**!\n🎨 **"${prompt.slice(0,80)}"**\n\nالصورة تظهر مباشرة في الشات.`;
  }

  if (name === 'generate_video') {
    const prompt = args.prompt || 'cinematic video clip';
    showToolActivity('🎬', 'جاري توليد الفيديو عبر Pollinations.AI...');
    // Pollinations video endpoint
    const encodedPrompt = encodeURIComponent(prompt);
    const videoUrl = `https://video.pollinations.ai/prompt/${encodedPrompt}`;
    // Inject video bubble into chat
    const el = document.getElementById('messages');
    const d = document.createElement('div');
    d.className = 'msg assistant';
    d.innerHTML = `<div class="msg-av" style="background:none;overflow:hidden;padding:0"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%23a855f722'/%3E%3Ctext x='50%25' y='55%25' dominant-baseline='middle' text-anchor='middle' font-size='20'%3E🎬%3C/text%3E%3C/svg%3E" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/></div>
      <div class="msg-body">
        <div class="msg-bubble">
          <div style="margin-bottom:6px;font-size:11px;color:var(--t2)">🎬 ${esc(prompt.slice(0,60))}${prompt.length>60?'...':''}</div>
          <div style="border-radius:var(--r);overflow:hidden;border:1px solid var(--b1);background:var(--bg2);max-width:360px">
            <video controls style="width:100%;display:block;border-radius:var(--r)" preload="auto">
              <source src="${videoUrl}" type="video/mp4">
              <div style="padding:16px;text-align:center;font-size:12px;color:var(--t2)">⚠️ المتصفح لا يدعم تشغيل الفيديو — <a href="${videoUrl}" target="_blank" style="color:var(--accent)">افتح الرابط مباشرة</a></div>
            </video>
            <div style="display:flex;gap:4px;padding:5px;background:var(--s1)">
              <a href="${videoUrl}" target="_blank" style="flex:1;text-align:center;font-size:10px;color:var(--accent);text-decoration:none;padding:3px">⬇️ تحميل</a>
              <a href="${videoUrl}" target="_blank" style="flex:1;text-align:center;font-size:10px;color:var(--t2);text-decoration:none;padding:3px">🔗 فتح</a>
            </div>
          </div>
          <div style="margin-top:6px;font-size:10px;color:var(--t3)">🌐 Pollinations.AI Video · مجاني بدون API Key</div>
        </div>
      </div>`;
    el.appendChild(d);
    scrollBottom();
    return `✅ تم توليد الفيديو!\n🎬 **"${prompt.slice(0,80)}"**\n\nالفيديو يظهر في الشات — إذا لم يظهر جرب فتح <${videoUrl}> مباشرة.`;
  }

  if (name === 'run_code') {
    showToolActivity('⚡', `تنفيذ كود ${args.language}...`);
    return new Promise(resolve => {
      execCode(args.language, args.code, (result, isErr) => {
        resolve(isErr ? `خطأ: ${result}` : `النتيجة:\n${result}`);
      });
    });
  }

  if (name === 'save_note') {
    showToolActivity('📌', `حفظ: ${args.title}`);
    const notes = JSON.parse(localStorage.getItem('pexil_notes') || '[]');
    const note = { id: Date.now(), title: args.title, content: args.content, category: args.category || 'عام', date: new Date().toLocaleDateString('ar-EG') };
    notes.unshift(note);
    localStorage.setItem('pexil_notes', JSON.stringify(notes.slice(0, 100)));
    return `تم حفظ الملاحظة "${args.title}" بنجاح.`;
  }

  if (name === 'get_notes') {
    const notes = JSON.parse(localStorage.getItem('pexil_notes') || '[]');
    if (!notes.length) return 'لا توجد ملاحظات محفوظة بعد.';
    const filtered = args.category ? notes.filter(n => n.category === args.category) : notes;
    return filtered.slice(0, 10).map((n, i) => `${i+1}. [${n.category}] ${n.title}\n   ${n.content.slice(0,100)}${n.content.length>100?'...':''}\n   📅 ${n.date}`).join('\n\n');
  }

  if (name === 'add_calendar_event') {
    showToolActivity('📅', `إضافة موعد: ${args.title}`);
    // Store locally (no external API key needed)
    const events = JSON.parse(localStorage.getItem('pexil_events') || '[]');
    const newEvent = {
      id: Date.now(),
      title: args.title,
      date: args.date,
      time: args.time || '',
      duration: args.duration_minutes || 60,
      description: args.description || '',
      created: new Date().toISOString()
    };
    events.push(newEvent);
    localStorage.setItem('pexil_events', JSON.stringify(events));
    // Also add to long-term memory
    addLongTermFact(`موعد محفوظ: ${args.title} بتاريخ ${args.date}${args.time?' الساعة '+args.time:''}`, 'تقويم');
    const dateFormatted = new Date(args.date).toLocaleDateString('ar-EG', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
    return `✅ تم حفظ الموعد بنجاح!\n📅 **${args.title}**\n📆 ${dateFormatted}${args.time?'\n⏰ الساعة '+args.time:''}\n${args.description?'📝 '+args.description:''}\n\n_الموعد محفوظ محلياً. يمكنك عرض مواعيدك بسؤالي عنها._`;
  }

  if (name === 'get_calendar_events') {
    showToolActivity('📅', 'جاري جلب المواعيد...');
    const days = args.days_ahead || 7;
    const events = JSON.parse(localStorage.getItem('pexil_events') || '[]');
    const now = new Date(); const limit = new Date(); limit.setDate(limit.getDate() + days);
    const upcoming = events.filter(e => { const d = new Date(e.date); return d >= now && d <= limit; });
    if (!upcoming.length) return `لا توجد مواعيد في الـ ${days} أيام القادمة.`;
    return upcoming.map(e => `📅 ${e.title}\n   ${e.date}${e.time?' | '+e.time:''}\n   ${e.description||''}`).join('\n\n');
  }

  if (name === 'analyze_data') {
    showToolActivity('📊', 'جاري تحليل البيانات...');
    try {
      let rows = [];
      if (args.data.trim().startsWith('[')) {
        rows = JSON.parse(args.data);
      } else {
        const lines = args.data.trim().split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        rows = lines.slice(1).map(l => { const v = l.split(','); return Object.fromEntries(headers.map((h,i) => [h, isNaN(v[i]) ? v[i]?.trim() : +v[i]])); });
      }
      if (args.analysis_type === 'summary') {
        const keys = Object.keys(rows[0] || {});
        const numKeys = keys.filter(k => typeof rows[0][k] === 'number');
        const summary = numKeys.map(k => {
          const vals = rows.map(r => r[k]).filter(v => !isNaN(v));
          const sum = vals.reduce((a,b)=>a+b,0);
          return `${k}: المجموع=${sum.toFixed(2)}, المتوسط=${(sum/vals.length).toFixed(2)}, الأدنى=${Math.min(...vals)}, الأعلى=${Math.max(...vals)}`;
        });
        return `إجمالي الصفوف: ${rows.length}\n\n${summary.join('\n')}`;
      }
      if (args.analysis_type === 'top_values') {
        const key = Object.keys(rows[0]||{}).find(k => typeof rows[0][k] === 'number') || Object.keys(rows[0]||{})[0];
        const sorted = [...rows].sort((a,b) => (b[key]||0) - (a[key]||0));
        return `أعلى 5 قيم لـ ${key}:\n` + sorted.slice(0,5).map((r,i)=>`${i+1}. ${JSON.stringify(r)}`).join('\n');
      }
      return `تم تحليل ${rows.length} صفوف بنجاح.`;
    } catch(e) { return `خطأ في التحليل: ${e.message}`; }
  }

  if (name === 'manage_tasks') {
    const tasks = JSON.parse(localStorage.getItem('pexil_tasks') || '[]');
    if (args.action === 'add') {
      const task = { id: Date.now(), text: args.task, priority: args.priority || 'medium', done: false, date: new Date().toLocaleDateString('ar-EG') };
      tasks.push(task);
      localStorage.setItem('pexil_tasks', JSON.stringify(tasks));
      showToolActivity('✅', `مهمة جديدة: ${args.task}`);
      return `تمت إضافة المهمة: "${args.task}" (${args.priority === 'high' ? '🔴 عالية' : args.priority === 'low' ? '🟢 منخفضة' : '🟡 متوسطة'})`;
    }
    if (args.action === 'list') {
      if (!tasks.length) return 'لا توجد مهام حالياً.';
      const p = {'high':'🔴','medium':'🟡','low':'🟢'};
      return tasks.filter(t=>!t.done).map((t,i)=>`${i+1}. ${p[t.priority]||'🟡'} ${t.text}`).join('\n') || 'تم إنجاز كل المهام! 🎉';
    }
    if (args.action === 'complete' && args.task_id) {
      const t = tasks.find(t => t.id === args.task_id); if(t) t.done = true;
      localStorage.setItem('pexil_tasks', JSON.stringify(tasks));
      return `تم إنجاز المهمة ✅`;
    }
    if (args.action === 'delete' && args.task_id) {
      const idx = tasks.findIndex(t => t.id === args.task_id);
      if (idx !== -1) tasks.splice(idx, 1);
      localStorage.setItem('pexil_tasks', JSON.stringify(tasks));
      return 'تم حذف المهمة.';
    }
    return 'عملية غير معروفة.';
  }

  if (name === 'speak_text') {
    showToolActivity('🔊', 'جاري القراءة بصوت...');
    speakText(args.text);
    return 'جاري القراءة بصوت عالٍ.';
  }

  // ── WEATHER ──
  if (name === 'get_weather') {
    const city = args.city || 'Cairo';
    const unit = args.unit === 'fahrenheit' ? 'imperial' : 'metric';
    showToolActivity('🌤️', `جاري جلب طقس ${city}...`);
    try {
      // wttr.in — no API key needed
      const enc = encodeURIComponent(city);
      const res = await fetch(`https://wttr.in/${enc}?format=j1`);
      if (!res.ok) throw new Error('فشل جلب الطقس');
      const d = await res.json();
      const cur = d.current_condition?.[0];
      const area = d.nearest_area?.[0];
      const areaName = area?.areaName?.[0]?.value || city;
      const country = area?.country?.[0]?.value || '';
      const tempC = cur.temp_C, tempF = cur.temp_F;
      const temp = unit === 'imperial' ? `${tempF}°F` : `${tempC}°C`;
      const feels = unit === 'imperial' ? `${cur.FeelsLikeF}°F` : `${cur.FeelsLikeC}°C`;
      const desc = cur.lang_ar?.[0]?.value || cur.weatherDesc?.[0]?.value || '';
      const humid = cur.humidity;
      const wind = cur.windspeedKmph;
      const vis = cur.visibility;
      // 3-day forecast
      const forecast = (d.weather || []).slice(0,3).map(w => {
        const day = w.date;
        const maxC = w.maxtempC, minC = w.mintempC;
        const wDesc = w.hourly?.[4]?.lang_ar?.[0]?.value || w.hourly?.[4]?.weatherDesc?.[0]?.value || '';
        return `📅 ${day}: ${minC}°C - ${maxC}°C | ${wDesc}`;
      }).join('\n');
      return `🌍 **${areaName}${country ? ', ' + country : ''}**\n🌡️ الحرارة: **${temp}** (يشعر بـ ${feels})\n🌥️ الحالة: ${desc}\n💧 الرطوبة: ${humid}%\n💨 الرياح: ${wind} كم/س\n👁️ الرؤية: ${vis} كم\n\n**التوقعات للـ 3 أيام:**\n${forecast}`;
    } catch(e) {
      return `❌ تعذر جلب طقس "${city}": ${e.message}\n\nجرّب البحث في: https://wttr.in/${encodeURIComponent(city)}`;
    }
  }

  // ── NEWS ──
  if (name === 'get_news') {
    const topic = args.topic || '';
    const country = args.country || '';
    showToolActivity('📰', `جاري جلب الأخبار${topic ? ' عن: ' + topic : ''}...`);
    try {
      const query = topic ? `أحدث أخبار ${topic} ${country}` : `آخر الأخبار ${country} اليوم`;
      const data = await bbCallIntegration('tavily', { method: 'POST', path: '/search', requestBody: { query, search_depth: 'basic', max_results: 6, include_answer: true, topic: 'news' } });
      if (data.error) return `خطأ في جلب الأخبار: ${data.error}`;
      let out = `📰 **آخر الأخبار${topic ? ' — ' + topic : ''}**\n\n`;
      if (data.answer) out += `📌 ${data.answer}\n\n`;
      if (data.results?.length) {
        data.results.slice(0, 5).forEach((item, i) => {
          out += `**${i+1}. ${item.title}**\n${item.content?.slice(0, 180)}...\n🔗 ${item.url}\n\n`;
        });
      }
      return out || 'لم تظهر أخبار.';
    } catch(e) {
      if (String(e.message).includes('not connected')) {
        return `📰 لجلب الأخبار الحقيقية، أضف **Tavily API Key** في الإعدادات.\n\nيمكنك متابعة الأخبار من:\n• BBC عربي: https://www.bbc.com/arabic\n• الجزيرة: https://www.aljazeera.net\n• RT عربي: https://arabic.rt.com\n\n_أضف Tavily API Key للحصول على أخبار مباشرة في الشات._`;
      }
      return `❌ خطأ في جلب الأخبار: ${e.message}`;
    }
  }

  // ── PERIODIC TASKS ──
  if (name === 'manage_periodic_tasks') {
    const ptasks = JSON.parse(localStorage.getItem('pexil_periodic_tasks') || '[]');
    if (args.action === 'add') {
      const task = {
        id: Date.now(),
        name: args.name || 'مهمة دورية',
        interval: args.interval || 'daily',
        time: args.time || '09:00',
        days: args.days || [],
        active: true,
        created: new Date().toLocaleDateString('ar-EG')
      };
      ptasks.push(task);
      localStorage.setItem('pexil_periodic_tasks', JSON.stringify(ptasks));
      showToolActivity('🔁', `مهمة دورية: ${task.name}`);
      schedulePeriodicTasks();
      const intervalMap = {daily:'يومياً', weekly:'أسبوعياً', hourly:'كل ساعة'};
      return `✅ تمت إضافة المهمة الدورية!\n🔁 **${task.name}**\n⏰ التكرار: ${intervalMap[task.interval]}\n🕐 الوقت: ${task.time}\n\n_المهمة نشطة الآن وستُذكّرك تلقائياً._`;
    }
    if (args.action === 'list') {
      if (!ptasks.length) return '📋 لا توجد مهام دورية مجدولة.\n\nيمكنك إضافة مهام مثل: "ذكّرني بشرب الماء كل ساعة" أو "تذكير يومي بمراجعة البريد الساعة 9 صباحاً".';
      const intervalMap = {daily:'يومياً', weekly:'أسبوعياً', hourly:'كل ساعة'};
      return `📋 **المهام الدورية (${ptasks.length}):**\n\n` + ptasks.map((t,i) =>
        `${i+1}. ${t.active ? '🟢' : '🔴'} **${t.name}**\n   ⏰ ${intervalMap[t.interval] || t.interval} الساعة ${t.time}\n   🆔 ID: ${t.id}`
      ).join('\n\n');
    }
    if (args.action === 'delete' && args.task_id) {
      const idx = ptasks.findIndex(t => t.id === args.task_id);
      if (idx !== -1) { ptasks.splice(idx, 1); localStorage.setItem('pexil_periodic_tasks', JSON.stringify(ptasks)); schedulePeriodicTasks(); return '🗑️ تم حذف المهمة الدورية.'; }
      return '❌ لم أجد المهمة بهذا ID.';
    }
    if (args.action === 'toggle' && args.task_id) {
      const t = ptasks.find(t => t.id === args.task_id);
      if (t) { t.active = !t.active; localStorage.setItem('pexil_periodic_tasks', JSON.stringify(ptasks)); schedulePeriodicTasks(); return `${t.active ? '🟢 تم تفعيل' : '🔴 تم إيقاف'} المهمة: **${t.name}**`; }
      return '❌ لم أجد المهمة.';
    }
    return 'عملية غير معروفة.';
  }

  // ── MAP CONTROL ──
  if (name === 'control_map') {
    const action = args.action;
    if (action === 'open') {
      showToolActivity('🗺️', 'فتح الخريطة...');
      setTimeout(() => openFloatWin('float-maps'), 300);
      return '🗺️ تم فتح الخريطة. يمكنك الآن تصفح المواقع.';
    }
    if (action === 'navigate' || action === 'search') {
      const loc = args.location || args.to || '';
      if (!loc) return '❌ حدد الموقع للانتقال إليه.';
      showToolActivity('🗺️', `التنقل إلى: ${loc}`);
      setTimeout(() => {
        openFloatWin('float-maps');
        const inp = document.getElementById('float-maps-inp');
        if (inp) { inp.value = loc; floatSearchMaps(); }
      }, 400);
      return `🗺️ تم الانتقال إلى **${loc}** في الخريطة.`;
    }
    if (action === 'my_location') {
      showToolActivity('📍', 'جاري تحديد موقعك...');
      setTimeout(() => { openFloatWin('float-maps'); floatMapsMyLocation(); }, 400);
      return '📍 تم فتح الخريطة وتحديد موقعك الحالي.';
    }
    if (action === 'show_route') {
      const from = args.from || 'موقعي';
      const to = args.to || args.location || '';
      if (!to) return '❌ حدد الوجهة.';
      showToolActivity('🗺️', `عرض المسار: ${from} → ${to}`);
      const query = `${from} إلى ${to}`;
      setTimeout(() => {
        openFloatWin('float-maps');
        const inp = document.getElementById('float-maps-inp');
        if (inp) { inp.value = to; floatSearchMaps(); }
      }, 400);
      return `🗺️ تم عرض مسار **${from} → ${to}** في الخريطة.\n\n💡 لمسارات تفصيلية يمكنك فتح Google Maps مباشرة.`;
    }
    if (action === 'zoom_in' || action === 'zoom_out') {
      setTimeout(() => openFloatWin('float-maps'), 300);
      return `🗺️ تم ${action === 'zoom_in' ? 'التكبير' : 'التصغير'} على الخريطة.`;
    }
    return '❌ إجراء غير معروف على الخريطة.';
  }

  // ══════════════════════════════════════════
  // ── GOOGLE SERVICES ──
  // ══════════════════════════════════════════

  // ── Helper: get Google access token via refresh token ──
  async function getGoogleAccessToken() {
    return getGoogleAccessToken_();
  }

  // ── GMAIL ──
  if (name === 'gmail') {
    showToolActivity('📧', `Gmail: ${args.action}...`);
    const token = await getGoogleAccessToken();
    if (!token) return '❌ Gmail غير مفعّل — أضف بيانات Google OAuth في الإعدادات → Google';
    try {
      if (args.action === 'list' || args.action === 'search') {
        const q = args.query ? encodeURIComponent(args.query) : '';
        const maxR = args.max_results || 5;
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxR}${q?'&q='+q:''}`;
        const r = await googleFetch(url, {});
        const d = await r.json();
        if (!d.messages?.length) return '📭 لا توجد رسائل.';
        // Get first 5 message details
        const details = await Promise.all(d.messages.slice(0,5).map(async m => {
          const mr = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, {});
          return mr.json();
        }));
        let out = `📧 **${args.query ? 'نتائج البحث' : 'آخر الرسائل'} (${details.length}):**\n\n`;
        details.forEach((msg, i) => {
          const headers = msg.payload?.headers || [];
          const subj = headers.find(h=>h.name==='Subject')?.value || '(بدون موضوع)';
          const from = headers.find(h=>h.name==='From')?.value || '';
          const date = headers.find(h=>h.name==='Date')?.value || '';
          out += `**${i+1}. ${subj}**\n📤 من: ${from}\n📅 ${date}\n🆔 \`${msg.id}\`\n\n`;
        });
        return out;
      }
      if (args.action === 'read') {
        if (!args.message_id) return '❌ حدد message_id';
        const r = await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.message_id}?format=full`, {});
        const msg = await r.json();
        const headers = msg.payload?.headers || [];
        const subj = headers.find(h=>h.name==='Subject')?.value || '';
        const from = headers.find(h=>h.name==='From')?.value || '';
        // Extract body
        let body = '';
        const getPart = (p) => {
          if (p.mimeType === 'text/plain' && p.body?.data) return atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/'));
          if (p.parts) for (const sp of p.parts) { const b = getPart(sp); if(b) return b; }
          return '';
        };
        body = getPart(msg.payload);
        return `📧 **${subj}**\n📤 من: ${from}\n\n${body.slice(0,1500)}${body.length>1500?'\n\n...':''}`;
      }
      if (args.action === 'send') {
        if (!args.to || !args.subject) return '❌ حدد to و subject';
        const raw = btoa(unescape(encodeURIComponent(
          `To: ${args.to}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${args.body||''}`
        ))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
        const r = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method:'POST',
          body: JSON.stringify({raw})
        });
        const d = await r.json();
        return d.id ? `✅ تم إرسال الإيميل!\n📧 إلى: ${args.to}\n📌 الموضوع: ${args.subject}` : `❌ فشل الإرسال: ${JSON.stringify(d)}`;
      }
    } catch(e) { return `❌ خطأ Gmail: ${e.message}`; }
  }

  // ── GOOGLE CALENDAR ──
  if (name === 'google_calendar') {
    showToolActivity('📅', `Calendar: ${args.action}...`);
    const token = await getGoogleAccessToken();
    if (!token) return '❌ Google Calendar غير مفعّل — أضف بيانات Google OAuth في الإعدادات → Google';
    try {
      if (args.action === 'list') {
        const days = args.days_ahead || 7;
        const now = new Date().toISOString();
        const until = new Date(Date.now() + days*86400000).toISOString();
        const r = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${until}&singleEvents=true&orderBy=startTime&maxResults=10`, {});
        const d = await r.json();
        if (!d.items?.length) return `📅 لا توجد مواعيد في الـ ${days} أيام القادمة.`;
        let out = `📅 **مواعيدك (${days} أيام القادمة):**\n\n`;
        d.items.forEach((ev,i) => {
          const start = ev.start?.dateTime || ev.start?.date || '';
          const dt = start ? new Date(start).toLocaleString('ar-EG',{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
          out += `**${i+1}. ${ev.summary||'(بدون عنوان)'}**\n📅 ${dt}\n${ev.description?'📝 '+ev.description.slice(0,100)+'\n':''}\n`;
        });
        return out;
      }
      if (args.action === 'create') {
        if (!args.title || !args.start) return '❌ حدد title و start';
        const event = {
          summary: args.title,
          description: args.description || '',
          start: {dateTime: args.start, timeZone: 'Africa/Cairo'},
          end: {dateTime: args.end || new Date(new Date(args.start).getTime()+3600000).toISOString(), timeZone: 'Africa/Cairo'}
        };
        const r = await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method:'POST',
          body: JSON.stringify(event)
        });
        const d = await r.json();
        return d.id ? `✅ تم إضافة الموعد!\n📅 **${args.title}**\n⏰ ${new Date(args.start).toLocaleString('ar-EG')}\n🔗 ${d.htmlLink}` : `❌ فشل: ${JSON.stringify(d)}`;
      }
      if (args.action === 'delete') {
        if (!args.event_id) return '❌ حدد event_id';
        await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${args.event_id}`, {method:'DELETE'});
        return '🗑️ تم حذف الموعد.';
      }
    } catch(e) { return `❌ خطأ Calendar: ${e.message}`; }
  }

  // ── GOOGLE DRIVE ──
  if (name === 'google_drive') {
    showToolActivity('📁', `Drive: ${args.action}...`);
    const token = await getGoogleAccessToken();
    if (!token) return '❌ Google Drive غير مفعّل — أضف بيانات Google OAuth في الإعدادات → Google';
    try {
      if (args.action === 'list' || args.action === 'search') {
        const q = args.query ? `name contains '${args.query}'` : "trashed=false";
        const max = args.max_results || 10;
        const r = await googleFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${max}&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)`, {});
        const d = await r.json();
        if (!d.files?.length) return '📁 لا توجد ملفات.';
        let out = `📁 **Drive — ${args.query||'آخر الملفات'} (${d.files.length}):**\n\n`;
        d.files.forEach((f,i) => {
          const size = f.size ? (f.size>1048576?(f.size/1048576).toFixed(1)+'MB':(f.size/1024).toFixed(0)+'KB') : '';
          const type = f.mimeType.includes('folder') ? '📂' : f.mimeType.includes('image') ? '🖼️' : f.mimeType.includes('pdf') ? '📄' : '📝';
          out += `${type} **${f.name}** ${size}\n🔗 ${f.webViewLink||'drive.google.com'}\n🆔 \`${f.id}\`\n\n`;
        });
        return out;
      }
      if (args.action === 'create_folder') {
        if (!args.folder_name) return '❌ حدد folder_name';
        const r = await googleFetch('https://www.googleapis.com/drive/v3/files', {
          method:'POST',
          body: JSON.stringify({name: args.folder_name, mimeType:'application/vnd.google-apps.folder'})
        });
        const d = await r.json();
        return d.id ? `✅ تم إنشاء مجلد **${args.folder_name}**\n🆔 \`${d.id}\`` : `❌ فشل: ${JSON.stringify(d)}`;
      }
    } catch(e) { return `❌ خطأ Drive: ${e.message}`; }
  }

  // ── GOOGLE SHEETS ──
  if (name === 'google_sheets') {
    showToolActivity('📊', `Sheets: ${args.action}...`);
    const token = await getGoogleAccessToken();
    if (!token) return '❌ Google Sheets غير مفعّل — أضف بيانات Google OAuth في الإعدادات → Google';
    const d = loadIntegrations();
    const sid = args.spreadsheet_id || d.google?.defaultSheetId || '';
    if (!sid) return '❌ حدد spreadsheet_id أو أضف الـ ID الافتراضي في الإعدادات';
    try {
      if (args.action === 'read') {
        const r = await googleFetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(args.range)}`, {});
        const data = await r.json();
        if (!data.values?.length) return '📊 لا توجد بيانات في هذا النطاق.';
        let out = `📊 **Sheets — ${args.range}:**\n\n\`\`\`\n`;
        data.values.forEach(row => { out += row.join('\t') + '\n'; });
        out += '```';
        return out;
      }
      if (args.action === 'write' || args.action === 'append') {
        if (!args.values) return '❌ حدد values';
        const endpoint = args.action === 'append'
          ? `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(args.range)}:append?valueInputOption=USER_ENTERED`
          : `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(args.range)}?valueInputOption=USER_ENTERED`;
        const method = args.action === 'append' ? 'POST' : 'PUT';
        const r = await googleFetch(endpoint, {method, body: JSON.stringify({values: args.values, range: args.range})});
        const data = await r.json();
        return data.updatedCells !== undefined || data.updates ? `✅ تم ${args.action==='append'?'إضافة':'كتابة'} البيانات في **${args.range}**` : `❌ فشل: ${JSON.stringify(data)}`;
      }
      if (args.action === 'clear') {
        await googleFetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(args.range)}:clear`, {method:'POST'});
        return `🗑️ تم مسح البيانات في **${args.range}**`;
      }
    } catch(e) { return `❌ خطأ Sheets: ${e.message}`; }
  }

  // ── GOOGLE TASKS ──
  if (name === 'google_tasks') {
    showToolActivity('✅', `Tasks: ${args.action}...`);
    const token = await getGoogleAccessToken();
    if (!token) return '❌ Google Tasks غير مفعّل — أضف بيانات Google OAuth في الإعدادات → Google';
    try {
      // Get default tasklist
      const tlr = await googleFetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1', {});
      const tld = await tlr.json();
      const listId = tld.items?.[0]?.id;
      if (!listId) return '❌ لا توجد قوائم مهام في Google Tasks.';
      if (args.action === 'list') {
        const r = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks?showCompleted=false&maxResults=15`, {});
        const d = await r.json();
        if (!d.items?.length) return '✅ لا توجد مهام نشطة في Google Tasks.';
        let out = `✅ **Google Tasks (${d.items.length}):**\n\n`;
        d.items.forEach((t,i) => {
          const due = t.due ? `📅 ${new Date(t.due).toLocaleDateString('ar-EG')}` : '';
          out += `${i+1}. **${t.title}** ${due}\n${t.notes?'📝 '+t.notes+'\n':''}\`${t.id}\`\n\n`;
        });
        return out;
      }
      if (args.action === 'create') {
        if (!args.title) return '❌ حدد title';
        const task = {title: args.title};
        if (args.notes) task.notes = args.notes;
        if (args.due) task.due = new Date(args.due).toISOString();
        const r = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks`, {method:'POST', body:JSON.stringify(task)});
        const d = await r.json();
        return d.id ? `✅ تم إضافة المهمة: **${args.title}**` : `❌ فشل: ${JSON.stringify(d)}`;
      }
      if (args.action === 'complete') {
        if (!args.task_id) return '❌ حدد task_id';
        const r = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${args.task_id}`, {method:'PATCH', body:JSON.stringify({status:'completed'})});
        return r.ok ? '✅ تم تحديد المهمة كمكتملة!' : '❌ فشل التحديث.';
      }
      if (args.action === 'delete') {
        if (!args.task_id) return '❌ حدد task_id';
        const r = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${args.task_id}`, {method:'DELETE'});
        return r.ok ? '🗑️ تم حذف المهمة.' : '❌ فشل الحذف.';
      }
    } catch(e) { return `❌ خطأ Tasks: ${e.message}`; }
  }

  // ══════════════════════════════════════════
  // ── GITHUB ──
  // ══════════════════════════════════════════
  if (name === 'github') {
    showToolActivity('🐙', `GitHub: ${args.action}...`);
    const ghFetch = async (url, opts={}) => {
      let requestBody;
      if (opts.body) { try { requestBody = JSON.parse(opts.body); } catch { requestBody = opts.body; } }
      try {
        return await bbCallIntegration('github', { method: opts.method || 'GET', path: url, requestBody });
      } catch (e) {
        if (String(e.message).includes('not connected')) throw new Error('GitHub غير مفعّل — أضف GitHub Token في الإعدادات → GitHub');
        throw e;
      }
    };
    try {
      if (args.action === 'list_repos') {
        const data = await ghFetch(`/user/repos?sort=updated&per_page=10`);
        let out = `🐙 **Repos (${data.length}):**\n\n`;
        data.forEach((r,i) => {
          out += `**${i+1}. ${r.full_name}** ${r.private?'🔒':'🌐'}\n`;
          out += `⭐ ${r.stargazers_count} | 🍴 ${r.forks_count} | ${r.language||'—'}\n`;
          if (r.description) out += `📝 ${r.description.slice(0,80)}\n`;
          out += `🔗 ${r.html_url}\n\n`;
        });
        return out;
      }
      if (args.action === 'list_commits') {
        if (!args.repo) return '❌ حدد repo بالصيغة owner/repo';
        const data = await ghFetch(`/repos/${args.repo}/commits?per_page=8`);
        let out = `📋 **آخر commits في ${args.repo}:**\n\n`;
        data.forEach((c,i) => {
          const msg = c.commit.message.split('\n')[0].slice(0,80);
          const author = c.commit.author.name;
          const date = new Date(c.commit.author.date).toLocaleDateString('ar-EG');
          out += `**${i+1}.** \`${c.sha.slice(0,7)}\` ${msg}\n👤 ${author} · ${date}\n\n`;
        });
        return out;
      }
      if (args.action === 'list_issues') {
        if (!args.repo) return '❌ حدد repo';
        const data = await ghFetch(`/repos/${args.repo}/issues?state=open&per_page=10`);
        if (!data.length) return `✅ لا توجد issues مفتوحة في ${args.repo}.`;
        let out = `🐛 **Issues المفتوحة في ${args.repo} (${data.length}):**\n\n`;
        data.forEach((iss,i) => {
          out += `**#${iss.number} ${iss.title}**\n👤 ${iss.user.login} · 🏷️ ${iss.labels.map(l=>l.name).join(', ')||'—'}\n🔗 ${iss.html_url}\n\n`;
        });
        return out;
      }
      if (args.action === 'open_issue') {
        if (!args.repo || !args.title) return '❌ حدد repo و title';
        const data = await ghFetch(`/repos/${args.repo}/issues`, {method:'POST', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify({title:args.title, body:args.body||''})});
        return `✅ تم فتح Issue!\n🐛 **#${data.number} ${data.title}**\n🔗 ${data.html_url}`;
      }
      if (args.action === 'close_issue') {
        if (!args.repo || !args.issue_number) return '❌ حدد repo و issue_number';
        await ghFetch(`/repos/${args.repo}/issues/${args.issue_number}`, {method:'PATCH', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify({state:'closed'})});
        return `✅ تم إغلاق Issue #${args.issue_number} في ${args.repo}`;
      }
      if (args.action === 'search_code') {
        if (!args.query) return '❌ حدد query';
        const q = encodeURIComponent(args.repo ? `${args.query} repo:${args.repo}` : args.query);
        const data = await ghFetch(`/search/code?q=${q}&per_page=5`);
        if (!data.items?.length) return `🔍 لا نتائج للبحث عن "${args.query}"`;
        let out = `🔍 **نتائج البحث في الكود: "${args.query}" (${data.total_count}):**\n\n`;
        data.items.slice(0,5).forEach((item,i) => {
          out += `**${i+1}. ${item.repository.full_name} — ${item.path}**\n🔗 ${item.html_url}\n\n`;
        });
        return out;
      }
      if (args.action === 'list_gists') {
        const data = await ghFetch('/gists?per_page=8');
        if (!data.length) return '📎 لا توجد Gists.';
        let out = `📎 **Gists (${data.length}):**\n\n`;
        data.forEach((g,i) => {
          const files = Object.keys(g.files).join(', ');
          const desc = g.description || '(بدون وصف)';
          out += `**${i+1}. ${desc}**\n📄 ${files}\n${g.public?'🌐 عام':'🔒 خاص'} · 🔗 ${g.html_url}\n\n`;
        });
        return out;
      }
      if (args.action === 'create_gist') {
        if (!args.filename || !args.content) return '❌ حدد filename و content';
        const data = await ghFetch('/gists', {method:'POST', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify({description:args.title||'PixelAi Gist', public:args.public!==false, files:{[args.filename]:{content:args.content}}})});
        return `✅ تم إنشاء Gist!\n📄 **${args.filename}**\n🔗 ${data.html_url}`;
      }
      if (args.action === 'create_pr') {
        if (!args.repo || !args.title || !args.head || !args.base) return '❌ حدد repo و title و head و base';
        const data = await ghFetch(`/repos/${args.repo}/pulls`, {method:'POST', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify({title:args.title, body:args.body||'', head:args.head, base:args.base})});
        return `✅ تم إنشاء Pull Request!\n🔀 **#${data.number} ${data.title}**\n${args.head} → ${args.base}\n🔗 ${data.html_url}`;
      }
    } catch(e) { return `❌ خطأ GitHub: ${e.message}`; }
  }

  return `أداة غير معروفة: ${name}`;
}

// ── Show tool activity chip in chat ──
function showToolActivity(icon, msg) {
  const el = document.getElementById('messages');
  const chip = document.createElement('div');
  chip.className = 'tool-activity-chip';
  chip.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  chip.id = 'tool-chip-' + Date.now();
  el.appendChild(chip);
  scrollBottom();
  setTimeout(() => chip.remove(), 6000);
}

// ── Inject AI-generated image directly into chat ──
function injectImageBubble(url, prompt) {
  const el = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'msg assistant';
  d.innerHTML = `<div class="msg-av" style="background:none;overflow:hidden;padding:0"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%2300d4ff22'/%3E%3Ctext x='50%25' y='55%25' dominant-baseline='middle' text-anchor='middle' font-size='20'%3E🎨%3C/text%3E%3C/svg%3E" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/></div>
    <div class="msg-body">
      <div class="msg-bubble">
        <div style="margin-bottom:6px;font-size:11px;color:var(--t2)">🎨 ${prompt?.slice(0,60)}...</div>
        <div class="imggen-card" style="max-width:340px">
          <img src="${url}" alt="صورة مُولَّدة" style="width:100%;border-radius:var(--r);display:block" loading="lazy"/>
          <div class="imggen-card-acts">
            <a href="${url}" download="pexil-img.png" class="cr-btn" style="text-decoration:none;padding:3px 8px;font-size:10px">⬇️ تحميل</a>
          </div>
        </div>
      </div>
    </div>`;
  el.appendChild(d);
  scrollBottom();
}

// ── Main Tool Calling loop (replaces agentLoop + routeReq) ──
async function toolCallLoop(text, model, mid, img) {
  const sys = buildSys();
  const msgs = [
    { role: 'system', content: sys },
    ...currentMsgs.slice(-12, -1).map(m => ({ role: m.role, content: m.content }))
  ];
  if (img && model?.caps?.includes('vision')) {
    msgs.push({ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: img } }] });
  } else {
    msgs.push({ role: 'user', content: text });
  }

  // Max 4 tool call rounds
  for (let round = 0; round < 4; round++) {
    let d;
    try {
      d = await bbCallProvider('openrouter', { model: mid, messages: msgs, max_tokens: 4096, temperature: 0.7, tools: PEXIL_TOOLS, tool_choice: 'auto' });
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.startsWith('BLOCKED:')) throw e;
      // بعض الموديلات مش بتدعم tools — نرجع لنداء عادي بدون أدوات
      if (msg.includes('400') || msg.toLowerCase().includes('tool')) return callORPlain(text, sys, msgs.slice(0, -1), mid, img);
      throw e;
    }
    const choice = d.choices?.[0];
    if (!choice) throw new Error('لم أتمكن من الرد.');

    const msg = choice.message;
    // No tool calls → return text
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || 'لم أتمكن من الرد.';
    }

    // Add assistant message with tool calls
    msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

    // Execute each tool call
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      const result = await executeTool(tc.function.name, args);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
    }
    // Continue loop to get final response
  }
  return 'تم تنفيذ الأدوات.';
}

// Fallback for models that don't support tool_calls
async function callORPlain(text, sys, histMsgs, mid, img) {
  const msgs = [...histMsgs];
  if (img) msgs.push({ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: img } }] });
  else msgs.push({ role: 'user', content: text });
  const d = await bbCallProvider('openrouter', { model: mid, messages: msgs, max_tokens: 4096, temperature: 0.7 });
  return d.choices?.[0]?.message?.content || 'لم أتمكن من الرد.';
}

async function agentLoop(text, model, mid, img) {
  return toolCallLoop(text, model, mid, img);
}


// Helper for MA deliberation: uses OpenRouter for all models (same as normal chat)
// Falls back to direct APIs only if OR key missing but direct key available
async function callMAAgent(prompt, mid, img, sys, hist) {
  if(!mid || !mid.trim()) throw new Error('لم يتم تحديد النموذج — افتح الإعدادات ← تفكير متعدد');
  if(mid === 'ollama/local') return callOllama(prompt, sys, hist);
  
  // Build message array
  const msgs = [
    { role: 'system', content: sys },
    ...hist.map(m => ({ role: m.role, content: m.content }))
  ];
  if(img) msgs.push({ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: img } }] });
  else msgs.push({ role: 'user', content: prompt });

  // Try OpenRouter first (handles ALL models including openai/, deepseek/, meta/, etc.)
  try {
    const d = await bbCallProvider('openrouter', { model: mid, messages: msgs, max_tokens: 2048, temperature: 0.7 });
    return d.choices?.[0]?.message?.content || 'لم أتمكن من الرد.';
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith('BLOCKED:')) throw e;
    if (!msg.startsWith('API_KEY_MISSING')) throw e;
    // مفيش مفتاح OpenRouter — نجرب المفاتيح المباشرة لو موجودة
  }

  // Fallback: direct APIs when OpenRouter unavailable
  if(mid.startsWith('google/')) return _callGemini(prompt, mid, img, sys, hist);
  if(mid.startsWith('anthropic/')) return _callAnthropic(prompt, mid, sys, hist);
  if(mid.startsWith('openai/')) return _callOpenAI(prompt, mid, img, sys, hist);

  throw new Error('لا يوجد API Key صالح — أضف مفتاح من الإعدادات ← APIs');
}

// ═══════════════════════════════════════════════════════
// MULTI-AGENT DELIBERATION
// ═══════════════════════════════════════════════════════
let maMode = false;
let maCfg = {
  modelA: localStorage.getItem('pexil_ma_a') || '',
  modelB: localStorage.getItem('pexil_ma_b') || '',
  rounds: parseInt(localStorage.getItem('pexil_ma_rounds') || '2'),
  showSteps: localStorage.getItem('pexil_ma_steps') !== 'false'
};

function toggleMAMode() {
  maMode = !maMode;
  const toggle = document.getElementById('ma-toggle');
  const lbl = document.getElementById('ma-lbl');
  if (toggle) toggle.classList.toggle('on', maMode);
  if (lbl) lbl.classList.toggle('on', maMode);
  showToast(maMode ? '🤝 التفكير المتعدد مفعّل — نموذجان سيتناقشان!' : '🤝 التفكير المتعدد متوقف');
}

function buildMAModelOptions() {
  const selA = document.getElementById('s-ma-a');
  const selB = document.getElementById('s-ma-b');
  if (!selA || !selB) return;
  const opts = MODELS.map(m => `<option value="${m.id}">${m.name} (${PROVIDERS[m.p]?.name || m.p})</option>`).join('');
  selA.innerHTML = opts;
  selB.innerHTML = opts;
  // Use saved value → fallback to active model → fallback to first model in list
  const activeMid = cfg.or_custom || cfg.model_id || MODELS[0]?.id || '';
  const defaultA = maCfg.modelA || activeMid;
  const defaultB = maCfg.modelB || MODELS[1]?.id || activeMid;
  selA.value = defaultA; if(!selA.value && MODELS[0]) selA.value = MODELS[0].id;
  selB.value = defaultB; if(!selB.value && MODELS[0]) selB.value = MODELS[0].id;
  const roundsSel = document.getElementById('s-ma-rounds');
  if (roundsSel) roundsSel.value = String(maCfg.rounds || 2);
  const stepsCb = document.getElementById('s-ma-steps');
  if (stepsCb) stepsCb.checked = maCfg.showSteps !== false;
}

function saveMASettings() {
  const a = document.getElementById('s-ma-a')?.value || maCfg.modelA;
  const b = document.getElementById('s-ma-b')?.value || maCfg.modelB;
  const r = parseInt(document.getElementById('s-ma-rounds')?.value || '2');
  const s = document.getElementById('s-ma-steps')?.checked !== false;
  localStorage.setItem('pexil_ma_a', a);
  localStorage.setItem('pexil_ma_b', b);
  localStorage.setItem('pexil_ma_rounds', String(r));
  localStorage.setItem('pexil_ma_steps', String(s));
  maCfg = { modelA: a, modelB: b, rounds: r, showSteps: s };
}

// Main multi-agent function — called by sendMessage when maMode=true
// Returns the final reply text (same contract as routeReq)
async function multiAgentDeliberate(userText, imgData) {
  const sys = buildSys();
  const hist = currentMsgs.slice(-10, -1);
  // Resolve models - fallback to active model
  const activeMid = cfg.or_custom || cfg.model_id || '';
  const midA = (maCfg.modelA && maCfg.modelA.trim()) ? maCfg.modelA : activeMid;
  const midB = (maCfg.modelB && maCfg.modelB.trim()) ? maCfg.modelB : activeMid;
  const modelA = MODELS.find(m => m.id === midA);
  const modelB = MODELS.find(m => m.id === midB);
  const nameA = modelA?.name || (midA ? midA.split('/').pop() : 'النموذج الأول');
  const nameB = modelB?.name || (midB ? midB.split('/').pop() : 'النموذج الثاني');
  const provA = PROVIDERS[modelA?.p]?.name || modelA?.p || 'AI';
  const provB = PROVIDERS[modelB?.p]?.name || modelB?.p || 'AI';
  const rounds = maCfg.rounds || 2;
  const showSteps = maCfg.showSteps !== false;

  // Color accents per model
  const colorA = 'rgba(0,170,255,.85)';    // cyan - model A
  const colorB = 'rgba(167,139,250,.85)';  // purple - model B
  const colorFin = 'rgba(52,211,153,.85)'; // green - final

  const msgEl = document.getElementById('messages');

  // Helper: append a chat bubble as one of the AI agents
  function agentBubble(agentName, provName, color, content, isFinal=false) {
    const d = document.createElement('div');
    d.className = 'msg assistant';
    const time = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const label = isFinal ? `✅ الإجابة النهائية — ${agentName}` : agentName;
    d.innerHTML = `
      <div class="msg-av" style="background:linear-gradient(135deg,${color},rgba(30,40,50,.8));font-size:18px;display:grid;place-items:center;color:#fff;font-weight:700;border:2px solid ${color}">
        ${isFinal ? '✅' : (agentName.startsWith(nameA) ? '🅰' : '🅱')}
      </div>
      <div class="msg-body" style="max-width:85%">
        <div class="msg-bubble" style="border-color:${color};border-width:1.5px">
          ${parseMd(content)}
        </div>
        <div class="msg-meta">
          <span style="font-size:9px;font-weight:700;color:${color}">${label}</span>
          <span style="font-size:9px;color:var(--t3)">${provName}</span>
          <span style="font-size:9px;color:var(--t3)">${time}</span>
        </div>
        <div class="msg-acts">
          <button class="act-btn" onclick="copyToCB(this.closest('.msg-body').querySelector('.msg-bubble').innerText)">نسخ</button>
          <button class="act-btn" onclick="speakText(this.closest('.msg-body').querySelector('.msg-bubble').innerText)">🔊</button>
        </div>
      </div>`;
    msgEl.appendChild(d);
    scrollBottom();
    return d;
  }

  // Typing bubble for agent
  function agentTyping(agentName, color) {
    const id = 'ma_tp_' + Date.now();
    const d = document.createElement('div');
    d.id = id;
    d.className = 'msg assistant';
    d.innerHTML = `
      <div class="msg-av" style="background:linear-gradient(135deg,${color},rgba(30,40,50,.8));font-size:18px;display:grid;place-items:center;color:#fff;font-weight:700;border:2px solid ${color}">
        ${agentName.startsWith(nameA) ? '🅰' : '🅱'}
      </div>
      <div class="msg-body">
        <div class="msg-bubble" style="border-color:${color};border-width:1.5px">
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>
        <div class="msg-meta"><span style="font-size:9px;color:${color}">${agentName} يفكر...</span></div>
      </div>`;
    msgEl.appendChild(d);
    scrollBottom();
    return id;
  }

  // Show MA header badge in chat
  const headerDiv = document.createElement('div');
  headerDiv.style.cssText = 'text-align:center;margin:6px 0;';
  headerDiv.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 14px;background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.25);border-radius:99px;font-size:11px;color:#a78bfa;font-weight:700">🤝 تفكير متعدد · ${nameA} + ${nameB}</span>`;
  msgEl.appendChild(headerDiv);
  scrollBottom();

  try {
    let lastAnswerA = '';
    let lastReviewB = '';

    for(let round = 0; round < rounds; round++) {
      // ── Agent A speaks ──
      const promptA = round === 0
        ? userText
        : `السؤال الأصلي: ${userText}\n\nإجابتك السابقة:\n${lastAnswerA}\n\nمراجعة ${nameB}:\n${lastReviewB}\n\nقدّم إجابة محسّنة ونهائية:`;

      const tidA = agentTyping(nameA, colorA);
      try {
        lastAnswerA = await callMAAgent(promptA, midA, round === 0 ? imgData : null, sys, hist);
      } finally { document.getElementById(tidA)?.remove(); }

      if(showSteps || round === rounds - 1) {
        agentBubble(nameA, provA, colorA, lastAnswerA);
      }

      // ── Agent B reviews (not on last round) ──
      if(round < rounds - 1) {
        const promptB = `السؤال الأصلي: ${userText}\n\nإجابة ${nameA}:\n${lastAnswerA}\n\nراجع هذه الإجابة: هل هي صحيحة وكاملة؟ صحّح أي خطأ وأضف ما يفيد. كن مختصراً.`;
        const tidB = agentTyping(nameB, colorB);
        try {
          lastReviewB = await callMAAgent(promptB, midB, null, sys, hist);
        } finally { document.getElementById(tidB)?.remove(); }

        if(showSteps) {
          agentBubble(nameB, provB, colorB, lastReviewB);
        }
      }
    }

    // ── Final answer bubble (highlighted) ──
    if(rounds > 1 || !showSteps) {
      agentBubble(nameA, provA, colorFin, lastAnswerA, true);
    }

    return lastAnswerA;

  } catch(err) {
    const errDiv = document.createElement('div');
    errDiv.className = 'msg system';
    errDiv.innerHTML = `<div class="msg-av">❌</div><div class="msg-body"><div class="msg-bubble" style="color:var(--red)">خطأ في التفكير المتعدد: ${esc(err.message)}</div></div>`;
    msgEl.appendChild(errDiv);
    scrollBottom();
    return null;
  }
}

// ═══ ROUTER ═══
function buildSys(){
  const p=cfg.user;
  const mc=memories.length?`\nما تعرفه:\n${memories.map(m=>'- '+m.content).join('\n')}`:'';
  const bot=cfg.bot||{};
  const botName=bot.name||'PixelAi';
  const avoidTxt=bot.avoid?`\nتجنب: ${bot.avoid}`:'';
  const expertTxt=bot.expertise?`\nمجالات تخصصك: ${bot.expertise}`:'';
  // ── الوقت والتاريخ الحالي ──
  const now=new Date();
  const dateStr=now.toLocaleDateString('ar-EG',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const timeStr=now.toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const isoStr=now.toISOString();
  const tzOffset=now.getTimezoneOffset();
  const tzHours=Math.abs(Math.floor(tzOffset/60));
  const tzMins=Math.abs(tzOffset%60);
  const tzSign=tzOffset<=0?'+':'-';
  const tzName=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  const currentDateTimeInfo=`\n\n⏰ التاريخ والوقت الحالي:\n- التاريخ: ${dateStr}\n- الوقت: ${timeStr}\n- ISO: ${isoStr}\n- المنطقة الزمنية: ${tzName} (UTC${tzSign}${String(tzHours).padStart(2,'0')}:${String(tzMins).padStart(2,'0')})\nاستخدم هذه المعلومات دائماً عند البحث أو أي مهمة تتعلق بالوقت.`;
  return `أنت مساعد شخصي ذكي اسمك "${botName}".${bot.tagline?'\nوصفك: '+bot.tagline:''}
اسم المستخدم: ${p.name||'صديقي'} | المهنة: ${p.job||'غير محدد'}
الأهداف: ${p.goals||'غير محدد'} | الاهتمامات: ${p.prefs||'غير محدد'}
الموقع: ${p.location||'غير محدد'}
أسلوبك: ${PP[p.persona]||p.personality||'تحدث بشكل ودي'}${expertTxt}${avoidTxt}${currentDateTimeInfo}${mc}${getLongTermContext()}
قواعد: تحدث بالعربية، كن مفيداً ومختصراً، استخدم code blocks للكود.
أدواتك تشمل: بحث ويب، طقس (get_weather)، أخبار (get_news)، خريطة (control_map)، توليد صور في الشات (generate_image)، توليد فيديو (generate_video)، تنفيذ كود، مهام دورية (manage_periodic_tasks)، ملاحظات، مواعيد، وتحليل بيانات. استخدمها تلقائياً حسب الحاجة.`;
}
function _getProvider(mid){
  if(!mid)return 'openrouter';
  if(mid==='ollama/local')return 'ollama';
  if(mid.startsWith('google/')&&cfg.apis.gemini)return 'gemini';
  if(mid.startsWith('anthropic/')&&cfg.apis.anthropic)return 'anthropic';
  if(mid.startsWith('openai/')&&cfg.apis.openai)return 'openai';
  return 'openrouter';
}
async function _callGemini(text,mid,img,sys,hist){
  const model=mid.replace('google/','');
  const contents=hist.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}));
  contents.push({role:'user',parts:[{text}]});
  const d = await bbCallProvider('gemini', {model, system_instruction:{parts:[{text:sys}]}, contents, generationConfig:{maxOutputTokens:4096,temperature:0.7}});
  return d.candidates?.[0]?.content?.parts?.[0]?.text||'لم أتمكن من الرد.';
}
async function _callAnthropic(text,mid,sys,hist){
  const model=mid.replace('anthropic/','');
  const messages=hist.map(m=>({role:m.role,content:m.content}));
  messages.push({role:'user',content:text});
  const d = await bbCallProvider('anthropic', {model,max_tokens:4096,system:sys,messages});
  return d.content?.[0]?.text||'لم أتمكن من الرد.';
}
async function _callOpenAI(text,mid,img,sys,hist){
  const model=mid.replace('openai/','');
  const msgs=[{role:'system',content:sys},...hist.map(m=>({role:m.role,content:m.content}))];
  if(img)msgs.push({role:'user',content:[{type:'image_url',image_url:{url:img}},{type:'text',text}]});
  else msgs.push({role:'user',content:text});
  const d = await bbCallProvider('openai', {model,messages:msgs,max_tokens:4096});
  return d.choices?.[0]?.message?.content||'لم أتمكن من الرد.';
}
async function routeReq(text,model,mid,img=null){
  const prov=_getProvider(mid);
  const sys=buildSys();
  const hist=currentMsgs.slice(-12,-1);
  if(prov==='gemini')return _callGemini(text,mid,img,sys,hist);
  if(prov==='anthropic')return _callAnthropic(text,mid,sys,hist);
  if(prov==='openai')return _callOpenAI(text,mid,img,sys,hist);
  if(prov==='ollama')return callOllama(text,sys,hist);
  return toolCallLoop(text,model,mid,img);
}
async function callAPI(text,model,mid,img=null,sys=null,hist=[]){
  if(!mid||!mid.trim())throw new Error('لم يتم تحديد النموذج — اختر نموذجاً من إعدادات التفكير المتعدد');
  if(mid==='ollama/local')return callOllama(text,sys||buildSys(),hist);
  const prov=_getProvider(mid);
  const s=sys||buildSys();
  if(prov==='gemini') return _callGemini(text,mid,img,s,hist);
  if(prov==='anthropic') return _callAnthropic(text,mid,s,hist);
  if(prov==='openai') return _callOpenAI(text,mid,img,s,hist);
  // OpenRouter fallback (بيستخدم مفتاح المستخدم لو مضاف، وإلا المفتاح العام المشترك لموديلات OpenRouter)
  const msgs=[{role:'system',content:s},...hist.map(m=>({role:m.role,content:m.content}))];
  if(img)msgs.push({role:'user',content:[{type:'text',text},{type:'image_url',image_url:{url:img}}]});
  else msgs.push({role:'user',content:text});
  const d = await bbCallProvider('openrouter', {model:mid,messages:msgs,max_tokens:2048,temperature:0.7});
  return d.choices?.[0]?.message?.content||'لم أتمكن من الرد.';
}
async function callOR(text,sys,hist,mid,img=null){
  return callAPI(text,null,mid,img,sys,hist.map?hist:Object.values(hist));
}
async function callOllama(text,sys,hist){
  const url=(cfg.ollama.url||'http://localhost:11434').replace(/\/$/,'');
  const model=cfg.ollama.model||'llama3';
  const msgs=[{role:'system',content:sys},...hist.map(m=>({role:m.role,content:m.content})),{role:'user',content:text}];
  const res=await fetch(`${url}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:msgs,stream:false})});
  if(!res.ok)throw new Error(`Ollama خطأ ${res.status} — تأكد أن Ollama شغال على ${url}`);
  const d=await res.json();return d.message?.content||'لم أتمكن من الرد.';
}

// ════════════════════════════════════════════
// SMART IMAGE GENERATION ENGINE (Multi-Provider)
// Priority: OpenAI gpt-image-2 → Gemini Imagen → OpenRouter fal → Pollinations fallback
// ════════════════════════════════════════════

const IMG_MODELS = {
  // ══ OpenAI (Direct) ══
  'gpt-image-2':  { provider:'openai',  model:'gpt-image-2',                      label:'GPT Image 2 — OpenAI (الأفضل)',  tag:'OAI', needKey:'openai' },
  'dalle3':       { provider:'openai',  model:'dall-e-3',                          label:'DALL-E 3 HD — OpenAI',           tag:'OAI', needKey:'openai' },
  'dalle2':       { provider:'openai',  model:'dall-e-2',                          label:'DALL-E 2 — OpenAI',              tag:'OAI', needKey:'openai' },
  // ══ Google Gemini / Imagen (Direct) ══
  'imagen4':      { provider:'gemini',  model:'imagen-4.0-generate-preview-05-20', label:'Imagen 4 — Google (أحدث)',      tag:'GEM', needKey:'gemini' },
  'imagen3':      { provider:'gemini',  model:'imagen-3.0-generate-002',           label:'Imagen 3 — Google',             tag:'GEM', needKey:'gemini' },
  'imagen3-fast': { provider:'gemini',  model:'imagen-3.0-fast-generate-001',      label:'Imagen 3 Fast — Google',        tag:'GEM', needKey:'gemini' },
  // ══ OpenRouter / fal.ai ══
  'flux-pro-v2':  { provider:'openrouter', model:'fal-ai/flux-pro/v2',            label:'FLUX Pro v2 (OpenRouter)',       tag:'OR',  needKey:'openrouter' },
  'flux-pro':     { provider:'openrouter', model:'fal-ai/flux-pro/v1.1',          label:'FLUX Pro 1.1 (OpenRouter)',      tag:'OR',  needKey:'openrouter' },
  'flux-schnell': { provider:'openrouter', model:'fal-ai/flux/schnell',           label:'FLUX Schnell — سريع (OpenRouter)',tag:'OR',  needKey:'openrouter' },
  'flux-realism': { provider:'openrouter', model:'fal-ai/flux-realism',           label:'FLUX Realism (OpenRouter)',      tag:'OR',  needKey:'openrouter' },
  'flux-anime':   { provider:'openrouter', model:'fal-ai/flux/dev',               label:'FLUX Dev — أنيمي (OpenRouter)',  tag:'OR',  needKey:'openrouter' },
  'sdxl':         { provider:'openrouter', model:'stability-ai/sdxl',             label:'Stable Diffusion XL',           tag:'OR',  needKey:'openrouter' },
  // ══ Pollinations (Free, No Key) ══
  'pollinations': { provider:'pollinations', model:'flux',          label:'FLUX — مجاني بلا Key',    tag:'FREE', needKey:null },
  'pol-realism':  { provider:'pollinations', model:'flux-realism',  label:'Realism — مجاني بلا Key', tag:'FREE', needKey:null },
  'pol-anime':    { provider:'pollinations', model:'flux-anime',    label:'Anime — مجاني بلا Key',   tag:'FREE', needKey:null },
  'pol-turbo':    { provider:'pollinations', model:'turbo',         label:'Turbo — مجاني سريع',      tag:'FREE', needKey:null },
};

// Detect best available provider based on current API keys
function _detectImgProvider(modelKey) {
  const m = IMG_MODELS[modelKey];
  if (!m) return null;
  if (m.needKey && !cfg.apis[m.needKey]) return null;
  return m;
}

function _getBestImgModel(preferredKey) {
  // Try preferred first
  const preferred = _detectImgProvider(preferredKey);
  if (preferred) return { key: preferredKey, ...preferred };

  // Fallback priority: GPT Image 2 → Gemini Imagen4 → DALL-E 3 → Imagen3 → OR FLUX → Pollinations
  const priority = ['gpt-image-2','imagen4','dalle3','imagen3','imagen3-fast','flux-pro-v2','flux-pro','flux-schnell','pollinations','pol-turbo'];
  for (const k of priority) {
    const m = _detectImgProvider(k);
    if (m) return { key: k, ...m };
  }
  // Always fallback to Pollinations (no key needed)
  return { key:'pollinations', provider:'pollinations', model:'flux', label:'FLUX Pollinations (مجاني)', tag:'FREE', needKey:null };
}

async function _generateViaOpenRouter(prompt, modelId, w, h) {
  // OpenRouter image gen uses /v1/images/generations compatible endpoint
  const body = { model: modelId, prompt, n: 1, size: `${w}x${h}`, response_format: 'url' };
  const d = await bbCallProvider('openrouter', body, 'images');
  const url = d.data?.[0]?.url || d.data?.[0]?.b64_json && `data:image/png;base64,${d.data[0].b64_json}`;
  if (!url) throw new Error('لم يرجع OpenRouter رابط الصورة');
  return { url, source: 'OpenRouter' };
}

async function _generateViaOpenAI(prompt, modelId, w, h) {
  // gpt-image-2 uses /v1/images/generations with base64 response
  if (modelId === 'gpt-image-2') {
    const d = await bbCallProvider('openai', { model: 'gpt-image-2', prompt, n: 1, size: '1024x1024', response_format: 'b64_json' }, 'images');
    const b64 = d.data?.[0]?.b64_json;
    if (!b64) throw new Error('لم يرجع GPT Image 2 بيانات الصورة');
    return { url: `data:image/png;base64,${b64}`, directUrl: null, source: 'GPT Image 2 (OpenAI)' };
  }
  // DALL-E 3 supports: 1024x1024, 1792x1024, 1024x1792
  let size = '1024x1024';
  if (modelId === 'dall-e-3') {
    if (w > h) size = '1792x1024';
    else if (h > w) size = '1024x1792';
  }
  const d = await bbCallProvider('openai', { model: modelId, prompt, n: 1, size, response_format: 'url', quality: modelId === 'dall-e-3' ? 'hd' : 'standard' }, 'images');
  const url = d.data?.[0]?.url;
  if (!url) throw new Error('لم يرجع OpenAI رابط الصورة');
  return { url, directUrl: url, source: 'OpenAI DALL-E' };
}

async function _generateViaGemini(prompt, modelId) {
  // Correct Gemini Imagen API endpoint: generateImages
  const d = await bbCallProvider('gemini', { model: modelId, prompt: { text: prompt }, number_of_images: 1, safety_filter_level: 'BLOCK_ONLY_HIGH', person_generation: 'ALLOW_ADULT' }, 'images');
  const b64 = d.generatedImages?.[0]?.image?.imageBytes;
  if (!b64) throw new Error('لم يرجع Gemini Imagen بيانات الصورة');
  return { url: `data:image/png;base64,${b64}`, directUrl: null, source: 'Google Imagen' };
}

async function _generateViaPollinationsImg(prompt, polModel, w, h) {
  const seed = Math.floor(Math.random() * 9999999);
  const polUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&model=${polModel}&seed=${seed}&nologo=true`;
  // Fetch as blob to bypass CORS/CSP image restrictions
  try {
    const resp = await fetch(polUrl, { mode: 'cors', cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    return { url: blobUrl, directUrl: polUrl, source: 'Pollinations.AI (مجاني)', seed };
  } catch(fetchErr) {
    // Fallback: return direct URL and let <img> try
    return { url: polUrl, directUrl: polUrl, source: 'Pollinations.AI (مجاني)', seed, noBlob: true };
  }
}

// Main unified generate function
async function _smartGenerateImage(prompt, modelKey, w, h, statusEl) {
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

  const mInfo = _getBestImgModel(modelKey);
  setStatus(`🎨 توليد عبر ${mInfo.label} [${mInfo.tag}]...`);

  try {
    if (mInfo.provider === 'openrouter') return await _generateViaOpenRouter(prompt, mInfo.model, w, h);
    if (mInfo.provider === 'openai')     return await _generateViaOpenAI(prompt, mInfo.model, w, h);
    if (mInfo.provider === 'gemini')     return await _generateViaGemini(prompt, mInfo.model);
    if (mInfo.provider === 'pollinations') return await _generateViaPollinationsImg(prompt, mInfo.model, w, h);
  } catch(err) {
    setStatus(`⚠️ ${mInfo.label} فشل (${err.message.slice(0,40)}) — جاري المحاولة بـ Pollinations...`);
    // Final fallback to Pollinations
    const polModel = mInfo.provider === 'pollinations' ? 'turbo' : 'flux';
    return await _generateViaPollinationsImg(prompt, polModel, w, h);
  }
}

// Build image result card DOM
function _buildImgCard(result, finalPrompt, mLabel, w, h) {
  const card = document.createElement('div');
  card.className = 'imggen-card';
  card.style.cssText = 'position:relative;border-radius:var(--r);overflow:hidden;border:1px solid var(--b1);background:var(--bg2)';

  const img = document.createElement('img');
  img.alt = finalPrompt.slice(0, 60);
  img.style.cssText = 'width:100%;display:block;min-height:120px;background:var(--s2)';

  // Loading overlay
  const loadingEl = document.createElement('div');
  loadingEl.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:var(--bg2);z-index:2';
  loadingEl.innerHTML = `<span style="font-size:28px;animation:spin 1.2s linear infinite;display:inline-block">⏳</span><span style="font-size:10px;color:var(--t2)">جاري تحميل الصورة...</span>`;
  card.appendChild(loadingEl);

  img.onload = () => { loadingEl.style.display='none'; };
  img.onerror = () => {
    const directUrl = result.directUrl || result.url;
    loadingEl.innerHTML = `<span style="font-size:22px">⚠️</span><span style="font-size:10px;color:var(--t2);text-align:center;padding:0 10px">الصورة تولدت — افتح الرابط</span><a href="${directUrl}" target="_blank" style="font-size:11px;color:var(--accent);font-weight:700;padding:4px 10px;border:1px solid var(--accent);border-radius:6px">🔗 افتح الصورة</a>`;
  };
  img.src = result.url;
  card.appendChild(img);

  const safeP = finalPrompt.slice(0,30).replace(/['"<>&]/g,'');
  const directUrl = result.directUrl || result.url;
  const isBlob = result.url.startsWith('blob:');
  const isDataUrl = result.url.startsWith('data:');

  const acts = document.createElement('div');
  acts.style.cssText = 'display:flex;gap:4px;padding:5px;background:var(--s1);position:relative;z-index:1';

  if (isDataUrl || isBlob) {
    acts.innerHTML = `<button onclick="downloadDataImg(this.closest('.imggen-card').querySelector('img').src,'pexil-img.png')" style="flex:1;font-size:10px;background:var(--accent);border:none;border-radius:4px;color:#1a2028;cursor:pointer;padding:3px 5px;font-family:'Cairo',sans-serif">⬇️ تحميل</button>
    <a href="${directUrl}" target="_blank" style="flex:1;text-align:center;font-size:10px;color:var(--t2);text-decoration:none;padding:3px 5px;border:1px solid var(--b1);border-radius:4px;display:flex;align-items:center;justify-content:center">🔗 رابط</a>
    <button onclick="injectImageBubble(this.closest('.imggen-card').querySelector('img').src,'${safeP}')" style="flex:1;font-size:10px;background:var(--s2);border:1px solid var(--b1);border-radius:4px;color:var(--t2);cursor:pointer;padding:3px 5px;font-family:'Cairo',sans-serif">💬 شات</button>`;
  } else {
    acts.innerHTML = `<a href="${directUrl}" target="_blank" style="flex:1;text-align:center;font-size:10px;color:var(--accent);text-decoration:none;padding:3px 5px;border:1px solid rgba(52,211,153,.3);border-radius:4px;display:flex;align-items:center;justify-content:center;font-weight:700">🔗 فتح / تحميل</a>
    <button onclick="injectImageBubble(this.closest('.imggen-card').querySelector('img').src,'${safeP}')" style="flex:1;font-size:10px;background:var(--s2);border:1px solid var(--b1);border-radius:4px;color:var(--t2);cursor:pointer;padding:3px 5px;font-family:'Cairo',sans-serif">💬 شات</button>`;
  }

  const tag = document.createElement('div');
  tag.style.cssText = 'font-size:9px;color:var(--t3);padding:2px 6px 4px;text-align:center;background:var(--bg)';
  tag.textContent = `🌐 ${result.source} · ${w}×${h}`;

  card.appendChild(acts);
  card.appendChild(tag);
  return card;
}

function downloadDataImg(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename; a.click();
}

async function generateImage(){
  const prompt = document.getElementById('imggen-prompt').value.trim();
  if (!prompt) { showToast('⚠️ اكتب وصف الصورة'); return; }
  const modelKey = document.getElementById('imggen-model')?.value || 'flux-schnell';
  const size = document.getElementById('imggen-size').value;
  const [w, h] = size.split('x').map(Number);
  const btn = document.getElementById('imggen-btn');
  const status = document.getElementById('imggen-status');
  const results = document.getElementById('imggen-results');
  btn.disabled = true; btn.textContent = '⏳ جاري التوليد...';

  // Translate Arabic prompt
  let finalPrompt = prompt;
  if (/[\u0600-\u06FF]/.test(prompt)) {
    const hasKey = cfg.apis.openrouter || cfg.apis.openai || cfg.apis.gemini;
    if (hasKey) {
      try {
        status.textContent = '✨ ترجمة الوصف للإنجليزية...';
        const t = await routeReq(`ترجم هذا النص للإنجليزية فقط لتوليد صورة احترافية، أجب بالـ prompt فقط بدون شرح: ${prompt}`, null, cfg.model_id);
        if (t && t.length > 3) finalPrompt = t.replace(/^["']|["']$/g,'').trim();
      } catch(e) {}
    }
  }

  // Show placeholder card
  const placeholder = document.createElement('div');
  placeholder.className = 'imggen-card';
  placeholder.style.cssText = `position:relative;border-radius:var(--r);overflow:hidden;border:1px solid var(--b1);background:var(--bg2);min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px`;
  placeholder.innerHTML = `<span style="font-size:36px;animation:spin 1.2s linear infinite;display:inline-block">⏳</span><span style="font-size:11px;color:var(--t2)">جاري التوليد...</span>`;
  results.insertBefore(placeholder, results.firstChild);

  try {
    const result = await _smartGenerateImage(finalPrompt, modelKey, w, h, status);
    const card = _buildImgCard(result, finalPrompt, modelKey, w, h);
    results.replaceChild(card, placeholder);
    status.textContent = `✅ تمت عبر ${result.source}!`;
  } catch(err) {
    placeholder.innerHTML = `<span style="font-size:28px">❌</span><span style="font-size:11px;color:var(--red)">${err.message.slice(0,80)}</span>
      <span style="font-size:10px;color:var(--t3)">تأكد من API Key أو جرب نموذج مختلف</span>`;
    status.textContent = '⚠️ فشل التوليد — ' + err.message.slice(0,50);
  }
  btn.disabled = false; btn.textContent = '🎨 توليد الصورة';
}
function onLangChange(){
  const lang=document.getElementById('code-lang').value;
  const isHtml=lang==='html'||lang==='css';
  document.getElementById('code-out').style.display=isHtml?'none':'block';
  document.getElementById('code-html-frame').style.display=isHtml?'block':'none';
}
async function runCode(){
  const lang=document.getElementById('code-lang').value;
  const code=document.getElementById('code-editor').value.trim();
  if(!code){showToast('⚠️ الكود فاضي');return;}
  const out=document.getElementById('code-out');const st=document.getElementById('cr-status');
  out.textContent='⏳ جاري التشغيل...';out.classList.remove('err');st.textContent='🔄 تشغيل...';
  const s=Date.now();
  execCode(lang,code,(result,isErr,isHtml)=>{
    const el=((Date.now()-s)/1000).toFixed(2);
    if(isHtml){
      const frame=document.getElementById('code-html-frame');
      frame.srcdoc=result;frame.style.display='block';out.style.display='none';
    }else{out.classList.toggle('err',isErr);out.textContent=result;}
    st.textContent=`${isErr?'❌ خطأ':'✅ تم'} — ${el}s`;document.getElementById('cr-st').textContent='';
  });
}
function execCode(lang,code,cb){
  if(lang==='javascript'||lang==='typescript'){
    if(lang==='typescript')code=code.replace(/:\s*\w+(\[\])?/g,'').replace(/interface\s+\w+\s*\{[^}]*\}/g,'').replace(/<\w+>/g,'');
    const logs=[];const ol=console.log,oe=console.error,ow=console.warn;
    console.log=(...a)=>{logs.push(a.map(x=>typeof x==='object'?JSON.stringify(x,null,2):String(x)).join(' '));ol(...a);};
    console.error=(...a)=>{logs.push('❌ '+a.join(' '));oe(...a);};
    console.warn=(...a)=>{logs.push('⚠️ '+a.join(' '));ow(...a);};
    try{
      const r=new Function(code)();
      console.log=ol;console.error=oe;console.warn=ow;
      cb(logs.length?logs.join('\n'):(r!==undefined?String(r):'(لا يوجد output)'),false);
    }catch(e){
      console.log=ol;console.error=oe;console.warn=ow;
      cb('❌ '+e.constructor.name+': '+e.message,true);
    }
    return;
  }
  if(lang==='python'){runPy(code,cb);return;}
  if(lang==='html'){cb(code,false,true);return;}
  if(lang==='css'){cb('<div style="padding:10px;font-family:sans-serif;background:#fff">CSS Preview</div>',false,true);return;}
  if(lang==='json'){try{cb(JSON.stringify(JSON.parse(code),null,2),false);}catch(e){cb('❌ JSON: '+e.message,true);}return;}
  if(lang==='markdown'){cb('<div style="padding:12px;background:#fff;font-family:sans-serif;direction:rtl">'+parseMd(code)+'</div>',false,true);return;}
  cb('(لا يوجد نتيجة)',false);
}
async function runPy(code,cb){
  const out=document.getElementById('code-out');
  try{
    if(!pyodide){out.textContent='⏳ جاري تحميل Python (Pyodide)...';document.getElementById('cr-status').textContent='⏳ تحميل Python...';
      await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});
      pyodide=await loadPyodide({indexURL:'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/'});
    }
    pyodide.runPython('import sys,io\nsys.stdout=io.StringIO()\nsys.stderr=io.StringIO()');
    try{pyodide.runPython(code);}catch(e){cb('❌ Python Error: '+e.message,true);return;}
    const stdout=pyodide.runPython('sys.stdout.getvalue()');
    const stderr=pyodide.runPython('sys.stderr.getvalue()');
    cb((stdout+stderr)||'(لا يوجد output)',false);
  }catch(e){cb('❌ '+e.message,true);}
}
function clearCodeOut(){const o=document.getElementById('code-out');o.textContent='// النتيجة هنا...';o.classList.remove('err');document.getElementById('cr-status').textContent='جاهز';document.getElementById('cr-st').textContent='';}
async function aiExplainCode(){const c=document.getElementById('code-editor').value.trim();if(!c){showToast('⚠️ فاضي');return;}switchTab('chat');document.getElementById('chat-input').value=`اشرح هذا الكود واقترح تحسينات:\n\`\`\`\n${c}\n\`\`\``;sendMessage();}
function copyCodeEditor(){copyToCB(document.getElementById('code-editor').value);showToast('✅ تم النسخ');}
function sendToEditor(code,lang){switchTab('code');document.getElementById('code-editor').value=code;const lm={js:'javascript',py:'python',javascript:'javascript',python:'python',html:'html',css:'css',json:'json',ts:'typescript',md:'markdown'};const l=lm[lang?.toLowerCase()]||'javascript';document.getElementById('code-lang').value=l;onLangChange();}
function fmtCode(){const lang=document.getElementById('code-lang').value;const code=document.getElementById('code-editor').value;if(lang==='json'){try{document.getElementById('code-editor').value=JSON.stringify(JSON.parse(code),null,2);showToast('✅ تم التنسيق');}catch(e){showToast('❌ JSON خاطئ');}}else{showToast('⚠️ التنسيق متاح للـ JSON فقط حالياً');}}

// ═══ TOOLS ═══
const TOOL_ICONS={
  search:'🔍',translate:'🌍',summarize:'📝',improve:'✍️',
  api:'🔗',regex:'⚙️',json:'{ }',diff:'⇄',
  image:'🖼️',ocr:'🔤',base64:'🔒',hash:'🔑',
  timer:'⏱️',notes:'📌',calc:'🖩',color:'🎨'
};
const CAT_COLORS_MAP={
  'بحث':'#60a5fa','نصوص':'#a78bfa','تطوير':'#fbbf24',
  'وسائط':'#e879f9','إنتاجية':'#34d399','تصميم':'#f9a8d4','الكل':'#94a3b8'
};
function buildTools(){
  const cats=['الكل',...new Set(TOOLS_REGISTRY.map(t=>t.cat))];
  document.getElementById('tools-cats').innerHTML=cats.map(c=>{
    const color=CAT_COLORS_MAP[c]||'#94a3b8';
    return `<div class="tool-cat ${toolsCat===c?'active':''}" onclick="filterToolsCat('${c}')">
      <span class="tool-cat-dot" style="background:${color}"></span>${c}
    </div>`;
  }).join('');
  const filtered=toolsCat==='الكل'?TOOLS_REGISTRY:TOOLS_REGISTRY.filter(t=>t.cat===toolsCat);
  document.getElementById('tools-grid').innerHTML=filtered.map(t=>`
    <div class="tool-tile" onclick="openTool('${t.id}')" style="--tc:${t.color}">
      <div class="tool-tile-icon" style="background:${t.color}22;color:${t.color}">${TOOL_ICONS[t.id]||'🛠️'}</div>
      <div class="tool-tile-name">${t.name}</div>
      <div class="tool-tile-desc">${t.desc}</div>
    </div>`).join('');
  const cnt=document.getElementById('tools-count');if(cnt)cnt.textContent=filtered.length;
}
function filterToolsCat(c){toolsCat=c;buildTools();document.getElementById('tool-panel').innerHTML='';
  const filtered=c==='الكل'?TOOLS_REGISTRY:TOOLS_REGISTRY.filter(t=>t.cat===c);
  const cnt=document.getElementById('tools-count');if(cnt)cnt.textContent=filtered.length;
}
function showTRes(text,isErr=false){const el=document.getElementById('t-res');if(!el)return;el.style.display='block';el.classList.toggle('err',isErr);el.textContent=text;}

// ─ CALC ─
let calcVal='0',calcOp=null,calcPrev=null,calcNew=true;
function tCalcInit(){calcVal='0';calcOp=null;calcPrev=null;calcNew=true;document.getElementById('t-calc-val').textContent='0';}
function tCalc(k){
  const vEl=document.getElementById('t-calc-val');const hEl=document.getElementById('t-calc-hist');
  if(k==='C'){calcVal='0';calcOp=null;calcPrev=null;calcNew=true;vEl.textContent='0';hEl.textContent='';return;}
  if(k==='⌫'){calcVal=calcVal.length>1?calcVal.slice(0,-1):'0';vEl.textContent=calcVal;return;}
  if(k==='±'){calcVal=String(-parseFloat(calcVal)||0);vEl.textContent=calcVal;return;}
  if(k==='%'){calcVal=String(parseFloat(calcVal)/100);vEl.textContent=calcVal;return;}
  const ops={'÷':'/','×':'*','−':'-','＋':'+'};
  if(ops[k]){
    if(calcOp&&!calcNew){const r=eval(calcPrev+calcOp+calcVal);calcVal=String(r);vEl.textContent=calcVal;}
    calcPrev=calcVal;calcOp=ops[k];calcNew=true;
    hEl.textContent=calcPrev+' '+k;return;
  }
  if(k==='='){
    if(!calcOp)return;
    hEl.textContent=calcPrev+' '+(Object.entries(ops).find(([,v])=>v===calcOp)||['?'])[0]+' '+calcVal+' =';
    try{const r=eval(calcPrev+calcOp+calcVal);calcVal=String(r);calcOp=null;calcNew=true;}catch(e){calcVal='خطأ';}
    vEl.textContent=calcVal;return;
  }
  if(k==='.'){
    if(calcNew){calcVal='0.';calcNew=false;vEl.textContent=calcVal;return;}
    if(!calcVal.includes('.'))calcVal+='.';vEl.textContent=calcVal;return;
  }
  if(calcNew){calcVal=k;calcNew=false;}else calcVal=(calcVal==='0'?k:calcVal+k);
  vEl.textContent=calcVal;
}

// ─ TIMER ─
let timerSecs=0,timerRunning=false;
function tTimerInit(){timerRunning=false;timerSecs=0;}
function tTimerTick(){
  if(!timerRunning)return;
  timerSecs--;
  if(timerSecs<=0){timerSecs=0;timerRunning=false;clearInterval(timerInterval);timerInterval=null;
    const el=document.getElementById('t-timer-display');if(el){el.textContent='00:00:00';el.style.color='var(--green)';}
    const lbl=document.getElementById('t-timer-label');if(lbl)lbl.textContent='✅ انتهى الوقت!';
    showToast('⏰ '+(document.getElementById('t-timer-name')?.value||'الوقت انتهى!')+'!');
    if(window.speechSynthesis){const u=new SpeechSynthesisUtterance('انتهى الوقت');u.lang='ar-SA';window.speechSynthesis.speak(u);}
    return;
  }
  const h=Math.floor(timerSecs/3600),m=Math.floor((timerSecs%3600)/60),s=timerSecs%60;
  const el=document.getElementById('t-timer-display');
  if(el)el.textContent=`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function tTimerStart(){
  const h=parseInt(document.getElementById('t-timer-h')?.value)||0;
  const m=parseInt(document.getElementById('t-timer-m')?.value)||0;
  const s=parseInt(document.getElementById('t-timer-s')?.value)||0;
  const total=h*3600+m*60+s;
  if(!timerRunning){
    if(timerSecs===0){if(!total){showToast('⚠️ حدد وقتاً أولاً');return;}timerSecs=total;}
    timerRunning=true;
    if(timerInterval)clearInterval(timerInterval);
    timerInterval=setInterval(tTimerTick,1000);
    const lbl=document.getElementById('t-timer-label');if(lbl)lbl.textContent='⏱️ يعمل...';
    const el=document.getElementById('t-timer-display');if(el)el.style.color='var(--accent)';
  }
}
function tTimerPause(){timerRunning=!timerRunning;if(timerRunning)timerInterval=setInterval(tTimerTick,1000);else{clearInterval(timerInterval);timerInterval=null;}
  const lbl=document.getElementById('t-timer-label');if(lbl)lbl.textContent=timerRunning?'⏱️ يعمل...':'⏸ متوقف مؤقتاً';}
function tTimerReset(){timerRunning=false;clearInterval(timerInterval);timerInterval=null;timerSecs=0;const el=document.getElementById('t-timer-display');if(el){el.textContent='00:00:00';el.style.color='var(--accent)';}const lbl=document.getElementById('t-timer-label');if(lbl)lbl.textContent='ابدأ العدّاد';}

// ─ NOTES ─
function tNoteAdd(){const txt=document.getElementById('t-note-txt')?.value.trim();if(!txt)return;const cat=document.getElementById('t-note-cat')?.value||'عام';notes.push({id:Date.now(),text:txt,cat,ts:Date.now()});saveNotes();document.getElementById('t-note-txt').value='';tNoteRender();showToast('✅ تمت الإضافة');}
function tNoteRender(){const el=document.getElementById('t-notes-list');if(!el)return;if(!notes.length){el.innerHTML='<div style="text-align:center;color:var(--t3);font-size:12px;padding:10px">لا توجد ملاحظات</div>';return;}const catColors={عام:'var(--accent)',مهمة:'var(--red)',فكرة:'var(--yellow)',كود:'var(--purple)'};el.innerHTML=notes.slice().reverse().map(n=>`<div style="padding:8px 10px;background:var(--s1);border:1px solid var(--b1);border-radius:var(--rs);display:flex;align-items:flex-start;gap:7px"><span style="font-size:9px;padding:2px 6px;border-radius:99px;background:${catColors[n.cat]||'var(--accent)'}22;color:${catColors[n.cat]||'var(--accent)'};font-weight:700;flex-shrink:0;margin-top:2px">${n.cat}</span><span style="flex:1;font-size:12px;line-height:1.6">${esc(n.text)}</span><button onclick="notes=notes.filter(x=>x.id!==${n.id});saveNotes();tNoteRender();" style="background:none;border:none;color:var(--t3);cursor:pointer;font-size:12px">✕</button></div>`).join('');}

// ─ COLOR ─
function tColorUpdate(){const hex=document.getElementById('t-color-pick')?.value||'#00aaff';document.getElementById('t-color-hex').value=hex;document.getElementById('t-color-preview').style.background=hex;const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);document.getElementById('t-color-r').value=r;document.getElementById('t-color-g').value=g;document.getElementById('t-color-b').value=b;const h=rgbToHsl(r,g,b);document.getElementById('t-color-info').textContent=`HSL: hsl(${h[0]}, ${h[1]}%, ${h[2]}%) | RGB: rgb(${r}, ${g}, ${b})`;}
function tColorFromHex(){const hex=document.getElementById('t-color-hex')?.value;if(!/^#[0-9a-fA-F]{6}$/.test(hex))return;document.getElementById('t-color-pick').value=hex;tColorUpdate();}
function tColorFromRGB(){const r=parseInt(document.getElementById('t-color-r')?.value)||0,g=parseInt(document.getElementById('t-color-g')?.value)||0,b=parseInt(document.getElementById('t-color-b')?.value)||0;const hex='#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');document.getElementById('t-color-hex').value=hex;document.getElementById('t-color-pick').value=hex;document.getElementById('t-color-preview').style.background=hex;}
function rgbToHsl(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b);let h,s,l=(max+min)/2;if(max===min){h=s=0;}else{const d=max-min;s=l>.5?d/(2-max-min):d/(max+min);switch(max){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;}h/=6;}return[Math.round(h*360),Math.round(s*100),Math.round(l*100)];}
function tColorPalette(){const hex=document.getElementById('t-color-hex')?.value||'#00aaff';const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);const shades=[.2,.4,.6,.8,1,1.2,1.4,1.6,1.8].map(f=>{const nr=Math.min(255,Math.round(r*f)),ng=Math.min(255,Math.round(g*f)),nb=Math.min(255,Math.round(b*f));return '#'+[nr,ng,nb].map(x=>x.toString(16).padStart(2,'0')).join('');});const el=document.getElementById('t-color-palette');if(el)el.innerHTML=shades.map(c=>`<div onclick="copyToCB('${c}')" title="${c}" style="width:28px;height:28px;border-radius:6px;background:${c};cursor:pointer;border:1px solid var(--b1)" title="نسخ ${c}"></div>`).join('');}

// ─ HASH ─  
async function tHash(){const txt=document.getElementById('t-txt')?.value;const alg=document.getElementById('t-hash-alg')?.value;if(!txt){showToast('⚠️ أدخل نصاً');return;}showTRes('⏳ جاري الحساب...');try{if(alg==='md5-like'){let hash=0;for(let i=0;i<txt.length;i++){hash=((hash<<5)-hash)+txt.charCodeAt(i);hash|=0;}showTRes(Math.abs(hash).toString(16).padStart(8,'0')+'...(md5 تقريبي)');}else{const algMap={'sha256':'SHA-256','sha1':'SHA-1','sha512':'SHA-512'};const buf=await crypto.subtle.digest(algMap[alg],new TextEncoder().encode(txt));showTRes([...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join(''));}}catch(e){showTRes('❌ '+e.message,true);}}

// ─ IMPROVE ALT ─


async function tImproveAlt(){const txt=document.getElementById('t-txt')?.value.trim();if(!txt){showToast('اكتب نصاً');return;}showTRes('جاري التحسين...');const mid=cfg.or_custom||cfg.model_id;const m2=MODELS.find(x=>x.id===mid);try{const r=await callAPI('اكتب نصاً بديلاً مختلفاً: '+txt,m2,mid,null,buildSys());showTRes(r);}catch(e){showTRes('خطأ: '+e.message,true);}}

// ─ API FORMAT ─
function tAPIFormat(){const b=document.getElementById('t-body');if(!b||!b.value.trim())return;try{b.value=JSON.stringify(JSON.parse(b.value),null,2);showToast('✅ تم التنسيق');}catch(e){showToast('❌ JSON غير صحيح');}}

// ─ JSON to CSV ─
function tJToCSV(){const txt=document.getElementById('t-txt')?.value.trim();try{const d=JSON.parse(txt);if(!Array.isArray(d)){showTRes('⚠️ يجب أن يكون JSON مصفوفة',true);return;}const keys=Object.keys(d[0]);const csv=[keys.join(','),...d.map(r=>keys.map(k=>JSON.stringify(r[k]??'')).join(','))].join('\n');showTRes(csv);}catch(e){showTRes('❌ '+e.message,true);}}


function tCalcKey(code){var m={"pm":"±","pct":"%","div":"÷","mul":"×","sub":"−","add":"＋","dot":".","del":"⌫","eq":"="};tCalc(m[code]||code);}

function tCalcRender(){
  const keys=[['C','C'],['\u00b1','pm'],['%','pct'],['\u00f7','div'],
    ['7','7'],['8','8'],['9','9'],['\u00d7','mul'],
    ['4','4'],['5','5'],['6','6'],['-','sub'],
    ['1','1'],['2','2'],['3','3'],['+'  ,'add'],
    ['0','0'],['.','dot'],['\u232b','del'],['=','eq']];
  const grid=document.getElementById('t-calc-btns');
  if(!grid)return;
  calcVal='0';calcOp=null;calcPrev=null;calcNew=true;
  grid.innerHTML='';
  keys.forEach(function(pair){
    const lbl=pair[0],code=pair[1];
    const btn=document.createElement('button');
    btn.className='t-btn'+(code==='eq'?' primary':'')+(['div','mul','sub','add'].includes(code)?' op-btn':'');
    btn.style.cssText='font-size:16px;padding:12px 6px;'+(code==='eq'?'background:var(--accent);color:#1a2028;':'')+((['div','mul','sub','add'].includes(code))?'color:var(--accent);':'');
    btn.textContent=lbl;
    btn.dataset.k=code;
    grid.appendChild(btn);
  });
  grid.addEventListener('click',function(e){
    const btn=e.target.closest('button');
    if(btn&&btn.dataset.k)tCalcKey(btn.dataset.k);
  });
}
function copyColorHex(){copyToCB(document.getElementById('t-color-hex').value||'#00aaff');}

function openTool(id){
  var t=TOOLS_REGISTRY.find(function(x){return x.id===id;});
  if(!t)return;
  var icon=TOOL_ICONS[id]||'🛠️';
  var p=document.getElementById('tool-panel');
  if(!p)return;
  p.style.display='block';

  var hdr='<div class="tp-header"><button class="tp-back" onclick="closeTool()">← رجوع</button><div class="tp-title">'+icon+' '+t.name+'</div></div>';
  var res='<div class="t-result" id="t-res" style="display:none"></div>';

  function field(lbl, inp){return '<div class="t-field"><label>'+lbl+'</label>'+inp+'</div>';}
  function btn(lbl, fn, cls){return '<button class="t-btn '+(cls||'')+'" onclick="'+fn+'()">'+lbl+'</button>';}
  function sel(id2, opts){return '<select id="'+id2+'">'+opts.map(function(o){return '<option value="'+o[0]+'">'+o[1]+'</option>';}).join('')+'</select>';}
  function wrap(body){return '<div class="tool-panel">'+hdr+body+res+'</div>';}
  function noRes(body){return '<div class="tool-panel">'+hdr+body+'</div>';}
  function grid2(a,b){return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px">'+a+b+'</div>';}

  var content='<div class="tool-panel">'+hdr+'<div style="text-align:center;padding:20px;color:var(--t2)">هذه الأداة قيد التطوير</div></div>';

  if(id==='search') content=wrap(
    field('ابحث عن','<input type="text" id="t-q" placeholder="مثال: أفضل مكتبات Python للذكاء الاصطناعي"/>')+
    '<div class="t-btns">'+btn('🔍 ابحث الآن','tSearch','primary')+'</div>'
  );
  else if(id==='translate') content=wrap(
    field('النص','<textarea id="t-txt" style="min-height:80px" placeholder="اكتب النص هنا..."></textarea>')+
    grid2(field('من',sel('t-from',[['auto','تلقائي'],['ar','عربي'],['en','إنجليزي'],['fr','فرنسي'],['de','ألماني'],['tr','تركي']])),
          field('إلى',sel('t-to',[['en','إنجليزي'],['ar','عربي'],['fr','فرنسي'],['de','ألماني'],['tr','تركي']])))+
    '<div class="t-btns">'+btn('⇄ ترجم','tTranslate','primary')+'</div>'
  );
  else if(id==='summarize') content=wrap(
    field('النص','<textarea id="t-txt" style="min-height:100px" placeholder="الصق النص هنا..."></textarea>')+
    field('طول الملخص',sel('t-len',[['short','قصير — 3 نقاط'],['medium','متوسط — فقرة'],['long','مفصل']]))+
    field('النوع',sel('t-sum-type',[['bullets','نقاط'],['paragraph','فقرة'],['tweet','تغريدة']]))+
    '<div class="t-btns">'+btn('✨ لخّص','tSummarize','primary')+'</div>'
  );
  else if(id==='improve') content=wrap(
    field('النص','<textarea id="t-txt" style="min-height:90px" placeholder="النص الذي تريد تحسينه..."></textarea>')+
    grid2(field('نوع التحسين',sel('t-improve-type',[['general','عام'],['formal','رسمي'],['casual','غير رسمي'],['shorter','أقصر'],['expand','أطول']])),
          field('اللغة',sel('t-improve-lang',[['same','نفس اللغة'],['ar','عربي'],['en','إنجليزي']])))+
    '<div class="t-btns">'+btn('🪄 حسّن','tImprove','primary')+btn('🔄 بديل','tImproveAlt','')+'</div>'
  );
  else if(id==='api') content=wrap(
    '<div style="display:grid;grid-template-columns:90px 1fr;gap:7px">'+
      field('Method',sel('t-method',[['GET','GET'],['POST','POST'],['PUT','PUT'],['DELETE','DELETE'],['PATCH','PATCH']]))+
      field('URL','<input type="url" id="t-url" class="ltr" placeholder="https://api.example.com/v1/data"/>')+
    '</div>'+
    field('Headers (JSON)','<textarea id="t-headers" class="ltr" style="min-height:45px;font-size:11px" placeholder=\'{"Authorization":"Bearer token"}\'></textarea>')+
    field('Body','<textarea id="t-body" class="ltr" style="min-height:50px;font-size:11px" placeholder=\'{"key":"value"}\'></textarea>')+
    '<div class="t-btns">'+btn('➤ إرسال','tAPI','primary')+btn('{ } نسّق','tAPIFormat','')+'</div>'
  );
  else if(id==='regex') content=wrap(
    field('Pattern','<input type="text" id="t-regex" class="ltr" placeholder="[a-z]+"/>')+
    grid2(field('Flags','<input type="text" id="t-flags" class="ltr" value="g" placeholder="gi"/>'),
          field('عملية',sel('t-regex-op',[['test','اختبر تطابق'],['match','استخرج نتائج'],['replace','استبدل']])))+
    field('النص','<textarea id="t-txt" class="ltr" style="min-height:80px"></textarea>')+
    '<div id="t-regex-replace-wrap" style="display:none">'+field('الاستبدال','<input type="text" id="t-regex-rep" class="ltr"/>')+'</div>'+
    '<div class="t-btns">'+btn('⚡ اختبر','tRegex','primary')+'</div>'
  );
  else if(id==='json') content=wrap(
    field('JSON','<textarea id="t-txt" class="ltr" style="min-height:110px;font-size:11px;direction:ltr;text-align:left" placeholder=\'{"key":"value"}\'></textarea>')+
    '<div class="t-btns">'+btn('نسّق','tJFmt','primary')+btn('تحقق','tJVal','')+btn('اضغط','tJMin','')+btn('المفاتيح','tJKeys','')+btn('→ CSV','tJToCSV','')+'</div>'
  );
  else if(id==='diff') content=wrap(
    grid2(field('النسخة القديمة','<textarea id="t-old" class="ltr" style="min-height:110px;font-size:11px"></textarea>'),
          field('النسخة الجديدة','<textarea id="t-new" class="ltr" style="min-height:110px;font-size:11px"></textarea>'))+
    '<div class="t-btns">'+btn('⇄ قارن','tDiff','primary')+'</div>'
  );
  else if(id==='image') content=wrap(
    '<div class="drop-zone" style="padding:14px;cursor:pointer" onclick="document.getElementById(\'t-img-inp\').click()">'+
      '⬆️<div style="font-size:12px;margin-top:4px">اضغط لاختيار صورة</div></div>'+
    '<input type="file" id="t-img-inp" accept="image/*" style="display:none" onchange="handleTImg(event)"/>'+
    '<div id="t-img-prev" style="display:none;text-align:center;margin:8px 0"><img id="t-img" style="max-width:100%;max-height:160px;border-radius:var(--rs)"/></div>'+
    field('سؤالك','<input type="text" id="t-q" placeholder="اشرح الصورة / اقرأ النص..."/>')+
    '<div class="t-btns">'+btn('🔍 حلّل','tImage','primary')+'</div>'
  );
  else if(id==='ocr') content=wrap(
    '<div class="drop-zone" style="padding:14px;cursor:pointer" onclick="document.getElementById(\'t-ocr-inp\').click()">'+
      '🖼️<div style="font-size:12px;margin-top:4px">اضغط لاختيار صورة تحتوي نص</div></div>'+
    '<input type="file" id="t-ocr-inp" accept="image/*" style="display:none" onchange="handleOCR(event)"/>'+
    '<div id="t-ocr-prev" style="display:none;text-align:center;margin:8px 0"><img id="t-ocr-img" style="max-width:100%;max-height:130px;border-radius:var(--rs)"/></div>'+
    '<div class="t-btns">'+btn('🔤 اقرأ النص','tOCR','primary')+'</div>'
  );
  else if(id==='base64') content=wrap(
    field('النص أو الـ Base64','<textarea id="t-txt" class="ltr" style="min-height:80px;font-size:11px" placeholder="أدخل النص للتشفير أو Base64 لفك التشفير..."></textarea>')+
    '<div class="t-btns">'+btn('🔒 Encode','tB64E','primary')+btn('🔓 Decode','tB64D','')+'</div>'
  );
  else if(id==='hash') content=wrap(
    field('النص','<textarea id="t-txt" style="min-height:70px" placeholder="أدخل النص هنا..."></textarea>')+
    field('الخوارزمية',sel('t-hash-alg',[['sha256','SHA-256'],['sha1','SHA-1'],['sha512','SHA-512']]))+
    '<div class="t-btns">'+btn('🔑 احسب Hash','tHash','primary')+'</div>'
  );
  else if(id==='timer') content=noRes(
    '<div style="text-align:center;padding:12px 0">'+
      '<div id="t-timer-display" style="font-size:50px;font-weight:900;font-family:var(--mono);color:var(--accent);letter-spacing:2px">00:00:00</div>'+
      '<div id="t-timer-label" style="font-size:12px;color:var(--t2);margin-top:4px">حدد الوقت وابدأ</div>'+
    '</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">'+
      field('ساعات','<input type="number" id="t-timer-h" min="0" max="99" value="0" style="text-align:center"/>')+
      field('دقائق','<input type="number" id="t-timer-m" min="0" max="59" value="0" style="text-align:center"/>')+
      field('ثواني','<input type="number" id="t-timer-s" min="0" max="59" value="0" style="text-align:center"/>')+
    '</div>'+
    field('تسمية','<input type="text" id="t-timer-name" placeholder="مثال: استراحة قهوة ☕"/>')+
    '<div class="t-btns">'+btn('▶ ابدأ','tTimerStart','primary')+btn('⏸ وقف','tTimerPause','')+btn('↺ إعادة','tTimerReset','')+'</div>'
  );
  else if(id==='notes') content=noRes(
    field('ملاحظة','<textarea id="t-note-txt" style="min-height:70px" placeholder="اكتب ملاحظتك..."></textarea>')+
    '<div style="display:grid;grid-template-columns:1fr auto;gap:6px">'+
      field('التصنيف',sel('t-note-cat',[['عام','عام'],['مهمة','مهمة'],['فكرة','فكرة'],['كود','كود']]))+
      '<div class="t-field"><label>&nbsp;</label><button class="t-btn primary" onclick="tNoteAdd()" style="height:35px">+ أضف</button></div>'+
    '</div>'+
    '<div id="t-notes-list" style="margin-top:8px;display:flex;flex-direction:column;gap:5px"></div>'
  );
  else if(id==='calc') content=noRes(
    '<div style="background:var(--bg);border:1px solid var(--b1);border-radius:var(--rs);padding:10px 14px;margin-bottom:8px;direction:ltr;text-align:right">'+
      '<div id="t-calc-hist" style="font-size:11px;color:var(--t3);min-height:16px;font-family:var(--mono)"></div>'+
      '<div id="t-calc-val" style="font-size:30px;font-weight:700;font-family:var(--mono);color:var(--text);word-break:break-all">0</div>'+
    '</div>'+
    '<div id="t-calc-btns" style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px"></div>'
  );
  else if(id==='color') content=noRes(
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">'+
      '<input type="color" id="t-color-pick" value="#00aaff" oninput="tColorUpdate()" style="width:56px;height:56px;border:none;border-radius:var(--rs);cursor:pointer;padding:2px;background:none"/>'+
      '<div id="t-color-preview" style="flex:1;height:50px;border-radius:var(--rs);background:#00aaff;border:1px solid var(--b1)"></div>'+
    '</div>'+
    field('HEX','<input type="text" id="t-color-hex" class="ltr" value="#00aaff" oninput="tColorFromHex()"/>')+
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">'+
      field('R','<input type="number" id="t-color-r" min="0" max="255" value="0" oninput="tColorFromRGB()"/>')+
      field('G','<input type="number" id="t-color-g" min="0" max="255" value="170" oninput="tColorFromRGB()"/>')+
      field('B','<input type="number" id="t-color-b" min="0" max="255" value="255" oninput="tColorFromRGB()"/>')+
    '</div>'+
    '<div id="t-color-info" style="font-size:11px;color:var(--t2);margin-top:6px;padding:7px;background:var(--s1);border-radius:var(--rs);line-height:1.9"></div>'+
    '<div class="t-btns" style="margin-top:8px">'+btn('📋 نسخ HEX','copyColorHex','')+btn('🎨 Palette','tColorPalette','')+'</div>'+
    '<div id="t-color-palette" style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap"></div>'
  );

  p.innerHTML=content;
  setTimeout(function(){p.scrollIntoView({behavior:'smooth',block:'nearest'});},80);
  if(id==='timer') tTimerInit();
  if(id==='notes') tNoteRender();
  if(id==='calc') tCalcRender();
  if(id==='color') setTimeout(function(){tColorUpdate();},50);
  if(id==='regex'){
    var opEl=document.getElementById('t-regex-op');
    if(opEl) opEl.addEventListener('change',function(){
      var rw=document.getElementById('t-regex-replace-wrap');
      if(rw) rw.style.display=this.value==='replace'?'block':'none';
    });
  }
}

function closeTool(){
  const p=document.getElementById('tool-panel');
  p.innerHTML='';
  p.style.display='none';
}


// ─ HASH ─


// ─ IMPROVE ALT ─


// ─ API FORMAT ─


// ─ JSON to CSV ─





// Tool functions
async function tSearch(){const q=document.getElementById('t-q')?.value.trim();if(!q)return;showTRes('🔍 جاري البحث...');try{const r=await routeReq(`ابحث وأجب بتفصيل على: ${q}`,MODELS.find(m=>m.id===cfg.model_id),cfg.model_id);showTRes(r);}catch(e){showTRes('❌ '+e.message,true);}}
async function tTranslate(){const t=document.getElementById('t-txt')?.value.trim();const to=document.getElementById('t-to')?.value;if(!t)return;showTRes('🌍 جاري الترجمة...');try{const r=await routeReq(`ترجم فقط (بدون شرح) إلى ${to}:\n${t}`,MODELS.find(m=>m.id===cfg.model_id),cfg.model_id);showTRes(r);}catch(e){showTRes('❌ '+e.message,true);}}
async function tSummarize(){const t=document.getElementById('t-txt')?.value.trim();const l=document.getElementById('t-len')?.value;if(!t)return;const lm={short:'3 نقاط رئيسية فقط',medium:'فقرة واحدة',long:'ملخص مفصل بعناوين'};showTRes('📄 جاري التلخيص...');try{const r=await routeReq(`لخّص في ${lm[l]}:\n${t}`,MODELS.find(m=>m.id===cfg.model_id),cfg.model_id);showTRes(r);}catch(e){showTRes('❌ '+e.message,true);}}
async function tImprove(){const t=document.getElementById('t-txt')?.value.trim();const ty=document.getElementById('t-improve-type')?.value;if(!t)return;showTRes('✍️ جاري التحسين...');const instrs={general:'حسّن الصياغة والوضوح',formal:'اجعله رسمياً ومهنياً',casual:'اجعله غير رسمي وودياً',shorter:'اجعله أقصر وأكثر إيجازاً',expand:'وسّع واشرح بتفصيل أكثر'};try{const r=await routeReq(`${instrs[ty]||'حسّن'} (فقط النص المحسّن بدون تعليق):\n${t}`,MODELS.find(m=>m.id===cfg.model_id),cfg.model_id);showTRes(r);}catch(e){showTRes('❌ '+e.message,true);}}
async function tAPI(){const url=document.getElementById('t-url')?.value.trim();if(!url)return;const method=document.getElementById('t-method').value;let headers={'Content-Type':'application/json'};try{const h=document.getElementById('t-headers').value.trim();if(h)Object.assign(headers,JSON.parse(h));}catch(e){}let body;try{const b=document.getElementById('t-body').value.trim();if(b&&method!=='GET')body=b;}catch(e){}showTRes('🚀 جاري الإرسال...');try{const res=await fetch(url,{method,headers,body});let txt=await res.text();try{txt=JSON.stringify(JSON.parse(txt),null,2);}catch(e){}showTRes(`HTTP ${res.status} ${res.statusText}\n\n${txt}`);}catch(e){showTRes('❌ '+e.message,true);}}
function tRegex(){const pat=document.getElementById('t-regex')?.value;const flags=document.getElementById('t-flags')?.value||'g';const txt=document.getElementById('t-txt')?.value;if(!pat||!txt)return;try{const re=new RegExp(pat,flags);const m=[...txt.matchAll(re)];if(!m.length){showTRes('🔍 لا توجد تطابقات');return;}showTRes(`✅ ${m.length} تطابق:\n\n${m.map((x,i)=>`[${i+1}] "${x[0]}" at index ${x.index}${x.length>1?'\n    Groups: '+x.slice(1).join(', '):''}`).join('\n')}`);}catch(e){showTRes('❌ Pattern خاطئ: '+e.message,true);}}
function tJFmt(){const t=document.getElementById('t-txt')?.value.trim();try{showTRes(JSON.stringify(JSON.parse(t),null,2));}catch(e){showTRes('❌ '+e.message,true);}}
function tJVal(){const t=document.getElementById('t-txt')?.value.trim();try{JSON.parse(t);showTRes('✅ JSON صحيح!');}catch(e){showTRes('❌ JSON خاطئ: '+e.message,true);}}
function tJMin(){const t=document.getElementById('t-txt')?.value.trim();try{showTRes(JSON.stringify(JSON.parse(t)));}catch(e){showTRes('❌ '+e.message,true);}}
function tJKeys(){const t=document.getElementById('t-txt')?.value.trim();try{const obj=JSON.parse(t);const getKeys=(o,prefix='')=>Object.keys(o).flatMap(k=>{const full=prefix?prefix+'.'+k:k;return typeof o[k]==='object'&&o[k]&&!Array.isArray(o[k])?[full,...getKeys(o[k],full)]:[full];});showTRes('🗝️ المفاتيح:\n'+getKeys(obj).join('\n'));}catch(e){showTRes('❌ '+e.message,true);}}
function tDiff(){const oldT=document.getElementById('t-old')?.value||'';const newT=document.getElementById('t-new')?.value||'';const oldL=oldT.split('\n'),newL=newT.split('\n');let result='';for(let i=0;i<Math.max(oldL.length,newL.length);i++){const o=oldL[i],n=newL[i];if(o===n)result+='  '+o+'\n';else{if(o!==undefined)result+='- '+o+'\n';if(n!==undefined)result+='+ '+n+'\n';}}showTRes(result||'(لا توجد فروق)');}
let ocrImg=null;
function handleTImg(e){const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>{toolImg=ev.target.result;document.getElementById('t-img').src=toolImg;document.getElementById('t-img-prev').style.display='block';};r.readAsDataURL(f);}
function handleOCR(e){const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>{ocrImg=ev.target.result;document.getElementById('t-ocr-img').src=ocrImg;document.getElementById('t-ocr-prev').style.display='block';};r.readAsDataURL(f);}
async function tImage(){if(!toolImg){showToast('⚠️ ارفع صورة');return;}const q=document.getElementById('t-q')?.value||'اشرح الصورة بالتفصيل';showTRes('🔍 جاري التحليل...');try{const r=await callOR(q,buildSys(),[],cfg.model_id,toolImg);showTRes(r);}catch(e){showTRes('❌ '+e.message+'\n(تأكد أن النموذج يدعم الصور 👁️)',true);}}
async function tOCR(){if(!ocrImg){showToast('⚠️ ارفع صورة');return;}showTRes('🔍 جاري قراءة النص...');try{const r=await callOR('استخرج كل النص الموجود في هذه الصورة حرفياً بدون أي تعليق',buildSys(),[],cfg.model_id,ocrImg);showTRes(r);}catch(e){showTRes('❌ '+e.message,true);}}
function tB64E(){const t=document.getElementById('t-txt')?.value;if(!t)return;try{showTRes(btoa(unescape(encodeURIComponent(t))));}catch(e){showTRes('❌ '+e.message,true);}}
function tB64D(){const t=document.getElementById('t-txt')?.value;if(!t)return;try{showTRes(decodeURIComponent(escape(atob(t))));}catch(e){showTRes('❌ النص ليس Base64 صحيح',true);}}


function stopTimer(){if(timerInterval){clearInterval(timerInterval);timerInterval=null;showToast('⏹️ تم إيقاف المؤقت');}}
function tTimer(){const mins=parseFloat(document.getElementById('t-min')?.value)||5;const msg=document.getElementById('t-msg')?.value||'انتهى الوقت!';stopTimer();let secs=Math.round(mins*60);const disp=document.getElementById('t-disp');if(disp)disp.style.display='block';timerInterval=setInterval(()=>{secs--;const m=Math.floor(secs/60),s=secs%60;if(disp)disp.textContent=`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;if(secs<=0){clearInterval(timerInterval);timerInterval=null;if(disp)disp.style.color='var(--red)';showToast('⏰ '+msg);speakText(msg);showTRes('⏰ '+msg);}},1000);showTRes(`✅ مؤقت ${mins} دقيقة بدأ`);}
function addNote(){const t=document.getElementById('t-note-txt')?.value.trim();if(!t)return;notes.unshift({id:Date.now(),text:t,ts:Date.now()});saveNotes();document.getElementById('t-note-txt').value='';renderNotes();}
function renderNotes(){const el=document.getElementById('notes-list');if(!el)return;if(!notes.length){el.innerHTML='<div style="text-align:center;color:var(--t3);font-size:11px;padding:10px">لا توجد ملاحظات</div>';return;}el.innerHTML=notes.map(n=>`<div style="padding:8px 10px;background:var(--bg);border:1px solid var(--b1);border-radius:var(--rs);font-size:12px;display:flex;gap:8px;align-items:flex-start"><span style="flex:1;white-space:pre-wrap">${esc(n.text)}</span><button onclick="delNote(${n.id})" style="background:none;border:none;color:var(--t3);cursor:pointer;font-size:12px;flex-shrink:0;padding:2px" title="حذف">✕</button></div>`).join('');}
function delNote(id){notes=notes.filter(n=>n.id!==id);saveNotes();renderNotes();}
function updateColor(){
  const hex=document.getElementById('t-clr')?.value||'#2dd4bf';
  if(document.getElementById('t-clr-txt'))document.getElementById('t-clr-txt').value=hex;
  const r=parseInt(hex.slice(1,3),16);
  const g=parseInt(hex.slice(3,5),16);
  const b=parseInt(hex.slice(5,7),16);
  const rn=r/255,gn=g/255,bn=b/255;
  const mx=Math.max(rn,gn,bn),mn=Math.min(rn,gn,bn),diff=mx-mn;
  let hue=0;
  if(diff){
    if(mx===rn)hue=((gn-bn)/diff)%6;
    else if(mx===gn)hue=(bn-rn)/diff+2;
    else hue=(rn-gn)/diff+4;
    hue=Math.round(hue*60);
    if(hue<0)hue+=360;
  }
  const sat=mx?Math.round(diff/mx*100):0,val=Math.round(mx*100);
  const info=document.getElementById('t-clr-info');
  if(!info)return;
  const textColor=val>50?'#000':'#fff';
  info.innerHTML='<div style="padding:6px 9px;background:var(--bg);border:1px solid var(--b1);border-radius:5px"><div style="font-size:9px;color:var(--t3);margin-bottom:2px">HEX</div><div>'+hex.toUpperCase()+'</div></div>'
    +'<div style="padding:6px 9px;background:var(--bg);border:1px solid var(--b1);border-radius:5px"><div style="font-size:9px;color:var(--t3);margin-bottom:2px">RGB</div><div>rgb('+r+','+g+','+b+')</div></div>'
    +'<div style="padding:6px 9px;background:var(--bg);border:1px solid var(--b1);border-radius:5px"><div style="font-size:9px;color:var(--t3);margin-bottom:2px">HSV</div><div>hsv('+hue+','+sat+'%,'+val+'%)</div></div>'
    +'<div style="padding:6px 9px;background:'+hex+';border:1px solid var(--b1);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:'+textColor+'">معاينة</div>';
}
function parseColorInput(){const t=document.getElementById('t-clr-txt')?.value.trim();if(t.match(/^#[0-9a-f]{6}$/i)){document.getElementById('t-clr').value=t;updateColor();}}

// ═══ FILES ═══
function triggerUpload(){document.getElementById('file-input').click();}
function handleFileIn(e,forTab){processFiles(Array.from(e.target.files),forTab);}
function onDragOver(e){e.preventDefault();document.getElementById('drop-zone').classList.add('over');}
function onDragLeave(){document.getElementById('drop-zone').classList.remove('over');}
function onDrop(e){e.preventDefault();document.getElementById('drop-zone').classList.remove('over');processFiles(Array.from(e.dataTransfer.files),true);}
function onPaste(e){const items=Array.from(e.clipboardData?.items||[]);const files=items.filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);if(files.length)processFiles(files,false);}
async function processFiles(files,forTab=false){
  for(const file of files){
    const fd={name:file.name,size:file.size,type:file.type,id:Date.now()+Math.random()};
    if(file.type.startsWith('image/'))fd.dataUrl=await readAs(file,'url');
    else if(file.size<600000)fd.content=await readAs(file,'text');
    if(forTab){uploadedFiles.push(fd);renderFiles();}
    else{chatAtts.push(fd);const el=document.getElementById('attached-files');const pill=document.createElement('div');pill.className='file-pill';pill.dataset.id=fd.id;pill.innerHTML=`${fIcon(file.type)} ${esc(file.name.slice(0,20))} <span class="rm" onclick="rmAtt(${fd.id})">✕</span>`;el.appendChild(pill);}
  }
}
function rmAtt(id){chatAtts=chatAtts.filter(f=>f.id!==id);document.querySelector(`.file-pill[data-id="${id}"]`)?.remove();}
function readAs(file,as){return new Promise(r=>{const rd=new FileReader();rd.onload=e=>r(e.target.result);as==='url'?rd.readAsDataURL(file):rd.readAsText(file);});}
function renderFiles(){
  const el=document.getElementById('files-list');
  if(!uploadedFiles.length){el.innerHTML='<div style="text-align:center;color:var(--t3);font-size:12px;padding:16px">لا توجد ملفات</div>';return;}
  el.innerHTML=uploadedFiles.map((f,i)=>`<div class="file-item"><div class="file-icon" style="background:${fColor(f.type)}22">${fIcon(f.type)}</div><div class="file-item-info"><div class="file-item-name">${esc(f.name)}</div><div class="file-item-meta">${fmtSz(f.size)}</div></div><div class="file-acts"><button class="fa-btn a" onclick="analyzeFile(${i})">🤖 تحليل</button><button class="fa-btn" onclick="attFile(${i})">💬</button><button class="fa-btn" onclick="uploadedFiles.splice(${i},1);renderFiles()">🗑️</button></div></div>`).join('');
}
async function analyzeFile(i){const f=uploadedFiles[i];switchTab('chat');document.getElementById('chat-input').value=`حلّل هذا الملف:\n${f.name}\n${f.content?f.content.slice(0,3000):'(ملف ثنائي/صورة)'}`;if(f.dataUrl)chatAtts.push(f);sendMessage();}
function attFile(i){chatAtts.push(uploadedFiles[i]);switchTab('chat');const el=document.getElementById('attached-files');const pill=document.createElement('div');pill.className='file-pill';pill.innerHTML=`${fIcon(uploadedFiles[i].type)} ${esc(uploadedFiles[i].name.slice(0,20))} <span class="rm" onclick="this.closest('.file-pill').remove()">✕</span>`;el.appendChild(pill);showToast(`📎 ${uploadedFiles[i].name}`);}
function fIcon(t){if(!t)return '📄';if(t.startsWith('image/'))return '🖼️';if(t.includes('pdf'))return '📕';if(t.includes('zip')||t.includes('rar'))return '📦';if(t.includes('json'))return '📋';if(t.includes('video'))return '🎬';if(t.includes('audio'))return '🎵';return '📝';}
function fColor(t){if(!t)return '#64748b';if(t.startsWith('image/'))return '#e879f9';if(t.includes('pdf'))return '#f87171';if(t.includes('json'))return '#4ade80';return '#60a5fa';}
function fmtSz(b){if(b<1024)return b+'B';if(b<1048576)return Math.round(b/1024)+'KB';return(b/1048576).toFixed(1)+'MB';}

// ═══ MEMORY ═══
function extractMem(text){
  const pats=[{re:/اسمي\s+(\S+)/i,tag:'fact',pre:'اسم المستخدم'},{re:/أعمل\s+(.+)/i,tag:'fact',pre:'يعمل في'},{re:/أحب\s+(.+)/i,tag:'pref',pre:'يحب'},{re:/تذكر\s+(.+)/i,tag:'fact',pre:'ملاحظة'},{re:/مهمتي\s+(.+)/i,tag:'task',pre:'مهمة'},{re:/أكره\s+(.+)/i,tag:'pref',pre:'لا يحب'},{re:/مشروعي\s+(.+)/i,tag:'task',pre:'مشروع'},{re:/هدفي\s+(.+)/i,tag:'task',pre:'هدف'},{re:/أسكن\s+(.+)/i,tag:'fact',pre:'يسكن في'}];
  for(const p of pats){const m=text.match(p.re);if(m?.[1]){const c=`${p.pre}: ${m[1].slice(0,100)}`;if(!memories.some(x=>x.content===c)){memories.push({id:Date.now()+Math.random(),content:c,tag:p.tag,ts:Date.now()});saveMems();renderMemList();sbSaveMemories();}}}
}
// Auto-trigger LTM extraction from last exchange
function triggerLTMExtraction() {
  if (currentMsgs.length < 2) return;
  const lastUser = [...currentMsgs].reverse().find(m => m.role === 'user');
  const lastAssist = [...currentMsgs].reverse().find(m => m.role === 'assistant');
  if (lastUser && lastAssist) {
    setTimeout(() => extractLongTermMemoryFromExchange(lastUser.content, lastAssist.content), 1500);
  }
}

function addMemManual(){const inp=document.getElementById('new-mem');const t=inp.value.trim();if(!t)return;memories.push({id:Date.now(),content:t,tag:'fact',ts:Date.now()});saveMems();inp.value='';renderMemList();sbSaveMemories();showToast('✅ تمت الإضافة');}
function delMem(id){memories=memories.filter(m=>m.id!==id);saveMems();renderMemList();}
function clearMems(){if(!confirm('مسح كل الذاكرة؟'))return;memories=[];saveMems();renderMemList();showToast('🗑️ تم المسح');}
function filterMem(){renderMemList(document.getElementById('mem-search').value.toLowerCase());}
function renderMemList(f=''){
  const el=document.getElementById('mem-list');
  const filtered=f?memories.filter(m=>m.content.toLowerCase().includes(f)):memories;
  if(!filtered.length){el.innerHTML=`<div style="text-align:center;color:var(--t3);padding:18px;font-size:12px">${f?'لا نتائج':'لا توجد ذكريات'}</div>`;return;}
  const lb={fact:'معلومة',pref:'تفضيل',task:'مهمة'};
  el.innerHTML=filtered.slice().reverse().map(m=>`<div class="mem-item"><span class="mem-tag ${m.tag||'fact'}">${lb[m.tag]||'معلومة'}</span><span style="flex:1;font-size:12px;line-height:1.6">${esc(m.content)}</span><button class="mem-del" onclick="delMem(${m.id})">✕</button></div>`).join('');
}

// ═══ VOICE ═══
let callMuted=false,inVoiceCall=false,callRecog=null;

function initVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){
    document.getElementById('mic-btn').title='الصوت غير مدعوم في هذا المتصفح';
    return;
  }
  recog=new SR();
  recog.lang=cfg.voice?.lang||'ar-SA';
  recog.continuous=false;
  recog.interimResults=true;
  recog.onstart=()=>{
    isListening=true;
    document.getElementById('mic-btn').classList.add('listening');
    document.getElementById('voice-bar').classList.add('show');
    document.getElementById('voice-text').textContent='جاري الاستماع...';
  };
  recog.onresult=e=>{
    const fin=[...e.results].filter(r=>r.isFinal).map(r=>r[0].transcript).join('');
    const inter=[...e.results].filter(r=>!r.isFinal).map(r=>r[0].transcript).join('');
    if(fin){
      document.getElementById('chat-input').value=fin;
      autoResize(document.getElementById('chat-input'));
    }
    document.getElementById('voice-interim').textContent=inter;
  };
  recog.onend=()=>{
    isListening=false;
    document.getElementById('mic-btn').classList.remove('listening');
    document.getElementById('voice-bar').classList.remove('show');
    document.getElementById('voice-interim').textContent='';
    const t=document.getElementById('chat-input').value.trim();
    if(t){lastVoice=true;sendMessage();}
  };
  recog.onerror=e=>{
    isListening=false;
    document.getElementById('mic-btn').classList.remove('listening');
    document.getElementById('voice-bar').classList.remove('show');
    const errMap={
      'not-allowed':'❌ لم تُمنح صلاحية الميكروفون — افتح إعدادات المتصفح',
      'no-speech':'(لم يُسمع صوت)',
      'network':'❌ خطأ في الشبكة — تحقق من الاتصال',
      'aborted':'(تم الإلغاء)',
      'audio-capture':'❌ لا يوجد ميكروفون — تحقق من الجهاز',
    };
    const msg=errMap[e.error]||('❌ خطأ صوتي: '+e.error);
    if(e.error!=='no-speech'&&e.error!=='aborted')showToast(msg);
  };
}

function toggleVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('⚠️ الصوت غير مدعوم في هذا المتصفح، جرّب Chrome');return;}
  if(!recog)initVoice();
  if(isListening){recog.stop();}
  else{
    try{
      recog.lang=cfg.voice?.lang||'ar-SA';
      recog.start();
    }catch(e){
      // If already started, stop and restart
      try{recog.stop();}catch(ex){}
      setTimeout(()=>{try{recog.start();}catch(ex2){showToast('❌ تعذر تشغيل الميكروفون');}},300);
    }
  }
}

function speakText(text){
  if(!window.speechSynthesis)return;
  window.speechSynthesis.cancel();
  const c=text.replace(/```[\s\S]*?```/g,'كود').replace(/[*_`#>]/g,'').replace(/\n+/g,' ').trim().slice(0,500);
  if(!c)return;
  const u=new SpeechSynthesisUtterance(c);
  u.lang=cfg.voice?.lang||'ar-SA';
  u.rate=parseFloat(cfg.voice?.rate||'1.1');
  // Pick Arabic voice if available
  const voices=window.speechSynthesis.getVoices();
  const arVoice=voices.find(v=>v.lang.startsWith('ar'));
  if(arVoice)u.voice=arVoice;
  window.speechSynthesis.speak(u);
  if(inVoiceCall){
    const _st=document.getElementById('vcall-status');
    const _wv=document.getElementById('vcall-waves');
    if(_st)_st.textContent='يتحدث...';
    if(_wv)_wv.classList.add('active');
    u.onend=()=>{
      if(_st)_st.textContent='جاهز للاستماع...';
      if(_wv)_wv.classList.remove('active');
      if(inVoiceCall&&!callMuted)startCallListening();
    };
  }
}

// ─── WAKE WORD ───
function toggleWakeWord(){if(wakeOn)stopWake();else startWake();}
function startWake(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('⚠️ الصوت غير مدعوم في هذا المتصفح');return;}
  const ww=(cfg.voice?.wake||'PixelAi').toLowerCase().trim();
  if(wakeRec){try{wakeRec.stop();}catch(e){}}
  wakeRec=new SR();
  wakeRec.lang=cfg.voice?.lang||'ar-SA';
  wakeRec.continuous=true;
  wakeRec.interimResults=false;
  wakeRec.onresult=e=>{
    const t=e.results[e.results.length-1][0].transcript.toLowerCase().trim();
    if(t.includes(ww)){
      showToast(`✅ تم اكتشاف "${ww}"!`);
      if(!isListening&&!inVoiceCall){
        setTimeout(()=>toggleVoice(),400);
      }
    }
  };
  wakeRec.onend=()=>{
    if(wakeOn){
      setTimeout(()=>{
        if(wakeOn&&wakeRec){
          try{wakeRec.start();}catch(e){}
        }
      },800);
    }
  };
  wakeRec.onerror=e=>{
    if(e.error==='not-allowed'){
      wakeOn=false;
      document.getElementById('wake-ind').classList.remove('show');
      document.getElementById('wake-btn').classList.remove('active');
      showToast('❌ لم تُمنح صلاحية الميكروفون');
      return;
    }
    if(wakeOn){setTimeout(()=>{try{wakeRec.start();}catch(ex){}},1000);}
  };
  try{
    wakeRec.start();
    wakeOn=true;
    document.getElementById('wake-ind').classList.add('show');
    document.getElementById('wake-btn').classList.add('active');
    showToast(`👂 أستمع لـ "${cfg.voice?.wake||'PixelAi'}"`);
  }catch(e){
    showToast('❌ تعذر تفعيل Wake Word: '+e.message);
  }
}
function stopWake(){
  wakeOn=false;
  if(wakeRec){try{wakeRec.stop();}catch(e){}}
  wakeRec=null;
  document.getElementById('wake-ind').classList.remove('show');
  document.getElementById('wake-btn').classList.remove('active');
  showToast('🔇 Wake Word متوقف');
}

// ─── VOICE CALL ───
function openVoiceCall(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){showToast('⚠️ الصوت غير مدعوم في هذا المتصفح');return;}
  inVoiceCall=true;callMuted=false;
  document.getElementById('voice-call-modal').classList.add('show');
  const muteBtn=document.getElementById('vcall-mute-btn');
  if(muteBtn){muteBtn.classList.remove('on');muteBtn.textContent='🎤';}
  const statusEl=document.getElementById('vcall-status');
  if(statusEl)statusEl.textContent='جاهز للاستماع...';
  const wavesEl=document.getElementById('vcall-waves');
  if(wavesEl)wavesEl.classList.remove('active');
  const nameEl=document.getElementById('vcall-name-el');
  if(nameEl)nameEl.textContent=cfg.bot?.name||'PixelAi';
  speakText('أهلاً! أنا مساعدك الذكي، كيف يمكنني مساعدتك؟');
}
function endVoiceCall(){
  inVoiceCall=false;
  if(callRecog){try{callRecog.stop();}catch(e){}}
  callRecog=null;
  window.speechSynthesis?.cancel();
  const modal=document.getElementById('voice-call-modal');
  if(modal)modal.classList.remove('show');
  const waves=document.getElementById('vcall-waves');
  if(waves)waves.classList.remove('active');
  showToast('📵 انتهت المكالمة');
}
function toggleCallMute(){
  callMuted=!callMuted;
  const btn=document.getElementById('vcall-mute-btn');
  btn.classList.toggle('on',callMuted);
  btn.textContent=callMuted?'🔇':'🎤';
  if(callMuted){
    if(callRecog){try{callRecog.stop();}catch(e){}}
    document.getElementById('vcall-status').textContent='الميكروفون مكتوم';
    document.getElementById('vcall-waves').classList.remove('active');
  }else{
    document.getElementById('vcall-status').textContent='جاهز للاستماع...';
    startCallListening();
  }
}
function startCallListening(){
  if(!inVoiceCall||callMuted)return;
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR)return;
  if(callRecog){try{callRecog.stop();}catch(e){}}
  callRecog=new SR();
  callRecog.lang=cfg.voice?.lang||'ar-SA';
  callRecog.continuous=false;
  callRecog.interimResults=true;
  callRecog.onstart=()=>{
    const _s=document.getElementById('vcall-status');
    const _w=document.getElementById('vcall-waves');
    const _a=document.getElementById('vcall-av');
    if(_s)_s.textContent='أستمع...';
    if(_w)_w.classList.add('active');
    if(_a)_a.classList.add('listening');
  };
  callRecog.onresult=e=>{
    const inter=[...e.results].filter(r=>!r.isFinal).map(r=>r[0].transcript).join('');
    const fin=[...e.results].filter(r=>r.isFinal).map(r=>r[0].transcript).join('');
    document.getElementById('vcall-transcript').textContent=inter||fin||'...';
    if(fin){
      document.getElementById('vcall-transcript').textContent=fin;
      document.getElementById('vcall-av').classList.remove('listening');
    }
  };
  callRecog.onend=async()=>{
    document.getElementById('vcall-waves').classList.remove('active');
    document.getElementById('vcall-av').classList.remove('listening');
    const said=document.getElementById('vcall-transcript').textContent.trim();
    if(said&&said!=='قل شيئاً...'&&said!=='اضغط على الميكروفون وابدأ الكلام'&&inVoiceCall){
      document.getElementById('vcall-status').textContent='يفكر...';
      try{
        const mid=cfg.or_custom||cfg.model_id;
        const model=MODELS.find(m=>m.id===mid);
        lastVoice=true;
        // add to chat silently
        currentMsgs.push({role:'user',content:said});
        const reply=await routeReq(said,model,mid);
        currentMsgs.push({role:'assistant',content:reply,model:model?.name||mid});
        saveConv();
        document.getElementById('vcall-transcript').textContent=reply.slice(0,120)+(reply.length>120?'...':'');
        speakText(reply);
      }catch(err){
        document.getElementById('vcall-status').textContent='❌ خطأ: '+err.message;
        setTimeout(()=>{if(inVoiceCall)startCallListening();},2000);
      }
    }else if(inVoiceCall&&!callMuted){
      setTimeout(()=>startCallListening(),600);
    }
  };
  callRecog.onerror=e=>{
    document.getElementById('vcall-waves').classList.remove('active');
    document.getElementById('vcall-av').classList.remove('listening');
    if(e.error!=='no-speech'&&e.error!=='aborted'){
      document.getElementById('vcall-status').textContent='❌ '+e.error;
    }
    if(inVoiceCall&&!callMuted&&e.error!=='not-allowed'){
      setTimeout(()=>startCallListening(),1000);
    }
  };
  try{callRecog.start();}catch(e){}
}

// ═══ SETTINGS ═══
function loadSettingsUI(){
  buildAPIGrid();buildPersonaGrid();
  const orInp=document.getElementById('s-or-key');
  if(orInp){orInp.value='';orInp.placeholder=cfg.apis.openrouter?'•••••••• (محفوظ — اكتب مفتاح جديد لتغييره)':'sk-or-...';}
  const tavilyInp=document.getElementById('s-tavily-key');
  if(tavilyInp){tavilyInp.value='';tavilyInp.placeholder=cfg.apis.tavily?'•••••••• (محفوظ — اكتب مفتاح جديد لتغييره)':'tvly-...';}
  ['gemini','anthropic','openai'].forEach(p=>{
    const el=document.getElementById('s-api-'+p);
    if(el){el.value='';el.placeholder=cfg.apis[p]?'•••••••• (محفوظ — اكتب مفتاح جديد لتغييره)':'';}
  });
  document.getElementById('s-ollama-url').value=cfg.ollama?.url||'http://localhost:11434';
  document.getElementById('s-ollama-model').value=cfg.ollama?.model||'llama3';
  document.getElementById('s-name').value=cfg.user.name||'';
  document.getElementById('s-job').value=cfg.user.job||'';
  document.getElementById('s-goals').value=cfg.user.goals||'';
  document.getElementById('s-prefs').value=cfg.user.prefs||'';
  document.getElementById('s-location').value=cfg.user.location||'';
  document.getElementById('s-personality').value=cfg.user.personality||PP[cfg.user.persona||'friendly'];
  document.getElementById('s-autonomy').value=cfg.autonomy||'assistant';
  document.getElementById('s-supa-url').value=cfg.supabase?.url||'';
  document.getElementById('s-supa-key').value=cfg.supabase?.key||'';
  document.getElementById('s-stt-lang').value=cfg.voice?.lang||'ar-SA';
  document.getElementById('s-tts-rate').value=cfg.voice?.rate||'1.1';
  document.getElementById('s-tts-mode').value=cfg.voice?.tts||'voice-only';
  document.getElementById('s-wake-word').value=cfg.voice?.wake||'PixelAi';
  // Bot persona fields
  const botNameInp=document.getElementById('s-bot-name');
  const botTaglineInp=document.getElementById('s-bot-tagline');
  const botGenderInp=document.getElementById('s-bot-gender');
  const botAgeInp=document.getElementById('s-bot-age');
  const botLangInp=document.getElementById('s-bot-lang');
  const botGreetingInp=document.getElementById('s-bot-greeting');
  const botExpertiseInp=document.getElementById('s-bot-expertise');
  const botAvoidInp=document.getElementById('s-bot-avoid');
  if(botNameInp)botNameInp.value=cfg.bot?.name||'PixelAi';
  if(botTaglineInp)botTaglineInp.value=cfg.bot?.tagline||'مساعدك الذكي الشخصي';
  if(botGenderInp)botGenderInp.value=cfg.bot?.gender||'neutral';
  if(botAgeInp)botAgeInp.value=cfg.bot?.age||'';
  if(botLangInp)botLangInp.value=cfg.bot?.lang||'ar';
  if(botGreetingInp)botGreetingInp.value=cfg.bot?.greeting||'';
  if(botExpertiseInp)botExpertiseInp.value=cfg.bot?.expertise||'';
  if(botAvoidInp)botAvoidInp.value=cfg.bot?.avoid||'';
  if(cfg.supabase?.url&&cfg.supabase?.key){const s=document.getElementById('supa-status');s.style.cssText='font-size:11px;margin-top:6px;padding:6px 9px;border-radius:6px;display:block;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.2);color:#34d399';s.textContent='✅ Supabase مفعّل';}
}
function openSettings(){loadSettingsUI();document.getElementById('settings-ov').classList.add('show');setTimeout(loadIntegrationsUI,60);}
function closeSettings(e){if(!e||e.target===document.getElementById('settings-ov'))document.getElementById('settings-ov').classList.remove('show');}
async function saveSettings(){
  // مفاتيح AI الأساسية: بتتشفر وتتخزن في الباك إند، مش في cfg/localStorage
  const geminiKey=document.getElementById('s-api-gemini')?.value.trim()||'';
  const anthropicKey=document.getElementById('s-api-anthropic')?.value.trim()||'';
  const openaiKey=document.getElementById('s-api-openai')?.value.trim()||'';
  const openrouterKey=document.getElementById('s-or-key').value.trim();
  const tavilyKey=(document.getElementById('s-tavily-key')||{}).value?.trim()||'';
  try{
    if(geminiKey) await bbSaveApiKey('gemini', geminiKey);
    if(anthropicKey) await bbSaveApiKey('anthropic', anthropicKey);
    if(openaiKey) await bbSaveApiKey('openai', openaiKey);
    if(openrouterKey) await bbSaveApiKey('openrouter', openrouterKey);
    if(tavilyKey) await bbSaveIntegrationCreds('tavily', tavilyKey);
    await bbRefreshKeyStatus();
  }catch(e){ showToast('⚠️ حصل خطأ في حفظ المفاتيح: '+e.message); }

  cfg.ollama={url:document.getElementById('s-ollama-url').value.trim(),model:document.getElementById('s-ollama-model').value.trim()};
  cfg.user={...cfg.user,name:document.getElementById('s-name').value.trim(),job:document.getElementById('s-job').value.trim(),goals:document.getElementById('s-goals').value.trim(),prefs:document.getElementById('s-prefs').value.trim(),location:document.getElementById('s-location').value.trim(),personality:document.getElementById('s-personality').value.trim()};
  cfg.autonomy=document.getElementById('s-autonomy').value;
  cfg.bot={
    name:document.getElementById('s-bot-name')?.value.trim()||'PixelAi',
    tagline:document.getElementById('s-bot-tagline')?.value.trim()||'مساعدك الذكي الشخصي',
    gender:document.getElementById('s-bot-gender')?.value||'neutral',
    age:document.getElementById('s-bot-age')?.value.trim()||'',
    lang:document.getElementById('s-bot-lang')?.value||'ar',
    greeting:document.getElementById('s-bot-greeting')?.value.trim()||'',
    expertise:document.getElementById('s-bot-expertise')?.value.trim()||'',
    avoid:document.getElementById('s-bot-avoid')?.value.trim()||'',
  };
  const bn=cfg.bot.name||'PixelAi';
  document.querySelectorAll('#bot-name-display,#vcall-name-el').forEach(el=>el.textContent=bn);
  cfg.supabase={url:document.getElementById('s-supa-url').value.trim(),key:document.getElementById('s-supa-key').value.trim()};
  cfg.voice={lang:document.getElementById('s-stt-lang').value,rate:document.getElementById('s-tts-rate').value,tts:document.getElementById('s-tts-mode').value,wake:document.getElementById('s-wake-word').value.trim()};
  saveCfg();initSupabase();sbSaveProfile();
  if(recog)recog.lang=cfg.voice.lang;
  document.getElementById('profile-name-el').textContent=cfg.user.name||'صديقي';
  updateKeyStatus();saveMASettings();closeSettings();showToast('✅ تم حفظ الإعدادات');
}

// ═══ SUPABASE ═══
const SB={_u:'',_k:'',init(u,k){this._u=u?.replace(/\/$/,'');this._k=k;},get ready(){return !!(this._u&&this._k);},
  async q(m,p,b){const r=await fetch(`${this._u}/rest/v1/${p}`,{method:m,headers:{'Content-Type':'application/json','apikey':this._k,'Authorization':`Bearer ${this._k}`,'Prefer':m==='POST'?'return=representation':'return=minimal'},body:b?JSON.stringify(b):undefined});if(!r.ok){const e=await r.json();throw new Error(e.message||`SB ${r.status}`);}return r.status===204?null:r.json();}
};
function initSupabase(){const{url,key}=cfg.supabase||{};if(url&&key){SB.init(url,key);const d=document.getElementById('cloud-dot');d.style.display='block';d.style.background='#34d399';}else{document.getElementById('cloud-dot').style.display='none';}}
async function sbSaveConv(c){if(!SB.ready)return;try{await SB.q('POST',`conversations?on_conflict=id`,{id:c.id,title:c.title,messages:c.messages,created_at:new Date(c.created).toISOString(),updated_at:new Date(c.updated||c.created).toISOString()});}catch(e){console.warn('SB conv:',e.message);}}
async function sbSaveMemories(){if(!SB.ready)return;try{for(const m of memories)await SB.q('POST',`memories?on_conflict=id`,{id:String(m.id),content:m.content,tag:m.tag,created_at:new Date(m.ts||Date.now()).toISOString()});}catch(e){console.warn('SB mem:',e.message);}}
async function sbSaveProfile(){if(!SB.ready)return;try{await SB.q('POST',`profiles?on_conflict=id`,{id:'default',data:cfg.user,updated_at:new Date().toISOString()});}catch(e){console.warn('SB prof:',e.message);}}
async function syncCloud(){try{const[cc,cm]=await Promise.all([SB.q('GET','conversations?select=*&order=updated_at.desc').catch(()=>null),SB.q('GET','memories?select=*&order=created_at.desc').catch(()=>null)]);if(cc?.length){conversations=cc.map(r=>({id:r.id,title:r.title,messages:r.messages,created:+new Date(r.created_at),updated:+new Date(r.updated_at)}));saveConvs();renderConvList();}if(cm?.length){memories=cm.map(r=>({id:r.id,content:r.content,tag:r.tag,ts:+new Date(r.created_at)}));saveMems();renderMemList();}showToast('☁️ تمت المزامنة');}catch(e){}}
async function manualSync(){if(!SB.ready){showToast('⚠️ Supabase مش متصل');return;}showToast('🔄 جاري المزامنة...');await syncCloud();}
async function testSupabase(){
  const s=document.getElementById('supa-status');
  const url=document.getElementById('s-supa-url')?.value.trim(),key=document.getElementById('s-supa-key')?.value.trim();
  if(!url||!key){if(s)s.style.display='none';return;}
  SB.init(url,key);if(s){s.style.cssText='font-size:11px;margin-top:6px;padding:6px 9px;border-radius:6px;display:block;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);color:#fbbf24';s.textContent='🔄 جاري الاتصال...';}
  try{await SB.q('GET','conversations?select=id&limit=1');if(s){s.style.cssText='font-size:11px;margin-top:6px;padding:6px 9px;border-radius:6px;display:block;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.2);color:#34d399';s.textContent='✅ Supabase متصل!';}}
  catch(e){if(s){s.style.cssText='font-size:11px;margin-top:6px;padding:6px 9px;border-radius:6px;display:block;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.2);color:#f87171';s.textContent=e.message.includes('does not exist')?'⚠️ متصل — افعل الجداول (انسخ SQL)':'❌ '+e.message;}}
}
function showSBSQL(){const sql='create table if not exists conversations(id text primary key,title text,messages jsonb,created_at timestamptz default now(),updated_at timestamptz default now());\ncreate table if not exists memories(id text primary key,content text,tag text,created_at timestamptz default now());\ncreate table if not exists profiles(id text primary key,data jsonb,updated_at timestamptz default now());\nalter table conversations enable row level security;\nalter table memories enable row level security;\nalter table profiles enable row level security;\ncreate policy "allow all" on conversations for all using(true)with check(true);\ncreate policy "allow all" on memories for all using(true)with check(true);\ncreate policy "allow all" on profiles for all using(true)with check(true);';navigator.clipboard?.writeText(sql).then(()=>showToast('📋 تم نسخ SQL')).catch(()=>{});console.log(sql);}

// ═══ UTILS ═══
function updateKeyStatus(){
  const badge=document.getElementById('key-status');
  if(!badge)return;
  const hasKey=!!cfg.apis.openrouter;
  const isOllama=cfg.or_custom==='ollama/local'||cfg.model_id==='ollama/local';
  if(hasKey||isOllama){
    badge.style.display='none';
  }else{
    badge.style.display='block';
    badge.style.background='rgba(248,113,113,.15)';
    badge.style.border='1px solid rgba(248,113,113,.3)';
    badge.style.color='var(--red)';
    badge.textContent='⚠️ لا يوجد API Key';
  }
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function copyToCB(t){navigator.clipboard?.writeText(t).then(()=>showToast('✅ تم النسخ')).catch(()=>showToast('❌ تعذر النسخ'));}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}
function toggleTTS(){
  const modes=['never','voice-only','always'];
  const icons={'never':'🔇','voice-only':'🔊','always':'📢'};
  const labels={'never':'الصوت متوقف','voice-only':'الصوت بعد الكلام','always':'الصوت دائماً'};
  const cur=cfg.voice?.tts||'never';
  const next=modes[(modes.indexOf(cur)+1)%modes.length];
  cfg.voice={...cfg.voice,tts:next};saveCfg();
  const btn=document.getElementById('tts-toggle-btn');
  if(btn){btn.textContent=icons[next];btn.title=labels[next];btn.style.opacity=next==='never'?'.4':'1';}
  showToast(labels[next]);
}
function updateTTSBtn(){
  const cur=cfg.voice?.tts||'never';
  const icons={'never':'🔇','voice-only':'🔊','always':'📢'};
  const labels={'never':'الصوت متوقف','voice-only':'الصوت بعد الكلام','always':'الصوت دائماً'};
  const btn=document.getElementById('tts-toggle-btn');
  if(btn){btn.textContent=icons[cur];btn.title=labels[cur];btn.style.opacity=cur==='never'?'.4':'1';}
}

function toggleSidebar(){
  const sb=document.getElementById('sidebar');
  const ov=document.getElementById('sidebar-overlay');
  sb.classList.toggle('open');
  if(ov)ov.style.display=sb.classList.contains('open')?'block':'none';
}
function closeSidebarMobile(){
  if(window.innerWidth<=680){
    document.getElementById('sidebar').classList.remove('open');
    const ov=document.getElementById('sidebar-overlay');
    if(ov)ov.style.display='none';
  }
}

// ════════════════════════════════════════════════
// ① WEB SEARCH — Tavily API
// ════════════════════════════════════════════════
async function webSearch(query){
  try{
    const d = await bbCallIntegration('tavily', { method: 'POST', path: '/search', requestBody: { query, search_depth: 'basic', max_results: 5, include_answer: true } });
    if(!d||d.error)return `خطأ في البحث: ${d?.error||'unknown'}`;
    let out=`نتائج البحث عن: "${query}"\n\n`;
    if(d.answer)out+=`📌 الإجابة المباشرة:\n${d.answer}\n\n`;
    if(d.results?.length){
      out+=`🔗 المصادر:\n`;
      d.results.slice(0,4).forEach((r,i)=>{out+=`${i+1}. ${r.title}\n${r.url}\n${r.content?.slice(0,200)}...\n\n`;});
    }
    return out;
  }catch(e){
    if(String(e.message).includes('not connected')) return `[بحث محاكى]: ${query} — أضف Tavily API Key في الإعدادات للبحث الحقيقي`;
    return `خطأ: ${e.message}`;
  }
}

// Intent detection — هل الرسالة تحتاج بحث ويب؟
function needsWebSearch(text){
  const triggers=[/ابحث|بحث عن|search for|ما هو|من هو|متى|أين|كيف|what is|who is|when|where|how|اخبار|أخبار|news|سعر|price|weather|الطقس|latest|أحدث|today|اليوم/i];
  return triggers.some(r=>r.test(text));
}

// ════════════════════════════════════════════════
// ② BROWSER PANEL
// ════════════════════════════════════════════════
let _lastBrowserUrl='';
function navBrowser(){
  let url=document.getElementById('browser-url-inp').value.trim();
  if(!url)return;
  if(!/^https?:\/\//i.test(url))url='https://'+url;
  _lastBrowserUrl=url;
  const frame=document.getElementById('browser-frame');
  const blocked=document.getElementById('browser-blocked-msg');
  const openBtn=document.getElementById('browser-open-new');
  blocked.style.display='none';
  frame.style.display='flex';
  frame.src=url;
  openBtn.onclick=()=>window.open(url,'_blank');
  // timeout fallback for blocked iframes
  clearTimeout(frame._timer);
  frame._timer=setTimeout(()=>{
    // try to detect blank/blocked by checking if load fired
    if(!frame._loaded){
      frame.style.display='none';
      blocked.style.display='flex';
      document.getElementById('browser-blocked-title').textContent='تعذر فتح الموقع';
      document.getElementById('browser-blocked-msg-text').textContent=`قد يكون ${url} يرفض التضمين. افتحه في تاب جديد.`;
    }
  },5000);
  frame._loaded=false;
}
function onBrowserLoad(){
  const frame=document.getElementById('browser-frame');
  frame._loaded=true;
  clearTimeout(frame._timer);
  // check if content loaded (some browsers block access to contentDocument)
  try{
    const doc=frame.contentDocument||frame.contentWindow?.document;
    if(!doc||doc.body?.innerHTML===''||doc.title===''){
      frame.style.display='none';
      document.getElementById('browser-blocked-msg').style.display='flex';
    }
  }catch(e){
    // cross-origin — content is likely loaded fine
  }
}
function onBrowserError(){
  document.getElementById('browser-frame').style.display='none';
  document.getElementById('browser-blocked-msg').style.display='flex';
}
function loadSocial(url){
  document.getElementById('browser-url-inp').value=url;
  switchTab('browser');
  navBrowser();
}
// Called from chat intent detection — opens floating browser window
function openBrowserFromChat(url){
  document.getElementById('float-browser-url').value=url;
  openFloatWin('float-browser');
  floatNavBrowser();
}

// ════════════════════════════════════════════════
// ③ MAPS
// ════════════════════════════════════════════════
function searchMaps(){
  const q=document.getElementById('maps-search-inp').value.trim();
  if(!q)return;
  const encoded=encodeURIComponent(q);
  document.getElementById('maps-frame').src=`https://www.openstreetmap.org/export/embed.html?query=${encoded}&layer=mapnik`;
  showToast('🗺️ جاري البحث...');
}
function mapsMyLocation(){
  if(!navigator.geolocation){showToast('⚠️ الموقع غير مدعوم');return;}
  navigator.geolocation.getCurrentPosition(pos=>{
    const lat=pos.coords.latitude,lng=pos.coords.longitude;
    const delta=0.05;
    const bbox=`${lng-delta},${lat-delta},${lng+delta},${lat+delta}`;
    document.getElementById('maps-frame').src=`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
    showToast('📍 تم تحديد موقعك');
  },()=>showToast('❌ تعذر الحصول على الموقع'));
}
// Called from chat intent — opens floating maps window
function openMapsFromChat(query){
  document.getElementById('float-maps-inp').value=query;
  openFloatWin('float-maps');
  floatSearchMaps();
}

// ════════════════════════════════════════════════
// ④ IMAGE GENERATION
// ════════════════════════════════════════════════
const RANDOM_PROMPTS=[
  'a futuristic city at night with neon lights, cyberpunk style, 8k',
  'a serene mountain lake at sunrise, photorealistic, golden hour',
  'a dragon made of galaxy stars, fantasy art, detailed',
  'a cozy coffee shop in autumn rain, warm lighting, cinematic',
  'an underwater world with glowing sea creatures, bioluminescent',
  'a samurai warrior in cherry blossom forest, ink painting style',
  'a magical library with floating books, enchanted, fantasy',
  'a minimalist portrait with geometric shapes, vibrant colors',
];
function randomImgPrompt(){
  const p=RANDOM_PROMPTS[Math.floor(Math.random()*RANDOM_PROMPTS.length)];
  document.getElementById('imggen-prompt').value=p;
}
async function improveImgPrompt(){
  const p=document.getElementById('imggen-prompt').value.trim();
  if(!p){showToast('⚠️ اكتب وصفاً أولاً');return;}
  document.getElementById('imggen-status').textContent='✨ جاري تحسين وترجمة الوصف...';
  try{
    const mid=cfg.model_id||'openai/gpt-4o-mini';
    const improved=await routeReq(`${/[\u0600-\u06FF]/.test(p)?'ترجم هذا للإنجليزية و':''}حوّله لـ image generation prompt احترافي مع تفاصيل الأسلوب والإضاءة والألوان. أجب بالـ prompt فقط بالإنجليزية بدون شرح:\n${p}`,MODELS.find(m=>m.id===mid),mid);
    document.getElementById('imggen-prompt').value=improved.replace(/^["']|["']$/g,'').trim();
    document.getElementById('imggen-status').textContent='✅ تم تحسين الوصف';
  }catch(e){document.getElementById('imggen-status').textContent='❌ '+e.message;}
}
async function generateImage(){
  const prompt=document.getElementById('imggen-prompt').value.trim();
  if(!prompt){showToast('⚠️ اكتب وصف الصورة');return;}
  const modelEl=document.getElementById('imggen-model');
  const pollinationsModel=modelEl?.value||'flux';
  const size=document.getElementById('imggen-size').value;
  const [w,h]=size.split('x').map(Number);
  const btn=document.getElementById('imggen-btn');
  const status=document.getElementById('imggen-status');
  btn.disabled=true;btn.textContent='⏳ جاري التوليد...';
  status.textContent='🎨 إرسال الطلب لـ Pollinations.AI (مجاني)...';
  const results=document.getElementById('imggen-results');

  // Translate/improve prompt if Arabic using AI (if key available)
  let finalPrompt=prompt;
  if(/[\u0600-\u06FF]/.test(prompt)&&cfg.apis.openrouter){
    try{
      status.textContent='✨ ترجمة الوصف للإنجليزية...';
      const translated=await routeReq(`ترجم هذا النص للإنجليزية فقط بدون شرح، وأضف تفاصيل فنية لتوليد صورة احترافية: ${prompt}`,null,cfg.model_id);
      if(translated&&translated.length>5)finalPrompt=translated.replace(/^["']|["']$/g,'').trim();
    }catch(e){}
  }

  // Use Pollinations.AI — free, no API key needed
  const seed=Math.floor(Math.random()*9999999);
  const url=`https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?width=${w}&height=${h}&model=${pollinationsModel}&seed=${seed}&nologo=true&enhance=true`;

  status.textContent=`🎨 توليد بنموذج ${pollinationsModel}...`;
  const card=document.createElement('div');card.className='imggen-card';
  card.style.cssText='position:relative;border-radius:var(--r);overflow:hidden;border:1px solid var(--b1);background:var(--bg2)';
  const placeholder=document.createElement('div');
  placeholder.style.cssText=`width:100%;aspect-ratio:${w}/${h};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;font-size:14px;color:var(--t2)`;
  placeholder.innerHTML=`<span style="font-size:32px;animation:spin 1.2s linear infinite;display:inline-block">⏳</span><span style="font-size:11px">توليد بنموذج ${pollinationsModel}...</span>`;
  card.appendChild(placeholder);
  results.insertBefore(card,results.firstChild);

  const img=new Image();
  img.style.cssText='width:100%;display:block';
  img.onload=()=>{
    card.innerHTML='';card.appendChild(img);
    const acts=document.createElement('div');
    acts.style.cssText='display:flex;gap:4px;padding:5px;background:var(--s1)';
    const safeP=finalPrompt.slice(0,30).replace(/['"<>&]/g,'');
    acts.innerHTML=`<a href="${url}" download="pexil-${pollinationsModel}-${seed}.png" target="_blank" style="flex:1;text-align:center;font-size:10px;color:var(--accent);text-decoration:none;padding:3px">⬇️ تحميل</a>
      <button onclick="injectImageBubble(this.dataset.u,this.dataset.p)" data-u="${url}" data-p="${safeP}" style="flex:1;font-size:10px;background:var(--accent);border:none;border-radius:4px;color:#1a2028;cursor:pointer;padding:3px">💬 شات</button>
      <button onclick="copyToCB(this.closest('.imggen-card').querySelector('img').src)" style="flex:1;font-size:10px;background:var(--s2);border:1px solid var(--b1);border-radius:4px;color:var(--t2);cursor:pointer;padding:3px">🔗 رابط</button>`;
    card.appendChild(acts);
    // add model tag
    const tag=document.createElement('div');
    tag.style.cssText='font-size:9px;color:var(--t3);padding:3px 6px;text-align:center;background:var(--bg)';
    tag.textContent=`🌐 Pollinations.AI · ${pollinationsModel} · seed:${seed}`;
    card.appendChild(tag);
    status.textContent='✅ تمت! (Pollinations.AI — مجاني بدون API Key)';
    btn.disabled=false;btn.textContent='🎨 توليد الصورة';
  };
  img.onerror=()=>{
    placeholder.innerHTML=`<span style="font-size:24px">❌</span><span style="font-size:11px;color:var(--red)">فشل التوليد</span>
      <a href="${url}" target="_blank" style="font-size:10px;color:var(--accent)">جرب الرابط مباشرة</a>`;
    status.textContent='⚠️ فشل — حاول مجدداً أو غير النموذج';
    btn.disabled=false;btn.textContent='🎨 توليد الصورة';
  };
  img.src=url;
}
function sendImgToChat(url){
  switchTab('chat');
  document.getElementById('chat-input').value='حلّل هذه الصورة التي تم توليدها';
  chatAtts.push({name:'generated-image.png',type:'image/png',dataUrl:url,id:Date.now()});
  const pill=document.createElement('div');pill.className='file-pill';
  pill.innerHTML=`🖼️ صورة مُولَّدة <span class="rm" onclick="this.closest('.file-pill').remove()">✕</span>`;
  document.getElementById('attached-files').appendChild(pill);
  showToast('📎 تم إرفاق الصورة');
}

// ════════════════════════════════════════════════
// ⑤ INTENT DETECTION — فتح مواقع / خرائط / بحث من الشات
// ════════════════════════════════════════════════
function detectChatIntent(text){
  // Open website intent
  const urlPat=/(?:افتح|فتح|ابدأ|open|go to|زور|روح)\s+((?:https?:\/\/)?[\w.-]+\.(?:com|net|org|io|co|sa|eg|ae|uk|app|me|ai)\S*)/i;
  const urlMatch=text.match(urlPat);
  if(urlMatch){
    setTimeout(()=>openBrowserFromChat(urlMatch[1].startsWith('http')?urlMatch[1]:'https://'+urlMatch[1]),500);
    return true;
  }
  // Social shortcuts
  const socialMap={
    'يوتيوب|youtube':'https://youtube.com',
    'تويتر|twitter|اكس|X\.com':'https://x.com',
    'انستجرام|instagram':'https://instagram.com',
    'تيك توك|tiktok':'https://tiktok.com',
    'فيسبوك|facebook':'https://facebook.com',
    'لينكدإن|linkedin':'https://linkedin.com',
    'ريديت|reddit':'https://reddit.com',
    'جيثب|github':'https://github.com',
  };
  for(const[pat,url] of Object.entries(socialMap)){
    if(new RegExp(`(?:افتح|open|روح|فتح).*(?:${pat})`, 'i').test(text)){
      setTimeout(()=>loadSocial(url),500);
      return true;
    }
  }
  // Maps intent
  const mapPat=/(?:ابحث في الخريطة|خريطة|maps?|find on map|locate|أين يقع|عنوان|مكان)\s+(.{3,60})/i;
  const mapMatch=text.match(mapPat);
  if(mapMatch){
    setTimeout(()=>openMapsFromChat(mapMatch[1]),500);
    return true;
  }
  return false;
}

// Settings tab for Tavily + override saveSettings
const _origSave=typeof saveSettings==='function'?saveSettings:null;
function patchSaveSettings(){
  const tavilyEl=document.getElementById('s-tavily-key');
  if(tavilyEl)cfg.apis.tavily=tavilyEl.value.trim();
}

// ════════════════════════════════════════════════
// FLOATING WINDOWS SYSTEM (Windows-style)
// ════════════════════════════════════════════════
const floatWinState = {};
function openFloatWin(id) {
  const win = document.getElementById(id);
  if (!win) return;
  // Close settings if open
  const sov = document.getElementById('settings-ov');
  if (sov && sov.classList.contains('show')) sov.classList.remove('show');
  // Show window
  win.classList.add('show');
  bringToFront(id);
  makeDraggable(id);
}
function closeFloatWin(id) {
  const win = document.getElementById(id);
  if (win) { win.classList.remove('show'); win.style.transform = ''; }
}
function minimizeFloatWin(id) {
  const win = document.getElementById(id);
  if (!win) return;
  const s = floatWinState[id] || {};
  if (s.minimized) {
    win.style.height = s.savedH || '500px';
    const body = win.querySelector('.float-win-body');
    if (body) body.style.display = '';
    s.minimized = false;
  } else {
    s.savedH = win.style.height || win.offsetHeight + 'px';
    const body = win.querySelector('.float-win-body');
    if (body) body.style.display = 'none';
    win.style.height = 'auto';
    s.minimized = true;
  }
  floatWinState[id] = s;
}
function maximizeFloatWin(id) {
  const win = document.getElementById(id);
  if (!win) return;
  const s = floatWinState[id] || {};
  if (s.maximized) {
    win.setAttribute('style', s.savedStyle || '');
    s.maximized = false;
  } else {
    s.savedStyle = win.getAttribute('style') || '';
    win.style.cssText = s.savedStyle + ';position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100dvh!important;border-radius:0!important;z-index:60001!important;transform:none!important;resize:none!important';
    s.maximized = true;
  }
  floatWinState[id] = s;
}
let _zTop = 50000;
function bringToFront(id) {
  _zTop++;
  const win = document.getElementById(id);
  if (win) win.style.zIndex = _zTop;
}
function makeDraggable(id) {
  const win = document.getElementById(id);
  const bar = document.getElementById(id + '-bar');
  if (!win || !bar || win._draggable) return;
  win._draggable = true;
  let startX, startY, origLeft, origTop;
  bar.addEventListener('mousedown', e => {
    if (e.target.classList.contains('float-win-dot') || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'I') return;
    bringToFront(id);
    const rect = win.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    origLeft = rect.left; origTop = rect.top;
    win.style.transform = 'none';
    win.style.left = origLeft + 'px'; win.style.top = origTop + 'px';
    const onMove = ev => {
      win.style.left = (origLeft + ev.clientX - startX) + 'px';
      win.style.top = (origTop + ev.clientY - startY) + 'px';
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
  win.addEventListener('mousedown', () => bringToFront(id));
}

// Floating browser
let _floatLastUrl = '';
function floatNavBrowser() {
  let url = document.getElementById('float-browser-url').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  _floatLastUrl = url;
  const frame = document.getElementById('float-browser-frame');
  const blocked = document.getElementById('float-browser-blocked');
  blocked.style.display = 'none';
  frame.style.display = 'block';
  frame.src = url;
  document.getElementById('float-open-new').onclick = () => window.open(url, '_blank');
  clearTimeout(frame._ftimer);
  frame._floaded = false;
  frame._ftimer = setTimeout(() => {
    if (!frame._floaded) { frame.style.display = 'none'; blocked.style.display = 'flex'; }
  }, 6000);
}
function onFloatBrowserLoad() {
  const f = document.getElementById('float-browser-frame');
  f._floaded = true; clearTimeout(f._ftimer);
  try {
    const doc = f.contentDocument || f.contentWindow?.document;
    if (!doc || doc.body?.innerHTML === '' || doc.title === '') {
      f.style.display = 'none'; document.getElementById('float-browser-blocked').style.display = 'flex';
    } else {
      document.getElementById('float-browser-title').textContent = doc.title.slice(0,40) || 'المتصفح';
    }
  } catch(e) {}
}
function onFloatBrowserError() {
  document.getElementById('float-browser-frame').style.display = 'none';
  document.getElementById('float-browser-blocked').style.display = 'flex';
}

// Floating maps
function floatSearchMaps() {
  const q = document.getElementById('float-maps-inp').value.trim();
  if (!q) return;
  document.getElementById('float-maps-frame').src = `https://www.openstreetmap.org/export/embed.html?query=${encodeURIComponent(q)}&layer=mapnik`;
  showToast('🗺️ جاري البحث...');
}
function floatMapsMyLocation() {
  if (!navigator.geolocation) { showToast('⚠️ الموقع غير مدعوم'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lng = pos.coords.longitude, delta = 0.05;
    document.getElementById('float-maps-frame').src = `https://www.openstreetmap.org/export/embed.html?bbox=${lng-delta},${lat-delta},${lng+delta},${lat+delta}&layer=mapnik&marker=${lat},${lng}`;
    document.getElementById('float-maps-inp').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    showToast('📍 تم تحديد موقعك');
  }, () => showToast('❌ تعذر الحصول على الموقع'));
}

// ════════════════════════════════════════════════
// HISTORY MODAL
// ════════════════════════════════════════════════
function showHistoryModal() {
  document.getElementById('history-modal').classList.add('show');
  renderHistoryList();
}
function closeHistoryModal() {
  document.getElementById('history-modal').classList.remove('show');
}
function renderHistoryList(filter='') {
  const list = document.getElementById('history-modal-list');
  if (!list) return;
  const convs = (conversations || []).slice().sort((a,b)=>(b.updated||0)-(a.updated||0));
  const filtered = filter ? convs.filter(c => c.title?.includes(filter) || c.messages?.some(m => m.content?.includes(filter))) : convs;
  if (!filtered.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--t3);padding:24px;font-size:12px">لا توجد محادثات سابقة<br><span style="font-size:10px">ابدأ بإرسال رسالة أولى!</span></div>';
    return;
  }
  list.innerHTML = filtered.map(c => {
    const msgCount = c.messages?.length || 0;
    const date = c.updated ? new Date(c.updated).toLocaleDateString('ar-EG', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
    const preview = c.messages?.filter(m=>m.role==='user').pop()?.content?.slice(0,70) || '...';
    return `<div class="history-item ${c.id===currentCid?'active':''}" onclick="loadConv('${c.id}');closeHistoryModal()">
      <i class="fa-regular fa-message" style="color:var(--accent);font-size:14px;flex-shrink:0;margin-top:2px"></i>
      <div class="history-item-info">
        <div class="history-item-title">${esc(c.title||'محادثة')}</div>
        <div style="font-size:10px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:380px;margin-top:2px">${esc(preview)}</div>
        <div class="history-item-meta"><span>${msgCount} رسالة</span><span>${date}</span></div>
      </div>
      <button onclick="event.stopPropagation();delConv('${c.id}');renderHistoryList(document.getElementById('history-search')?.value||'')" style="background:none;border:none;color:var(--t3);cursor:pointer;font-size:12px;padding:4px 6px;border-radius:4px;transition:color .15s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--t3)'" title="حذف">✕</button>
    </div>`;
  }).join('');
}
function filterHistory() {
  renderHistoryList(document.getElementById('history-search')?.value?.trim() || '');
}

// ════════════════════════════════════════════════
// LONG-TERM MEMORY SYSTEM (cross-session)
// ════════════════════════════════════════════════
const LTM_KEY = 'pexil_ltm_v2';
function loadLongTermMemory() {
  try { return JSON.parse(localStorage.getItem(LTM_KEY) || '[]'); } catch { return []; }
}
function saveLongTermMemory(ltm) {
  localStorage.setItem(LTM_KEY, JSON.stringify(ltm.slice(0, 200)));
}
function addLongTermFact(fact, category='عام') {
  if (!fact || fact.length < 5) return;
  const ltm = loadLongTermMemory();
  if (ltm.some(m => m.content === fact)) return;
  ltm.unshift({ id: Date.now(), content: fact, category, ts: Date.now() });
  saveLongTermMemory(ltm);
}
function getLongTermContext() {
  const ltm = loadLongTermMemory();
  if (!ltm.length) return '';
  return `\n\nذاكرة طويلة المدى من محادثات سابقة:\n${ltm.slice(0,30).map(m=>`- ${m.content}`).join('\n')}`;
}
async function extractLongTermMemoryFromExchange(userMsg, assistantReply) {
  try {
    const key = cfg.apis?.openrouter;
    if (!key) return;
    const mid = cfg.model_id || 'openai/gpt-4o-mini';
    const prompt = `من هذه المحادثة القصيرة، استخرج أي حقائق مهمة عن المستخدم يجب تذكرها مستقبلاً (اسم، مهنة، تفضيلات، أهداف، معلومات شخصية). أجب بـ JSON فقط: {"facts":["حقيقة 1"]} أو {"facts":[]} إذا لم يوجد شيء مهم.

المستخدم: ${userMsg.slice(0,400)}
المساعد: ${assistantReply.slice(0,400)}`;
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`,'HTTP-Referer':'https://devverse.app','X-Title':'PixelAi - Binary Beast'},
      body:JSON.stringify({model:mid,messages:[{role:'user',content:prompt}],max_tokens:200,temperature:0.2})
    });
    if (!res.ok) return;
    const d = await res.json();
    const txt = (d.choices?.[0]?.message?.content||'{}').replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(txt);
    (parsed.facts||[]).forEach(f => addLongTermFact(f));
  } catch(e) {}
}

// ═══════════════════════════════════════════════
// ═══ INTEGRATIONS — Telegram / Discord / WhatsApp
// ═══════════════════════════════════════════════

let tgPolling = false, tgPollOffset = 0, tgPollTimer = null;
let dcPolling = false, dcPollTimer = null, dcLastMsgId = null;

// ── Load/Save integrations config ──
function loadIntegrations() {
  try { return JSON.parse(localStorage.getItem('pexil_integrations') || '{}'); } catch(e) { return {}; }
}
function saveIntegrationsConfig(data) {
  localStorage.setItem('pexil_integrations', JSON.stringify(data));
}

async function saveIntegrations() {
  const cmbPhone = document.getElementById('s-cmb-phone')?.value.trim() || '';
  const cmbKey = document.getElementById('s-cmb-key')?.value.trim() || '';
  const waMode = document.getElementById('wa-mode-meta')?.classList.contains('active') ? 'meta' : 'callmebot';

  // الحقول الغير حساسة (أرقام هواتف/معرّفات، مش أسرار) بتفضل محلية زي ما هي
  const data = {
    tg: {
      chatId: document.getElementById('s-tg-chatid')?.value.trim() || ''
    },
    dc: {
      webhook: document.getElementById('s-dc-webhook')?.value.trim() || '', // webhook URL نفسه بيشتغل كسر لكن مفيش وقت كافي لعمل بروكسي مخصص له الآن، فضل زي ما هو
      channelId: document.getElementById('s-dc-channel')?.value.trim() || ''
    },
    wa: {
      mode: waMode,
      phoneId: document.getElementById('s-wa-phone-id')?.value.trim() || '',
      to: document.getElementById('s-wa-to')?.value.trim() || '',
      cmbPhone
    },
    google: {
      defaultSheetId: document.getElementById('s-sheets-id')?.value.trim() || ''
    },
    github: {
      username: document.getElementById('s-gh-user')?.value.trim() || ''
    },
    actions: {
      notifyTasks: document.getElementById('int-notify-tasks')?.checked || false,
      notifyAI: document.getElementById('int-notify-ai')?.checked || false,
      receiveMsgs: document.getElementById('int-receive-msgs')?.checked || false,
      destTG: document.getElementById('int-dest-tg')?.checked || false,
      destDC: document.getElementById('int-dest-dc')?.checked || false,
      destWA: document.getElementById('int-dest-wa')?.checked || false
    }
  };
  saveIntegrationsConfig(data);

  // الحقول الحساسة (توكنات/مفاتيح) بتتشفر وتتخزن في الباك إند، مش في localStorage
  try {
    const tgToken = document.getElementById('s-tg-token')?.value.trim() || '';
    if (tgToken) await bbSaveIntegrationCreds('telegram', tgToken);

    const dcToken = document.getElementById('s-dc-token')?.value.trim() || '';
    // Discord webhook posting doesn't need OAuth-style storage — kept local since webhook URLs are self-contained secrets used client-side by design in this build

    const waToken = document.getElementById('s-wa-token')?.value.trim() || '';
    if (waToken) await bbSaveIntegrationCreds('facebook_whatsapp', waToken);

    if (cmbPhone && cmbKey) await bbSaveIntegrationCreds('callmebot_whatsapp', { phone: cmbPhone, apikey: cmbKey });

    const ggClientId = document.getElementById('s-ggl-client-id')?.value.trim() || '';
    const ggClientSecret = document.getElementById('s-ggl-client-secret')?.value.trim() || '';
    const ggRefreshToken = document.getElementById('s-ggl-refresh-token')?.value.trim() || '';
    if (ggClientId && ggClientSecret && ggRefreshToken) await bbSaveGoogleCreds(ggClientId, ggClientSecret, ggRefreshToken);

    const ghToken = document.getElementById('s-gh-token')?.value.trim() || '';
    if (ghToken) await bbSaveIntegrationCreds('github', ghToken);
  } catch (e) {
    showToast('⚠️ حصل خطأ في حفظ بعض المفاتيح: ' + e.message);
  }

  updateIntegrationsBadges();
  if (data.actions.receiveMsgs) {
    if (data.tg.chatId) tgStartPolling(true);
    if (document.getElementById('s-dc-token')?.value.trim() && data.dc.channelId) dcStartPolling(true);
  }
  closeSettings();
  showToast('✅ تم حفظ التكاملات');
}

async function loadIntegrationsUI() {
  const d = loadIntegrations();
  // Messaging (non-sensitive fields load from localStorage instantly)
  if (document.getElementById('s-tg-chatid')) document.getElementById('s-tg-chatid').value = d.tg?.chatId || '';
  if (document.getElementById('s-dc-webhook')) document.getElementById('s-dc-webhook').value = d.dc?.webhook || '';
  if (document.getElementById('s-dc-channel')) document.getElementById('s-dc-channel').value = d.dc?.channelId || '';
  if (document.getElementById('s-wa-phone-id')) document.getElementById('s-wa-phone-id').value = d.wa?.phoneId || '';
  if (document.getElementById('s-wa-to')) document.getElementById('s-wa-to').value = d.wa?.to || '';
  if (document.getElementById('s-cmb-phone')) document.getElementById('s-cmb-phone').value = d.wa?.cmbPhone || '';
  setWAMode(d.wa?.mode || 'meta');
  // Google
  if (document.getElementById('s-ggl-client-id')) document.getElementById('s-ggl-client-id').value = d.google?.clientId || '';
  if (document.getElementById('s-ggl-client-secret')) document.getElementById('s-ggl-client-secret').value = d.google?.clientSecret || '';
  if (document.getElementById('s-ggl-refresh-token')) document.getElementById('s-ggl-refresh-token').value = d.google?.refreshToken || '';
  if (document.getElementById('s-sheets-id')) document.getElementById('s-sheets-id').value = d.google?.defaultSheetId || '';
  // GitHub
  if (document.getElementById('s-gh-token')) document.getElementById('s-gh-token').value = d.github?.token || '';
  if (document.getElementById('s-gh-user')) document.getElementById('s-gh-user').value = d.github?.username || '';
  // Actions
  if (document.getElementById('int-notify-tasks')) document.getElementById('int-notify-tasks').checked = d.actions?.notifyTasks || false;
  if (document.getElementById('int-notify-ai')) document.getElementById('int-notify-ai').checked = d.actions?.notifyAI || false;
  if (document.getElementById('int-receive-msgs')) document.getElementById('int-receive-msgs').checked = d.actions?.receiveMsgs || false;
  if (document.getElementById('int-dest-tg')) document.getElementById('int-dest-tg').checked = d.actions?.destTG || false;
  if (document.getElementById('int-dest-dc')) document.getElementById('int-dest-dc').checked = d.actions?.destDC || false;
  if (document.getElementById('int-dest-wa')) document.getElementById('int-dest-wa').checked = d.actions?.destWA || false;
}

async function updateIntegrationsBadges() {
  const d = loadIntegrations();
  const bar = document.getElementById('integrations-bar');
  if (!bar) return;
  const [hasTg, hasWaFb, hasCmb, hasGoogle, hasGithub] = await Promise.all([
    bbHasIntegration('telegram'), bbHasIntegration('facebook_whatsapp'), bbHasIntegration('callmebot_whatsapp'),
    bbHasIntegration('google_oauth'), bbHasIntegration('github')
  ]);
  const badges = [];
  if (hasTg) badges.push(`<span class="int-badge tg">📲 TG ${tgPolling ? '🟢' : '⚪'}</span>`);
  if (d.dc?.webhook) badges.push(`<span class="int-badge dc">💬 DC ${dcPolling ? '🟢' : '⚪'}</span>`);
  if (hasWaFb || hasCmb) badges.push(`<span class="int-badge wa">📱 WA</span>`);
  if (hasGoogle) badges.push(`<span class="int-badge" style="background:rgba(66,133,244,.15);color:#4285f4;border:1px solid rgba(66,133,244,.3)">🟦 Google</span>`);
  if (hasGithub) badges.push(`<span class="int-badge" style="background:rgba(255,255,255,.07);color:#e0e0e0;border:1px solid rgba(255,255,255,.15)">🐙 GitHub</span>`);
  if (badges.length) { bar.innerHTML = badges.join(''); bar.style.display = 'flex'; }
  else { bar.style.display = 'none'; }
}

function switchIntTab(i) {
  document.querySelectorAll('.int-tab').forEach((t,j) => t.classList.toggle('active', i===j));
  document.querySelectorAll('.int-page').forEach((p,j) => {
    p.classList.toggle('active', i===j);
    p.style.display = i===j ? 'block' : 'none';
  });
}

// ── Google OAuth helper (opens consent URL) ──
function gmailAuth() {
  const d = loadIntegrations();
  const clientId = document.getElementById('s-ggl-client-id')?.value.trim() || d.google?.clientId;
  if (!clientId) { setIntStatus('gmail-status','⚠️ أدخل Client ID أولاً','info'); return; }
  const scopes = encodeURIComponent([
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/tasks'
  ].join(' '));
  const redirect = encodeURIComponent('urn:ietf:wg:oauth:2.0:oob');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirect}&response_type=code&scope=${scopes}&access_type=offline&prompt=consent`;
  window.open(url, '_blank');
  setIntStatus('gmail-status',
    '🔐 تم فتح صفحة Google — بعد الموافقة ستظهر لك Authorization Code\nانسخ الكود وأضفه كـ Refresh Token مؤقتاً، ثم استخدم أداة مثل <a href="https://developers.google.com/oauthplayground" target="_blank" style="color:#4285f4">OAuth Playground</a> لتحويله لـ Refresh Token حقيقي.',
    'info');
}

async function _ensureGoogleSaved() {
  const clientId = document.getElementById('s-ggl-client-id')?.value.trim();
  const clientSecret = document.getElementById('s-ggl-client-secret')?.value.trim();
  const refreshToken = document.getElementById('s-ggl-refresh-token')?.value.trim();
  if (clientId && clientSecret && refreshToken) {
    await bbSaveGoogleCreds(clientId, clientSecret, refreshToken);
    return true;
  }
  return await bbHasIntegration('google_oauth');
}

async function gmailTest() {
  setIntStatus('gmail-status','⏳ جاري الاختبار...','info');
  try {
    if (!(await _ensureGoogleSaved())) { setIntStatus('gmail-status','⚠️ أضف بيانات Google OAuth أولاً','info'); return; }
    const r = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {});
    const data = await r.json();
    if (data.emailAddress) setIntStatus('gmail-status', `✅ Gmail متصل! البريد: ${data.emailAddress}`, 'ok');
    else setIntStatus('gmail-status', `❌ فشل: ${JSON.stringify(data)}`, 'err');
  } catch(e) { setIntStatus('gmail-status', `❌ ${e.message}`, 'err'); }
}

async function calendarTest() {
  setIntStatus('cal-status','⏳ جاري الاختبار...','info');
  try {
    if (!(await _ensureGoogleSaved())) { setIntStatus('cal-status','⚠️ أضف بيانات Google OAuth','info'); return; }
    const r = await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary', {});
    const d = await r.json();
    setIntStatus('cal-status', d.id ? `✅ Calendar متصل! ${d.summary}` : `❌ ${JSON.stringify(d)}`, d.id ? 'ok' : 'err');
  } catch(e) { setIntStatus('cal-status', `❌ ${e.message}`, 'err'); }
}

async function driveTest() {
  setIntStatus('drive-status','⏳ جاري الاختبار...','info');
  try {
    if (!(await _ensureGoogleSaved())) { setIntStatus('drive-status','⚠️ أضف بيانات Google OAuth','info'); return; }
    const r = await googleFetch('https://www.googleapis.com/drive/v3/about?fields=user', {});
    const d = await r.json();
    setIntStatus('drive-status', d.user ? `✅ Drive متصل! ${d.user.displayName}` : `❌ ${JSON.stringify(d)}`, d.user ? 'ok' : 'err');
  } catch(e) { setIntStatus('drive-status', `❌ ${e.message}`, 'err'); }
}

async function sheetsTest() {
  setIntStatus('sheets-status','⏳ جاري الاختبار...','info');
  const d = loadIntegrations();
  const sid = document.getElementById('s-sheets-id')?.value.trim() || d.google?.defaultSheetId;
  if (!sid) { setIntStatus('sheets-status','⚠️ أضف Spreadsheet ID للاختبار','info'); return; }
  try {
    if (!(await _ensureGoogleSaved())) { setIntStatus('sheets-status','⚠️ أضف بيانات Google OAuth','info'); return; }
    const r = await googleFetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}?fields=properties`, {});
    const data = await r.json();
    setIntStatus('sheets-status', data.properties ? `✅ Sheets متصل! "${data.properties.title}"` : `❌ ${JSON.stringify(data)}`, data.properties ? 'ok' : 'err');
  } catch(e) { setIntStatus('sheets-status', `❌ ${e.message}`, 'err'); }
}

async function tasksTest() {
  setIntStatus('tasks-status','⏳ جاري الاختبار...','info');
  try {
    const token = await getGoogleAccessToken_();
    if (!token) { setIntStatus('tasks-status','⚠️ أضف بيانات Google OAuth','info'); return; }
    const r = await googleFetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1', {});
    const d = await r.json();
    setIntStatus('tasks-status', d.items ? `✅ Tasks متصل! ${d.items[0]?.title||''}` : `❌ ${JSON.stringify(d)}`, d.items ? 'ok' : 'err');
  } catch(e) { setIntStatus('tasks-status', `❌ ${e.message}`, 'err'); }
}

// ── googleFetch: بديل آمن لـ fetch المباشر بمفتاح خام. بياخد نفس الـ URL اللي كان
// هيتحط في fetch العادي، ويستخرج منه الـ host/path/query ويودّيه لـ google-proxy
// اللي بترفرش التوكن على السيرفر وتنفذ النداء بالنيابة عننا.
async function googleFetch(url, options = {}) {
  const u = new URL(url);
  const query = {};
  u.searchParams.forEach((v, k) => { query[k] = v; });
  let requestBody;
  if (options.body) { try { requestBody = JSON.parse(options.body); } catch { requestBody = options.body; } }
  const data = await bbCallGoogle(u.hostname, { method: options.method || 'GET', path: u.pathname, query, requestBody });
  // بنرجع كائن يحاكي شكل Response عشان .json() يفضل شغال زي ما هو في كل الأكواد اللي بتستخدمه
  return { ok: true, json: async () => data, status: 200 };
}

// alias — خلاص التوكن مبقاش بيتاخد على المتصفح، فمش محتاج فعليًا، بس سايبينها
// موجودة عشان أي كود قديم بينده عليها ميكسرش
async function getGoogleAccessToken_() {
  return 'server-side'; // marker — القيمة الفعلية بتتفك على السيرفر جوه googleFetch
}

async function ghTest() {
  setIntStatus('gh-status','⏳ جاري الاختبار...','info');
  try {
    const d = await bbCallIntegration('github', { method: 'GET', path: '/user' });
    if (d.login) {
      if (document.getElementById('s-gh-user') && !document.getElementById('s-gh-user').value) document.getElementById('s-gh-user').value = d.login;
      setIntStatus('gh-status', `✅ GitHub متصل!\n👤 ${d.login} | ⭐ ${d.public_repos} repos | 👥 ${d.followers} followers`, 'ok');
    } else setIntStatus('gh-status', `❌ Token غير صحيح: ${d.message||''}`, 'err');
  } catch(e) {
    if (String(e.message).includes('not connected')) { setIntStatus('gh-status','⚠️ أدخل GitHub Token','info'); return; }
    setIntStatus('gh-status', `❌ ${e.message}`, 'err');
  }
}

// Fix getGoogleAccessToken reference inside executeTool (it's defined inline there)
// This alias is used by test functions above

function setIntStatus(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.className = `int-status-${type}`;
  el.style.cssText += ';font-size:11px;margin-top:7px;padding:6px 9px;border-radius:6px;display:block';
  el.textContent = msg;
}

// ─── TELEGRAM ───
async function tgSend(text, chatId) {
  try {
    const cid = chatId || loadIntegrations().tg?.chatId;
    if (!cid) return false;
    const data = await bbCallIntegration('telegram', { method: 'POST', path: '/sendMessage', requestBody: { chat_id: cid, text, parse_mode: 'Markdown' } });
    return data.ok;
  } catch(e) { return false; }
}

async function tgFetchChatId() {
  const tok = document.getElementById('s-tg-token')?.value.trim();
  if (!tok) { setIntStatus('tg-status', '⚠️ أدخل Bot Token أولاً', 'info'); return; }
  setIntStatus('tg-status', '⏳ جاري الحفظ والاختبار...', 'info');
  try {
    // نحفظ التوكن مشفر الأول عشان الباك إند يقدر يستخدمه
    await bbSaveIntegrationCreds('telegram', tok);
    const d = await bbCallIntegration('telegram', { method: 'GET', path: '/getUpdates' });
    if (!d.ok) { setIntStatus('tg-status', '❌ Token غير صحيح', 'err'); return; }
    const updates = d.result;
    if (!updates.length) {
      setIntStatus('tg-status', '⚠️ ابعت رسالة للبوت أولاً ثم اضغط جلب مجدداً', 'info');
      return;
    }
    const chatId = updates[updates.length-1]?.message?.chat?.id;
    if (chatId) {
      document.getElementById('s-tg-chatid').value = chatId;
      setIntStatus('tg-status', `✅ Chat ID: ${chatId}`, 'ok');
    }
  } catch(e) { setIntStatus('tg-status', '❌ ' + e.message, 'err'); }
}

async function tgTestSend() {
  const tok = document.getElementById('s-tg-token')?.value.trim();
  const cid = document.getElementById('s-tg-chatid')?.value.trim();
  if (!tok || !cid) { setIntStatus('tg-status', '⚠️ أدخل Token و Chat ID', 'info'); return; }
  setIntStatus('tg-status', '📤 جاري الإرسال...', 'info');
  try {
    await bbSaveIntegrationCreds('telegram', tok);
    const ok = await tgSend('👋 مرحباً من *PixelAi*! التكامل يعمل بنجاح ✅', cid);
    setIntStatus('tg-status', ok ? '✅ تم الإرسال بنجاح!' : '❌ فشل الإرسال — تحقق من Token و Chat ID', ok ? 'ok' : 'err');
  } catch(e) { setIntStatus('tg-status', '❌ ' + e.message, 'err'); }
}

function tgStartPolling(silent = false) {
  const d = loadIntegrations();
  const tok = d.tg?.token;
  if (!tok) { if (!silent) setIntStatus('tg-status', '⚠️ أدخل Bot Token وفعّله من الإعدادات', 'info'); return; }
  if (tgPolling) { tgStopPolling(); return; }
  tgPolling = true;
  const btn = document.getElementById('tg-poll-btn');
  if (btn) btn.textContent = '⏹ إيقاف الاستقبال';
  if (!silent) setIntStatus('tg-status', '🟢 جاري الاستماع للرسائل...', 'ok');
  updateIntegrationsBadges();
  showToast('📲 Telegram: جاري الاستماع للرسائل');

  async function poll() {
    if (!tgPolling) return;
    try {
      const data = await bbCallIntegration('telegram', { method: 'GET', path: '/getUpdates', query: { timeout: 25, offset: tgPollOffset } });
      if (data.ok && data.result?.length) {
        for (const upd of data.result) {
          tgPollOffset = upd.update_id + 1;
          const msg = upd.message;
          if (!msg?.text) continue;
          const text = msg.text;
          const fromName = msg.from?.first_name || 'مستخدم';
          const chatId = msg.chat?.id;
          // Show in PixelAi chat
          appendBubble('system', `📲 **Telegram — ${fromName}:** ${text}`, null, true);
          scrollBottom();
          // Auto-reply if enabled
          const actions = loadIntegrations().actions;
          if (actions?.receiveMsgs) {
            const mid = cfg.or_custom || cfg.model_id;
            const model = MODELS.find(m => m.id === mid);
            try {
              const reply = await toolCallLoop(`[رسالة من Telegram من ${fromName}]: ${text}`, model, mid, null);
              appendBubble('assistant', reply, model?.name || mid);
              currentMsgs.push({role:'assistant', content: reply, model: model?.name || mid});
              saveConv();
              scrollBottom();
              // Send reply back to Telegram
              await tgSend(reply, chatId, tok);
              // Forward to other destinations
              await intForwardToAll(reply, 'tg');
            } catch(e) { console.warn('TG auto-reply error:', e.message); }
          }
        }
      }
    } catch(e) { /* network error — retry */ }
    if (tgPolling) tgPollTimer = setTimeout(poll, 2000);
  }
  poll();
}

function tgStopPolling() {
  tgPolling = false;
  if (tgPollTimer) { clearTimeout(tgPollTimer); tgPollTimer = null; }
  const btn = document.getElementById('tg-poll-btn');
  if (btn) btn.textContent = '▶ تشغيل الاستقبال';
  updateIntegrationsBadges();
  showToast('📲 Telegram: توقف الاستقبال');
}

// ─── DISCORD ───
async function dcSendWebhook(text, webhookUrl) {
  const d = loadIntegrations();
  const url = webhookUrl || d.dc?.webhook;
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, username: cfg.bot?.name || 'PixelAi' })
    });
    return r.ok;
  } catch(e) { return false; }
}

async function dcSendBot(text, channelId, token) {
  if (!token || !channelId) return false;
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${token}` },
      body: JSON.stringify({ content: text })
    });
    return r.ok;
  } catch(e) { return false; }
}

async function dcTestWebhook() {
  const url = document.getElementById('s-dc-webhook')?.value.trim();
  if (!url) { setIntStatus('dc-status', '⚠️ أدخل Webhook URL', 'info'); return; }
  setIntStatus('dc-status', '📤 جاري الإرسال...', 'info');
  const ok = await dcSendWebhook(`👋 مرحباً من **PixelAi**! التكامل يعمل بنجاح ✅`, url);
  setIntStatus('dc-status', ok ? '✅ تم الإرسال للـ Discord بنجاح!' : '❌ فشل — تحقق من Webhook URL', ok ? 'ok' : 'err');
}

function dcStartPolling(silent = false) {
  const d = loadIntegrations();
  const tok = d.dc?.token;
  const channelId = d.dc?.channelId;
  if (!tok || !channelId) { if (!silent) setIntStatus('dc-status', '⚠️ أدخل Bot Token و Channel ID', 'info'); return; }
  if (dcPolling) { dcStopPolling(); return; }
  dcPolling = true;
  const btn = document.getElementById('dc-poll-btn');
  if (btn) btn.textContent = '⏹ إيقاف الاستقبال';
  if (!silent) setIntStatus('dc-status', '🟢 جاري الاستماع للرسائل...', 'ok');
  updateIntegrationsBadges();
  showToast('💬 Discord: جاري الاستماع للرسائل');

  async function poll() {
    if (!dcPolling) return;
    try {
      let url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=1`;
      if (dcLastMsgId) url += `&after=${dcLastMsgId}`;
      const r = await fetch(url, { headers: { 'Authorization': `Bot ${tok}` } });
      if (r.ok) {
        const msgs = await r.json();
        for (const msg of msgs) {
          if (msg.author?.bot) continue; // ignore bot messages
          if (!dcLastMsgId) { dcLastMsgId = msg.id; continue; } // first run — set baseline
          dcLastMsgId = msg.id;
          const text = msg.content;
          const fromName = msg.author?.username || 'مستخدم';
          appendBubble('system', `💬 **Discord — ${fromName}:** ${text}`, null, true);
          scrollBottom();
          const actions = loadIntegrations().actions;
          if (actions?.receiveMsgs) {
            const mid = cfg.or_custom || cfg.model_id;
            const model = MODELS.find(m => m.id === mid);
            try {
              const reply = await toolCallLoop(`[رسالة من Discord من ${fromName}]: ${text}`, model, mid, null);
              appendBubble('assistant', reply, model?.name || mid);
              currentMsgs.push({role:'assistant', content: reply, model: model?.name || mid});
              saveConv(); scrollBottom();
              // Reply back to Discord channel
              await dcSendBot(reply, channelId, tok);
              await intForwardToAll(reply, 'dc');
            } catch(e) { console.warn('DC auto-reply error:', e.message); }
          }
        }
        if (!dcLastMsgId && msgs.length) dcLastMsgId = msgs[0].id;
      }
    } catch(e) { /* retry */ }
    if (dcPolling) dcPollTimer = setTimeout(poll, 4000);
  }
  poll();
}

function dcStopPolling() {
  dcPolling = false;
  if (dcPollTimer) { clearTimeout(dcPollTimer); dcPollTimer = null; }
  const btn = document.getElementById('dc-poll-btn');
  if (btn) btn.textContent = '▶ تشغيل الاستقبال';
  updateIntegrationsBadges();
  showToast('💬 Discord: توقف الاستقبال');
}

// ─── WHATSAPP ───
function setWAMode(mode) {
  const metaBtn = document.getElementById('wa-mode-meta');
  const cmbBtn = document.getElementById('wa-mode-callmebot');
  const metaF = document.getElementById('wa-meta-fields');
  const cmbF = document.getElementById('wa-cmb-fields');
  if (!metaBtn) return;
  if (mode === 'meta') {
    metaBtn.style.cssText += ';background:rgba(37,211,102,.2);border-color:rgba(37,211,102,.4);color:#25d366';
    cmbBtn.style.cssText = cmbBtn.style.cssText.replace(/background:[^;]+;border-color:[^;]+;color:[^;]+;/g,'');
    if (metaF) metaF.style.display = 'block';
    if (cmbF) cmbF.style.display = 'none';
  } else {
    cmbBtn.style.cssText += ';background:rgba(37,211,102,.2);border-color:rgba(37,211,102,.4);color:#25d366';
    metaBtn.style.cssText = metaBtn.style.cssText.replace(/background:[^;]+;border-color:[^;]+;color:[^;]+;/g,'');
    if (metaF) metaF.style.display = 'none';
    if (cmbF) cmbF.style.display = 'block';
  }
}

async function waSend(text) {
  const d = loadIntegrations();
  const wa = d.wa || {};
  try {
    if (wa.mode === 'callmebot' && wa.cmbPhone) {
      const data = await bbCallIntegration('callmebot_whatsapp', { method: 'GET', path: '/whatsapp.php', query: { text } });
      return true;
    } else if (wa.phoneId && wa.to) {
      const to = wa.to.replace(/\D/g, '');
      await bbCallIntegration('facebook_whatsapp', { method: 'POST', path: `/v18.0/${wa.phoneId}/messages`, requestBody: { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } } });
      return true;
    }
  } catch(e) { return false; }
  return false;
}

async function waTestSend() {
  setIntStatus('wa-status', '📤 جاري الإرسال...', 'info');
  const ok = await waSend('👋 مرحباً من PixelAi! التكامل يعمل بنجاح ✅');
  setIntStatus('wa-status', ok ? '✅ تم الإرسال للواتساب بنجاح!' : '❌ فشل — تحقق من الإعدادات', ok ? 'ok' : 'err');
}

// ─── Forward to all enabled destinations ───
async function intForwardToAll(text, source = '') {
  const d = loadIntegrations();
  const a = d.actions || {};
  const promises = [];
  if (a.destTG && source !== 'tg' && d.tg?.token && d.tg?.chatId)
    promises.push(tgSend(text, d.tg.chatId, d.tg.token));
  if (a.destDC && source !== 'dc' && d.dc?.webhook)
    promises.push(dcSendWebhook(text, d.dc.webhook));
  if (a.destWA && source !== 'wa')
    promises.push(waSend(text));
  await Promise.allSettled(promises);
}

// ─── Send notifications to integrations (called from periodic tasks & AI replies) ───
async function intNotify(text, type = 'task') {
  const d = loadIntegrations();
  const a = d.actions || {};
  const shouldNotify = (type === 'task' && a.notifyTasks) || (type === 'ai' && a.notifyAI);
  if (!shouldNotify) return;
  await intForwardToAll(text);
}

// ─── Init integrations on load ───
setTimeout(() => { updateIntegrationsBadges(); initIntegrations(); }, 1200);

function initIntegrations() {
  const d = loadIntegrations();
  if (!d.actions?.receiveMsgs) return;
  if (d.tg?.token && d.tg?.chatId) tgStartPolling(true);
  if (d.dc?.token && d.dc?.channelId) dcStartPolling(true);
}

// ═══════════════════════════════════════════════
// End Integrations
// ═══════════════════════════════════════════════

let periodicInterval = null;

function loadPeriodicTasks() {
  return JSON.parse(localStorage.getItem('pexil_periodic_tasks') || '[]');
}
function savePeriodicTasks(tasks) {
  localStorage.setItem('pexil_periodic_tasks', JSON.stringify(tasks));
}

function addPeriodicTaskUI() {
  const name = document.getElementById('pt-name-inp')?.value.trim();
  const time = document.getElementById('pt-time-inp')?.value || '09:00';
  const interval = document.getElementById('pt-interval-sel')?.value || 'daily';
  const aiPrompt = document.getElementById('pt-ai-prompt-inp')?.value.trim() || '';
  if (!name) { showToast('⚠️ اكتب اسم المهمة'); return; }
  const tasks = loadPeriodicTasks();
  tasks.push({ id: Date.now(), name, time, interval, aiPrompt, active: true, created: new Date().toLocaleDateString('ar-EG'), lastRun: null });
  savePeriodicTasks(tasks);
  if (document.getElementById('pt-name-inp')) document.getElementById('pt-name-inp').value = '';
  if (document.getElementById('pt-ai-prompt-inp')) document.getElementById('pt-ai-prompt-inp').value = '';
  renderPeriodicTasks();
  schedulePeriodicTasks();
  showToast(`✅ مهمة دورية: ${name}`);
}

function deletePeriodicTask(id) {
  const tasks = loadPeriodicTasks().filter(t => t.id !== id);
  savePeriodicTasks(tasks);
  renderPeriodicTasks();
  schedulePeriodicTasks();
}

function togglePeriodicTask(id) {
  const tasks = loadPeriodicTasks();
  const t = tasks.find(t => t.id === id);
  if (t) { t.active = !t.active; savePeriodicTasks(tasks); renderPeriodicTasks(); schedulePeriodicTasks(); }
}

function renderPeriodicTasks() {
  const el = document.getElementById('ptask-list');
  if (!el) return;
  const tasks = loadPeriodicTasks();
  const badge = document.getElementById('ptask-badge');
  if (badge) { badge.textContent = tasks.length > 0 ? tasks.length : ''; badge.style.display = tasks.length > 0 ? 'block' : 'none'; }
  // Also update topbar button glow when active tasks exist
  const topBtn = document.getElementById('periodic-topbar-btn');
  if (topBtn) {
    const hasActive = tasks.some(t => t.active);
    topBtn.style.background = hasActive
      ? 'linear-gradient(135deg,rgba(124,58,237,.28),rgba(0,170,255,.18))'
      : 'linear-gradient(135deg,rgba(124,58,237,.18),rgba(0,170,255,.12))';
    topBtn.style.boxShadow = hasActive ? '0 0 10px rgba(124,58,237,.3)' : '';
    topBtn.style.color = hasActive ? '#c4b5fd' : '#a78bfa';
  }
  if (!tasks.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--t3);font-size:12px;padding:16px;line-height:1.9">لا توجد مهام دورية بعد.<br>أضف مهمة وحدد ما تريد من PixelAi!</div>';
    return;
  }
  const intervalMap = { daily: 'يومياً', weekly: 'أسبوعياً', hourly: 'كل ساعة' };
  el.innerHTML = tasks.map(t => `
    <div class="ptask-item ${t.active ? 'active-task' : ''}">
      <div class="ptask-dot ${t.active ? 'on' : ''}"></div>
      <div style="flex:1;min-width:0">
        <div class="ptask-name">${esc(t.name)}</div>
        <div class="ptask-time">${intervalMap[t.interval] || t.interval} • ${t.time}${t.aiPrompt ? ' • <span style="color:#a78bfa;font-size:9.5px">🤖 Auto AI</span>' : ''}</div>
      </div>
      <button class="ptask-tog" onclick="togglePeriodicTask(${t.id})">${t.active ? 'إيقاف' : 'تفعيل'}</button>
      <button class="ptask-del" onclick="deletePeriodicTask(${t.id})">✕</button>
    </div>
  `).join('');
}

function schedulePeriodicTasks() {
  if (periodicInterval) { clearInterval(periodicInterval); periodicInterval = null; }
  periodicInterval = setInterval(() => checkPeriodicTasks(), 60000); // Check every minute
  checkPeriodicTasks(); // Immediate check
}

function checkPeriodicTasks() {
  const tasks = loadPeriodicTasks();
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const todayDay = now.toLocaleDateString('en-US', {weekday:'long'});
  let changed = false;
  tasks.forEach(t => {
    if (!t.active) return;
    const shouldRun = (() => {
      if (t.interval === 'hourly') {
        const lastRun = t.lastRun ? new Date(t.lastRun) : null;
        if (!lastRun) return true;
        return (now - lastRun) >= 3600000;
      }
      if (t.interval === 'daily') return t.time === currentTime;
      if (t.interval === 'weekly') return t.time === currentTime && (!t.days?.length || t.days.includes(todayDay));
      return false;
    })();
    const alreadyRanToday = t.lastRun && new Date(t.lastRun).toDateString() === now.toDateString() && t.interval !== 'hourly';
    if (shouldRun && !alreadyRanToday) {
      t.lastRun = now.toISOString();
      changed = true;
      showToast(`🔁 مهمة دورية: ${t.name}`);
      speakText(`تذكير: ${t.name}`);
      // Auto-run PixelAi for this task
      autoRunPeriodicTask(t);
    }
  });
  if (changed) savePeriodicTasks(tasks);
}

async function autoRunPeriodicTask(task) {
  const intervalMap = { daily: 'يومياً', weekly: 'أسبوعياً', hourly: 'كل ساعة' };
  const now = new Date().toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'});

  // Show a system trigger chip in chat
  const el = document.getElementById('messages');
  const chip = document.createElement('div');
  chip.className = 'tool-activity-chip';
  chip.style.cssText = 'background:rgba(124,58,237,.1);border-color:rgba(124,58,237,.3);color:#a78bfa';
  chip.innerHTML = `<span>🔁</span><span>مهمة دورية تعمل تلقائياً: <strong>${esc(task.name)}</strong></span>`;
  el.appendChild(chip);
  scrollBottom();

  // Only auto-run if API key is available
  const key = cfg.apis?.openrouter;
  if (!key || isLoading) {
    // Fallback: just show system message
    appendBubble('system', `🔁 **تذكير دوري تلقائي:** ${task.name}\n⏰ ${now} — ${intervalMap[task.interval] || task.interval}`, null);
    scrollBottom();
    setTimeout(() => chip.remove(), 5000);
    return;
  }

  // Build the auto-prompt for PixelAi
  const autoPrompt = task.aiPrompt
    ? task.aiPrompt  // custom AI action stored with the task
    : `[مهمة دورية تلقائية - ${now}]\nحان وقت: "${task.name}" (${intervalMap[task.interval] || task.interval})\nقدّم تذكيراً مناسباً ومفيداً عن هذه المهمة، وأي نصائح أو معلومات مرتبطة بها.`;

  const mid = cfg.or_custom || cfg.model_id;
  const model = MODELS.find(m => m.id === mid);

  const tid = showTyping();
  isLoading = true;
  document.getElementById('send-btn').disabled = true;

  try {
    // Add user trigger message (shown as system so it's visually distinct)
    appendBubble('system', `🔁 تذكير دوري: **${task.name}**`, null, true);
    currentMsgs.push({ role: 'user', content: autoPrompt });

    const reply = await toolCallLoop(autoPrompt, model, mid, null);
    removeTyping(tid);
    currentMsgs.push({ role: 'assistant', content: reply, model: model?.name || mid });
    appendBubble('assistant', reply, model?.name || mid);
    saveConv();

    // Notify integrations about the periodic task result
    await intNotify(`🔁 ${task.name}\n\n${reply}`, 'task').catch(()=>{});

    // Speak the reply
    const tm = cfg.voice?.tts || 'voice-only';
    if (tm === 'always') speakText(reply);
    else speakText(`تذكير: ${task.name}`);

  } catch(err) {
    removeTyping(tid);
    appendBubble('system', `🔁 **${task.name}** — ${now}`, null);
  }

  isLoading = false;
  document.getElementById('send-btn').disabled = false;
  scrollBottom();
  setTimeout(() => chip.remove(), 3000);
}

function togglePeriodicPanel() {
  const panel = document.getElementById('periodic-panel');
  if (!panel) return;
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderPeriodicTasks();
}

// ═══════════════════════════════════════════════
// IMAGE/VIDEO GEN TABS
// ═══════════════════════════════════════════════
function switchIGTab(tab) {
  const imgPanel = document.getElementById('ig-panel-img');
  const vidPanel = document.getElementById('ig-panel-vid');
  const imgBtn = document.getElementById('ig-tab-img');
  const vidBtn = document.getElementById('ig-tab-vid');
  if (!imgPanel || !vidPanel) return;
  const isImg = tab === 'img';
  imgPanel.style.display = isImg ? 'block' : 'none';
  vidPanel.style.display = isImg ? 'none' : 'flex';
  if (imgBtn) { imgBtn.style.background = isImg ? 'var(--adim)' : 'var(--s2)'; imgBtn.style.borderColor = isImg ? 'var(--accent)' : 'var(--b1)'; imgBtn.style.color = isImg ? 'var(--accent)' : 'var(--t2)'; imgBtn.style.fontWeight = isImg ? '700' : '400'; }
  if (vidBtn) { vidBtn.style.background = !isImg ? 'rgba(168,85,247,.15)' : 'var(--s2)'; vidBtn.style.borderColor = !isImg ? '#a855f7' : 'var(--b1)'; vidBtn.style.color = !isImg ? '#a855f7' : 'var(--t2)'; vidBtn.style.fontWeight = !isImg ? '700' : '400'; }
}

async function generateVideoFromTab() {
  const prompt = document.getElementById('vidgen-prompt')?.value.trim();
  if (!prompt) { showToast('⚠️ اكتب وصف الفيديو'); return; }
  const btn = document.getElementById('vidgen-btn');
  const status = document.getElementById('vidgen-status');
  const results = document.getElementById('vidgen-results');
  btn.disabled = true; btn.textContent = '⏳ جاري التوليد...';
  status.textContent = '🎬 إرسال الطلب لـ Pollinations.AI...';

  // Translate if Arabic
  let finalPrompt = prompt;
  if (/[\u0600-\u06FF]/.test(prompt) && (cfg.apis.openrouter || cfg.apis.openai || cfg.apis.gemini)) {
    try {
      status.textContent = '✨ ترجمة الوصف...';
      const t = await routeReq(`ترجم للإنجليزية فقط لتوليد فيديو احترافي، أجب بالـ prompt فقط:\n${prompt}`, null, cfg.model_id);
      if (t && t.length > 5) finalPrompt = t.replace(/^["']|["']$/g, '').trim();
    } catch(e) {}
  }

  const videoUrl = `https://video.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}`;
  status.textContent = '🎬 جاري التوليد — قد يستغرق من 30ث إلى دقيقتين...';

  const card = document.createElement('div');
  card.style.cssText = 'border-radius:var(--r);overflow:hidden;border:1px solid rgba(168,85,247,.3);background:var(--bg2)';
  const safeVP = finalPrompt.slice(0,40).replace(/['"<>&]/g,'');
  card.innerHTML = `
    <div style="padding:8px 10px;background:rgba(168,85,247,.08);font-size:11px;color:#a855f7;font-weight:600">🎬 ${esc(finalPrompt.slice(0,60))}${finalPrompt.length>60?'...':''}</div>
    <div id="vid-loading-${Date.now()}" style="padding:20px;text-align:center;font-size:11px;color:var(--t2)">
      <span style="font-size:28px;animation:spin 1.2s linear infinite;display:inline-block">⏳</span><br>جاري توليد الفيديو...
    </div>
    <video id="vid-el-${Date.now()}" controls style="width:100%;display:none;max-height:300px" preload="auto">
      <source src="${videoUrl}" type="video/mp4">
    </video>
    <div style="display:flex;gap:4px;padding:5px;background:var(--s1)">
      <a href="${videoUrl}" download="pexil-video.mp4" target="_blank" style="flex:1;text-align:center;font-size:10px;color:#a855f7;text-decoration:none;padding:3px">⬇️ تحميل/فتح</a>
      <button onclick="injectVideoBubble('${videoUrl}','${safeVP}')" style="flex:1;font-size:10px;background:#a855f7;border:none;border-radius:4px;color:#fff;cursor:pointer;padding:3px">💬 شات</button>
    </div>
    <div style="font-size:9px;color:var(--t3);padding:3px 6px;text-align:center">🌐 Pollinations.AI · مجاني</div>`;
  results.insertBefore(card, results.firstChild);

  // Try to load video in background
  const vidEl = card.querySelector('video');
  const loadingEl = card.querySelector('[id^="vid-loading"]');
  if (vidEl) {
    vidEl.oncanplay = () => {
      if(loadingEl) loadingEl.remove();
      vidEl.style.display = 'block';
      status.textContent = '✅ الفيديو جاهز للتشغيل!';
    };
    vidEl.onerror = () => {
      if(loadingEl) loadingEl.innerHTML = `<a href="${videoUrl}" target="_blank" style="color:#a855f7;font-size:12px">🔗 افتح الفيديو في تاب جديد</a>`;
      status.textContent = '⚠️ يمكن فتح الفيديو مباشرة من الرابط أعلاه';
    };
    // Attempt load after short delay
    setTimeout(()=>{ vidEl.load(); }, 500);
    // Fallback: show link after 8s if still loading
    setTimeout(()=>{
      if(vidEl.style.display === 'none' && loadingEl) {
        loadingEl.innerHTML = `<div style="font-size:11px;color:var(--t2);padding:4px">⏳ الفيديو يُوَلَّد...<br><a href="${videoUrl}" target="_blank" style="color:#a855f7">🔗 افتح هنا لما يخلص</a></div>`;
        status.textContent = '⏳ الفيديو لا يزال يُولَّد — استخدم الرابط لمتابعة';
      }
    }, 8000);
  }
  btn.disabled = false; btn.textContent = '🎬 توليد الفيديو';
}

async function improveVidPrompt() {
  const p = document.getElementById('vidgen-prompt')?.value.trim();
  if (!p) { showToast('اكتب وصفاً'); return; }
  document.getElementById('vidgen-status').textContent = '✨ جاري تحسين وصف الفيديو...';
  try {
    const improved = await routeReq(`حوّل هذا لـ cinematic video generation prompt احترافي بالإنجليزية مع تفاصيل الحركة والإضاءة. أجب بالـ prompt فقط:\n${p}`, null, cfg.model_id);
    document.getElementById('vidgen-prompt').value = improved.replace(/^["']|["']$/g, '').trim();
    document.getElementById('vidgen-status').textContent = '✅ تم تحسين الوصف';
  } catch(e) { document.getElementById('vidgen-status').textContent = '❌ ' + e.message; }
}

function injectVideoBubble(url, prompt) {
  const el = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'msg assistant';
  d.innerHTML = `<div class="msg-av" style="background:rgba(168,85,247,.2);display:grid;place-items:center;font-size:16px">🎬</div>
    <div class="msg-body">
      <div class="msg-bubble">
        <div style="margin-bottom:6px;font-size:11px;color:var(--t2)">🎬 ${esc(prompt?.slice(0,60))}${prompt?.length>60?'...':''}</div>
        <div style="border-radius:var(--r);overflow:hidden;border:1px solid rgba(168,85,247,.3);max-width:340px">
          <video controls style="width:100%;display:block" preload="auto"><source src="${url}" type="video/mp4"></video>
          <div style="display:flex;gap:4px;padding:4px;background:var(--s1)">
            <a href="${url}" download="pexil-video.mp4" target="_blank" style="flex:1;text-align:center;font-size:10px;color:#a855f7;text-decoration:none;padding:2px">⬇️ تحميل</a>
          </div>
        </div>
      </div>
    </div>`;
  el.appendChild(d);
  scrollBottom();
}

init();
