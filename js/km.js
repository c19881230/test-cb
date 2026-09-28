/* ========== 学科交互模块 ========== */
// 页面事件只调用这里的公开入口，具体数据仍由 store.js 提供。
function renderSubjectCards(){ return subjectRenderCards(); }
function renderSubjectDetail(subject){ return subjectRenderDetail(subject); }
function toggleSubjectExpand(id){ return subjectToggleExpand(id); }
function addSubjectDailyTask(subjectId){ return subjectAddDailyTask(subjectId); }
function toggleListenMode(subjectId){ return subjectToggleListenMode(subjectId); }
function listenSetTarget(subjectId){ return subjectListenSetTarget(subjectId); }
function listenAdd(subjectId, delta){ return subjectListenAdd(subjectId, delta); }
function subModAdd(subjectId, moduleId, delta){ return subjectSubModAdd(subjectId, moduleId, delta); }
function deleteSubModule(subjectId, moduleId){ return subjectDeleteSubModule(subjectId, moduleId); }
function openAddSubjectModal(){ return subjectOpenAddModal(); }
function closeAddSubjectModal(){ return subjectCloseAddModal(); }
function addSubject(){ return subjectAdd(); }
function renameSubjectStart(id){ return subjectRenameStart(id); }
function renameSubjectDirect(id){ return subjectRenameDirect(id); }
function closeRenameSubjectModal(){ return subjectCloseRenameModal(); }
function renameSubject(){ return subjectRename(); }
function deleteSubject(id){ return subjectDelete(id); }
function openSubModuleModal(subjectId, moduleId){ return subjectOpenSubModuleModal(subjectId, moduleId); }
function closeSubModuleModal(){ return subjectCloseSubModuleModal(); }
function saveSubModule(){ return subjectSaveSubModule(); }
function openSubDailyTplModal(subjectId, templateId){ return subjectOpenSubDailyTplModal(subjectId, templateId); }
function closeSubDailyTplModal(){ return subjectCloseSubDailyTplModal(); }
function onSdtScheduleChange(){ return subjectOnSdtScheduleChange(); }
function saveSubDailyTpl(){ return subjectSaveSubDailyTpl(); }
function deleteSubDailyTpl(){ return subjectDeleteSubDailyTpl(); }
function deleteSubDailyTplDirect(subjectId, templateId){ return subjectDeleteSubDailyTplDirect(subjectId, templateId); }

/* ---------- 学科每日任务周期模板 ---------- */
let editingSdtId=null;
function subjectOpenSubDailyTplModal(subjectId, tplId){
	if(!subjectId) return;
	document.getElementById('sdtSubjectId').value=subjectId;
	editingSdtId=tplId||null;
	const bindWeeklyLabels=function(wrapId, checkedDays){
		const wrap=document.getElementById(wrapId);
		if(!wrap) return;
		wrap.querySelectorAll('label').forEach(label=>{
			const checkbox=label.querySelector('input');
			label.onclick=function(event){
				event.preventDefault();
				checkbox.checked=!checkbox.checked;
				label.style.background=checkbox.checked?'rgba(14,165,233,.1)':'';
				label.style.borderColor=checkbox.checked?'#0ea5e9':'#e2e8f0';
				label.style.color=checkbox.checked?'#0369a1':'';
			};
			const checked=(checkedDays||[]).includes(Number(checkbox.value));
			checkbox.checked=checked;
			label.style.background=checked?'rgba(14,165,233,.1)':'';
			label.style.borderColor=checked?'#0ea5a9':'#e2e8f0';
			label.style.color=checked?'#0369a1':'';
		});
	};
	const subject=state.subjects.find(item=>item.id===subjectId);
	const today=todayStr();
	const template=tplId&&subject?(subject.dailyTaskTemplates||[]).find(item=>item.id===tplId):null;
	document.getElementById('sdtModalTitle').textContent=template?'编辑学科每日周期任务':'新增学科每日周期任务';
	document.getElementById('sdtContentInput').value=template?.content||'';
	document.getElementById('sdtTypeInput').value=template?.scheduleMode||template?.scheduleType||'daily';
	document.getElementById('sdtDeleteBtn').classList.toggle('hidden',!template);
	document.getElementById('sdtEditId').value=tplId||'';
	bindWeeklyLabels('sdtWeeklyDays',template?.weekdays||[]);
	document.getElementById('sdtMemoryMonths').value=String(template?.memoryDurationMonths||12);
	document.getElementById('sdtMemoryStartDate').value=template?.memoryStartDate||today;
	subjectOnSdtScheduleChange();
	document.getElementById('subDailyTplModal').classList.remove('hidden');
}
function subjectCloseSubDailyTplModal(){ document.getElementById('subDailyTplModal').classList.add('hidden'); editingSdtId=null; }
function subjectOnSdtScheduleChange(){
	const mode=document.getElementById('sdtTypeInput').value;
	document.getElementById('sdtWeeklyDaysWrap').classList.toggle('hidden',mode!=='weekly');
	document.getElementById('sdtMemoryWrap').classList.toggle('hidden',mode!=='memory');
	if(mode==='memory'&&!document.getElementById('sdtMemoryStartDate').value) document.getElementById('sdtMemoryStartDate').value=todayStr();
}
function subjectSaveSubDailyTpl(){
	const subjectId=document.getElementById('sdtSubjectId').value;
	const subject=state.subjects.find(item=>item.id===subjectId);
	if(!subject){ subjectCloseSubDailyTplModal(); return; }
	const content=(document.getElementById('sdtContentInput').value||'').trim();
	if(!content){ showToast('请输入任务内容'); return; }
	const scheduleMode=document.getElementById('sdtTypeInput').value;
	const weekdays=scheduleMode==='weekly'?[...document.querySelectorAll('#sdtWeeklyDays input:checked')].map(input=>Number(input.value)):[];
	if(scheduleMode==='weekly'&&!weekdays.length){ showToast('请选择星期'); return; }
	const memoryDurationMonths=scheduleMode==='memory'?Math.max(1,Number(document.getElementById('sdtMemoryMonths').value)||12):12;
	const memoryStartDate=scheduleMode==='memory'?(document.getElementById('sdtMemoryStartDate').value||todayStr()):todayStr();
	if(!subject.dailyTaskTemplates) subject.dailyTaskTemplates=[];
	const template=editingSdtId&&subject.dailyTaskTemplates.find(item=>item.id===editingSdtId);
	if(template){
		template.content=content; template.scheduleMode=scheduleMode; delete template.scheduleType;
		template.weekdays=weekdays; template.memoryDurationMonths=memoryDurationMonths; template.memoryStartDate=memoryStartDate; template.enabled=true;
	}else{
		subject.dailyTaskTemplates.push({id:genId(),content,scheduleMode,weekdays,memoryDurationMonths,memoryStartDate,enabled:true});
	}
	saveData(); subjectCloseSubDailyTplModal(); renderSubjectCards(); showToast('已保存');
}
function subjectDeleteSubDailyTpl(){
	const subjectId=document.getElementById('sdtSubjectId').value;
	const subject=state.subjects.find(item=>item.id===subjectId);
	if(!subject||!editingSdtId){ subjectCloseSubDailyTplModal(); return; }
	openConfirmModal('确定删除该学科每日周期任务模板？',()=>{
		subject.dailyTaskTemplates=(subject.dailyTaskTemplates||[]).filter(item=>item.id!==editingSdtId);
		saveData(); subjectCloseSubDailyTplModal(); renderSubjectCards(); showToast('已删除');
	});
}
function subjectDeleteSubDailyTplDirect(subjectId, templateId){
	const subject=state.subjects.find(item=>item.id===subjectId);
	if(!subject||!templateId) return;
	openConfirmModal('确定删除该学科每日周期任务模板？',()=>{
		subject.dailyTaskTemplates=(subject.dailyTaskTemplates||[]).filter(item=>item.id!==templateId);
		saveData(); renderSubjectCards(); showToast('已删除');
	});
}

/* ---------- 科目进度与总进度 ---------- */
function listenPercent(subject){
	if(!subject.listenMode||!subject.listenTarget||subject.listenTarget<=0) return 0;
	return Math.min(100,Math.round((subject.listenCompleted||0)/subject.listenTarget*100));
}
function subModulePercent(module){
	if(!module.target||module.target<=0) return 0;
	return Math.min(100,Math.round((module.current||0)/module.target*100));
}
function subjectPercent(subject){
	const parts=[];
	if(subject.listenMode&&subject.listenTarget>0) parts.push(listenPercent(subject));
	(subject.subModules||[]).forEach(module=>{ if(module.target>0) parts.push(subModulePercent(module)); });
	if(parts.length) return Math.round(parts.reduce((total,value)=>total+value,0)/parts.length);
	const tasks=[...(subject.dailyTasks||[]),...(subject.longTasks||[])];
	return tasks.length?Math.round(tasks.filter(task=>task.completed).length/tasks.length*100):0;
}
function subjectGroupPercent(subjects){
	let weightTotal=0, weighted=0;
	subjects.forEach(subject=>{
		const weight=Math.max(0.1,Number(subject.weight)||1);
		weightTotal+=weight;
		weighted+=subjectPercent(subject)*weight;
	});
	return weightTotal?Math.round(weighted/weightTotal):0;
}
function subjectDailyPercent(subject,dateStr){
	const tasks=datedDailyTasks(subject,dateStr||todayStr());
	return tasks.length?Math.round(tasks.filter(task=>task.completed).length/tasks.length*100):0;
}
function overallPercent(){
	let weightTotal=0, weighted=0;
	(state.subjects||[]).forEach(subject=>{
		const weight=Number(subject.weight)||1;
		weightTotal+=weight;
		weighted+=subjectPercent(subject)*weight;
	});
	return weightTotal?Math.round(weighted/weightTotal):0;
}
function datedOverallPercent(dateStr){
	const date=dateStr||todayStr();
	let done=0,total=0;
	(state.subjects||[]).forEach(subject=>{
		const tasks=datedDailyTasks(subject,date);
		total+=tasks.length;
		done+=tasks.filter(task=>task.completed).length;
	});
	(state.globalDailyTasks||[]).forEach(task=>{ if(task.date===date){ total++; if(task.completed) done++; } });
	return total?Math.round(done/total*100):0;
}
function datedTaskCounts(dateStr){
	const date=dateStr||todayStr();
	let done=0,total=0;
	(state.subjects||[]).forEach(subject=>{
		const tasks=datedDailyTasks(subject,date);
		total+=tasks.length;
		done+=tasks.filter(task=>task.completed).length;
	});
	(state.globalDailyTasks||[]).forEach(task=>{ if(task.date===date){ total++; if(task.completed) done++; } });
	return {done,total};
}

/* ---------- 个人面板中的科目进度 ---------- */
function renderPersonalPanel(){
	document.getElementById('ppAvatar').textContent=state.userAvatar||'学';
	document.getElementById('sidebarAvatar').textContent=state.userAvatar||'学';
	document.getElementById('homeAvatarEntry').textContent=state.userAvatar||'学';
	const name=state.username||'学习者';
	document.getElementById('ppUsername').textContent=name;
	document.getElementById('sidebarUsername').textContent=name;
	let totalCheckin=0;
	Object.values(state.records||{}).forEach(record=>{ if(record&&record.checkedIn) totalCheckin++; });
	document.getElementById('ppTotalCheckin').textContent=totalCheckin;
	let totalMinutes=0;
	Object.values(state.records||{}).forEach(record=>{ totalMinutes+=Number(record&&record.studyMinutes)||0; });
	(state.sessions||[]).forEach(session=>{ totalMinutes+=Number(session.minutes)||0; });
	document.getElementById('ppTotalTime').textContent=formatHours(totalMinutes);
	document.getElementById('ppOverallPct').textContent=overallPercent();
	document.getElementById('ppSessions').textContent=(state.sessions||[]).length;
	document.getElementById('ppSubjects').textContent=(state.subjects||[]).length;
	document.getElementById('ppGoal').textContent=state.goal||'未设置大目标';
	const list=document.getElementById('ppSubjectProgress');
	const empty=document.getElementById('ppSubjectEmpty');
	if(!state.subjects.length){ list.innerHTML=''; empty.classList.remove('hidden'); return; }
	empty.classList.add('hidden');
	const groups=[...new Set(state.subjects.map(subject=>(subject.group||'').trim()).filter(Boolean))];
	list.innerHTML=groups.map(group=>{
		const percent=subjectGroupPercent(state.subjects.filter(subject=>subject.group===group));
		return `<div class="bg-sky-50 rounded-lg p-2"><div class="flex items-center justify-between mb-1"><span class="text-xs font-medium text-sky-700 truncate">${escapeHtml(group)}（科目汇总）</span><span class="text-xs font-bold text-primary-600">${percent}%</span></div><div class="w-full bg-white rounded-full h-1.5 overflow-hidden"><div class="progress-bar-fill bg-gradient-to-r from-sky-400 to-indigo-500 h-full rounded-full" style="width:${percent}%"></div></div></div>`;
	}).join('')+state.subjects.map(subject=>{
		const percent=subjectPercent(subject);
		return `<div class="bg-slate-50 rounded-lg p-2"><div class="flex items-center justify-between mb-1"><span class="text-xs font-medium text-slate-700 truncate">${escapeHtml(subject.name)}</span><span class="text-xs font-bold text-primary-600">${percent}%</span></div><div class="w-full bg-white rounded-full h-1.5 overflow-hidden"><div class="progress-bar-fill bg-gradient-to-r from-primary-400 to-primary-600 h-full rounded-full" style="width:${percent}%"></div></div></div>`;
	}).join('');
}
