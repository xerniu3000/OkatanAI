/* OKATAN CORE v1.3.1 — JS module
   Extracted from Bestnow6.html. Edit here; index.html references this via <script>. */

(function(){
  'use strict';
  if (window.OKATAN && window.OKATAN.__loaded) return;

  // ---------- 1. EVENT BUS ----------
  const bus = (function(){
    const map = new Map();
    return {
      on(ev, fn){ if(!map.has(ev)) map.set(ev,new Set()); map.get(ev).add(fn); return ()=>map.get(ev)&&map.get(ev).delete(fn); },
      off(ev, fn){ map.has(ev) && map.get(ev).delete(fn); },
      emit(ev, payload){
        if(!map.has(ev)) return;
        map.get(ev).forEach(fn=>{ try{ fn(payload); }catch(e){ console.warn('[OKATAN bus]',ev,e); } });
      }
    };
  })();

  // ---------- 2. PERSISTENT MEMORY (IndexedDB) ----------
  const memory = (function(){
    const DB='okatan_core', STORE='memory', VER=1;
    let dbp = null;
    function open(){
      if(dbp) return dbp;
      dbp = new Promise((res,rej)=>{
        const r = indexedDB.open(DB, VER);
        r.onupgradeneeded = e => {
          const db = e.target.result;
          if(!db.objectStoreNames.contains(STORE)){
            const os = db.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
            os.createIndex('tag','tag',{unique:false});
            os.createIndex('ts','ts',{unique:false});
          }
        };
        r.onsuccess = ()=>res(r.result);
        r.onerror = ()=>rej(r.error);
      });
      return dbp;
    }
    async function tx(mode){
      const db = await open();
      return db.transaction(STORE,mode).objectStore(STORE);
    }
    async function add(text, tag='fact'){
      if(!text||!String(text).trim()) return null;
      const os = await tx('readwrite');
      return new Promise((res,rej)=>{
        const req = os.add({text:String(text).trim(), tag, ts:Date.now()});
        req.onsuccess = ()=>{ bus.emit('memory:changed'); res(req.result); };
        req.onerror = ()=>rej(req.error);
      });
    }
    async function all(){
      const os = await tx('readonly');
      return new Promise((res,rej)=>{
        const req = os.getAll();
        req.onsuccess = ()=>res((req.result||[]).sort((a,b)=>b.ts-a.ts));
        req.onerror = ()=>rej(req.error);
      });
    }
    async function remove(id){
      const os = await tx('readwrite');
      return new Promise((res,rej)=>{
        const req = os.delete(id);
        req.onsuccess = ()=>{ bus.emit('memory:changed'); res(true); };
        req.onerror = ()=>rej(req.error);
      });
    }
    async function clear(){
      const os = await tx('readwrite');
      return new Promise((res,rej)=>{
        const req = os.clear();
        req.onsuccess = ()=>{ bus.emit('memory:changed'); res(true); };
        req.onerror = ()=>rej(req.error);
      });
    }
    async function recall(query, limit=8){
      const items = await all();
      if(!items.length) return [];
      const q = String(query||'').toLowerCase().split(/\W+/).filter(t=>t.length>2);
      if(!q.length) return items.slice(0,limit);
      const now = Date.now();
      const scored = items.map(it=>{
        const text = String(it.text).toLowerCase();
        let score = 0;
        for(const t of q) if(text.includes(t)) score += 1;
        if(it.tag==='fact') score += 0.4;
        score += Math.max(0, 1 - (now - it.ts)/(60*86400*1000)) * 0.3;
        return {it,score};
      }).filter(x=>x.score>0)
        .sort((a,b)=>b.score-a.score)
        .slice(0,limit)
        .map(x=>x.it);
      return scored;
    }
    return { add, all, remove, clear, recall };
  })();

  // ---------- 3. TTS QUEUE (browser + OpenAI) ----------
  const tts = (function(){
    let enabled = false;
    const queue = [];
    let speaking = false;
    let currentAudio = null;
    let onSpeakStart = null;
    let onSpeakEnd = null;
    function settings(){
      return {
        engine: localStorage.getItem('okatan_core_tts_engine') || 'browser',
        voiceName: localStorage.getItem('okatan_core_tts_voice') || '',
        openaiVoice: localStorage.getItem('okatan_core_openai_voice') || 'onyx',
        rate: parseFloat(localStorage.getItem('okatan_core_tts_rate')||'1.0')
      };
    }
    function listBrowserVoices(){
      try{ return (window.speechSynthesis && speechSynthesis.getVoices()) || []; }catch(e){ return []; }
    }
    function pickBrowserVoice(){
      const s = settings();
      const all = listBrowserVoices();
      if(!all.length) return null;
      if(s.voiceName){
        const m = all.find(v=>v.name===s.voiceName);
        if(m) return m;
      }
      const pref = ['Samantha','Ava','Daniel','Karen','Google US English','Microsoft Aria','Microsoft Guy'];
      for(const p of pref){
        const m = all.find(v=>v.name.includes(p));
        if(m) return m;
      }
      return all.find(v=>(v.lang||'').startsWith('en')) || all[0];
    }
    async function speakBrowser(text){
      return new Promise((resolve)=>{
        try{
          const u = new SpeechSynthesisUtterance(text);
          const v = pickBrowserVoice();
          if(v) u.voice = v;
          u.rate = settings().rate || 1.0;
          u.onend = ()=>resolve();
          u.onerror = ()=>resolve();
          speechSynthesis.speak(u);
        }catch(e){ resolve(); }
      });
    }
    async function speakOpenAI(text){
      const key = sessionStorage.getItem('ok_api_key_openai')||'';
      if(!key) return speakBrowser(text);
      try{
        const r = await fetch('https://api.openai.com/v1/audio/speech',{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
          body: JSON.stringify({
            model:'tts-1',
            voice: settings().openaiVoice || 'onyx',
            input: text,
            speed: settings().rate || 1.0
          })
        });
        if(!r.ok){ return speakBrowser(text); }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        return new Promise(resolve=>{
          const a = new Audio(url);
          currentAudio = a;
          a.onended = ()=>{ URL.revokeObjectURL(url); currentAudio=null; resolve(); };
          a.onerror = ()=>{ URL.revokeObjectURL(url); currentAudio=null; resolve(); };
          a.play().catch(()=>{ currentAudio=null; resolve(); });
        });
      }catch(e){ return speakBrowser(text); }
    }
    async function flush(){
      if(speaking || !queue.length || !enabled) return;
      const item = queue.shift();
      speaking = true;
      try{ onSpeakStart && onSpeakStart(); }catch(e){}
      if(settings().engine === 'openai'){
        await speakOpenAI(item.text);
      } else {
        await speakBrowser(item.text);
      }
      speaking = false;
      try{ onSpeakEnd && onSpeakEnd(); }catch(e){}
      flush();
    }
    function hardStop(){
      try{ speechSynthesis && speechSynthesis.cancel(); }catch(e){}
      if(currentAudio){ try{ currentAudio.pause(); currentAudio.src=''; }catch(e){} currentAudio=null; }
      queue.length = 0;
      speaking = false;
    }
    return {
      enable(v){ enabled = !!v; if(!enabled) hardStop(); },
      isEnabled(){ return enabled; },
      isSpeaking(){ return speaking; },
      settings, listBrowserVoices,
      setEngine(e){ localStorage.setItem('okatan_core_tts_engine', e); },
      setBrowserVoice(name){ localStorage.setItem('okatan_core_tts_voice', name||''); },
      setOpenAIVoice(v){ localStorage.setItem('okatan_core_openai_voice', v||'onyx'); },
      setRate(r){ localStorage.setItem('okatan_core_tts_rate', String(r||1.0)); },
      onStart(fn){ onSpeakStart = fn; },
      onEnd(fn){ onSpeakEnd = fn; },
      say(text, priority='normal'){
        if(!text||!enabled) return;
        const clean = String(text).replace(/```[\s\S]*?```/g,'').replace(/[*_`#>]/g,'').replace(/\s+/g,' ').trim();
        if(!clean) return;
        if(priority==='high'){ hardStop(); }
        queue.push({text:clean});
        flush();
      },
      stop: hardStop
    };
  })();

  // ---------- 4. UNIFIED AI CLIENT ----------
  function getKey(provider){
    const k = provider==='gemini'?'ok_api_key_gemini':provider==='groq'?'ok_api_key_groq':'ok_api_key_openai';
    return sessionStorage.getItem(k) || '';
  }
  function pickProvider(forced){
    if(forced && forced!=='auto') return forced;
    if(getKey('openai')) return 'openai';
    if(getKey('gemini')) return 'gemini';
    if(getKey('groq'))   return 'groq';
    return null;
  }

  const toolRegistry = [];
  function registerTool(spec){ toolRegistry.push(spec); }

  function toolsForOpenAI(){
    return toolRegistry.map(t=>({
      type:'function',
      function:{
        name:t.name,
        description:t.description,
        parameters: t.parameters && Object.keys(t.parameters.properties||{}).length
          ? t.parameters
          : { type:'object', properties:{}, additionalProperties:false }
      }
    }));
  }
  function toolsForGemini(){
    // Gemini rejects function declarations whose parameters have empty properties.
    return [{ functionDeclarations: toolRegistry.map(t=>{
      const hasProps = t.parameters && t.parameters.properties && Object.keys(t.parameters.properties).length;
      const decl = { name:t.name, description:t.description };
      if(hasProps) decl.parameters = t.parameters;
      return decl;
    }) }];
  }
  function toolsForGroq(){ return toolsForOpenAI(); }

  async function callOpenAI({key, model, messages, tools}){
    const r = await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages,
        tools: tools && tools.length ? tools : undefined,
        tool_choice: tools && tools.length ? 'auto' : undefined,
        temperature: 0.4,
        max_tokens: 800
      })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j?.error?.message || 'OpenAI request failed');
    return j.choices[0].message;
  }
  async function callGroq({key, messages, tools}){
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body: JSON.stringify({
        model:'llama-3.1-8b-instant',
        messages,
        tools: tools && tools.length ? tools : undefined,
        tool_choice: tools && tools.length ? 'auto' : undefined,
        temperature: 0.4,
        max_tokens: 800
      })
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j?.error?.message || 'Groq request failed');
    const m = j.choices?.[0]?.message || {};
    return { role:'assistant', content: m.content || '', tool_calls: m.tool_calls };
  }
  async function callGemini({key, messages, tools}){
    const contents = [];
    let system = '';
    for(const m of messages){
      if(m.role==='system'){ system += (system?'\n':'') + (m.content||''); continue; }
      if(m.role==='tool'){
        contents.push({ role:'user', parts:[{ text:'[tool '+m.name+' result]: '+m.content }] });
        continue;
      }
      contents.push({
        role: m.role==='assistant'?'model':'user',
        parts: [{ text: m.content || '' }]
      });
    }
    const body = {
      contents,
      systemInstruction: system ? { parts:[{ text: system }] } : undefined,
      tools: tools && tools.length ? tools : undefined,
      generationConfig: { temperature: 0.4, maxOutputTokens: 800 }
    };
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+encodeURIComponent(key),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j?.error?.message || 'Gemini request failed');
    const cand = (j.candidates||[])[0];
    const parts = cand?.content?.parts || [];
    let text = '';
    const tool_calls = [];
    for(const p of parts){
      if(p.text) text += p.text;
      if(p.functionCall){
        tool_calls.push({
          id: 'gem_'+Math.random().toString(36).slice(2,9),
          type:'function',
          function:{ name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args||{}) }
        });
      }
    }
    return { role:'assistant', content: text, tool_calls: tool_calls.length?tool_calls:undefined };
  }

  // ---------- 5. AGENTIC ROUTER ----------
  function defaultSystemPrompt(){
    return "You are OKATAN (the user may call you Katana), a heads-up personal assistant inspired by JARVIS from Iron Man. Voice: concise, dry, capable, warm. Reply in 1-2 sentences unless asked to elaborate. You live inside a personal device PWA with many built-in apps and tools. CRITICAL RULES: (1) When the user asks you to open, launch, start, show, or pull up anything that matches a tool, CALL THE TOOL — do not just describe it. (2) When the user states a personal fact ('I drive a Tacoma', 'my wife's name is Sara', 'I prefer celsius'), call the remember tool. (3) Before answering personal questions, call recall_memory. (4) Never invent abilities. If no tool matches, say so plainly.";
  }
  function loadSystemPrompt(){
    return localStorage.getItem('okatan_core_sysprompt') || defaultSystemPrompt();
  }
  function saveSystemPrompt(v){
    localStorage.setItem('okatan_core_sysprompt', v || defaultSystemPrompt());
  }
  function buildToolHint(){
    if(!toolRegistry.length) return '';
    const lines = toolRegistry.map(t=>'- '+t.name+': '+t.description);
    return '\n\nAvailable tools you can call:\n' + lines.join('\n');
  }

  function pendingConfirm(){
    return new Promise(resolve=>{
      const overlay = document.getElementById('okc-confirm');
      const yes = document.getElementById('okc-confirm-yes');
      const no  = document.getElementById('okc-confirm-no');
      const cleanup = (val)=>{
        overlay.classList.remove('show');
        yes.onclick = null; no.onclick = null;
        resolve(val);
      };
      yes.onclick = ()=>cleanup(true);
      no.onclick  = ()=>cleanup(false);
      overlay.classList.add('show');
    });
  }
  async function askConfirm(text){
    document.getElementById('okc-confirm-text').textContent = text;
    return await pendingConfirm();
  }

  async function runTool(name, args){
    const tool = toolRegistry.find(t=>t.name===name);
    if(!tool) return { ok:false, error:'Unknown tool: '+name };
    if(tool.confirm){
      const ok = await askConfirm(typeof tool.confirm==='function' ? tool.confirm(args) : tool.confirm);
      if(!ok) return { ok:false, error:'User declined.' };
    }
    try{
      const result = await tool.run(args||{});
      bus.emit('tool:ran', {name, args, result});
      return { ok:true, result: result==null ? 'done' : result };
    }catch(e){
      return { ok:false, error: String(e.message||e) };
    }
  }

  let chatHistory = [];

  async function ask(userText, opts={}){
    // VISION LIVE MODE: route to camera+vision instead of text LLM
    try{
      if(typeof vision !== 'undefined' && vision.isLive && vision.isLive()){
        ui.setStatus('LOOKING…', true);
        const ans = await vision.analyze(userText);
        chatHistory.push({ role:'user', content: userText });
        chatHistory.push({ role:'assistant', content: ans });
        ui.appendMsg('assistant', ans);
        tts.say(ans);
        ui.setStatus('READY', false);
        return ans;
      }
    }catch(e){ /* fall through to regular ask */ }

    const provider = pickProvider(opts.provider || (document.getElementById('okcore-provider')||{}).value || 'auto');
    if(!provider){
      const msg = 'No API key set. Open CORE → CONFIG to add an OpenAI, Gemini, or Groq key.';
      ui.appendMsg('assistant', msg);
      return msg;
    }
    const key = getKey(provider);

    const recalled = await memory.recall(userText, 6);
    const memBlock = recalled.length
      ? 'Known facts about the user (apply when relevant):\n' + recalled.map(r=>'- '+r.text).join('\n')
      : '';
    const sys = loadSystemPrompt() + buildToolHint() + (memBlock?('\n\n'+memBlock):'');
    const messages = [
      { role:'system', content: sys },
      ...chatHistory.slice(-12),
      { role:'user', content: userText }
    ];

    ui.setStatus('THINKING…', true);
    bus.emit('ai:start', {provider});

    try{
      let assistantMsg;
      if(provider==='openai'){
        assistantMsg = await callOpenAI({ key, messages, tools: toolsForOpenAI() });
      } else if(provider==='gemini'){
        assistantMsg = await callGemini({ key, messages, tools: toolsForGemini() });
      } else {
        assistantMsg = await callGroq({ key, messages, tools: toolsForGroq() });
      }

      let hops = 0;
      while(assistantMsg.tool_calls && assistantMsg.tool_calls.length && hops < 4){
        hops++;
        for(const tc of assistantMsg.tool_calls){
          const argsObj = (()=>{ try{ return JSON.parse(tc.function.arguments||'{}'); }catch(e){ return {}; } })();
          ui.appendMsg('tool', '→ '+tc.function.name+'('+JSON.stringify(argsObj)+')');
        }
        messages.push({
          role:'assistant',
          content: assistantMsg.content || '',
          tool_calls: assistantMsg.tool_calls
        });
        for(const tc of assistantMsg.tool_calls){
          let args = {};
          try{ args = JSON.parse(tc.function.arguments||'{}'); }catch(e){}
          const result = await runTool(tc.function.name, args);
          messages.push({
            role:'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify(result).slice(0,1200)
          });
        }
        if(provider==='openai'){
          assistantMsg = await callOpenAI({ key, messages, tools: toolsForOpenAI() });
        } else if(provider==='gemini'){
          assistantMsg = await callGemini({ key, messages, tools: toolsForGemini() });
        } else {
          assistantMsg = await callGroq({ key, messages, tools: toolsForGroq() });
        }
      }

      const replyText = assistantMsg.content || '(no reply)';
      chatHistory.push({ role:'user', content:userText });
      chatHistory.push({ role:'assistant', content:replyText });
      ui.appendMsg('assistant', replyText);
      tts.say(replyText);
      ui.setStatus('READY', false);
      bus.emit('ai:done', {provider, text:replyText});
      return replyText;

    }catch(e){
      ui.setStatus('ERROR', false);
      const err = 'Error: '+(e.message||e);
      ui.appendMsg('system', err);
      bus.emit('ai:error', {error:err});
      return err;
    }
  }

  // ---------- 6. TOOL REGISTRATIONS ----------
  function appOpener(fnName){
    return ()=>{ if(typeof window[fnName]==='function'){ window[fnName](); return 'opened'; } return 'launcher_missing:'+fnName; };
  }

  registerTool({
    name:'remember',
    description:'Save a long-term fact about the user (preference, vehicle, name, contact, routine).',
    parameters:{ type:'object', properties:{ text:{type:'string', description:'The fact, written as a complete sentence.'} }, required:['text'] },
    run: async ({text})=>{ await memory.add(text,'fact'); return 'Stored.'; }
  });
  registerTool({
    name:'recall_memory',
    description:'Search the user\'s stored facts for relevant entries.',
    parameters:{ type:'object', properties:{ query:{type:'string'} }, required:['query'] },
    run: async ({query})=>{ const r = await memory.recall(query,6); return r.length ? r.map(x=>x.text) : 'No matching memories.'; }
  });
  registerTool({
    name:'list_memories',
    description:'Return all stored memory facts.',
    parameters:{ type:'object', properties:{} },
    run: async ()=>{ const r = await memory.all(); return r.length ? r.map(x=>x.text) : 'No memories stored.'; }
  });
  registerTool({
    name:'forget_memory',
    description:'Delete a stored fact. Use only when the user explicitly asks to forget something.',
    parameters:{ type:'object', properties:{ query:{type:'string'} }, required:['query'] },
    confirm: (args)=>'Forget memories matching: "'+(args.query||'')+'"?',
    run: async ({query})=>{
      const matches = await memory.recall(query, 10);
      if(!matches.length) return 'Nothing matched.';
      for(const m of matches) await memory.remove(m.id);
      return 'Forgot '+matches.length+' item(s).';
    }
  });

  registerTool({
    name:'set_alarm',
    description:'Create an alarm. Use 24-hour time.',
    parameters:{ type:'object', properties:{
      hour:{type:'integer', minimum:0, maximum:23},
      minute:{type:'integer', minimum:0, maximum:59},
      label:{type:'string'}
    }, required:['hour','minute'] },
    run: async ({hour,minute,label})=>{
      try{
        if(typeof window.okatanOpenAlarm==='function'){
          window.okatanOpenAlarm();
          return 'Alarm screen opened for '+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')+(label?(' — '+label):'')+'. Confirm to save.';
        }
      }catch(e){}
      return 'Alarm screen not available.';
    }
  });

  const APP_OPENERS = [
    ['open_notes','Open the Notes app','okatanOpenNotes'],
    ['open_camera','Open the camera','okatanOpenCamera'],
    ['open_okavision','Open OkaVision (camera + AI vision)','okatanOpenOkaVision'],
    ['open_map','Open the map','okatanOpenOkaMap'],
    ['open_weather','Open weather','okatanOpenWeather'],
    ['open_radio','Open OKATAN radio','okatanOpenRadio'],
    ['open_compass','Open the compass','okatanOpenCompass'],
    ['open_themes','Open the themes / appearance settings','okatanOpenThemes'],
    ['open_calculator','Open the scientific calculator','okatanOpenSciCalc'],
    ['open_translate','Open live language translation','okatanOpenLanguage'],
    ['open_conversate','Open the live conversation transcriber','okatanOpenConversate'],
    ['open_journal','Open the journal','okatanOpenJournal'],
    ['open_tasks','Open tasks','okatanOpenTasks'],
    ['open_habits','Open habits','okatanOpenHabits'],
    ['open_water','Open the water tracker','okatanOpenWater'],
    ['open_breath','Open the breathing exercise','okatanOpenBreath'],
    ['open_pomodoro','Open the Pomodoro timer','okatanOpenPomodoro'],
    ['open_fuel_log','Open the fuel log','okatanOpenFuelLog'],
    ['open_vehicle','Open the vehicle screen','okatanOpenVehicle'],
    ['open_world_clock','Open the world clock','okatanOpenWorldClock'],
    ['open_bible','Open the Bible','okatanOpenBible'],
    ['open_arcade','Open the arcade / game hub','okatanOpenArcadeHub']
  ];
  for(const [name, desc, fn] of APP_OPENERS){
    registerTool({
      name, description: desc,
      parameters:{ type:'object', properties:{} },
      run: appOpener(fn)
    });
  }

  registerTool({
    name:'web_search',
    description:'Open a Google search with the given query. Use for current info beyond your training.',
    parameters:{ type:'object', properties:{ query:{type:'string'} }, required:['query'] },
    run: async ({query})=>{
      if(typeof window.okatanOpenUrl==='function'){
        window.okatanOpenUrl('https://www.google.com/search?q='+encodeURIComponent(query));
        return 'Opened search for: '+query;
      }
      window.open('https://www.google.com/search?q='+encodeURIComponent(query),'_blank');
      return 'Opened search.';
    }
  });
  registerTool({
    name:'get_time',
    description:'Get the current local date and time.',
    parameters:{ type:'object', properties:{} },
    run: async ()=>new Date().toString()
  });
  registerTool({
    name:'get_location',
    description:'Get the device\'s current GPS coordinates.',
    parameters:{ type:'object', properties:{} },
    run: ()=>new Promise(res=>{
      if(!navigator.geolocation) return res('Geolocation not supported.');
      navigator.geolocation.getCurrentPosition(
        p=>res({lat:p.coords.latitude, lon:p.coords.longitude, accuracy_m:Math.round(p.coords.accuracy)}),
        e=>res('Geolocation error: '+e.message),
        {timeout:8000, maximumAge:60000}
      );
    })
  });

  // ---------- 7. UI WIRING ----------
  const ui = (function(){
    function chat(){ return document.getElementById('okc-chat'); }
    function statusEl(){ return document.getElementById('okcore-status'); }
    function setStatus(txt, live){
      const s = statusEl(); if(!s) return;
      s.textContent = txt;
      s.classList.toggle('live', !!live);
    }
    function appendMsg(role, text){
      const c = chat(); if(!c) return;
      const d = document.createElement('div');
      d.className = 'okc-msg '+role;
      d.textContent = text;
      c.appendChild(d);
      c.scrollTop = c.scrollHeight;
    }
    function clearChat(){
      chatHistory = [];
      const c = chat(); if(c) c.innerHTML = '';
      appendMsg('system','— new session —');
    }
    function renderMemoryList(){
      memory.all().then(list=>{
        const box = document.getElementById('okc-mem-list');
        if(!box) return;
        if(!list.length){ box.innerHTML = '<div class="okc-sub">No memories yet. Add one above, or ask the assistant to remember something.</div>'; return; }
        box.innerHTML = '';
        list.forEach(m=>{
          const row = document.createElement('div');
          row.className = 'okc-mem-item';
          const ts = new Date(m.ts).toLocaleDateString();
          row.innerHTML = '<div class="okc-mem-text"></div><span class="okc-mem-tag">'+ts+'</span><button class="okc-mem-del" title="Delete">✕</button>';
          row.querySelector('.okc-mem-text').textContent = m.text;
          row.querySelector('.okc-mem-del').onclick = async ()=>{ await memory.remove(m.id); renderMemoryList(); };
          box.appendChild(row);
        });
      });
    }
    function renderToolList(){
      const box = document.getElementById('okc-tools-list');
      if(!box) return;
      box.innerHTML = toolRegistry.map(t=>('<div><code>'+t.name+'</code> — '+t.description+'</div>')).join('');
    }
    return { chat, setStatus, appendMsg, clearChat, renderMemoryList, renderToolList };
  })();

  // ---------- 8. PUSH-TO-TALK MIC ----------
  const mic = (function(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null, live = false;
    function setBtn(on){
      const b = document.getElementById('okc-mic');
      if(b) b.classList.toggle('live', !!on);
    }
    function start(){
      if(!SR){ ui.appendMsg('system','Speech recognition not supported on this browser.'); return; }
      if(live) return;
      try{
        rec = new SR();
        rec.continuous = false;
        rec.interimResults = true;
        rec.lang = 'en-US';
        let finalTx = '';
        rec.onresult = e=>{
          let interim='';
          for(let i=e.resultIndex;i<e.results.length;i++){
            const t = e.results[i][0].transcript;
            if(e.results[i].isFinal) finalTx += t; else interim += t;
          }
          const input = document.getElementById('okc-input');
          if(input) input.value = (finalTx+' '+interim).trim();
        };
        rec.onend = ()=>{
          live = false; setBtn(false);
          const input = document.getElementById('okc-input');
          const text = (input&&input.value||'').trim();
          if(text){ input.value=''; ui.appendMsg('user', text); ask(text); }
        };
        rec.onerror = ()=>{ live=false; setBtn(false); };
        rec.start(); live=true; setBtn(true);
      }catch(e){ ui.appendMsg('system','Mic error: '+e.message); live=false; setBtn(false); }
    }
    function stop(){ try{ rec && rec.stop(); }catch(e){} live=false; setBtn(false); }
    return { start, stop, toggle(){ live?stop():start(); } };
  })();

  // ---------- 9. HANDS-FREE (continuous mic + barge-in) ----------
  const handsFree = (function(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    let active = false;
    let listening = false;
    let pausedForTTS = false;
    let silenceTimer = null;
    let buffer = '';
    function setIndicator(){
      const btn = document.getElementById('okc-handsfree-btn');
      if(!btn) return;
      btn.classList.toggle('live', active && listening);
      btn.classList.toggle('paused', active && !listening);
      btn.textContent = active ? (listening ? '● LIVE' : (pausedForTTS?'◌ SPEAKING':'◌ WAIT')) : '○ HANDS-FREE';
    }
    function clearSilence(){ if(silenceTimer){ clearTimeout(silenceTimer); silenceTimer=null; } }
    function armSilence(){
      clearSilence();
      silenceTimer = setTimeout(()=>{
        const text = buffer.trim(); buffer = '';
        if(text.length >= 2 && active){
          ui.appendMsg('user', text);
          ask(text);
        }
      }, 1600);
    }
    // Robust merger: given the existing buffer and a new chunk, return the
    // combined string with any overlap collapsed. Handles three cases:
    //  (a) new chunk is fully contained in buffer        → return buffer unchanged
    //  (b) buffer ends with a prefix of the new chunk    → append only the new tail
    //  (c) totally new content                           → append with a space
    function mergeChunk(buf, chunk){
      buf   = (buf || '').trim();
      chunk = (chunk || '').trim();
      if(!chunk) return buf;
      if(!buf)   return chunk;
      const Bl = buf.toLowerCase();
      const Cl = chunk.toLowerCase();
      // Case (a): exact tail match → already absorbed
      if(Bl.endsWith(Cl)) return buf;
      // Case (a'): chunk is a refinement of the tail by being longer
      // and the buffer's last N chars match the chunk's first N chars.
      // Walk overlap sizes from longest possible down to 1 word.
      const maxOverlap = Math.min(Bl.length, Cl.length);
      for(let n = maxOverlap; n > 0; n--){
        if(Bl.slice(Bl.length - n) === Cl.slice(0, n)){
          // Glue the non-overlapping tail
          return buf + chunk.slice(n);
        }
      }
      // No overlap → append fresh
      return buf + ' ' + chunk;
    }

    function startRec(){
      if(!SR){ ui.appendMsg('system','Hands-free needs SpeechRecognition (use Chrome on Android, or Safari iOS 16+).'); return false; }
      try{
        rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';
        rec.onresult = (e)=>{
          listening = true; setIndicator();
          let gotFinal = false;
          // Pick the LATEST (longest) final chunk in this event — Chrome Android often
          // fires multiple cumulative finals; we want the most refined one.
          let latest = '';
          for(let i=e.resultIndex;i<e.results.length;i++){
            if(e.results[i].isFinal){
              const t = (e.results[i][0].transcript||'').trim();
              if(t.length > latest.length) latest = t;
              gotFinal = true;
            }
          }
          if(gotFinal){
            buffer = mergeChunk(buffer, latest);
            armSilence();
          }
          if(tts.isSpeaking()){ tts.stop(); }
        };
        rec.onerror = ()=>{};
        rec.onend = ()=>{
          listening = false; setIndicator();
          // Do NOT reset buffer here — we want the merge logic to dedup across restarts.
          if(active && !pausedForTTS){
            setTimeout(()=>{ if(active && !pausedForTTS){ try{ rec.start(); }catch(e){} } }, 250);
          }
        };
        rec.start();
        listening = true;
        return true;
      }catch(e){
        ui.appendMsg('system','Hands-free start failed: '+e.message);
        return false;
      }
    }
    function stopRec(){ try{ rec && rec.stop(); }catch(e){} rec = null; listening = false; }
    tts.onStart(()=>{
      if(!active) return;
      pausedForTTS = true;
      stopRec();
      setIndicator();
    });
    tts.onEnd(()=>{
      if(!active){ pausedForTTS=false; return; }
      pausedForTTS = false;
      setTimeout(()=>{ if(active && !pausedForTTS) startRec(); }, 350);
      setIndicator();
    });
    return {
      isActive(){ return active; },
      start(){
        if(active) return;
        if(!tts.isEnabled()){
          tts.enable(true);
          const cb = document.getElementById('okc-tts-on');
          if(cb) cb.checked = true;
          localStorage.setItem('okatan_core_tts','1');
        }
        // If wake is active, suspend it while hands-free runs
        if(wake.isActive()) wake.suspend();
        active = true; buffer = '';
        if(startRec()){
          ui.appendMsg('system','Hands-free ON — just talk. Pause to send.');
          setIndicator();
        } else {
          active = false; setIndicator();
        }
      },
      stop(){
        active = false;
        clearSilence();
        stopRec();
        setIndicator();
        ui.appendMsg('system','Hands-free OFF.');
        // Resume wake-word if it was the source
        if(wake.wasActive()) wake.resume();
      },
      toggle(){ active ? this.stop() : this.start(); }
    };
  })();

  // ---------- 10. WAKE WORD ("Hey Katana") ----------
  // Uses browser SpeechRecognition in a low-attention mode: continuous, scanning every interim
  // result for trigger phrases. On match → triggers a short attended capture, sends to ask().
  // Cooperates with handsFree: if hands-free starts, wake suspends; when hands-free ends,
  // wake resumes if it was on.
  const wake = (function(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    let active = false;
    let wasOn = false;
    let suspended = false;
    let restartTimer = null;
    let captureMode = false;     // briefly after wake, capture user's command
    let captureBuffer = '';
    let captureSilenceTimer = null;
    let captureTimeoutTimer = null;
    let scanWindow = '';         // rolling text window for trigger detection

    function phrases(){
      const raw = localStorage.getItem('okatan_core_wake_phrases');
      const list = (raw || 'hey katana, katana, okatan, hey okatan')
        .split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
      return list;
    }
    function detectTrigger(text){
      const t = String(text||'').toLowerCase();
      for(const p of phrases()){
        if(p.length < 4) continue; // too short to be reliable; require explicit phrases
        if(t.includes(p)) return p;
      }
      return null;
    }
    function detectTriggerLoose(text){
      // Allow single-word triggers ("katana" / "okatan") only on isolated short phrases
      const t = String(text||'').toLowerCase().trim();
      for(const p of phrases()){
        if(p.length < 4) continue;
        if(t === p || t.startsWith(p+' ') || t.endsWith(' '+p) || t.includes(' '+p+' ') || t.includes(p)) return p;
      }
      return null;
    }
    function banner(on){
      const b = document.getElementById('okc-wake-banner');
      if(!b) return;
      b.classList.toggle('show', !!on);
    }
    function setBtn(){
      const b = document.getElementById('okc-wake-btn');
      if(!b) return;
      b.classList.toggle('live', active && !suspended);
      b.textContent = active ? (suspended ? '◌ WAKE (paused)' : '◐ WAKE ON') : '○ WAKE WORD';
    }
    function clearTimers(){
      if(restartTimer){ clearTimeout(restartTimer); restartTimer=null; }
      if(captureSilenceTimer){ clearTimeout(captureSilenceTimer); captureSilenceTimer=null; }
      if(captureTimeoutTimer){ clearTimeout(captureTimeoutTimer); captureTimeoutTimer=null; }
    }
    function endCapture(send){
      if(!captureMode) return;
      captureMode = false;
      const text = captureBuffer.trim();
      captureBuffer = '';
      clearTimers();
      banner(false);
      if(send && text.length >= 2){
        ui.appendMsg('user', text);
        ask(text);
      } else if(send){
        // We woke but got nothing usable — gentle nudge
        ui.appendMsg('system','I heard you. What do you need?');
        if(tts.isEnabled()) tts.say('Yes?');
      }
    }
    function startCapture(){
      captureMode = true;
      captureBuffer = '';
      banner(true);
      // Acknowledge
      if(tts.isEnabled()){ tts.say('Yes?', 'high'); }
      // Hard timeout — 7s after wake, send what we have
      captureTimeoutTimer = setTimeout(()=>endCapture(true), 7000);
    }
    function startRec(){
      if(!SR) return false;
      try{
        rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';
        rec.onresult = (e)=>{
          if(suspended) return;
          // Only look at NEW results since the last fire — keeps scan window small.
          let finalText = '';
          let interim = '';
          for(let i=e.resultIndex;i<e.results.length;i++){
            const t = e.results[i][0].transcript;
            if(e.results[i].isFinal) finalText += t+' '; else interim += t+' ';
          }
          const fresh = (finalText + ' ' + interim).trim();

          if(captureMode){
            // Strip trigger phrase from front if it's still there
            let body = fresh;
            for(const p of phrases()){
              const idx = body.toLowerCase().indexOf(p);
              if(idx !== -1){ body = body.slice(idx + p.length).replace(/^[\s,.!?]+/,''); break; }
            }
            captureBuffer = body;
            // Restart silence timer on every result
            if(captureSilenceTimer) clearTimeout(captureSilenceTimer);
            captureSilenceTimer = setTimeout(()=>endCapture(true), 1600);
            // If user is talking during TTS, kill TTS
            if(tts.isSpeaking() && body.length > 1) tts.stop();
            return;
          }

          // Wake detection on rolling window of latest result chunk
          // Use only the most recent ~120 chars to avoid stale matches
          scanWindow = fresh.slice(-160);
          const trig = detectTriggerLoose(scanWindow);
          if(trig){
            // Reset the buffer to ignore old hits
            scanWindow = '';
            // Begin capture phase
            startCapture();
          }
        };
        rec.onerror = ()=>{};
        rec.onend = ()=>{
          // Auto-restart while active and not suspended
          if(active && !suspended){
            restartTimer = setTimeout(()=>{ try{ rec && rec.start(); }catch(e){
              // recognizer is dead; create a fresh one
              try{ startRec(); }catch(_){}
            } }, 400);
          }
        };
        rec.start();
        return true;
      }catch(e){
        return false;
      }
    }
    function stopRec(){
      try{ rec && rec.stop(); }catch(e){}
      rec = null;
      clearTimers();
    }
    return {
      isActive(){ return active && !suspended; },
      wasActive(){ return wasOn; },
      start(){
        if(!SR){ ui.appendMsg('system','Wake word needs SpeechRecognition (use Chrome on Android, or Safari iOS 16+).'); return; }
        if(active) return;
        // Wake works best with TTS on so the user gets an audible "Yes?"
        if(!tts.isEnabled()){
          tts.enable(true);
          const cb = document.getElementById('okc-tts-on');
          if(cb) cb.checked = true;
          localStorage.setItem('okatan_core_tts','1');
        }
        active = true; wasOn = true; suspended = false;
        if(startRec()){
          ui.appendMsg('system','Wake word armed. Say "Hey Katana".');
          setBtn();
        } else {
          active = false; wasOn = false; setBtn();
        }
      },
      stop(){
        active = false; wasOn = false; suspended = false;
        stopRec();
        banner(false);
        setBtn();
        ui.appendMsg('system','Wake word OFF.');
      },
      // Temporary pause when hands-free takes over the mic
      suspend(){
        if(!active) return;
        suspended = true;
        stopRec();
        banner(false);
        setBtn();
      },
      resume(){
        if(!active) return;
        suspended = false;
        if(startRec()) setBtn();
      },
      toggle(){ active ? this.stop() : this.start(); }
    };
  })();

  // ---------- 10b. VISION (camera + AI vision) ----------
  const vision = (function(){
    let stream = null;
    let facing = 'environment'; // 'environment' (rear) or 'user' (front/selfie)
    let liveMode = false;
    function videoEl(){ return document.getElementById('okc-vision-video'); }
    function canvasEl(){ return document.getElementById('okc-vision-canvas'); }
    function resultEl(){ return document.getElementById('okc-vision-result'); }
    function pickProvider(){
      const forced = (document.getElementById('okc-vision-provider')||{}).value || 'auto';
      if(forced==='gemini' || forced==='openai') return forced;
      // auto: prefer Gemini (cheaper for vision), fall back to OpenAI
      if(sessionStorage.getItem('ok_api_key_gemini')) return 'gemini';
      if(sessionStorage.getItem('ok_api_key_openai')) return 'openai';
      return null;
    }
    function visionKey(provider){
      return sessionStorage.getItem(provider==='gemini'?'ok_api_key_gemini':'ok_api_key_openai')||'';
    }
    function isStreaming(){
      const v = videoEl();
      return !!(stream && v && v.videoWidth > 0);
    }
    async function start(){
      if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        ui.appendMsg('system','Camera not supported in this browser.');
        return false;
      }
      try{
        if(stream){ try{ stream.getTracks().forEach(t=>t.stop()); }catch(e){} stream=null; }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing } },
          audio: false
        });
        const v = videoEl();
        if(v){ v.srcObject = stream; }
        const r = resultEl();
        if(r) r.textContent = 'Camera online. Point at something and tap WHAT AM I LOOKING AT?';
        return true;
      }catch(e){
        const r = resultEl();
        if(r) r.textContent = 'Camera blocked. Use HTTPS, then grant camera permission.';
        return false;
      }
    }
    function stop(){
      if(stream){ try{ stream.getTracks().forEach(t=>t.stop()); }catch(e){} stream=null; }
      const v = videoEl(); if(v) v.srcObject = null;
    }
    async function flip(){
      facing = (facing==='environment') ? 'user' : 'environment';
      if(stream) await start();
    }
    function snapBase64(){
      const v = videoEl(), c = canvasEl();
      if(!v || !c || !v.videoWidth) return null;
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return { dataUrl: c.toDataURL('image/jpeg', 0.72) };
    }
    async function analyze(question){
      const q = (question && question.trim()) || 'What am I looking at? Be concise and useful.';
      if(!isStreaming()){
        // Try to start camera first
        const ok = await start();
        if(!ok) return 'Camera is not available.';
        // Give the video a moment to grab a frame
        await new Promise(r=>setTimeout(r, 700));
      }
      const provider = pickProvider();
      if(!provider) return 'No vision API key set. Add a Gemini or OpenAI key in CORE → CONFIG.';
      const key = visionKey(provider);
      const snap = snapBase64();
      if(!snap) return 'Could not capture a frame from the camera.';
      const r = resultEl(); if(r) r.textContent = 'Scanning ('+provider+')...';
      try{
        let answer = '';
        if(provider === 'gemini'){
          const base64 = snap.dataUrl.split(',')[1];
          const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+encodeURIComponent(key),{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
              contents:[{ parts:[
                { text: 'You are OKATAN Vision, a JARVIS-style assistant analysing the user\'s live camera feed. Answer the question directly, briefly, and usefully. Avoid hedging. Question: ' + q },
                { inline_data: { mime_type:'image/jpeg', data: base64 } }
              ]}],
              generationConfig: { temperature: 0.3, maxOutputTokens: 250 }
            })
          });
          const j = await res.json();
          if(!res.ok) throw new Error(j?.error?.message || 'Gemini vision failed');
          answer = j?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join(' ').trim() || 'I could not identify it.';
        } else {
          const res = await fetch('https://api.openai.com/v1/chat/completions',{
            method:'POST',
            headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
            body: JSON.stringify({
              model:'gpt-4o-mini',
              messages:[{ role:'user', content:[
                { type:'text', text: 'You are OKATAN Vision, a JARVIS-style assistant analysing the user\'s live camera feed. Answer the question directly, briefly, and usefully. Avoid hedging. Question: ' + q },
                { type:'image_url', image_url:{ url: snap.dataUrl } }
              ]}],
              max_tokens: 250,
              temperature: 0.3
            })
          });
          const j = await res.json();
          if(!res.ok) throw new Error(j?.error?.message || 'OpenAI vision failed');
          answer = j?.choices?.[0]?.message?.content?.trim() || 'I could not identify it.';
        }
        if(r) r.textContent = answer;
        return answer;
      }catch(e){
        const err = 'Vision error: '+(e.message||e);
        if(r) r.textContent = err;
        return err;
      }
    }
    return {
      start, stop, flip,
      isStreaming,
      analyze,
      isLive(){ return liveMode; },
      setLive(v){
        liveMode = !!v;
        const btn = document.getElementById('okc-vision-live');
        if(btn){
          btn.classList.toggle('live', liveMode);
          btn.textContent = liveMode ? '● LIVE MODE' : '○ LIVE MODE';
        }
        if(liveMode && !isStreaming()) start();
      },
      toggleLive(){ this.setLive(!liveMode); }
    };
  })();

  // ---------- 10c. PHILIPS HUE ----------
  const hue = (function(){
    const KEY_BRIDGE = 'okatan_hue_bridge_v1';   // IP
    const KEY_USER   = 'okatan_hue_user_v1';     // username token returned by /api on pair

    function state(){
      return {
        bridge: localStorage.getItem(KEY_BRIDGE) || '',
        user:   localStorage.getItem(KEY_USER)   || ''
      };
    }
    function setStatus(text){
      const el = document.getElementById('okc-hue-status');
      if(el) el.textContent = text;
    }
    function isPaired(){
      const s = state(); return !!(s.bridge && s.user);
    }
    async function discover(){
      // Hue's discovery endpoint returns a list of bridge IPs on the local net.
      // Works as long as your phone is on the same Wi-Fi.
      try{
        const r = await fetch('https://discovery.meethue.com/');
        if(!r.ok) throw new Error('Discovery service unreachable');
        const arr = await r.json();
        if(!arr.length) return null;
        const ip = arr[0].internalipaddress;
        localStorage.setItem(KEY_BRIDGE, ip);
        const ipBox = document.getElementById('okc-hue-ip');
        if(ipBox) ipBox.value = ip;
        return ip;
      }catch(e){
        return null;
      }
    }
    async function pair(ipOverride){
      const ip = ipOverride || (document.getElementById('okc-hue-ip')||{}).value || state().bridge;
      if(!ip) throw new Error('No bridge IP. Tap FIND BRIDGE first, or enter one manually.');
      const r = await fetch('http://'+ip+'/api',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ devicetype: 'okatan_core#user' })
      });
      const j = await r.json();
      if(!Array.isArray(j) || !j[0]) throw new Error('Bridge gave no response.');
      if(j[0].error){
        const msg = j[0].error.description || 'Pair failed';
        throw new Error(msg + ' — make sure you pressed the round link button on top of the bridge first.');
      }
      if(j[0].success && j[0].success.username){
        const user = j[0].success.username;
        localStorage.setItem(KEY_BRIDGE, ip);
        localStorage.setItem(KEY_USER, user);
        return user;
      }
      throw new Error('Unexpected response from bridge.');
    }
    async function get(path){
      const s = state();
      if(!isPaired()) throw new Error('Hue bridge not paired.');
      const r = await fetch('http://'+s.bridge+'/api/'+s.user+'/'+path);
      if(!r.ok) throw new Error('Hue request failed.');
      return r.json();
    }
    async function put(path, body){
      const s = state();
      if(!isPaired()) throw new Error('Hue bridge not paired.');
      const r = await fetch('http://'+s.bridge+'/api/'+s.user+'/'+path,{
        method:'PUT',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      if(!r.ok) throw new Error('Hue PUT failed.');
      return r.json();
    }
    async function lights(){ return get('lights'); }
    async function groups(){ return get('groups'); }

    // Set a single light: { on, brightness (0-100), color: 'red'|'#hex'|{x,y} }
    function brightnessToHue(pct){
      return Math.max(0, Math.min(254, Math.round(pct/100 * 254)));
    }
    // Approx hex -> CIE xy (Hue's native color space)
    function hexToXy(hex){
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
      if(!m) return null;
      const r = parseInt(m[1],16)/255, g = parseInt(m[2],16)/255, b = parseInt(m[3],16)/255;
      // Gamma correction
      const f = c => c > 0.04045 ? Math.pow((c+0.055)/1.055, 2.4) : c/12.92;
      const R=f(r), G=f(g), B=f(b);
      // sRGB → XYZ (D65)
      const X = R*0.4124 + G*0.3576 + B*0.1805;
      const Y = R*0.2126 + G*0.7152 + B*0.0722;
      const Z = R*0.0193 + G*0.1192 + B*0.9505;
      const sum = X+Y+Z;
      if(sum === 0) return [0.3127, 0.3290];
      return [X/(sum), Y/(sum)];
    }
    const COLORS = {
      red:'#ff0000', orange:'#ff8800', yellow:'#ffd900', green:'#00ff00',
      blue:'#0040ff', purple:'#a020f0', pink:'#ff66cc', white:'#ffffff',
      warm:'#ffb070', cool:'#a0c8ff'
    };
    function colorToState(color){
      if(!color) return {};
      if(typeof color !== 'string') return {};
      const c = color.toLowerCase().trim();
      const hex = COLORS[c] || (c.startsWith('#') ? c : null);
      if(!hex) return {};
      const xy = hexToXy(hex);
      if(!xy) return {};
      return { xy };
    }
    async function setLight(id, opts){
      const body = {};
      if(opts.on !== undefined) body.on = !!opts.on;
      if(opts.brightness !== undefined) body.bri = brightnessToHue(opts.brightness);
      Object.assign(body, colorToState(opts.color));
      body.transitiontime = 4; // 0.4s smooth transition
      return put('lights/'+encodeURIComponent(id)+'/state', body);
    }
    async function setGroup(id, opts){
      const body = {};
      if(opts.on !== undefined) body.on = !!opts.on;
      if(opts.brightness !== undefined) body.bri = brightnessToHue(opts.brightness);
      Object.assign(body, colorToState(opts.color));
      body.transitiontime = 4;
      return put('groups/'+encodeURIComponent(id)+'/action', body);
    }
    // Find a light or group by name (case-insensitive, partial)
    async function findLightId(name){
      const all = await lights();
      const key = String(name||'').toLowerCase().trim();
      for(const [id, l] of Object.entries(all)){
        if((l.name||'').toLowerCase() === key) return id;
      }
      for(const [id, l] of Object.entries(all)){
        if((l.name||'').toLowerCase().includes(key)) return id;
      }
      return null;
    }
    async function findGroupId(name){
      const all = await groups();
      const key = String(name||'').toLowerCase().trim();
      // Special name: "all" → group 0 = broadcast
      if(key === 'all' || key === 'everything' || key === 'all lights') return '0';
      for(const [id, g] of Object.entries(all)){
        if((g.name||'').toLowerCase() === key) return id;
      }
      for(const [id, g] of Object.entries(all)){
        if((g.name||'').toLowerCase().includes(key)) return id;
      }
      return null;
    }
    function forget(){
      localStorage.removeItem(KEY_BRIDGE);
      localStorage.removeItem(KEY_USER);
    }
    return {
      state, isPaired, discover, pair, forget,
      lights, groups, setLight, setGroup,
      findLightId, findGroupId,
      setStatus,
      colorList: ()=>Object.keys(COLORS)
    };
  })();

  // ---------- 10d. TOOL REGISTRATIONS (vision + hue, after modules) ----------
  registerTool({
    name:'look_at_view',
    description:'Use the device camera to see what the user is looking at and answer their question about it. Call this whenever the user asks "what am I looking at", "what is this", "what does this say", "identify this", or any question that requires SEEING the physical world. Optionally specify a question for context.',
    parameters:{
      type:'object',
      properties:{
        question:{ type:'string', description:'Optional specific question about the view. If omitted, gives a general description.' }
      }
    },
    run: async ({question})=>{
      const answer = await vision.analyze(question || 'What am I looking at? Be concise and useful.');
      return answer;
    }
  });
  registerTool({
    name:'camera_on',
    description:'Turn the device camera on for vision queries. Use before look_at_view if camera is off.',
    parameters:{ type:'object', properties:{} },
    run: async ()=>{ const ok = await vision.start(); return ok ? 'Camera on.' : 'Camera failed to start.'; }
  });
  registerTool({
    name:'camera_off',
    description:'Turn the device camera off.',
    parameters:{ type:'object', properties:{} },
    run: ()=>{ vision.stop(); return 'Camera off.'; }
  });

  // --- Hue tools ---
  registerTool({
    name:'hue_status',
    description:'Check whether the Philips Hue bridge is paired and reachable. Use when the user asks about light status, troubleshooting, or whether Hue is connected.',
    parameters:{ type:'object', properties:{} },
    run: async ()=>{
      if(!hue.isPaired()) return 'Hue bridge not paired. Open CORE → HUE tab to set up.';
      try{
        const list = await hue.lights();
        const count = Object.keys(list).length;
        return 'Hue bridge connected. '+count+' light(s) available.';
      }catch(e){
        return 'Bridge paired but unreachable: '+(e.message||e);
      }
    }
  });
  registerTool({
    name:'hue_list_lights',
    description:'List all Philips Hue lights and their current state.',
    parameters:{ type:'object', properties:{} },
    run: async ()=>{
      if(!hue.isPaired()) return 'Hue not paired.';
      const list = await hue.lights();
      return Object.entries(list).map(([id,l])=>({
        id, name:l.name,
        on: !!(l.state&&l.state.on),
        brightness_pct: l.state&&l.state.bri ? Math.round(l.state.bri/254*100) : 0,
        reachable: !!(l.state&&l.state.reachable)
      }));
    }
  });
  registerTool({
    name:'hue_list_rooms',
    description:'List Philips Hue rooms and groups (e.g. "Living Room", "Kitchen").',
    parameters:{ type:'object', properties:{} },
    run: async ()=>{
      if(!hue.isPaired()) return 'Hue not paired.';
      const list = await hue.groups();
      return Object.entries(list).map(([id,g])=>({ id, name:g.name, type:g.type, any_on: g.state&&g.state.any_on }));
    }
  });
  registerTool({
    name:'hue_set_light',
    description:'Control a single Philips Hue light by name. Examples: turn the bedside lamp on, dim the desk light to 30%, set the kitchen light to red. Brightness is 0-100. Color can be a name (red, orange, yellow, green, blue, purple, pink, white, warm, cool) or a hex like #ff8800.',
    parameters:{
      type:'object',
      properties:{
        name:{ type:'string', description:'Name of the light (partial match works)' },
        on:{ type:'boolean' },
        brightness:{ type:'integer', minimum:0, maximum:100 },
        color:{ type:'string' }
      },
      required:['name']
    },
    run: async ({name, on, brightness, color})=>{
      if(!hue.isPaired()) return 'Hue not paired.';
      const id = await hue.findLightId(name);
      if(!id) return 'No light named "'+name+'".';
      const opts = {};
      if(on !== undefined) opts.on = on;
      if(brightness !== undefined){ opts.brightness = brightness; if(opts.on === undefined) opts.on = brightness > 0; }
      if(color) { opts.color = color; if(opts.on === undefined) opts.on = true; }
      await hue.setLight(id, opts);
      return 'Updated light "'+name+'".';
    }
  });
  registerTool({
    name:'hue_set_room',
    description:'Control a whole Philips Hue room or group by name (e.g. "Living Room", "Kitchen", or "all" for every light). Use this for plural requests like "turn off the lights" → name="all".',
    parameters:{
      type:'object',
      properties:{
        name:{ type:'string' },
        on:{ type:'boolean' },
        brightness:{ type:'integer', minimum:0, maximum:100 },
        color:{ type:'string' }
      },
      required:['name']
    },
    run: async ({name, on, brightness, color})=>{
      if(!hue.isPaired()) return 'Hue not paired.';
      const id = await hue.findGroupId(name);
      if(id === null) return 'No room named "'+name+'".';
      const opts = {};
      if(on !== undefined) opts.on = on;
      if(brightness !== undefined){ opts.brightness = brightness; if(opts.on === undefined) opts.on = brightness > 0; }
      if(color) { opts.color = color; if(opts.on === undefined) opts.on = true; }
      await hue.setGroup(id, opts);
      return 'Updated room "'+name+'".';
    }
  });

  // ---------- 11. UI WIRING ----------
  function wireUi(){
    // Tabs
    document.querySelectorAll('#okatan-core-app .okc-tab').forEach(btn=>{
      btn.onclick = ()=>{
        document.querySelectorAll('#okatan-core-app .okc-tab').forEach(b=>b.classList.remove('active'));
        document.querySelectorAll('#okatan-core-app .okc-tab-pane').forEach(p=>p.classList.remove('active'));
        btn.classList.add('active');
        const pane = document.querySelector('#okatan-core-app .okc-tab-pane[data-okc-pane="'+btn.dataset.okcTab+'"]');
        if(pane) pane.classList.add('active');
        if(btn.dataset.okcTab==='memory') ui.renderMemoryList();
        if(btn.dataset.okcTab==='tools')  ui.renderToolList();
        if(btn.dataset.okcTab==='hue')    bus.emit('hue:opened');
        if(btn.dataset.okcTab==='settings'){
          document.getElementById('okc-key-openai').value = sessionStorage.getItem('ok_api_key_openai')||'';
          document.getElementById('okc-key-gemini').value = sessionStorage.getItem('ok_api_key_gemini')||'';
          document.getElementById('okc-key-groq').value   = sessionStorage.getItem('ok_api_key_groq')||'';
          document.getElementById('okc-sysprompt').value = loadSystemPrompt();
          document.getElementById('okc-tts-on').checked = tts.isEnabled();
          document.getElementById('okc-wake-phrases').value = localStorage.getItem('okatan_core_wake_phrases') || 'hey katana, katana, okatan, hey okatan';
          bus.emit('settings:opened');
        }
      };
    });

    const input = document.getElementById('okc-input');
    const send = ()=>{
      const v = (input.value||'').trim();
      if(!v) return;
      input.value = '';
      ui.appendMsg('user', v);
      ask(v);
    };
    document.getElementById('okc-send').onclick = send;
    input.addEventListener('keydown', e=>{
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }
    });
    document.getElementById('okc-stop').onclick = ()=>{ tts.stop(); ui.setStatus('STOPPED', false); };
    document.getElementById('okc-mic').onclick = ()=>mic.toggle();
    document.getElementById('okc-handsfree-btn').onclick = ()=>handsFree.toggle();
    document.getElementById('okc-wake-btn').onclick = ()=>wake.toggle();

    document.getElementById('okc-mem-add').onclick = async ()=>{
      const v = document.getElementById('okc-mem-input').value.trim();
      if(!v) return;
      await memory.add(v,'fact');
      document.getElementById('okc-mem-input').value='';
      ui.renderMemoryList();
    };
    document.getElementById('okc-mem-clear').onclick = async ()=>{
      const ok = await askConfirm('Delete all stored memories? This cannot be undone.');
      if(ok){ await memory.clear(); ui.renderMemoryList(); }
    };

    document.getElementById('okc-key-save').onclick = ()=>{
      const o = document.getElementById('okc-key-openai').value.trim();
      const g = document.getElementById('okc-key-gemini').value.trim();
      const q = document.getElementById('okc-key-groq').value.trim();
      if(o) sessionStorage.setItem('ok_api_key_openai', o);
      if(g) sessionStorage.setItem('ok_api_key_gemini', g);
      if(q) sessionStorage.setItem('ok_api_key_groq', q);
      ui.appendMsg('system','Keys saved for this session.');
    };

    function populateBrowserVoices(){
      const sel = document.getElementById('okc-tts-voice');
      if(!sel) return;
      const voices = tts.listBrowserVoices();
      const current = tts.settings().voiceName;
      sel.innerHTML = '<option value="">— device default —</option>' +
        voices.map(v=>'<option value="'+v.name.replace(/"/g,'&quot;')+'">'+v.name+' ('+v.lang+')'+(v.localService?'':' [net]')+'</option>').join('');
      if(current) sel.value = current;
    }
    if(window.speechSynthesis){
      window.speechSynthesis.onvoiceschanged = populateBrowserVoices;
    }

    document.getElementById('okc-tts-on').addEventListener('change', e=>{
      tts.enable(e.target.checked);
      localStorage.setItem('okatan_core_tts', e.target.checked?'1':'0');
    });
    if(localStorage.getItem('okatan_core_tts')==='1'){ tts.enable(true); }

    document.getElementById('okc-tts-engine').addEventListener('change', e=>tts.setEngine(e.target.value));
    document.getElementById('okc-tts-voice').addEventListener('change', e=>tts.setBrowserVoice(e.target.value));
    document.getElementById('okc-tts-openai-voice').addEventListener('change', e=>tts.setOpenAIVoice(e.target.value));
    document.getElementById('okc-tts-rate').addEventListener('change', e=>tts.setRate(parseFloat(e.target.value)||1.0));
    document.getElementById('okc-tts-test').onclick = ()=>{
      const was = tts.isEnabled();
      tts.enable(true);
      tts.say('OKATAN voice check complete. Standing by.', 'high');
      if(!was) setTimeout(()=>tts.enable(false), 4500);
    };

    // Wake phrases save
    document.getElementById('okc-wake-save').onclick = ()=>{
      const v = document.getElementById('okc-wake-phrases').value.trim();
      if(v){
        localStorage.setItem('okatan_core_wake_phrases', v);
        ui.appendMsg('system','Wake phrases saved.');
        if(wake.isActive()){ wake.stop(); wake.start(); }
      }
    };

    document.getElementById('okc-sys-save').onclick = ()=>{
      saveSystemPrompt(document.getElementById('okc-sysprompt').value);
      ui.appendMsg('system','System prompt saved.');
    };
    document.getElementById('okc-sys-reset').onclick = ()=>{
      const def = defaultSystemPrompt();
      document.getElementById('okc-sysprompt').value = def;
      saveSystemPrompt(def);
    };

    bus.on('settings:opened', ()=>{
      populateBrowserVoices();
      const s = tts.settings();
      document.getElementById('okc-tts-engine').value = s.engine;
      document.getElementById('okc-tts-openai-voice').value = s.openaiVoice;
      document.getElementById('okc-tts-rate').value = s.rate;
    });

    bus.on('memory:changed', ()=>{
      const active = document.querySelector('#okatan-core-app .okc-tab.active');
      if(active && active.dataset.okcTab==='memory') ui.renderMemoryList();
    });

    bus.on('hue:opened', ()=>renderHueState());

    // ----- VISION wiring -----
    document.getElementById('okc-vision-start').onclick = ()=>vision.start();
    document.getElementById('okc-vision-stop').onclick = ()=>vision.stop();
    document.getElementById('okc-vision-flip').onclick = ()=>vision.flip();
    document.getElementById('okc-vision-scan').onclick = async ()=>{
      const ans = await vision.analyze();
      ui.appendMsg('assistant', ans);
      tts.say(ans);
    };
    document.getElementById('okc-vision-live').onclick = ()=>vision.toggleLive();
    const vp = localStorage.getItem('okatan_vision_provider_core') || 'auto';
    const vpSel = document.getElementById('okc-vision-provider');
    if(vpSel){
      vpSel.value = vp;
      vpSel.onchange = ()=>localStorage.setItem('okatan_vision_provider_core', vpSel.value);
    }

    // ----- HUE wiring -----
    function renderHueState(){
      const s = hue.state();
      const ipBox = document.getElementById('okc-hue-ip');
      if(ipBox && !ipBox.value && s.bridge) ipBox.value = s.bridge;
      if(hue.isPaired()){
        hue.setStatus('Paired. Bridge: '+s.bridge);
        renderHueLights();
        renderHueGroups();
      } else if(s.bridge){
        hue.setStatus('Bridge found at '+s.bridge+'. Press the link button on the bridge, then tap PAIR.');
      } else {
        hue.setStatus('Not connected. Tap FIND BRIDGE.');
      }
    }
    async function renderHueLights(){
      const box = document.getElementById('okc-hue-lights');
      if(!box) return;
      try{
        const list = await hue.lights();
        const ids = Object.keys(list);
        if(!ids.length){ box.innerHTML = '<div class="okc-sub">No lights found.</div>'; return; }
        box.innerHTML = '';
        ids.forEach(id=>{
          const l = list[id];
          const row = document.createElement('div');
          row.className = 'okc-hue-light-row';
          const isOn = !!(l.state && l.state.on);
          const bri = l.state && l.state.bri ? Math.round(l.state.bri/254*100) : 0;
          row.innerHTML =
            '<div class="okc-hue-dot" style="background:'+(isOn?'#ffd060':'#222')+'"></div>'+
            '<div class="okc-hue-name"></div>'+
            '<input type="range" class="okc-hue-slider" min="0" max="100" value="'+bri+'" '+(isOn?'':'disabled')+'>'+
            '<button class="okc-hue-toggle '+(isOn?'on':'')+'">'+(isOn?'ON':'OFF')+'</button>';
          row.querySelector('.okc-hue-name').textContent = l.name || ('Light '+id);
          row.querySelector('.okc-hue-toggle').onclick = async ()=>{
            await hue.setLight(id, { on: !isOn });
            setTimeout(renderHueLights, 400);
          };
          row.querySelector('.okc-hue-slider').onchange = async (e)=>{
            const v = parseInt(e.target.value)||0;
            await hue.setLight(id, { brightness: v, on: v>0 });
            setTimeout(renderHueLights, 400);
          };
          box.appendChild(row);
        });
      }catch(e){
        box.innerHTML = '<div class="okc-sub">Could not load lights: '+(e.message||e)+'</div>';
      }
    }
    async function renderHueGroups(){
      const box = document.getElementById('okc-hue-groups');
      if(!box) return;
      try{
        const list = await hue.groups();
        const ids = Object.keys(list);
        if(!ids.length){ box.innerHTML = '<div class="okc-sub">No rooms found.</div>'; return; }
        box.innerHTML = '';
        ids.forEach(id=>{
          const g = list[id];
          const row = document.createElement('div');
          row.className = 'okc-hue-light-row';
          const anyOn = !!(g.state && g.state.any_on);
          row.innerHTML =
            '<div class="okc-hue-dot" style="background:'+(anyOn?'#ffd060':'#222')+'"></div>'+
            '<div class="okc-hue-name"></div>'+
            '<button class="okc-hue-toggle '+(anyOn?'on':'')+'">'+(anyOn?'ON':'OFF')+'</button>';
          row.querySelector('.okc-hue-name').textContent = (g.name||'Room '+id) + ' ['+(g.type||'')+']';
          row.querySelector('.okc-hue-toggle').onclick = async ()=>{
            await hue.setGroup(id, { on: !anyOn });
            setTimeout(()=>{ renderHueGroups(); renderHueLights(); }, 400);
          };
          box.appendChild(row);
        });
      }catch(e){
        box.innerHTML = '<div class="okc-sub">Could not load rooms: '+(e.message||e)+'</div>';
      }
    }
    document.getElementById('okc-hue-discover').onclick = async ()=>{
      hue.setStatus('Searching for bridge...');
      const ip = await hue.discover();
      if(ip){
        hue.setStatus('Bridge found at '+ip+'. Now press the round link button on top of your bridge, then tap PAIR within 30 seconds.');
      } else {
        hue.setStatus('No bridge found. Make sure your phone is on the same Wi-Fi. You can also enter the IP manually.');
      }
    };
    document.getElementById('okc-hue-pair').onclick = async ()=>{
      try{
        hue.setStatus('Pairing... (did you press the link button?)');
        await hue.pair();
        hue.setStatus('Paired successfully.');
        renderHueState();
      }catch(e){
        hue.setStatus('Pair failed: '+(e.message||e));
      }
    };
    document.getElementById('okc-hue-refresh').onclick = ()=>renderHueState();
    document.getElementById('okc-hue-forget').onclick = async ()=>{
      const ok = await askConfirm('Forget the paired Hue bridge? You\'ll need to pair again.');
      if(ok){ hue.forget(); renderHueState(); }
    };

    ui.appendMsg('system','OKATAN CORE v1.3.1 online — Vision + Hue (tabs fixed). Try: "what am I looking at?" or "turn on the kitchen light".');
  }

  // ---------- 12. APP REGISTRATION ----------
  function openCore(){
    if(typeof window.okatanShowApp==='function') window.okatanShowApp('okatan-core-app');
    if(typeof window.okatanTrackRecent==='function'){
      try{ window.okatanTrackRecent('okacore'); }catch(e){}
    }
  }
  window.okatanOpenCore = openCore;

  function registerInDrawer(){
    try{
      if(typeof OKL_ICON_MAP!=='undefined') OKL_ICON_MAP['okacore']='okatan';
      if(typeof OKL_LABEL_MAP!=='undefined') OKL_LABEL_MAP['okacore']='CORE';
      if(typeof OKL_FN_MAP!=='undefined')   OKL_FN_MAP['okacore']='okatanOpenCore()';
      if(window.okatanAllApps && !window.okatanAllApps.some(a=>a.id==='okacore')){
        window.okatanAllApps.push({id:'okacore',label:'CORE',ic:'okatan',fn:'okatanOpenCore()'});
      }
      const grid = document.getElementById('okl-drawer-grid');
      if(grid && !grid.querySelector('[data-app-id="okacore"]')){
        const b = document.createElement('button');
        b.className = 'okl-app';
        b.dataset.appId = 'okacore';
        b.dataset.drawer = '1';
        b.innerHTML = '<div class="okl-icon okatan"></div><button type="button" class="okl-drawer-add" title="Add to home">+</button><div>CORE</div>';
        b.onclick = function(e){
          if(e&&e.target&&e.target.closest&&e.target.closest('.okl-drawer-add')) return;
          if(typeof okatanCloseDrawer==='function') okatanCloseDrawer();
          setTimeout(()=>{ if(typeof okatanTrackRecent==='function') okatanTrackRecent('okacore'); openCore(); }, 180);
        };
        const a = b.querySelector('.okl-drawer-add');
        if(a) a.onclick = function(e){
          e.preventDefault(); e.stopPropagation();
          if(typeof okatanAddAppToCurrentPage==='function') okatanAddAppToCurrentPage('okacore');
        };
        grid.appendChild(b);
      }
    }catch(e){ console.warn('[OKATAN CORE drawer reg]', e); }
  }

  // ---------- 13. PUBLIC API ----------
  window.OKATAN = {
    __loaded: true,
    version: 'core-1.3.1',
    bus, memory, tts, handsFree, wake, vision, hue,
    ask,
    tools: { register: registerTool, list: ()=>toolRegistry.slice(), run: runTool },
    open: openCore,
    ui: {
      clearChat: ()=>ui.clearChat()
    }
  };

  function init(){
    wireUi();
    registerInDrawer();
    bus.emit('core:ready');
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 300);
  }
})();
