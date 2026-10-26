
(() => {
const S = {
  db:null, fs:null, user:null, email:null, memberRes:null, isCoord:false, ready:false,
  residents:{}, hospitals:{}, schedule:{}, vacations:{}, members:{}, coordinators:{}, marks:{}, requests:{}, decisions:{}, config:{}, stages:{}, stageAssign:{}, form:{hosp:'',stage:'',until:'',days:[]},
  tab:'escala', seg:'todos', monthOpen:false, date:null, month:null, compFilter:'pend', manageDate:null, profiles:{}, busy:false, pending:false
};
// ---------- Firebase: helpers ----------
function fmtDist(m){ m=Math.round(m); return m<1000 ? `${m} m` : `${(m/1000).toFixed(1).replace('.',',')} km`; }
function normEmail(v, quiet){
  const e=String(v||'').trim().toLowerCase();
  if(!e) return '';
  if(!/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(e)){ if(!quiet) toast('E-mail inválido.'); return false; }
  return e;
}
function monthAdd(ym, n){ const [y,m]=ym.split('-').map(Number); const d=new Date(y,m-1+n,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
// Mesma conta das regras de segurança do Firestore (aproximação plana, ótima para algumas centenas de metros).
function distM(g, h){ const dy=(g.lat-h.lat)*111320, dx=(g.lng-h.lng)*111320*h.cosLat; return Math.round(Math.sqrt(dx*dx+dy*dy)); }
function locate(){
  return new Promise((res, rej)=>{
    if(!navigator.geolocation) return rej({code:'nogeo'});
    navigator.geolocation.getCurrentPosition(
      p=>res({lat:+p.coords.latitude.toFixed(6), lng:+p.coords.longitude.toFixed(6), acc:Math.round(p.coords.accuracy||0)}),
      e=>rej({code: e.code===1?'denied': e.code===3?'timeout':'unavailable'}),
      {enableHighAccuracy:true, timeout:20000, maximumAge:0});
  });
}
function modal(inner){ document.getElementById('modal').innerHTML=`<div class="overlay" data-act="close"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`; }
function sheetMsg(text){ modal(`<p style="margin:0">${text}</p>`); }
const mapLink=(lat,lng)=>`<a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener">Conferir no mapa</a>`;

// ---------- check-in / checkout ----------
async function doMark(kind, sid){
  const s=allShifts().find(x=>x.id===sid); if(!s) return;
  const h=S.hospitals[s.hospitalId]||{}; const geo=h.geo;
  S.pendingGeo=null;
  if(!geo){ await writeMark(kind, s, {}); return; }
  sheetMsg(`Confirmando sua localização no ${esc(h.short||h.name||'hospital')}…`);
  let pos=null, err=null;
  try{ pos=await locate(); }catch(e){ err=e; }
  if(pos){
    const g={lat:pos.lat, lng:pos.lng, acc:pos.acc, dist:distM(pos, geo)};
    if(g.dist<=geo.radius){ closeModal(); await writeMark(kind, s, {[kind+'Geo']:g}); return; }
    S.pendingGeo=g; return geoFail(kind, s, h, g, null);
  }
  geoFail(kind, s, h, null, err);
}
function geoFail(kind, s, h, g, err){
  const what=kind==='in'?'check-in':'checkout';
  const msg = g
    ? `Você está a <b>${fmtDist(g.dist)}</b> do ${esc(h.name)}. O ${what} é liberado a até ${fmtDist(h.geo.radius)} do hospital.${g.acc>150?` A precisão do GPS agora está baixa (±${g.acc} m); tente perto de uma janela.`:''}`
    : err?.code==='denied'
      ? 'O celular não liberou a sua localização para este site. Permita a localização nas configurações do navegador e tente de novo.'
      : 'Não foi possível pegar a sua localização. Confira se a localização (GPS) do celular está ligada e tente de novo.';
  modal(`<div class="row between"><h2>${g?'Fora da área do hospital':'Localização indisponível'}</h2><button class="ghost" data-act="close">Fechar</button></div>
    <p style="margin:0">${msg}</p>
    <div class="row"><button class="primary" data-act="retrygeo" data-k="${kind}" data-id="${esc(s.id)}">Tentar de novo</button></div>
    <hr class="sep">
    <label class="f">Registrar mesmo assim, com justificativa<textarea id="gNote" placeholder="Ex.: estou no prédio anexo; o GPS não pega no centro cirúrgico"></textarea></label>
    <div class="row"><button data-act="forcegeo" data-k="${kind}" data-id="${esc(s.id)}">Registrar ${what} com justificativa</button></div>
    <div class="muted" style="font-size:.82rem">A coordenação vê este registro marcado como fora da área.</div>`);
}
async function writeMark(kind, s, extra){
  const ref=S.fs.doc(`checkins/${s.month}/marks/${s.id}`);
  const ST=firebase.firestore.FieldValue.serverTimestamp();
  let ok=false;
  await guard(async()=>{
    if(kind==='in') await ref.set({residentId:s.residentId, date:s.date, inAt:ST, ...extra});
    else await ref.update({outAt:ST, ...extra});
    ok=true;
  }, kind==='in'?'Check-in registrado':'Checkout registrado');
  if(ok && kind==='out'){
    const c=S.marks[s.id]; const ex=extraMins(s,{in:c?.in, out:new Date().toISOString()});
    if(ex>=10){ S.tab='escala'; S.seg='meus'; render(); openAsk(s.id); }
  }
}

// ---------- check-in records (one document per shift) ----------
const markL={}; const fetchedMarks=new Set();
function normMark(d){
  const x=d.data({serverTimestamps:'estimate'})||{};
  const ts=t=>t&&t.toDate?t.toDate().toISOString():null;
  return {...x, in:ts(x.inAt), out:ts(x.outAt), month:d.ref.parent.parent.id};
}
function listenMarks(key, q){
  if(markL[key]) return;
  markL[key]=q.onSnapshot(snap=>{
    snap.docChanges().forEach(ch=>{ if(ch.type==='removed') delete S.marks[ch.doc.id]; else S.marks[ch.doc.id]=normMark(ch.doc); });
    render();
  }, err=>console.error('marks', key, err));
}
function ensureMarks(){
  if(!S.fs||!S.ready) return;
  const want=new Set(), cur=today().slice(0,7), prev=monthAdd(cur,-1);
  const days=[S.date, today(), addDays(today(),-1)]; if(S.tab==='gerenciar') days.push(S.manageDate);
  for (const d of days){ const k='d|'+d; want.add(k); listenMarks(k, S.fs.collection(`checkins/${d.slice(0,7)}/marks`).where('date','==',d)); }
  const r=myRes();
  if(r) for (const m of [cur, prev]){ const k='r|'+m; want.add(k); listenMarks(k, S.fs.collection(`checkins/${m}/marks`).where('residentId','==',r)); }
  if(S.isCoord) for (const m of [cur, prev]){ const k='f|'+m; want.add(k); listenMarks(k, S.fs.collection(`checkins/${m}/marks`).where('flag','==',true)); }
  for (const k of Object.keys(markL)) if(k.startsWith('d|') && !want.has(k)){ markL[k](); delete markL[k]; }
}
function fetchMarks(reqs){
  for (const q of reqs){
    const sid=q.shiftId, m=(q.shiftDate||'').slice(0,7);
    if(!sid||!m||S.marks[sid]||fetchedMarks.has(sid)) continue;
    fetchedMarks.add(sid);
    S.fs.doc(`checkins/${m}/marks/${sid}`).get().then(d=>{ if(d.exists){ S.marks[d.id]=normMark(d); render(); } }).catch(()=>{});
  }
}

// ---------- Gerenciar: access and out-of-area records ----------
function accessPanel(){
  const coords=Object.keys(S.coordinators).sort();
  const rows=coords.map(e=>`<div class="li"><span class="l"><b>${esc(e)}</b>${e===S.email?'<span class="muted" style="font-size:.85rem">você</span>':''}</span>${e===S.email?'':`<button class="ghost" style="color:var(--bad)" data-act="delcoord" data-id="${esc(e)}">Remover</button>`}</div>`).join('');
  const noMail=Object.keys(S.residents).filter(id=>!emailOf(id)).length;
  return `<div class="panel stack" id="acesso"><h2>Acesso</h2>
    <div class="muted" style="font-size:.85rem">Entra no app quem estiver nesta lista de coordenação ou tiver o e-mail no cadastro de um residente. ${noMail?`<b style="color:var(--post)">${noMail} residente${noMail===1?' está':'s estão'} sem e-mail</b> e ainda não ${noMail===1?'consegue':'conseguem'} entrar.`:'Todos os residentes têm e-mail cadastrado.'}</div>
    <h3>Coordenação</h3><div class="list">${rows}</div>
    <div class="form"><label class="f">E-mail Google<input id="cEmail" type="email"></label><button data-act="addcoord">Adicionar à coordenação</button></div></div>`;
}
function flaggedPanel(){
  const list=Object.entries(S.marks).filter(([,m])=>m.flag).sort((a,b)=>(b[1].date||'').localeCompare(a[1].date||''));
  if(!list.length) return '';
  const sh={}; allShifts().forEach(s=>sh[s.id]=s);
  const rows=list.map(([sid,m])=>{
    const s=sh[sid], h=s?S.hospitals[s.hospitalId]:null;
    const part=(k,label)=>m[k+'Note']||(m[k+'Geo']&&h?.geo&&m[k+'Geo'].dist>h.geo.radius)?`<div class="muted" style="font-size:.86rem">${label}${m[k+'Geo']?` a ${fmtDist(m[k+'Geo'].dist)}`:' sem localização'}${m[k+'Note']?` · “${esc(m[k+'Note'])}”`:''}</div>`:'';
    const rv=m.review?`<span class="pill ${m.review.status==='aceito'?'p-yes':'p-no'}">${m.review.status==='aceito'?'Aceito':'Recusado'}</span>`:`<span class="row" style="gap:4px"><button class="ghost" data-act="review" data-v="aceito" data-id="${esc(sid)}" data-m="${esc(m.month)}">Aceitar</button><button class="ghost" style="color:var(--bad)" data-act="review" data-v="recusado" data-id="${esc(sid)}" data-m="${esc(m.month)}">Recusar</button></span>`;
    return `<div class="li"><span class="l"><b>${esc(resName(m.residentId))} · ${fmtShort(m.date)} · ${esc(h?.short||'')}</b>${part('in','Check-in')}${part('out','Checkout')}</span>${rv}</div>`;
  }).join('');
  return `<section class="panel stack" id="fora-da-area"><h2>Registros fora da área</h2><div class="muted" style="font-size:.85rem">Check-ins e checkouts feitos longe do hospital, com a justificativa do residente. Últimos dois meses.</div><div class="list">${rows}</div></section>`;
}

// ---------- hospital location ----------
function openGeo(hid){
  const h=S.hospitals[hid]; if(!h) return; const g=h.geo;
  modal(`<div class="row between"><h2>Local do ${esc(h.name)}</h2><button class="ghost" data-act="close">Fechar</button></div>
    <label class="f">Buscar endereço<span class="row" style="flex-wrap:nowrap"><input id="gq" type="text" placeholder="Rua, número, cidade" style="flex:1"><button data-act="geosearch">Buscar</button></span></label>
    <div id="gres" class="list"></div>
    <div class="row"><button data-act="geohere">Usar minha localização atual</button><span class="muted" style="font-size:.82rem">bom quando você está no hospital</span></div>
    <label class="f">Coordenadas (pode colar do Google Maps)<input id="gll" type="text" placeholder="-23.5617, -46.6560" value="${g?`${g.lat}, ${g.lng}`:''}"></label>
    <label class="f">Distância permitida para o check-in (metros)<input id="grad" type="number" min="50" max="5000" step="50" value="${g?.radius||300}"></label>
    <div id="gmap" class="muted" style="font-size:.85rem">${g?mapLink(g.lat,g.lng):''}</div>
    <div class="row"><button class="primary" data-act="geosave" data-id="${esc(hid)}">Salvar local</button>${g?`<button class="bad" data-act="geoclear" data-id="${esc(hid)}">Não exigir localização</button>`:''}</div>
    <div class="muted" style="font-size:.82rem">Dentro de prédios o GPS pode errar 50 a 100 metros. Uma distância de 300 m costuma funcionar bem.</div>`);
}
function parseLL(v){ const m=String(v||'').match(/(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)/); if(!m) return null; const lat=+m[1].replace(',','.'), lng=+m[2].replace(',','.'); if(!(Math.abs(lat)<=90&&Math.abs(lng)<=180)) return null; return {lat, lng}; }
function setLL(lat,lng){ const i=document.getElementById('gll'); if(i) i.value=`${(+lat).toFixed(6)}, ${(+lng).toFixed(6)}`; const m=document.getElementById('gmap'); if(m) m.innerHTML=mapLink((+lat).toFixed(6),(+lng).toFixed(6)); }

// ---------- importar dados ----------
function importPanel(){
  return `<section class="panel stack" id="importar"><details><summary class="sumx">Importar dados de um arquivo (.json)</summary><div class="stack" style="margin-top:8px">
    <div class="muted" style="font-size:.85rem">Use o arquivo “dados-do-app-claude.json”. Entram residentes, hospitais, estágios, escala, férias e regras de pós-plantão. O que já existir com o mesmo código é substituído. Os e-mails dos residentes não vêm no arquivo: preencha em Residentes depois.</div>
    <input type="file" id="impFile" accept=".json,application/json">
    <div><button class="primary" data-act="importjson">Importar</button></div></div></details></section>`;
}

const MAX_WEEK_MIN = 60*60; // Lei 6.932/81: até 60 h semanais
const WD = ['dom','seg','ter','qua','qui','sex','sáb'];
const MON = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const pad = n => String(n).padStart(2,'0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseD = s => { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); };
const addDays = (s,n) => { const d=parseD(s); d.setDate(d.getDate()+n); return isoDate(d); };
const today = () => isoDate(new Date());
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDur = m => { m=Math.round(m); const sg=m<0?'-':''; m=Math.abs(m); const h=Math.floor(m/60), r=m%60; return sg+(h?`${h}h`:'')+(h&&r?pad(r):'')+(!h?`${r}min`:''); };
const fmtDay = s => { const d=parseD(s); return `${WD[d.getDay()]}, ${d.getDate()} de ${MON[d.getMonth()]}`; };
const fmtHM = m => `${pad(Math.floor(m/60))}h${pad(Math.round(m%60))}`;
const fmtShort = s => { const d=parseD(s); return `${pad(d.getDate())}/${pad(d.getMonth()+1)}`; };
const fmtDT = iso => { const d=new Date(iso); return `${fmtShort(isoDate(d))} ${hm(d)}`; };
const nowISO = () => { const d=new Date(), o=-d.getTimezoneOffset(); return `${isoDate(d)}T${hm(d)}:${pad(d.getSeconds())}${o>=0?'+':'-'}${pad(Math.floor(Math.abs(o)/60))}:${pad(Math.abs(o)%60)}`; };
const rid = () => Math.random().toString(36).slice(2,8);
S.date = today(); S.manageDate = today(); S.month = today().slice(0,7);

function times(s){
  const d=parseD(s.date); const [sh,sm]=s.start.split(':').map(Number); const [eh,em]=s.end.split(':').map(Number);
  const a=new Date(d.getFullYear(),d.getMonth(),d.getDate(),sh,sm);
  let b=new Date(d.getFullYear(),d.getMonth(),d.getDate(),eh,em); if(b<=a) b.setDate(b.getDate()+1);
  return {a,b,mins:(b-a)/60000};
}
const allShifts = () => { const out=[]; for (const [m,doc] of Object.entries(S.schedule)) for (const [id,s] of Object.entries(doc.shifts||{})) out.push({...s,id,month:m}); return out.sort((x,y)=> (x.date+x.start).localeCompare(y.date+y.start)); };
function checkIndex(){ return S.marks; }
function allRequests(){ const out=[]; for (const [key,doc] of Object.entries(S.requests)) for (const [id,r] of Object.entries(doc.items||{})) { const dec=S.decisions[key]?.items?.[id]; out.push({...r,id,key,example:!!doc.example,decision:dec||null,status:dec?.status||'pendente'}); } return out.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')); }
const myRes = () => S.memberRes && S.residents[S.memberRes] ? S.memberRes : null;
const emailOf = rid => Object.keys(S.members).find(e=>S.members[e]?.residentId===rid) || '';
const YEARS=['ME1','ME2','ME3'];
function resByYear(){
  const g={}; for (const [id,r] of Object.entries(S.residents)) (g[r.year||'Sem ano']=g[r.year||'Sem ano']||[]).push([id,r]);
  const rank=y=>{ const i=YEARS.indexOf(y); return i<0?99:i; };
  return Object.keys(g).sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b)).map(y=>[y, g[y].sort((a,b)=>a[1].name.localeCompare(b[1].name,'pt-BR',{sensitivity:'base'}))]);
}
function resOptions(fmt){ return resByYear().map(([y,list])=>`<optgroup label="${esc(y)}">${list.map(([id,r])=>`<option value="${id}">${fmt(id,r)}</option>`).join('')}</optgroup>`).join(''); }
const resName = id => S.residents[id]?.name || 'Residente removido';
const hospName = id => S.hospitals[id]?.name || 'Hospital removido';
const onVac = (r,d) => Object.values(S.vacations).some(v=>v.residentId===r && v.start<=d && d<=v.end);
const WDL=['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
const DEFAULT_OFF={0:0,1:1,2:1,3:1,4:1,5:3,6:0};
function ruleSets(){ const sets=S.config.pos?.sets; return Array.isArray(sets)&&sets.length?sets:[{from:'2000-01-01',offsets:DEFAULT_OFF}]; }
function ruleFor(date){ const all=ruleSets().slice().sort((a,b)=>a.from.localeCompare(b.from)); return all.filter(x=>x.from<=date).pop() || all[0]; }
function crosses(s){ return isoDate(times(s).b)!==s.date; }
function postDate(s){ const r=ruleFor(s.date), wd=parseD(s.date).getDay(); const o=Number((crosses(s)?r.offsets:r.dayOffsets)?.[wd] ?? 0); if(!o) return null; return addDays(s.date, Math.min(7,Math.max(1,o))); }
function postOn(day, shifts){ return shifts.filter(s=>postDate(s)===day); }
function postLabel(wd,o){ if(!o) return 'não gera'; return WDL[(wd+o)%7] + (o===1?' (dia seguinte)':o>=7?' (uma semana depois)':wd+o>6?' da semana seguinte':''); }
function compOn(day){ return allRequests().filter(r=>r.status==='aprovado' && r.compDate===day); }
function weekRange(day){ const d=parseD(day); const wd=(d.getDay()+6)%7; const a=addDays(day,-wd); return [a, addDays(a,6)]; }
function workedMins(s, c){ if(c?.in && c?.out) return (new Date(c.out)-new Date(c.in))/60000; return null; }
function extraMins(s,c){ const w=workedMins(s,c); if(w==null) return 0; return Math.max(0, Math.round(w - times(s).mins)); }

function status(s, c){
  const t=times(s), now=new Date();
  if (c?.in && c?.out) return {k:'done', label:`Concluído ${hm(new Date(c.in))}–${hm(new Date(c.out))}`, cls:'p-done'};
  if (c?.in) return {k:'on', label:`Em plantão desde ${hm(new Date(c.in))}`, cls:'p-on'};
  if (now > new Date(t.a.getTime()+30*60000)) return {k:'miss', label: now>t.b?'Sem registro':'Sem check-in', cls:'p-miss'};
  return {k:'wait', label:'Aguardando', cls:'p-wait'};
}

function toast(msg){ const el=document.createElement('div'); el.className='toast'; el.textContent=msg; document.body.appendChild(el); setTimeout(()=>el.remove(),2800); }

// ---------- rendering ----------
const ICON={
  escala:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  comp:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/></svg>',
  ferias:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  gerenciar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>'
};
function tabsList(){
  const pend = allRequests().filter(r=>r.status==='pendente').length;
  const t=[['escala','Escala']];
  if (S.isCoord) t.push(['comp','Compensações', pend], ['gerenciar','Gerenciar']);
  return t;
}
function renderTabs(){
  const nav=document.getElementById('tabs');
  const tl=tabsList(); document.querySelector('nav.bottom').hidden = tl.length<2;
  nav.innerHTML = tl.map(([id,l,b])=>`<button role="tab" data-tab="${id}" aria-selected="${S.tab===id}">${ICON[id]}<span>${l}</span>${b?`<span class="badge">${b}</span>`:''}</button>`).join('');
  const title=document.getElementById('topTitle'), right=document.getElementById('topRight');
  if (S.tab==='escala'){
    const d=parseD(S.date);
    title.innerHTML=`<button data-act="week" data-n="-1" aria-label="${S.monthOpen?'Mês anterior':'Semana anterior'}">‹</button><span>${MON[d.getMonth()]}${d.getFullYear()!==new Date().getFullYear()?' '+d.getFullYear():''}</span><button data-act="week" data-n="1" aria-label="${S.monthOpen?'Próximo mês':'Próxima semana'}">›</button>`;
    right.innerHTML=`<button class="todaybtn" data-act="today" aria-label="Ir para hoje"><svg viewBox="0 0 44 44" width="40" height="40" fill="none"><rect x="6" y="8" width="32" height="30" rx="5" stroke="currentColor" stroke-width="2"/><path d="M6 15h32" stroke="currentColor" stroke-width="2"/><path d="M14 5v6M30 5v6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><text x="22" y="28" text-anchor="middle" font-size="8.5" font-weight="700" fill="currentColor" font-family="-apple-system,Segoe UI,Roboto,sans-serif">HOJE</text><circle cx="22" cy="33" r="1.4" fill="currentColor"/></svg></button>`;
  } else {
    title.textContent={comp:'Compensações',gerenciar:'Gerenciar escala'}[S.tab]||'Escala';
    right.innerHTML='';
  }
}
function renderWho(){
  const el=document.getElementById('who');
  if(!S.user){ el.innerHTML=''; return; }
  const ini=(S.user.displayName||S.email||'?').trim()[0].toUpperCase();
  el.innerHTML = `<button class="avbtn" data-act="me" aria-label="Minha conta">${S.user.photoURL?`<img alt="" src="${esc(S.user.photoURL)}" referrerpolicy="no-referrer">`:`<span class="av" style="width:36px;height:36px;background:var(--accent)">${esc(ini)}</span>`}</button>`;
}

function render(){
  if (S.busy || !S.ready) return;
  ensureMarks();
  const v=document.getElementById('view');
  if (v.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { S.pending=true; return; }
  S.pending=false;
  renderTabs(); renderWho();
  if (!S.ready) return;
  const fn=(S.isCoord?{escala:viewEscala, comp:viewComp, gerenciar:viewGerenciar}:{escala:viewEscala})[S.tab]||viewEscala;
  v.innerHTML = fn();
}

function linkBanner(){ return ''; }
function localStorage_get(k){ try{ return localStorage.getItem('esc_'+k); }catch(e){ return null; } }
function localStorage_set(k,v){ try{ localStorage.setItem('esc_'+k,v); }catch(e){} }

function myCurrentShift(){
  const r=myRes(); if(!r) return null;
  const idx=checkIndex(), now=new Date();
  const mine=allShifts().filter(s=>s.residentId===r);
  const open=mine.find(s=>idx[s.id]?.in && !idx[s.id]?.out);
  if (open) return open;
  const cur=mine.find(s=>{const t=times(s); return now>=new Date(t.a.getTime()-60*60000) && now<=t.b && !idx[s.id]?.out;});
  if (cur) return cur;
  return mine.find(s=>times(s).a>now) || null;
}

function meCard(){
  const r=myRes(); if(!r) return '';
  const s=myCurrentShift(); const idx=checkIndex();
  if (!s) return `<section class="me-card"><div class="eyebrow">Meu plantão</div><div class="where">Nenhum plantão na escala</div><div class="muted">Fale com a coordenação se isso estiver errado.</div></section>`;
  const t=times(s), c=idx[s.id], now=new Date();
  const canIn = now>=new Date(t.a.getTime()-60*60000) && now<=t.b;
  let action='', extra='';
  if (c?.in && !c?.out){
    const worked=(now-new Date(c.in))/60000, over=Math.round(worked - t.mins);
    action=`<button class="primary big" data-act="checkout" data-id="${s.id}">Fazer checkout · ${hm(now)}</button>`;
    extra = over>0 ? `<div class="warnline">Você já passou ${fmtDur(over)} da jornada deste plantão. Ao sair, justifique as horas para pedir compensação.</div>` : `<div class="muted">Check-in às ${hm(new Date(c.in))} · faltam ${fmtDur((t.b-now)/60000)} para o fim da jornada</div>`;
  } else if (canIn){
    action=`<button class="primary big" data-act="checkin" data-id="${s.id}">Fazer check-in · ${hm(now)}</button>`;
  } else {
    action=`<button class="big" disabled>Check-in abre às ${hm(new Date(t.a.getTime()-60*60000))} de ${fmtShort(s.date)}</button>`;
  }
  const label = c?.in&&!c?.out ? 'Em plantão agora' : (canIn?'Plantão de agora':'Próximo plantão');
  return `<section class="me-card" id="me-card"><div class="row between"><div class="eyebrow">${label}</div><span class="clock">${fmtDay(s.date)}</span></div>
    <div><div class="where">${esc(hospName(s.hospitalId))}</div>${S.stages[s.stageId]?`<div class="muted" style="font-weight:600">${esc(S.stages[s.stageId].name)}</div>`:''}<div class="muted"><span class="time">${s.start}–${s.end}</span> · ${esc(s.label||'')}</div></div>
    <div class="row">${action}</div>${extra}${S.hospitals[s.hospitalId]?.geo&&!c?.out?`<div class="muted" style="font-size:.84rem">O app confere se você está a até ${fmtDist(S.hospitals[s.hospitalId].geo.radius)} do hospital.</div>`:''}</section>`;
}

const AVC=['#2F6F73','#6B4FA0','#8A5A2B','#2E5E8C','#7A3E5C','#3F6E3A','#8C4A3A','#555B66'];
function avatar(rid){
  const r=S.residents[rid];
  const parts=(r?.name||'?').split(' ').filter(Boolean);
  const txt=(parts[0]?.[0]||'?')+(parts.length>1?parts[parts.length-1][0]:'');
  let h=0; for (const ch of String(rid||'')) h=(h*31+ch.charCodeAt(0))>>>0;
  return `<span class="av" style="background:${AVC[h%AVC.length]}" aria-hidden="true">${esc(txt.toUpperCase())}</span>`;
}
function weekDays(day){ const start=addDays(day,-parseD(day).getDay()); return Array.from({length:7},(_,i)=>addDays(start,i)); }
function dayCell(day, shifts, inMonth=true){
  const r=myRes();
  const list=shifts.filter(s=>s.date===day && (!r || s.residentId===r));
  const night=list.some(s=>isoDate(times(s).b)!==s.date), dayk=list.some(s=>isoDate(times(s).b)===s.date);
  return `<button class="dc ${day===S.date?'sel':''} ${day===today()?'today':''} ${inMonth?'':'out'}" data-act="pick" data-d="${day}" aria-pressed="${day===S.date}" aria-label="${fmtDay(day)}"><span class="n">${parseD(day).getDate()}</span><span class="dots">${dayk?'<i class="dot d"></i>':''}${night?'<i class="dot n"></i>':''}</span></button>`;
}
function shiftCard(s, c, mine){
  const st=status(s,c), t=times(s), me=s.residentId===mine;
  return `<article class="scard ${me?'mine':''}">${avatar(s.residentId)}
    <span class="tt"><span>${s.start}</span><span>${s.end}</span></span>
    <span class="nmc"><b>${esc(resName(s.residentId))}</b><span class="sub"><span>${fmtHM(t.mins)}</span><span class="pill ${st.cls}">${esc(st.label)}</span>${me?'<span class="pill p-done">você</span>':''}${S.isCoord&&c?.flag?'<span class="pill p-post">fora da área</span>':''}</span></span></article>`;
}
function viewEscala(){
  const shifts=allShifts();
  const labels=WD.map(w=>`<span class="wl">${w}.</span>`).join('');
  let cells;
  if (S.monthOpen){
    const ym=S.date.slice(0,7), first=ym+'-01', [y,m]=ym.split('-').map(Number);
    const lastISO=`${ym}-${pad(new Date(y,m,0).getDate())}`; const out=[];
    for (let d=addDays(first,-parseD(first).getDay()); d<=lastISO || parseD(d).getDay()!==0; d=addDays(d,1)) out.push(dayCell(d,shifts,d.slice(0,7)===ym));
    cells=out.join('');
  } else cells=weekDays(S.date).map(d=>dayCell(d,shifts)).join('');
  const chev=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${S.monthOpen?'M6 15l6-6 6 6':'M6 9l6 6 6-6'}"/></svg>`;
  const segs=[['todos','Todos'],['meus','Meus plantões'],['pos','Pós-plantão'],['ferias','Férias']];
  const body = S.seg==='meus' ? segMeus() : S.seg==='pos' ? segPos(shifts) : S.seg==='ferias' ? viewFerias() : segTodos(shifts);
  return `<section class="cal" id="calendario"><div class="week">${labels}</div><div class="week" id="strip">${cells}</div></section>
  <div class="grab-wrap"><button class="grab" data-act="monthToggle" aria-expanded="${S.monthOpen}" aria-label="${S.monthOpen?'Mostrar só a semana':'Mostrar o mês inteiro'}">${chev}</button></div>
  ${linkBanner()}
  <div class="seg" role="group" aria-label="Filtro da escala">${segs.map(([k,l])=>`<button data-act="seg" data-v="${k}" aria-pressed="${S.seg===k}">${l}</button>`).join('')}</div>
  ${body}`;
}
function dayHeader(day, extra=''){ return `<div class="dayline"><b>${day===today()?'Hoje, ':''}${fmtDay(day)}</b><span class="muted" style="font-size:.88rem">${extra}</span></div>`; }
function segTodos(shifts){
  const day=S.date, idx=checkIndex(), mine=myRes();
  const dayShifts=shifts.filter(s=>s.date===day);
  const groups=Object.entries(S.hospitals).sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([hid,h])=>{
    const list=dayShifts.filter(s=>s.hospitalId===hid);
    const st=stageBlock(hid, day, mine);
    if(!list.length && !st) return '';
    return `<section id="h-${esc(hid)}"><h2 class="ghead">${esc(h.short?h.short+' - ':'')}${esc(h.name)}</h2>${st}${list.length?cardsByStage(list,idx,mine):''}</section>`;
  }).join('');
  const posts=postOn(day,shifts).length, comps=compOn(day);
  return `${day===today()&&mine?meCard():''}${dayHeader(day, `${dayShifts.length} plantões · ${posts} em pós-plantão`)}${comps.length?`<div class="banner" style="background:var(--panel)"><span><b>Folga compensatória:</b> ${comps.map(r=>esc(resName(r.residentId))+' ('+esc(r.compPeriod||'')+')').join(', ')}</span></div>`:''}
  <div class="hgrid" id="hospitais">${groups||`<div class="panel stack"><span class="muted">Nenhum plantão escalado neste dia.</span>${S.isCoord?'<div><button class="primary" data-act="goManage">Montar a escala deste dia</button></div>':''}</div>`}</div>${exampleNote()}`;
}
function segMeus(){
  if (myRes()) return viewMeus();
  return `<div class="panel muted">Seu e-mail (${esc(S.email||'')}) não está ligado a um residente. ${S.isCoord?'Se você também é residente, coloque seu e-mail no seu nome em Gerenciar → Residentes.':'Peça à coordenação para conferir seu cadastro.'}</div>`;
}
function segPos(shifts){
  const day=S.date;
  const items=postOn(day,shifts).map(s=>`<div class="li"><span class="row" style="flex-wrap:nowrap;min-width:0">${avatar(s.residentId)}<span class="l"><b>${esc(resName(s.residentId))}</b><span class="muted" style="font-size:.86rem">${esc(s.label||'Plantão')} de ${WD[parseD(s.date).getDay()]}, ${fmtShort(s.date)} · ${esc(S.hospitals[s.hospitalId]?.short||hospName(s.hospitalId))} ${s.start}–${s.end}</span></span></span><span class="pill p-post">Pós-plantão</span></div>`);
  return `${dayHeader(day, `${items.length} residente${items.length===1?'':'s'}`)}<section class="panel" id="pos-plantao"><div class="list">${items.length?items.join(''):'<div class="empty">Ninguém em pós-plantão neste dia.</div>'}</div><p class="note-ex" style="margin:8px 0 0">Calculado pela regra de pós-plantão da coordenação, que separa diurno e noturno no fim de semana.</p></section>`;
}
function exampleNote(){ return ''; }

function viewMeus(){
  const r=myRes();
  if (!r) return segMeus();
  const shifts=allShifts().filter(s=>s.residentId===r), idx=checkIndex(), now=new Date();
  const [wa,wb]=weekRange(today());
  const wk=shifts.filter(s=>s.date>=wa&&s.date<=wb);
  const wkMin=wk.reduce((t,s)=>t+(workedMins(s,idx[s.id])??times(s).mins),0);
  const pct=Math.min(100, wkMin/MAX_WEEK_MIN*100);
  const upcoming=shifts.filter(s=>times(s).b>now).slice(0,8);
  const past=shifts.filter(s=>times(s).b<=now && s.date>=addDays(today(),-30)).reverse();
  const reqs=allRequests().filter(q=>q.residentId===r);
  const reqByShift={}; reqs.forEach(q=>reqByShift[q.shiftId]=q);
  const pillFor = q => q.status==='aprovado'?'<span class="pill p-yes">Compensação autorizada</span>':q.status==='negado'?'<span class="pill p-no">Compensação negada</span>':'<span class="pill p-pend">Aguardando coordenação</span>';
  const up=upcoming.map(s=>{const st=status(s,idx[s.id]); return `<div class="li"><span class="l"><b>${fmtDay(s.date)}</b><span class="muted" style="font-size:.88rem">${esc(hospName(s.hospitalId))}${S.stages[s.stageId]?' · '+esc(S.stages[s.stageId].name):''} · <span class="time">${s.start}–${s.end}</span></span></span><span class="pill ${st.cls}">${esc(st.label)}</span></div>`}).join('');
  const hist=past.map(s=>{ const c=idx[s.id]; const ex=extraMins(s,c); const q=reqByShift[s.id];
    const real = c?.in ? `<span class="time">${hm(new Date(c.in))}–${c.out?hm(new Date(c.out)):'…'}</span>` : '<span class="pill p-miss">Sem registro</span>';
    const act = q ? pillFor(q) : (ex>=10 ? `<button class="primary" data-act="ask" data-id="${s.id}">Justificar ${fmtDur(ex)}</button>` : '');
    return `<div class="li"><span class="l"><b>${fmtShort(s.date)} · ${esc(S.hospitals[s.hospitalId]?.short||'')}</b><span class="muted" style="font-size:.88rem">Escala <span class="time">${s.start}–${s.end}</span> · Real ${real}${ex>0?` · <b style="color:var(--bad)">+${fmtDur(ex)}</b>`:''}</span></span>${act}</div>`; }).join('');
  return `${meCard()}${myStageCard()}
  <section class="panel stack" id="semana"><div class="sec-title"><h2>Carga da semana</h2><span class="muted time">${fmtShort(wa)} a ${fmtShort(wb)}</span></div>
    <div class="row between"><span><b style="font:800 1.6rem var(--f-display)">${fmtDur(wkMin)}</b> <span class="muted">de 60h semanais</span></span>${wkMin>MAX_WEEK_MIN?'<span class="pill p-miss">Acima do limite</span>':''}</div>
    <div class="meter ${wkMin>MAX_WEEK_MIN?'hot':''}"><i style="width:${pct}%"></i></div>
    <div class="muted" style="font-size:.82rem">Conta as horas reais dos plantões com checkout e as horas da escala dos demais. Limite da Lei 6.932/81.</div></section>
  <section class="two">
    <div class="panel" id="proximos"><h2 style="margin-bottom:6px">Próximos plantões</h2><div class="list">${up||'<div class="empty">Nenhum plantão futuro na escala.</div>'}</div></div>
    <div class="panel" id="historico"><div class="sec-title"><h2>Últimos 30 dias</h2><button class="ghost" data-act="ask" data-id="">Nova solicitação</button></div><div class="list">${hist||'<div class="empty">Sem plantões recentes.</div>'}</div></div>
  </section>
  <section class="stack" id="minhas"><h2>Minhas solicitações</h2>${reqs.length?reqs.map(reqCard).join(''):'<div class="panel muted">Você ainda não pediu compensação de horas.</div>'}</section>
  <p class="note-ex">Você entrou como ${esc(S.email)}. <button class="ghost" data-act="logout">Sair</button></p>`;
}

function reqCard(q){
  const s=allShifts().find(x=>x.id===q.shiftId); const c=checkIndex()[q.shiftId];
  const conflict=allShifts().find(x=>x.residentId===q.residentId && x.date===q.compDate);
  const pill=q.status==='aprovado'?'<span class="pill p-yes">Autorizada</span>':q.status==='negado'?'<span class="pill p-no">Negada</span>':'<span class="pill p-pend">Pendente</span>';
  const decide = S.isCoord && q.status==='pendente' ? `<div class="stack" style="gap:8px"><label class="f">Observação para o residente (opcional)<input id="note-${esc(q.key)}~${esc(q.id)}" type="text" placeholder="Ex.: compensação lançada na escala"></label>
     <div class="row"><button class="ok" data-act="decide" data-v="aprovado" data-k="${esc(q.key)}" data-q="${esc(q.id)}">Autorizar compensação</button><button class="bad" data-act="decide" data-v="negado" data-k="${esc(q.key)}" data-q="${esc(q.id)}">Negar</button></div></div>` : '';
  const dec = q.decision ? `<div class="muted" style="font-size:.85rem">${q.decision.status==='aprovado'?'Autorizada':'Negada'} em ${fmtDT(q.decision.at)}${q.decision.note?` · “${esc(q.decision.note)}”`:''}</div>` : '';
  const undo = S.isCoord && q.decision ? `<button class="ghost" data-act="undecide" data-k="${esc(q.key)}" data-q="${esc(q.id)}">Reabrir</button>`:'';
  return `<article class="req ${q.status==='pendente'?'pend':''}">
    <div class="row between"><div><b>${esc(resName(q.residentId))}</b> <span class="yr">${esc(S.residents[q.residentId]?.year||'')}</span>${q.example?' <span class="note-ex">exemplo</span>':''}</div><div class="row">${pill}${undo}</div></div>
    <dl class="kv" style="margin:0">
      <div><dt>Plantão</dt><dd>${s?`${fmtShort(s.date)} · ${esc(S.hospitals[s.hospitalId]?.short||'')} <span class="time">${s.start}–${s.end}</span>`:esc(q.shiftDate?fmtShort(q.shiftDate):'—')}</dd></div>
      <div><dt>Registro real</dt><dd>${c?.in?`<span class="time">${hm(new Date(c.in))}–${c.out?hm(new Date(c.out)):'…'}</span>`:'Sem check-in'}</dd></div>
      <div><dt>Horas adicionais</dt><dd><b>${fmtDur(q.minutes)}</b></dd></div>
      <div><dt>Compensar em</dt><dd>${q.compDate?fmtDay(q.compDate):'—'}${q.compPeriod?` · ${esc(q.compPeriod)}`:''}${conflict&&S.isCoord?`<div class="warnline">Tem plantão neste dia (${esc(S.hospitals[conflict.hospitalId]?.short||'')} ${conflict.start}–${conflict.end})</div>`:''}</dd></div>
    </dl>
    <div class="quote">${esc(q.reason)}</div>${dec}${decide}</article>`;
}

function viewComp(){
  const all=allRequests();
  if (!S.isCoord){
    const r=myRes();
    const mine=all.filter(q=>q.residentId===r);
    return `<section class="stack"><h2>Minhas compensações</h2>${r?(mine.length?mine.map(reqCard).join(''):'<div class="panel muted">Nenhuma solicitação. Em “Meus plantões”, use “Justificar” num plantão com horas além da jornada.</div>'):linkBanner()}</section>`;
  }
  fetchMarks(all);
  const pend=all.filter(q=>q.status==='pendente');
  const list = S.compFilter==='pend'?pend:all;
  const appr=all.filter(q=>q.status==='aprovado');
  const hours=appr.reduce((t,q)=>t+(q.minutes||0),0);
  return `<section class="stack" id="aprovacoes"><div class="sec-title"><h2>Pedidos de compensação</h2>
    <div class="row"><button class="${S.compFilter==='pend'?'primary':''}" data-act="cf" data-v="pend">Pendentes (${pend.length})</button><button class="${S.compFilter==='all'?'primary':''}" data-act="cf" data-v="all">Todos (${all.length})</button></div></div>
    <div class="chips"><div class="chip post"><b>${pend.length}</b><span>aguardando decisão</span></div><div class="chip comp"><b>${fmtDur(hours)}</b><span>autorizadas para compensar</span></div></div>
    ${list.length?list.map(reqCard).join(''):'<div class="panel muted">Nenhum pedido pendente.</div>'}</section>`;
}

function viewFerias(){
  const m=S.date.slice(0,7), [y,mo]=m.split('-').map(Number);
  const days=new Date(y,mo,0).getDate(); const first=`${m}-01`, last=`${m}-${pad(days)}`;
  const vs=Object.entries(S.vacations).filter(([,v])=>v.start<=last && v.end>=first).sort((a,b)=>a[1].start.localeCompare(b[1].start));
  const byRes={}; vs.forEach(([id,v])=>(byRes[v.residentId]=byRes[v.residentId]||[]).push(v));
  const td=today();
  const head=Array.from({length:days},(_,i)=>{const d=new Date(y,mo-1,i+1); const we=d.getDay()%6===0; return `<th class="${we?'we':''}">${i+1}<br>${WD[d.getDay()][0].toUpperCase()}</th>`}).join('');
  const rows=Object.entries(byRes).map(([rid,list])=>`<tr><td class="n">${esc(resName(rid))}</td>${Array.from({length:days},(_,i)=>{const d=`${m}-${pad(i+1)}`; const on=list.some(v=>v.start<=d&&d<=v.end); return `<td class="${on?'v':''} ${d===td?'t':''}"></td>`}).join('')}</tr>`).join('');
  const list=vs.map(([id,v])=>{ const n=(parseD(v.end)-parseD(v.start))/864e5+1; return `<div class="li"><span class="l"><b>${esc(resName(v.residentId))} <span class="yr">${esc(S.residents[v.residentId]?.year||'')}</span></b><span class="muted"><span class="time">${fmtShort(v.start)} a ${fmtShort(v.end)}</span> · ${n} dias</span></span>${S.isCoord?`<button class="ghost" data-act="delvac" data-id="${id}">Remover</button>`:'<span class="pill p-vac">Férias</span>'}</div>`; }).join('');
  const resOpts=resOptions((id,r)=>esc(r.name));
  return `<section class="stack" id="ferias"><div class="row between"><div class="datebar"><button aria-label="Mês anterior" data-act="month" data-n="-1">‹</button><span class="d">${MON[mo-1][0].toUpperCase()+MON[mo-1].slice(1)} de ${y}</span><button aria-label="Próximo mês" data-act="month" data-n="1">›</button></div>
    <div class="chip vac"><b>${Object.keys(byRes).length}</b><span>residente${Object.keys(byRes).length===1?'':'s'} de férias no mês</span></div></div>
    ${rows?`<div class="gantt-wrap"><table class="gantt"><thead><tr><th class="n">Residente</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`:''}
    <div class="panel"><div class="list">${list||'<div class="empty">Ninguém de férias neste mês.</div>'}</div></div>
    ${S.isCoord?`<div class="panel stack"><h3>Lançar férias</h3><div class="form">
      <label class="f">Residente<select id="vRes">${resOpts}</select></label>
      <label class="f">Início<input type="date" id="vStart" value="${first}"></label>
      <label class="f">Fim<input type="date" id="vEnd" value="${addDays(first,29)}"></label>
      <button class="primary" data-act="addvac">Lançar férias</button></div><div class="muted" style="font-size:.82rem">A residência garante 30 dias de descanso por ano.</div></div>`:''}
  </section>`;
}

function viewGerenciar(){
  if (!S.isCoord) return viewEscala();
  const d=S.manageDate, idx=checkIndex();
  const list=allShifts().filter(s=>s.date===d);
  const resOpts=resOptions((id,r)=>esc(r.name)+(onVac(id,d)?' · férias':''));
  const hList=Object.entries(S.hospitals).sort((a,b)=>a[1].name.localeCompare(b[1].name));
  const selH=S.hospitals[S.form.hosp]?S.form.hosp:(hList[0]?.[0]||'');
  const selSt=S.stages[S.form.stage]?.hospitalId===selH?S.form.stage:'';
  const hOpts=hList.map(([id,h])=>`<option value="${id}" ${id===selH?'selected':''}>${esc(h.name)}</option>`).join('');
  const posts=new Set(postOn(d, allShifts()).map(s=>s.residentId));
  const rows=list.map(s=>`<div class="li"><span class="l"><b>${esc(resName(s.residentId))}</b><span class="muted" style="font-size:.88rem">${esc(hospName(s.hospitalId))}${S.stages[s.stageId]?' · '+esc(S.stages[s.stageId].name):''} · <span class="time">${s.start}–${s.end}</span> · ${esc(s.label||'')}${idx[s.id]?.in?' · com check-in':''}${s.batch&&s.until?` · período até ${fmtShort(s.until)}`:''}</span></span><span class="row" style="gap:4px"><button class="ghost" data-act="delshift" data-id="${s.id}" data-m="${s.month}">${s.batch?'Remover só este dia':'Remover'}</button>${s.batch?`<button class="ghost" style="color:var(--bad)" data-act="delbatch" data-b="${esc(s.batch)}" data-from="${s.date}">Remover daqui até o fim</button>`:''}</span></div>`).join('');
  const yrs=['ME1','ME2','ME3'];
  const resRows=resByYear().map(([y,list])=>`<h3 class="ygrp">${esc(y)} · ${list.length} residente${list.length===1?'':'s'}</h3>`+list.map(([id,r])=>`<div class="li edit"><input id="rn-${esc(id)}" type="text" value="${esc(r.name)}" aria-label="Nome" style="flex:1 1 180px"><select id="ry-${esc(id)}" aria-label="Ano">${yrs.map(y=>`<option ${y===r.year?'selected':''}>${y}</option>`).join('')}</select><input id="rem-${esc(id)}" type="email" value="${esc(emailOf(id))}" placeholder="e-mail Google" aria-label="E-mail" style="flex:1 1 200px"><span class="row" style="gap:4px"><button class="ghost" data-act="saveres" data-id="${esc(id)}">Salvar</button><button class="ghost" style="color:var(--bad)" data-act="delres" data-id="${esc(id)}">Remover</button></span></div>`).join('')).join('');
  const hRows=Object.entries(S.hospitals).map(([id,h])=>`<div class="li edit"><input id="hn-${esc(id)}" type="text" value="${esc(h.name)}" aria-label="Nome do hospital" style="flex:1 1 200px"><input id="hs-${esc(id)}" type="text" value="${esc(h.short||'')}" maxlength="6" aria-label="Sigla" style="width:84px"><span class="row" style="gap:4px"><button class="ghost" data-act="geo" data-id="${esc(id)}">${h.geo?`Local: ${fmtDist(h.geo.radius)}`:'Definir local'}</button><button class="ghost" data-act="savehosp" data-id="${esc(id)}">Salvar</button><button class="ghost" style="color:var(--bad)" data-act="delhosp" data-id="${esc(id)}">Remover</button></span></div>`).join('');
  const pc=posConflicts();
  const pcHtml = pc.length ? `<section class="banner" id="conflitos-pos" style="background:var(--post-soft)"><div><b>${pc.length} dia${pc.length===1?'':'s'} de estágio ca${pc.length===1?'i':'em'} em pós-plantão</b><div class="muted" style="font-size:.86rem">${pc.slice(0,6).map(s=>`${esc(resName(s.residentId))} em ${fmtShort(s.date)}`).join(' · ')}${pc.length>6?' …':''}</div></div><button class="primary" data-act="fixpos">Retirar do estágio nesses dias</button></section>` : '';
  return `${pcHtml}<section class="panel stack" id="escala-dia"><div class="row between"><h2>Escala do dia</h2><div class="datebar"><button aria-label="Dia anterior" data-act="mday" data-n="-1">‹</button><input type="date" id="mDay" value="${d}" aria-label="Data"><button aria-label="Próximo dia" data-act="mday" data-n="1">›</button></div></div>
    <div class="list">${rows||'<div class="empty">Nenhum plantão neste dia.</div>'}</div>
    <h3>Adicionar plantão em ${fmtDay(d)}</h3>
    <div class="form"><label class="f">Hospital<select id="sHosp">${hOpts}</select></label>
      <label class="f">Estágio<select id="sStage">${stageOpts(selH,selSt)}</select></label>
      <label class="f">Residente<select id="sRes">${resOptsFor(selSt,d)}</select></label>
      <label class="f">Início<input type="time" id="sStart" value="07:00"></label>
      <label class="f">Fim<input type="time" id="sEnd" value="19:00"></label>
      <label class="f">Tipo<select id="sLabel"><option>Diurno 12h</option><option>Noturno 12h</option><option>Plantão 24h</option><option>Manhã 6h</option><option>Tarde 6h</option><option>Estágio</option></select></label>
      <label class="f">Repetir até (opcional)<input type="date" id="sUntil" min="${d}" value="${esc(S.form.until&&S.form.until>d?S.form.until:'')}"></label></div>
    <div id="sDaysWrap" class="stack" style="gap:6px" ${S.form.until&&S.form.until>d?'':'hidden'}><span class="f-lab">Dias da semana no período</span><div class="wdays" id="sDays">${[1,2,3,4,5,6,0].map(w=>`<label class="wd"><input type="checkbox" value="${w}" ${(S.form.days||[]).includes(w)?'checked':''}> ${WD[w]}</label>`).join('')}</div><span class="muted" style="font-size:.82rem">Cria um lançamento por dia marcado, de ${fmtShort(d)} até a data final. Dias de férias ou de pós-plantão do residente são pulados.</span></div>
    <div><button class="primary" data-act="addshift">Adicionar</button></div>
    ${posts.size?`<div class="muted" style="font-size:.85rem">Em pós-plantão neste dia: ${[...posts].map(r=>esc(resName(r))).join(', ')}.</div>`:''}
  </section>
  <section class="two">
    <div class="panel stack" id="residentes"><h2>Residentes</h2><div class="list">${resRows}</div>
      <div class="form"><label class="f">Nome<input id="rName" type="text"></label><label class="f">Ano<select id="rYear"><option>ME1</option><option>ME2</option><option>ME3</option></select></label><label class="f">E-mail Google<input id="rEmail" type="email"></label><button class="primary" data-act="addres">Adicionar</button></div>
      <details><summary class="sumx">Adicionar vários de uma vez</summary><div class="stack" style="margin-top:8px"><label class="f">Um por linha: Nome;Ano;e-mail<textarea id="rBulk" placeholder="Maria Souza;ME1;maria@gmail.com"></textarea></label><div><button data-act="bulkres">Adicionar lista</button></div></div></details></div>
    <div class="stack">
      <div class="panel stack" id="hospitais-cad"><h2>Hospitais</h2><div class="list">${hRows}</div>
        <div class="form"><label class="f">Nome<input id="hName" type="text"></label><label class="f">Sigla<input id="hShort" type="text" maxlength="6"></label><button class="primary" data-act="addhosp">Adicionar</button></div></div>
      ${accessPanel()}
    </div>
  </section>
  ${flaggedPanel()}
  ${stagesPanel()}
  ${rulesPanel()}
  ${importPanel()}`;
}
const rankY=y=>{ const i=YEARS.indexOf(y); return i<0?99:i; };
function stagesOf(hid){ return Object.entries(S.stages).filter(([,x])=>x.hospitalId===hid).sort((a,b)=>rankY(a[1].year)-rankY(b[1].year)||a[1].name.localeCompare(b[1].name,'pt-BR',{numeric:true})); }
function assignsOn(stid, day){ return Object.entries(S.stageAssign).filter(([,a])=>a.stageId===stid && a.start<=day && (!a.end || day<=a.end)).sort((a,b)=>resName(a[1].residentId).localeCompare(resName(b[1].residentId),'pt-BR')); }
function stageOpts(hid, sel){ const sts=stagesOf(hid); return `<option value="">${sts.length?'Sem estágio':'Nenhum estágio neste hospital'}</option>`+sts.map(([id,st])=>`<option value="${id}" ${id===sel?'selected':''}>${esc(st.name)}${st.year?' · '+esc(st.year):''}</option>`).join(''); }
function resOptsFor(stageId, d){ const st=S.stages[stageId]; return resByYear().filter(([y])=>!st?.year||y===st.year).map(([y,list])=>`<optgroup label="${esc(y)}">${list.map(([id,r])=>`<option value="${id}">${esc(r.name)}${onVac(id,d)?' · férias':''}</option>`).join('')}</optgroup>`).join('') || '<option value="">Nenhum residente deste ano</option>'; }
function cardsByStage(list, idx, mine){
  const order=stagesOf(list[0]?.hospitalId).map(([id])=>id);
  const key=s=>S.stages[s.stageId]?s.stageId:'';
  const sorted=list.slice().sort((a,b)=>{ const ka=key(a), kb=key(b); return (ka?order.indexOf(ka):999)-(kb?order.indexOf(kb):999) || a.start.localeCompare(b.start); });
  const anyStage=sorted.some(x=>key(x));
  let html='', cur=null;
  for (const s of sorted){ const k=key(s); if(k!==cur){ if(cur!==null) html+='</div>'; const st=S.stages[k]; html+= k?`<div class="stsub">${esc(st.name)}${st.year?` <span class="yr">${esc(st.year)}</span>`:''}</div><div class="cards">`:`${anyStage?'<div class="stsub">Sem estágio</div>':''}<div class="cards">`; cur=k; } html+=shiftCard(s,idx[s.id],mine); }
  return html+'</div>';
}
function stageBlock(hid, day, mine){
  const rows=stagesOf(hid).map(([id,st])=>{ const as=assignsOn(id,day); if(!as.length) return '';
    const names=as.map(([,a])=>`<span class="${a.residentId===mine?'me-name':''}">${esc(resName(a.residentId))}</span>`).join(', ');
    return `<div class="strow"><span class="stname">${esc(st.name)}${st.year?`<span class="yr">${esc(st.year)}</span>`:''}</span><span>${names}</span></div>`; }).join('');
  return rows?`<div class="stbox"><div class="eyebrow">Estágios</div>${rows}</div>`:'';
}
function myStageCard(){
  const r=myRes(); if(!r) return '';
  const td=today();
  const list=Object.entries(S.stageAssign).filter(([,a])=>a.residentId===r && (!a.end || a.end>=td) && S.stages[a.stageId]).sort((a,b)=>a[1].start.localeCompare(b[1].start));
  if(!list.length) return '';
  const rows=list.map(([,a])=>{ const st=S.stages[a.stageId]; const now=a.start<=td; return `<div class="li"><span class="l"><b>${esc(st.name)} · ${esc(S.hospitals[st.hospitalId]?.short||hospName(st.hospitalId))}</b><span class="muted" style="font-size:.86rem">${fmtShort(a.start)}${a.end?' a '+fmtShort(a.end):' em diante'}</span></span><span class="pill ${now?'p-done':'p-wait'}">${now?'Atual':'Próximo'}</span></div>`; }).join('');
  return `<section class="panel" id="meu-estagio"><h2 style="margin-bottom:6px">Meu estágio</h2><div class="list">${rows}</div></section>`;
}
function stagesPanel(){
  const td=today();
  const yOpts=sel=>['ME1','ME2','ME3'].map(y=>`<option ${y===sel?'selected':''}>${y}</option>`).join('')+`<option value="" ${!sel?'selected':''}>Todos os anos</option>`;
  const hosp=Object.entries(S.hospitals).sort((a,b)=>a[1].name.localeCompare(b[1].name));
  const blocks=hosp.map(([hid,h])=>{
    const sts=stagesOf(hid).map(([id,st])=>{
      const as=Object.entries(S.stageAssign).filter(([,a])=>a.stageId===id).sort((a,b)=>a[1].start.localeCompare(b[1].start));
      const cur=as.filter(([,a])=>!a.end||a.end>=td), old=as.length-cur.length;
      const arows=cur.map(([aid,a])=>`<div class="li"><span class="l"><b>${esc(resName(a.residentId))}</b><span class="muted" style="font-size:.85rem">${fmtShort(a.start)}${a.end?' a '+fmtShort(a.end):' em diante'}${a.start<=td?' · atual':''}</span></span><button class="ghost" style="color:var(--bad)" data-act="delassign" data-id="${esc(aid)}">Tirar</button></div>`).join('');
      const opts=resByYear().filter(([y])=>!st.year||y===st.year).map(([y,list])=>`<optgroup label="${esc(y)}">${list.map(([rid,r])=>`<option value="${rid}">${esc(r.name)}</option>`).join('')}</optgroup>`).join('');
      return `<div class="rule"><div class="li edit" style="padding:0"><input id="stn-${esc(id)}" type="text" value="${esc(st.name)}" aria-label="Nome do estágio" style="flex:1 1 140px"><select id="sty-${esc(id)}" aria-label="Ano">${yOpts(st.year)}</select><span class="row" style="gap:4px"><button class="ghost" data-act="savestage" data-id="${esc(id)}">Salvar</button><button class="ghost" style="color:var(--bad)" data-act="delstage" data-id="${esc(id)}">Remover</button></span></div>
        <details ${cur.length?'open':''}><summary class="sumx">Período fixo no estágio (opcional)${cur.length?` · ${cur.length} residente${cur.length===1?'':'s'}`:''}</summary><div class="list">${arows||'<div class="empty">Ninguém com período fixo.</div>'}</div>${old?`<div class="note-ex">${old} período${old===1?'':'s'} encerrado${old===1?'':'s'}.</div>`:''}
        <div class="form"><label class="f">Residente<select id="sar-${esc(id)}">${opts||'<option value="">Nenhum residente deste ano</option>'}</select></label><label class="f">Início<input type="date" id="sas-${esc(id)}" value="${td}"></label><label class="f">Fim (opcional)<input type="date" id="sae-${esc(id)}"></label><button data-act="addassign" data-id="${esc(id)}">Colocar no estágio</button></div></details></div>`;
    }).join('');
    return `<div class="stack"><h3>${esc(h.short?h.short+' - ':'')}${esc(h.name)}</h3>${sts||'<div class="empty">Nenhum estágio neste hospital.</div>'}
      <div class="form"><label class="f">Novo estágio<input type="text" id="nsn-${esc(hid)}" placeholder="Ex.: Estágio A"></label><label class="f">Ano<select id="nsy-${esc(hid)}">${yOpts('ME1')}</select></label><button class="primary" data-act="addstage" data-id="${esc(hid)}">Criar estágio</button></div></div>`;
  }).join('<hr class="sep">');
  return `<section class="panel stack" id="estagios"><h2>Estágios</h2><div class="muted" style="font-size:.88rem">Crie aqui os estágios de cada hospital. Na hora de montar a escala do dia, escolha o hospital, o estágio e o residente. Se alguém fica num estágio por um período inteiro sem plantão lançado, use “Período fixo”.</div>${blocks||'<div class="empty">Cadastre um hospital primeiro.</div>'}</section>`;
}
function rulesPanel(){
  const sets=ruleSets().map((x,i)=>({...x,i})).sort((a,b)=>a.from.localeCompare(b.from));
  const cur=ruleFor(today());
  const order=[['n',1],['n',2],['n',3],['n',4],['n',5],['d',6],['n',6],['d',0],['n',0]];
  const blocks=sets.map(x=>`<div class="rule"><div class="row between"><label class="f">Válida para plantões a partir de<input type="date" id="pf-${x.i}" value="${esc(x.from)}"></label><span class="row" style="gap:6px">${x.from===cur.from?'<span class="pill p-done">Em vigor hoje</span>':(x.from>today()?'<span class="pill p-wait">Futura</span>':'')}${sets.length>1?`<button class="ghost" style="color:var(--bad)" data-act="delrule" data-i="${x.i}">Remover</button>`:''}</span></div>
    <div class="rulegrid">${order.map(([k,wd])=>{ const o=Number((k==='d'?x.dayOffsets:x.offsets)?.[wd] ?? 0); return `<label class="f">${k==='d'?'Diurno':'Noturno'} de ${WDL[wd]}<select id="po-${x.i}-${k}${wd}">${[0,1,2,3,4,5,6,7].map(n=>`<option value="${n}" ${n===o?'selected':''}>Pós-plantão: ${postLabel(wd,n)}</option>`).join('')}</select></label>`; }).join('')}</div></div>`).join('');
  const [y,m]=today().split('-').map(Number); const nextStart = `${m>=3?y+1:y}-03-01`;
  return `<section class="panel stack" id="regras-pos"><div class="sec-title"><h2>Regras de pós-plantão</h2><button class="primary" data-act="saverules">Salvar regras</button></div>
    <div class="muted" style="font-size:.88rem">Noturno vale para plantões que viram a noite (inclui o de 24h); diurno, para os que terminam no mesmo dia. O pós-plantão aparece sozinho assim que o residente é escalado. Para um novo ano, crie uma regra com a data de início: plantões antes dela seguem a regra anterior.</div>
    ${blocks}
    <div class="form"><label class="f">Nova regra a partir de<input type="date" id="pfNew" value="${nextStart}"></label><button data-act="addrule">Criar regra nova</button></div></section>`;
}

// ---------- request sheet ----------
function openAsk(shiftId){
  const r=myRes(); if(!r) return;
  const idx=checkIndex(), now=new Date();
  const reqd=new Set(allRequests().map(q=>q.shiftId));
  const opts=allShifts().filter(s=>s.residentId===r && times(s).b<=now && s.date>=addDays(today(),-60) && !reqd.has(s.id)).reverse();
  if (!opts.length){ toast('Nenhum plantão recente disponível para justificar.'); return; }
  const sel = shiftId && opts.some(s=>s.id===shiftId) ? shiftId : opts[0].id;
  const m=document.getElementById('modal');
  m.innerHTML=`<div class="overlay" data-act="close"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="askT">
    <div class="row between"><h2 id="askT">Justificar horas adicionais</h2><button class="ghost" data-act="close" aria-label="Fechar">Fechar</button></div>
    <label class="f">Plantão<select id="qShift">${opts.map(s=>{const ex=extraMins(s,idx[s.id]); return `<option value="${s.id}" ${s.id===sel?'selected':''}>${fmtShort(s.date)} · ${esc(S.hospitals[s.hospitalId]?.short||'')} ${s.start}–${s.end}${ex?` · +${fmtDur(ex)}`:''}</option>`}).join('')}</select></label>
    <div id="qInfo" class="muted" style="font-size:.88rem"></div>
    <div class="form"><label class="f">Horas<input type="number" id="qH" min="0" max="24" value="0"></label><label class="f">Minutos<input type="number" id="qM" min="0" max="59" step="5" value="0"></label></div>
    <label class="f">Justificativa<textarea id="qReason" placeholder="O que aconteceu e por que foi preciso ficar além da jornada"></textarea></label>
    <div class="form"><label class="f">Compensar em<input type="date" id="qDate" min="${addDays(today(),1)}" value="${addDays(today(),7)}"></label>
      <label class="f">Período<select id="qPer"><option>Manhã</option><option>Tarde</option><option>Dia inteiro</option></select></label></div>
    <div id="qWarn" class="warnline"></div>
    <div class="row"><button class="primary big" data-act="sendask">Enviar para a coordenação</button></div></div></div>`;
  const fill=()=>{ const s=opts.find(x=>x.id===document.getElementById('qShift').value); const c=idx[s.id]; const ex=extraMins(s,c);
    document.getElementById('qH').value=Math.floor(ex/60); document.getElementById('qM').value=ex%60;
    document.getElementById('qInfo').textContent = c?.in ? `Escala ${s.start}–${s.end} (${fmtDur(times(s).mins)}). Registro real ${hm(new Date(c.in))}–${c.out?hm(new Date(c.out)):'sem checkout'}.` : 'Este plantão não tem check-in registrado. Informe as horas manualmente.'; checkDate(); };
  const checkDate=()=>{ const d=document.getElementById('qDate').value; const c=allShifts().find(x=>x.residentId===r&&x.date===d); document.getElementById('qWarn').textContent = c?`Você tem plantão nesse dia (${S.hospitals[c.hospitalId]?.short||''} ${c.start}–${c.end}).`:''; };
  document.getElementById('qShift').addEventListener('change',fill);
  document.getElementById('qDate').addEventListener('change',checkDate);
  fill();
}
function closeModal(){ document.getElementById('modal').innerHTML=''; if(S.pending) render(); }

// ---------- writes ----------
const isStageEntry = s => !crosses(s) && !!(s.stageId || s.batch || s.label==='Estágio');
async function removeShifts(list){
  const byM={}; list.forEach(s=>(byM[s.month]=byM[s.month]||new Set()).add(s.id));
  for (const [m,ids] of Object.entries(byM)){ const cur=S.schedule[m]; if(!cur) continue; const shifts={...cur.shifts}; ids.forEach(id=>delete shifts[id]); await S.db.doc('schedule/'+m).set({...cur, shifts}); }
}
function posConflicts(){
  const all=allShifts(), idx=checkIndex(), td=today();
  return all.filter(s=>s.date>=td && isStageEntry(s) && !idx[s.id]?.in && postOn(s.date, all).some(p=>p.residentId===s.residentId));
}
async function addPeriod(data, d, until){
  if (until<d){ toast('A data final é antes do início.'); return; }
  if ((parseD(until)-parseD(d))/864e5>120){ toast('Período muito longo. Lance no máximo 4 meses de cada vez.'); return; }
  const days=[...document.querySelectorAll('#sDays input:checked')].map(i=>+i.value);
  if (!days.length){ toast('Marque os dias da semana do período.'); return; }
  const all=allShifts(), batch='b'+Date.now().toString(36), byMonth={}; let made=0, skipped=0;
  for (let x=d; x<=until; x=addDays(x,1)){
    if (!days.includes(parseD(x).getDay())) continue;
    if (onVac(data.residentId,x) || postOn(x,all).some(s=>s.residentId===data.residentId)){ skipped++; continue; }
    const m=x.slice(0,7); (byMonth[m]=byMonth[m]||{})[`s${x.replace(/-/g,'')}-${rid()}`]={...data, date:x, batch, until};
    made++;
  }
  if (!made){ toast('Nenhum dia para criar nesse período.'); return; }
  await guard(async()=>{ for (const [m,sh] of Object.entries(byMonth)){ const ref=S.db.doc('schedule/'+m); if (S.schedule[m]) await ref.update({shifts:sh}); else await ref.set({month:m, shifts:sh}); } },
    `${made} dia${made===1?'':'s'} lançado${made===1?'':'s'}${skipped?` · ${skipped} pulado${skipped===1?'':'s'} (férias ou pós-plantão)`:''}`);
}
async function guard(fn, okMsg){
  if (!S.db){ toast('Sem conexão com a escala.'); return; }
  S.busy=true;
  try { await fn(); if(okMsg) toast(okMsg); }
  catch(e){ console.error(e); toast(e?.code==='permission-denied'?'O servidor recusou esta ação. Confira se você está no local ou se tem permissão.':e?.code==='unavailable'?'Sem internet. Tente de novo quando a conexão voltar.':'Não foi possível salvar. Tente de novo.'); }
  finally { S.busy=false; render(); }
}
async function setShift(month, id, data){
  const ref=S.db.doc('schedule/'+month); const cur=S.schedule[month];
  if (cur) await ref.update({shifts:{[id]:data}}); else await ref.set({month, shifts:{[id]:data}});
}

const actions = {
  async checkin(el){ await doMark('in', el.dataset.id); },
  async checkout(el){ await doMark('out', el.dataset.id); },
  retrygeo(el){ doMark(el.dataset.k, el.dataset.id); },
  async forcegeo(el){ const note=(document.getElementById('gNote')?.value||'').trim(); if(note.length<10){ toast('Escreva a justificativa (pelo menos uma frase).'); return; }
    const s=allShifts().find(x=>x.id===el.dataset.id); const k=el.dataset.k; const extra={[k+'Note']:note, flag:true}; if(S.pendingGeo) extra[k+'Geo']=S.pendingGeo;
    closeModal(); await writeMark(k, s, extra); },
  ask(el){ openAsk(el.dataset.id); },
  close(el,ev){ if(ev.target===el) closeModal(); },
  async sendask(){
    const shiftId=document.getElementById('qShift').value; const s=allShifts().find(x=>x.id===shiftId);
    const minutes=(+document.getElementById('qH').value||0)*60+(+document.getElementById('qM').value||0);
    const reason=document.getElementById('qReason').value.trim(); const compDate=document.getElementById('qDate').value; const compPeriod=document.getElementById('qPer').value;
    const w=document.getElementById('qWarn');
    if (minutes<=0){ w.textContent='Informe quantas horas a mais você trabalhou.'; return; }
    if (reason.length<10){ w.textContent='Escreva a justificativa (pelo menos uma frase).'; return; }
    if (!compDate || compDate<=today()){ w.textContent='Escolha uma data futura para compensar.'; return; }
    const item={residentId:myRes(), shiftId, shiftDate:s.date, minutes, reason, compDate, compPeriod, createdAt:nowISO()};
    const ref=S.db.doc('requests/'+myRes()); const id='q'+Date.now().toString(36);
    closeModal();
    await guard(async()=>{ await ref.update({items:{[id]:item}}); }, 'Pedido enviado para a coordenação');
  },
  async decide(el){
    const key=el.dataset.k, q=el.dataset.q; const note=(document.getElementById(`note-${key}~${q}`)?.value||'').trim();
    const dec={status:el.dataset.v, note, at:nowISO(), by:S.email||''}; const ref=S.db.doc('decisions/'+key);
    await guard(()=> S.decisions[key] ? ref.update({items:{[q]:dec}}) : ref.set({items:{[q]:dec}}), el.dataset.v==='aprovado'?'Compensação autorizada':'Pedido negado');
  },
  async undecide(el){ const cur=S.decisions[el.dataset.k]; if(!cur) return; const items={...cur.items}; delete items[el.dataset.q]; await guard(()=>S.db.doc('decisions/'+el.dataset.k).set({...cur, items}), 'Pedido reaberto'); },
  cf(el){ S.compFilter=el.dataset.v; render(); },
  day(el){ S.date=addDays(S.date,+el.dataset.n); render(); },
  today(){ S.date=today(); render(); },
  pick(el){ S.date=el.dataset.d; render(); },
  goManage(){ S.manageDate=S.date; S.tab='gerenciar'; render(); window.scrollTo({top:0}); },
  seg(el){ S.seg=el.dataset.v; render(); },
  monthToggle(){ S.monthOpen=!S.monthOpen; render(); },
  week(el){ const n=+el.dataset.n; if(S.monthOpen){ const d=parseD(S.date); d.setDate(1); d.setMonth(d.getMonth()+n); S.date=isoDate(d); } else S.date=addDays(S.date,7*n); render(); },
  mday(el){ S.manageDate=addDays(S.manageDate,+el.dataset.n); render(); },
  month(el){ const [y,m]=S.date.split('-').map(Number); const d=new Date(y,m-1+ +el.dataset.n,1); const ym=`${d.getFullYear()}-${pad(d.getMonth()+1)}`; S.date = ym===today().slice(0,7) ? today() : ym+'-01'; render(); },
  async addvac(){ const r=document.getElementById('vRes').value, a=document.getElementById('vStart').value, b=document.getElementById('vEnd').value;
    if(!r||!a||!b||b<a){ toast('Confira as datas das férias.'); return; }
    await guard(()=>S.db.doc('vacations/v'+Date.now().toString(36)).set({residentId:r,start:a,end:b}), 'Férias lançadas'); },
  async delvac(el){ await guard(()=>S.db.doc('vacations/'+el.dataset.id).delete(), 'Férias removidas'); },
  async addshift(){ const d=S.manageDate; const data={date:d, hospitalId:document.getElementById('sHosp').value, residentId:document.getElementById('sRes').value, start:document.getElementById('sStart').value, end:document.getElementById('sEnd').value, label:document.getElementById('sLabel').value, stageId:document.getElementById('sStage')?.value||null};
    if(!data.hospitalId||!data.residentId||!data.start||!data.end){ toast('Preencha hospital, residente e horários.'); return; }
    const until=document.getElementById('sUntil')?.value;
    if(until && until!==d) return addPeriod(data, d, until);
    if(onVac(data.residentId,d) && !el_confirm('vac')) { toast('Residente de férias neste dia. Clique de novo para confirmar.'); return; }
    if(postOn(d,allShifts()).some(s=>s.residentId===data.residentId) && !el_confirm('pos')) { toast('Residente em pós-plantão neste dia. Clique de novo para confirmar.'); return; }
    const pd=postDate(data), idx=checkIndex();
    const onPd = pd ? allShifts().filter(s=>s.residentId===data.residentId && s.date===pd) : [];
    const stageOut = onPd.filter(s=>isStageEntry(s) && !idx[s.id]?.in);
    if(onPd.some(s=>!stageOut.includes(s)) && !el_confirm('pos2')) { toast(`O pós-plantão cairia em ${fmtDay(pd)}, quando o residente já tem plantão. Clique de novo para confirmar.`); return; }
    await guard(async()=>{ if(stageOut.length) await removeShifts(stageOut); await setShift(d.slice(0,7), `s${d.replace(/-/g,'')}-${rid()}`, data); },
      (pd?`Plantão adicionado · pós-plantão em ${fmtDay(pd)}`:'Plantão adicionado') + (stageOut.length?` · retirado do estágio nesse dia`:'')); },
  async fixpos(){ const c=posConflicts(); if(!c.length) return; await guard(()=>removeShifts(c), `${c.length} dia${c.length===1?'':'s'} de estágio retirado${c.length===1?'':'s'} por pós-plantão`); },
  async saverules(){
    const sets=ruleSets().map((x,i)=>{ const offsets={}, dayOffsets={}; for(let wd=0;wd<7;wd++){ const en=document.getElementById(`po-${i}-n${wd}`); offsets[wd]=en?Number(en.value):Number(x.offsets?.[wd] ?? 0); const ed=document.getElementById(`po-${i}-d${wd}`); dayOffsets[wd]=ed?Number(ed.value):Number(x.dayOffsets?.[wd] ?? 0); } const f=document.getElementById(`pf-${i}`); return {...x, from:(f&&f.value)||x.from, offsets, dayOffsets}; });
    const froms=sets.map(x=>x.from); if(new Set(froms).size!==froms.length){ toast('Duas regras com a mesma data de início. Ajuste uma delas.'); return; }
    await guard(()=>S.db.doc('config/pos').set({sets}), 'Regras salvas'); },
  async addrule(){ const f=document.getElementById('pfNew').value; if(!f){ toast('Escolha a data de início.'); return; }
    if(ruleSets().some(x=>x.from===f)){ toast('Já existe uma regra com essa data.'); return; }
    const base=ruleFor(f); const sets=[...ruleSets(), {from:f, offsets:{...base.offsets}, dayOffsets:{...(base.dayOffsets||{})}}];
    await guard(()=>S.db.doc('config/pos').set({sets}), 'Regra criada. Ajuste os dias e salve.'); },
  async delrule(el){ if(!el_confirm('rule'+el.dataset.i)){ toast('Clique de novo em Remover para confirmar.'); return; }
    const sets=ruleSets().filter((x,i)=>i!==+el.dataset.i); await guard(()=>S.db.doc('config/pos').set({sets}), 'Regra removida'); },
  async addstage(el){ const hid=el.dataset.id; const name=document.getElementById('nsn-'+hid).value.trim(); if(!name){ toast('Dê um nome ao estágio.'); return; }
    await guard(()=>S.db.doc('stages/st'+Date.now().toString(36)).set({hospitalId:hid, name, year:document.getElementById('nsy-'+hid).value}), 'Estágio criado'); },
  async savestage(el){ const id=el.dataset.id; const name=document.getElementById('stn-'+id).value.trim(); if(!name){ toast('O nome não pode ficar vazio.'); return; }
    await guard(()=>S.db.doc('stages/'+id).update({name, year:document.getElementById('sty-'+id).value}), 'Estágio atualizado'); },
  async delstage(el){ const id=el.dataset.id; if(!el_confirm('st'+id)){ toast('Clique de novo em Remover para apagar o estágio e os períodos dele.'); return; }
    await guard(async()=>{ for (const [aid,a] of Object.entries(S.stageAssign)) if(a.stageId===id) await S.db.doc('stageAssign/'+aid).delete(); await S.db.doc('stages/'+id).delete(); }, 'Estágio removido'); },
  async addassign(el){ const id=el.dataset.id; const r=document.getElementById('sar-'+id).value, a=document.getElementById('sas-'+id).value, b=document.getElementById('sae-'+id).value||null;
    if(!r){ toast('Escolha o residente.'); return; } if(!a||(b&&b<a)){ toast('Confira as datas do período.'); return; }
    const clash=Object.values(S.stageAssign).find(x=>x.residentId===r && x.start<=(b||'9999-12-31') && (!x.end||x.end>=a));
    if(clash && !el_confirm('sa'+r)){ const st=S.stages[clash.stageId]; toast(`${resName(r)} já está em ${st?st.name:'outro estágio'} nesse período. Clique de novo para confirmar.`); return; }
    await guard(()=>S.db.doc('stageAssign/sa'+Date.now().toString(36)).set({stageId:id, residentId:r, start:a, end:b}), 'Residente colocado no estágio'); },
  async delassign(el){ await guard(()=>S.db.doc('stageAssign/'+el.dataset.id).delete(), 'Residente retirado do estágio'); },
  async delbatch(el){ const b=el.dataset.b, from=el.dataset.from; if(!el_confirm('b'+b)){ toast('Clique de novo para remover este período a partir deste dia.'); return; }
    await guard(async()=>{ let n=0; for (const [m,doc] of Object.entries(S.schedule)){ const shifts={...doc.shifts}; let ch=false; for (const [id,s] of Object.entries(shifts)) if(s.batch===b && s.date>=from){ delete shifts[id]; ch=true; n++; } if(ch) await S.db.doc('schedule/'+m).set({...doc, shifts}); } toast(`${n} dia${n===1?'':'s'} removido${n===1?'':'s'}`); }); },
  async delshift(el){ const m=el.dataset.m; const cur=S.schedule[m]; if(!cur) return; const shifts={...cur.shifts}; delete shifts[el.dataset.id];
    await guard(()=>S.db.doc('schedule/'+m).set({...cur, shifts}), 'Plantão removido'); },
  async addres(){ const name=document.getElementById('rName').value.trim(); if(!name){ toast('Informe o nome.'); return; }
    const email=normEmail(document.getElementById('rEmail').value); if(email===false) return;
    const id='r'+Date.now().toString(36);
    await guard(async()=>{ await S.db.doc('residents/'+id).set({name, year:document.getElementById('rYear').value}); if(email) await S.db.doc('members/'+email).set({residentId:id}); }, 'Residente adicionado'); },
  async bulkres(){ const lines=(document.getElementById('rBulk').value||'').split('\n').map(l=>l.trim()).filter(Boolean); if(!lines.length){ toast('Cole a lista, um residente por linha.'); return; }
    const rows=[]; for (const [i,l] of lines.entries()){ const [n,y,e]=l.split(/[;\t]/).map(x=>(x||'').trim()); if(!n){ toast(`Linha ${i+1} sem nome.`); return; } const yr=(y||'').toUpperCase(); if(!YEARS.includes(yr)){ toast(`Linha ${i+1}: o ano precisa ser ME1, ME2 ou ME3.`); return; } const em=e?normEmail(e,true):''; if(em===false){ toast(`Linha ${i+1}: e-mail inválido.`); return; } rows.push([n,yr,em]); }
    await guard(async()=>{ let k=0; for (const [n,y,e] of rows){ const id='r'+Date.now().toString(36)+(k++); await S.db.doc('residents/'+id).set({name:n, year:y}); if(e) await S.db.doc('members/'+e).set({residentId:id}); } }, `${rows.length} residente${rows.length===1?'':'s'} adicionado${rows.length===1?'':'s'}`); },
  async saveres(el){ const id=el.dataset.id; const name=document.getElementById('rn-'+id).value.trim(); if(!name){ toast('O nome não pode ficar vazio.'); return; }
    const email=normEmail(document.getElementById('rem-'+id).value); if(email===false) return;
    if(email && S.members[email] && S.members[email].residentId!==id){ toast(`Esse e-mail já está com ${resName(S.members[email].residentId)}.`); return; }
    const old=emailOf(id);
    await guard(async()=>{ await S.db.doc('residents/'+id).update({name, year:document.getElementById('ry-'+id).value}); if(old && old!==email) await S.db.doc('members/'+old).delete(); if(email && email!==old) await S.db.doc('members/'+email).set({residentId:id}); }, 'Residente atualizado'); },
  async savehosp(el){ const id=el.dataset.id; const name=document.getElementById('hn-'+id).value.trim(); if(!name){ toast('O nome não pode ficar vazio.'); return; }
    await guard(()=>S.db.doc('hospitals/'+id).update({name, short:document.getElementById('hs-'+id).value.trim().toUpperCase()}), 'Hospital atualizado'); },
  async delres(el){ if(!el_confirm('res'+el.dataset.id)){ toast('Clique de novo em Remover para confirmar.'); return; } const e=emailOf(el.dataset.id); await guard(async()=>{ if(e) await S.db.doc('members/'+e).delete(); await S.db.doc('residents/'+el.dataset.id).delete(); }, 'Residente removido'); },
  async addhosp(){ const name=document.getElementById('hName').value.trim(); if(!name){ toast('Informe o nome do hospital.'); return; }
    await guard(()=>S.db.doc('hospitals/h'+Date.now().toString(36)).set({name, short:document.getElementById('hShort').value.trim().toUpperCase()}), 'Hospital adicionado'); },
  async delhosp(el){ if(!el_confirm('h'+el.dataset.id)){ toast('Clique de novo em Remover para confirmar.'); return; } await guard(()=>S.db.doc('hospitals/'+el.dataset.id).delete(), 'Hospital removido'); },
  me(){
    const r=myRes();
    modal(`<div class="row between"><h2>Minha conta</h2><button class="ghost" data-act="close">Fechar</button></div>
      <div class="list"><div class="li"><span class="l"><b>${esc(S.user?.displayName||'')}</b><span class="muted">${esc(S.email||'')}</span></span></div>
      <div class="li"><span class="l"><span class="muted">${[S.isCoord?'Coordenação':'', r?`Residente: ${esc(resName(r))} (${esc(S.residents[r]?.year||'')})`:''].filter(Boolean).join(' · ')}</span></span></div></div>
      <div class="row"><button class="bad" data-act="logout">Sair</button></div>`);
  },
  async logout(){ closeModal(); await firebase.auth().signOut(); },
  async login(){
    const auth=firebase.auth(), p=new firebase.auth.GoogleAuthProvider();
    p.setCustomParameters({prompt:'select_account'});
    try { await auth.signInWithPopup(p); }
    catch(e){
      if(['auth/popup-blocked','auth/operation-not-supported-in-this-environment','auth/cancelled-popup-request'].includes(e?.code)){ try{ await auth.signInWithRedirect(p); }catch(e2){ toast('Não foi possível abrir o login do Google.'); } }
      else if(e?.code==='auth/unauthorized-domain') toast('Este endereço ainda não foi autorizado no Firebase (Authentication → Configurações → Domínios autorizados).');
      else if(e?.code!=='auth/popup-closed-by-user') toast('Não foi possível entrar. Tente de novo.');
    }
  },
  geo(el){ openGeo(el.dataset.id); },
  async geosearch(){
    const q=(document.getElementById('gq')?.value||'').trim(); const box=document.getElementById('gres'); if(!q||!box) return;
    box.innerHTML='<div class="empty">Buscando…</div>';
    try{
      const r=await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=br&q='+encodeURIComponent(q), {headers:{'Accept-Language':'pt-BR'}});
      const list=await r.json();
      box.innerHTML = list.length ? list.map(x=>`<div class="li"><span class="l" style="font-size:.88rem">${esc(x.display_name)}</span><button class="ghost" data-act="geopick" data-lat="${esc(x.lat)}" data-lng="${esc(x.lon)}">Usar</button></div>`).join('') : '<div class="empty">Nada encontrado. Tente com cidade e número, ou cole as coordenadas.</div>';
    }catch(e){ box.innerHTML='<div class="empty">A busca não respondeu. Cole as coordenadas do Google Maps.</div>'; }
  },
  geopick(el){ setLL(el.dataset.lat, el.dataset.lng); },
  async geohere(el){ el.disabled=true; try{ const p=await locate(); setLL(p.lat,p.lng); toast(`Localização obtida (±${p.acc} m)`); }catch(e){ toast(e?.code==='denied'?'Permita a localização para este site no navegador.':'Não foi possível pegar a localização.'); } el.disabled=false; },
  async geosave(el){
    const ll=parseLL(document.getElementById('gll')?.value); if(!ll){ toast('Coordenadas inválidas. Use o formato -23.5617, -46.6560.'); return; }
    const radius=Math.round(+document.getElementById('grad')?.value||0); if(!(radius>=50&&radius<=5000)){ toast('Use uma distância entre 50 e 5000 metros.'); return; }
    const geo={lat:+ll.lat.toFixed(6), lng:+ll.lng.toFixed(6), radius, cosLat:+Math.cos(ll.lat*Math.PI/180).toFixed(6)};
    closeModal(); await guard(()=>S.db.doc('hospitals/'+el.dataset.id).update({geo}), 'Local do hospital salvo');
  },
  async geoclear(el){ closeModal(); await guard(()=>S.db.doc('hospitals/'+el.dataset.id).update({geo:null}), 'Localização deixou de ser exigida'); },
  async review(el){ await guard(()=>S.fs.doc(`checkins/${el.dataset.m}/marks/${el.dataset.id}`).update({review:{status:el.dataset.v, by:S.email, at:nowISO()}}), el.dataset.v==='aceito'?'Registro aceito':'Registro recusado'); },
  async addcoord(){ const e=normEmail(document.getElementById('cEmail')?.value); if(!e) { if(e==='') toast('Informe o e-mail.'); return; } await guard(()=>S.db.doc('coordinators/'+e).set({at:nowISO(), by:S.email}), 'Coordenação adicionada'); },
  async delcoord(el){ if(el.dataset.id===S.email) return; if(!el_confirm('c'+el.dataset.id)){ toast('Clique de novo em Remover para confirmar.'); return; } await guard(()=>S.db.doc('coordinators/'+el.dataset.id).delete(), 'Removido da coordenação'); },
  async importjson(){
    const f=document.getElementById('impFile')?.files?.[0]; if(!f){ toast('Escolha o arquivo .json.'); return; }
    let data; try{ data=JSON.parse(await f.text()); }catch(e){ toast('Arquivo inválido.'); return; }
    if(data?.formato!=='escala-residencia-v1'){ toast('Esse arquivo não é uma exportação da Escala da Residência.'); return; }
    const cols=['residents','hospitals','stages','stageAssign','schedule','vacations','config']; let n=0;
    await guard(async()=>{ for (const c of cols) for (const [id,doc] of Object.entries(data[c]||{})){ if(!/^[A-Za-z0-9_\-.~:@+]+$/.test(id)||!doc||typeof doc!=='object') continue; await S.fs.doc(`${c}/${id}`).set(doc); n++; } }, null);
    if(n) toast(`${n} registros importados`);
  },
};
let lastConfirm={k:null,t:0};
function el_confirm(k){ const now=Date.now(); if(lastConfirm.k===k && now-lastConfirm.t<5000){ lastConfirm={k:null,t:0}; return true; } lastConfirm={k,t:now}; return false; }

document.addEventListener('click', ev=>{
  const t=ev.target.closest('[data-tab]'); if(t){ S.tab=t.dataset.tab; render(); window.scrollTo({top:0}); return; }
  const a=ev.target.closest('[data-act]'); if(!a) return;
  const fn=actions[a.dataset.act]; if(fn) fn(a, ev);
});
document.addEventListener('change', ev=>{
  if(ev.target.id==='sHosp'){ S.form.hosp=ev.target.value; S.form.stage=''; const st=document.getElementById('sStage'); if(st) st.innerHTML=stageOpts(S.form.hosp,''); const r=document.getElementById('sRes'); if(r) r.innerHTML=resOptsFor('',S.manageDate); }
  if(ev.target.id==='sUntil'){ S.form.until=ev.target.value; const w=document.getElementById('sDaysWrap'); const on=!!ev.target.value && ev.target.value>S.manageDate; if(w) w.hidden=!on; if(on && !document.querySelector('#sDays input:checked')){ const wd=parseD(S.manageDate).getDay(); const cb=document.querySelector(`#sDays input[value="${wd}"]`); if(cb){ cb.checked=true; S.form.days=[wd]; } } }
  if(ev.target.closest && ev.target.closest('#sDays')){ S.form.days=[...document.querySelectorAll('#sDays input:checked')].map(i=>+i.value); }
  if(ev.target.id==='sStage'){ S.form.stage=ev.target.value; const r=document.getElementById('sRes'); if(r){ const keep=r.value; r.innerHTML=resOptsFor(S.form.stage,S.manageDate); if([...r.options].some(o=>o.value===keep)) r.value=keep; } }
  if(ev.target.id==='pickDay' && ev.target.value){ S.date=ev.target.value; ev.target.blur(); render(); }
  if(ev.target.id==='mDay' && ev.target.value){ S.manageDate=ev.target.value; ev.target.blur(); render(); }
});
document.addEventListener('focusout', ()=>{ setTimeout(()=>{ if(S.pending && !document.getElementById('view').contains(document.activeElement)) render(); }, 50); });
document.addEventListener('keydown', ev=>{ if(ev.key==='Escape' && document.getElementById('modal').innerHTML) closeModal(); });
setInterval(()=>{ if(S.tab==='escala') render(); }, 60000);
let touchX=null;
document.addEventListener('touchstart', e=>{ touchX = e.target.closest('#strip') ? e.touches[0].clientX : null; }, {passive:true});
document.addEventListener('touchend', e=>{ if(touchX==null) return; const dx=e.changedTouches[0].clientX-touchX; touchX=null; if(Math.abs(dx)>60) actions.week({dataset:{n: dx<0?1:-1}}); });

// ---------- boot (Firebase) ----------
const unsubs=[];
function stopAll(){ while(unsubs.length){ try{ unsubs.pop()(); }catch(e){} } for (const k of Object.keys(markL)){ try{ markL[k](); }catch(e){} delete markL[k]; } fetchedMarks.clear(); }
function screen(html){
  document.querySelector('nav.bottom').hidden=true;
  document.getElementById('topTitle').textContent='Escala da Residência';
  document.getElementById('topRight').innerHTML='';
  renderWho();
  document.getElementById('view').innerHTML=html;
}
function showLogin(){
  screen(`<section class="panel stack" style="max-width:460px;width:100%;margin:40px auto 0;text-align:center;justify-items:center">
    <h2>Entrar</h2><p class="muted" style="margin:0">Use a conta Google do e-mail que a coordenação cadastrou.</p>
    <button class="primary big" data-act="login">Entrar com Google</button></section>`);
}
function showNoAccess(){
  screen(`<section class="panel stack" style="max-width:520px;width:100%;margin:40px auto 0">
    <h2>Seu e-mail não está cadastrado</h2>
    <p class="muted" style="margin:0">Você entrou como <b>${esc(S.email)}</b>. Peça à coordenação para colocar esse e-mail no seu nome em Gerenciar → Residentes, e entre de novo.</p>
    <div class="row"><button data-act="logout">Sair e entrar com outra conta</button></div></section>`);
}
function showSetup(){
  screen(`<section class="panel stack" style="max-width:560px;width:100%;margin:40px auto 0"><h2>Falta configurar o Firebase</h2>
    <p class="muted" style="margin:0">Abra o arquivo <b>config.js</b> e cole a configuração do seu projeto Firebase, como explicado no guia.</p></section>`);
}
function adapter(fs){
  return { doc: p => { const r=fs.doc(p); return {
    set: d => r.set(d),
    update: d => r.set(d, {merge:true}),
    delete: () => r.delete(),
    get: () => r.get() }; } };
}
function startData(){
  const fs=S.fs, need=new Set(), loaded=new Set();
  const done=name=>{ loaded.add(name); if(!S.ready && [...need].every(n=>loaded.has(n))){ S.ready=true; document.querySelector('nav.bottom').hidden=false; } render(); };
  const col=(name, path=name)=>{ need.add(name); unsubs.push(fs.collection(path).onSnapshot(snap=>{ const o={}; snap.forEach(d=>o[d.id]=d.data()); S[name]=o; done(name); }, err=>{ console.error(name, err); S[name]={}; done(name); toast('Sem permissão para ler parte da escala.'); })); };
  const one=(name, path)=>{ need.add(name); unsubs.push(fs.doc(path).onSnapshot(d=>{ S[name]=d.exists?{[d.id]:d.data()}:{}; done(name); }, err=>{ console.error(name, err); S[name]={}; done(name); })); };
  ['residents','hospitals','schedule','vacations','config','stages','stageAssign'].forEach(c=>col(c));
  if(S.isCoord){ ['members','coordinators','requests','decisions'].forEach(c=>col(c)); }
  else {
    S.members = S.memberRes ? {[S.email]:{residentId:S.memberRes}} : {};
    one('requests', 'requests/'+S.memberRes);
    one('decisions', 'decisions/'+S.memberRes);
  }
}
function boot(){
  const cfg=window.FIREBASE_CONFIG;
  if(!window.firebase){ screen('<div class="panel"><p class="muted" style="margin:0">Não foi possível carregar o Firebase. Confira a internet e recarregue a página.</p></div>'); return; }
  if(!cfg||!cfg.apiKey||/COLE_AQUI/.test(cfg.apiKey)){ showSetup(); return; }
  firebase.initializeApp(cfg);
  const fs=firebase.firestore();
  try{ fs.enablePersistence({synchronizeTabs:true}).catch(()=>{}); }catch(e){}
  S.fs=fs; S.db=adapter(fs);
  const auth=firebase.auth();
  auth.getRedirectResult().catch(e=>{ if(e?.code==='auth/unauthorized-domain') toast('Este endereço ainda não foi autorizado no Firebase.'); });
  auth.onAuthStateChanged(async u=>{
    stopAll(); S.ready=false; S.marks={}; S.isCoord=false; S.memberRes=null;
    if(!u){ S.user=null; S.email=null; showLogin(); return; }
    S.user=u; S.email=(u.email||'').toLowerCase();
    screen('<div class="panel"><p class="muted" style="margin:0">Carregando a escala…</p></div>');
    try{ S.isCoord=(await fs.doc('coordinators/'+S.email).get()).exists; }catch(e){ S.isCoord=false; }
    try{ const m=await fs.doc('members/'+S.email).get(); S.memberRes=m.exists?(m.data().residentId||null):null; }catch(e){ S.memberRes=null; }
    if(!S.isCoord && !S.memberRes){ showNoAccess(); return; }
    S.tab='escala'; S.seg = S.memberRes ? 'todos' : 'todos';
    startData();
  });
}
boot();

})();
