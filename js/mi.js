window.__tailwindReady = false;
window.tailwind = window.tailwind || {};
tailwind.config = {
    theme: { extend: {
        colors: { primary: {50:'#f0f9ff',100:'#e0f2fe',200:'#bae6fd',300:'#7dd3fc',400:'#38bdf8',500:'#0ea5e9',600:'#0284c7',700:'#0369a1',800:'#075985',900:'#0c4a6e'} },
        fontFamily: { sans: ['"PingFang SC"','"Microsoft YaHei"','system-ui','sans-serif'] }
    } }
};
window.__tailwindReady = true;

/* ===== JS 接管标记：延迟添加 js-ready，确保 renderAll 成功后才切换视图控制 ===== */
/* 如果 JS 在此处之后的代码崩溃，#view-home 的 CSS fallback (display:block) 仍然生效，不会白屏 */
/* js-ready 类将在 renderAll() 成功执行后由 initApp 添加 */
/* ===== 工具函数前置：供 window.onerror / initApp catch 块使用，避免报错时连 escapeHtml 都找不到 ===== */
function escapeHtml(s){ if(s==null) return ''; return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function showToast(msg){
    try{
        const t=document.getElementById('toast');
        if(!t) return;
        t.textContent=String(msg||'');
        t.classList.remove('hidden');
        clearTimeout(showToast._t);
        showToast._t=setTimeout(()=>{ t.classList.add('hidden'); }, 2200);
    }catch(_){}
}
/* ============================================================
 * 学习进度管理系统 v6 - 新架构：4导航+主线/支线+日常详情+个人面板
 * 数据结构（localStorage 持久化）:
 * state = {
 *   username, goal, sidebarCollapsed, currentView, planningTab,
 *   userAvatar: 头像首字母,
 *   subjects: [{ id, name, weight, dailyTasks:[], longTasks:[],
 *                listenMode, listenTarget, listenCompleted, subModules:[] }],
 *   records: { "YYYY-MM-DD": { studyMinutes, checkedIn, completionRate } },
 *   midTasks: [{ id, title, deadline, visible, subGoals:[] }],
 *   sessions: [{ id, date, subjectId, classificationId, startTs, endTs, minutes, manual? }],
 *   timerState: { subjectId, sessionStartedAt, accumulatedSeconds, segmentStartedAt, running },
 *   periodicTemplates: [{ id, content, subjectId, scheduleType, weekdays:[], enabled, mainLineId?, sideOnly? }],
 *   globalDailyTasks: [{ id, text, completed, date, completedAt, matchedSubModuleIds, subjectId? }],
 *   longTermPlans: [{ id, text, percent }],
 *   weeklyPlans: [{ id, date, startMin, endMin, content, classificationId, completed }],
 *   classifications: [{ id, name, color }],
 *   // v6 新增：主线任务体系
 *   mainLines: [{ id, name, description, deadline, createdAt,
 *                 chapters: [{ id, title, percent, createdAt }],       // 章节（原长期任务）
 *                 weeklyTasks: [{ id, content, subjectId, scheduleType, weekdays:[], enabled }]  // 周常任务
 *               }],
 *   planningTab: 'main'|'side',
 *   dailyDetailDate: 'YYYY-MM-DD',  // 日常详情页当前选中日期
 *   timerFullscreen: bool
 * }
 * ============================================================ */
// v9 升级：STORAGE_KEY 变更；颜色改为分类自定义；周视图以周一为第一天；新增历史未完成清理规则
let editingTask=null, renamingId=null, pendingAction=null, expandedSubjects=new Set();
let editingMidTaskId=null, editingPeriodicId=null;
let editingSubModuleSubjectId=null, editingSubModuleId=null, editingLongPlanId=null;
let charts = { dailyTime:null, hour:null, monthBar:null };
let timerInterval=null;
let calYear=new Date().getFullYear(), calMonth=new Date().getMonth(), selectedCalDate=null;
let annualGridYear=new Date().getFullYear();
// 每周复盘状态
let weekOffset=0, weeklyStatsRange='week', weeklyDragStart=null, weeklyDragEnd=null;
let editingWeeklyPlanId=null, editingWeeklyPlanDate=null, editingWeeklyPlanSource=null;
let weeklyCharts={ subject:null, category:null };
// v6 新增：主线编辑状态
let editingMainLineId=null;
// v7 新增：支线编辑状态 + 月历标记编辑状态 + 章节/周常 lineType 区分
let editingSideLineId=null, editingChapterLineType='main', editingWtLineType='main';
let editingEventMarkerId=null, editingBlockMarkerId=null;
// 闲置计时切换全屏
let idleTimer=null, timerFullscreenActive=false;

/* ========== 前后端分离：API层 + 账号管理 ========== */
// 自动检测 API 基础地址
// 如果页面从后端 3000 端口加载 → 同源（空字符串）
// 否则（file:// 或其他端口） → 指向 http://localhost:3000
const API_BASE = (function(){
    try{
        if(window.location && window.location.protocol==='http:' && window.location.port==='3000'){
            return '';
        }
    }catch(e){}
    return 'http://localhost:3000';
})();
const API_PREFIX = '/api';
let authMode = 'login'; // 'login' or 'register'
let _saveTimer = null; // 防抖计时器
let _isSyncing = false; // 正在从后端同步中（避免回环）
let _backendOnline = null; // null=未检测, true=在线, false=离线

/* 构造完整URL */
function _url(path){ return API_BASE + API_PREFIX + path; }

/* 统一请求封装 */
async function _request(path, options){
    const url = _url(path);
    const opts = Object.assign({
        headers: { 'Content-Type': 'application/json' }
    }, options || {});
    // 附加认证头
    if(authToken){
        opts.headers['Authorization'] = 'Bearer ' + authToken;
    }
    try{
        const resp = await fetch(url, opts);
        const text = await resp.text();
        let data;
        try{ data = text ? JSON.parse(text) : null; }catch(e){ data = null; }
        if(!resp.ok){
            const errMsg = (data && data.error) ? data.error : ('请求失败 (HTTP ' + resp.status + ')');
            const err = new Error(errMsg);
            err.status = resp.status;
            err.code = (data && data.code) || 'HTTP_' + resp.status;
            throw err;
        }
        _backendOnline = true;
        return data;
    }catch(e){
        if(e instanceof TypeError || e.message.indexOf('Failed to fetch')>=0 || e.message.indexOf('NetworkError')>=0 || e.message.indexOf('Load failed')>=0){
            _backendOnline = false;
            const err = new Error('无法连接到服务器，请确认后端服务已启动（双击 server/启动服务.bat）');
            err.code = 'NO_CONNECTION';
            err.isNetworkError = true;
            throw err;
        }
        throw e;
    }
}

/* 获取认证头 */
function authHeaders(){
    const h = { 'Content-Type': 'application/json' };
    if(authToken) h['Authorization'] = 'Bearer ' + authToken;
    return h;
}

/* 检测后端服务是否在线 */
async function checkBackendHealth(){
    try{
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // 2秒超时
        const resp = await fetch(_url('/health'), { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
        _backendOnline = resp.ok;
        return resp.ok;
    }catch(e){
        _backendOnline = false;
        return false;
    }
}

/* 检查登录状态 */
async function checkAuthStatus(){
    if(!authToken) return false;
    try{
        const data = await _request('/auth/check');
        if(data && data.success && data.valid){
            authUser = data.username || authUser;
            localStorage.setItem(AUTH_USER_KEY, authUser);
            return true;
        }
        return false;
    }catch(e){
        if(e.isNetworkError){
            showToast('⚠️ 后端服务未启动，当前为离线模式');
        }
        return false;
    }
}

/* 登录 */
async function apiLogin(username, password){
    const data = await _request('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
    });
    return data;
}

/* 注册 */
async function apiRegister(username, password){
    const data = await _request('/register', {
        method: 'POST',
        body: JSON.stringify({ username, password })
    });
    return data;
}

/* 退出登录 */
async function apiLogout(){
    try{
        await _request('/logout', { method: 'POST' });
    }catch(e){}
}

/* 从后端拉取数据 */
async function fetchBackendData(){
    const data = await _request('/data');
    return (data && data.data) || {};
}

/* 推送数据到后端（防抖） */
function syncToBackend(){
    if(!authToken || _isSyncing) return;
    if(!_backendOnline) return; // 离线模式不尝试后端同步
    if(_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async ()=>{
        try{
            await _request('/data', {
                method: 'PUT',
                body: JSON.stringify({ data: state })
            });
        }catch(e){
            // 静默失败，已保存到localStorage
        }
    }, 800);
}

/* 从后端同步数据到本地 */
async function syncFromBackend(){
    if(!authToken) return false;
    _isSyncing = true;
    try{
        const remoteData = await fetchBackendData();
        if(remoteData && Object.keys(remoteData).length > 0){
            state = remoteData;
            saveData();
        }else{
            syncToBackend();
        }
        return true;
    }catch(e){
        if(e.isNetworkError){
            showToast('⚠️ 后端服务未连接，数据仅保存在本地');
        }else{
            console.warn('后端拉取失败，使用本地缓存:', e.message);
        }
        return false;
    }finally{
        _isSyncing = false;
    }
}

/* ---------- 持久化 ---------- */
function legacySaveData(){
    // 1. 本地localStorage立即写入（离线兜底）
    localStorage.setItem(getUserStorageKey(), JSON.stringify(state));
    // 2. 防抖推送到后端（在线时主数据源）
    syncToBackend();
}
function legacyLoadData(){
    // v8 升级：兼容读取 v7/v6/v5/v4 旧数据
    let raw=localStorage.getItem(getUserStorageKey());
    if(!raw && authUser && localStorage.getItem(STORAGE_KEY)){
        raw=localStorage.getItem(STORAGE_KEY);
        localStorage.setItem(getUserStorageKey(), raw);
    }
    if(!raw){
        const oldKeys=['study_progress_data_v8','study_progress_data_v7','study_progress_data_v6','study_progress_data_v5','study_progress_data_v4'];
        for(const k of oldKeys){
            const old=localStorage.getItem(k);
            if(old){ try{ state=JSON.parse(old); break; }catch(e){} }
        }
    }else{ try{ state=JSON.parse(raw); }catch(e){ state={}; } }
    // 默认学科（v9b：移除timerCategories，不再区分看书/刷题等子分类）
    if(!state.subjects||!state.subjects.length){
        state.subjects=[{ id:genId(), name:'默认学科', weight:1, dailyTasks:[], longTasks:[], listenMode:null, listenTarget:0, listenCompleted:0, subModules:[], dailyTaskTemplates:[] }];
    }
    state.subjects.forEach(s=>{
        if(s.weight===undefined) s.weight=1;
        if(!s.listenMode) s.listenMode=null;
        if(typeof s.listenTarget!=='number') s.listenTarget=0;
        if(typeof s.listenCompleted!=='number') s.listenCompleted=0;
        if(!Array.isArray(s.subModules)) s.subModules=[];
        if(!Array.isArray(s.dailyTaskTemplates)) s.dailyTaskTemplates=[];
        // v9b 删除子分类：兼容旧数据时不再使用
        delete s.timerCategories;
    });
    // v9b：全局自定义分类（用户设置学习/生活/娱乐）
    if(!Array.isArray(state.classifications)||!state.classifications.length){
        state.classifications=[
            {id:genId(),name:'学习',color:CATEGORY_PALETTE[0]},
            {id:genId(),name:'生活',color:CATEGORY_PALETTE[2]},
            {id:genId(),name:'娱乐',color:CATEGORY_PALETTE[3]}
        ];
    }
    state.classifications.forEach(c=>{ if(!c.color) c.color=nextCategoryColor(); });
    // v9b：为 weeklyPlans / sessions 旧数据补齐 classificationId（原 categoryId 废弃）
    const firstClsId=defaultClassificationId();
    (state.weeklyPlans||[]).forEach(p=>{ if(!p.classificationId) p.classificationId=firstClsId; });
    (state.sessions||[]).forEach(s=>{ if(!s.classificationId) s.classificationId=firstClsId; });
    if(!state.records) state.records={};
    if(!state.midTasks) state.midTasks=[];
    if(!state.sessions) state.sessions=[];
    if(!state.periodicTemplates) state.periodicTemplates=[];
    if(!Array.isArray(state.globalDailyTasks)) state.globalDailyTasks=[];
    if(!Array.isArray(state.longTermPlans)) state.longTermPlans=[];
    if(!Array.isArray(state.weeklyPlans)) state.weeklyPlans=[];
    if(!state.annualNotes||typeof state.annualNotes!=='object') state.annualNotes={};
    if(!state.entertainment||typeof state.entertainment!=='object') state.entertainment={};
    if(!Array.isArray(state.entertainment.categories)||!state.entertainment.categories.length){
        state.entertainment.categories=['书','电影','动漫','漫画','电视剧'].map(name=>({id:genId(),name,subcategories:[]}));
    }
    state.entertainment.categories.forEach(c=>{ if(!Array.isArray(c.subcategories)) c.subcategories=[]; });
    if(!Array.isArray(state.entertainment.works)) state.entertainment.works=[];
    if(typeof state.entertainment.progressEnabled!=='boolean') state.entertainment.progressEnabled=false;
    if(state.entertainment.statusFilter===undefined) state.entertainment.statusFilter='';
    if(state.entertainment.categoryId===undefined) state.entertainment.categoryId='';
    if(state.entertainment.subcategoryId===undefined) state.entertainment.subcategoryId='';
    if(!['home','collection','restrictions'].includes(state.entertainment.page)) state.entertainment.page='home';
    if(!Array.isArray(state.entertainment.kinds)||!state.entertainment.kinds.length){
        state.entertainment.kinds=['看电影','读书','听音乐','玩游戏','看动漫'].map(name=>({id:genId(),name}));
    }
    if(!Array.isArray(state.entertainment.restrictions)) state.entertainment.restrictions=[];
    if(!state.weekTimeConfig) state.weekTimeConfig={ startMin:480, endMin:1380, slotMin:60 };
    state.weekTimeConfig.startMin=Math.max(0,Math.min(1439,Number(state.weekTimeConfig.startMin)||480));
    state.weekTimeConfig.endMin=Math.max(state.weekTimeConfig.startMin+15,Math.min(1440,Number(state.weekTimeConfig.endMin)||1380));
    state.weekTimeConfig.slotMin=Math.max(15,Math.min(1440,Number(state.weekTimeConfig.slotMin)||60));
    if(!Array.isArray(state.mainLines)) state.mainLines=[];  // v6 新增
    // v7 新增：支线数组 & 数据迁移
    if(!Array.isArray(state.sideLines)) state.sideLines=[];
    // v7 数据迁移：旧 longTermPlans / midTasks / periodicTemplates(无mainLineId) 合并进默认"迁移支线"
    const hasOldData=(state.longTermPlans&&state.longTermPlans.length)||(state.midTasks&&state.midTasks.length)||(state.periodicTemplates&&state.periodicTemplates.some(t=>!t.mainLineId));
    if(hasOldData && state.sideLines.length===0){
        const migrateLine={ id:genId(), name:'迁移支线', description:'由旧版长期计划/中期任务/周期模板自动合并生成', deadline:'', createdAt:Date.now(), chapters:[], weeklyTasks:[] };
        // 旧 longTermPlans → chapters
        (state.longTermPlans||[]).forEach(p=>{
            migrateLine.chapters.push({ id:genId(), title:p.text, percent:p.percent||0, createdAt:Date.now() });
        });
        // 旧 midTasks → chapters（尽力而为）
        (state.midTasks||[]).forEach(mt=>{
            migrateLine.chapters.push({ id:genId(), title:mt.title+(mt.deadline?' ('+mt.deadline+')':''), percent:midTaskPercent(mt), createdAt:Date.now() });
        });
        // 旧 periodicTemplates 无 mainLineId → weeklyTasks
        (state.periodicTemplates||[]).forEach(t=>{
            if(!t.mainLineId){
                migrateLine.weeklyTasks.push({ id:genId(), content:t.content, subjectId:t.subjectId||'', scheduleType:t.scheduleType||'daily', weekdays:t.weekdays||[], enabled:t.enabled!==false });
            }
        });
        state.sideLines.push(migrateLine);
        // 迁移后清空旧结构，但保留数据以防回滚（这里只标记 sideOnly=true 兼容旧逻辑）
    }
    // v7 新增：月历标记模块
    if(!state.calendarMarkers) state.calendarMarkers={ events:[], blocks:[] };
    if(!Array.isArray(state.calendarMarkers.events)) state.calendarMarkers.events=[];
    if(!Array.isArray(state.calendarMarkers.blocks)) state.calendarMarkers.blocks=[];
    // v9：weeklyPlans startHour/endHour → startMin/endMin 兼容转换（移除四象限字段默认）
    (state.weeklyPlans||[]).forEach(p=>{
        if(typeof p.startMin!=='number' && typeof p.startHour==='number') p.startMin=p.startHour;
        if(typeof p.endMin!=='number' && typeof p.endHour==='number') p.endMin=p.endHour;
        if(typeof p.startMin!=='number') p.startMin=8*60;
        if(typeof p.endMin!=='number') p.endMin=9*60;
        if(typeof p.completed!=='boolean') p.completed=false;
    });
    // v9：未完成计划超过 30 天自动删除
    if(!Array.isArray(state.weeklyPlans)) state.weeklyPlans=[];
    (function(){
        const today=todayStr();
        const cutoff=new Date(today+'T00:00:00'); cutoff.setDate(cutoff.getDate()-30);
        const cutoffStr=formatDate(cutoff);
        const before=state.weeklyPlans.length;
        state.weeklyPlans=state.weeklyPlans.filter(p=> p.completed || !(p.date && p.date<cutoffStr));
    })();
    // v9：历史未完成显示开关默认
    if(state.showOldUncompleted===undefined) state.showOldUncompleted=false;
    if(typeof state.username!=='string') state.username='';
    if(typeof state.userAvatar!=='string'||!state.userAvatar) state.userAvatar='学';
    if(typeof state.goal!=='string') state.goal='';
    if(!state.currentView) state.currentView='home';
    if(state.sidebarCollapsed===undefined) state.sidebarCollapsed=false;
    if(state.timerFocus===undefined) state.timerFocus=false;
    if(!state.reviewTab) state.reviewTab='week';
    if(!state.planningTab) state.planningTab='main';
    if(!state.dailyDetailDate) state.dailyDetailDate=todayStr();
    if(state.timerFullscreen===undefined) state.timerFullscreen=false;
    // v8 新增：三种 scheduleMode 统一（daily / weekly / memory）+ 记忆曲线默认值
    // 工具：对 weeklyTasks / dailyTaskTemplates / periodicTemplates 数组每项补全字段
    const normalizeTaskTpl=function(t){
        if(!t) return t;
        if(!t.scheduleMode){ t.scheduleMode = t.scheduleType || 'daily'; delete t.scheduleType; }
        if(!['daily','weekly','memory'].includes(t.scheduleMode)) t.scheduleMode='daily';
        if(!Array.isArray(t.weekdays)) t.weekdays=[];
        if(typeof t.memoryDurationMonths!=='number' || t.memoryDurationMonths<=0) t.memoryDurationMonths=12; // 默认1年
        if(!t.memoryStartDate) t.memoryStartDate=todayStr();
        if(t.enabled===undefined) t.enabled=true;
        if(!t._isSubjectTemplate && (!Number.isFinite(Number(t.weeklyTargetCount)) || Number(t.weeklyTargetCount)<1)) t.weeklyTargetCount=1;
        return t;
    };
    (state.mainLines||[]).forEach(ml=>{ if(!Array.isArray(ml.weeklyTasks)) ml.weeklyTasks=[]; ml.weeklyTasks.forEach(normalizeTaskTpl); });
    (state.sideLines||[]).forEach(sl=>{ if(!Array.isArray(sl.weeklyTasks)) sl.weeklyTasks=[]; sl.weeklyTasks.forEach(normalizeTaskTpl); });
    (state.periodicTemplates||[]).forEach(normalizeTaskTpl);
    (state.subjects||[]).forEach(s=>{ (s.dailyTaskTemplates||[]).forEach(normalizeTaskTpl); });
    // 旧视图重定向
    if(['daily','masterplan','periodic','midterm','timer'].includes(state.currentView)){
        if(state.currentView==='daily') state.currentView='dailyDetail';
        else if(state.currentView==='timer') state.currentView='timer';
        else state.currentView='planning';
    }
    if(['stats','weekly'].includes(state.currentView)) state.currentView='review';
}
function genId(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

/* ---------- 日期工具 ---------- */
function pad2(n){ return String(n).padStart(2,'0'); }
function formatDate(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function todayStr(){ return formatDate(new Date()); }
function daysAgoStr(n){ const d=new Date(); d.setDate(d.getDate()-n); return formatDate(d); }
function weekDayLabel(ds){ return ['日','一','二','三','四','五','六'][new Date(ds+'T00:00:00').getDay()]; }
function addDaysStr(ds, n){ const d=new Date(ds+'T00:00:00'); d.setDate(d.getDate()+n); return formatDate(d); }
function diffDaysStr(later, earlier){ return Math.round((new Date(later+'T00:00:00')-new Date(earlier+'T00:00:00'))/86400000); }

/* ---------- v8 新增：记忆曲线（艾宾浩斯）间隔规则工具 ---------- */
// 根据记忆曲线总时长（月）返回标准艾宾浩斯间隔天数数组
function getMemoryIntervals(months){
    const m=Number(months)||12;
    // 标准艾宾浩斯复习间隔（单位：天，从创建当天开始算）
    const full=[0,1,2,4,7,15,30,60,90,180,365,730];
    const maxDays=Math.max(30, Math.round(m*30)); // 1月≈30天，至少30天防止过于激进
    const filtered=full.filter(d=>{
        if(d===0) return true; // 首次创建当天必须包含
        if(d<=maxDays) return true;
        return false;
    });
    // 确保至少有 [0,1,2,4,7,15,30]（一个月）
    const base=[0,1,2,4,7,15,30];
    const seen=new Set();
    const out=[];
    base.forEach(d=>{ if(!seen.has(d)){ seen.add(d); out.push(d); } });
    filtered.forEach(d=>{ if(!seen.has(d) && d<=maxDays){ seen.add(d); out.push(d); } });
    return out.sort((a,b)=>a-b);
}
// 给定周期模板 + 指定日期，判断这一天是否应该生成该任务（通用：weeklyTasks / subject dailyTaskTemplates / periodicTemplates 全部复用）
function scheduleMatchesDate(tpl, dateStr){
    if(!tpl || tpl.enabled===false) return false;
    const mode=tpl.scheduleMode||'daily';
    if(mode==='daily') return true;
    if(mode==='weekly'){
        const dow=new Date(dateStr+'T00:00:00').getDay();
        return Array.isArray(tpl.weekdays) && tpl.weekdays.includes(dow);
    }
    if(mode==='memory'){
        const start=tpl.memoryStartDate || todayStr();
        const daysDiff=diffDaysStr(dateStr, start);
        if(daysDiff<0) return false; // 早于起始日期不生成
        const intervals=getMemoryIntervals(tpl.memoryDurationMonths||12);
        return intervals.includes(daysDiff);
    }
    return false;
}
// 生成scheduleMode的人类可读描述
function describeSchedule(tpl){
    const mode=(tpl||{}).scheduleMode||'daily';
    if(mode==='daily') return '每天';
    if(mode==='weekly'){
        const days=(tpl.weekdays||[]).map(d=>['日','一','二','三','四','五','六'][d]).join('、');
        return days?('每周'+days):'每周';
    }
    if(mode==='memory'){
        const months=(tpl.memoryDurationMonths||12);
        return `记忆曲线${months}个月`;
    }
    return '自定义';
}
function weeklyTaskTemplateIds(templateUid){ return [templateUid, templateUid.replace(/^wt_ml_|^wt_sl_/,m=>m==='wt_ml_'?'ml_':'sl_')]; }
function weeklyTaskWeekStats(sub, templateUid, dateStr, targetCount){
    const date=new Date((dateStr||todayStr())+'T00:00:00');
    const weekStart=getWeekStart(date,0); const start=formatDate(weekStart); const end=new Date(weekStart); end.setDate(end.getDate()+7); const endStr=formatDate(end);
    const ids=new Set(weeklyTaskTemplateIds(templateUid)); let completed=0;
    (sub.dailyTasks||[]).forEach(t=>{ if(ids.has(t.templateId)&&t.generatedDate>=start&&t.generatedDate<endStr&&t.completed) completed++; });
    const elapsed=Math.max(0,Math.min(7,diffDaysStr(dateStr||todayStr(),start)+1));
    return {completed, remainingDays:Math.max(0,7-elapsed), target:Math.max(1,Number(targetCount)||1)};
}
function weeklyTaskShouldShow(tpl, dateStr, templateUid, sub){
    if(!tpl || tpl.weeklyTargetCount===undefined) return true;
    const subject= sub || state.subjects.find(s=>s.id===tpl.subjectId); if(!subject) return true;
    const stats=weeklyTaskWeekStats(subject,templateUid,dateStr,tpl.weeklyTargetCount);
    const remaining=Math.max(0,stats.target-stats.completed);
    return remaining>0 && stats.remainingDays<remaining;
}
function findWeeklyTaskTemplate(templateUid){
    for(const ml of state.mainLines||[]) for(const tpl of ml.weeklyTasks||[]) if('wt_ml_'+ml.id+'_'+tpl.id===templateUid||'ml_'+ml.id+'_'+tpl.id===templateUid) return tpl;
    for(const sl of state.sideLines||[]) for(const tpl of sl.weeklyTasks||[]) if('wt_sl_'+sl.id+'_'+tpl.id===templateUid||'sl_'+sl.id+'_'+tpl.id===templateUid) return tpl;
    return null;
}

/* ---------- 用户名 & 大目标 ---------- */
function onUsernameChange(v){
    state.username=v;
    state.userAvatar=v?v.trim().charAt(0)||'学':'学';
    saveData();
}
function onGoalChange(v){ state.goal=v; saveData(); }

/* ---------- 周期任务生成：按 scheduleMode 判断今日是否命中，幂等写入学科 dailyTasks（不破坏已完成态） ---------- */
function generatePeriodicTasks(){
    const today=todayStr();
    let changed=false;
    // 构造今日所有模板的唯一键 → 模板对象的映射，用于统一写入
    const tplList=[];
    // ① 主线下的周常任务
    (state.mainLines||[]).forEach(ml=>{
        (ml.weeklyTasks||[]).forEach(tpl=>{
            if(!tpl.enabled) return;
            if(!tpl.subjectId || !state.subjects.find(s=>s.id===tpl.subjectId)) return;
            if(!scheduleMatchesDate(tpl, today) || !weeklyTaskShouldShow(tpl, today, 'wt_ml_'+ml.id+'_'+tpl.id)) return;
            tplList.push({ subjectId: tpl.subjectId, templateUid: 'wt_ml_'+ml.id+'_'+tpl.id, legacyUid: 'ml_'+ml.id+'_'+tpl.id, content: tpl.content });
        });
    });
    // ② 支线下的周常任务
    (state.sideLines||[]).forEach(sl=>{
        (sl.weeklyTasks||[]).forEach(tpl=>{
            if(!tpl.enabled) return;
            if(!tpl.subjectId || !state.subjects.find(s=>s.id===tpl.subjectId)) return;
            if(!scheduleMatchesDate(tpl, today) || !weeklyTaskShouldShow(tpl, today, 'wt_sl_'+sl.id+'_'+tpl.id)) return;
            tplList.push({ subjectId: tpl.subjectId, templateUid: 'wt_sl_'+sl.id+'_'+tpl.id, legacyUid: 'sl_'+sl.id+'_'+tpl.id, content: tpl.content });
        });
    });
    // ③ 旧 periodicTemplates（兼容）
    (state.periodicTemplates||[]).forEach(tpl=>{
        if(!tpl.enabled) return;
        if(tpl.mainLineId) return;
        if(!tpl.subjectId || !state.subjects.find(s=>s.id===tpl.subjectId)) return;
        if(!scheduleMatchesDate(tpl, today)) return;
        tplList.push({ subjectId: tpl.subjectId, templateUid: 'pt_'+tpl.id, legacyUid: tpl.id, content: tpl.content });
    });
    // ④ v8新增：各学科每日任务周期模板 dailyTaskTemplates
    (state.subjects||[]).forEach(sub=>{
        (sub.dailyTaskTemplates||[]).forEach(tpl=>{
            if(!tpl.enabled) return;
            if(!scheduleMatchesDate(tpl, today)) return;
            tplList.push({ subjectId: sub.id, templateUid: 'sdt_'+sub.id+'_'+tpl.id, legacyUid: null, content: tpl.content });
        });
    });
    // 批量幂等写入：同一学科+同一日期+同一模板（新uid或旧uid）已存在则跳过；否则新建
    const bySubject=new Map(); // subjectId → sub
    state.subjects.forEach(s=>bySubject.set(s.id, s));
    tplList.forEach(item=>{
        const sub=bySubject.get(item.subjectId);
        if(!sub) return;
        const exists=sub.dailyTasks.some(t=>{
            if(t.generatedDate!==today) return false;
            return t.templateId===item.templateUid || t.templateId===item.legacyUid;
        });
        if(!exists){
            sub.dailyTasks.push({ id:genId(), text:item.content, completed:false, templateId:item.templateUid, generatedDate:today });
            changed=true;
        }
    });
    if(changed) saveData();
}
// 获取某学科指定日期有效的每日任务 = 【手动任务（无generatedDate或generatedDate==dateStr）】 ∪ 【虚拟周期任务（当天命中但还没生成actual的，用虚拟项，已存在actual则用actual）】
// 这样切换日常详情页到其他日期（过去/未来）都能看到完整周期任务。经验1358638：completed状态始终以actual为准。
function datedDailyTasks(sub, dateStr){
    if(!sub) return [];
    const manual=(sub.dailyTasks||[]).filter(t=>{
        if(t.generatedDate && t.generatedDate!==dateStr) return false;
        const tpl=findWeeklyTaskTemplate(t.templateId);
        return !tpl || weeklyTaskShouldShow(tpl,dateStr,t.templateId,sub);
    });
    // 构造actual的templateId集合（用于后续虚拟去重）
    const actualIds=new Set(manual.filter(t=>t.templateId && t.generatedDate===dateStr).map(t=>t.templateId));
    const virtuals=[];
    const pushIfMatch=function(tpl, tplUid, isWeekly){
        if(!tpl || !tpl.enabled) return;
        if(actualIds.has(tplUid)) return; // 已有actual，不用虚拟
        if(!scheduleMatchesDate(tpl, dateStr)) return;
        if(isWeekly && !weeklyTaskShouldShow(tpl,dateStr,tplUid,sub)) return;
        virtuals.push({
            id: 'v_'+tplUid+'_'+dateStr, text:tpl.content, completed:false,
            templateId:tplUid, generatedDate:dateStr, isVirtual:true
        });
    };
    // 周常任务（主线/支线）
    (state.mainLines||[]).forEach(ml=>{
        (ml.weeklyTasks||[]).forEach(tpl=>{
            if(tpl.subjectId!==sub.id) return;
            pushIfMatch(tpl, 'wt_ml_'+ml.id+'_'+tpl.id, true);
        });
    });
    (state.sideLines||[]).forEach(sl=>{
        (sl.weeklyTasks||[]).forEach(tpl=>{
            if(tpl.subjectId!==sub.id) return;
            pushIfMatch(tpl, 'wt_sl_'+sl.id+'_'+tpl.id, true);
        });
    });
    // 旧 periodicTemplates 兼容
    (state.periodicTemplates||[]).forEach(tpl=>{
        if(tpl.mainLineId) return;
        if(tpl.subjectId!==sub.id) return;
        pushIfMatch(tpl, 'pt_'+tpl.id);
    });
    // 学科每日周期模板
    (sub.dailyTaskTemplates||[]).forEach(tpl=>{
        pushIfMatch(tpl, 'sdt_'+sub.id+'_'+tpl.id);
    });
    return manual.concat(virtuals);
}
// 向后兼容：todayDailyTasks 直接调 datedDailyTasks(today)
function todayDailyTasks(sub){ return datedDailyTasks(sub, todayStr()); }

function midTaskPercent(mt){
    const goals=mt.subGoals||[];
    if(!goals.length) return 0;
    let cur=0,tar=0;
    goals.forEach(g=>{ cur+=Number(g.current)||0; tar+=Number(g.target)||0; });
    return tar? Math.min(100,Math.round(cur/tar*100)):0;
}
// 主线任务进度：章节平均 + 周常完成率平均
function mainLinePercent(ml){
    const parts=[];
    (ml.chapters||[]).forEach(c=>{ if(typeof c.percent==='number') parts.push(Math.max(0,Math.min(100,c.percent))); });
    // 周常模板统计：统计生成实例的完成率（兼容新旧两种uid前缀）
    let wtTotal=0, wtDone=0;
    (ml.weeklyTasks||[]).forEach(tpl=>{
        const newUid='wt_ml_'+ml.id+'_'+tpl.id;
        const oldUid='ml_'+ml.id+'_'+tpl.id;
        state.subjects.forEach(s=>{
            (s.dailyTasks||[]).forEach(task=>{
                if(task.templateId===newUid || task.templateId===oldUid){ wtTotal++; if(task.completed) wtDone++; }
            });
        });
    });
    if(wtTotal>0) parts.push(Math.round(wtDone/wtTotal*100));
    if(!parts.length) return 0;
    return Math.round(parts.reduce((a,b)=>a+b,0)/parts.length);
}
// v7 支线任务进度：与主线算法一致，但周常 tplUid 前缀为 sl_ / wt_sl_
function sideLinePercent(sl){
    const parts=[];
    (sl.chapters||[]).forEach(c=>{ if(typeof c.percent==='number') parts.push(Math.max(0,Math.min(100,c.percent))); });
    let wtTotal=0, wtDone=0;
    (sl.weeklyTasks||[]).forEach(tpl=>{
        const newUid='wt_sl_'+sl.id+'_'+tpl.id;
        const oldUid='sl_'+sl.id+'_'+tpl.id;
        state.subjects.forEach(s=>{
            (s.dailyTasks||[]).forEach(task=>{
                if(task.templateId===newUid || task.templateId===oldUid){ wtTotal++; if(task.completed) wtDone++; }
            });
        });
    });
    if(wtTotal>0) parts.push(Math.round(wtDone/wtTotal*100));
    if(!parts.length) return 0;
    return Math.round(parts.reduce((a,b)=>a+b,0)/parts.length);
}

/* ---------- 侧边栏导航 ---------- */
const VIEW_TITLES={home:'总览',planning:'计划体系',dailyDetail:'日常详情',timer:'计时中心',review:'数据复盘',subjects:'学科管理',entertainment:'娱乐'};
function switchView(view){
    state.currentView=view;
    saveData();
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('view-active'));
    const el=document.getElementById('view-'+view);
    if(el) el.classList.add('view-active');
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('nav-item-active'));
    // 对日常/计时：在侧边栏高亮最接近的父导航
    let navView=view;
    if(view==='dailyDetail') navView='home';
    if(view==='timer') navView='home'; // 计时已从一级导航移除
    const btn=document.querySelector(`.nav-item[data-view="${navView}"]`);
    if(btn) btn.classList.add('nav-item-active');
    document.getElementById('mobileTitle').textContent=VIEW_TITLES[view]||'';
    renderViewContent(view);
    closeSidebarMobile();
    // 切换视图时关闭计时全屏
    if(timerFullscreenActive) exitTimerFullscreen();
}
function renderViewContent(view){
    if(view==='home') renderHome();
    else if(view==='dailyDetail') renderDailyDetail();
    else if(view==='planning') renderPlanning();
    else if(view==='subjects') renderSubjectCards();
    else if(view==='entertainment') renderEntertainment();
    else if(view==='timer'){ renderTimer(); renderSubjectTimeStats(); renderSessionList(); initManualRecordForm(); }
    else if(view==='review') renderReview();
}
function entertainmentData(){ return state.entertainment||{categories:[],works:[],progressEnabled:false,status:'following'}; }
function toggleEntertainmentStatus(status){ const d=entertainmentData(); d.statusFilter=d.statusFilter===status?'':status; saveData(); renderEntertainment(); }
function entertainmentCategory(id){ return entertainmentData().categories.find(c=>c.id===id); }
const ENTERTAINMENT_KIND_COLORS=['#22a6b3','#f6b93b','#78c091','#e779a8','#6c9ee8','#f08a5d','#8fbc8f','#d98b9c','#55b7a5','#f2a65a'];
const ENTERTAINMENT_KIND_ICONS=['🎬','📚','🎧','🎮','🌟','🎨','🏀','🧩','🎤','🚲'];
function enterEntertainmentPage(page){
    const d=entertainmentData(); d.page=page; saveData(); renderEntertainment();
}
function renderEntertainmentHome(){
    const d=entertainmentData();
    const grid=document.getElementById('entertainmentKindGrid');
    if(grid) grid.innerHTML=d.kinds.map((kind,index)=>`<button onclick="enterEntertainmentPage('home'); drawEntertainmentKind('${kind.id}')" class="entertainment-kind-card rounded-2xl p-4 text-white shadow-sm flex flex-col items-center justify-center text-center" style="background:${ENTERTAINMENT_KIND_COLORS[index%ENTERTAINMENT_KIND_COLORS.length]}"><span class="text-4xl mb-3">${ENTERTAINMENT_KIND_ICONS[index%ENTERTAINMENT_KIND_ICONS.length]}</span><span class="entertainment-kind-title text-xl font-bold">${escapeHtml(kind.name)}</span></button>`).join('');
    const manage=document.getElementById('entertainmentKindManageList');
    if(manage) manage.innerHTML=d.kinds.map((kind,index)=>`<span class="inline-flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"><span>${ENTERTAINMENT_KIND_ICONS[index%ENTERTAINMENT_KIND_ICONS.length]}</span><span>${escapeHtml(kind.name)}</span><button onclick="renameEntertainmentKind('${kind.id}')" class="text-primary-600 text-xs">重命名</button><button onclick="deleteEntertainmentKind('${kind.id}')" class="text-red-400 text-xs">删除</button></span>`).join('');
}
function renderEntertainmentRestrictions(){
    const d=entertainmentData(), list=document.getElementById('entertainmentRestrictionList'), empty=document.getElementById('entertainmentRestrictionEmpty');
    if(!list||!empty) return;
    list.innerHTML=d.restrictions.map(item=>`<div class="flex items-center gap-3 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 ${item.completed?'opacity-60':''}"><input type="checkbox" ${item.completed?'checked':''} onchange="toggleEntertainmentRestriction('${item.id}')" class="w-4 h-4"><span class="flex-1 text-sm ${item.completed?'line-through text-slate-400':'text-slate-600'}">${escapeHtml(item.text)}</span><button onclick="editEntertainmentRestriction('${item.id}')" class="text-xs text-primary-600">编辑</button><button onclick="deleteEntertainmentRestriction('${item.id}')" class="text-xs text-red-400">删除</button></div>`).join('');
    empty.classList.toggle('hidden',d.restrictions.length>0);
}
function renderEntertainment(){
    const page=entertainmentData().page||'home';
    document.getElementById('entertainmentHomePage')?.classList.toggle('hidden',page!=='home');
    document.getElementById('entertainmentCollectionPage')?.classList.toggle('hidden',page!=='collection');
    document.getElementById('entertainmentRestrictionsPage')?.classList.toggle('hidden',page!=='restrictions');
    if(page==='home') renderEntertainmentHome();
    if(page==='collection') renderEntertainmentCollection();
    if(page==='restrictions') renderEntertainmentRestrictions();
}
function addEntertainmentKind(){ const input=document.getElementById('entertainmentKindName'),name=input?.value.trim(); if(!name) return; entertainmentData().kinds.push({id:genId(),name}); input.value=''; saveData(); renderEntertainmentHome(); }
function renameEntertainmentKind(id){ const kind=entertainmentData().kinds.find(x=>x.id===id),name=prompt('请输入新的娱乐种类名称：',kind?.name||''); if(kind&&name?.trim()){kind.name=name.trim();saveData();renderEntertainmentHome();} }
function deleteEntertainmentKind(id){ const d=entertainmentData(); if(d.kinds.length<=1){showToast('至少保留一个娱乐种类');return;} openConfirmModal('确定删除该娱乐种类？',()=>{d.kinds=d.kinds.filter(x=>x.id!==id);saveData();renderEntertainmentHome();}); }
function drawEntertainmentKind(id){ const d=entertainmentData(); if(!d.kinds.length) return showToast('请先添加娱乐种类'); const kind=d.kinds.find(x=>x.id===id)||d.kinds[Math.floor(Math.random()*d.kinds.length)]; const index=d.kinds.indexOf(kind); document.getElementById('entertainmentKindRandomName').textContent=kind.name; document.getElementById('entertainmentKindRandomIcon').textContent=ENTERTAINMENT_KIND_ICONS[index%ENTERTAINMENT_KIND_ICONS.length]; document.getElementById('entertainmentKindRandomCard').style.background=ENTERTAINMENT_KIND_COLORS[index%ENTERTAINMENT_KIND_COLORS.length]; document.getElementById('entertainmentKindRandomModal').classList.remove('hidden'); }
function closeEntertainmentKindRandom(){ document.getElementById('entertainmentKindRandomModal').classList.add('hidden'); }
function addEntertainmentRestriction(){ const input=document.getElementById('entertainmentRestrictionInput'),text=input?.value.trim(); if(!text)return; entertainmentData().restrictions.push({id:genId(),text,completed:false}); input.value='';saveData();renderEntertainmentRestrictions(); }
function toggleEntertainmentRestriction(id){ const item=entertainmentData().restrictions.find(x=>x.id===id); if(item){item.completed=!item.completed;saveData();renderEntertainmentRestrictions();} }
function editEntertainmentRestriction(id){ const item=entertainmentData().restrictions.find(x=>x.id===id),text=prompt('修改限制条目：',item?.text||''); if(item&&text?.trim()){item.text=text.trim();saveData();renderEntertainmentRestrictions();} }
function deleteEntertainmentRestriction(id){ openConfirmModal('确定删除该限制条目？',()=>{entertainmentData().restrictions=entertainmentData().restrictions.filter(x=>x.id!==id);saveData();renderEntertainmentRestrictions();}); }
function fillEntertainmentSubcategory(selectId, categoryId, selected){
    const el=document.getElementById(selectId); if(!el) return;
    const c=entertainmentCategory(categoryId); el.innerHTML='<option value="">未分类</option>'+(c?c.subcategories.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join(''):''); if(selected) el.value=selected;
}
function renderEntertainmentCollection(){
    const d=entertainmentData(), categoryId=d.categoryId||'', subcategoryId=d.subcategoryId||'';
    const categoryTabs=document.getElementById('entertainmentCategoryTabs'), subcategoryTabs=document.getElementById('entertainmentSubcategoryTabs');
    categoryTabs.innerHTML=`<button onclick="selectEntertainmentCategory('')" class="px-3 py-1.5 text-xs rounded-lg ${!categoryId?'bg-primary-500 text-white':'bg-slate-100 text-slate-500 hover:bg-slate-200'}">全部</button>`+d.categories.map(c=>`<button onclick="selectEntertainmentCategory('${c.id}')" class="px-3 py-1.5 text-xs rounded-lg ${categoryId===c.id?'bg-primary-500 text-white':'bg-slate-100 text-slate-500 hover:bg-slate-200'}">${escapeHtml(c.name)}</button>`).join('');
    const currentCategory=entertainmentCategory(categoryId);
    subcategoryTabs.classList.toggle('hidden',!currentCategory||!currentCategory.subcategories.length);
    subcategoryTabs.innerHTML=currentCategory?`<button onclick="selectEntertainmentSubcategory('')" class="px-3 py-1 text-[11px] rounded ${!subcategoryId?'bg-primary-50 text-primary-600':'bg-slate-100 text-slate-500'}">全部小分类</button>`+currentCategory.subcategories.map(s=>`<button onclick="selectEntertainmentSubcategory('${s.id}')" class="px-3 py-1 text-[11px] rounded ${subcategoryId===s.id?'bg-primary-50 text-primary-600':'bg-slate-100 text-slate-500'}">${escapeHtml(s.name)}</button>`).join(''):'';
    const works=d.works.filter(w=>(!d.statusFilter||w.status===d.statusFilter)&&(!categoryId||w.categoryId===categoryId)&&(!subcategoryId||w.subcategoryId===subcategoryId));
    document.getElementById('entertainmentSummary').textContent=`${d.works.length} 部作品 · 在追 ${d.works.filter(w=>w.status==='following').length} · 看完 ${d.works.filter(w=>w.status==='finished').length}`;
    document.getElementById('entertainmentStatusFollowing').className=d.statusFilter==='following'?'px-4 py-1.5 text-xs rounded-md bg-white text-primary-600 shadow-sm':'px-4 py-1.5 text-xs rounded-md text-slate-500';
    document.getElementById('entertainmentStatusFinished').className=d.statusFilter==='finished'?'px-4 py-1.5 text-xs rounded-md bg-white text-primary-600 shadow-sm':'px-4 py-1.5 text-xs rounded-md text-slate-500';
    const grid=document.getElementById('entertainmentWorkGrid'); grid.innerHTML=works.map(w=>{ const cat=entertainmentCategory(w.categoryId); const sub=cat?.subcategories.find(s=>s.id===w.subcategoryId); return `<article class="entertainment-card bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100"><div class="entertainment-cover bg-gradient-to-br from-primary-50 to-indigo-50 flex items-center justify-center text-center p-3">${w.cover?`<img src="${w.cover}" class="w-full h-full object-cover" alt="">`:`<span class="text-sm font-semibold text-primary-600">${escapeHtml(w.title)}</span>`}</div><div class="p-3"><h4 class="font-semibold text-slate-700 truncate">${escapeHtml(w.title)}</h4><p class="text-[10px] text-slate-400 truncate mt-1">${escapeHtml(cat?.name||'')} ${sub?'· '+escapeHtml(sub.name):''}</p>${w.status==='finished'?`<div class="mt-2 text-[11px] text-amber-600">${Math.max(1,Number(w.rewatchCount)||1)} 刷</div>`:''}${d.progressEnabled&&w.status==='following'&&w.episodes?`<div class="mt-2 text-[11px] text-slate-500">进度 ${w.current||0}/${w.episodes}</div><div class="h-1.5 bg-slate-100 rounded-full mt-1"><div class="h-full bg-primary-500 rounded-full" style="width:${Math.min(100,Math.round((w.current||0)/w.episodes*100))}%"></div></div>`:''}${w.note?`<p class="text-xs text-slate-400 mt-2 line-clamp-2">${escapeHtml(w.note)}</p>`:''}<div class="flex justify-end gap-2 mt-3"><button onclick="openEntertainmentWorkModal('${w.id}')" class="text-xs text-primary-600">编辑</button><button onclick="deleteEntertainmentWork('${w.id}')" class="text-xs text-red-400">删除</button></div></div></article>`; }).join(''); document.getElementById('entertainmentEmpty').classList.toggle('hidden',works.length>0);
}
function selectEntertainmentCategory(id){ const d=entertainmentData(); d.categoryId=id; d.subcategoryId=''; saveData(); renderEntertainment(); }
function selectEntertainmentSubcategory(id){ entertainmentData().subcategoryId=id; saveData(); renderEntertainment(); }
function openEntertainmentWorkModal(id){
    const d=entertainmentData(), w=d.works.find(x=>x.id===id)||{id:'',title:'',note:'',categoryId:d.categoryId||'',subcategoryId:d.subcategoryId||'',status:'following',episodes:0,current:0,cover:'',rewatchCount:1};
    document.getElementById('entertainmentWorkId').value=w.id; document.getElementById('entertainmentWorkTitle').value=w.title; document.getElementById('entertainmentWorkNote').value=w.note||''; document.getElementById('entertainmentWorkCategory').innerHTML='<option value="">全部（不指定）</option>'+d.categories.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(''); document.getElementById('entertainmentWorkCategory').value=w.categoryId||''; fillEntertainmentSubcategory('entertainmentWorkSubcategory',w.categoryId,w.subcategoryId); document.querySelectorAll('input[name="entertainmentStatus"]').forEach(x=>x.checked=x.value===w.status); document.getElementById('entertainmentWorkEpisodes').value=w.episodes||''; document.getElementById('entertainmentWorkCurrent').value=w.current||''; document.getElementById('entertainmentWorkRewatch').value=Math.max(1,Number(w.rewatchCount)||1); document.getElementById('entertainmentWorkCover').value=''; document.getElementById('entertainmentWorkModalTitle').textContent=id?'编辑作品':'添加作品'; toggleEntertainmentEpisodeFields(); document.getElementById('entertainmentWorkModal').classList.remove('hidden');
}
function closeEntertainmentWorkModal(){ document.getElementById('entertainmentWorkModal').classList.add('hidden'); }
function toggleEntertainmentEpisodeFields(){
    const finished=document.querySelector('input[name="entertainmentStatus"]:checked')?.value==='finished';
    document.getElementById('entertainmentEpisodeFields').classList.toggle('hidden',finished||!entertainmentData().progressEnabled);
    document.getElementById('entertainmentRewatchField').classList.toggle('hidden',!finished);
}
function saveEntertainmentWork(){
    const d=entertainmentData(), id=document.getElementById('entertainmentWorkId').value, title=document.getElementById('entertainmentWorkTitle').value.trim(); if(!title){showToast('请输入作品标题');return;}
    const existing=d.works.find(w=>w.id===id), work=existing||{id:genId()}; work.title=title; work.note=document.getElementById('entertainmentWorkNote').value.trim(); work.categoryId=document.getElementById('entertainmentWorkCategory').value; work.subcategoryId=document.getElementById('entertainmentWorkSubcategory').value; work.status=document.querySelector('input[name="entertainmentStatus"]:checked').value; work.episodes=Math.max(0,parseInt(document.getElementById('entertainmentWorkEpisodes').value,10)||0); work.current=Math.max(0,parseInt(document.getElementById('entertainmentWorkCurrent').value,10)||0); work.rewatchCount=work.status==='finished'?Math.max(1,parseInt(document.getElementById('entertainmentWorkRewatch').value,10)||1):0; if(work.episodes) work.current=Math.min(work.current,work.episodes); const file=document.getElementById('entertainmentWorkCover').files[0]; if(file){const reader=new FileReader(); reader.onload=()=>{work.cover=reader.result; if(!existing)d.works.push(work); saveData();closeEntertainmentWorkModal();renderEntertainment();}; reader.readAsDataURL(file); return;} if(!existing)d.works.push(work); saveData();closeEntertainmentWorkModal();renderEntertainment();
}
function deleteEntertainmentWork(id){ openConfirmModal('确定删除该作品？',()=>{entertainmentData().works=entertainmentData().works.filter(w=>w.id!==id);saveData();renderEntertainment();}); }
function openEntertainmentSettings(){ renderEntertainmentSettings(); document.getElementById('entertainmentProgressToggle').checked=!!entertainmentData().progressEnabled; document.getElementById('entertainmentSettingsModal').classList.remove('hidden'); }
function closeEntertainmentSettings(){ document.getElementById('entertainmentSettingsModal').classList.add('hidden'); }
function toggleEntertainmentProgress(v){ entertainmentData().progressEnabled=!!v; saveData(); renderEntertainment(); }
function renderEntertainmentSettings(){ const d=entertainmentData(); document.getElementById('entertainmentCategoryList').innerHTML=d.categories.map(c=>`<div class="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2"><span class="flex-1 text-sm">${escapeHtml(c.name)}</span><button onclick="renameEntertainmentCategory('${c.id}')" class="text-xs text-primary-600">重命名</button><button onclick="deleteEntertainmentCategory('${c.id}')" class="text-xs text-red-400">删除</button></div>`).join(''); document.getElementById('entertainmentSubcategoryParent').innerHTML=d.categories.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(''); document.getElementById('entertainmentSubcategoryList').innerHTML=d.categories.flatMap(c=>c.subcategories.map(s=>`<div class="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2"><span class="flex-1 text-sm">${escapeHtml(c.name)} · ${escapeHtml(s.name)}</span><button onclick="renameEntertainmentSubcategory('${c.id}','${s.id}')" class="text-xs text-primary-600">重命名</button><button onclick="deleteEntertainmentSubcategory('${c.id}','${s.id}')" class="text-xs text-red-400">删除</button></div>`)).join(''); }
function addEntertainmentCategory(){const input=document.getElementById('entertainmentCategoryName'),name=input.value.trim();if(!name)return;entertainmentData().categories.push({id:genId(),name,subcategories:[]});input.value='';saveData();renderEntertainmentSettings();renderEntertainment();}
function renameEntertainmentCategory(id){const c=entertainmentCategory(id),name=prompt('请输入新的分类名称：',c?.name||'');if(c&&name?.trim()){c.name=name.trim();saveData();renderEntertainmentSettings();renderEntertainment();}}
function deleteEntertainmentCategory(id){if(entertainmentData().categories.length<=1){showToast('至少保留一个大分类');return;}openConfirmModal('删除分类后作品仍会保留但失去分类，确定删除？',()=>{entertainmentData().categories=entertainmentData().categories.filter(c=>c.id!==id);saveData();renderEntertainmentSettings();renderEntertainment();});}
function addEntertainmentSubcategory(){const name=document.getElementById('entertainmentSubcategoryName').value.trim(),c=entertainmentCategory(document.getElementById('entertainmentSubcategoryParent').value);if(!name||!c)return;c.subcategories.push({id:genId(),name});document.getElementById('entertainmentSubcategoryName').value='';saveData();renderEntertainmentSettings();renderEntertainment();}
function renameEntertainmentSubcategory(cid,id){const s=entertainmentCategory(cid)?.subcategories.find(x=>x.id===id),name=prompt('请输入新的小分类名称：',s?.name||'');if(s&&name?.trim()){s.name=name.trim();saveData();renderEntertainmentSettings();renderEntertainment();}}
function deleteEntertainmentSubcategory(cid,id){const c=entertainmentCategory(cid);if(c){c.subcategories=c.subcategories.filter(s=>s.id!==id);saveData();renderEntertainmentSettings();renderEntertainment();}}
function openEntertainmentRandomModal(){updateEntertainmentRandomOptions();document.getElementById('entertainmentRandomResults').innerHTML='';document.getElementById('entertainmentRandomModal').classList.remove('hidden');}
function closeEntertainmentRandomModal(){document.getElementById('entertainmentRandomModal').classList.add('hidden');}
function updateEntertainmentRandomOptions(){const scope=document.getElementById('entertainmentRandomScope').value,el=document.getElementById('entertainmentRandomFilter');el.innerHTML=scope==='category'?entertainmentData().categories.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(''):scope==='subcategory'?entertainmentData().categories.flatMap(c=>c.subcategories.map(s=>`<option value="${c.id}|${s.id}">${escapeHtml(c.name)} · ${escapeHtml(s.name)}</option>`)).join(''):'<option value="">全部</option>';}
function drawEntertainmentRandomWorks(){const d=entertainmentData(),scope=document.getElementById('entertainmentRandomScope').value,filter=document.getElementById('entertainmentRandomFilter').value,count=Math.max(1,parseInt(document.getElementById('entertainmentRandomCount').value,10)||1);let pool=d.works;if(scope==='category')pool=pool.filter(w=>w.categoryId===filter);if(scope==='subcategory'){const [c,s]=filter.split('|');pool=pool.filter(w=>w.categoryId===c&&w.subcategoryId===s);}pool=pool.sort(()=>Math.random()-.5).slice(0,count);document.getElementById('entertainmentRandomResults').innerHTML=pool.length?pool.map(w=>`<div class="bg-slate-50 rounded-lg p-2 text-center"><div class="aspect-[3/4] bg-primary-50 rounded flex items-center justify-center p-2">${w.cover?`<img src="${w.cover}" class="w-full h-full object-cover rounded" alt="">`:`<span class="text-xs text-primary-600">${escapeHtml(w.title)}</span>`}</div><p class="text-xs font-medium mt-2 truncate">${escapeHtml(w.title)}</p></div>`).join(''):'<p class="col-span-3 text-center text-sm text-slate-400 py-6">没有符合条件的作品</p>';}
function toggleSidebarCollapse(){
    state.sidebarCollapsed=!state.sidebarCollapsed;
    saveData();
    applySidebarCollapse();
}
function applySidebarCollapse(){
    const sb=document.getElementById('sidebar');
    if(state.sidebarCollapsed) sb.classList.add('sidebar-collapsed');
    else sb.classList.remove('sidebar-collapsed');
}
function openSidebarMobile(){
    document.getElementById('sidebar').classList.remove('-translate-x-full');
    document.getElementById('sidebarOverlay').classList.remove('hidden');
}
function closeSidebarMobile(){
    if(window.innerWidth<1024){
        document.getElementById('sidebar').classList.add('-translate-x-full');
        document.getElementById('sidebarOverlay').classList.add('hidden');
    }
}

/* ---------- 个人面板（双入口） ---------- */
function openPersonalPanel(){
    renderPersonalPanel();
    document.getElementById('personalPanel').classList.add('panel-open');
    document.getElementById('personalPanelOverlay').classList.remove('hidden');
}
function closePersonalPanel(){
    document.getElementById('personalPanel').classList.remove('panel-open');
    document.getElementById('personalPanelOverlay').classList.add('hidden');
}
function getStreakDays(){
    let streak=0;
    for(let i=0;i<365;i++){
        const ds=daysAgoStr(i);
        const rec=state.records[ds];
        if(rec&&rec.checkedIn) streak++;
        else { if(i===0) continue; break; }
    }
    return streak;
}
/* ---------- 日常详情页（日期切换） ---------- */
function changeDailyDate(delta){
    const d=new Date(state.dailyDetailDate+'T00:00:00');
    d.setDate(d.getDate()+delta);
    state.dailyDetailDate=formatDate(d);
    document.getElementById('dailyDatePicker').value=state.dailyDetailDate;
    saveData(); renderDailyDetail();
}
function goDailyToday(){
    state.dailyDetailDate=todayStr();
    document.getElementById('dailyDatePicker').value=state.dailyDetailDate;
    saveData(); renderDailyDetail();
}
function onDailyDateChange(v){
    if(!v) return;
    state.dailyDetailDate=v;
    saveData(); renderDailyDetail();
}
function renderDailyDetail(){
    // 初始化日期选择器
    const picker=document.getElementById('dailyDatePicker');
    if(!picker.value) picker.value=state.dailyDetailDate;
    // 日期学科下拉
    const sel=document.getElementById('ddSubjectSelect');
    if(sel){
        sel.innerHTML='<option value="">自由任务</option>'+state.subjects.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    }
    const ds=state.dailyDetailDate;
    const counts=datedTaskCounts(ds);
    const pct=counts.total?Math.round(counts.done/counts.total*100):0;
    document.getElementById('ddTodoCount').textContent=counts.total-counts.done;
    document.getElementById('ddDoneCount').textContent=counts.done;
    document.getElementById('ddPercent').textContent=pct;
    document.getElementById('ddTodoBadge').textContent=counts.total-counts.done;
    document.getElementById('ddDoneBadge').textContent=counts.done;
    // 聚合任务
    const todoItems=[], doneItems=[];
    state.globalDailyTasks.forEach(t=>{
        if(t.date===ds){
            const subName=t.subjectId?(state.subjects.find(s=>s.id===t.subjectId)||{}).name||'自由':'自由';
            const item={ kind:'global', taskId:t.id, text:t.text, completed:t.completed, isPeriodic:false, subjectName:subName, matched:t.matchedSubModuleIds, completedAt:t.completedAt, subjectId:t.subjectId };
            (t.completed?doneItems:todoItems).push(item);
        }
    });
    state.subjects.forEach(sub=>{
        datedDailyTasks(sub,ds).forEach(t=>{
            const item={ kind:'subject', subjectId:sub.id, subjectName:sub.name, taskId:t.id, text:t.text, completed:t.completed, isPeriodic:!!t.templateId, matched:t.matchedSubModuleIds, completedAt:t.completedAt };
            (t.completed?doneItems:todoItems).push(item);
        });
    });
    // 渲染待办
    const todoList=document.getElementById('ddTodoList');
    const todoEmpty=document.getElementById('ddTodoEmpty');
    if(!todoItems.length){ todoList.innerHTML=''; todoEmpty.classList.remove('hidden'); }
    else{
        todoEmpty.classList.add('hidden');
        todoList.innerHTML=todoItems.map(i=>renderDatedTaskRow(i,false)).join('');
    }
    // 渲染已完成
    const doneList=document.getElementById('ddDoneList');
    const doneEmpty=document.getElementById('ddDoneEmpty');
    if(!doneItems.length){ doneList.innerHTML=''; doneEmpty.classList.remove('hidden'); }
    else{
        doneEmpty.classList.add('hidden');
        doneItems.sort((a,b)=>(b.completedAt||0)-(a.completedAt||0));
        doneList.innerHTML=doneItems.map(i=>renderDatedTaskRow(i,true)).join('');
    }
}
function renderDatedTaskRow(i, done){
    const toggle=i.kind==='global'
        ? `toggleGlobalTask('${i.taskId}')`
        : `toggleTask('${i.subjectId}','daily','${i.taskId}')`;
    const edit=`openEditTaskModal('${i.kind}','${i.subjectId||''}','daily','${i.taskId}')`;
    const del=i.kind==='global'
        ? `deleteGlobalTask('${i.taskId}')`
        : `deleteTask('${i.subjectId}','daily','${i.taskId}')`;
    const badge=i.isPeriodic?'<span class="text-[9px] text-indigo-400 bg-indigo-50 px-1 rounded mr-1">周期</span>':'';
    const matched=(i.matched&&i.matched.length)?`<span class="text-[9px] text-emerald-500 bg-emerald-50 px-1 rounded mr-1">+${i.matched.length}子模块</span>`:'';
    return `<div class="task-item ${done?'task-completed':''} flex items-center gap-2 p-2 bg-slate-50 hover:bg-slate-100 rounded-lg">
        <input type="checkbox" ${done?'checked':''} onchange="${toggle}" class="w-4 h-4 rounded border-slate-300 text-primary-500 focus:ring-primary-400 cursor-pointer flex-shrink-0">
        <span class="task-text flex-1 text-xs break-all">${escapeHtml(i.text)}</span>${matched}${badge}
        <span class="text-[10px] text-slate-400 bg-white px-1.5 py-0.5 rounded border border-slate-200 flex-shrink-0">${escapeHtml(i.subjectName)}</span>
        <button onclick="${edit}" class="text-slate-400 hover:text-primary-600 text-xs flex-shrink-0" title="编辑">✎</button>
        <button onclick="${del}" class="text-slate-400 hover:text-red-500 text-xs flex-shrink-0" title="删除">✕</button>
    </div>`;
}

/* ---------- 工具函数（注：escapeHtml/showToast 已前置定义在 script 块最开头，带 try/catch，防空白优先） ---------- */
let toastTimer=null;
/* 旧版 escapeHtml/showToast 已移至 script 开头（1113-1122行），避免初始化异常时工具函数未定义导致错误提示无法显示
function escapeHtml(s){
    return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function showToast(msg){
    const el=document.getElementById('toast');
    el.textContent=msg||'';
    el.classList.remove('hidden');
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>el.classList.add('hidden'),2200);
}
*/
function formatHours(minutes){
    const m=Math.max(0,Number(minutes)||0);
    const h=Math.floor(m/60), r=m%60;
    if(h===0) return `${r}m`;
    if(r===0) return `${h}h`;
    return `${h}h${r}m`;
}
function dayTotalMinutes(dateStr){
    const ds=dateStr||todayStr();
    let total=Number((state.records[ds]&&state.records[ds].studyMinutes)||0);
    state.sessions.forEach(s=>{ if(s.date===ds) total+=Number(s.minutes)||0; });
    return total;
}

/* ---------- 确认弹窗 ---------- */
function openConfirmModal(text, onOk){
    document.getElementById('confirmText').textContent=text||'确定执行吗？';
    document.getElementById('confirmOkBtn').onclick=()=>{ closeConfirmModal(); if(onOk) onOk(); };
    document.getElementById('confirmModal').classList.remove('hidden');
}
function closeConfirmModal(){ document.getElementById('confirmModal').classList.add('hidden'); }

/* ---------- 日常任务操作 ---------- */
function addDatedGlobalTask(){
    const input=document.getElementById('ddTaskInput');
    const sel=document.getElementById('ddSubjectSelect');
    const text=(input.value||'').trim();
    if(!text){ showToast('请输入任务内容'); return; }
    const subjectId=(sel&&sel.value)||'';
    const ds=state.dailyDetailDate||todayStr();
    const task={ id:genId(), text, completed:false, date:ds, matchedSubModuleIds:[], subjectId:subjectId||undefined };
    tryMatchSubModules(task, false);
    state.globalDailyTasks.push(task);
    saveData();
    input.value='';
    renderDailyDetail();
    showToast('任务已添加');
}
function addGlobalTaskText(text){
    const ds=todayStr();
    const task={ id:genId(), text, completed:false, date:ds, matchedSubModuleIds:[] };
    tryMatchSubModules(task, false);
    state.globalDailyTasks.push(task);
    saveData();
}
function tryMatchSubModules(task, applyProgress=true){
    const ids=[];
    const txt=(task.text||'').toLowerCase();
    state.subjects.forEach(sub=>{
        (sub.subModules||[]).forEach(m=>{
            if(!m.keywords) return;
            const kws=String(m.keywords).split(/[,，、\s]+/).filter(Boolean);
            let increment=1;
            const matchedKeyword=kws.find(k=>txt.includes(k.toLowerCase()));
            if(matchedKeyword){
                const keywordEnd=txt.indexOf(matchedKeyword.toLowerCase())+matchedKeyword.length;
                const afterKeyword=txt.slice(keywordEnd);
                const numberMatch=afterKeyword.match(/^(?:\s|[\u4e00-\u9fffA-Za-z])*?(\d+)/);
                if(numberMatch) increment=Math.max(1,parseInt(numberMatch[1],10));
                ids.push(m.id);
                if(applyProgress) m.current=(Number(m.current)||0)+increment;
            }
        });
    });
    if(ids.length) task.matchedSubModuleIds=ids;
}
function toggleGlobalTask(id){
    const t=state.globalDailyTasks.find(x=>x.id===id);
    if(!t) return;
    t.completed=!t.completed;
    t.completedAt=t.completed?Date.now():null;
    // 学科任务命中子模块时按任务文本中的数量增加（仅手动任务）
    if(t.completed && !t._subAdded){
        tryMatchSubModules(t);
        t._subAdded=true;
    }
    saveData(); renderDailyDetail(); renderHome();
    checkDailyCheckin(t.date||todayStr());
}
function deleteGlobalTask(id){
    openConfirmModal('确定删除该任务？',()=>{
        state.globalDailyTasks=state.globalDailyTasks.filter(t=>t.id!==id);
        saveData(); renderDailyDetail(); renderHome(); showToast('已删除');
    });
}
// 将虚拟任务（切换到其他日期时预览的周期任务）实体化到实际存储中
// 返回实体化后的真实任务id；若id不是虚拟格式，直接原样返回
function materializeVirtualTaskIfNeeded(subjectId, dateStr, taskIdOrVirtual){
    const sub=state.subjects.find(s=>s.id===subjectId);
    if(!sub) return taskIdOrVirtual;
    if(!taskIdOrVirtual || typeof taskIdOrVirtual!=='string' || !taskIdOrVirtual.startsWith('v_')) return taskIdOrVirtual;
    // 格式：v_{templateUid}_{YYYY-MM-DD}，其中日期段以'-'分隔不含'_'，templateUid内部有'_'
    const rest=taskIdOrVirtual.slice(2); // 去掉前缀 'v_'
    const lastUS=rest.lastIndexOf('_');
    if(lastUS<0) return taskIdOrVirtual;
    const templateUid=rest.slice(0, lastUS);
    const ds=rest.slice(lastUS+1);
    // 检查是否已经实体化（竞态防护）
    const exists=(sub.dailyTasks||[]).find(t=> t.templateId===templateUid && t.generatedDate===ds);
    if(exists) return exists.id;
    // 查找匹配模板获取content
    let content='周期任务';
    const checkTpl=function(tpl){ if(tpl && scheduleMatchesDate(tpl, ds)) content=tpl.content||content; };
    (state.mainLines||[]).forEach(ml=>{(ml.weeklyTasks||[]).forEach(tpl=>{ if('wt_ml_'+ml.id+'_'+tpl.id===templateUid) checkTpl(tpl); });});
    (state.sideLines||[]).forEach(sl=>{(sl.weeklyTasks||[]).forEach(tpl=>{ if('wt_sl_'+sl.id+'_'+tpl.id===templateUid) checkTpl(tpl); });});
    (state.periodicTemplates||[]).forEach(tpl=>{ if('pt_'+tpl.id===templateUid) checkTpl(tpl); });
    (sub.dailyTaskTemplates||[]).forEach(tpl=>{ if('sdt_'+sub.id+'_'+tpl.id===templateUid) checkTpl(tpl); });
    const newTask={ id:genId(), text:content, completed:false, templateId:templateUid, generatedDate:ds };
    if(!Array.isArray(sub.dailyTasks)) sub.dailyTasks=[];
    sub.dailyTasks.push(newTask);
    saveData();
    return newTask.id;
}
function toggleTask(subjectId, listType, taskId){
    const sub=state.subjects.find(s=>s.id===subjectId);
    if(!sub) return;
    // 虚拟任务 → 先实体化
    let actualId=taskId;
    if(listType==='daily' && typeof taskId==='string' && taskId.startsWith('v_')){
        const ds=taskId.split('_').pop();
        actualId=materializeVirtualTaskIfNeeded(subjectId, ds, taskId);
    }
    const list=sub[listType==='daily'?'dailyTasks':'longTasks'];
    const t=list.find(x=>x.id===actualId);
    if(!t) return;
    t.completed=!t.completed;
    t.completedAt=t.completed?Date.now():null;
    if(t.completed && !t._subAdded){
        tryMatchSubModules(t);
        t._subAdded=true;
    }
    saveData(); renderAll();
    checkDailyCheckin(t.generatedDate||todayStr());
}
function deleteTask(subjectId, listType, taskId){
    openConfirmModal('确定删除该任务？',()=>{
        const sub=state.subjects.find(s=>s.id===subjectId);
        if(!sub) return;
        const key=listType==='daily'?'dailyTasks':'longTasks';
        // 虚拟任务：没有实际存储，删除等同于跳过（仅刷新UI）
        if(typeof taskId==='string' && taskId.startsWith('v_')){
            renderAll(); showToast('已删除');
            return;
        }
        sub[key]=sub[key].filter(t=>t.id!==taskId);
        saveData(); renderAll(); showToast('已删除');
    });
}
function clearDatedDone(){
    const ds=state.dailyDetailDate;
    openConfirmModal('清空当天已完成任务？',()=>{
        state.globalDailyTasks=state.globalDailyTasks.filter(t=>!(t.date===ds&&t.completed));
        state.subjects.forEach(sub=>{
            sub.dailyTasks=sub.dailyTasks.filter(t=>{
                if(t.generatedDate && t.generatedDate!==ds) return true;
                if(!t.generatedDate && ds!==todayStr()) return true;
                return !t.completed;
            });
        });
        saveData(); renderDailyDetail(); renderHome(); showToast('已清空');
    });
}
// 打卡检查
function checkDailyCheckin(dateStr){
    const ds=dateStr||todayStr();
    const counts=datedTaskCounts(ds);
    const mins=dayTotalMinutes(ds);
    if(!state.records[ds]) state.records[ds]={ studyMinutes:0, checkedIn:false, completionRate:0 };
    const rec=state.records[ds];
    rec.completionRate=counts.total?Math.round(counts.done/counts.total*100):0;
    rec.studyMinutes=mins;
    if(mins>=15 || counts.total>0 && rec.completionRate>=80){
        rec.checkedIn=true;
    }
    saveData();
}

/* ---------- 任务编辑 ---------- */
let taskEditor=null;
function openEditTaskModal(kind, subjectId, listType, taskId){
    // 虚拟任务：先实体化再编辑，保证编辑的是实际存储中的任务
    let actualId=taskId;
    if(kind!=='global' && listType==='daily' && typeof taskId==='string' && taskId.startsWith('v_')){
        const ds=taskId.slice(taskId.lastIndexOf('_')+1);
        actualId=materializeVirtualTaskIfNeeded(subjectId, ds, taskId);
    }
    taskEditor={ kind, subjectId, listType, taskId:actualId };
    let text='';
    if(kind==='global'){
        const t=state.globalDailyTasks.find(x=>x.id===actualId);
        if(t) text=t.text;
    }else{
        const sub=state.subjects.find(s=>s.id===subjectId);
        if(sub){
            const list=sub[listType==='daily'?'dailyTasks':'longTasks'];
            const t=list.find(x=>x.id===actualId);
            if(t) text=t.text;
        }
    }
    document.getElementById('editTaskInput').value=text;
    document.getElementById('editTaskModal').classList.remove('hidden');
}
function closeEditTaskModal(){ document.getElementById('editTaskModal').classList.add('hidden'); taskEditor=null; }
function saveEditedTask(){
    if(!taskEditor) return closeEditTaskModal();
    const text=(document.getElementById('editTaskInput').value||'').trim();
    if(!text){ showToast('任务内容不能为空'); return; }
    if(taskEditor.kind==='global'){
        const t=state.globalDailyTasks.find(x=>x.id===taskEditor.taskId);
        if(t) t.text=text;
    }else{
        const sub=state.subjects.find(s=>s.id===taskEditor.subjectId);
        if(sub){
            const list=sub[taskEditor.listType==='daily'?'dailyTasks':'longTasks'];
            const t=list.find(x=>x.id===taskEditor.taskId);
            if(t) t.text=text;
        }
    }
    saveData(); closeEditTaskModal(); renderAll(); showToast('已保存');
}

/* ---------- 计划体系 ---------- */
function switchPlanningTab(tab){
    state.planningTab=tab;
    saveData();
    ['main','side'].forEach(t=>{
        const pane=document.getElementById('planningPane-'+t);
        const btn=document.getElementById('planningTab'+(t==='main'?'Main':'Side'));
        if(t===tab){ pane.classList.remove('hidden'); btn.classList.add('planning-tab-active'); }
        else{ pane.classList.add('hidden'); btn.classList.remove('planning-tab-active'); }
    });
    renderPlanning();
}
function renderPlanning(){
    // 更新学科选择到相关modal
    const wtSel=document.getElementById('wtSubjectInput');
    if(wtSel) wtSel.innerHTML='<option value="">无</option>'+state.subjects.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    const psSel=document.getElementById('periodicSubjectInput');
    if(psSel) psSel.innerHTML='<option value="">无</option>'+state.subjects.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    if(state.planningTab==='main') renderPlanningMainTab();
    else renderPlanningSideTab();
}
function renderPlanningMainTab(){
    const list=document.getElementById('mainLineList');
    const empty=document.getElementById('mainLineEmpty');
    if(!state.mainLines.length){ list.innerHTML=''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    list.innerHTML=state.mainLines.map(ml=>{
        const pct=mainLinePercent(ml);
        const chapters=ml.chapters||[];
        const wts=ml.weeklyTasks||[];
        return `<div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
            <div class="flex items-start justify-between mb-3">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <h4 class="text-sm font-semibold text-slate-800 truncate">${escapeHtml(ml.name)}</h4>
                        <span class="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-1.5 rounded">${pct}%</span>
                    </div>
                    ${ml.description?`<p class="text-[11px] text-slate-500 mb-1 line-clamp-2">${escapeHtml(ml.description)}</p>`:''}
                    ${ml.deadline?`<p class="text-[10px] text-slate-400">📅 ${ml.deadline}</p>`:''}
                </div>
                <div class="flex gap-1 flex-shrink-0 ml-2">
                    <button onclick="openEditMainLineModal('${ml.id}')" class="text-slate-400 hover:text-primary-600 text-xs px-1.5 py-0.5">编辑</button>
                    <button onclick="deleteMainLine('${ml.id}')" class="text-slate-400 hover:text-red-500 text-xs px-1.5 py-0.5">删除</button>
                </div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-2 mb-3 overflow-hidden"><div class="progress-bar-fill bg-gradient-to-r from-indigo-400 to-indigo-600 h-full rounded-full" style="width:${pct}%"></div></div>
            <!-- 章节列表（v7：openChapterModal 传入第3个参数 lineType='main'） -->
            <div class="mb-3">
                <div class="flex items-center justify-between mb-1.5">
                    <h5 class="text-xs font-medium text-slate-600">📖 章节 (${chapters.length})</h5>
                    <button onclick="openChapterModal('${ml.id}',null,'main')" class="text-[10px] text-indigo-600 hover:text-indigo-700">+ 新增</button>
                </div>
                ${chapters.length?`<div class="space-y-1">${chapters.map(c=>`
                    <div class="flex items-center gap-2 bg-slate-50 rounded-lg p-2 text-xs">
                        <div class="flex-1 min-w-0 flex items-center gap-2">
                            <span class="task-text truncate ${c.percent>=100?'text-slate-400 line-through':''}">${escapeHtml(c.title)}</span>
                        </div>
                        <span class="text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded flex-shrink-0">${c.percent||0}%</span>
                        <button onclick="openChapterModal('${ml.id}','${c.id}','main')" class="text-slate-400 hover:text-primary-600 flex-shrink-0">✎</button>
                    </div>
                `).join('')}</div>`:`<div class="text-[11px] text-slate-300 text-center py-2">暂无章节</div>`}
            </div>
            <!-- 周常任务（v7：openWeeklyTaskModal 传入第3个参数 lineType='main'） -->
            <div>
                <div class="flex items-center justify-between mb-1.5">
                    <h5 class="text-xs font-medium text-slate-600">🔁 周常任务 (${wts.length})</h5>
                    <button onclick="openWeeklyTaskModal('${ml.id}',null,'main')" class="text-[10px] text-indigo-600 hover:text-indigo-700">+ 新增</button>
                </div>
                ${wts.length?`<div class="space-y-1">${wts.map(w=>{
                    const sub=state.subjects.find(s=>s.id===w.subjectId);
                    const daysDesc=describeSchedule(w);
                    return `<div class="flex items-center gap-2 bg-slate-50 rounded-lg p-2 text-xs">
                        <span class="task-text flex-1 min-w-0 truncate">${escapeHtml(w.content)}</span>
                        <span class="text-[10px] text-slate-400 bg-white px-1.5 py-0.5 rounded border border-slate-200 flex-shrink-0">${escapeHtml(daysDesc)}</span>
                        <span class="text-[10px] text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded flex-shrink-0">每周${Math.max(1,Number(w.weeklyTargetCount)||1)}次</span>
                        ${sub?`<span class="text-[10px] text-primary-600 bg-primary-50 px-1.5 py-0.5 rounded flex-shrink-0">${escapeHtml(sub.name)}</span>`:''}
                        <button onclick="openWeeklyTaskModal('${ml.id}','${w.id}','main')" class="text-slate-400 hover:text-primary-600 flex-shrink-0">✎</button>
                    </div>`;
                }).join('')}</div>`:`<div class="text-[11px] text-slate-300 text-center py-2">暂无周常</div>`}
            </div>
        </div>`;
    }).join('');
}
// v7 重写：支线渲染逻辑与主线一致，数据源为 state.sideLines，主色 teal-emerald 系
function renderPlanningSideTab(){
    const list=document.getElementById('sideLineList');
    const empty=document.getElementById('sideLineEmpty');
    if(!state.sideLines.length){ list.innerHTML=''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    list.innerHTML=state.sideLines.map(sl=>{
        const pct=sideLinePercent(sl);
        const chapters=sl.chapters||[];
        const wts=sl.weeklyTasks||[];
        return `<div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
            <div class="flex items-start justify-between mb-3">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <h4 class="text-sm font-semibold text-slate-800 truncate">${escapeHtml(sl.name)}</h4>
                        <span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-1.5 rounded">${pct}%</span>
                    </div>
                    ${sl.description?`<p class="text-[11px] text-slate-500 mb-1 line-clamp-2">${escapeHtml(sl.description)}</p>`:''}
                    ${sl.deadline?`<p class="text-[10px] text-slate-400">📅 ${sl.deadline}</p>`:''}
                </div>
                <div class="flex gap-1 flex-shrink-0 ml-2">
                    <button onclick="openEditSideLineModal('${sl.id}')" class="text-slate-400 hover:text-emerald-600 text-xs px-1.5 py-0.5">编辑</button>
                    <button onclick="deleteSideLine('${sl.id}')" class="text-slate-400 hover:text-red-500 text-xs px-1.5 py-0.5">删除</button>
                </div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-2 mb-3 overflow-hidden"><div class="progress-bar-fill bg-gradient-to-r from-teal-400 to-emerald-500 h-full rounded-full" style="width:${pct}%"></div></div>
            <!-- 章节列表（teal-emerald 配色） -->
            <div class="mb-3">
                <div class="flex items-center justify-between mb-1.5">
                    <h5 class="text-xs font-medium text-slate-600">📖 章节 (${chapters.length})</h5>
                    <button onclick="openChapterModal('${sl.id}',null,'side')" class="text-[10px] text-emerald-600 hover:text-emerald-700">+ 新增</button>
                </div>
                ${chapters.length?`<div class="space-y-1">${chapters.map(c=>`
                    <div class="flex items-center gap-2 bg-slate-50 rounded-lg p-2 text-xs">
                        <div class="flex-1 min-w-0 flex items-center gap-2">
                            <span class="task-text truncate ${c.percent>=100?'text-slate-400 line-through':''}">${escapeHtml(c.title)}</span>
                        </div>
                        <span class="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded flex-shrink-0">${c.percent||0}%</span>
                        <button onclick="openChapterModal('${sl.id}','${c.id}','side')" class="text-slate-400 hover:text-emerald-600 flex-shrink-0">✎</button>
                    </div>
                `).join('')}</div>`:`<div class="text-[11px] text-slate-300 text-center py-2">暂无章节</div>`}
            </div>
            <!-- 周常任务（teal-emerald 配色） -->
            <div>
                <div class="flex items-center justify-between mb-1.5">
                    <h5 class="text-xs font-medium text-slate-600">🔁 周常任务 (${wts.length})</h5>
                    <button onclick="openWeeklyTaskModal('${sl.id}',null,'side')" class="text-[10px] text-emerald-600 hover:text-emerald-700">+ 新增</button>
                </div>
                ${wts.length?`<div class="space-y-1">${wts.map(w=>{
                    const sub=state.subjects.find(s=>s.id===w.subjectId);
                    const daysDesc=describeSchedule(w);
                    return `<div class="flex items-center gap-2 bg-slate-50 rounded-lg p-2 text-xs">
                        <span class="task-text flex-1 min-w-0 truncate">${escapeHtml(w.content)}</span>
                        <span class="text-[10px] text-slate-400 bg-white px-1.5 py-0.5 rounded border border-slate-200 flex-shrink-0">${escapeHtml(daysDesc)}</span>
                        <span class="text-[10px] text-emerald-500 bg-emerald-50 px-1.5 py-0.5 rounded flex-shrink-0">每周${Math.max(1,Number(w.weeklyTargetCount)||1)}次</span>
                        ${sub?`<span class="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded flex-shrink-0">${escapeHtml(sub.name)}</span>`:''}
                        <button onclick="openWeeklyTaskModal('${sl.id}','${w.id}','side')" class="text-slate-400 hover:text-emerald-600 flex-shrink-0">✎</button>
                    </div>`;
                }).join('')}</div>`:`<div class="text-[11px] text-slate-300 text-center py-2">暂无周常</div>`}
            </div>
        </div>`;
    }).join('');
}
function togglePeriodicEnabled(id){
    const t=state.periodicTemplates.find(x=>x.id===id);
    if(t){ t.enabled=!t.enabled; saveData(); renderPlanning(); }
}

/* ---------- 主线任务 ---------- */
function openAddMainLineModal(){
    editingMainLineId=null;
    document.getElementById('mlPanelTitle').textContent='新建主线任务';
    document.getElementById('mlNameInput').value='';
    document.getElementById('mlDescInput').value='';
    document.getElementById('mlDeadlineInput').value='';
    document.getElementById('mainLinePanel').classList.add('panel-open');
    document.getElementById('mainLineOverlay').classList.remove('hidden');
}
function openEditMainLineModal(id){
    const ml=state.mainLines.find(x=>x.id===id);
    if(!ml) return;
    editingMainLineId=id;
    document.getElementById('mlPanelTitle').textContent='编辑主线任务';
    document.getElementById('mlNameInput').value=ml.name||'';
    document.getElementById('mlDescInput').value=ml.description||'';
    document.getElementById('mlDeadlineInput').value=ml.deadline||'';
    document.getElementById('mainLinePanel').classList.add('panel-open');
    document.getElementById('mainLineOverlay').classList.remove('hidden');
}
function closeMainLinePanel(){
    document.getElementById('mainLinePanel').classList.remove('panel-open');
    document.getElementById('mainLineOverlay').classList.add('hidden');
    editingMainLineId=null;
}
function saveMainLine(){
    const name=(document.getElementById('mlNameInput').value||'').trim();
    if(!name){ showToast('请输入主线任务名称'); return; }
    const description=(document.getElementById('mlDescInput').value||'').trim();
    const deadline=(document.getElementById('mlDeadlineInput').value||'');
    if(editingMainLineId){
        const ml=state.mainLines.find(x=>x.id===editingMainLineId);
        if(ml){ ml.name=name; ml.description=description; ml.deadline=deadline; }
    }else{
        state.mainLines.push({ id:genId(), name, description, deadline, createdAt:Date.now(), chapters:[], weeklyTasks:[] });
    }
    saveData(); closeMainLinePanel(); renderPlanning(); renderHome(); showToast('已保存');
}
function deleteMainLine(id){
    openConfirmModal('确定删除该主线及其所有章节/周常？',()=>{
        state.mainLines=state.mainLines.filter(x=>x.id!==id);
        saveData(); renderPlanning(); renderHome(); showToast('已删除');
    });
}

/* ---------- v7 新增：支线管理 ---------- */
function openAddSideLineModal(){
    editingSideLineId=null;
    document.getElementById('slPanelTitle').textContent='新建支线任务';
    document.getElementById('slNameInput').value='';
    document.getElementById('slDescInput').value='';
    document.getElementById('slDeadlineInput').value='';
    document.getElementById('sideLinePanel').classList.add('panel-open');
    document.getElementById('sideLineOverlay').classList.remove('hidden');
}
function openEditSideLineModal(id){
    const sl=state.sideLines.find(x=>x.id===id);
    if(!sl) return;
    editingSideLineId=id;
    document.getElementById('slPanelTitle').textContent='编辑支线任务';
    document.getElementById('slNameInput').value=sl.name||'';
    document.getElementById('slDescInput').value=sl.description||'';
    document.getElementById('slDeadlineInput').value=sl.deadline||'';
    document.getElementById('sideLinePanel').classList.add('panel-open');
    document.getElementById('sideLineOverlay').classList.remove('hidden');
}
function closeSideLinePanel(){
    document.getElementById('sideLinePanel').classList.remove('panel-open');
    document.getElementById('sideLineOverlay').classList.add('hidden');
    editingSideLineId=null;
}
function saveSideLine(){
    const name=(document.getElementById('slNameInput').value||'').trim();
    if(!name){ showToast('请输入支线任务名称'); return; }
    const description=(document.getElementById('slDescInput').value||'').trim();
    const deadline=(document.getElementById('slDeadlineInput').value||'');
    if(editingSideLineId){
        const sl=state.sideLines.find(x=>x.id===editingSideLineId);
        if(sl){ sl.name=name; sl.description=description; sl.deadline=deadline; }
    }else{
        state.sideLines.push({ id:genId(), name, description, deadline, createdAt:Date.now(), chapters:[], weeklyTasks:[] });
    }
    saveData(); closeSideLinePanel(); renderPlanning(); renderHome(); showToast('已保存');
}
function deleteSideLine(id){
    openConfirmModal('确定删除该支线及其所有章节/周常？',()=>{
        state.sideLines=state.sideLines.filter(x=>x.id!==id);
        saveData(); renderPlanning(); renderHome(); showToast('已删除');
    });
}

/* ---------- 章节管理（v7 修改：同时支持主线 main / 支线 side） ---------- */
let editingChapterId=null;
// v7：第3个参数 lineType='main'|'side'
function openChapterModal(lineId, chapterId, lineType){
    lineType=lineType||'main';
    document.getElementById('chapterMainLineId').value=lineId;
    document.getElementById('chapterLineType').value=lineType;  // 保存到隐藏字段
    editingChapterLineType=lineType;
    editingChapterId=chapterId||null;
    // 保存按钮颜色区分
    const saveBtn=document.getElementById('chapterSaveBtn');
    if(saveBtn){
        if(lineType==='side'){ saveBtn.className='px-4 py-2 text-sm bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg'; }
        else{ saveBtn.className='px-4 py-2 text-sm bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg'; }
    }
    // 根据 lineType 获取对应 line 对象
    const lineArr=lineType==='side'?state.sideLines:state.mainLines;
    const line=lineArr.find(x=>x.id===lineId);
    if(chapterId && line){
        const c=line.chapters.find(x=>x.id===chapterId);
        if(c){
            document.getElementById('chapterModalTitle').textContent='编辑章节';
            document.getElementById('chapterTitleInput').value=c.title;
            document.getElementById('chapterPercentInput').value=c.percent||0;
            document.getElementById('chapterDeleteBtn').classList.remove('hidden');
            document.getElementById('chapterEditId').value=chapterId;
        }
    }else{
        document.getElementById('chapterModalTitle').textContent='新增章节';
        document.getElementById('chapterTitleInput').value='';
        document.getElementById('chapterPercentInput').value=0;
        document.getElementById('chapterDeleteBtn').classList.add('hidden');
        document.getElementById('chapterEditId').value='';
    }
    document.getElementById('chapterModal').classList.remove('hidden');
}
function closeChapterModal(){ document.getElementById('chapterModal').classList.add('hidden'); editingChapterId=null; }
function saveChapter(){
    const lineId=document.getElementById('chapterMainLineId').value;
    const lineType=document.getElementById('chapterLineType').value||'main';
    const lineArr=lineType==='side'?state.sideLines:state.mainLines;
    const line=lineArr.find(x=>x.id===lineId);
    if(!line){ closeChapterModal(); return; }
    const title=(document.getElementById('chapterTitleInput').value||'').trim();
    if(!title){ showToast('请输入章节标题'); return; }
    const percent=Math.max(0,Math.min(100,Number(document.getElementById('chapterPercentInput').value)||0));
    if(editingChapterId){
        const c=line.chapters.find(x=>x.id===editingChapterId);
        if(c){ c.title=title; c.percent=percent; }
    }else{
        line.chapters.push({ id:genId(), title, percent, createdAt:Date.now() });
    }
    saveData(); closeChapterModal(); renderPlanning(); renderHome(); showToast('已保存');
}
function deleteChapter(){
    const lineId=document.getElementById('chapterMainLineId').value;
    const lineType=document.getElementById('chapterLineType').value||'main';
    const lineArr=lineType==='side'?state.sideLines:state.mainLines;
    const line=lineArr.find(x=>x.id===lineId);
    if(!line || !editingChapterId){ closeChapterModal(); return; }
    openConfirmModal('确定删除该章节？',()=>{
        line.chapters=line.chapters.filter(c=>c.id!==editingChapterId);
        saveData(); closeChapterModal(); renderPlanning(); renderHome(); showToast('已删除');
    });
}

/* ---------- 周常任务（v7 修改：同时支持主线 main / 支线 side；v8 升级：三种scheduleMode+记忆曲线时长） ---------- */
let editingWtId=null;
// v7：第3个参数 lineType='main'|'side'
function openWeeklyTaskModal(lineId, wtId, lineType){
    lineType=lineType||'main';
    document.getElementById('wtMainLineId').value=lineId;
    document.getElementById('wtLineType').value=lineType;  // 保存到隐藏字段
    editingWtLineType=lineType;
    editingWtId=wtId||null;
    // 保存按钮颜色区分
    const saveBtn=document.getElementById('wtSaveBtn');
    if(saveBtn){
        if(lineType==='side'){ saveBtn.className='px-4 py-2 text-sm bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg'; }
        else{ saveBtn.className='px-4 py-2 text-sm bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg'; }
    }
    // 初始化星期多选框样式绑定
    const bindWeeklyLabels=function(wrapId, checkedDays){
        const wrap=document.getElementById(wrapId);
        if(!wrap) return;
        wrap.querySelectorAll('label').forEach(lab=>{
            const cb=lab.querySelector('input');
            lab.onclick=(e)=>{
                e.preventDefault();
                cb.checked=!cb.checked;
                lab.style.background=cb.checked?'rgba(14,165,233,.1)':'';
                lab.style.borderColor=cb.checked?'#0ea5e9':'#e2e8f0';
                lab.style.color=cb.checked?'#0369a1':'';
            };
            const val=Number(cb.value);
            const on=(checkedDays||[]).includes(val);
            cb.checked=on;
            lab.style.background=on?'rgba(14,165,233,.1)':'';
            lab.style.borderColor=on?'#0ea5e9':'#e2e8f0';
            lab.style.color=on?'#0369a1':'';
        });
    };
    // 学科下拉填充
    const subSel=document.getElementById('wtSubjectInput');
    if(subSel && !subSel.options.length){
        state.subjects.forEach(s=>{ const opt=document.createElement('option'); opt.value=s.id; opt.textContent=s.name; subSel.appendChild(opt); });
    }
    const lineArr=lineType==='side'?state.sideLines:state.mainLines;
    const line=lineArr.find(x=>x.id===lineId);
    const today=todayStr();
    if(wtId && line){
        const w=line.weeklyTasks.find(x=>x.id===wtId);
        if(w){
            document.getElementById('wtModalTitle').textContent='编辑周常任务';
            document.getElementById('wtContentInput').value=w.content||'';
            document.getElementById('wtWeeklyTargetInput').value=Math.max(1,Number(w.weeklyTargetCount)||1);
            document.getElementById('wtSubjectInput').value=w.subjectId||'';
            document.getElementById('wtTypeInput').value=w.scheduleMode||w.scheduleType||'daily';
            document.getElementById('wtDeleteBtn').classList.remove('hidden');
            document.getElementById('wtEditId').value=wtId;
            bindWeeklyLabels('wtWeeklyDays', w.weekdays||[]);
            document.getElementById('wtMemoryMonths').value=String(w.memoryDurationMonths||12);
            document.getElementById('wtMemoryStartDate').value=w.memoryStartDate||today;
            onWtScheduleChange();
        }
    }else{
        document.getElementById('wtModalTitle').textContent='新增周常任务';
        document.getElementById('wtContentInput').value='';
        document.getElementById('wtWeeklyTargetInput').value='1';
        if(subSel && state.subjects.length) subSel.value=state.subjects[0].id;
        document.getElementById('wtTypeInput').value='daily';
        document.getElementById('wtDeleteBtn').classList.add('hidden');
        document.getElementById('wtEditId').value='';
        bindWeeklyLabels('wtWeeklyDays', []);
        document.getElementById('wtMemoryMonths').value='12';
        document.getElementById('wtMemoryStartDate').value=today;
        onWtScheduleChange();
    }
    document.getElementById('weeklyTaskModal').classList.remove('hidden');
}
function closeWeeklyTaskModal(){ document.getElementById('weeklyTaskModal').classList.add('hidden'); editingWtId=null; }
function onWtScheduleChange(){
    const mode=document.getElementById('wtTypeInput').value;
    document.getElementById('wtWeeklyDaysWrap').classList.toggle('hidden', mode!=='weekly');
    document.getElementById('wtMemoryWrap').classList.toggle('hidden', mode!=='memory');
    // 若刚切到memory模式但日期为空，默认今天
    if(mode==='memory' && !document.getElementById('wtMemoryStartDate').value){
        document.getElementById('wtMemoryStartDate').value=todayStr();
    }
}
// 兼容旧函数名（之前调用的onWtTypeChange，现在都走onWtScheduleChange）
function onWtTypeChange(){ return onWtScheduleChange(); }
function saveWeeklyTask(){
    const lineId=document.getElementById('wtMainLineId').value;
    const lineType=document.getElementById('wtLineType').value||'main';
    const lineArr=lineType==='side'?state.sideLines:state.mainLines;
    const line=lineArr.find(x=>x.id===lineId);
    if(!line){ closeWeeklyTaskModal(); return; }
    const content=(document.getElementById('wtContentInput').value||'').trim();
    if(!content){ showToast('请输入任务内容'); return; }
    const subjectId=document.getElementById('wtSubjectInput').value||'';
    const scheduleMode=document.getElementById('wtTypeInput').value;
    const weekdays=[];
    if(scheduleMode==='weekly'){
        document.querySelectorAll('#wtWeeklyDays input:checked').forEach(cb=>weekdays.push(Number(cb.value)));
        if(!weekdays.length){ showToast('请选择星期'); return; }
    }
    const memoryDurationMonths=scheduleMode==='memory' ? Math.max(1, Number(document.getElementById('wtMemoryMonths').value)||12) : 12;
    const memoryStartDate=scheduleMode==='memory' ? (document.getElementById('wtMemoryStartDate').value || todayStr()) : todayStr();
    const weeklyTargetCount=Math.max(1,parseInt(document.getElementById('wtWeeklyTargetInput').value,10)||1);
    if(editingWtId){
        const w=line.weeklyTasks.find(x=>x.id===editingWtId);
        if(w){
            w.content=content; w.subjectId=subjectId;
            w.scheduleMode=scheduleMode; delete w.scheduleType; // v8 统一 scheduleMode
            w.weekdays=weekdays;
            w.memoryDurationMonths=memoryDurationMonths;
            w.memoryStartDate=memoryStartDate;
            w.weeklyTargetCount=weeklyTargetCount;
            w.enabled=true;
        }
    }else{
        line.weeklyTasks.push({
            id:genId(), content, subjectId,
            scheduleMode, weekdays,
            memoryDurationMonths, memoryStartDate,
            weeklyTargetCount,
            enabled:true
        });
    }
    saveData(); closeWeeklyTaskModal(); renderPlanning(); showToast('已保存');
}
function deleteWeeklyTask(){
    const lineId=document.getElementById('wtMainLineId').value;
    const lineType=document.getElementById('wtLineType').value||'main';
    const lineArr=lineType==='side'?state.sideLines:state.mainLines;
    const line=lineArr.find(x=>x.id===lineId);
    if(!line || !editingWtId){ closeWeeklyTaskModal(); return; }
    openConfirmModal('确定删除该周常任务？',()=>{
        line.weeklyTasks=line.weeklyTasks.filter(w=>w.id!==editingWtId);
        saveData(); closeWeeklyTaskModal(); renderPlanning(); showToast('已删除');
    });
}

/* ---------- 支线：长期计划 ---------- */
function openAddLongPlanModal(planId){
    editingLongPlanId=planId||null;
    if(planId){
        const p=state.longTermPlans.find(x=>x.id===planId);
        if(p){
            document.getElementById('longPlanModalTitle').textContent='编辑长期计划';
            document.getElementById('longPlanTextInput').value=p.text;
            document.getElementById('longPlanPercentInput').value=p.percent||0;
        }
    }else{
        document.getElementById('longPlanModalTitle').textContent='新增长期计划';
        document.getElementById('longPlanTextInput').value='';
        document.getElementById('longPlanPercentInput').value=0;
    }
    document.getElementById('longPlanModal').classList.remove('hidden');
}
function closeLongPlanModal(){ document.getElementById('longPlanModal').classList.add('hidden'); editingLongPlanId=null; }
function saveLongPlan(){
    const text=(document.getElementById('longPlanTextInput').value||'').trim();
    if(!text){ showToast('请输入计划内容'); return; }
    const percent=Math.max(0,Math.min(100,Number(document.getElementById('longPlanPercentInput').value)||0));
    if(editingLongPlanId){
        const p=state.longTermPlans.find(x=>x.id===editingLongPlanId);
        if(p){ p.text=text; p.percent=percent; }
    }else{
        state.longTermPlans.push({ id:genId(), text, percent });
    }
    saveData(); closeLongPlanModal(); renderPlanning(); renderHome(); showToast('已保存');
}
function deleteLongPlan(id){
    openConfirmModal('确定删除该长期计划？',()=>{
        state.longTermPlans=state.longTermPlans.filter(p=>p.id!==id);
        saveData(); renderPlanning(); showToast('已删除');
    });
}

/* ---------- 支线：中期任务 ---------- */
function openAddMidTaskModal(){
    document.getElementById('midTaskTitleInput').value='';
    document.getElementById('midTaskDeadlineInput').value='';
    document.getElementById('addMidTaskModal').classList.remove('hidden');
}
function closeAddMidTaskModal(){ document.getElementById('addMidTaskModal').classList.add('hidden'); }
function addMidTask(){
    const title=(document.getElementById('midTaskTitleInput').value||'').trim();
    if(!title){ showToast('请输入任务标题'); return; }
    const deadline=(document.getElementById('midTaskDeadlineInput').value||'');
    state.midTasks.push({ id:genId(), title, deadline, visible:true, subGoals:[] });
    saveData(); closeAddMidTaskModal(); renderPlanning(); showToast('已添加');
}
function openEditMidTaskModal(id){
    const mt=state.midTasks.find(x=>x.id===id);
    if(!mt) return;
    editingMidTaskId=id;
    document.getElementById('editMidTaskTitle').value=mt.title||'';
    document.getElementById('editMidTaskDeadline').value=mt.deadline||'';
    document.getElementById('editMidTaskVisible').checked=!!mt.visible;
    document.getElementById('editMidTaskModal').classList.remove('hidden');
}
function closeEditMidTaskModal(){ document.getElementById('editMidTaskModal').classList.add('hidden'); editingMidTaskId=null; }
function saveEditMidTask(){
    const mt=state.midTasks.find(x=>x.id===editingMidTaskId);
    if(!mt) return closeEditMidTaskModal();
    const title=(document.getElementById('editMidTaskTitle').value||'').trim();
    if(!title){ showToast('请输入任务标题'); return; }
    mt.title=title;
    mt.deadline=document.getElementById('editMidTaskDeadline').value||'';
    mt.visible=document.getElementById('editMidTaskVisible').checked;
    saveData(); closeEditMidTaskModal(); renderPlanning(); showToast('已保存');
}
function deleteMidTask(id){
    openConfirmModal('确定删除该中期任务？',()=>{
        state.midTasks=state.midTasks.filter(x=>x.id!==id);
        saveData(); renderPlanning(); showToast('已删除');
    });
}

/* ---------- 支线：周期模板 ---------- */
function openAddPeriodicModal(tplId){
    editingPeriodicId=tplId||null;
    const wrap=document.getElementById('weeklyDays');
    wrap.querySelectorAll('label').forEach(lab=>{
        const cb=lab.querySelector('input');
        lab.onclick=(e)=>{
            if(e.target!==cb) cb.checked=!cb.checked;
            lab.style.background=cb.checked?'rgba(14,165,233,.1)':'';
            lab.style.borderColor=cb.checked?'#0ea5e9':'#e2e8f0';
            lab.style.color=cb.checked?'#0369a1':'';
        };
        cb.checked=false;
        lab.style.background=''; lab.style.borderColor='#e2e8f0'; lab.style.color='';
    });
    if(tplId){
        const t=state.periodicTemplates.find(x=>x.id===tplId);
        if(t){
            document.getElementById('periodicModalTitle').textContent='编辑周期模板';
            document.getElementById('periodicContentInput').value=t.content;
            document.getElementById('periodicSubjectInput').value=t.subjectId||'';
            document.getElementById('periodicTypeInput').value=t.scheduleType||'daily';
            document.getElementById('periodicSaveBtn').textContent='保存';
            if(t.scheduleType==='weekly'){
                (t.weekdays||[]).forEach(d=>{
                    const cb=wrap.querySelector(`input[value="${d}"]`);
                    if(cb){
                        cb.checked=true;
                        const lab=cb.parentElement;
                        lab.style.background='rgba(14,165,233,.1)';
                        lab.style.borderColor='#0ea5e9';
                        lab.style.color='#0369a1';
                    }
                });
            }
            onPeriodicTypeChange();
        }
    }else{
        document.getElementById('periodicModalTitle').textContent='新增周期模板';
        document.getElementById('periodicContentInput').value='';
        document.getElementById('periodicSubjectInput').value='';
        document.getElementById('periodicTypeInput').value='daily';
        document.getElementById('periodicSaveBtn').textContent='保存';
        onPeriodicTypeChange();
    }
    document.getElementById('periodicModal').classList.remove('hidden');
}
function closePeriodicModal(){ document.getElementById('periodicModal').classList.add('hidden'); editingPeriodicId=null; }
function onPeriodicTypeChange(){
    const type=document.getElementById('periodicTypeInput').value;
    document.getElementById('weeklyDaysWrap').classList.toggle('hidden',type!=='weekly');
}
function savePeriodic(){
    const content=(document.getElementById('periodicContentInput').value||'').trim();
    if(!content){ showToast('请输入任务内容'); return; }
    const subjectId=document.getElementById('periodicSubjectInput').value||'';
    const scheduleType=document.getElementById('periodicTypeInput').value;
    const weekdays=[];
    if(scheduleType==='weekly'){
        document.querySelectorAll('#weeklyDays input:checked').forEach(cb=>weekdays.push(Number(cb.value)));
        if(!weekdays.length){ showToast('请选择星期'); return; }
    }
    if(editingPeriodicId){
        const t=state.periodicTemplates.find(x=>x.id===editingPeriodicId);
        if(t){ t.content=content; t.subjectId=subjectId; t.scheduleType=scheduleType; t.weekdays=weekdays; }
    }else{
        state.periodicTemplates.push({ id:genId(), content, subjectId, scheduleType, weekdays, enabled:true, sideOnly:true });
    }
    saveData(); closePeriodicModal(); renderPlanning(); showToast('已保存');
}
function deletePeriodic(id){
    openConfirmModal('确定删除该周期模板？',()=>{
        state.periodicTemplates=state.periodicTemplates.filter(x=>x.id!==id);
        saveData(); renderPlanning(); showToast('已删除');
    });
}

/* ---------- 计时系统：核心 ---------- */
function initTimerState(){
    if(!state.timerState){
        state.timerState={ subjectId:(state.subjects[0]&&state.subjects[0].id)||'', subjectGroup:'', sessionStartedAt:null, accumulatedSeconds:0, segmentStartedAt:null, running:false };
    }
    if(state.timerState.subjectGroup && !state.subjects.some(s=>s.group===state.timerState.subjectGroup)) state.timerState.subjectGroup='';
    // 自动选第一个有分类的学科
    if(!state.timerState.subjectGroup && (!state.timerState.subjectId || !state.subjects.find(s=>s.id===state.timerState.subjectId))){
        if(state.subjects[0]) state.timerState.subjectId=state.subjects[0].id;
    }
    const ts=state.timerState;
    // 恢复累计时间：如果运行中且有 segmentStartedAt
    if(ts.running && ts.segmentStartedAt){
        const now=Date.now();
        const add=Math.floor((now-ts.segmentStartedAt)/1000);
        if(add>0) ts.accumulatedSeconds+=add;
        ts.segmentStartedAt=now;
    }
    // 更新选择框
    ['timerSubject','timerSubjectBottom'].forEach(id=>{
        const subjSel=document.getElementById(id);
        if(subjSel){
            subjSel.innerHTML=timerSubjectOptions();
            subjSel.value=getTimerTargetValue(ts);
        }
    });
    onTimerSubjectChange();
    updateTimerCurrentLabel();
    updateTimerDisplay();
    updateTimerButtons();
}
function getCurrentWeeklyPlans(){
    const now=new Date();
    const date=formatDate(now);
    const minute=now.getHours()*60+now.getMinutes();
    return (state.weeklyPlans||[]).filter(plan=>{
        if(plan.date!==date) return false;
        const start=Number(plan.startMin), end=Number(plan.endMin);
        if(!Number.isFinite(start)||!Number.isFinite(end)) return false;
        const normalizedEnd=end<=start?end+1440:end;
        return minute>=start&&minute<normalizedEnd;
    });
}
function inferTimerSubjectFromWeeklyPlan(){
    const plans=getCurrentWeeklyPlans();
    const matches=[];
    const addMatch=(type,id,name)=>{
        const key=type+':'+id;
        if(name&&!matches.some(item=>item.key===key)) matches.push({type,id,name,key});
    };
    plans.forEach(plan=>{
        const content=String(plan.content||'').toLocaleLowerCase();
        (state.subjects||[]).forEach(subject=>{
            if(subject.name&&content.includes(String(subject.name).toLocaleLowerCase())) addMatch('subject',subject.id,subject.name);
            if(subject.group&&content.includes(String(subject.group).toLocaleLowerCase())) addMatch('group',subject.group,subject.group);
        });
    });
    return matches.sort((a,b)=>String(b.name).length-String(a.name).length);
}
function timerSubjectOptions(){
    const subjects=state.subjects||[];
    const groups=[...new Set(subjects.map(subject=>(subject.group||'').trim()).filter(Boolean))];
    return '<option value="">未选择</option>'+
        subjects.map(subject=>`<option value="${subject.id}">${escapeHtml(subject.name)}</option>`).join('')+
        groups.map(group=>`<option value="group:${encodeURIComponent(group)}">${escapeHtml(group)}（科目汇总）</option>`).join('');
}
function getTimerTargetValue(timerState){
    if(timerState?.subjectGroup) return 'group:'+encodeURIComponent(timerState.subjectGroup);
    return timerState?.subjectId||'';
}
function setTimerTargetValue(value){
    if(!state.timerState) return;
    if(String(value||'').startsWith('group:')){
        state.timerState.subjectGroup=decodeURIComponent(String(value).slice(6));
        state.timerState.subjectId='';
    }else{
        state.timerState.subjectGroup='';
        state.timerState.subjectId=value||'';
    }
}
function setTimerSubject(subjectId){
    if(!state.timerState) return;
    setTimerTargetValue(subjectId);
    ['timerSubject','timerSubjectBottom','timerSubjectModalSelect'].forEach(id=>{
        const select=document.getElementById(id);
        if(select) select.value=getTimerTargetValue(state.timerState);
    });
    updateTimerCurrentLabel();
    saveData();
}
function openTimerSubjectModal(subjects=state.subjects, message){
    const modal=document.getElementById('timerSubjectModal');
    const select=document.getElementById('timerSubjectModalSelect');
    if(!modal||!select) return;
    const messageEl=document.getElementById('timerSubjectModalMessage');
    if(messageEl) messageEl.textContent=message||'当前时间没有匹配到包含科目名称的周视图计划，请选择本次计时所属科目。';
    const groups=[...new Set((subjects||[]).map(subject=>(subject.group||'').trim()).filter(Boolean))];
    select.innerHTML='<option value="">请选择科目</option>'+(subjects||[]).map(subject=>`<option value="${subject.id}">${escapeHtml(subject.name)}</option>`).join('')+groups.map(group=>`<option value="group:${encodeURIComponent(group)}">${escapeHtml(group)}（科目汇总）</option>`).join('');
    select.value=getTimerTargetValue(state.timerState);
    modal.classList.remove('hidden');
    setTimeout(()=>select.focus(),0);
}
function closeTimerSubjectModal(){ document.getElementById('timerSubjectModal')?.classList.add('hidden'); }
function confirmTimerSubjectSelection(){
    const targetValue=document.getElementById('timerSubjectModalSelect')?.value||'';
    if(!targetValue){ showToast('请选择科目'); return; }
    setTimerSubject(targetValue);
    closeTimerSubjectModal();
    startTimerCore();
}
function startTimer(){
    const ts=state.timerState;
    if(!ts||ts.running) return;
    const inferredSubjects=inferTimerSubjectFromWeeklyPlan();
    if(inferredSubjects.length===1){
        setTimerSubject(inferredSubjects[0].type==='group'?'group:'+encodeURIComponent(inferredSubjects[0].id):inferredSubjects[0].id);
        startTimerCore();
        showToast(`已按周计划开始${inferredSubjects[0].name}计时`);
        return;
    }
    if(inferredSubjects.length>1){
        openTimerSubjectModal(inferredSubjects,'当前周计划匹配到多个科目，请选择本次计时所属科目。');
    }else{
        openTimerSubjectModal(state.subjects);
    }
}
function startTimerCore(){
    const ts=state.timerState;
    if(!ts||(!ts.subjectId&&!ts.subjectGroup)){ showToast('请先选择科目'); return; }
    if(ts.running) return;
    ts.running=true;
    ts.segmentStartedAt=Date.now();
    if(!ts.sessionStartedAt) ts.sessionStartedAt=ts.segmentStartedAt;
    saveData();
    updateTimerButtons();
    startTimerInterval();
}
function pauseTimer(){
    const ts=state.timerState;
    if(!ts.running) return;
    const now=Date.now();
    if(ts.segmentStartedAt){
        ts.accumulatedSeconds+=Math.floor((now-ts.segmentStartedAt)/1000);
    }
    ts.running=false;
    ts.segmentStartedAt=null;
    saveData();
    stopTimerInterval();
    updateTimerButtons();
    updateTimerDisplay();
}
function stopTimer(){
    const ts=state.timerState;
    const now=Date.now();
    if(ts.running && ts.segmentStartedAt){
        ts.accumulatedSeconds+=Math.floor((now-ts.segmentStartedAt)/1000);
    }
    const seconds=ts.accumulatedSeconds;
    const minutes=Math.round(seconds/60);
    // 只有超过1分钟才记录
    if(minutes>=1 && (ts.subjectId||ts.subjectGroup)){
        const startTs=ts.sessionStartedAt||(now-seconds*1000);
        state.sessions.push({
            id:genId(), date:formatDate(new Date(startTs)),
            subjectId:ts.subjectId||'', subjectGroup:ts.subjectGroup||'', classificationId:defaultClassificationId(),
            startTs, endTs:now, minutes, manual:false
        });
        // 同步 records 中的 studyMinutes
        const ds=formatDate(new Date(startTs));
        if(!state.records[ds]) state.records[ds]={ studyMinutes:0, checkedIn:false, completionRate:0 };
        checkDailyCheckin(ds);
    }
    // 重置
    ts.sessionStartedAt=null;
    ts.accumulatedSeconds=0;
    ts.segmentStartedAt=null;
    ts.running=false;
    saveData();
    stopTimerInterval();
    updateTimerDisplay();
    updateTimerButtons();
    renderTimer(); renderSubjectTimeStats(); renderSessionList(); renderHome(); renderPersonalPanel();
    if(minutes>=1) showToast(`本次学习 ${formatHours(minutes)}，已记录`);
    else showToast('已停止计时');
}
function tickTimer(){
    const ts=state.timerState;
    if(ts.running && ts.segmentStartedAt){
        const now=Date.now();
        const add=Math.floor((now-ts.segmentStartedAt)/1000);
        if(add>0){
            ts.accumulatedSeconds+=add;
            ts.segmentStartedAt=now;
            saveData();
        }
    }
    updateTimerDisplay();
}
let timerIntervalId=null;
function startTimerInterval(){
    if(timerIntervalId) return;
    timerIntervalId=setInterval(tickTimer,1000);
}
function stopTimerInterval(){
    if(timerIntervalId){ clearInterval(timerIntervalId); timerIntervalId=null; }
}
function updateTimerDisplay(){
    const ts=state.timerState||{accumulatedSeconds:0};
    let s=ts.accumulatedSeconds||0;
    if(ts.running && ts.segmentStartedAt){
        s+=Math.floor((Date.now()-ts.segmentStartedAt)/1000);
    }
    const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
    const text=`${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
    const td=document.getElementById('timerDisplay');
    const htd=document.getElementById('homeTimerDisplay');
    const ftd=document.getElementById('floatTimerDisplay');
    if(td) td.textContent=text;
    if(htd) htd.textContent=text;
    if(ftd) ftd.textContent=text;
    // 标题显示
    if(state.timerFullscreen || document.getElementById('timerStage')?.classList.contains('timer-focus')){
        document.title=`${text} · 学习中`;
    }
}
function updateTimerButtons(){
    const running=state.timerState&&state.timerState.running;
    const hasAcc=(state.timerState&&state.timerState.accumulatedSeconds>0)||running;
    ['Start','Pause','Stop'].forEach(k=>{
        const btn=document.getElementById('timer'+k+'Btn');
        const floatBtn=document.getElementById('float'+k+'Btn');
        if(k==='Start'){ if(btn) btn.disabled=running; if(floatBtn) floatBtn.disabled=running; }
        else{ if(btn) btn.disabled=!running && !(k==='Stop'&&hasAcc); if(floatBtn) floatBtn.disabled=!running && !(k==='Stop'&&hasAcc); }
    });
    const st=document.getElementById('timerStatus');
    if(st){
        if(running) st.textContent='⏱ 计时中...';
        else if(hasAcc) st.textContent='⏸ 已暂停';
        else st.textContent='未开始';
    }
}

/* ---------- 计时：专注模式 + 配置面板 ---------- */
function enterTimerFocus(){
    const stage=document.getElementById('timerStage');
    if(stage) stage.classList.add('timer-focus');
    document.getElementById('enterFocusBtn').classList.add('hidden');
    document.getElementById('exitFocusBtn').classList.remove('hidden');
    resetIdleTimer();
}
function exitTimerFocus(){
    const stage=document.getElementById('timerStage');
    if(stage) stage.classList.remove('timer-focus');
    document.getElementById('enterFocusBtn').classList.remove('hidden');
    document.getElementById('exitFocusBtn').classList.add('hidden');
    clearIdleTimer();
    document.title='学习进度管理系统';
}
function toggleTimerConfigPanel(){
    const p=document.getElementById('timerConfigPanel');
    p.classList.toggle('panel-open');
}
function closeTimerConfigPanel(){
    document.getElementById('timerConfigPanel').classList.remove('panel-open');
}

/* ---------- 计时：全屏极简 ---------- */
function enterTimerFullscreen(){
    const stage=document.getElementById('timerStage');
    if(!stage) return;
    stage.classList.add('timer-fullscreen');
    timerFullscreenActive=true;
    document.body.style.overflow='hidden';
}
function exitTimerFullscreen(){
    const stage=document.getElementById('timerStage');
    if(stage) stage.classList.remove('timer-fullscreen');
    timerFullscreenActive=false;
    document.body.style.overflow='';
    document.title='学习进度管理系统';
}
function resetIdleTimer(){
    clearIdleTimer();
    idleTimer=setTimeout(()=>{
        if(state.timerState && state.timerState.running && !timerFullscreenActive){
            enterTimerFullscreen();
        }
    }, 60000);
}
function clearIdleTimer(){
    if(idleTimer){ clearTimeout(idleTimer); idleTimer=null; }
}

/* ---------- 计时：悬浮窗 ---------- */
function createTimerFloatingWindow(){
    // 悬浮窗 HTML 已存在，仅确保显示状态同步
    updateTimerDisplay();
}
function toggleTimerFloatWindow(){
    const fw=document.getElementById('timerFloatWindow');
    fw.classList.toggle('hidden');
    if(!fw.classList.contains('hidden')){
        fw.classList.remove('timer-float-minimized');
        updateTimerDisplay();
    }
}
function closeTimerFloatWindow(){
    document.getElementById('timerFloatWindow').classList.add('hidden');
}
function minimizeTimerFloat(){
    document.getElementById('timerFloatWindow').classList.toggle('timer-float-minimized');
}

/* ---------- v9b：全局自定义分类管理（替换学科子分类timerCategories） ---------- */
function openClassificationManage(){
    renderClassificationList();
    document.getElementById('clsModalNewName').value='';
    document.getElementById('clsModalNewColor').value=nextCategoryColor();
    document.getElementById('classificationModal').classList.remove('hidden');
}
function renderClassificationList(){
    const list=document.getElementById('classificationList');
    if(!state.classifications.length){ list.innerHTML='<div class="text-xs text-slate-300 text-center py-2">暂无分类</div>'; return; }
    list.innerHTML=state.classifications.map(c=>`
        <div class="flex items-center gap-2 bg-slate-50 rounded-lg p-2">
            <input type="color" value="${c.color||CATEGORY_PALETTE[0]}" onchange="recolorClassification('${c.id}', this.value)" class="w-7 h-7 rounded border border-slate-200 cursor-pointer bg-white flex-shrink-0" title="分类颜色">
            <input class="input-focus flex-1 px-2 py-1 text-xs border border-slate-200 rounded bg-white" value="${escapeHtml(c.name)}" onchange="renameClassification('${c.id}', this.value)">
            <button onclick="deleteClassification('${c.id}')" class="text-slate-400 hover:text-red-500 text-xs flex-shrink-0">删除</button>
        </div>
    `).join('');
}
function renameClassification(cid, val){
    const c=(state.classifications||[]).find(x=>x.id===cid);
    if(c && val.trim()){ c.name=val.trim(); saveData(); fillAllClassificationSelects(); }
}
function recolorClassification(cid, color){
    const c=(state.classifications||[]).find(x=>x.id===cid);
    if(c){ c.color=color; saveData(); renderWeekReview(); }
}
function deleteClassification(cid){
    if((state.classifications||[]).length<=1){ showToast('至少保留一个分类'); return; }
    openConfirmModal('确定删除该分类？（历史记录会使用默认分类）',()=>{
        state.classifications=(state.classifications||[]).filter(x=>x.id!==cid);
        // 若该分类是默认或空的，把引用转到第一个
        const fallback=defaultClassificationId();
        (state.weeklyPlans||[]).forEach(p=>{ if(!p.classificationId||p.classificationId===cid) p.classificationId=fallback; });
        (state.sessions||[]).forEach(s=>{ if(!s.classificationId||s.classificationId===cid) s.classificationId=fallback; });
        saveData();
        renderClassificationList(); fillAllClassificationSelects();
        renderWeekReview();
    });
}
function closeClassificationModal(){ document.getElementById('classificationModal').classList.add('hidden'); }
function addClassificationFromModal(){
    const nameInput=document.getElementById('clsModalNewName');
    const colorInput=document.getElementById('clsModalNewColor');
    const name=(nameInput.value||'').trim();
    if(!name){ showToast('请输入分类名'); return; }
    state.classifications.push({ id:genId(), name, color:(colorInput&&colorInput.value)||nextCategoryColor() });
    saveData(); nameInput.value='';
    renderClassificationList(); fillAllClassificationSelects();
}
/* 填充所有用到全局分类下拉的 select */
function fillAllClassificationSelects(){
    const opts=(state.classifications||[]).map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    const sel1=document.getElementById('weeklyPlanClassificationSelect'); if(sel1){ const cur=sel1.value; sel1.innerHTML=opts; if(cur) sel1.value=cur; }
    const sel2=document.getElementById('sessionCategoryFilter'); if(sel2){ const cur=sel2.value; sel2.innerHTML='<option value="">全部分类</option>'+opts; if(cur) sel2.value=cur; }
    renderWeekReview();
}

/* ---------- 计时：补录与修改 ---------- */
function initManualRecordForm(){
    const d=document.getElementById('manualRecordDate');
    if(d&&!d.value) d.value=todayStr();
    const s=document.getElementById('manualRecordSubject');
    if(s){
        s.innerHTML='<option value="">未选择</option>'+state.subjects.map(sub=>`<option value="${sub.id}">${escapeHtml(sub.name)}</option>`).join('');
        if(state.subjects[0]) s.value=state.subjects[0].id;
    }
}
function addManualTimeRecord(){
    const date=document.getElementById('manualRecordDate').value;
    const minutesInput=document.getElementById('manualRecordMinutes').value;
    const startInput=document.getElementById('manualRecordStart').value;
    const endInput=document.getElementById('manualRecordEnd').value;
    const subjectId=document.getElementById('manualRecordSubject').value;
    if(!date){ showToast('请选择日期'); return; }
    if(!subjectId){ showToast('请选择学科'); return; }
    let minutes=0;
    let startTs=null, endTs=null;
    if(minutesInput && Number(minutesInput)>0){
        minutes=Number(minutesInput);
        const base=new Date(date+'T12:00:00').getTime();
        startTs=base; endTs=base+minutes*60*1000;
    }else if(startInput && endInput){
        const s=new Date(date+'T'+startInput).getTime();
        const e=new Date(date+'T'+endInput).getTime();
        if(e<=s){ showToast('结束时间需大于开始时间'); return; }
        minutes=Math.round((e-s)/60000);
        startTs=s; endTs=e;
    }else{
        showToast('请输入时长或起止时间'); return;
    }
    if(minutes<=0){ showToast('时长必须大于0'); return; }
    state.sessions.push({
        id:genId(), date, subjectId, classificationId:defaultClassificationId(),
        startTs:startTs||Date.now(), endTs:endTs||Date.now(), minutes, manual:true
    });
    if(!state.records[date]) state.records[date]={ studyMinutes:0, checkedIn:false, completionRate:0 };
    checkDailyCheckin(date);
    saveData();
    // 清空
    document.getElementById('manualRecordMinutes').value='';
    document.getElementById('manualRecordStart').value='';
    document.getElementById('manualRecordEnd').value='';
    renderTimer(); renderSubjectTimeStats(); renderSessionList(); renderHome(); renderPersonalPanel();
    showToast(`已补录 ${formatHours(minutes)}`);
}
let editingSessionId=null;
function openEditSessionModal(sid){
    const s=state.sessions.find(x=>x.id===sid);
    if(!s) return;
    editingSessionId=sid;
    document.getElementById('esSessionId').value=sid;
    document.getElementById('esDate').value=s.date;
    document.getElementById('esMinutes').value=s.minutes;
    const dt=s.startTs?new Date(s.startTs):null;
    document.getElementById('esStartTime').value=dt?`${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`:'';
    const dt2=s.endTs?new Date(s.endTs):null;
    document.getElementById('esEndTime').value=dt2?`${pad2(dt2.getHours())}:${pad2(dt2.getMinutes())}`:'';
    const subSel=document.getElementById('esSubject');
    subSel.innerHTML='<option value="">未选择</option>'+state.subjects.map(sub=>`<option value="${sub.id}">${escapeHtml(sub.name)}</option>`).join('');
    subSel.value=s.subjectId||'';
    document.getElementById('editSessionModal').classList.remove('hidden');
}
function closeEditSessionModal(){ document.getElementById('editSessionModal').classList.add('hidden'); editingSessionId=null; }
function saveEditedSession(){
    const s=state.sessions.find(x=>x.id===editingSessionId);
    if(!s) return closeEditSessionModal();
    const date=document.getElementById('esDate').value;
    const minutes=Math.max(1,Number(document.getElementById('esMinutes').value)||0);
    const subjectId=document.getElementById('esSubject').value;
    const startTime=document.getElementById('esStartTime').value;
    const endTime=document.getElementById('esEndTime').value;
    if(!date||!subjectId||!minutes){ showToast('请填写完整信息'); return; }
    s.date=date; s.minutes=minutes; s.subjectId=subjectId;
    if(!s.classificationId) s.classificationId=defaultClassificationId();
    if(startTime) s.startTs=new Date(date+'T'+startTime).getTime();
    if(endTime) s.endTs=new Date(date+'T'+endTime).getTime();
    saveData(); closeEditSessionModal();
    renderTimer(); renderSubjectTimeStats(); renderSessionList(); renderHome(); renderPersonalPanel(); renderWeekReview();
    showToast('已保存修改');
}
function deleteSession(){
    if(!editingSessionId) return;
    openConfirmModal('确定删除该计时记录？',()=>{
        state.sessions=state.sessions.filter(s=>s.id!==editingSessionId);
        saveData(); closeEditSessionModal();
        renderTimer(); renderSubjectTimeStats(); renderSessionList(); renderHome(); renderPersonalPanel();
        showToast('已删除');
    });
}

/* ---------- 计时：统计渲染 ---------- */
function renderTimer(){
    initTimerState();
    updateTimerCurrentLabel();
    // 更新过滤器
    const sf=document.getElementById('sessionSubjectFilter');
    const cf=document.getElementById('sessionCategoryFilter');
    const curSubj=sf?sf.value:'';
    const curCat=cf?cf.value:'';
    if(sf){ sf.innerHTML='<option value="">全部学科</option>'+state.subjects.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join(''); sf.value=curSubj; }
    fillAllClassificationSelects();
    if(cf) cf.value=curCat;
}
function updateTimerCurrentLabel(){
    const ts=state.timerState;
    if(!ts) return;
    const sub=state.subjects.find(s=>s.id===ts.subjectId);
    const targetName=ts.subjectGroup||sub?.name||'未选择科目';
    const label=document.getElementById('timerCurrentSubject');
    if(label) label.textContent=targetName;
    ['timerSubject','timerSubjectBottom'].forEach(id=>{
        const select=document.getElementById(id);
        if(select) select.value=getTimerTargetValue(ts);
    });
}
function onTimerSubjectChange(sourceId='timerSubject'){
    const ts=state.timerState;
    if(!ts) return;
    const sel=document.getElementById(sourceId);
    if(sel) setTimerTargetValue(sel.value);
    ['timerSubject','timerSubjectBottom'].forEach(id=>{
        const other=document.getElementById(id);
        if(other && other!==sel) other.value=getTimerTargetValue(ts);
    });
    saveData();
}
function renderSubjectTimeStats(){
    const wrap=document.getElementById('subjectTimeStats');
    const empty=document.getElementById('subjectTimeEmpty');
    if(!state.sessions.length){ wrap.innerHTML=''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    const totals={};
    state.sessions.forEach(s=>{
        const key=s.subjectGroup?'group:'+s.subjectGroup:'subject:'+s.subjectId;
        if(!totals[key]) totals[key]=0;
        totals[key]+=Number(s.minutes)||0;
    });
    const entries=state.subjects.map(sub=>({ name:sub.name, mins:totals['subject:'+sub.id]||0 }));
    [...new Set(state.subjects.map(sub=>(sub.group||'').trim()).filter(Boolean))].forEach(group=>{
        entries.push({name:group+'（科目汇总）', mins:totals['group:'+group]||0});
    });
    const total=entries.reduce((a,b)=>a+b.mins,0);
    entries.sort((a,b)=>b.mins-a.mins);
    wrap.innerHTML=entries.map(e=>{
        const pct=total?Math.round(e.mins/total*100):0;
        return `<div class="bg-slate-50 rounded-lg p-2.5">
            <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-medium text-slate-700">${escapeHtml(e.name)}</span>
                <span class="text-xs font-bold text-primary-600">${formatHours(e.mins)} · ${pct}%</span>
            </div>
            <div class="w-full bg-white rounded-full h-2 overflow-hidden"><div class="progress-bar-fill bg-gradient-to-r from-primary-400 to-primary-600 h-full rounded-full" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
    if(total===0){ wrap.innerHTML=''; empty.classList.remove('hidden'); }
}
function renderSessionList(){
    const list=document.getElementById('sessionList');
    const empty=document.getElementById('sessionEmpty');
    const subFilter=document.getElementById('sessionSubjectFilter')?.value||'';
    const catFilter=document.getElementById('sessionCategoryFilter')?.value||'';
    let arr=[...state.sessions];
    if(subFilter) arr=arr.filter(s=>s.subjectId===subFilter);
    if(catFilter) arr=arr.filter(s=>s.classificationId===catFilter);
    arr.sort((a,b)=>(b.startTs||0)-(a.startTs||0));
    if(!arr.length){ list.innerHTML=''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    list.innerHTML=arr.slice(0,200).map(s=>{
        const sub=state.subjects.find(x=>x.id===s.subjectId);
        const sessionName=s.subjectGroup?s.subjectGroup+'（科目汇总）':(sub?sub.name:'未知');
        const cls=(state.classifications||[]).find(x=>x.id===s.classificationId);
        const start=new Date(s.startTs||0);
        const end=new Date(s.endTs||0);
        const timeTxt=(s.startTs&&s.endTs)?` ${pad2(start.getHours())}:${pad2(start.getMinutes())}-${pad2(end.getHours())}:${pad2(end.getMinutes())}`:'';
        const badge=s.manual?'<span class="text-[9px] text-amber-600 bg-amber-50 px-1 rounded ml-1">补录</span>':'';
        const clsChip=cls?`<span class="inline-flex items-center gap-1 ml-1 text-[9px] px-1.5 py-0.5 rounded-full" style="background:${hexToRgba(cls.color,.12)};color:${cls.color};">${escapeHtml(cls.name)}</span>`:'';
        return `<div class="flex items-center gap-2 p-2 bg-slate-50 hover:bg-slate-100 rounded-lg text-xs">
            <span class="text-slate-400 w-20 flex-shrink-0">${s.date}${timeTxt}</span>
            <span class="flex-1 min-w-0 truncate">${escapeHtml(sessionName)}${clsChip}</span>
            <span class="font-bold text-primary-600 flex-shrink-0">${formatHours(s.minutes)}</span>${badge}
            <button onclick="openEditSessionModal('${s.id}')" class="text-slate-400 hover:text-primary-600 flex-shrink-0">修改</button>
        </div>`;
    }).join('');
}

/* ---------- 学科管理 ---------- */
function subjectRenderCards(){
    const cards=document.getElementById('subjectCards');
    const empty=document.getElementById('subjectEmpty');
    if(!state.subjects.length){ cards.innerHTML=''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    const grouped={};
    state.subjects.forEach(subject=>{
        const group=(subject.group||'').trim()||'未分组';
        (grouped[group] ||= []).push(subject);
    });
    const groupCards=Object.entries(grouped).filter(([group])=>group!=='未分组').map(([group, subjects])=>{
        const pct=subjectGroupPercent(subjects);
        return `<div class="subject-group-card col-span-full bg-gradient-to-r from-sky-50 to-indigo-50 rounded-2xl p-4 border border-sky-100">
            <div class="flex items-center justify-between gap-3">
                <div><div class="text-[10px] text-sky-500">课程汇总</div><h3 class="text-base font-bold text-slate-800">${escapeHtml(group)}</h3><div class="text-[11px] text-slate-500 mt-1">${subjects.map(s=>escapeHtml(s.name)).join('、')}</div></div>
                <div class="text-right"><div class="text-2xl font-bold text-primary-600">${pct}%</div><div class="text-[10px] text-slate-400">综合进度</div></div>
            </div>
            <div class="w-full bg-white/80 rounded-full h-2 mt-3 overflow-hidden"><div class="progress-bar-fill bg-gradient-to-r from-sky-400 to-indigo-500 h-full" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
    cards.innerHTML=groupCards+state.subjects.map(s=>{
        const pct=subjectPercent(s);
        const isExpanded=expandedSubjects.has(s.id);
        const dailyT=todayDailyTasks(s);
        const done=dailyT.filter(t=>t.completed).length;
        const listenPct=listenPercent(s);
        return `<div class="bg-white rounded-2xl p-4 shadow-sm card-hover border border-slate-100">
            <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-2 flex-1 min-w-0" ondblclick="renameSubjectDirect('${s.id}')">
                    <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 text-white flex items-center justify-center text-sm font-bold flex-shrink-0">${escapeHtml(s.name.charAt(0)||'?')}</div>
                    <div class="min-w-0 flex-1">
                        <h4 class="text-sm font-semibold text-slate-800 truncate">${escapeHtml(s.name)}</h4>
                        <div class="flex items-center gap-2 mt-0.5">
                            ${s.group?`<span class="text-[10px] text-sky-600 bg-sky-50 px-1.5 py-0.5 rounded">${escapeHtml(s.group)}</span>`:''}
                            <span class="text-[10px] text-slate-400">权重 ${s.weight}</span>
                            <span class="text-[10px] font-bold text-primary-600">${pct}%</span>
                        </div>
                    </div>
                </div>
                <div class="flex gap-0.5 flex-shrink-0 ml-2">
                    <button onclick="toggleSubjectExpand('${s.id}')" class="text-slate-400 hover:text-slate-600 text-xs px-1.5 py-0.5">${isExpanded?'收起 ▲':'展开 ▼'}</button>
                    <button onclick="renameSubjectStart('${s.id}')" class="text-slate-400 hover:text-primary-600 text-xs px-1.5 py-0.5">重命名</button>
                    <button onclick="deleteSubject('${s.id}')" class="text-slate-400 hover:text-red-500 text-xs px-1.5 py-0.5">删除</button>
                </div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-2 mb-3 overflow-hidden"><div class="progress-bar-fill bg-gradient-to-r from-primary-400 to-primary-600 h-full rounded-full" style="width:${pct}%"></div></div>
            <div class="grid grid-cols-2 gap-2 text-[10px] mb-3">
                <div class="bg-slate-50 rounded-lg p-2"><div class="text-slate-400">今日任务</div><div class="text-sm font-bold text-slate-700">${done}/${dailyT.length}</div></div>
                <div class="bg-slate-50 rounded-lg p-2"><div class="text-slate-400">子模块</div><div class="text-sm font-bold text-slate-700">${(s.subModules||[]).length}</div></div>
            </div>
            <div class="task-section ${isExpanded?'expanded':''}">
                ${renderSubjectDetail(s)}
            </div>
        </div>`;
    }).join('');
}
function subjectToggleExpand(id){
    if(expandedSubjects.has(id)) expandedSubjects.delete(id);
    else expandedSubjects.add(id);
    renderSubjectCards();
}
function subjectRenderDetail(s){
    const dailyT=todayDailyTasks(s);
    const listenPct=listenPercent(s);
    return `<div class="space-y-3 pt-2 border-t border-slate-100 text-xs">
        <!-- 听课进度模式 -->
        <div class="bg-slate-50 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
                <h5 class="font-medium text-slate-700">🎧 听课进度</h5>
                <div class="flex gap-1">
                    <button onclick="toggleListenMode('${s.id}')" class="text-[10px] text-primary-600 hover:text-primary-700">${s.listenMode?'关闭':'开启'}模式</button>
                    ${s.listenMode?`<button onclick="listenSetTarget('${s.id}')" class="text-[10px] text-primary-600 hover:text-primary-700">设置</button>`:''}
                </div>
            </div>
            ${s.listenMode?`
                <div class="flex items-center gap-2 mb-1">
                    <div class="flex-1 min-w-0 bg-white rounded-full h-2 overflow-hidden"><div class="progress-bar-fill bg-emerald-400 h-full" style="width:${listenPct}%"></div></div>
                    <span class="font-semibold text-emerald-600 flex-shrink-0">${s.listenCompleted||0}/${s.listenTarget||0} · ${listenPct}%</span>
                </div>
                <div class="flex gap-1 mt-2">
                    <button onclick="listenAdd('${s.id}',-1)" class="flex-1 bg-white border border-slate-200 rounded py-1 hover:bg-slate-100">-1节</button>
                    <button onclick="listenAdd('${s.id}',1)" class="flex-1 bg-emerald-50 border border-emerald-200 text-emerald-600 rounded py-1 hover:bg-emerald-100">+1节</button>
                    <button onclick="listenAdd('${s.id}',10)" class="flex-1 bg-emerald-50 border border-emerald-200 text-emerald-600 rounded py-1 hover:bg-emerald-100">+10节</button>
                </div>
            `:`<div class="text-slate-400 text-[10px]">未开启，适合记录听课时数进度</div>`}
        </div>
        <!-- 子模块 -->
        <div class="bg-slate-50 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
                <h5 class="font-medium text-slate-700">🧩 子模块 (${(s.subModules||[]).length})</h5>
                <button onclick="openSubModuleModal('${s.id}')" class="text-[10px] text-indigo-600 hover:text-indigo-700">+ 新增</button>
            </div>
            ${(s.subModules||[]).length?`<div class="space-y-1.5">${s.subModules.map(m=>{
                const pct=subModulePercent(m);
                return `<div class="bg-white rounded-lg p-2">
                    <div class="flex items-center justify-between mb-1 gap-2">
                        <span class="font-medium truncate flex-1">${escapeHtml(m.name)}</span>
                        <span class="text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded flex-shrink-0">${pct}%</span>
                        <div class="flex gap-1 flex-shrink-0">
                            <button onclick="subModAdd('${s.id}','${m.id}',-1)" class="text-slate-400 text-[10px]">-</button>
                            <button onclick="subModAdd('${s.id}','${m.id}',1)" class="text-primary-600 text-[10px]">+</button>
                            <button onclick="openSubModuleModal('${s.id}','${m.id}')" class="text-slate-400 text-[10px]">✎</button>
                            <button onclick="deleteSubModule('${s.id}','${m.id}')" class="text-red-400 text-[10px]">✕</button>
                        </div>
                    </div>
                    <div class="w-full bg-slate-100 rounded-full h-1 overflow-hidden"><div class="progress-bar-fill bg-indigo-400 h-full" style="width:${pct}%"></div></div>
                    ${m.keywords?`<div class="text-[9px] text-slate-400 mt-1 truncate">关键词：${escapeHtml(m.keywords)}</div>`:''}
                </div>`;
            }).join('')}</div>`:`<div class="text-slate-400 text-[10px] text-center py-2">暂无子模块，点击「新增」创建可自动累加的子目标</div>`}
        </div>
        <!-- 学科每日任务（合并：周期模板 + 单次任务，单向同步到总览日常） -->
        <div class="bg-slate-50 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
                <h5 class="font-medium text-slate-700">📝 学科每日任务 (${dailyT.length})</h5>
                <button onclick="openSubDailyTplModal('${s.id}')" class="text-[10px] text-primary-600 hover:text-primary-700">+ 新增周期任务</button>
            </div>
            <!-- 周期任务模板（紧凑列表） -->
            ${(s.dailyTaskTemplates||[]).length?`<div class="mb-2 pb-2 border-b border-slate-200">
                <div class="text-[9px] text-slate-400 mb-1">周期任务模板（${(s.dailyTaskTemplates||[]).length}）</div>
                <div class="space-y-1">${s.dailyTaskTemplates.map(t=>{
                    const sd=describeSchedule(t);
                    return `<div class="flex items-center gap-1.5 bg-white rounded p-1.5">
                        <span class="task-text flex-1 min-w-0 truncate text-[11px]">${escapeHtml(t.content)}</span>
                        <span class="text-[9px] text-primary-600 bg-primary-50 px-1 rounded flex-shrink-0">${escapeHtml(sd)}</span>
                        <button onclick="openSubDailyTplModal('${s.id}','${t.id}')" class="text-slate-400 text-[10px] flex-shrink-0">✎</button>
                        <button onclick="deleteSubDailyTplDirect('${s.id}','${t.id}')" class="text-red-400 text-[10px] flex-shrink-0">✕</button>
                    </div>`;
                }).join('')}</div>
            </div>`:''}
            <!-- 单次任务快捷输入（支持设置日期） -->
            <div class="flex gap-1 mb-2 flex-wrap">
                <input id="subjTaskInput_${s.id}" type="text" placeholder="新增单次任务（Enter添加）" class="input-focus flex-1 min-w-[120px] px-2 py-1 text-xs border border-slate-200 rounded bg-white" onkeypress="if(event.key==='Enter') addSubjectDailyTask('${s.id}')">
                <input id="subjTaskDate_${s.id}" type="date" value="${todayStr()}" class="input-focus px-1.5 py-1 text-xs border border-slate-200 rounded bg-white" title="任务日期">
                <button onclick="addSubjectDailyTask('${s.id}')" class="bg-primary-500 hover:bg-primary-600 text-white text-xs px-2 rounded">+</button>
            </div>
            <!-- 今日任务列表（周期生成实例 + 手动单次任务） -->
            ${dailyT.length?`<div class="space-y-1">${dailyT.map(t=>`
                <div class="task-item ${t.completed?'task-completed':''} flex items-center gap-1.5 bg-white rounded p-1.5">
                    <input type="checkbox" ${t.completed?'checked':''} onchange="toggleTask('${s.id}','daily','${t.id}')" class="w-3.5 h-3.5">
                    <span class="task-text flex-1 text-[11px] break-all">${escapeHtml(t.text)}</span>
                    ${t.templateId?'<span class="text-[9px] text-indigo-400 bg-indigo-50 px-1 rounded flex-shrink-0">周期</span>':''}
                    <button onclick="openEditTaskModal('subject','${s.id}','daily','${t.id}')" class="text-slate-400 text-[10px] flex-shrink-0">✎</button>
                    <button onclick="deleteTask('${s.id}','daily','${t.id}')" class="text-slate-400 text-[10px] flex-shrink-0">✕</button>
                </div>
            `).join('')}</div>`:`<div class="text-slate-400 text-[10px] text-center py-2">暂无任务，可上方添加单次任务或点击「+ 新增周期任务」</div>`}
        </div>
    </div>`;
}
function subjectAddDailyTask(subjectId){
    const input=document.getElementById('subjTaskInput_'+subjectId);
    const dateInput=document.getElementById('subjTaskDate_'+subjectId);
    const text=(input?.value||'').trim();
    if(!text) return;
    const sub=state.subjects.find(s=>s.id===subjectId);
    if(!sub) return;
    const taskDate=(dateInput?.value||'').trim()||todayStr();
    const t={ id:genId(), text, completed:false, generatedDate:taskDate };
    tryMatchSubModules(t);
    sub.dailyTasks.push(t);
    saveData(); renderAll();
    const today=todayStr();
    if(taskDate===today) showToast('任务已添加到今日');
    else showToast('任务已添加到 '+taskDate);
}
function subjectToggleListenMode(sid){
    const s=state.subjects.find(x=>x.id===sid);
    if(!s) return;
    s.listenMode=s.listenMode?null:'chapters';
    if(s.listenMode && !s.listenTarget){ s.listenTarget=10; s.listenCompleted=0; }
    saveData(); renderAll();
}
function subjectListenSetTarget(sid){
    const s=state.subjects.find(x=>x.id===sid);
    if(!s) return;
    const v=prompt('设置总课时数：', String(s.listenTarget||10));
    if(v===null) return;
    const n=parseInt(v);
    if(!(n>0)){ showToast('请输入正整数'); return; }
    s.listenTarget=n;
    if((s.listenCompleted||0)>n) s.listenCompleted=n;
    saveData(); renderAll();
}
function subjectListenAdd(sid, delta){
    const s=state.subjects.find(x=>x.id===sid);
    if(!s) return;
    s.listenCompleted=Math.max(0, Math.min(s.listenTarget||0, (s.listenCompleted||0)+delta));
    saveData(); renderAll();
}
function subjectSubModAdd(sid, mid, delta){
    const s=state.subjects.find(x=>x.id===sid);
    if(!s) return;
    const m=(s.subModules||[]).find(x=>x.id===mid);
    if(!m) return;
    m.current=Math.max(0, (m.current||0)+delta);
    if(m.target && m.current>m.target) m.current=m.target;
    saveData(); renderAll();
}
function subjectDeleteSubModule(sid, mid){
    openConfirmModal('确定删除该子模块？',()=>{
        const s=state.subjects.find(x=>x.id===sid);
        if(!s) return;
        s.subModules=(s.subModules||[]).filter(x=>x.id!==mid);
        saveData(); renderAll(); showToast('已删除');
    });
}

/* ---------- 学科增删改 ---------- */
function subjectOpenAddModal(){
    document.getElementById('subjectNameInput').value='';
    document.getElementById('subjectGroupInput').value='';
    document.getElementById('subjectWeightInput').value=1;
    document.getElementById('addSubjectModal').classList.remove('hidden');
}
function subjectCloseAddModal(){ document.getElementById('addSubjectModal').classList.add('hidden'); }
function subjectAdd(){
    const name=(document.getElementById('subjectNameInput').value||'').trim();
    if(!name){ showToast('请输入学科名称'); return; }
    const weight=Math.max(0.1,Number(document.getElementById('subjectWeightInput').value)||1);
    const group=(document.getElementById('subjectGroupInput').value||'').trim();
    state.subjects.push({
        id:genId(), name, group, weight,
        dailyTasks:[], longTasks:[],
        listenMode:null, listenTarget:0, listenCompleted:0, subModules:[], dailyTaskTemplates:[]
    });
    saveData(); closeAddSubjectModal(); renderAll(); showToast('已添加学科');
}
function subjectRenameStart(id){ renamingId=id; const s=state.subjects.find(x=>x.id===id); if(s){ document.getElementById('renameSubjectInput').value=s.name; document.getElementById('renameSubjectGroupInput').value=s.group||''; document.getElementById('renameSubjectModal').classList.remove('hidden'); } }
function subjectRenameDirect(id){ subjectRenameStart(id); }
function subjectCloseRenameModal(){ document.getElementById('renameSubjectModal').classList.add('hidden'); renamingId=null; }
function subjectRename(){
    if(!renamingId) return closeRenameSubjectModal();
    const name=(document.getElementById('renameSubjectInput').value||'').trim();
    if(!name){ showToast('请输入名称'); return; }
    const s=state.subjects.find(x=>x.id===renamingId);
    if(s){ s.name=name; s.group=(document.getElementById('renameSubjectGroupInput').value||'').trim(); }
    saveData(); closeRenameSubjectModal(); renderAll(); showToast('已重命名');
}
function subjectDelete(id){
    if(state.subjects.length<=1){ showToast('至少保留一个学科'); return; }
    openConfirmModal('确定删除该学科？相关任务和计时记录保留学科字段',()=>{
        state.subjects=state.subjects.filter(s=>s.id!==id);
        if(state.timerState && state.timerState.subjectId===id){
            state.timerState.subjectId=(state.subjects[0]&&state.subjects[0].id)||'';
        }
        saveData(); renderAll(); showToast('已删除');
    });
}

/* ---------- 子模块编辑弹窗 ---------- */
function subjectOpenSubModuleModal(sid, mid){
    editingSubModuleSubjectId=sid;
    editingSubModuleId=mid||null;
    if(mid){
        const s=state.subjects.find(x=>x.id===sid);
        const m=(s?.subModules||[]).find(x=>x.id===mid);
        if(m){
            document.getElementById('subModNameInput').value=m.name||'';
            document.getElementById('subModTargetInput').value=m.target||100;
            document.getElementById('subModCurrentInput').value=m.current||0;
            document.getElementById('subModKeywordsInput').value=m.keywords||'';
        }
    }else{
        document.getElementById('subModNameInput').value='';
        document.getElementById('subModTargetInput').value=100;
        document.getElementById('subModCurrentInput').value=0;
        document.getElementById('subModKeywordsInput').value='';
    }
    document.getElementById('subModuleModal').classList.remove('hidden');
}
function subjectCloseSubModuleModal(){ document.getElementById('subModuleModal').classList.add('hidden'); editingSubModuleSubjectId=null; editingSubModuleId=null; }
function subjectSaveSubModule(){
    const s=state.subjects.find(x=>x.id===editingSubModuleSubjectId);
    if(!s) return closeSubModuleModal();
    const name=(document.getElementById('subModNameInput').value||'').trim();
    if(!name){ showToast('请输入子模块名称'); return; }
    const target=Math.max(1,Number(document.getElementById('subModTargetInput').value)||1);
    const current=Math.max(0,Math.min(target, Number(document.getElementById('subModCurrentInput').value)||0));
    const keywords=(document.getElementById('subModKeywordsInput').value||'').trim();
    if(editingSubModuleId){
        const m=(s.subModules||[]).find(x=>x.id===editingSubModuleId);
        if(m){ m.name=name; m.target=target; m.current=current; m.keywords=keywords; }
    }else{
        if(!Array.isArray(s.subModules)) s.subModules=[];
        s.subModules.push({ id:genId(), name, target, current, keywords });
    }
    saveData(); closeSubModuleModal(); renderAll(); showToast('已保存');
}

/* ---------- 数据复盘 ---------- */
function switchReviewTab(tab){
    if(!['week','month','year'].includes(tab)) tab='week';
    state.reviewTab=tab; saveData();
    ['week','month','year'].forEach(t=>{
        const p=document.getElementById('reviewPane-'+t);
        const b=document.getElementById('reviewTab'+(t==='week'?'Week':t==='month'?'Month':'Year'));
        if(b){ if(t===tab) b.classList.add('review-tab-active'); else b.classList.remove('review-tab-active'); }
        if(p){ p.classList.toggle('hidden', t!==tab); }
    });
    renderReview();
}
function renderReview(){
    renderReviewSummary();
    const tab=state.reviewTab||'week';
    if(tab==='week'){ renderWeekReview(); }
    else if(tab==='month'){ renderMonthReview(); }
    else if(tab==='year'){ renderYearReview(); }
    else { state.reviewTab='week'; renderWeekReview(); }
}
function renderReviewSummary(){
    const today=new Date();
    const year=today.getFullYear(), month=today.getMonth();
    const thisWeekStart=getWeekStart(new Date(),0);
    const lastWeekStart=getWeekStart(new Date(),-1);
    // 本周
    let weekMins=0, lastWeekMins=0;
    const weekDates=dateRange(thisWeekStart,7);
    const lastDates=dateRange(lastWeekStart,7);
    state.sessions.forEach(s=>{
        if(weekDates.includes(s.date)) weekMins+=Number(s.minutes)||0;
        if(lastDates.includes(s.date)) lastWeekMins+=Number(s.minutes)||0;
    });
    document.getElementById('weekTime').textContent=formatHours(weekMins);
    const delta=weekMins-lastWeekMins;
    document.getElementById('weekDelta').textContent= delta>0?`对比上周 +${formatHours(delta)}` : delta<0?`对比上周 -${formatHours(-delta)}`:'对比上周 持平';
    // 本月
    const monthDates=[];
    for(let d=1;d<=new Date(year,month+1,0).getDate();d++) monthDates.push(`${year}-${pad2(month+1)}-${pad2(d)}`);
    const lastMonth=new Date(year,month-1,1);
    const lmDates=[];
    for(let d=1;d<=new Date(lastMonth.getFullYear(),lastMonth.getMonth()+1,0).getDate();d++) lmDates.push(`${lastMonth.getFullYear()}-${pad2(lastMonth.getMonth()+1)}-${pad2(d)}`);
    let monthMins=0, lmMonthMins=0;
    state.sessions.forEach(s=>{
        if(monthDates.includes(s.date)) monthMins+=Number(s.minutes)||0;
        if(lmDates.includes(s.date)) lmMonthMins+=Number(s.minutes)||0;
    });
    document.getElementById('monthTime').textContent=formatHours(monthMins);
    const mdelta=monthMins-lmMonthMins;
    document.getElementById('monthDelta').textContent= mdelta>0?`对比上月 +${formatHours(mdelta)}` : mdelta<0?`对比上月 -${formatHours(-mdelta)}`:'对比上月 持平';
    // 全年
    let totalMins=0;
    state.sessions.forEach(s=>{ if(s.date.startsWith(year+'-')) totalMins+=Number(s.minutes)||0; });
    document.getElementById('totalTime').textContent=formatHours(totalMins);
    document.getElementById('totalSessions').textContent=state.sessions.filter(s=>s.date.startsWith(year+'-')).length+' 次会话';
}
function getWeekStart(d, offsetWeeks=0){
    const nd=new Date(d); nd.setHours(0,0,0,0);
    const day=nd.getDay();
    // 以周一为一周的第一天（day=0周日→减6天；day=1周一→减0天）
    const shift=day===0?6:day-1;
    nd.setDate(nd.getDate()-shift + offsetWeeks*7);
    return nd;
}
function dateRange(startDate, days){
    const arr=[]; for(let i=0;i<days;i++){ const d=new Date(startDate); d.setDate(d.getDate()+i); arr.push(formatDate(d)); } return arr;
}

/* ---------- v9b 全局自定义分类（替换学科子分类timerCategories） ---------- */
const CATEGORY_PALETTE=[
    '#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6',
    '#ec4899','#0ea5e9','#84cc16','#f97316','#6366f1',
    '#14b8a6','#a855f7','#d946ef','#06b6d4','#facc15'
];
let _catColorCursor=0;
function nextCategoryColor(){
    const c=CATEGORY_PALETTE[_catColorCursor%CATEGORY_PALETTE.length];
    _catColorCursor++;
    return c;
}
const DEFAULT_CLASSIFICATION_COLOR=()=>CATEGORY_PALETTE[0];
function findClassificationColor(classificationId){
    if(!classificationId) return DEFAULT_CLASSIFICATION_COLOR();
    const c=(state.classifications||[]).find(x=>x.id===classificationId);
    return (c&&c.color)?c.color:DEFAULT_CLASSIFICATION_COLOR();
}
function defaultClassificationId(){
    if(Array.isArray(state.classifications)&&state.classifications[0]) return state.classifications[0].id;
    return '';
}
/* 颜色淡化（同色系低明度）：mix with white 65% */
function lightenColor(hex){
    const h=(hex||DEFAULT_CLASSIFICATION_COLOR()).replace('#','');
    const full=h.length===3?h.split('').map(c=>c+c).join(''):h;
    const r=parseInt(full.substr(0,2),16)||59;
    const g=parseInt(full.substr(2,2),16)||130;
    const b=parseInt(full.substr(4,2),16)||246;
    const mix=(v)=>Math.round(v*0.35 + 255*0.65);
    const toHex=(v)=>String(v.toString(16)).padStart(2,'0');
    return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}
/* 获取条目颜色：按全局分类color，完成态淡化 */
function getEntryColor(classificationId, completed){
    const base=findClassificationColor(classificationId);
    return completed?lightenColor(base):base;
}
// v7 时间 "HH:MM" ↔ 分钟整数
function timeStrToMin(str){
    if(!str) return 8*60;
    const p=str.split(':');
    const h=parseInt(p[0])||0, m=parseInt(p[1])||0;
    return Math.max(0,Math.min(1439,h*60+m));
}
function minToTimeStr(min){
    min=Math.max(0,Math.min(1439,Number(min)||0));
    return pad2(Math.floor(min/60))+':'+pad2(min%60);
}

/* ---------- 复盘：周视图 ---------- */
function changeWeek(delta){ weekOffset+=delta; renderWeekReview(); }
function goToCurrentWeek(){ weekOffset=0; renderWeekReview(); }
function renderWeekReview(){
    const start=getWeekStart(new Date(), weekOffset);
    const end=new Date(start); end.setDate(end.getDate()+6);
    document.getElementById('weekLabel').textContent=`${formatDate(start)} ~ ${formatDate(end)}`;
    const dates=dateRange(start,7);
    // 初始化 weeklyPlan 分类下拉（颜色由分类决定）
    const clsSel=document.getElementById('weeklyPlanClassificationSelect');
    if(clsSel){
        const cur=clsSel.value;
        clsSel.innerHTML=(state.classifications||[]).map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        if(cur) clsSel.value=cur; else clsSel.value=defaultClassificationId();
    }
    // 历史未完成开关回显
    const tog=document.getElementById('showOldUncompletedToggle');
    if(tog) tog.checked=!!state.showOldUncompleted;
    renderWeekCompletionRate(dates);
    renderWeekGrid(dates);
    renderWeekBarChart();
    renderWeeklyStats();
}
/* v9：本周完成率统计（仅统计当前展示这一周的周计划 weeklyPlans + sessions视为完成条目） */
function renderWeekCompletionRate(dates){
    const rEl=document.getElementById('weekCompletionRate');
    const bEl=document.getElementById('weekCompletionBar');
    const dEl=document.getElementById('weekCompletionDetail');
    if(!rEl||!bEl||!dEl) return;
    const dateSet=new Set(dates);
    let total=0, done=0;
    state.weeklyPlans.forEach(p=>{
        if(!p.date || !dateSet.has(p.date)) return;
        total++;
        if(p.completed) done++;
    });
    state.sessions.forEach(s=>{
        if(!s.date || !dateSet.has(s.date)) return;
        total++; done++;
    });
    const pct=total?Math.round(done/total*100):0;
    rEl.textContent=pct+'%';
    bEl.style.width=pct+'%';
    dEl.textContent=`${done}/${total}`;
}
/* v9：切换历史未完成显示开关 */
function toggleOldUncompleted(checked){
    state.showOldUncompleted=!!checked;
    saveData();
    renderWeekReview();
    showToast(checked?'已显示历史未完成任务':'已隐藏历史未完成任务');
}
function getWeekTimeConfig(){
    const config=state.weekTimeConfig||{startMin:480,endMin:1380,slotMin:60};
    const startRaw=Number(config.startMin), endRaw=Number(config.endMin), slotRaw=Number(config.slotMin);
    const start=Number.isFinite(startRaw)?Math.max(0,Math.min(1439,startRaw)):480;
    const end=Number.isFinite(endRaw)?Math.max(start+15,Math.min(1440,endRaw)):1380;
    const slot=Number.isFinite(slotRaw)?Math.max(15,Math.min(1440,slotRaw)):60;
    return {startMin:start,endMin:end,slotMin:slot};
}
function openWeekTimeSettings(){
    const config=getWeekTimeConfig();
    document.getElementById('weekTimeStartInput').value=minToTimeStr(config.startMin);
    document.getElementById('weekTimeEndInput').value=config.endMin>=1440?'23:59':minToTimeStr(config.endMin);
    document.getElementById('weekTimeAllDayInput').checked=config.startMin===0&&config.endMin===1440;
    document.getElementById('weekTimeSlotInput').value=config.slotMin;
    toggleWeekTimeAllDay(document.getElementById('weekTimeAllDayInput').checked);
    document.getElementById('weekTimeSettingsModal').classList.remove('hidden');
}
function closeWeekTimeSettings(){ document.getElementById('weekTimeSettingsModal').classList.add('hidden'); }
function toggleWeekTimeAllDay(checked){
    document.getElementById('weekTimeStartInput').disabled=!!checked;
    document.getElementById('weekTimeEndInput').disabled=!!checked;
}
function saveWeekTimeSettings(){
    const allDay=document.getElementById('weekTimeAllDayInput').checked;
    const start=allDay?0:timeStrToMin(document.getElementById('weekTimeStartInput').value);
    const end=allDay?1440:Math.min(1440,timeStrToMin(document.getElementById('weekTimeEndInput').value));
    const slot=Math.max(15,Math.min(1440,parseInt(document.getElementById('weekTimeSlotInput').value,10)||60));
    if(end<=start){ showToast('结束时间需晚于开始时间'); return; }
    state.weekTimeConfig={startMin:start,endMin:end,slotMin:slot};
    saveData(); closeWeekTimeSettings(); renderWeekReview(); showToast('时间轴设置已应用');
}
/* v7 重写：条目按 position:absolute + top/height% 精确渲染，跨小时分段显示；v9 分类颜色替换四象限 */
function renderWeekGrid(dates){
    const grid=document.getElementById('weekGrid');
    const empty=document.getElementById('weekGridEmpty');
    const config=getWeekTimeConfig();
    const slotCount=Math.ceil((config.endMin-config.startMin)/config.slotMin);
    const slots=Array.from({length:slotCount},(_,i)=>config.startMin+i*config.slotMin);
    const dowLabels=['日','一','二','三','四','五','六'];
    let html='<div class="week-grid-surface">';
    html+=`<div class="grid week-grid-layout" style="grid-template-columns:3rem repeat(7,1fr);grid-template-rows:2.25rem repeat(${slotCount},3.5rem);">`;
    html+='<div></div>';
    dates.forEach((ds,i)=>{ html+=`<div class="text-[10px] text-center text-slate-500 pb-1">${dowLabels[new Date(ds+'T00:00:00').getDay()]}<br><span class="font-semibold">${new Date(ds+'T00:00:00').getDate()}</span></div>`; });
    slots.forEach(slotMin=>{
        html+=`<div class="text-[10px] text-slate-400 text-right pr-1 py-2">${minToTimeStr(slotMin)}</div>`;
        dates.forEach(ds=>{
            html+=`<div class="cal-cell week-cell relative h-14 border rounded cursor-pointer overflow-hidden bg-slate-50 border-slate-200" data-date="${ds}" data-hour="${slotMin}" onmousedown="startWeekDrag(event,'${ds}',${slotMin})" onmouseup="endWeekDrag(event)" onclick="if(!weeklyDragMoved) openWeeklyPlanModalForCell('${ds}',${slotMin})" onmouseenter="weekDragEnter(event,'${ds}',${slotMin})"></div>`;
        });
    });
    html+=`</div><div class="week-grid-overlay" style="height:${slotCount*3.5}rem;">`;
    dates.forEach((ds,dayIndex)=>{
        html+=`<div class="week-day-lane" data-date="${ds}">`;
        getWeekEntriesForDate(ds).forEach((e,idx)=>{
            const bg=getEntryColor(e.classificationId, !!e.completed);
            const textColor=e.completed?'#475569':'#fff';
            const leftPct=0;
            const widthPct=100;
            const topPct=Math.max(0,(e.startMin-config.startMin)/(config.endMin-config.startMin)*100);
            const heightPct=Math.min(100,Math.max(2,(e.endMin-e.startMin)/(config.endMin-config.startMin)*100));
            html+=`<div class="week-entry ${e.completed?'completed-entry':''} text-[9px] px-1 rounded border cursor-pointer overflow-hidden" style="position:absolute;left:${leftPct}%;top:${topPct}%;width:${widthPct}%;height:${heightPct}%;box-sizing:border-box;background:${bg};border-color:${bg};color:${textColor};font-size:13px;font-weight:400;text-align:center;line-height:1.2;white-space:normal;overflow-wrap:anywhere;" onpointerdown="startWeekEntryDrag(event,'${e.id}','${e.isPlan?'plan':'session'}')" onmousedown="event.stopPropagation()" onclick="event.stopPropagation();if(!weeklyEntryDragMoved) openWeeklyPlanModalForEntry('${e.id}','${e.isPlan?'plan':'session'}')" title="${escapeHtml(e.label)}"><span class="week-entry-content">${escapeHtml(e.label)}</span></div>`;
        });
        html+='</div>';
    });
    html+='</div></div>';
    grid.innerHTML=html;
    ensureWeekEntryDragListeners();
    if(!state.sessions.length && !state.weeklyPlans.length) empty.classList.remove('hidden'); else empty.classList.add('hidden');
}
/* v9b：条目按全局分类classificationId取颜色；新增历史未完成过滤 */
function getCellEntries(ds, h){
    const arr=[];
    const hStart=h*60;
    const hEnd=(h+1)*60;
    // 当前周周一（作为历史未完成隐藏的分界线）
    const curWeekStart=formatDate(getWeekStart(new Date(), 0));
    const showOld=!!state.showOldUncompleted;
    // 周计划
    state.weeklyPlans.forEach(p=>{
        if(p.date!==ds) return;
        // 历史未完成（早于本周周一）默认隐藏，用户可手动开启
        if(!p.completed && p.date<curWeekStart && !showOld) return;
        const sm=Number(p.startMin); const em=Number(p.endMin);
        if(sm<hEnd && em>hStart){
            const overlapStart=Math.max(sm, hStart);
            const overlapEnd=Math.min(em, hEnd);
            const startPct=(overlapStart-hStart)/60*100;
            const heightPct=(overlapEnd-overlapStart)/60*100;
            arr.push({
                id:p.id, isPlan:true, completed:!!p.completed,
                classificationId:p.classificationId,
                label:p.content,
                startPct:Math.max(0,startPct), heightPct:Math.min(100,Math.max(8,heightPct)),
                continuesAbove:sm<hStart, continuesBelow:em>hEnd, continuesAcrossBoundary:sm<hStart||em>hEnd
            });
        }
    });
    // 计时会话
    state.sessions.forEach(s=>{
        if(s.date!==ds) return;
        const st=new Date(s.startTs||0);
        const en=new Date(s.endTs||0);
        const sm=st.getHours()*60+st.getMinutes();
        let em=en.getHours()*60+en.getMinutes();
        if(em<=sm) em=sm+Math.max(15,Math.round(Number(s.minutes)||15));
        if(sm<hEnd && em>hStart){
            const overlapStart=Math.max(sm, hStart);
            const overlapEnd=Math.min(em, hEnd);
            const startPct=(overlapStart-hStart)/60*100;
            const heightPct=(overlapEnd-overlapStart)/60*100;
            const sub=state.subjects.find(x=>x.id===s.subjectId);
            arr.push({
                id:s.id, isPlan:false, completed:true,
                classificationId:s.classificationId,
                label:(sub?sub.name:'')+' '+formatHours(s.minutes),
                startPct:Math.max(0,startPct), heightPct:Math.min(100,Math.max(8,heightPct)),
                continuesAbove:sm<hStart, continuesBelow:em>hEnd, continuesAcrossBoundary:sm<hStart||em>hEnd
            });
        }
    });
    arr.sort((a,b)=>(a.startPct-b.startPct));
    return arr;
}
function getWeekEntriesForDate(ds){
    const result=[];
    const config=getWeekTimeConfig();
    const curWeekStart=formatDate(getWeekStart(new Date(),0));
    const showOld=!!state.showOldUncompleted;
    state.weeklyPlans.forEach(p=>{
        if(!p.date || (!p.completed && p.date<curWeekStart && !showOld)) return;
        const start=Number(p.startMin), rawEnd=Number(p.endMin);
        if(!Number.isFinite(start)||!Number.isFinite(rawEnd)) return;
        const end=rawEnd<=start?rawEnd+1440:rawEnd;
        const dayOffset=Math.round((new Date(ds+'T00:00:00')-new Date(p.date+'T00:00:00'))/86400000);
        if(dayOffset<0||dayOffset>1) return;
        const dayStart=dayOffset*1440;
        const visibleStart=Math.max(start,dayStart+config.startMin);
        const visibleEnd=Math.min(end,dayStart+config.endMin);
        if(visibleEnd<=visibleStart) return;
        result.push({id:p.id,isPlan:true,completed:!!p.completed,classificationId:p.classificationId,
            label:p.content,startMin:visibleStart-dayOffset*1440,endMin:visibleEnd-dayOffset*1440});
    });
    state.sessions.forEach(s=>{
        if(s.date!==ds) return;
        const st=new Date(s.startTs||0), en=new Date(s.endTs||0);
        const startMin=st.getHours()*60+st.getMinutes();
        let endMin=en.getHours()*60+en.getMinutes();
        if(endMin<=startMin) endMin=startMin+Math.max(15,Math.round(Number(s.minutes)||15));
        if(endMin<=config.startMin || startMin>=config.endMin) return;
        result.push({id:s.id,isPlan:false,completed:true,classificationId:s.classificationId,
            label:formatHours(s.minutes),startMin:Math.max(config.startMin,startMin),endMin:Math.min(config.endMin,endMin)});
    });
    return result.sort((a,b)=>a.startMin-b.startMin);
}
let weeklyDragMoved=false;
let weeklyEntryDrag=null;
let weeklyEntryDragTimer=null;
let weeklyEntryDragMoved=false;
function ensureWeekEntryDragListeners(){
    if(window.__weekEntryDragListenersReady) return;
    window.__weekEntryDragListenersReady=true;
    document.addEventListener('pointermove',moveWeekEntryDrag);
    document.addEventListener('pointerup',endWeekEntryDrag);
    document.addEventListener('pointercancel',cancelWeekEntryDrag);
}
function startWeekEntryDrag(e, id, source){
    e.stopPropagation();
    if(source!=='plan') return;
    const p=state.weeklyPlans.find(x=>x.id===id);
    if(!p || p.completed) return;
    const rect=e.currentTarget.getBoundingClientRect();
    weeklyEntryDragMoved=false;
    weeklyEntryDrag={id, source, pointerId:e.pointerId, date:p.date, startMin:Number(p.startMin), endMin:Number(p.endMin), active:false, mode:'move', element:e.currentTarget, container:e.currentTarget.closest('.week-grid-surface'), offsetX:e.clientX-rect.left, offsetY:e.clientY-rect.top, downX:e.clientX, downY:e.clientY};
    const ghost=weeklyEntryDrag.element.cloneNode(true);
    ghost.style.visibility='hidden';
    ghost.classList.add('week-entry-drag-ghost');
    ghost.style.width=rect.width+'px';
    ghost.style.height=rect.height+'px';
    weeklyEntryDrag.container.appendChild(ghost);
    weeklyEntryDrag.ghost=ghost;
    positionWeekEntryGhost(e.clientX,e.clientY);
    weeklyEntryDragTimer=setTimeout(()=>{
        if(weeklyEntryDrag){
            weeklyEntryDrag.active=true;
            weeklyEntryDragMoved=true;
            weeklyEntryDrag.element.style.visibility='hidden';
            weeklyEntryDrag.ghost.style.visibility='visible';
            document.body.style.userSelect='none';
            showToast('已进入时间调整，拖动到目标格');
        }
    },350);
}
function moveWeekEntryDrag(e){
    if(!weeklyEntryDrag || e.pointerId!==weeklyEntryDrag.pointerId) return;
    if(!weeklyEntryDrag.active){
        if(Math.hypot(e.clientX-weeklyEntryDrag.downX,e.clientY-weeklyEntryDrag.downY)<4) return;
        weeklyEntryDrag.active=true;
        weeklyEntryDragMoved=true;
        clearTimeout(weeklyEntryDragTimer);
        weeklyEntryDrag.element.style.visibility='hidden';
        weeklyEntryDrag.ghost.style.visibility='visible';
        document.body.style.userSelect='none';
    }
    const target=getWeekDropTarget(e.clientX,e.clientY);
    updateWeekEntryGhost(e.clientX,e.clientY);
    if(!target) return;
    weeklyEntryDrag.target=target;
    document.querySelectorAll('.week-cell.week-entry-drag-target').forEach(el=>el.classList.remove('week-entry-drag-target'));
    const targetCell=document.querySelector(`.week-cell[data-date="${target.ds}"][data-hour="${target.h}"]`);
    if(targetCell) targetCell.classList.add('week-entry-drag-target');
    e.preventDefault();
}
function endWeekEntryDrag(e){
    if(!weeklyEntryDrag || e.pointerId!==weeklyEntryDrag.pointerId) return;
    clearTimeout(weeklyEntryDragTimer);
    const drag=weeklyEntryDrag;
    weeklyEntryDrag=null;
    if(drag.ghost) drag.ghost.remove();
    document.body.style.userSelect='';
    document.querySelectorAll('.week-cell.week-entry-drag-target').forEach(el=>el.classList.remove('week-entry-drag-target'));
    if(!drag.active || !drag.target){
        if(drag.element) drag.element.style.visibility='';
        weeklyEntryDragMoved=false;
        return;
    }
    const p=state.weeklyPlans.find(x=>x.id===drag.id);
    if(!p) return;
    const slotMin=getWeekTimeConfig().slotMin;
    const targetStart=drag.target.h;
    const duration=Math.max(slotMin,drag.endMin-drag.startMin);
    const config=getWeekTimeConfig();
    const nextStart=Math.max(config.startMin,Math.min(config.endMin-duration,targetStart));
    const nextEnd=nextStart+duration;
    const conflict=getWeekEntriesForDate(drag.target.ds).some(other=>other.id!==p.id&&nextStart<Number(other.endMin)&&nextEnd>Number(other.startMin));
    if(conflict){
        if(drag.element) drag.element.style.visibility='';
        weeklyEntryDragMoved=false;
        showToast('目标时间与已有计划冲突');
        return;
    }
    p.date=drag.target.ds; p.startMin=nextStart; p.endMin=nextEnd;
    saveData(); renderWeekReview(); showToast('时间块已调整');
    setTimeout(()=>{ weeklyEntryDragMoved=false; },0);
}
function cancelWeekEntryDrag(){
    clearTimeout(weeklyEntryDragTimer);
    if(weeklyEntryDrag&&weeklyEntryDrag.ghost) weeklyEntryDrag.ghost.remove();
    if(weeklyEntryDrag&&weeklyEntryDrag.element) weeklyEntryDrag.element.style.visibility='';
    weeklyEntryDrag=null;
    document.body.style.userSelect='';
    document.querySelectorAll('.week-cell.week-entry-drag-target').forEach(el=>el.classList.remove('week-entry-drag-target'));
}
function positionWeekEntryGhost(clientX, clientY){
    if(!weeklyEntryDrag||!weeklyEntryDrag.ghost) return;
    const containerRect=weeklyEntryDrag.container.getBoundingClientRect();
    const offsetX=weeklyEntryDrag.offsetX||0;
    const offsetY=weeklyEntryDrag.offsetY||0;
    weeklyEntryDrag.ghost.style.left=Math.round(clientX-containerRect.left-offsetX)+'px';
    weeklyEntryDrag.ghost.style.top=Math.round(clientY-containerRect.top-offsetY)+'px';
}
function getWeekDropTarget(clientX,clientY){
    const overlay=document.querySelector('.week-grid-overlay');
    if(!overlay) return null;
    const rect=overlay.getBoundingClientRect(), config=getWeekTimeConfig();
    if(clientX<rect.left||clientX>rect.right||clientY<rect.top||clientY>rect.bottom) return null;
    const day=Math.max(0,Math.min(6,Math.floor((clientX-rect.left)/(rect.width/7))));
    const raw=config.startMin+(clientY-rect.top)/rect.height*(config.endMin-config.startMin);
    const snapped=config.startMin+Math.max(0,Math.min(Math.ceil((config.endMin-config.startMin)/config.slotMin)-1,Math.round((raw-config.startMin)/config.slotMin)))*config.slotMin;
    const lane=overlay.children[day];
    return {ds:lane&&lane.dataset.date,h:snapped};
}
function updateWeekEntryGhost(clientX,clientY){
    if(!weeklyEntryDrag||!weeklyEntryDrag.ghost) return;
    positionWeekEntryGhost(clientX,clientY);
}
function startWeekDrag(e, ds, h){ weeklyDragStart={ds,h}; weeklyDragEnd={ds,h}; weeklyDragMoved=false; clearWeekDragSelection(); }
function weekDragEnter(e, ds, h){ if(!weeklyDragStart) return; weeklyDragEnd={ds,h}; weeklyDragMoved=true; applyWeekDragSelection(); }
function endWeekDrag(e){
    if(weeklyDragMoved && weeklyDragStart && weeklyDragEnd){
        const cells=collectCellsInRange(weeklyDragStart,weeklyDragEnd);
        if(cells.length){
            const first=cells[0];
            openWeeklyPlanModalForCell(first.ds, first.h, collectCellsInRange(weeklyDragStart,weeklyDragEnd));
        }
    }
    weeklyDragStart=null; weeklyDragEnd=null; weeklyDragMoved=false;
    setTimeout(clearWeekDragSelection,100);
}
function clearWeekDrag(){ weeklyDragStart=null; weeklyDragEnd=null; weeklyDragMoved=false; clearWeekDragSelection(); }
function clearWeekDragSelection(){
    document.querySelectorAll('.week-cell.drag-selected').forEach(el=>el.classList.remove('drag-selected'));
    document.querySelectorAll('.week-drag-preview').forEach(el=>el.remove());
}
function applyWeekDragSelection(){
    clearWeekDragSelection();
    document.querySelectorAll('.week-drag-preview').forEach(el=>el.remove());
    if(!weeklyDragStart||!weeklyDragEnd) return;
    const cells=collectCellsInRange(weeklyDragStart,weeklyDragEnd);
    cells.forEach(c=>{
        const el=document.querySelector(`.week-cell[data-date="${c.ds}"][data-hour="${c.h}"]`);
        if(el) el.classList.add('drag-selected');
    });
    const byDate={};
    cells.forEach(c=>{ if(!byDate[c.ds]) byDate[c.ds]=[]; byDate[c.ds].push(c.h); });
    Object.keys(byDate).forEach(ds=>{
        const lane=document.querySelector(`.week-day-lane[data-date="${ds}"]`);
        if(!lane) return;
        const minHour=Math.min(...byDate[ds]), maxHour=Math.max(...byDate[ds]);
        const preview=document.createElement('div');
        preview.className='week-drag-preview';
        const config=getWeekTimeConfig();
        preview.style.top=((minHour-config.startMin)/(config.endMin-config.startMin)*100)+'%';
        preview.style.height=((maxHour-minHour+config.slotMin)/(config.endMin-config.startMin)*100)+'%';
        lane.appendChild(preview);
    });
}
function collectCellsInRange(a,b){
    const result=[];
    const dates=[];
    const start=getWeekStart(new Date(), weekOffset);
    for(let i=0;i<7;i++){ const d=new Date(start); d.setDate(d.getDate()+i); dates.push(formatDate(d)); }
    const d1=dates.indexOf(a.ds), d2=dates.indexOf(b.ds);
    const dMin=Math.min(d1,d2), dMax=Math.max(d1,d2);
    const config=getWeekTimeConfig();
    const hMin=Math.min(a.h,b.h), hMax=Math.max(a.h,b.h);
    for(let d=dMin;d<=dMax;d++) for(let h=hMin;h<=hMax;h+=config.slotMin) result.push({ds:dates[d],h});
    return result;
}
/* 周计划模态框 */
let editingWeeklyCells=null;
function openWeeklyPlanModalForCell(ds, h, cells){
    editingWeeklyPlanId=null;
    editingWeeklyCells=cells||[{ds,h}];
    document.getElementById('weeklyPlanModalTitle').textContent='新建计划';
    document.getElementById('weeklyPlanContentInput').value='';
    const first=editingWeeklyCells[0];
    document.getElementById('weeklyPlanDate')&&(document.getElementById('weeklyPlanDate').value=first.ds);
    editingWeeklyPlanDate=first.ds;
    const startMin=first.h;
    const last=editingWeeklyCells[editingWeeklyCells.length-1]||first;
    const endMin=Math.min(24*60, last.h+getWeekTimeConfig().slotMin);
    const sSel=document.getElementById('weeklyPlanStartSelect');
    const eSel=document.getElementById('weeklyPlanEndSelect');
    if(sSel) sSel.value=minToTimeStr(startMin);
    if(eSel) eSel.value=minToTimeStr(endMin);
    const cSel=document.getElementById('weeklyPlanCompleted');
    if(cSel){ cSel.checked=false; }
    const clsSel=document.getElementById('weeklyPlanClassificationSelect');
    if(clsSel) clsSel.value=defaultClassificationId();
    document.getElementById('weeklyPlanDeleteBtn').classList.add('hidden');
    document.getElementById('weeklyPlanCompleteBtn').classList.add('hidden');
    document.getElementById('weeklyPlanSaveBtn').classList.remove('hidden');
    document.getElementById('weeklyPlanModal').classList.remove('hidden');
}
function openWeeklyPlanModalForEntry(id, source){
    if(source==='session'){
        openEditSessionModal(id);
        return;
    }
    const p=state.weeklyPlans.find(x=>x.id===id);
    if(!p) return;
    editingWeeklyPlanId=id;
    editingWeeklyPlanSource=source;
    editingWeeklyCells=null;
    document.getElementById('weeklyPlanModalTitle').textContent='编辑计划';
    document.getElementById('weeklyPlanContentInput').value=p.content;
    editingWeeklyPlanDate=p.date;
    document.getElementById('weeklyPlanStartSelect').value=minToTimeStr(Number(p.startMin));
    document.getElementById('weeklyPlanEndSelect').value=minToTimeStr(Number(p.endMin)%1440);
    const clsSel=document.getElementById('weeklyPlanClassificationSelect');
    if(clsSel) clsSel.value=p.classificationId||defaultClassificationId();
    const cSel=document.getElementById('weeklyPlanCompleted');
    if(cSel){ cSel.checked=!!p.completed; }
    document.getElementById('weeklyPlanDeleteBtn').classList.remove('hidden');
    document.getElementById('weeklyPlanCompleteBtn').classList.remove('hidden');
    document.getElementById('weeklyPlanCompleteBtn').textContent=p.completed?'取消完成':'标记完成';
    document.getElementById('weeklyPlanSaveBtn').classList.remove('hidden');
    document.getElementById('weeklyPlanModal').classList.remove('hidden');
}
function closeWeeklyPlanModal(){ document.getElementById('weeklyPlanModal').classList.add('hidden'); editingWeeklyPlanId=null; editingWeeklyCells=null; }
function saveWeeklyPlan(){
    const content=(document.getElementById('weeklyPlanContentInput').value||'').trim();
    if(!content){ showToast('请输入计划内容'); return; }
    const classificationId=document.getElementById('weeklyPlanClassificationSelect').value||defaultClassificationId();
    const startMin=timeStrToMin(document.getElementById('weeklyPlanStartSelect').value);
    let endMin=timeStrToMin(document.getElementById('weeklyPlanEndSelect').value);
    const completedFlag=!!(document.getElementById('weeklyPlanCompleted')||{}).checked;
    if(endMin<=startMin) endMin+=1440;
    if(endMin>2880){ showToast('计划时长不能超过24小时'); return; }
    if(editingWeeklyPlanId){
        const p=state.weeklyPlans.find(x=>x.id===editingWeeklyPlanId);
        if(p){
            const conflict=getWeekEntriesForDate(p.date).some(other=>other.id!==p.id&&startMin<Number(other.endMin)&&endMin>Number(other.startMin));
            if(conflict){ showToast('该时间与已有计划冲突'); return; }
            p.content=content; p.subjectId=''; p.classificationId=classificationId;
            p.startMin=startMin; p.endMin=endMin; p.completed=completedFlag;
        }
    }else{
        (editingWeeklyCells||[]).forEach(cell=>{
            state.weeklyPlans.push({
                id:genId(), date:cell.ds,
                startMin, endMin,
                content, classificationId,
                completed:completedFlag
            });
        });
    }
    saveData(); closeWeeklyPlanModal(); renderWeekReview(); showToast('已保存');
}
function deleteWeeklyPlan(){
    if(!editingWeeklyPlanId) return;
    const planId=editingWeeklyPlanId;
    openConfirmModal('确定删除该计划？',()=>{
        state.weeklyPlans=state.weeklyPlans.filter(p=>p.id!==planId);
        saveData(); closeWeeklyPlanModal(); renderWeekReview(); showToast('已删除');
    });
}
function completeWeeklyPlanFromModal(){
    if(!editingWeeklyPlanId) return;
    const p=state.weeklyPlans.find(x=>x.id===editingWeeklyPlanId);
    if(p){ p.completed=!p.completed; saveData(); closeWeeklyPlanModal(); renderWeekReview(); showToast(p.completed?'已标记完成':'已取消完成'); }
}
/* 周统计 */
function changeStatsRange(r){
    weeklyStatsRange=r;
    ['week','month','year'].forEach(x=>{
        const el=document.getElementById('statsTab'+(x==='week'?'Week':x==='month'?'Month':'Year'));
        if(el){ if(x===r) el.classList.add('stats-tab-active'); else el.classList.remove('stats-tab-active'); }
    });
    renderWeeklyStats();
}
function renderWeekBarChart(){
    const chart=document.getElementById('weekChart');
    const start=getWeekStart(new Date(), weekOffset);
    const days=['一','二','三','四','五','六','日'];
    let max=0;
    const data=[];
    for(let i=0;i<7;i++){
        const d=new Date(start); d.setDate(d.getDate()+i); const ds=formatDate(d);
        let mins=0;
        state.sessions.forEach(s=>{ if(s.date===ds) mins+=Number(s.minutes)||0; });
        if(mins>max) max=mins;
        const rate=datedOverallPercent(ds);
        data.push({label:days[i],ds,mins,rate});
    }
    if(max===0 && data.every(d=>d.rate===0)){ document.getElementById('weekEmpty').classList.remove('hidden'); chart.innerHTML=''; return; }
    document.getElementById('weekEmpty').classList.add('hidden');
    max=Math.max(max,60);
    chart.innerHTML=data.map(d=>{
        const h1=max?Math.max(4,d.mins/max*100):0;
        const h2=Math.max(4,d.rate);
        return `<div class="flex-1 flex flex-col items-center gap-1">
            <div class="flex flex-col-reverse h-full w-full items-center gap-0.5">
                <div class="week-bar w-full bg-gradient-to-t from-primary-400 to-primary-500 rounded-t" style="height:${h1}%" title="时长 ${formatHours(d.mins)}"></div>
                <div class="week-bar w-full bg-gradient-to-t from-emerald-300 to-emerald-400 rounded-t" style="height:${h2*0.6}%" title="完成率 ${d.rate}%"></div>
            </div>
            <div class="text-[10px] text-slate-500">${d.label}</div>
        </div>`;
    }).join('');
}
function renderWeeklyStats(){
    let minDate=null, maxDate=null;
    const now=new Date();
    if(weeklyStatsRange==='week'){
        const start=getWeekStart(now, weekOffset); const end=new Date(start); end.setDate(end.getDate()+6);
        minDate=start; maxDate=end;
    }else if(weeklyStatsRange==='month'){
        minDate=new Date(now.getFullYear(), now.getMonth(), 1);
        maxDate=new Date(now.getFullYear(), now.getMonth()+1, 0);
    }else{
        minDate=new Date(now.getFullYear(), 0, 1);
        maxDate=new Date(now.getFullYear(), 11, 31);
    }
    const minStr=formatDate(minDate), maxStr=formatDate(maxDate);
    const subTotals={}, clsTotals={};
    let totalMins=0, sessCount=0;
    state.sessions.forEach(s=>{
        if(s.date<minStr||s.date>maxStr) return;
        const m=Number(s.minutes)||0;
        const subjectKey=s.subjectGroup?'group:'+s.subjectGroup:'subject:'+s.subjectId;
        subTotals[subjectKey]=(subTotals[subjectKey]||0)+m;
        const cls=(state.classifications||[]).find(x=>x.id===s.classificationId);
        const key=cls?cls.name:'未分类';
        clsTotals[key]=(clsTotals[key]||0)+m;
        totalMins+=m; sessCount++;
    });
    document.getElementById('weekStatsSummary').innerHTML=`合计 ${formatHours(totalMins)} · ${sessCount} 次会话`;
    const subColors=['#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316'];
    const subData=[];
    state.subjects.forEach((s,i)=>{
        const mins=subTotals['subject:'+s.id]||0;
        if(mins>0) subData.push({name:s.name, mins, color:subColors[i%subColors.length]});
    });
    [...new Set(state.subjects.map(s=>(s.group||'').trim()).filter(Boolean))].forEach((group,i)=>{
        const mins=subTotals['group:'+group]||0;
        if(mins>0) subData.push({name:group+'（科目汇总）', mins, color:subColors[(state.subjects.length+i)%subColors.length]});
    });
    const clsEntries=Object.entries(clsTotals).map(([n,m])=>{
        const cls=(state.classifications||[]).find(x=>x.name===n);
        return {name:n, mins:m, color:cls?cls.color:'#cbd5e1'};
    }).filter(x=>x.mins>0);
    renderDoughnut('weeklySubjectChart', weeklyCharts, 'subject', subData.length?subData:[{name:'暂无数据', mins:1, color:'#e2e8f0'}]);
    renderDoughnut('weeklyCategoryChart', weeklyCharts, 'category', clsEntries.length?clsEntries:[{name:'暂无数据', mins:1, color:'#e2e8f0'}]);
}
function renderDoughnut(canvasId, store, key, data){
    const ctx=document.getElementById(canvasId);
    if(!ctx) return;
    if(store[key]){ store[key].destroy(); store[key]=null; }
    try{
        store[key]=new Chart(ctx,{
            type:'doughnut',
            data:{ labels:data.map(d=>d.name), datasets:[{
                data:data.map(d=>d.mins),
                backgroundColor:data.map(d=>d.color),
                borderWidth:1, borderColor:'#fff'
            }]},
            options:{
                responsive:true, maintainAspectRatio:false,
                plugins:{
                    legend:{ position:'bottom', labels:{ boxWidth:10, font:{size:10} } },
                    tooltip:{ callbacks:{ label:(c)=>`${c.label}: ${formatHours(c.parsed)}` } }
                }
            }
        });
    }catch(e){}
}

/* ---------- 复盘：月视图 ---------- */
function changeMonth(delta){ calMonth+=delta; if(calMonth<0){ calMonth=11; calYear--; } if(calMonth>11){ calMonth=0; calYear++; } renderMonthReview(); }
function renderMonthReview(){
    document.getElementById('calMonthLabel').textContent=`${calYear}年${calMonth+1}月`;
    renderCalendar();
    renderMonthBar();
    // 30天汇总
    let checkin=0, rates=[], times=[];
    for(let i=0;i<30;i++){
        const d=new Date(); d.setDate(d.getDate()-i); const ds=formatDate(d);
        const mins=dayTotalMinutes(ds);
        if(mins>=15 || (state.records[ds]&&state.records[ds].checkedIn)) checkin++;
        const r=datedOverallPercent(ds); rates.push(r); times.push(mins);
    }
    const avgRates=rates.length?Math.round(rates.reduce((a,b)=>a+b,0)/rates.length):0;
    const avgTimes=times.length?Math.round(times.reduce((a,b)=>a+b,0)/times.length):0;
    document.getElementById('monthCheckinDays').textContent=checkin;
    document.getElementById('monthAvgRate').textContent=avgRates+'%';
    document.getElementById('monthAvgTime').textContent=formatHours(avgTimes);
    // 明细
    const details=[];
    const mt=state.subjects.map(s=>{
        let m=0; state.sessions.forEach(ss=>{
            const d=new Date(ss.date); const diff=(Date.now()-d.getTime())/(1000*60*60*24);
            if(diff<30 && ss.subjectId===s.id) m+=Number(ss.minutes)||0;
        });
        return {name:s.name, mins:m};
    }).filter(x=>x.mins>0).sort((a,b)=>b.mins-a.mins);
    mt.forEach(x=>details.push(`<div class="flex justify-between bg-slate-50 rounded p-1.5"><span>${escapeHtml(x.name)}</span><span class="text-primary-600 font-semibold">${formatHours(x.mins)}</span></div>`));
    document.getElementById('monthDetails').innerHTML=details.join('');
}
/* ---------- v7 月历标记：8色常量 ---------- */
const MARKER_COLORS=['#ef4444','#f97316','#f59e0b','#84cc16','#10b981','#0ea5e9','#6366f1','#ec4899'];
/* 注意：editingEventMarkerId / editingBlockMarkerId 已在 1184 行顶层声明过！
   这里不能再 let 重复声明——重复 let/const 会触发 SyntaxError，导致整个 script 块在解析阶段就被浏览器拒绝，所有函数不定义、整个界面"死的、点不动"！ */
editingEventMarkerId=null;
editingBlockMarkerId=null;
let eventMarkerPickedColor=MARKER_COLORS[0];
let blockMarkerPickedColor=MARKER_COLORS[5];

/* 8色选择器HTML构造，onPick选中时触发回调 */
function buildColorPickerHTML(containerId, current, onPickId){
    const el=document.getElementById(containerId);
    if(!el) return;
    el.innerHTML=MARKER_COLORS.map(c=>{
        const sel=c===current;
        return `<button type="button" 
            class="aspect-square rounded transition" 
            style="background:${c};${sel?'outline:2px solid #1e293b;outline-offset:1px;':''}"
            onclick="${onPickId}('${c}',this)"></button>`;
    }).join('');
}
function pickEventMarkerColor(c, btn){
    eventMarkerPickedColor=c;
    buildColorPickerHTML('eventMarkerColors', c, 'pickEventMarkerColor');
}
function pickBlockMarkerColor(c, btn){
    blockMarkerPickedColor=c;
    buildColorPickerHTML('blockMarkerColors', c, 'pickBlockMarkerColor');
}

/* ---- 事件标记：增删改 ---- */
function openAddEventMarkerModal(presetDate){
    editingEventMarkerId=null;
    document.getElementById('eventMarkerModalTitle').textContent='新增事件标记';
    document.getElementById('eventMarkerDeleteBtn').classList.add('hidden');
    const ds=presetDate||document.getElementById('eventMarkerPresetDate').value||todayStr();
    document.getElementById('eventMarkerDate').value=ds;
    document.getElementById('eventMarkerText').value='';
    eventMarkerPickedColor=MARKER_COLORS[0];
    buildColorPickerHTML('eventMarkerColors', eventMarkerPickedColor, 'pickEventMarkerColor');
    document.getElementById('eventMarkerModal').classList.remove('hidden');
}
function openEditEventMarkerModal(id){
    const m=state.calendarMarkers.events.find(x=>x.id===id);
    if(!m) return;
    editingEventMarkerId=id;
    document.getElementById('eventMarkerModalTitle').textContent='编辑事件标记';
    document.getElementById('eventMarkerDeleteBtn').classList.remove('hidden');
    document.getElementById('eventMarkerDate').value=m.date;
    document.getElementById('eventMarkerText').value=m.text||'';
    eventMarkerPickedColor=m.color||MARKER_COLORS[0];
    buildColorPickerHTML('eventMarkerColors', eventMarkerPickedColor, 'pickEventMarkerColor');
    document.getElementById('eventMarkerModal').classList.remove('hidden');
}
function closeEventMarkerModal(){ document.getElementById('eventMarkerModal').classList.add('hidden'); editingEventMarkerId=null; }
function saveEventMarker(){
    const date=document.getElementById('eventMarkerDate').value;
    const text=(document.getElementById('eventMarkerText').value||'').trim();
    if(!date){ showToast('请选择日期'); return; }
    if(!text){ showToast('请输入说明'); return; }
    if(editingEventMarkerId){
        const m=state.calendarMarkers.events.find(x=>x.id===editingEventMarkerId);
        if(m){ m.date=date; m.text=text; m.color=eventMarkerPickedColor; }
    }else{
        state.calendarMarkers.events.push({ id:genId(), date, text, color:eventMarkerPickedColor });
    }
    saveData(); closeEventMarkerModal(); renderCalendar();
    const sel=selectedCalDate; if(sel) showCalDayDetail(sel);
    showToast('已保存');
}
function deleteEventMarker(){
    if(!editingEventMarkerId) return;
    openConfirmModal('确定删除该事件标记？',()=>{
        state.calendarMarkers.events=state.calendarMarkers.events.filter(x=>x.id!==editingEventMarkerId);
        saveData(); closeEventMarkerModal(); renderCalendar();
        const sel=selectedCalDate; if(sel) showCalDayDetail(sel);
        showToast('已删除');
    });
}

/* ---- 整体(区间)标记：增删改 ---- */
function openAddBlockMarkerModal(presetDate){
    editingBlockMarkerId=null;
    document.getElementById('blockMarkerModalTitle').textContent='新增整体标记';
    document.getElementById('blockMarkerDeleteBtn').classList.add('hidden');
    const ds=presetDate||document.getElementById('blockMarkerPresetDate').value||todayStr();
    document.getElementById('blockMarkerStart').value=ds;
    // 默认 1 周区间
    const end=new Date(ds+'T00:00:00'); end.setDate(end.getDate()+6);
    document.getElementById('blockMarkerEnd').value=formatDate(end);
    document.getElementById('blockMarkerText').value='';
    blockMarkerPickedColor=MARKER_COLORS[5];
    buildColorPickerHTML('blockMarkerColors', blockMarkerPickedColor, 'pickBlockMarkerColor');
    document.getElementById('blockMarkerModal').classList.remove('hidden');
}
function openEditBlockMarkerModal(id){
    const m=state.calendarMarkers.blocks.find(x=>x.id===id);
    if(!m) return;
    editingBlockMarkerId=id;
    document.getElementById('blockMarkerModalTitle').textContent='编辑整体标记';
    document.getElementById('blockMarkerDeleteBtn').classList.remove('hidden');
    document.getElementById('blockMarkerStart').value=m.startDate;
    document.getElementById('blockMarkerEnd').value=m.endDate;
    document.getElementById('blockMarkerText').value=m.text||'';
    blockMarkerPickedColor=m.color||MARKER_COLORS[5];
    buildColorPickerHTML('blockMarkerColors', blockMarkerPickedColor, 'pickBlockMarkerColor');
    document.getElementById('blockMarkerModal').classList.remove('hidden');
}
function closeBlockMarkerModal(){ document.getElementById('blockMarkerModal').classList.add('hidden'); editingBlockMarkerId=null; }
function saveBlockMarker(){
    const startDate=document.getElementById('blockMarkerStart').value;
    const endDate=document.getElementById('blockMarkerEnd').value;
    const text=(document.getElementById('blockMarkerText').value||'').trim();
    if(!startDate||!endDate){ showToast('请选择日期区间'); return; }
    if(endDate<startDate){ showToast('结束日期不能早于开始'); return; }
    if(!text){ showToast('请输入说明'); return; }
    if(editingBlockMarkerId){
        const m=state.calendarMarkers.blocks.find(x=>x.id===editingBlockMarkerId);
        if(m){ m.startDate=startDate; m.endDate=endDate; m.text=text; m.color=blockMarkerPickedColor; }
    }else{
        state.calendarMarkers.blocks.push({ id:genId(), startDate, endDate, text, color:blockMarkerPickedColor });
    }
    saveData(); closeBlockMarkerModal(); renderCalendar();
    const sel=selectedCalDate; if(sel) showCalDayDetail(sel);
    showToast('已保存');
}
function deleteBlockMarker(){
    if(!editingBlockMarkerId) return;
    openConfirmModal('确定删除该整体标记？',()=>{
        state.calendarMarkers.blocks=state.calendarMarkers.blocks.filter(x=>x.id!==editingBlockMarkerId);
        saveData(); closeBlockMarkerModal(); renderCalendar();
        const sel=selectedCalDate; if(sel) showCalDayDetail(sel);
        showToast('已删除');
    });
}

/* 渲染某日标记区（dayMarkersBlock） */
function renderDayMarkers(ds){
    const blockEl=document.getElementById('dayMarkersBlock');
    const listEl=document.getElementById('dayMarkersList');
    if(!blockEl||!listEl){ return; }
    const evs=state.calendarMarkers.events.filter(e=>e.date===ds);
    const blks=state.calendarMarkers.blocks.filter(b=>ds>=b.startDate && ds<=b.endDate);
    if(!evs.length && !blks.length){ blockEl.classList.add('hidden'); return; }
    blockEl.classList.remove('hidden');
    const chips=[];
    blks.forEach(b=>chips.push(`<div class="flex items-center gap-1 text-[11px] px-2 py-1 rounded" style="background:${hexToRgba(b.color,.15)};border-left:3px solid ${b.color}">
        <span class="text-slate-700 flex-1 truncate">📌 ${escapeHtml(b.text)} <span class="text-slate-400">(${b.startDate}~${b.endDate})</span></span>
        <button onclick="openEditBlockMarkerModal('${b.id}')" class="text-slate-500 hover:text-indigo-600 px-1" title="编辑">✎</button>
        <button onclick="(function(){ const id='${b.id}'; openConfirmModal('删除该整体标记？',()=>{ state.calendarMarkers.blocks=state.calendarMarkers.blocks.filter(x=>x.id!==id); saveData(); renderCalendar(); const s=selectedCalDate; if(s)showCalDayDetail(s); showToast('已删除'); }); })()" class="text-slate-500 hover:text-red-600 px-1" title="删除">✕</button>
    </div>`));
    evs.forEach(e=>chips.push(`<div class="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-white border" style="border-left:3px solid ${e.color}">
        <span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${e.color}"></span>
        <span class="text-slate-700 flex-1 truncate">${escapeHtml(e.text)} <span class="text-slate-400">(${e.date})</span></span>
        <button onclick="openEditEventMarkerModal('${e.id}')" class="text-slate-500 hover:text-indigo-600 px-1" title="编辑">✎</button>
        <button onclick="(function(){ const id='${e.id}'; openConfirmModal('删除该事件标记？',()=>{ state.calendarMarkers.events=state.calendarMarkers.events.filter(x=>x.id!==id); saveData(); renderCalendar(); const s=selectedCalDate; if(s)showCalDayDetail(s); showToast('已删除'); }); })()" class="text-slate-500 hover:text-red-600 px-1" title="删除">✕</button>
    </div>`));
    listEl.innerHTML=chips.join('');
}
/* hex→rgba，用于整体标记半透明底色 */
function hexToRgba(hex, alpha){
    const h=(hex||'#888888').replace('#','');
    const n=h.length===3?h.split('').map(c=>c+c).join(''):h;
    const r=parseInt(n.substr(0,2),16)||136, g=parseInt(n.substr(2,2),16)||136, b=parseInt(n.substr(4,2),16)||136;
    return `rgba(${r},${g},${b},${alpha})`;
}

/* v9 月视图重构：方框替代纯数字，事件以文字标签形式显示在单元格内 */
function renderCalendar(){
    const grid=document.getElementById('calendarGrid');
    const first=new Date(calYear, calMonth, 1);
    const last=new Date(calYear, calMonth+1, 0);
    const firstDow=first.getDay();
    const cells=[];
    for(let i=0;i<firstDow;i++) cells.push({empty:true});
    for(let d=1;d<=last.getDate();d++){
        const ds=`${calYear}-${pad2(calMonth+1)}-${pad2(d)}`;
        const mins=dayTotalMinutes(ds);
        const rate=datedOverallPercent(ds);
        let intensity='';
        if(mins>=300||rate>=100) intensity='bg-primary-600 text-white';
        else if(mins>=120||rate>=80) intensity='bg-primary-400 text-white';
        else if(mins>=60||rate>=50) intensity='bg-primary-200';
        else if(mins>=15||rate>0) intensity='bg-primary-100';
        else intensity='bg-slate-50';
        const blocks=state.calendarMarkers.blocks.filter(b=>ds>=b.startDate && ds<=b.endDate);
        const events=state.calendarMarkers.events.filter(e=>e.date===ds);
        cells.push({ empty:false, d, ds, intensity, mins, rate, isToday: ds===todayStr(), blocks, events });
    }
    grid.innerHTML=cells.map(c=>{
        if(c.empty) return '<div class="min-h-[90px]"></div>';
        const border=c.isToday?'ring-2 ring-primary-500 ring-offset-1':'';
        let blockLayers=c.blocks.map(b=>`linear-gradient(${hexToRgba(b.color,.22)},${hexToRgba(b.color,.22)})`).join(',');
        const bgStyle=blockLayers?`background-image:${blockLayers}; background-blend-mode:multiply;`:'';
        // 事件标签（文字）显示，最多显示2条，超出+N
        const maxShow=2;
        const shownEvents=c.events.slice(0,maxShow);
        const moreCount=Math.max(0,c.events.length-maxShow);
        const eventChips=shownEvents.map(e=>`<div class="flex items-center gap-1 w-full px-1 py-0.5 rounded text-[9px] leading-tight truncate" style="background:${hexToRgba(e.color,.18)};color:${e.color};border-left:2px solid ${e.color};" title="${escapeHtml(e.text)}">
            <span class="truncate">${escapeHtml(e.text)}</span>
        </div>`).join('');
        const moreChip=moreCount>0?`<div class="w-full text-[9px] text-slate-500 px-1 leading-tight">+${moreCount} 更多</div>`:'';
        // 整体标记（block）文字也显示一条
        const blockChip=c.blocks.length?`<div class="flex items-center gap-1 w-full px-1 py-0.5 rounded text-[9px] leading-tight truncate" style="background:${hexToRgba(c.blocks[0].color,.15)};border-left:2px solid ${c.blocks[0].color};" title="${escapeHtml(c.blocks[0].text)}">
            <span class="truncate">📌 ${escapeHtml(c.blocks[0].text)}</span>
        </div>`:'';
        return `<div class="cal-cell relative min-h-[90px] ${c.intensity} ${border} rounded-lg flex flex-col cursor-pointer text-[10px] p-1 gap-0.5 overflow-hidden" style="${bgStyle}" onclick="showCalDayDetail('${c.ds}')">
            <div class="flex items-center justify-between w-full flex-shrink-0">
                <span class="font-semibold">${c.d}</span>
                ${c.mins?`<span class="text-[8px] opacity-75">${formatHours(c.mins)}</span>`:''}
            </div>
            <div class="flex-1 flex flex-col gap-0.5 w-full overflow-hidden">
                ${blockChip}
                ${eventChips}
                ${moreChip}
            </div>
        </div>`;
    }).join('');
}
function showCalDayDetail(ds){
    selectedCalDate=ds;
    // v7 先渲染当日标记（右上角/上方区块）
    renderDayMarkers(ds);
    const mins=dayTotalMinutes(ds);
    const counts=datedTaskCounts(ds);
    const rate=counts.total?Math.round(counts.done/counts.total*100):0;
    const dow=['日','一','二','三','四','五','六'][new Date(ds+'T00:00:00').getDay()];
    const sessions=state.sessions.filter(s=>s.date===ds).sort((a,b)=>(a.startTs||0)-(b.startTs||0));
    let tasks=[];
    state.subjects.forEach(sub=>{
        datedDailyTasks(sub,ds).forEach(t=>tasks.push({sub:sub.name, text:t.text, done:t.completed}));
    });
    state.globalDailyTasks.forEach(t=>{ if(t.date===ds) tasks.push({sub:'自由', text:t.text, done:t.completed}); });
    const html=`<div class="space-y-3 text-sm">
        <div class="bg-slate-50 rounded-lg p-3 space-y-1">
            <div class="font-semibold text-slate-800 flex items-center justify-between">
                <span>${ds} 星期${dow}</span>
                <span class="flex gap-1">
                    <button onclick="openAddEventMarkerModal('${ds}')" class="text-[10px] bg-rose-50 text-rose-600 hover:bg-rose-100 px-1.5 py-0.5 rounded">+事件</button>
                    <button onclick="openAddBlockMarkerModal('${ds}')" class="text-[10px] bg-violet-50 text-violet-600 hover:bg-violet-100 px-1.5 py-0.5 rounded">+整体</button>
                </span>
            </div>
            <div class="text-xs grid grid-cols-3 gap-2 mt-2">
                <div><span class="text-slate-400">时长</span><br><b class="text-primary-600">${formatHours(mins)}</b></div>
                <div><span class="text-slate-400">任务</span><br><b class="text-emerald-600">${counts.done}/${counts.total}</b></div>
                <div><span class="text-slate-400">完成率</span><br><b class="text-indigo-600">${rate}%</b></div>
            </div>
        </div>
        ${tasks.length?`<div class="bg-slate-50 rounded-lg p-3">
            <div class="text-xs text-slate-500 mb-1.5">📋 任务列表</div>
            ${tasks.map(t=>`<div class="text-xs py-0.5 ${t.done?'text-slate-400 line-through':''}">${t.done?'✅':'⬜'} [${escapeHtml(t.sub)}] ${escapeHtml(t.text)}</div>`).join('')}
        </div>`:''}
        ${sessions.length?`<div class="bg-slate-50 rounded-lg p-3">
            <div class="text-xs text-slate-500 mb-1.5">⏱ 计时记录 (${sessions.length})</div>
            ${sessions.map(s=>{
                const sub=state.subjects.find(x=>x.id===s.subjectId);
                const sessionName=s.subjectGroup?s.subjectGroup+'（科目汇总）':(sub?.name||'');
                const st=new Date(s.startTs||0), en=new Date(s.endTs||0);
                return `<div class="text-xs py-0.5 flex justify-between"><span>· ${pad2(st.getHours())}:${pad2(st.getMinutes())}-${pad2(en.getHours())}:${pad2(en.getMinutes())} ${escapeHtml(sessionName)}</span><span class="text-primary-600 font-semibold">${formatHours(s.minutes)}</span></div>`;
            }).join('')}
        </div>`:''}
    </div>`;
    document.getElementById('dayDetail').innerHTML=html;
}
function renderMonthBar(){
    const canvas=document.getElementById('monthBarChart');
    const empty=document.getElementById('monthBarEmpty');
    const days=new Date(calYear, calMonth+1, 0).getDate();
    const labels=[], data=[];
    for(let d=1;d<=days;d++){
        const ds=`${calYear}-${pad2(calMonth+1)}-${pad2(d)}`;
        labels.push(d);
        data.push(dayTotalMinutes(ds));
    }
    const total=data.reduce((a,b)=>a+b,0);
    if(total===0){ empty.classList.remove('hidden'); if(charts.monthBar){charts.monthBar.destroy();charts.monthBar=null;} canvas.parentElement.querySelector('canvas')?.setAttribute('height','200'); return; }
    empty.classList.add('hidden');
    if(charts.monthBar){ charts.monthBar.destroy(); charts.monthBar=null; }
    try{
        charts.monthBar=new Chart(canvas,{
            type:'bar',
            data:{ labels, datasets:[{ label:'学习时长(分钟)', data, backgroundColor:'rgba(14,165,233,.6)', borderRadius:4 }]},
            options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true, ticks:{font:{size:10}}}, x:{ticks:{font:{size:9}, maxTicksLimit:15}}}}
        });
    }catch(e){}
}

/* ---------- 复盘：年视图 ---------- */
function renderYearReview(){
    const grid=document.getElementById('yearGrid');
    const title=document.getElementById('yearGridTitle');
    if(!grid) return;
    const year=annualGridYear;
    if(title) title.textContent=`📅 ${year} 年度学习表`;
    const monthNames=['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
    let html='<div class="year-grid-row year-grid-header"><div class="year-grid-day-label">日期</div>';
    html+=monthNames.map(name=>`<div class="year-grid-month">${name}</div>`).join('')+'</div>';
    for(let day=1;day<=31;day++){
        html+=`<div class="year-grid-row"><div class="year-grid-day-label">${day}</div>`;
        for(let month=0;month<12;month++){
            const lastDay=new Date(year,month+1,0).getDate();
            if(day>lastDay){ html+='<div class="year-grid-cell year-grid-cell-empty">-</div>'; continue; }
            const ds=`${year}-${pad2(month+1)}-${pad2(day)}`;
            const today=ds===todayStr()?' year-grid-cell-today':'';
            const value=escapeHtml((state.annualNotes&&state.annualNotes[ds])||'');
            html+=`<div class="year-grid-cell${today}" title="${ds}"><input class="year-grid-input" type="text" value="${value}" placeholder="" aria-label="${ds}" oninput="saveAnnualNote('${ds}',this.value)"></div>`;
        }
        html+='</div>';
    }
    grid.innerHTML=html;
}
function changeAnnualGridYear(delta){
    annualGridYear+=Number(delta)||0;
    renderYearReview();
}
function saveAnnualNote(dateStr, value){
    if(!state.annualNotes||typeof state.annualNotes!=='object') state.annualNotes={};
    const text=String(value||'').trim();
    if(text) state.annualNotes[dateStr]=text;
    else delete state.annualNotes[dateStr];
    saveData();
}
function renderDailyTimeChart(){
    const canvas=document.getElementById('dailyTimeChart');
    const empty=document.getElementById('dailyTimeEmpty');
    const filter=document.getElementById('timeFilter')?.value||'all';
    const labels=[], data=[];
    const year=new Date().getFullYear();
    const today=new Date();
    const endMs=today.getTime();
    const startMs=new Date(year,0,1).getTime();
    const dayMs=86400000;
    for(let t=startMs; t<=endMs; t+=dayMs){
        const ds=formatDate(new Date(t));
        labels.push(`${new Date(t).getMonth()+1}/${new Date(t).getDate()}`);
        let mins=0;
        state.sessions.forEach(s=>{
            if(s.date!==ds) return;
            if(filter!=='all' && s.subjectId!==filter) return;
            mins+=Number(s.minutes)||0;
        });
        data.push(mins);
    }
    const total=data.reduce((a,b)=>a+b,0);
    if(total===0){ empty.classList.remove('hidden'); if(charts.dailyTime){charts.dailyTime.destroy();charts.dailyTime=null;} return; }
    empty.classList.add('hidden');
    if(charts.dailyTime){ charts.dailyTime.destroy(); charts.dailyTime=null; }
    try{
        charts.dailyTime=new Chart(canvas,{
            type:'line',
            data:{ labels, datasets:[{ label:'学习时长(分钟)', data, borderColor:'#0ea5e9', backgroundColor:'rgba(14,165,233,.1)', fill:true, tension:.3, pointRadius:0, borderWidth:2 }]},
            options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true, ticks:{font:{size:10}}}, x:{ticks:{font:{size:9}, maxTicksLimit:12}}}}
        });
    }catch(e){}
}
function renderHourChart(){
    const canvas=document.getElementById('hourChart');
    const empty=document.getElementById('hourEmpty');
    const buckets=Array(24).fill(0);
    state.sessions.forEach(s=>{
        if(!s.startTs) return;
        const h=new Date(s.startTs).getHours();
        buckets[h]+=Number(s.minutes)||0;
    });
    const labels=buckets.map((_,i)=>pad2(i));
    const total=buckets.reduce((a,b)=>a+b,0);
    if(total===0){ empty.classList.remove('hidden'); if(charts.hour){charts.hour.destroy();charts.hour=null;} return; }
    empty.classList.add('hidden');
    // 分析
    let peak=0, peakH=0;
    buckets.forEach((v,i)=>{ if(v>peak){peak=v;peakH=i;} });
    const morning=buckets.slice(6,12).reduce((a,b)=>a+b,0);
    const afternoon=buckets.slice(12,18).reduce((a,b)=>a+b,0);
    const evening=buckets.slice(18,24).reduce((a,b)=>a+b,0);
    let conclusion='';
    const pct=v=>total?Math.round(v/total*100):0;
    if(morning>=afternoon&&morning>=evening) conclusion=`你是【晨型学习者】，上午(${pct(morning)}%)效率最高。最黄金时段：${pad2(peakH)}:00`;
    else if(afternoon>=morning&&afternoon>=evening) conclusion=`你是【午后学习者】，下午(${pct(afternoon)}%)状态最佳。最黄金时段：${pad2(peakH)}:00`;
    else conclusion=`你是【夜猫子型】，晚间(${pct(evening)}%)最适合学习。最黄金时段：${pad2(peakH)}:00`;
    document.getElementById('habitAnalysis').textContent=conclusion;
    if(charts.hour){ charts.hour.destroy(); charts.hour=null; }
    try{
        charts.hour=new Chart(canvas,{
            type:'bar',
            data:{ labels, datasets:[{ label:'学习分钟', data, backgroundColor:buckets.map((v,i)=> i===peakH?'#0ea5e9':'rgba(14,165,233,.35)'), borderRadius:4 }]},
            options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true, ticks:{font:{size:10}}}, x:{ticks:{font:{size:9}}}}}
        });
    }catch(e){}
}

/* ---------- 复盘：习惯 ---------- */
function renderHabitReview(){
    let totalMins=0;
    Object.values(state.records||{}).forEach(r=>totalMins+=Number(r&&r.studyMinutes)||0);
    state.sessions.forEach(s=>totalMins+=Number(s.minutes)||0);
    document.getElementById('habitTotalTime').textContent=formatHours(totalMins);
}

/* ---------- 统一渲染 + 初始化 ---------- */
/* 全局捕获初始化错误，避免静默空白 */
window.addEventListener('error', function(e){
    try{
        const tip=document.getElementById('initErrorTip');
        if(tip){ tip.style.display='block'; tip.innerHTML='<b>运行时异常：</b><br>'+escapeHtml(e.message||'')+'<br><span style="color:#64748b;font-size:11px">位置：'+(e.filename||'').split('/').pop()+' : '+ (e.lineno||'')+':'+(e.colno||'')+'</span>'; }
    }catch(_){}
});
/* 安全查询DOM：避免getElementById返回null抛错中断整个渲染 */
function $safe(id){ return document.getElementById(id); }
function setText(id, v){ const el=document.getElementById(id); if(el) el.textContent=v==null?'':String(v); }
function setVal(id, v){ const el=document.getElementById(id); if(el) el.value=v==null?'':String(v); }
function setStyle(id, prop, v){ const el=document.getElementById(id); if(el) el.style[prop]=v; }
function renderAll(){
    try{
        /* 第一步（最重要）：先激活视图显示框架，确保就算后续渲染失败也不会完全空白！ */
        const view=state.currentView||'home';
        document.querySelectorAll('.view').forEach(v=>v.classList.remove('view-active'));
        const elView=document.getElementById('view-'+view);
        if(elView) elView.classList.add('view-active');
        /* 激活侧边栏导航高亮 */
        document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('nav-item-active'));
        let navView=view;
        if(view==='dailyDetail') navView='home';
        if(view==='timer') navView='home';
        const btn=document.querySelector('.nav-item[data-view="'+navView+'"]');
        if(btn) btn.classList.add('nav-item-active');
        setText('mobileTitle', VIEW_TITLES[view]||'');
        applySidebarCollapse();
        /* 第二步：逐个渲染（每个独立try-catch，单个失败不影响其他） */
        try{ renderPersonalPanel(); }catch(err){ console.error('renderPersonalPanel fail:', err); }
        try{ renderHome(); }catch(err){ console.error('renderHome fail:', err); }
        try{ if(view==='dailyDetail') renderDailyDetail(); }catch(err){ console.error('renderDailyDetail fail:', err); }
        try{ if(view==='planning') renderPlanning(); }catch(err){ console.error('renderPlanning fail:', err); }
        try{ if(view==='subjects') renderSubjectCards(); }catch(err){ console.error('renderSubjectCards fail:', err); }
        try{ if(view==='timer'){ renderTimer(); renderSubjectTimeStats(); renderSessionList(); initManualRecordForm(); } }catch(err){ console.error('renderTimer fail:', err); }
        try{ if(view==='review'){ switchReviewTab(state.reviewTab||'week'); renderViewContent(view); } }catch(err){ console.error('renderReview fail:', err); }
        // 复盘标签页默认激活
        try{
            const rt=state.reviewTab||'week';
            ['week','month','year'].forEach(t=>{
                const b=document.getElementById('reviewTab'+(t==='week'?'Week':t==='month'?'Month':'Year'));
                if(b){ if(t===rt) b.classList.add('review-tab-active'); else b.classList.remove('review-tab-active'); }
            });
            ['main','side'].forEach(t=>{
                const btn2=document.getElementById('planningTab'+(t==='main'?'Main':'Side'));
                const pane=document.getElementById('planningPane-'+t);
                if(btn2){ if(t===state.planningTab) btn2.classList.add('planning-tab-active'); else btn2.classList.remove('planning-tab-active'); }
                if(pane){ if(t===state.planningTab) pane.classList.remove('hidden'); else pane.classList.add('hidden'); }
            });
        }catch(_){}
    }catch(err){
        console.error('renderAll top-level error:', err);
        const tip=document.getElementById('initErrorTip');
        if(tip){ tip.style.display='block'; tip.innerHTML='<b>渲染异常：</b><br>'+escapeHtml(err.message||String(err)); }
    }
}
/* ========== 认证UI函数 ========== */
function showAuthModal(){
    const modal = document.getElementById('authModal');
    if(modal){
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
    switchAuthMode('login');
    const rememberedUser=localStorage.getItem(AUTH_USER_KEY)||'';
    const usernameInput=document.getElementById('authUsername');
    const passwordInput=document.getElementById('authPassword');
    if(usernameInput && rememberedUser) usernameInput.value=rememberedUser;
    if(passwordInput) passwordInput.value='';
    // 显示当前后端状态（initApp中已异步检查）
    const statusEl = document.getElementById('authBackendStatus');
    const offlineEl = document.getElementById('authBackendOffline');
    if(_backendOnline === true){
        if(statusEl) statusEl.classList.remove('hidden');
        if(offlineEl) offlineEl.classList.add('hidden');
    }else{
        // null 或 false 均显示离线提示
        if(statusEl) statusEl.classList.add('hidden');
        if(offlineEl) offlineEl.classList.remove('hidden');
    }
    setTimeout(()=>{
        const input=document.getElementById('authUsername');
        if(input) input.focus();
    },100);
}
function hideAuthModal(){
    const modal = document.getElementById('authModal');
    if(modal){
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}
function switchAuthMode(mode){
    authMode = mode;
    const title=document.getElementById('authModalTitle');
    const sub=document.getElementById('authModalSubtitle');
    const btn=document.getElementById('authSubmitBtn');
    const tabLogin=document.getElementById('authTabLogin');
    const tabRegister=document.getElementById('authTabRegister');
    const err=document.getElementById('authError');
    if(err) err.classList.add('hidden');
    if(mode==='login'){
        title.textContent='登录';
        sub.textContent='跨设备同步你的学习进度';
        btn.textContent='登录';
        tabLogin.className='text-primary-600 font-medium';
        tabRegister.className='text-slate-400 hover:text-primary-600';
    }else{
        title.textContent='注册新账号';
        sub.textContent='注册后可在任意设备同步数据';
        btn.textContent='注册';
        tabLogin.className='text-slate-400 hover:text-primary-600';
        tabRegister.className='text-primary-600 font-medium';
    }
}
async function submitAuth(){
    const username=document.getElementById('authUsername').value.trim();
    const password=document.getElementById('authPassword').value;
    const errEl=document.getElementById('authError');
    const btn=document.getElementById('authSubmitBtn');
    if(!username || !password){ errEl.textContent='请输入用户名和密码'; errEl.classList.remove('hidden'); return; }
    errEl.classList.add('hidden');
    btn.disabled=true; btn.textContent='处理中…';
    try{
        if(_backendOnline){
            // 后端在线：走API
            const result = authMode==='login' ? await apiLogin(username, password) : await apiRegister(username, password);
            authToken = result.token;
            authUser = result.username;
            localStorage.setItem(AUTH_TOKEN_KEY, authToken);
            localStorage.setItem(AUTH_USER_KEY, authUser);
            await syncFromBackend();
            loadData();
        }else{
            // 离线模式：本地存储验证
            const userKey = 'local_users';
            let users = [];
            try { users = JSON.parse(localStorage.getItem(userKey) || '[]'); } catch(e) { users = []; }
            
            if(authMode === 'register'){
                if(users.find(u => u.username === username)){
                    throw new Error('该用户名已被注册');
                }
                // 简单哈希密码存储
                const simpleHash = btoa(password + '_salt_' + username);
                users.push({ username, password: simpleHash, createdAt: Date.now() });
                localStorage.setItem(userKey, JSON.stringify(users));
                authUser = username;
                authToken = 'local_' + Date.now();
                localStorage.setItem(AUTH_TOKEN_KEY, authToken);
                localStorage.setItem(AUTH_USER_KEY, authUser);
            } else {
                const user = users.find(u => u.username === username);
                if(!user){
                    throw new Error('用户不存在，请先注册');
                }
                const simpleHash = btoa(password + '_salt_' + username);
                if(user.password !== simpleHash){
                    throw new Error('密码错误');
                }
                authUser = username;
                authToken = 'local_' + Date.now();
                localStorage.setItem(AUTH_TOKEN_KEY, authToken);
                localStorage.setItem(AUTH_USER_KEY, authUser);
                loadData();
            }
        }
        
        hideAuthModal();
        updateAuthUI();
        generatePeriodicTasks();
        initTimerState();
        const today=todayStr();
        checkDailyCheckin(today);
        renderAll();
        saveData();
        showToast(authMode==='login' ? `欢迎回来，${authUser}！` : `注册成功，欢迎${authUser}！`);
    }catch(e){
        let msg = e.message || '操作失败';
        if(e.isNetworkError){
            msg = '无法连接到服务器。当前为离线模式，请直接使用本地账号';
        }
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
    }finally{
        btn.disabled=false;
        btn.textContent = authMode==='login' ? '登录' : '注册';
    }
}
async function logout(){
    if(!authToken) return;
    saveData();
    // 仅在后端在线时调用API
    if(_backendOnline){
        try { await apiLogout(); } catch(e) { /* 离线忽略 */ }
    }
    authToken = '';
    authUser = '';
    localStorage.removeItem(AUTH_TOKEN_KEY);
    // 保留最近一次账号名，用于下次默认填充登录框
    // 账号切换后的默认数据由共享数据层统一创建
    resetStateForAccountSwitch();
    updateAuthUI();
    renderAll();
    showToast('已退出登录');
    setTimeout(showAuthModal, 300);
}
function getLocalUsers(){
    try{
        const users=JSON.parse(localStorage.getItem('local_users')||'[]');
        return Array.isArray(users)?users.filter(user=>user&&user.username):[];
    }catch(e){ return []; }
}
function saveLocalUsers(users){
    localStorage.setItem('local_users', JSON.stringify(users));
}
function openAccountSwitcher(){
    const modal=document.getElementById('accountSwitcherModal');
    const current=document.getElementById('accountCurrentName');
    const list=document.getElementById('accountList');
    const empty=document.getElementById('accountListEmpty');
    if(!modal||!list) return;
    current.textContent=authUser||'未登录';
    const users=getLocalUsers();
    const names=[];
    if(authUser) names.push(authUser);
    users.forEach(user=>{ if(!names.includes(user.username)) names.push(user.username); });
    const otherNames=names.filter(name=>name!==authUser);
    list.innerHTML=otherNames.map(name=>{ const encodedName=encodeURIComponent(name); return `<div class="flex items-center justify-between gap-2 border border-slate-200 rounded-lg px-3 py-2">
        <span class="text-sm text-slate-700 truncate">${escapeHtml(name)}</span>
        <div class="flex items-center gap-2 flex-shrink-0">
            <button onclick="selectAccount(decodeURIComponent('${encodedName}'))" class="text-xs text-primary-600 hover:text-primary-700">使用此账号</button>
            <button onclick="deleteStoredAccount(decodeURIComponent('${encodedName}'))" class="text-xs text-red-400 hover:text-red-500">删除缓存</button>
        </div>
    </div>`; }).join('');
    empty.classList.toggle('hidden', otherNames.length>0);
    modal.classList.remove('hidden');
}
function closeAccountSwitcher(){
    document.getElementById('accountSwitcherModal')?.classList.add('hidden');
}
function switchAccount(){
    saveData();
    closePersonalPanel();
    openAccountSwitcher();
}
function selectAccount(username){
    saveData();
    closeAccountSwitcher();
    authToken='';
    authUser=username;
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.setItem(AUTH_USER_KEY, username);
    resetStateForAccountSwitch();
    updateAuthUI();
    renderAll();
    showAuthModal();
}
function deleteStoredAccount(username){
    if(username===authUser) return;
    const users=getLocalUsers().filter(user=>user.username!==username);
    saveLocalUsers(users);
    openAccountSwitcher();
    showToast('已删除账号缓存，学习数据已保留');
}
function unregisterCurrentAccount(){
    if(!authUser) return;
    const username=authUser;
    openConfirmModal(`确定注销本地账号“${username}”吗？该账号的密码和学习数据都会删除。`,()=>{
        saveLocalUsers(getLocalUsers().filter(user=>user.username!==username));
        localStorage.removeItem(getUserStorageKey(username));
        authToken='';
        localStorage.removeItem(AUTH_TOKEN_KEY);
        localStorage.removeItem(AUTH_USER_KEY);
        closeAccountSwitcher();
        resetStateForAccountSwitch();
        updateAuthUI();
        renderAll();
        showAuthModal();
        showToast('本地账号已注销');
    });
}
function updateAuthUI(){
    const status=document.getElementById('sidebarLoginStatus');
    const btn=document.getElementById('logoutBtn');
    if(_backendOnline === false){
        // 离线模式
        status.textContent = '离线模式';
        status.className = 'text-[10px] text-amber-500 truncate';
        btn.classList.add('hidden');
    } else if(authToken && authUser){
        status.textContent = '已登录: ' + authUser;
        status.className = 'text-[10px] text-emerald-500 truncate';
        btn.classList.remove('hidden');
    } else {
        status.textContent = '未登录';
        status.className = 'text-[10px] text-slate-400 truncate';
        btn.classList.add('hidden');
    }
}

function initApp(){
        // ========== 第一阶段：同步执行，立即渲染 ==========
        
        // 1. 加载数据（独立 try/catch）
        try{ loadData(); }catch(e){ console.warn('loadData 异常:', e); }
        
        // 2. 渲染UI（独立 try/catch，成功后才标记JS就绪）
        let renderOK = false;
        try{
            renderAll();
            renderOK = true;
            // 关键：renderAll 成功后才添加 js-ready，避免视图丢失
            document.body.classList.add('js-ready');
            // 恢复 #view-home 的默认显示控制
            const vh = document.getElementById('view-home');
            if(vh) vh.style.display = '';
        }catch(e){
            console.error('renderAll 异常:', e);
            // renderAll 失败，强制显示总览页作为兜底
            const vh = document.getElementById('view-home');
            if(vh){
                vh.style.display = 'block';
                vh.classList.add('view-active');
            }
        }
        
        // 3. 认证UI + 登录弹窗（独立 try/catch）
        try{
            updateAuthUI();
            // 如果已有登录凭证（离线或在线），不显示登录弹窗
            if(!(authToken && authUser)){
                showAuthModal();
            }else{
                hideAuthModal();
            }
        }catch(e){
            console.warn('认证UI异常:', e);
            // 登录弹窗已在HTML中默认可见，不会消失
        }
        
        // ========== 第二阶段：异步执行，检查后端连通性 ==========
        setTimeout(async ()=>{
            try{
                const backendOK = await checkBackendHealth();
                if(backendOK){
                    _backendOnline = true;
                    // 后端可用：更新登录弹窗状态
                    const statusEl = document.getElementById('authBackendStatus');
                    const offlineEl = document.getElementById('authBackendOffline');
                    if(statusEl) statusEl.classList.remove('hidden');
                    if(offlineEl) offlineEl.classList.add('hidden');
                    // 如果当前已登录，尝试从后端同步数据
                    if(authToken && authUser){
                        try{ await syncFromBackend(); }catch(_){}
                    }
                }else{
                    _backendOnline = false;
                    // 后端不可用：更新状态提示
                    const statusEl = document.getElementById('authBackendStatus');
                    const offlineEl = document.getElementById('authBackendOffline');
                    if(statusEl) statusEl.classList.add('hidden');
                    if(offlineEl) offlineEl.classList.remove('hidden');
                    // 更新侧边栏状态
                    updateAuthUI();
                }
            }catch(e){
                _backendOnline = false;
                updateAuthUI();
            }
        }, 100);
        
        // ========== 第三阶段：后台常驻任务 ==========
        
        // 每秒计时刷新
        setInterval(()=>{
            try{
                if(state.timerState && (state.timerState.running || (typeof timerIntervalId!=='undefined' && timerIntervalId))){
                    updateTimerDisplay();
                }
            }catch(_){}
        },1000);
        
        // 页面关闭前保存
        window.addEventListener('beforeunload', saveData);
        
        // 计时器全屏模式的退出监听
        ['keydown','mousemove','click','touchstart'].forEach(ev=>{
            document.addEventListener(ev,()=>{
                try{
                    if(timerFullscreenActive && state.timerState?.running){
                        exitTimerFullscreen();
                        resetIdleTimer();
                    }else if(state.timerState?.running){
                        resetIdleTimer();
                    }
                }catch(_){}
            });
        });
    }
window.onload=initApp;