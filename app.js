(() => {
  'use strict';
  const KEY = 'yumeodoro-v1';
  const CROP_WIDTH = 720;
  const CROP_HEIGHT = 960;
  const CATEGORIES = [
    ['focusStart', '集中開始時'], ['focus', '集中中'], ['focusEnd', '集中終了時'],
    ['breakStart', '休憩開始時'], ['break', '休憩中'], ['breakEnd', '休憩終了時'], ['setEnd', 'ポモドーロ1セット完了時']
  ];
  const DEFAULT = { durations: { focus: 25, shortBreak: 5, longBreak: 15 }, target: 4, sound: false, displayName: '', quotes: [], calendarQuotes: {}, dailyQuote: { time: '', text: '' }, mode: 'focus', completed: 0, status: 'idle', endAt: null, remaining: 25 * 60_000 };
  const $ = id => document.getElementById(id);
  let state = loadState();
  const pageOpenedDate = localDateKey(new Date());
  const pageOpeningQuote = state.calendarQuotes[pageOpenedDate];
  let pageOpeningQuotePending = typeof pageOpeningQuote === 'string' && Boolean(pageOpeningQuote.trim());
  let dailyTimeQuotePending = Boolean(state.dailyQuote.time && state.dailyQuote.text.trim() && isDailyQuoteTimeDue(state.dailyQuote.time));
  let dbPromise;
  let imageUrl = null;
  let editingQuote = null;
  let lastQuote = '';
  let tickHandle;
  let advanceHandle;
  let toastHandle;
  let midnightHandle;
  let dailyQuoteHandle;
  let cropSource = null;
  let cropOriginal = null;
  let cropZoom = 1;
  let cropOffsetX = 0;
  let cropOffsetY = 0;
  let cropDragPoint = null;
  let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedDate = localDateKey(new Date());

  function loadState() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || '{}');
      const merged = { ...DEFAULT, ...data, durations: { ...DEFAULT.durations, ...(data.durations || {}) }, quotes: Array.isArray(data.quotes) ? data.quotes : [], calendarQuotes: data.calendarQuotes && typeof data.calendarQuotes === 'object' && !Array.isArray(data.calendarQuotes) ? data.calendarQuotes : {}, dailyQuote: { ...DEFAULT.dailyQuote, ...(data.dailyQuote || {}) } };
      if (!['focus','shortBreak','longBreak'].includes(merged.mode)) merged.mode = 'focus';
      if (!['idle','running','paused','done'].includes(merged.status)) merged.status = 'idle';
      if (merged.status === 'running' && Number.isFinite(merged.endAt)) merged.remaining = Math.max(0, merged.endAt - Date.now());
      if (merged.status === 'running' && merged.remaining <= 0) {
        if (merged.mode === 'focus') merged.completed = Math.min(Number(merged.target) || DEFAULT.target, (Number(merged.completed) || 0) + 1);
        merged.status = 'done'; merged.endAt = null; merged.remaining = 0;
        try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch { /* Keep the recovered in-memory state if storage is full. */ }
      }
      return merged;
    } catch { return structuredClone(DEFAULT); }
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch { showToast('設定を保存できませんでした。ブラウザの空き容量を確認してください。'); return false; }
  }
  function db() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('このブラウザは画像保存に対応していません。'));
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('yumeodoro-media', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('media');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('画像ストレージを開けませんでした。'));
    });
    return dbPromise;
  }
  async function saveImage(file, originalSource) {
    try {
      const database = await db();
      await new Promise((resolve, reject) => { const tx = database.transaction('media', 'readwrite'); const store=tx.objectStore('media');store.put(file, 'character');if(originalSource)store.put(originalSource,'character-original');tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      await loadImage();
      showToast('画像を保存しました');
      return true;
    } catch (error) { showNotice(error.message || '画像を保存できませんでした。空き容量を確認してください。'); return false; }
  }
  function cropScale(){return Math.min(CROP_WIDTH/cropSource.naturalWidth,CROP_HEIGHT/cropSource.naturalHeight)*cropZoom;}
  function constrainCrop(){const scale=cropScale(),width=cropSource.naturalWidth*scale,height=cropSource.naturalHeight*scale;if(width<=CROP_WIDTH)cropOffsetX=(CROP_WIDTH-width)/2;else cropOffsetX=Math.min(0,Math.max(CROP_WIDTH-width,cropOffsetX));if(height<=CROP_HEIGHT)cropOffsetY=(CROP_HEIGHT-height)/2;else cropOffsetY=Math.min(0,Math.max(CROP_HEIGHT-height,cropOffsetY));}
  function drawCrop(){if(!cropSource)return;const canvas=$('cropCanvas'),context=canvas.getContext('2d');constrainCrop();context.clearRect(0,0,canvas.width,canvas.height);const scale=cropScale();context.drawImage(cropSource,cropOffsetX,cropOffsetY,cropSource.naturalWidth*scale,cropSource.naturalHeight*scale);}
  function setCropZoom(value){const oldScale=cropScale(),centerX=(CROP_WIDTH/2-cropOffsetX)/oldScale,centerY=(CROP_HEIGHT/2-cropOffsetY)/oldScale;cropZoom=Number(value)/100;const newScale=cropScale();cropOffsetX=CROP_WIDTH/2-centerX*newScale;cropOffsetY=CROP_HEIGHT/2-centerY*newScale;$('cropZoomValue').textContent=`${Math.round(cropZoom*100)}%`;drawCrop();}
  function openCropEditor(file){
    cropOriginal=file;const image=new Image(),url=URL.createObjectURL(file);
    image.onload=()=>{URL.revokeObjectURL(url);cropSource=image;cropZoom=1;const scale=cropScale();cropOffsetX=(CROP_WIDTH-image.naturalWidth*scale)/2;cropOffsetY=(CROP_HEIGHT-image.naturalHeight*scale)/2;$('cropZoom').value='100';$('cropZoomValue').textContent='100%';$('cropEditor').hidden=false;drawCrop();};
    image.onerror=()=>{URL.revokeObjectURL(url);showToast('この画像を読み込めませんでした');};
    image.src=url;
  }
  function closeCropEditor(){cropSource=null;cropOriginal=null;cropDragPoint=null;$('cropEditor').hidden=true;}
  async function openSavedCrop(){try{const database=await db();const source=await new Promise((resolve,reject)=>{const tx=database.transaction('media','readonly'),store=tx.objectStore('media'),original=store.get('character-original');original.onsuccess=()=>{if(original.result){resolve(original.result);return;}const current=store.get('character');current.onsuccess=()=>resolve(current.result);current.onerror=()=>reject(current.error);};original.onerror=()=>reject(original.error);});if(source)openCropEditor(source);}catch{showToast('保存画像を開けませんでした');}}
  async function applyCrop(){if(!cropSource)return;const canvas=$('cropCanvas');const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob){showToast('画像を切り取れませんでした');return;}if(await saveImage(blob,cropOriginal))closeCropEditor();}
  async function loadImage() {
    try {
      const database = await db();
      const file = await new Promise((resolve, reject) => { const tx = database.transaction('media', 'readonly'); const request = tx.objectStore('media').get('character'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      if (!file) { $('characterImage').hidden = true; $('characterEmpty').hidden = false; $('imagePreview').innerHTML = '<span>画像はまだありません</span>'; $('removeImage').disabled = true;$('adjustCrop').disabled=true; return; }
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = URL.createObjectURL(file);
      $('characterImage').src = imageUrl; $('characterImage').hidden = false; $('characterEmpty').hidden = true;
      $('imagePreview').innerHTML = ''; const preview = document.createElement('img'); preview.src = imageUrl; preview.alt = '選択した画像'; $('imagePreview').append(preview); $('removeImage').disabled = false;$('adjustCrop').disabled=false;
    } catch (error) { showNotice(error.message || '保存済み画像を読み込めませんでした。'); }
  }
  async function deleteImage() {
    try { const database = await db(); await new Promise((resolve, reject) => { const tx = database.transaction('media','readwrite'); tx.objectStore('media').delete('character');tx.objectStore('media').delete('character-original'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); await loadImage(); showToast('画像を削除しました'); }
    catch { showToast('画像を削除できませんでした'); }
  }
  function showToast(message) { const node = $('toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastHandle); toastHandle = setTimeout(() => node.classList.remove('show'), 2600); }
  function showNotice(message) { const node = $('storageNotice'); node.textContent = message; node.hidden = false; }
  function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
  function parseDateKey(key) { const [year,month,day] = key.split('-').map(Number); return new Date(year,month-1,day); }
  function modeMinutes(mode = state.mode) { return Number(state.durations[mode]) || DEFAULT.durations[mode]; }
  function duration() { return modeMinutes() * 60_000; }
  function categoryFor(mode = state.mode, phase = state.status) {
    if (phase === 'done') return mode === 'focus' ? (state.completed >= state.target ? 'setEnd' : 'focusEnd') : 'breakEnd';
    if (phase === 'running' || phase === 'paused') return mode === 'focus' ? 'focus' : 'break';
    return mode === 'focus' ? 'focusStart' : 'breakStart';
  }
  function quoteText() {
    const matching = state.quotes.filter(q => q.category === categoryFor());
    if (!matching.length) return state.quotes.length ? '設定したセリフがここに表示されます。' : '右上の設定からセリフを登録してください。';
    let selected = matching[Math.floor(Math.random() * matching.length)];
    if (matching.length > 1 && selected.text === lastQuote) selected = matching[(matching.findIndex(q => q.id === selected.id) + 1) % matching.length];
    lastQuote = selected.text;
    return selected.text;
  }
  function render() {
    const modeNames = { focus: ['FOCUS TIME','集中'], shortBreak: ['SHORT BREAK','短い休憩'], longBreak: ['LONG BREAK','長い休憩'] };
    $('modeLabel').textContent = modeNames[state.mode][0]; $('modeJapanese').textContent = modeNames[state.mode][1];
    $('speechName').textContent = state.displayName || ''; $('speechName').hidden = !state.displayName;
    const today = localDateKey(new Date());
    const speechKey = `${today}:${categoryFor()}`;
    if (render._category !== speechKey) { render._category = speechKey; if (pageOpeningQuotePending) { $('speechText').textContent = pageOpeningQuote; pageOpeningQuotePending = false; } else if (dailyTimeQuotePending && state.dailyQuote.text.trim()) { $('speechText').textContent = state.dailyQuote.text; dailyTimeQuotePending = false; } else { $('speechText').textContent = quoteText(); } }
    const left = state.status === 'running' ? Math.max(0, state.endAt - Date.now()) : Math.max(0, Number(state.remaining) || 0);
    const mins = Math.floor(left / 60_000), secs = Math.floor((left % 60_000) / 1000);
    $('timerDisplay').textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    $('startButton').hidden = state.status === 'running' || state.status === 'paused'; $('pauseButton').hidden = state.status !== 'running'; $('pauseButton').disabled = state.status !== 'running'; $('resumeButton').hidden = state.status !== 'paused'; $('resetButton').disabled = state.status === 'idle';
    const track = $('sessionTrack'); track.replaceChildren(); for (let i=0;i<state.target;i++){const dot=document.createElement('span');dot.className='session-dot'+(i < state.completed ? ' done':'');track.append(dot);}
    $('sessionCount').textContent = `${state.completed} / ${state.target} セッション`;
    $('nextBreak').textContent = state.completed >= state.target ? '長い休憩へ進めます' : '次は短い休憩';
    document.querySelectorAll('.mode-option').forEach(button => button.classList.toggle('active', button.dataset.mode === state.mode));
  }
  function start() { if(state.status === 'done') return; if(state.status !== 'paused') state.remaining = duration(); state.status='running'; state.endAt=Date.now()+state.remaining; persist(); render(); runTicker(); }
  function pause() { if(state.status !== 'running') return; state.remaining=Math.max(0,state.endAt-Date.now());state.status='paused';state.endAt=null;persist();render();clearInterval(tickHandle); }
  function reset() { clearTimeout(advanceHandle);advanceHandle=null;state.status='idle';state.endAt=null;state.remaining=duration();persist();render();clearInterval(tickHandle); }
  function runTicker() { clearInterval(tickHandle);tickHandle=setInterval(() => { if(state.status!=='running') return; state.remaining=Math.max(0,state.endAt-Date.now()); if(state.remaining<=0) finishTimer(); else render(); },250); }
  function finishTimer() { clearInterval(tickHandle);state.status='done';state.remaining=0;state.endAt=null;if(state.mode==='focus')state.completed=Math.min(state.target,state.completed+1);persist();render();render._category=null;render();if(state.sound)playChime();showToast(state.mode==='focus'?'集中セッション完了！':'休憩時間が終わりました');clearTimeout(advanceHandle);advanceHandle=setTimeout(()=>{advanceHandle=null;nextMode();start();},2500); }
  function playChime(){try{const audio=new(window.AudioContext||window.webkitAudioContext)();[660,880].forEach((hz,i)=>{const oscillator=audio.createOscillator(),gain=audio.createGain();oscillator.frequency.value=hz;gain.gain.setValueAtTime(.08,audio.currentTime+i*.18);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+i*.18+.35);oscillator.connect(gain).connect(audio.destination);oscillator.start(audio.currentTime+i*.18);oscillator.stop(audio.currentTime+i*.18+.36);});setTimeout(()=>audio.close(),1000);}catch{} }
  function setMode(mode) { if(!['focus','shortBreak','longBreak'].includes(mode))return;clearTimeout(advanceHandle);advanceHandle=null;if(mode==='focus'&&state.mode==='longBreak'&&state.completed>=state.target)state.completed=0;state.mode=mode;state.status='idle';state.endAt=null;state.remaining=modeMinutes(mode)*60_000;persist();render._category=null;render();clearInterval(tickHandle); }
  function nextMode() { if(state.mode==='focus'){setMode(state.completed>0&&state.completed%state.target===0?'longBreak':'shortBreak');}else setMode('focus'); }
  function openSettings() { $('timerView').hidden=true;$('settingsView').hidden=false;window.scrollTo(0,0);try{syncSettingsForm();}catch(error){console.error('設定画面の初期化に失敗しました',error);showNotice('設定を読み込めませんでした。ページを再読み込みしてください。');} }
  function closeSettings() { $('settingsView').hidden=true;$('timerView').hidden=false;window.scrollTo(0,0); }
  function syncSettingsForm(){
    $('displayName').value=state.displayName || '';$('focusMinutes').value=state.durations.focus;$('shortMinutes').value=state.durations.shortBreak;$('longMinutes').value=state.durations.longBreak;$('sessionsTarget').value=state.target;$('soundEnabled').checked=state.sound;
    $('dailyQuoteTime').value=state.dailyQuote.time;$('dailyQuoteText').value=state.dailyQuote.text;
    $('quoteCategory').replaceChildren(...CATEGORIES.map(([value,label])=>{const o=document.createElement('option');o.value=value;o.textContent=label;return o;}));renderQuotes();renderCalendar();
  }
  function renderQuotes(){const list=$('quoteList');list.replaceChildren();const category=$('quoteCategory').value,labelText=CATEGORIES.find(x=>x[0]===category)?.[1]||'選択したタイミング',quotes=state.quotes.filter(quote=>quote.category===category);if(!quotes.length){const empty=document.createElement('div');empty.className='empty-quotes';empty.textContent=state.quotes.length?`「${labelText}」のセリフはまだありません。`:'まだセリフはありません。最初のひとことを登録しましょう。';list.append(empty);return;}
    for(const quote of quotes){const row=document.createElement('div');row.className='quote-item';const copy=document.createElement('p');const label=document.createElement('small');label.textContent=labelText;copy.append(label,document.createTextNode(quote.text));const actions=document.createElement('div');actions.className='quote-actions';const edit=document.createElement('button');edit.type='button';edit.textContent='✎';edit.title='編集';edit.setAttribute('aria-label','セリフを編集');edit.onclick=()=>{editingQuote=quote.id;$('quoteCategory').value=quote.category;$('quoteInput').value=quote.text;$('quoteEditLabel').textContent='セリフを編集中';$('addQuote').textContent='更新する';$('quoteInput').focus();};const del=document.createElement('button');del.type='button';del.textContent='×';del.title='削除';del.setAttribute('aria-label','セリフを削除');del.onclick=()=>{state.quotes=state.quotes.filter(q=>q.id!==quote.id);if(editingQuote===quote.id)clearQuoteForm();persist();renderQuotes();render._category=null;render();};actions.append(edit,del);row.append(copy,actions);list.append(row);}
  }
  function updateSelectedDateForm(){
    const date=parseDateKey(selectedDate);
    $('selectedDateLabel').textContent=new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(date);
    $('scheduledQuote').value=state.calendarQuotes[selectedDate]||'';
    $('deleteScheduledQuote').disabled=!Object.prototype.hasOwnProperty.call(state.calendarQuotes,selectedDate);
  }
  function renderCalendar(){
    const grid=$('calendarGrid');if(!grid)return;
    $('calendarMonth').textContent=new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long'}).format(calendarCursor);
    grid.replaceChildren();
    for(const weekday of ['日','月','火','水','木','金','土']){const label=document.createElement('span');label.className='calendar-weekday';label.textContent=weekday;label.setAttribute('role','columnheader');grid.append(label);}
    const year=calendarCursor.getFullYear(),month=calendarCursor.getMonth(),firstWeekday=new Date(year,month,1).getDay(),daysInMonth=new Date(year,month+1,0).getDate();
    for(let blank=0;blank<firstWeekday;blank++){const spacer=document.createElement('span');spacer.className='calendar-blank';spacer.setAttribute('aria-hidden','true');grid.append(spacer);}
    const today=localDateKey(new Date());
    for(let day=1;day<=daysInMonth;day++){
      const key=localDateKey(new Date(year,month,day)),button=document.createElement('button');button.type='button';button.className='calendar-day';button.textContent=String(day);button.setAttribute('role','gridcell');button.setAttribute('aria-pressed',String(key===selectedDate));button.setAttribute('aria-label',new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long',day:'numeric'}).format(new Date(year,month,day)));
      if(key===selectedDate)button.classList.add('selected');if(key===today)button.classList.add('today');if(Object.prototype.hasOwnProperty.call(state.calendarQuotes,key)){button.classList.add('has-quote');button.setAttribute('aria-label',`${button.getAttribute('aria-label')}、セリフの予定あり`);}
      button.addEventListener('click',()=>{selectedDate=key;updateSelectedDateForm();renderCalendar();});grid.append(button);
    }
    updateSelectedDateForm();
  }
  function shiftCalendarMonth(amount){calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()+amount,1);selectedDate=localDateKey(calendarCursor);renderCalendar();}
  function saveScheduledQuote(){const text=$('scheduledQuote').value;if(!text.trim()){showToast('予定するセリフを入力してください');return;}state.calendarQuotes[selectedDate]=text;persist();renderCalendar();if(selectedDate===localDateKey(new Date())){render._category=null;render();}showToast('日付にセリフを保存しました');}
  function saveDailyQuote(){const time=$('dailyQuoteTime').value,text=$('dailyQuoteText').value.trim();if(Boolean(time)!==Boolean(text)){showToast('時刻とセリフの両方を入力してください');return;}state.dailyQuote={time,text};dailyTimeQuotePending=Boolean(time&&text&&isDailyQuoteTimeDue(time));persist();render._category=null;render();scheduleDailyQuoteRefresh();showToast(time?'毎日の時刻セリフを保存しました':'毎日の時刻セリフを解除しました');}
  function deleteScheduledQuote(){if(!Object.prototype.hasOwnProperty.call(state.calendarQuotes,selectedDate))return;delete state.calendarQuotes[selectedDate];persist();renderCalendar();if(selectedDate===localDateKey(new Date())){render._category=null;render();}showToast('日付のセリフを削除しました');}
  function clearQuoteForm() { editingQuote=null;$('quoteInput').value='';$('quoteEditLabel').textContent='新しいセリフ';$('addQuote').textContent='追加する'; }
  function saveQuote(){const text=$('quoteInput').value;if(!text.trim()){showToast('セリフを入力してください');return;}const record={id:editingQuote||`${Date.now()}-${Math.random()}`,category:$('quoteCategory').value,text};if(editingQuote)state.quotes=state.quotes.map(q=>q.id===editingQuote?record:q);else state.quotes.push(record);persist();clearQuoteForm();renderQuotes();render._category=null;render();}
  function saveSettings(){const vals={focus:Number($('focusMinutes').value),shortBreak:Number($('shortMinutes').value),longBreak:Number($('longMinutes').value)},target=Number($('sessionsTarget').value);if(Object.values(vals).some(v=>!Number.isInteger(v)||v<1)||!Number.isInteger(target)||target<1||target>12){showToast('時間と回数を正しく入力してください');return;}state.displayName=$('displayName').value.trim();state.durations=vals;state.target=target;state.sound=$('soundEnabled').checked;state.completed=state.completed%target;if(state.status==='idle')state.remaining=duration();persist();render();closeSettings();showToast('設定を保存しました');}
  $('openSettings').addEventListener('click',openSettings);$('addImageShortcut').addEventListener('click',openSettings);$('backButton').addEventListener('click',closeSettings);$('saveSettings').addEventListener('click',saveSettings);$('quoteCategory').addEventListener('change',renderQuotes);
  $('startButton').addEventListener('click',start);$('pauseButton').addEventListener('click',pause);$('resumeButton').addEventListener('click',start);$('resetButton').addEventListener('click',reset);$('addQuote').addEventListener('click',saveQuote);
  $('calendarPrev').addEventListener('click',()=>shiftCalendarMonth(-1));$('calendarNext').addEventListener('click',()=>shiftCalendarMonth(1));$('saveScheduledQuote').addEventListener('click',saveScheduledQuote);$('deleteScheduledQuote').addEventListener('click',deleteScheduledQuote);$('saveDailyQuote').addEventListener('click',saveDailyQuote);
  $('imageInput').addEventListener('change',event=>{const file=event.target.files?.[0];if(!file)return;if(!file.type.startsWith('image/')){showToast('画像ファイルを選択してください');return;}if(file.size>20*1024*1024){showNotice('画像サイズが大きすぎます。20MB以下の画像をお選びください。');return;}openCropEditor(file);event.target.value='';});$('removeImage').addEventListener('click',deleteImage);$('adjustCrop').addEventListener('click',openSavedCrop);
  $('cropZoom').addEventListener('input',event=>setCropZoom(event.target.value));$('cancelCrop').addEventListener('click',closeCropEditor);$('applyCrop').addEventListener('click',applyCrop);
  $('cropCanvas').addEventListener('pointerdown',event=>{if(!cropSource)return;const rect=event.currentTarget.getBoundingClientRect();cropDragPoint={x:(event.clientX-rect.left)*CROP_WIDTH/rect.width,y:(event.clientY-rect.top)*CROP_HEIGHT/rect.height};event.currentTarget.setPointerCapture(event.pointerId);});
  $('cropCanvas').addEventListener('pointermove',event=>{if(!cropDragPoint)return;const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)*CROP_WIDTH/rect.width,y=(event.clientY-rect.top)*CROP_HEIGHT/rect.height;cropOffsetX+=x-cropDragPoint.x;cropOffsetY+=y-cropDragPoint.y;cropDragPoint={x,y};drawCrop();});
  $('cropCanvas').addEventListener('pointerup',()=>{cropDragPoint=null;});$('cropCanvas').addEventListener('pointercancel',()=>{cropDragPoint=null;});
  document.querySelectorAll('.mode-option').forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.mode)));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){render();if(state.status==='running'){state.remaining=Math.max(0,state.endAt-Date.now());if(state.remaining<=0)finishTimer();else render();}}});
  window.addEventListener('storage',event=>{if(event.key===KEY){state=loadState();render();}});
  function scheduleMidnightRefresh(){clearTimeout(midnightHandle);const next=new Date();next.setHours(24,0,0,50);midnightHandle=setTimeout(()=>{render._category=null;render();scheduleMidnightRefresh();},next.getTime()-Date.now());}
  function isDailyQuoteTimeDue(time,now=new Date()){return Boolean(time&&`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`>=time);}
  function scheduleDailyQuoteRefresh(){clearTimeout(dailyQuoteHandle);if(!state.dailyQuote.time||!state.dailyQuote.text.trim())return;const [hours,minutes]=state.dailyQuote.time.split(':').map(Number),next=new Date();next.setHours(hours,minutes,0,0);if(next<=new Date())next.setDate(next.getDate()+1);dailyQuoteHandle=setTimeout(()=>{dailyTimeQuotePending=true;render._category=null;render();scheduleDailyQuoteRefresh();},next.getTime()-Date.now());}
  function registerOfflineCache(){if(!('serviceWorker'in navigator))return;const isLocal=location.hostname==='localhost'||location.hostname==='127.0.0.1';if(isLocal){navigator.serviceWorker.getRegistrations().then(registrations=>Promise.all(registrations.map(registration=>registration.unregister()))).catch(()=>{});if('caches'in window)caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('yumeodoro-shell-')).map(key=>caches.delete(key)))).catch(()=>{});return;}if(location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});}
  render();loadImage();if(state.status==='running')runTicker();scheduleMidnightRefresh();scheduleDailyQuoteRefresh();registerOfflineCache();
})();
