let ctx,analyser,stream,source,track,processor,silentGain,running=false,paused=false,startTime=0,last=0;
let weighting='A', view='fft',energy=0,energyTime=0,history=[];
let fastE=undefined, slowE=undefined;
let measurementReady=false, stabilizationElapsed=0;
const STABILIZATION_SEC=2.0;
let minFast=Infinity,maxFast=-Infinity,minSlow=Infinity,maxSlow=-Infinity;
let latestLevel=NaN, latestRawLevel=NaN;
let clipSamples=0,totalSamples=0,lastClipAt=0;
let sessionStartedAt=null, calibrationSampling=false, calibrationSamples=[], pendingCalibration=null;
const $=id=>document.getElementById(id); const canv=$('spectrum'), hist=$('history');
const CAL_KEY='slm_calibration_v2';
const NOMINAL_OFFSET=100; // Solo referencia digital→SPL estimada cuando no hay calibración externa.
function resize(c){c.width=Math.max(1,c.clientWidth*devicePixelRatio);c.height=Math.max(1,c.clientHeight*devicePixelRatio)}
function weight(f,w){if(w==='Z')return 0; let f2=f*f;if(w==='A'){let ra=(12200**2*f2*f2)/((f2+20.6**2)*Math.sqrt((f2+107.7**2)*(f2+737.9**2))*(f2+12200**2));return 20*Math.log10(ra)+2;}let rc=(12200**2*f2)/((f2+20.6**2)*(f2+12200**2));return 20*Math.log10(rc)+.06}
function getCalibration(){try{return JSON.parse(localStorage.getItem(CAL_KEY)||'null')}catch{return null}}
function currentOffset(){const c=getCalibration();return c&&Number.isFinite(c.offset)?c.offset:NOMINAL_OFFSET}
function updateCalUI(){const c=getCalibration(),st=$('calStatus'),ol=$('calOffsetLabel');if(st){st.textContent=c?'Calibrado':'Estimación automática';st.className=c?'ok':''}if(ol)ol.textContent=c?`Corrección: ${c.offset>=0?'+':''}${c.offset.toFixed(1)} dB`:'Sin calibración externa';}
function label(){let p=weighting;const slow=$('response').value==='1';let r=slow?'SLOW':'FAST',t=slow?'S':'F';$('unit').textContent=`dB(${p})`;$('instLabel').textContent=`L${p}${t}`;$('leqLabel').textContent=`L${p}eq,T`;$('maxLabel').textContent=`L${p}${t}max`;$('minLabel').textContent=`L${p}${t}min`;$('histLegend').textContent=`dB(${p})`;if($('mobileWeight'))$('mobileWeight').textContent=p;if($('mobileResponse'))$('mobileResponse').textContent=r;if($('referenceUnit'))$('referenceUnit').textContent=`dB(${p})`}
document.querySelectorAll('.mode button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.mode button').forEach(x=>x.classList.remove('active'));b.classList.add('active');weighting=b.dataset.w;label();resetStats()});document.querySelectorAll('.view').forEach(b=>b.onclick=()=>{if(!b.dataset.view)return;document.querySelectorAll('.view[data-view]').forEach(x=>x.classList.remove('active'));b.classList.add('active');view=b.dataset.view;updateFrequencyModeUI();if(analyser)drawSpectrum(spectrumLevels())});$('response').onchange=()=>{label();updateDisplayedStats();document.querySelectorAll('[data-response]').forEach(b=>b.classList.toggle('active',b.dataset.response===$('response').value))};document.querySelectorAll('[data-response]').forEach(b=>b.onclick=()=>{$('response').value=b.dataset.response;$('response').dispatchEvent(new Event('change'))});

// Coeficientes IIR obtenidos por transformación bilineal de las curvas analógicas A/C,
// normalizados a 0 dB a 1 kHz. Se elige el banco más cercano a 44.1 o 48 kHz.
const SOS={
  44100:{A:[[0.2555878203785175,0.511175640757035,0.2555878203785175,1,-0.14053608242071078,0.004937597615540203],[1,-2,1,1,-1.884901217428792,0.8864214718161674],[1,-2,1,1,-1.9941388812663283,0.9941474694445309]],C:[[0.21701321570823098,0.43402643141646197,0.21701321570823098,1,-0.14053608242071078,0.004937597615540203],[1,-2,1,1,-1.9941388812663283,0.9941474694445309]]},
  48000:{A:[[0.23418304260356074,0.4683660852071215,0.23418304260356074,1,-0.22455845805977914,0.012606625271546396],[1,-2,1,1,-1.8938704947230707,0.8951597690946617],[1,-2,1,1,-1.9946144559930215,0.9946217070140843]],C:[[0.19789070701987366,0.3957814140397473,0.19789070701987366,1,-0.22455845805977914,0.012606625271546396],[1,-2,1,1,-1.9946144559930215,0.9946217070140843]]}
};
// Corrección digital de alta frecuencia para compensar el warping de la transformación bilineal.
// Se aplica por igual a A y C; mantiene ~0 dB de corrección bajo 4 kHz y mejora 8–20 kHz.
const HF_CORR={
  44100:[2.04743012,0.75373459,0.26641216,1,1.48992278,0.57765408],
  48000:[1.96173107,0.60991994,0.22810595,1,1.32685313,0.47290383]
};
let filters={A:null,C:null};
function makeCascade(kind,fs){const bank=Math.abs(fs-44100)<Math.abs(fs-48000)?44100:48000;const coeffs=[...SOS[bank][kind],HF_CORR[bank]];return coeffs.map(c=>({b0:c[0],b1:c[1],b2:c[2],a1:c[4],a2:c[5],z1:0,z2:0}))}
function runCascade(x,sections){let y=x;for(const s of sections){const o=s.b0*y+s.z1;s.z1=s.b1*y-s.a1*o+s.z2;s.z2=s.b2*y-s.a2*o;y=o}return y}
function processAudio(ev){if(!running||paused)return;const input=ev.inputBuffer.getChannelData(0);let sumA=0,sumC=0,sumZ=0,blockClip=0;for(let i=0;i<input.length;i++){const x=input[i];if(Math.abs(x)>=0.995)blockClip++;const a=runCascade(x,filters.A),c=runCascade(x,filters.C);sumA+=a*a;sumC+=c*c;sumZ+=x*x}const n=input.length;if(!n)return;clipSamples+=blockClip;totalSamples+=n;if(blockClip>0)lastClipAt=performance.now();const mean={A:sumA/n,C:sumC/n,Z:sumZ/n}[weighting];if(!(mean>0))return;const rawDb=10*Math.log10(mean);const off=currentOffset();const eCal=mean*Math.pow(10,off/10);latestRawLevel=rawDb;latestLevel=10*Math.log10(eCal);
  const dt=n/ctx.sampleRate;
  // FAST/SLOW se integran en energía (p²), no promediando dB.
  const af=1-Math.exp(-dt/0.125), as=1-Math.exp(-dt/1.0);
  if(!(fastE>0))fastE=eCal; else fastE+=af*(eCal-fastE);
  if(!(slowE>0))slowE=eCal; else slowE+=as*(eCal-slowE);
  if(calibrationSampling&&Number.isFinite(rawDb))calibrationSamples.push(rawDb);

  // Estabilización inicial del micrófono: durante 2 s se muestra el nivel,
  // pero NO se integra Leq ni se retienen máximos/mínimos. Esto evita que
  // el transitorio de apertura/AGC del navegador contamine sobre todo Lmin.
  if(!measurementReady){
    stabilizationElapsed+=dt;
    if(stabilizationElapsed<STABILIZATION_SEC)return;

    // En el instante real de inicio se reinician los detectores con la
    // energía ya estabilizada y desde aquí comienzan T, Leq, Max y Min.
    fastE=eCal;
    slowE=eCal;
    const l0=10*Math.log10(eCal);
    minFast=maxFast=minSlow=maxSlow=l0;
    energy=0;
    energyTime=0;
    measurementReady=true;
    sessionStartedAt=new Date();
    if($('status')){$('status').textContent='● MIDIENDO';$('status').style.color='#d6f23d'}
  }

  energy+=eCal*dt;
  energyTime+=dt;
  const lf=10*Math.log10(fastE), ls=10*Math.log10(slowE);
  minFast=Math.min(minFast,lf);maxFast=Math.max(maxFast,lf);minSlow=Math.min(minSlow,ls);maxSlow=Math.max(maxSlow,ls);
}
async function start(){if(!ctx){const requested={echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1};stream=await navigator.mediaDevices.getUserMedia({audio:requested,video:false});track=stream.getAudioTracks()[0];ctx=new (window.AudioContext||window.webkitAudioContext)();source=ctx.createMediaStreamSource(stream);analyser=ctx.createAnalyser();analyser.fftSize=8192;analyser.smoothingTimeConstant=0;source.connect(analyser);filters.A=makeCascade('A',ctx.sampleRate);filters.C=makeCascade('C',ctx.sampleRate);
    // ScriptProcessor se usa para mantener compatibilidad amplia (incluido Safari/iOS).
    // El procesamiento es temporal; el analyser queda solo para visualización espectral.
    processor=ctx.createScriptProcessor(1024,1,1);silentGain=ctx.createGain();silentGain.gain.value=0;source.connect(processor);processor.connect(silentGain);silentGain.connect(ctx.destination);processor.onaudioprocess=processAudio;renderMicInfo()}
  await ctx.resume();if(!running){startTime=performance.now();last=startTime;running=true;resetStats(false)}paused=false;$('status').textContent=measurementReady?'● MIDIENDO':'● PREPARANDO';$('status').style.color=measurementReady?'#d6f23d':'#f3c969';requestAnimationFrame(loop)}
function resetStats(resetClock=true){energy=0;energyTime=0;history=[];fastE=undefined;slowE=undefined;measurementReady=false;stabilizationElapsed=0;minFast=Infinity;maxFast=-Infinity;minSlow=Infinity;maxSlow=-Infinity;latestLevel=NaN;latestRawLevel=NaN;clipSamples=0;totalSamples=0;lastClipAt=0;if(resetClock){startTime=performance.now();last=startTime}sessionStartedAt=null;$('min').textContent=$('max').textContent=$('leq').textContent='--.-';$('elapsed').textContent='00:00:00';if(running&&$('status')){$('status').textContent='● PREPARANDO';$('status').style.color='#f3c969'}}
$('start').onclick=()=>start().catch(e=>alert('No fue posible acceder al micrófono. Use HTTPS y autorice el permiso.\n'+e.message));$('pause').onclick=()=>{if(!running)return;paused=!paused;$('status').textContent=paused?'● PAUSADO':(measurementReady?'● MIDIENDO':'● PREPARANDO');$('status').style.color=paused?'#9fb4bd':(measurementReady?'#d6f23d':'#f3c969');if(!paused){last=performance.now();requestAnimationFrame(loop)}};if($('stop'))$('stop').onclick=stopMeasurement;$('reset').onclick=()=>resetStats(true);if($('finish'))$('finish').onclick=finishAndSave;

function stopMeasurement(){
  if(!running)return;
  running=false;
  paused=false;
  updateDisplayedStats();
  $('status').textContent='● DETENIDO';
  $('status').style.color='#9fb4bd';
  if($('pause'))$('pause').textContent='Pausar';
  updateInputStatus();
}


function spectrumLevels(offset=currentOffset()){let arr=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(arr);let sr=ctx.sampleRate, bin=sr/analyser.fftSize;return {arr,sr,bin,off:offset}}
function updateInputStatus(){const el=$('inputStatus');if(!el)return;if(!ctx){el.textContent='Entrada: esperando micrófono';el.className='input-status';return}if(running&&!measurementReady){const left=Math.max(0,STABILIZATION_SEC-stabilizationElapsed);el.textContent=`Estabilizando micrófono… ${left.toFixed(1)} s`;el.className='input-status warn';return}const ratio=totalSamples?clipSamples/totalSamples:0;const recent=lastClipAt&&performance.now()-lastClipAt<2000;if(recent||ratio>0.0005){el.textContent='Entrada: SATURACIÓN detectada';el.className='input-status clip'}else if(totalSamples>ctx.sampleRate){el.textContent='Entrada: nivel válido';el.className='input-status ok'}else{el.textContent='Entrada: verificando…';el.className='input-status warn'}}
function updateDisplayedStats(){const useSlow=$('response').value==='1';const e=useSlow?slowE:fastE;const v=e>0?10*Math.log10(e):NaN;const mn=useSlow?minSlow:minFast,mx=useSlow?maxSlow:maxFast;const leq=energyTime>0?10*Math.log10(energy/energyTime):NaN;if(Number.isFinite(v)){$('big').textContent=$('inst').textContent=v.toFixed(1);$('bar').style.width=Math.max(0,Math.min(100,(v-20)/110*100))+'%'}$('leq').textContent=Number.isFinite(leq)?leq.toFixed(1):'--.-';$('max').textContent=Number.isFinite(mx)?mx.toFixed(1):'--.-';$('min').textContent=Number.isFinite(mn)?mn.toFixed(1):'--.-'}
function loop(now){if(!running||paused)return;updateDisplayedStats();updateInputStatus();const useSlow=$('response').value==='1',e=useSlow?slowE:fastE,v=e>0?10*Math.log10(e):NaN;if(measurementReady&&Number.isFinite(v)){history.push(v);if(history.length>900)history.shift()}const sec=energyTime;$('elapsed').textContent=new Date(sec*1000).toISOString().slice(11,19);drawHistory();if(analyser)drawSpectrum(spectrumLevels());requestAnimationFrame(loop)}
function drawHistory(){resize(hist);let g=hist.getContext('2d'),w=hist.width,h=hist.height;g.clearRect(0,0,w,h);g.strokeStyle='#1c3440';g.lineWidth=1;for(let y=0;y<=5;y++){g.beginPath();g.moveTo(0,y*h/5);g.lineTo(w,y*h/5);g.stroke()}if(history.length<2)return;g.strokeStyle='#d6f23d';g.lineWidth=2*devicePixelRatio;g.beginPath();history.forEach((v,i)=>{let x=i/(history.length-1)*w,y=h-(Math.max(20,Math.min(130,v))-20)/110*h;i?g.lineTo(x,y):g.moveTo(x,y)});g.stroke()}
const oct=[31.5,63,125,250,500,1000,2000,4000,8000,16000];const third=[25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000];
function bandLevel(s,fc,frac){
  const r=2**(1/(2*frac)),lo=fc/r,hi=fc*r;
  let sum=0;
  for(let i=Math.max(1,Math.floor(lo/s.bin));i<Math.min(s.arr.length,Math.ceil(hi/s.bin));i++){
    const f=i*s.bin,db=s.arr[i]+s.off+weight(f,weighting);
    if(Number.isFinite(db))sum+=10**(db/10);
  }
  return sum>0?10*Math.log10(sum):NaN;
}
function niceBandScale(values){
  const valid=values.filter(Number.isFinite);
  if(!valid.length)return {min:20,max:80,step:10};
  let lo=Math.min(...valid),hi=Math.max(...valid);
  // Evita que una banda casi silenciosa aplaste visualmente el resto.
  const sorted=[...valid].sort((a,b)=>a-b);
  const p10=sorted[Math.floor((sorted.length-1)*.10)],p90=sorted[Math.floor((sorted.length-1)*.90)];
  if(valid.length>5){lo=Math.max(lo,p10-12);hi=Math.max(hi,p90+8)}
  let range=Math.max(30,hi-lo);
  let min=Math.floor((lo-6)/10)*10,max=Math.ceil((hi+6)/10)*10;
  if(max-min<30)max=min+30;
  min=Math.max(-20,min);max=Math.min(140,max);
  if(max-min<30)min=Math.max(-20,max-30);
  const step=(max-min)<=40?5:10;
  min=Math.floor(min/step)*step;max=Math.ceil(max/step)*step;
  return {min,max,step};
}
function renderBandYAxis(scale){
  const axis=$('bandYAxis');if(!axis)return;
  let html='';
  for(let v=scale.min;v<=scale.max+.001;v+=scale.step){
    const pct=(v-scale.min)/(scale.max-scale.min)*100;
    html+=`<span class="tick" style="bottom:${pct}%">${Math.round(v)}</span>`;
  }
  axis.innerHTML=html;
}
function formatFc(fc){return fc>=1000?`${Number((fc/1000).toFixed(fc%1000?2:0))}k`:String(fc)}
function updateFrequencyModeUI(){
  const card=document.querySelector('.spectrum-card'),fft=$('fftPanel'),bp=$('bandPanel'),info=$('bandScaleInfo'),sub=$('frequencySubtitle');
  if(card)card.dataset.view=view;
  if(fft)fft.classList.toggle('hidden',view!=='fft');
  if(bp)bp.classList.toggle('hidden',view==='fft');
  if(info)info.classList.toggle('hidden',view==='fft');
  if(sub)sub.textContent=view==='fft'?'Espectro FFT en tiempo real · escala logarítmica 20 Hz–20 kHz':view==='oct'?'Bandas de 1/1 octava · nivel por frecuencia central':'Bandas de 1/3 octava · deslice horizontalmente para recorrer todas las bandas';
}
function drawFft(s){
  resize(canv);const g=canv.getContext('2d'),w=canv.width,h=canv.height;g.clearRect(0,0,w,h);
  // Fondo y retícula discreta.
  g.strokeStyle='#17303a';g.lineWidth=1;
  for(let y=1;y<5;y++){g.beginPath();g.moveTo(0,y*h/5);g.lineTo(w,y*h/5);g.stroke()}
  const values=[];
  for(let i=1;i<s.arr.length;i++){const f=i*s.bin;if(f<20||f>20000)continue;const db=s.arr[i]+s.off+weight(f,weighting);if(Number.isFinite(db))values.push(db)}
  const sc=niceBandScale(values);
  g.strokeStyle='#d6f23d';g.lineWidth=1.6*devicePixelRatio;g.beginPath();let started=false;
  for(let i=1;i<s.arr.length;i++){
    const f=i*s.bin;if(f<20||f>20000)continue;
    const db=s.arr[i]+s.off+weight(f,weighting);if(!Number.isFinite(db))continue;
    const x=(Math.log10(f)-Math.log10(20))/(Math.log10(20000)-Math.log10(20))*w;
    const clamped=Math.max(sc.min,Math.min(sc.max,db)),y=h-(clamped-sc.min)/(sc.max-sc.min)*h;
    started?g.lineTo(x,y):g.moveTo(x,y);started=true;
  }
  g.stroke();
}
function drawBands(s){
  const list=view==='oct'?oct:third,frac=view==='oct'?1:3;
  const vals=list.map(fc=>({fc,db:bandLevel(s,fc,frac)}));
  const scale=niceBandScale(vals.map(x=>x.db));renderBandYAxis(scale);
  const container=$('bands');if(!container)return;
  container.innerHTML=vals.map(({fc,db})=>{
    const safe=Number.isFinite(db)?db:scale.min;
    const pct=Math.max(0,Math.min(100,(safe-scale.min)/(scale.max-scale.min)*100));
    const value=Number.isFinite(db)?db.toFixed(1):'--';
    return `<div class="band" title="${formatFc(fc)} Hz · ${value} dB(${weighting})"><div class="band-bar-area"><span class="band-value" style="bottom:calc(${pct}% + 7px)">${value}</span><i style="height:${pct}%"></i></div><span class="band-label">${formatFc(fc)}</span></div>`;
  }).join('');
  const info=$('bandScaleInfo');if(info)info.textContent=`Escala automática: ${scale.min} a ${scale.max} dB(${weighting}) · frecuencia central (Hz)`;
}
function drawSpectrum(s){
  updateFrequencyModeUI();
  if(view==='fft'){drawFft(s);if($('bands'))$('bands').innerHTML='';return}
  drawBands(s);
}
function boolText(v){return v===false?'desactivada':v===true?'activada':'no informado'}
function renderMicInfo(){if(!track)return;const s=track.getSettings?track.getSettings():{};const rows=[['Micrófono',track.label||'Entrada de audio'],['Sample rate',s.sampleRate?`${s.sampleRate} Hz`:(ctx?`${ctx.sampleRate} Hz`:'no informado')],['Canales',s.channelCount??'no informado'],['AGC',boolText(s.autoGainControl)],['Supresión de ruido',boolText(s.noiseSuppression)],['Cancelación de eco',boolText(s.echoCancellation)]];if($('micInfo'))$('micInfo').innerHTML=rows.map(([a,b])=>`<div><span>${a}</span><b>${b}</b></div>`).join('')}
if($('openCal'))$('openCal').onclick=()=>{const p=$('calibrationPanel');if(p){p.classList.remove('hidden');p.scrollIntoView({behavior:'smooth',block:'start'})}};if($('closeCal'))$('closeCal').onclick=()=>{const p=$('calibrationPanel');if(p)p.classList.add('hidden')};if($('referenceLevel'))$('referenceLevel').oninput=()=>{if($('refCalLevel'))$('refCalLevel').textContent=(+$('referenceLevel').value||0).toFixed(1);pendingCalibration=null;if($('saveCal'))$('saveCal').disabled=true;if($('newCalOffset'))$('newCalOffset').textContent='--.-'};
if($('sampleCal'))$('sampleCal').onclick=async()=>{try{if(!running)await start();if(paused){paused=false;last=performance.now();requestAnimationFrame(loop)}calibrationSamples=[];calibrationSampling=true;$('sampleCal').disabled=true;$('sampleCal').textContent='Midiendo…';await new Promise(r=>setTimeout(r,3000));calibrationSampling=false;const vals=calibrationSamples.filter(Number.isFinite);if(!vals.length)throw new Error('No se obtuvieron muestras válidas.');const energyMean=vals.reduce((a,v)=>a+10**(v/10),0)/vals.length;const raw=10*Math.log10(energyMean);const ref=+$('referenceLevel').value;if(!Number.isFinite(ref))throw new Error('Ingrese un nivel de referencia válido.');const off=ref-raw;pendingCalibration={offset:off,reference:ref,raw,weighting,createdAt:new Date().toISOString()};$('rawCalLevel').textContent=raw.toFixed(1);$('refCalLevel').textContent=ref.toFixed(1);$('newCalOffset').textContent=`${off>=0?'+':''}${off.toFixed(1)} dB`;$('saveCal').disabled=false}catch(e){alert(e.message)}finally{$('sampleCal').disabled=false;$('sampleCal').textContent='Medir 3 s'}};
if($('saveCal'))$('saveCal').onclick=()=>{if(!pendingCalibration)return;localStorage.setItem(CAL_KEY,JSON.stringify(pendingCalibration));pendingCalibration=null;updateCalUI();$('saveCal').disabled=true;resetStats(true);alert('Calibración guardada en este dispositivo/navegador.')};if($('clearCal'))$('clearCal').onclick=()=>{localStorage.removeItem(CAL_KEY);pendingCalibration=null;updateCalUI();$('rawCalLevel').textContent='--.-';$('newCalOffset').textContent='--.-';$('saveCal').disabled=true;resetStats(true)};
function storedSessions(){try{return JSON.parse(localStorage.getItem('slm_sessions_v1')||'[]')}catch{return []}}
function saveSessions(items){localStorage.setItem('slm_sessions_v1',JSON.stringify(items))}
function fmtDate(iso){return new Intl.DateTimeFormat('es-CL',{dateStyle:'short',timeStyle:'medium'}).format(new Date(iso))}
function fmtDuration(sec){sec=Math.max(0,Math.round(sec));let h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),ss=sec%60;return [h,m,ss].map(x=>String(x).padStart(2,'0')).join(':')}
function finishAndSave(){const useSlow=$('response').value==='1',mn=useSlow?minSlow:minFast,mx=useSlow?maxSlow:maxFast;if(!energyTime||!Number.isFinite(mn)||!Number.isFinite(mx)){alert('Primero inicia una medición válida.');return}if(running)stopMeasurement();const leq=10*Math.log10(energy/energyTime), ended=new Date(),cal=getCalibration();const item={id:Date.now(),startedAt:(sessionStartedAt||ended).toISOString(),endedAt:ended.toISOString(),duration:energyTime,weighting,response:useSlow?'SLOW':'FAST',leq:+leq.toFixed(1),max:+mx.toFixed(1),min:+mn.toFixed(1),calibrated:!!cal,calOffset:currentOffset(),clipping:clipSamples>0,clipRatio:totalSamples?clipSamples/totalSamples:0};const items=storedSessions();items.unshift(item);saveSessions(items.slice(0,100));running=false;paused=false;$('status').textContent='● GUARDADO';$('status').style.color='#7bd7a6';renderSessions()}
function deleteSession(id){saveSessions(storedSessions().filter(x=>x.id!==id));renderSessions()}
function renderSessions(){const items=storedSessions(), list=$('sessionList'), empty=$('noSessions');if(!list)return;empty.style.display=items.length?'none':'block';list.innerHTML=items.map(x=>{let p=x.weighting;return `<article class="session"><div class="session-head"><div><b>${fmtDate(x.startedAt)}</b><span>${fmtDuration(x.duration)} · ${p} · ${x.response} · ${x.calibrated?'calibrado':'sin calibrar'}${x.clipping?' · saturación detectada':''}</span></div><button class="delete-session" data-id="${x.id}" aria-label="Eliminar medición">Eliminar</button></div><div class="session-values"><div><strong>${x.leq.toFixed(1)}</strong><span>L${p}eq,T · dB(${p})</span></div><div><strong>${x.max.toFixed(1)}</strong><span>L${p}${x.response==='SLOW'?'S':'F'}max · dB(${p})</span></div><div><strong>${x.min.toFixed(1)}</strong><span>L${p}${x.response==='SLOW'?'S':'F'}min · dB(${p})</span></div></div></article>`}).join('');list.querySelectorAll('.delete-session').forEach(b=>b.onclick=()=>deleteSession(+b.dataset.id))}
if($('clearSessions'))$('clearSessions').onclick=()=>{if(storedSessions().length&&confirm('¿Borrar todas las mediciones guardadas en este dispositivo?')){saveSessions([]);renderSessions()}};
label();updateCalUI();renderSessions();updateInputStatus();resize(hist);resize(canv);
