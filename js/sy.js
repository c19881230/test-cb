/* ---------- 总览页面交互 ---------- */
function renderHome(){
	document.getElementById('usernameInput').value=state.username;
	document.getElementById('goalInput').value=state.goal;
	document.getElementById('homeUsername').textContent=state.username||'学习者';
	document.getElementById('sidebarAvatar').textContent=state.userAvatar||'学';
	document.getElementById('homeAvatarEntry').textContent=state.userAvatar||'学';
	document.getElementById('sidebarUsername').textContent=state.username||'学习者';
	const pct=overallPercent();
	const circ=2*Math.PI*50;
	document.getElementById('goalRing').style.strokeDashoffset=circ-pct/100*circ;
	document.getElementById('goalRingPercent').textContent=pct+'%';
	const tp=datedOverallPercent(todayStr());
	document.getElementById('homeTodayPercent').textContent=tp+'%';
	renderHomeTodayTasks();
	const todayMin=dayTotalMinutes(todayStr());
	const homeTimerTime=document.getElementById('homeTimerTodayTime');
	if(homeTimerTime) homeTimerTime.textContent=formatHours(todayMin);
	const counts=datedTaskCounts(todayStr());
	const doneCount=document.getElementById('homeDoneCount');
	if(doneCount) doneCount.textContent=`完成 ${counts.done}/${counts.total}`;
}

function renderHomeTodayTasks(){
	const list=document.getElementById('homeMiniTaskList');
	const empty=document.getElementById('homeMiniTaskEmpty');
	const items=[];
	const today=todayStr();
	state.globalDailyTasks.forEach(t=>{
		if(t.date===today) items.push({ kind:'global', taskId:t.id, text:t.text, completed:t.completed, isPeriodic:false, subjectName:t.subjectId?(state.subjects.find(s=>s.id===t.subjectId)||{}).name||'自由':'自由' });
	});
	state.subjects.forEach(sub=>{
		todayDailyTasks(sub).forEach(t=>{
			items.push({ kind:'subject', subjectId:sub.id, subjectName:sub.name, taskId:t.id, text:t.text, completed:t.completed, isPeriodic:!!t.templateId });
		});
	});
	if(!items.length){ list.innerHTML=''; empty.classList.remove('hidden'); return; }
	empty.classList.add('hidden');
	items.sort((a,b)=>(a.completed===b.completed?0:a.completed?1:-1));
	list.innerHTML=items.slice(0,5).map(i=>{
		const badge=i.isPeriodic?'<span class="text-[9px] text-indigo-400 bg-indigo-50 px-1 rounded">周期</span>':'';
		const handler=i.kind==='global'?`toggleGlobalTask('${i.taskId}')`:`toggleTask('${i.subjectId}','daily','${i.taskId}')`;
		return `<div class="task-item ${i.completed?'task-completed':''} flex items-center gap-2 p-2 bg-slate-50 hover:bg-slate-100 rounded-lg" onclick="event.stopPropagation()">
			<input type="checkbox" ${i.completed?'checked':''} onchange="${handler}" class="w-4 h-4 rounded border-slate-300 text-primary-500 focus:ring-primary-400 cursor-pointer flex-shrink-0">
			<span class="task-text flex-1 text-xs break-all">${escapeHtml(i.text)}</span>${badge}
			<span class="text-[10px] text-slate-400 bg-white px-1.5 py-0.5 rounded border border-slate-200">${escapeHtml(i.subjectName)}</span>
		</div>`;
	}).join('');
}

function quickStartStudy(){
	switchView('timer');
	setTimeout(()=>{
		if(typeof enterTimerFocus==='function') enterTimerFocus();
		if(typeof startTimer==='function') startTimer();
		resetIdleTimer();
	},150);
}

function quickAddTask(){
	const value=prompt('请输入今日日常任务内容：','');
	if(value&&value.trim()){ addGlobalTaskText(value.trim()); switchView('dailyDetail'); }
}

function editUsername(){
	const value=prompt('请输入用户名：', state.username||'');
	if(value===null) return;
	const name=value.trim();
	state.username=name;
	state.userAvatar=name?name.charAt(0):'学';
	saveData(); renderAll(); showToast(name?'用户名已更新':'已清空用户名');
}

function editGoalText(){
	const value=prompt('请输入整体大目标：', state.goal||'');
	if(value===null) return;
	state.goal=value;
	saveData();
	document.getElementById('goalInput').value=value;
	renderAll();
	showToast('大目标已更新');
}
