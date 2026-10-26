import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../store.mjs';
import {runSession, elapsedSeconds, parseQuickRun} from '../run-session.mjs';
import {dataDirectory, saveSettings} from '../config.mjs';
import {parseActivityImport} from '../activity.mjs';
import {createTelegramConnection} from '../telegram-connection.mjs';
import {createBotHandler} from '../telegram.mjs';
import {createApp} from '../server.mjs';

async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runlog-reliability-'));
  const store = await createStore(dir);
  try { await run(store, dir); }
  finally { store.close(); await rm(dir, {recursive:true, force:true}); }
}
test('timer survives restart, excludes pauses and cannot start over unfinished run', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runlog-timer-'));
  let store = await createStore(dir);
  try {
    runSession(store, 'start', {now:10000, date:'2026-10-26'});
    assert.throws(() => runSession(store, 'start'), /незавершённая/);
    runSession(store, 'pause', {now:70000});
    store.close(); store = await createStore(dir);
    assert.equal(elapsedSeconds(store.getSetting('active_run'), 150000), 60);
    runSession(store, 'resume', {now:180000});
    const finished = runSession(store, 'finish', {now:210000});
    assert.equal(finished.durationSeconds, 90);
    assert.equal(elapsedSeconds(finished, 900000), 90);
    assert.equal(runSession(store, 'finish', {now:999000}).durationSeconds, 90);
  } finally { store.close(); await rm(dir, {recursive:true, force:true}); }
});
test('quick log parses explicit minutes and hours and rejects invalid seconds', () => {
  assert.equal(parseQuickRun('/log 3,2 24:30', '2026-10-26').durationSeconds, 1470);
  assert.equal(parseQuickRun('/log 10 1:05:00', '2026-10-26').durationSeconds, 3900);
  assert.throws(() => parseQuickRun('/log 3 24:99', '2026-10-26'));
  assert.throws(() => parseQuickRun('/log 3 1:99:00', '2026-10-26'));
});
test('settings preserve unrelated values and Unicode paths round-trip through dotenv', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runlog-config-'));
  try {
    const file = path.join(dir, '.env');
    await saveSettings({RUNLOG_DATA_DIR:'/tmp/бег', EXISTING:'retained'}, file);
    await saveSettings({TELEGRAM_BOT_USERNAME:'runlog_test'}, file);
    const text = await readFile(file, 'utf8');
    assert.match(text, /\/tmp\/бег/);
    assert.match(text, /EXISTING="retained"/);
    assert.equal(dataDirectory('/tmp/\\u0431\\u0435\\u0433'), '/tmp/бег');
  } finally { await rm(dir, {recursive:true, force:true}); }
});
function columns(extra={}) {
  return JSON.stringify({format:'runlog-health-v2', generatedAt:'2026-10-26T19:00:00+07:00', sampleLimit:'2000',
    stepsCount:'2', steps_start:'2026-10-26T12:00:00+07:00\n2026-10-26T12:10:00+07:00',
    steps_end:'2026-10-26T12:05:00+07:00\n2026-10-26T12:15:00+07:00', steps_value:'300\n500', steps_unit:'count\ncount', steps_source:'iPhone\niPhone',
    distanceCount:'0', distance_start:'',distance_end:'',distance_value:'',distance_unit:'',distance_source:'',...extra});
}
test('bulk Health export retains values; truncation and column mismatch are rejected', () => {
  const options = {now:new Date('2026-10-26T20:00:00+07:00')};
  assert.equal(parseActivityImport(columns(), options).rows[0].steps, 800);
  assert.throws(() => parseActivityImport(columns({stepsCount:'2000'}), options), /лимита/);
  assert.throws(() => parseActivityImport(columns({steps_value:'300'}), options), /не совпало/);
  assert.throws(() => parseActivityImport(columns({steps_source:'iPhone\nWatch\nOther'}), options), /не совпало/);
});
test('Health import confirmation is atomic and never adds a snapshot twice', async () => fixture(async store => {
  const batch = parseActivityImport(columns(), {now:new Date('2026-10-26T20:00:00+07:00')});
  const draft = store.createDraft('web', {kind:'activity', batch});
  assert.equal(store.listActivity().length, 0);
  assert.equal(store.confirmDraft(draft.id,'web').imported, 1);
  assert.equal(store.confirmDraft(draft.id,'web').alreadySaved, true);
  assert.equal(store.listActivity()[0].steps, 800);
}));
test('Telegram run records event time rather than delayed processing; save needs approval', async () => fixture(async (store, dir) => {
  const sent=[];
  const api={send:async(...args)=>sent.push(args),call:async()=>{}};
  const handle=createBotHandler({api,store,ownerId:'123',directory:dir,today:()=> '2026-10-26',now:()=> 9000000});
  const msg=(id,text,date)=>({update_id:id,message:{date,from:{id:123},chat:{id:123,type:'private'},text}});
  await handle(msg(1,'/run',1000));
  await handle(msg(2,'/finish',2200));
  assert.equal(elapsedSeconds(store.getSetting('active_run')),1200);
  await handle(msg(3,'3,2',2201));
  assert.equal(store.listWorkouts().length,0);
  const callback=sent.at(-1)[2].inline_keyboard[0][0].callback_data;
  await handle({update_id:4,callback_query:{id:'test',data:callback,from:{id:123},message:{message_id:5,chat:{id:123,type:'private'}}}});
  assert.equal(store.listWorkouts()[0].durationSeconds,1200);
  assert.equal(store.listWorkouts()[0].distanceKm,3.2);
  assert.equal(store.getSetting('active_run'),null);
}));
test('pairing ignores public /start and persists only account proving the one-time secret', async () => {
  const prior = Object.fromEntries(['TELEGRAM_BOT_TOKEN','TELEGRAM_OWNER_ID','TELEGRAM_BOT_USERNAME'].map(k=>[k,process.env[k]]));
  for(const k of Object.keys(prior)) delete process.env[k];
  let release, persisted, running=false;
  const first = new Promise(resolve=> {release=resolve;});
  let polls=0;
  const api={call:async(method)=> {
    if(method==='getMe') return {username:'runlog_test'};
    if(method==='getWebhookInfo') return {url:''};
    if(method==='getUpdates' && polls++===0) return [{update_id:1,message:{from:{id:999},chat:{id:999,type:'private'},text:'/start'}}];
    if(method==='getUpdates') return first;
  },send:async()=>{}};
  const connection=createTelegramConnection({apiFactory:()=>api,persist:async values=>{persisted=values;}, launch:async ({signal,onReady})=> {
    running=true; onReady({username:'runlog_test'});
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  }});
  try {
    const result=await connection.pair('12345:abcdefghijklmnopqrstuvwxyz');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(persisted,undefined);
    const challenge=new URL(result.url).searchParams.get('start');
    release([{update_id:2,message:{from:{id:123},chat:{id:123,type:'private'},text:'/start '+challenge}}]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(persisted.TELEGRAM_OWNER_ID,'123');
    assert.equal(running,true);
    assert.equal(connection.state.status,'connected');
    assert.equal(JSON.stringify(connection.state).includes('abcdefghijklmnopqrstuvwxyz'),false);
  } finally {
    await connection.stop();
    for(const [key,value] of Object.entries(prior)) if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
test('web timer finishes into a confirmed workout and Health import accepts v2', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'runlog-web-'));
  const app=await createApp({dataDir:dir,syncFile:[],telegram:false});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  try {
    const status=await (await fetch(base+'/api/status')).json();
    const post=async(url,body)=>{
      const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Diary-Token':status.token},body:JSON.stringify(body)});
      const data=await response.json(); assert.ok(response.ok,data.error);return data;
    };
    const started=await post('/api/run',{action:'start'});
    await post('/api/run',{action:'finish'});
    await post('/api/workouts',{date:status.today,sport:'run',distanceKm:3,durationSeconds:1200,runSessionId:started.session.id});
    assert.equal(app.store.getSetting('active_run'),null);
    const draft=await post('/api/import',{text:columns().replaceAll('2026-10-26','2020-10-26'),filename:'runlog-health.json'});
    assert.equal(draft.kind,'activity');
    await post(`/api/imports/${draft.id}/confirm`,{});
    assert.equal(app.store.listActivity()[0].steps,800);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('OCR never turns pace or unlabeled figures into workout duration; conflicting values stay empty', async () => {
  const {parseRecognizedText}=await import('../ocr.mjs');
  const lines=texts=>texts.map(text=>({text,confidence:1}));
  const d=parseRecognizedText(lines(['Distance: 3.20 km','Duration: 24:30','Date: 2026-10-26']));
  assert.equal(d.distanceKm,3.2);assert.equal(d.durationSeconds,1470);assert.equal(d.date,'2026-10-26');
  const missing=parseRecognizedText(lines(['PACE 5:20 /km','Speed 10.5','280 calories']));
  assert.equal(missing.durationSeconds,null);assert.equal(missing.distanceKm,null);
  assert.equal(parseRecognizedText(lines(['Дистанция: 2,5 км','Время: 20:00'])).distanceKm,2.5);
  const ambiguous=parseRecognizedText(lines(['Distance: 3 km','Distance: 4 km','Duration: 20:00','Duration: 30:00']));
  assert.equal(ambiguous.distanceKm,null);assert.equal(ambiguous.durationSeconds,null);assert.ok(ambiguous.warnings.length);
});

test('model quota errors fail fast instead of hanging through CLI retries', async () => {
  const {callCodex}=await import('../agent.mjs');
  const {writeFile,chmod}=await import('node:fs/promises');
  const dir=await mkdtemp(path.join(os.tmpdir(),'runlog-quota-'));
  try {
    const fake=path.join(dir,'fake-codex');
    await writeFile(fake,'#!/usr/bin/env node\nprocess.stderr.write("429 Too Many Requests\\n");setTimeout(()=>{},30000);\n');
    await chmod(fake,0o700);
    const started=Date.now();
    await assert.rejects(callCodex({prompt:'test',directory:dir,binary:fake,timeoutMs:5000}),/лимит запросов/);
    assert.ok(Date.now()-started<3000);
  } finally {await rm(dir,{recursive:true,force:true});}
});
