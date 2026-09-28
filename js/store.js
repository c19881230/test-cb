/* ========== 共享数据层 ========== */
// 所有页面模块共用的持久化数据只在这里定义和加载。
const STORAGE_KEY = 'study_progress_data_v9';
const AUTH_TOKEN_KEY = 'study_progress_auth_token';
const AUTH_USER_KEY = 'study_progress_auth_user';

let state = createDefaultState();
let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';
let authUser = localStorage.getItem(AUTH_USER_KEY) || '';

function createDefaultState(){
	return {
		username:'', goal:'', sidebarCollapsed:false, currentView:'home', planningTab:'main',
		userAvatar:'学',
		subjects:[], records:{}, midTasks:[], sessions:[], timerState:null,
		periodicTemplates:[], globalDailyTasks:[], longTermPlans:[], weeklyPlans:[],
		mainLines:[], sideLines:[],
		calendarMarkers:{ events:[], blocks:[] },
		showOldUncompleted:false,
		weekTimeConfig:{ startMin:480, endMin:1380, slotMin:60 },
		entertainment:{ categories:[], works:[], progressEnabled:false, categoryId:'', subcategoryId:'', statusFilter:'', page:'home', kinds:[], restrictions:[] },
		classifications:[], annualNotes:{}, dailyDetailDate:null, timerFullscreen:false
	};
}

function getUserStorageKey(username=authUser){
	const safeName=String(username||'').trim();
	return safeName ? `${STORAGE_KEY}_${encodeURIComponent(safeName)}` : STORAGE_KEY;
}

function saveData(){
	localStorage.setItem(getUserStorageKey(), JSON.stringify(state));
	if(typeof syncToBackend==='function') syncToBackend();
}

function loadData(){
	let raw=localStorage.getItem(getUserStorageKey());
	if(!raw && authUser && localStorage.getItem(STORAGE_KEY)){
		raw=localStorage.getItem(STORAGE_KEY);
		localStorage.setItem(getUserStorageKey(), raw);
	}
	if(!raw){
		const oldKeys=['study_progress_data_v8','study_progress_data_v7','study_progress_data_v6','study_progress_data_v5','study_progress_data_v4'];
		for(const key of oldKeys){
			const old=localStorage.getItem(key);
			if(old){ try{ state=JSON.parse(old); break; }catch(e){} }
		}
	}else{
		try{ state=JSON.parse(raw); }catch(e){ state=createDefaultState(); }
	}
	if(!state.subjects||!state.subjects.length){
		state.subjects=[{ id:genId(), name:'默认学科', weight:1, dailyTasks:[], longTasks:[], listenMode:null, listenTarget:0, listenCompleted:0, subModules:[], dailyTaskTemplates:[] }];
	}
	state.subjects.forEach(subject=>{
		if(subject.weight===undefined) subject.weight=1;
		if(!subject.listenMode) subject.listenMode=null;
		if(typeof subject.listenTarget!=='number') subject.listenTarget=0;
		if(typeof subject.listenCompleted!=='number') subject.listenCompleted=0;
		if(!Array.isArray(subject.subModules)) subject.subModules=[];
		if(!Array.isArray(subject.dailyTaskTemplates)) subject.dailyTaskTemplates=[];
		delete subject.timerCategories;
	});
	if(!Array.isArray(state.classifications)||!state.classifications.length){
		state.classifications=[
			{id:genId(),name:'学习',color:CATEGORY_PALETTE[0]},
			{id:genId(),name:'生活',color:CATEGORY_PALETTE[2]},
			{id:genId(),name:'娱乐',color:CATEGORY_PALETTE[3]}
		];
	}
	state.classifications.forEach(classification=>{ if(!classification.color) classification.color=nextCategoryColor(); });
	const firstClsId=defaultClassificationId();
	(state.weeklyPlans||[]).forEach(plan=>{ if(!plan.classificationId) plan.classificationId=firstClsId; });
	(state.sessions||[]).forEach(session=>{ if(!session.classificationId) session.classificationId=firstClsId; });
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
	state.entertainment.categories.forEach(category=>{ if(!Array.isArray(category.subcategories)) category.subcategories=[]; });
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
	if(!state.weekTimeConfig) state.weekTimeConfig={ startMin:480,endMin:1380,slotMin:60 };
	state.weekTimeConfig.startMin=Math.max(0,Math.min(1439,Number(state.weekTimeConfig.startMin)||480));
	state.weekTimeConfig.endMin=Math.max(state.weekTimeConfig.startMin+15,Math.min(1440,Number(state.weekTimeConfig.endMin)||1380));
	state.weekTimeConfig.slotMin=Math.max(15,Math.min(1440,Number(state.weekTimeConfig.slotMin)||60));
	if(!Array.isArray(state.mainLines)) state.mainLines=[];
	if(!Array.isArray(state.sideLines)) state.sideLines=[];
	const hasOldData=(state.longTermPlans&&state.longTermPlans.length)||(state.midTasks&&state.midTasks.length)||(state.periodicTemplates&&state.periodicTemplates.some(template=>!template.mainLineId));
	if(hasOldData && state.sideLines.length===0){
		const migrateLine={ id:genId(), name:'迁移支线', description:'由旧版长期计划/中期任务/周期模板自动合并生成', deadline:'', createdAt:Date.now(), chapters:[], weeklyTasks:[] };
		(state.longTermPlans||[]).forEach(plan=>{
			migrateLine.chapters.push({ id:genId(), title:plan.text, percent:plan.percent||0, createdAt:Date.now() });
		});
		(state.midTasks||[]).forEach(task=>{
			migrateLine.chapters.push({ id:genId(), title:task.title+(task.deadline?' ('+task.deadline+')':''), percent:midTaskPercent(task), createdAt:Date.now() });
		});
		(state.periodicTemplates||[]).forEach(template=>{
			if(!template.mainLineId){
				migrateLine.weeklyTasks.push({ id:genId(), content:template.content, subjectId:template.subjectId||'', scheduleType:template.scheduleType||'daily', weekdays:template.weekdays||[], enabled:template.enabled!==false });
			}
		});
		state.sideLines.push(migrateLine);
	}
	if(!state.calendarMarkers) state.calendarMarkers={ events:[], blocks:[] };
	if(!Array.isArray(state.calendarMarkers.events)) state.calendarMarkers.events=[];
	if(!Array.isArray(state.calendarMarkers.blocks)) state.calendarMarkers.blocks=[];
	(state.weeklyPlans||[]).forEach(plan=>{
		if(typeof plan.startMin!=='number' && typeof plan.startHour==='number') plan.startMin=plan.startHour;
		if(typeof plan.endMin!=='number' && typeof plan.endHour==='number') plan.endMin=plan.endHour;
		if(typeof plan.startMin!=='number') plan.startMin=8*60;
		if(typeof plan.endMin!=='number') plan.endMin=9*60;
		if(typeof plan.completed!=='boolean') plan.completed=false;
	});
	const today=todayStr();
	const cutoff=new Date(today+'T00:00:00'); cutoff.setDate(cutoff.getDate()-30);
	const cutoffStr=formatDate(cutoff);
	state.weeklyPlans=state.weeklyPlans.filter(plan=>plan.completed || !(plan.date && plan.date<cutoffStr));
	if(state.showOldUncompleted===undefined) state.showOldUncompleted=false;
	if(typeof state.username!=='string') state.username='';
	if(typeof state.userAvatar!=='string'||!state.userAvatar) state.userAvatar='学';
	if(typeof state.goal!=='string') state.goal='';
	if(!state.currentView) state.currentView='home';
	if(state.sidebarCollapsed===undefined) state.sidebarCollapsed=false;
	if(state.timerFocus===undefined) state.timerFocus=false;
	if(!state.reviewTab) state.reviewTab='week';
	if(!state.planningTab) state.planningTab='main';
	if(!state.dailyDetailDate) state.dailyDetailDate=today;
	if(state.timerFullscreen===undefined) state.timerFullscreen=false;
	const normalizeTaskTemplate=function(template){
		if(!template) return template;
		if(!template.scheduleMode){ template.scheduleMode=template.scheduleType||'daily'; delete template.scheduleType; }
		if(!['daily','weekly','memory'].includes(template.scheduleMode)) template.scheduleMode='daily';
		if(!Array.isArray(template.weekdays)) template.weekdays=[];
		if(typeof template.memoryDurationMonths!=='number'||template.memoryDurationMonths<=0) template.memoryDurationMonths=12;
		if(!template.memoryStartDate) template.memoryStartDate=today;
		if(template.enabled===undefined) template.enabled=true;
		if(!template._isSubjectTemplate&&(!Number.isFinite(Number(template.weeklyTargetCount))||Number(template.weeklyTargetCount)<1)) template.weeklyTargetCount=1;
		return template;
	};
	(state.mainLines||[]).forEach(line=>{ if(!Array.isArray(line.weeklyTasks)) line.weeklyTasks=[]; line.weeklyTasks.forEach(normalizeTaskTemplate); });
	(state.sideLines||[]).forEach(line=>{ if(!Array.isArray(line.weeklyTasks)) line.weeklyTasks=[]; line.weeklyTasks.forEach(normalizeTaskTemplate); });
	(state.periodicTemplates||[]).forEach(normalizeTaskTemplate);
	(state.subjects||[]).forEach(subject=>{ (subject.dailyTaskTemplates||[]).forEach(normalizeTaskTemplate); });
	if(['daily','masterplan','periodic','midterm','timer'].includes(state.currentView)){
		if(state.currentView==='daily') state.currentView='dailyDetail';
		else if(state.currentView!=='timer') state.currentView='planning';
	}
	if(['stats','weekly'].includes(state.currentView)) state.currentView='review';
}

function resetStateForAccountSwitch(){
	state=createDefaultState();
}
