// Isolated Edge smoke test. Uses generated media and never opens the user's data.
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, utimes, writeFile, readFile, stat, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { createServer as createHTTPServer } from 'node:http'

const root = resolve(import.meta.dirname, '..')
await mkdir(join(root, '.navora-dev-data'), { recursive: true })
const data = await mkdtemp(join(root, '.navora-dev-data', 'smoke-'))
const freePort = () => new Promise((done) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)) })
})
const port = await freePort(), debugPort = await freePort()
const base = `http://127.0.0.1:${port}`
const password = randomBytes(24).toString('hex')
const ffmpeg = resolve(root, 'vendor/ffmpeg/win-x64/ffmpeg.exe')
const recording = join(data, 'recordings', 'smoke')
await mkdir(recording, { recursive: true })
await writeFile(join(data, 'settings.json'), JSON.stringify({
  recordingsPath: join(data, 'recordings'), savedClipsPath: join(data, 'saved'),
  snapshotsPath: join(data, 'snapshots'), recordCacheEnabled: false,
  remoteEnabled: false, remotePassword: password, ffmpegPath: ffmpeg,
}))
await writeFile(join(data, 'channels.json'), JSON.stringify({version: 1, channels: [{
  id: 'smoke', name: '回放验证', url: 'rtsp://127.0.0.1:1/synthetic', enabled: false, segmentTimeSec: 10,
}]}))
const run = (bin, args) => new Promise((done, fail) => {
  const child = spawn(bin, args, { cwd: root, windowsHide: true, stdio: 'ignore' })
  child.once('error', fail); child.once('exit', code => code === 0 ? done() : fail(new Error(`${bin}: exit ${code}`)))
})
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
  'testsrc2=size=640x360:rate=25', '-t', '8', '-c:v', 'libx264', '-g', '25',
  join(recording, 'smoke-20261012-080000.ts')])
const savedDir = join(data, 'saved', 'smoke')
await mkdir(savedDir, {recursive:true})
const savedFirst = 'clip-20261011-235958-1111111111111111.mp4', savedSecond = 'clip-20261012-000000-2222222222222222.mp4'
await run(ffmpeg, ['-hide_banner','-loglevel','error','-i',join(recording,'smoke-20261012-080000.ts'),'-c','copy','-movflags','+faststart',join(savedDir,savedFirst)])
await copyFile(join(savedDir,savedFirst),join(savedDir,savedSecond))
const server = spawn('go', ['-C', 'server', 'run', './cmd/navora', '--data', data, '--port', String(port)], {
  cwd: root, windowsHide: true, stdio: 'ignore',
})
let browser, socket, cookie, fixtureServer
const feeders = new Set()
const pause = ms => new Promise(done => setTimeout(done, ms))
async function poll(fn, timeout = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { try { const result = await fn(); if (result) return result } catch {} await pause(100) }
  throw new Error('Smoke test timed out')
}
try {
  await poll(async () => (await fetch(`${base}/api/status`)).ok)
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({username:'navora', password}) })
  if (!login.ok) throw new Error('Isolated login failed')
  cookie = login.headers.get('set-cookie').split(';')[0]
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(data, 'edge')}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' })
  const targets = await poll(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json())
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
  let id = 0
  const pending = new Map(), errors = []
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    const task = pending.get(message.id)
    if (task) { pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result) }
  }
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id; pending.set(key, {resolve,reject}); socket.send(JSON.stringify({id:key,method,params}))
  })
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true})
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  await cdp('Runtime.enable')
  await cdp('Network.enable')
  await cdp('Network.setCookie', {name:'nm_session', value:cookie.split('=')[1], url:base, httpOnly:true})
  await cdp('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await cdp('Page.navigate', {url:base})
  await poll(() => evaluate(`Boolean(window.navoraMonitor && document.querySelector('.login-screen') === null && document.querySelector('button'))`))
  await poll(() => evaluate(`document.body.innerText.includes('通道 1')`))
  const initialPlaybackAssets = await evaluate(`performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>{const file=new URL(name).pathname.split('/').at(-1);return file.startsWith('hls-')||file.startsWith('PlaybackView-')})`)
  if(initialPlaybackAssets.length) throw Error('Playback assets loaded before playback was opened: '+JSON.stringify(initialPlaybackAssets))
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='回放').click()`)
  await poll(() => evaluate(`Boolean(document.querySelector('input[type="time"]'))`))
  await evaluate(`(() => { const input=document.querySelector('input[type="time"]'); input.value='08:00:03';
    input.dispatchEvent(new Event('input',{bubbles:true})); input.closest('form').requestSubmit(); })()`)
  await poll(() => evaluate(`Array.from(document.querySelectorAll('video')).some(v => v.videoWidth===640 && v.currentTime >= 2.8 && v.getVideoPlaybackQuality().totalVideoFrames>1)`))
  await poll(()=>evaluate(`!document.querySelector('.playback .playback-feedback') && !document.querySelector('.playback video').paused`))
  await evaluate(`document.querySelector('.playback .play-toggle').click()`)
  await poll(()=>evaluate(`document.querySelector('.playback video').paused`))
  const zoomBefore = await evaluate(`(() => {const v=document.querySelector('.playback video'),r=document.querySelector('.playback .stage').getBoundingClientRect();return {src:v.src,x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await evaluate(`document.querySelector('.playback video').dispatchEvent(new WheelEvent('wheel',{deltaY:-400,clientX:${zoomBefore.x},clientY:${zoomBefore.y},bubbles:true,cancelable:true}))`)
  await poll(()=>evaluate(`document.querySelector('.playback video').style.transform.includes('scale(2.')`))
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:zoomBefore.x,y:zoomBefore.y,button:'left',clickCount:1})
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:zoomBefore.x+40,y:zoomBefore.y+20,button:'left',buttons:1})
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:zoomBefore.x+40,y:zoomBefore.y+20,button:'left',clickCount:1})
  const zoomDragged=await evaluate(`(() => {const v=document.querySelector('.playback video');return {paused:v.paused,src:v.src,transform:v.style.transform,hit:document.elementFromPoint(${zoomBefore.x},${zoomBefore.y})?.outerHTML.slice(0,350),point:${JSON.stringify(zoomBefore)}}})()`)
  if(!zoomDragged.paused || zoomDragged.src!==zoomBefore.src || !zoomDragged.transform.includes('translate(40px, 20px)')) throw Error('Playback zoom drag changed playback state or failed to pan: '+JSON.stringify(zoomDragged))
  await evaluate(`document.querySelector('.playback .zoom-controls button[title]').click()`)
  if(!await evaluate(`document.querySelector('.playback video').style.transform==='translate(0px, 0px) scale(1)'`)) throw Error('Playback zoom reset failed')
  await evaluate(`document.querySelector('.playback .play-toggle').click()`)
  await evaluate(`document.querySelector('.settings-btn').click()`)
  await poll(() => evaluate(`Boolean(document.querySelector('[role="dialog"] [role="radio"]'))`))
  await pause(200)
  const focused = await evaluate(`document.querySelector('[role="dialog"]').contains(document.activeElement)`)
  if (!focused) throw new Error('Settings did not receive focus')
  await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>b.textContent.trim()==='深色').click()`)
  await cdp('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27})
  await cdp('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27})
  await poll(() => evaluate(`document.body.innerText.includes('有尚未保存的设置')`))
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='放弃修改并关闭').click()`)
  await poll(() => evaluate(`!document.querySelector('[role="dialog"]')`))
  await poll(async () => {
    const segments = await (await fetch(`${base}/api/recordings?channelId=smoke`, {headers:{Cookie:cookie}})).json()
    return segments.length === 1 && segments[0].endMs-segments[0].startMs === 8000
  })
  await poll(() => evaluate(`Array.from(document.querySelectorAll('.block[title]')).some(el => el.title.includes('08:00:08'))`))
  const second = join(recording, 'smoke-20261012-080008.ts')
  await copyFile(join(recording, 'smoke-20261012-080000.ts'), second)
  const secondEnd = new Date('2026-10-12T08:00:16')
  await utimes(second, secondEnd, secondEnd)
  await poll(() => evaluate(`Number(document.querySelector('.timeline').dataset.segmentCount) === 2`))
  const firstSource = await evaluate(`Array.from(document.querySelectorAll('video')).find(v=>v.videoWidth===640).src`)
  await evaluate(`(() => { const input=document.querySelector('input[type="time"]'); input.value='08:00:07';
    input.dispatchEvent(new Event('input',{bubbles:true})); input.closest('form').requestSubmit(); })()`)
  await poll(() => evaluate(`Array.from(document.querySelectorAll('video')).some(v => v.src !== ${JSON.stringify(firstSource)} && v.videoWidth===640 && v.currentTime > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 1)`))
  const desktop = await cdp('Page.captureScreenshot', {format:'png'})
  await evaluate(`document.querySelector('.status .disk').click()`)
  await poll(() => evaluate(`Boolean(document.querySelector('#storage-sense-card .storage-summary'))`))
  const storageCard = await evaluate(`(() => { const card=document.querySelector('#storage-sense-card'), r=card.getBoundingClientRect(), footer=document.querySelector('footer.status').getBoundingClientRect(); return {text:card.innerText,x:r.x,right:r.right,bottom:r.bottom,footerTop:footer.top,width:innerWidth}; })()`)
  if(storageCard.x<0 || storageCard.right>storageCard.width || storageCard.bottom>storageCard.footerTop || !storageCard.text.includes('约可再录') || !storageCard.text.includes('磁盘占用')) throw Error('Storage card content or position invalid: '+JSON.stringify(storageCard))
  await pause(250)
  await writeFile(join(data,'storage-card.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'))
  await evaluate(`document.querySelector('.status .disk').click()`)
  if(await evaluate(`Boolean(document.querySelector('#storage-sense-card'))`)) throw Error('Storage trigger did not close card')
  await evaluate(`document.querySelector('.status .disk').click()`)
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:500,y:100,button:'left',clickCount:1})
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:500,y:100,button:'left',clickCount:1})
  await poll(() => evaluate(`!document.querySelector('#storage-sense-card')`))
  await evaluate(`document.querySelector('.timeline .block').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:780}))`)
  await poll(() => evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(b=>b.textContent==='下载片段'&&!b.disabled)`))
  const downloaded = await evaluate(`(() => {const click=HTMLAnchorElement.prototype.click;let result;HTMLAnchorElement.prototype.click=function(){result={href:this.href,name:this.download}};try{Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent==='下载片段').click()}finally{HTMLAnchorElement.prototype.click=click}return result})()`)
  if(!downloaded?.name || !downloaded.href.includes('/media/files/recordings/smoke/') || !downloaded.href.endsWith('?download=1')) throw Error('Download action did not target a recording')
  const downloadResponse=await fetch(downloaded.href,{headers:{Cookie:cookie}})
  if(!downloadResponse.ok || !downloadResponse.headers.get('content-disposition')?.includes('attachment')) throw Error('Download response was not a file attachment')
  const sourceBytes=await readFile(join(recording,downloaded.name))
  if(!Buffer.from(await downloadResponse.arrayBuffer()).equals(sourceBytes)) throw Error('Download changed recording bytes')
  await cdp('Runtime.evaluate',{expression:`document.querySelector('.timeline').parentElement.requestFullscreen()`,awaitPromise:true,userGesture:true})
  await poll(() => evaluate(`Boolean(document.fullscreenElement)`))
  await pause(250)
  await evaluate(`document.querySelector('.timeline .block').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:400}))`)
  await poll(() => evaluate(`Boolean(document.fullscreenElement.querySelector('.ctx-menu'))`))
  if(!await evaluate(`(() => {const menu=document.querySelector('.ctx-menu'),r=menu.getBoundingClientRect();return r.width>0&&r.bottom<=innerHeight&&menu.contains(document.elementFromPoint(r.x+12,r.y+12))})()`)) throw Error('Fullscreen menu is obscured or outside the viewport')
  await evaluate(`document.exitFullscreen()`)
  await poll(() => evaluate(`!document.fullscreenElement && !document.querySelector('.ctx-menu')`))
  await evaluate(`document.querySelector('.status .disk').click()`)
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await poll(() => evaluate(`!document.querySelector('#storage-sense-card')`))
  await writeFile(join(data, 'desktop.png'), Buffer.from(desktop.data,'base64'))
  await evaluate(`(() => {
    document.querySelectorAll('video').forEach(v=>v.pause());
    const button=Array.from(document.querySelectorAll('.timeline button')).find(b=>b.textContent.trim()==='跟随播放');
    if(button) button.click();
  })()`)
  await pause(100)
  const beforeZoom = await evaluate(`(() => { const el=document.querySelector('.timeline .viewport'), r=el.getBoundingClientRect();
    const x=Math.trunc(r.left+r.width*.7); return {center:+el.dataset.center,scale:+el.dataset.scale,width:el.clientWidth,anchor:x-r.left-el.clientWidth*.5,x,y:r.top+20}; })()`)
  await evaluate(`(() => {const el=document.querySelector('.timeline .viewport');
    for(let i=0;i<12;i++)el.dispatchEvent(new WheelEvent('wheel',{deltaY:-3,clientX:${beforeZoom.x},clientY:${beforeZoom.y},bubbles:true,cancelable:true}));})()`)
  await pause(600)
  const afterZoom = await evaluate(`(() => {const el=document.querySelector('.timeline .viewport');return {center:+el.dataset.center,scale:+el.dataset.scale};})()`)
  const offset = beforeZoom.anchor
  if(Math.abs(beforeZoom.center+offset/beforeZoom.scale-afterZoom.center-offset/afterZoom.scale)>5) throw new Error('Timeline zoom moved pointer time: '+JSON.stringify({beforeZoom,afterZoom}))
  for(const direction of [-1,1]) {
    await evaluate(`(() => {const el=document.querySelector('.timeline .viewport');
      for(let i=0;i<80;i++)el.dispatchEvent(new WheelEvent('wheel',{deltaY:${direction*240},clientX:${beforeZoom.x},clientY:${beforeZoom.y},bubbles:true,cancelable:true}));})()`)
    await pause(800)
    const span = await evaluate(`(() => {const el=document.querySelector('.timeline .viewport');return el.clientWidth/+el.dataset.scale;})()`)
    if(span<4999 || span>604800001) throw new Error('Timeline zoom exceeded bounds: '+span)
    const ticks = await evaluate(`document.querySelectorAll('.timeline .tick').length`)
    if(ticks<2 || ticks>320) throw new Error('Timeline visible ticks missing or unbounded')
  }
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='实时').click()`)
  await poll(() => evaluate(`Boolean(Array.from(document.querySelectorAll('.timeline button')).find(b=>b.textContent.trim()==='跟随实时'))`))
  const liveBefore = await evaluate(`+document.querySelector('.timeline .viewport').dataset.center`)
  await pause(1300)
  const liveAfter = await evaluate(`+document.querySelector('.timeline .viewport').dataset.center`)
  if(liveAfter-liveBefore<500) throw new Error('Realtime timeline did not follow the clock')
  for(const deltaY of [-240,240,-240]) {
    const point=await evaluate(`(() => {const r=document.querySelector('.timeline .viewport').getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()`)
    for(let step=0;step<32;step++) await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:0,deltaY})
    await pause(450)
    const alignment=await evaluate(`(() => {const v=document.querySelector('.timeline .viewport'),r=v.getBoundingClientRect(),center=+v.dataset.center,scale=+v.dataset.scale;
      return {clockError:Math.abs(center-Date.now()),span:r.width/scale,ticks:Array.from(document.querySelectorAll('.timeline .tick[data-wall-ms]')).map(t=>Math.abs(t.getBoundingClientRect().left-(r.left+v.clientWidth/2+(+t.dataset.wallMs-center)*scale)))};})()`)
    if(alignment.clockError>250 || alignment.ticks.some(error=>error>2)) throw new Error('Live zoom cursor/ruler misaligned: '+JSON.stringify(alignment))
  }
  await evaluate(`Array.from(document.querySelectorAll('.timeline [role="tab"]')).find(b=>b.textContent.includes('已保存')).click()`)
  await poll(() => evaluate(`Boolean(document.querySelector('.saved-picker') && document.querySelectorAll('.timeline .block').length===2)`))
  const savedCenterBefore = await evaluate(`+document.querySelector('.timeline .viewport').dataset.center`)
  await pause(1100)
  const savedCenterAfter = await evaluate(`+document.querySelector('.timeline .viewport').dataset.center`)
  if(Math.abs(savedCenterAfter-savedCenterBefore)>1) throw new Error('Saved timeline was pulled to realtime')
  await evaluate(`(() => {const el=document.querySelector('.timeline .day');el.value='2026-10-11';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await poll(() => evaluate(`document.querySelectorAll('.timeline .block').length===1`))
  await evaluate(`(() => {const el=document.querySelector('.timeline .day');el.value='2026-10-12';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await poll(() => evaluate(`document.querySelectorAll('.timeline .block').length===2`))
  await evaluate(`(() => {const el=document.querySelector('.saved-picker'); el.value='smoke/${savedFirst}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await poll(() => evaluate(`Array.from(document.querySelectorAll('video')).some(v=>v.src.includes(${JSON.stringify(savedFirst)}) && v.videoWidth===640 && v.currentTime>.2)`))
  await evaluate(`(() => {const el=document.querySelector('.saved-picker'); el.value='smoke/${savedSecond}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await poll(() => evaluate(`Array.from(document.querySelectorAll('video')).some(v=>v.src.includes(${JSON.stringify(savedSecond)}) && v.videoWidth===640 && v.currentTime>.2)`))
  await evaluate(`(() => {const input=document.querySelector('input[type="time"]');input.value='00:00:03';input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').requestSubmit();})()`)
  try { await poll(() => evaluate(`Array.from(document.querySelectorAll('video')).some(v=>v.src.includes(${JSON.stringify(savedSecond)}) && v.currentTime>=2.8 && v.currentTime<5)`)) }
  catch(error) {
    const state=await evaluate(`({videos:Array.from(document.querySelectorAll('video')).map(v=>({src:v.src,time:v.currentTime,paused:v.paused,error:v.error?.message})),day:document.querySelector('.timeline .day').value,timeline:document.querySelector('.timeline').innerText,playback:document.querySelector('.playback')?.innerText})`)
    throw new Error(error.message+' saved jump: '+JSON.stringify(state))
  }
  await evaluate(`(() => {const el=document.querySelector('.saved-picker');el.value='smoke/${savedFirst}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await poll(() => evaluate(`Array.from(document.querySelectorAll('video')).some(v=>v.src.includes(${JSON.stringify(savedFirst)}) && v.currentTime>.2)`))
  await evaluate(`Array.from(document.querySelectorAll('video')).find(v=>v.src.includes(${JSON.stringify(savedFirst)})).currentTime=7.7`)
  await poll(() => evaluate(`Array.from(document.querySelectorAll('video')).some(v=>v.src.includes(${JSON.stringify(savedSecond)}) && v.currentTime>.2)`))
  let savedResponse
  try { await poll(async () => {
    savedResponse=await (await fetch(`${base}/api/saved-clips?channelId=smoke`,{headers:{Cookie:cookie}})).json()
    return Array.isArray(savedResponse) && savedResponse.length===2 && savedResponse.every(s=>Math.abs(s.endMs-s.startMs-8000)<100)
  }) } catch(error) { throw new Error(error.message+' saved metadata: '+JSON.stringify(savedResponse)) }
  await pause(1500)
  const followed = await evaluate(`(() => { const v=Array.from(document.querySelectorAll('video')).find(v=>v.src.includes(${JSON.stringify(savedSecond)}));
    return {wall:+document.querySelector('.timeline .viewport').dataset.center,media:v.currentTime}; })()`)
  const savedStart = savedResponse.find(clip=>clip.fileName===savedSecond).startMs
  if(Math.abs(followed.wall-savedStart-followed.media*1000)>500) throw new Error('Saved timeline did not follow the selected file clock: '+JSON.stringify({followed,savedStart,state:await evaluate(`document.querySelector('.timeline').innerText`)}))
  await evaluate(`document.querySelector('[aria-label="上一录像段"]').click()`)
  await poll(()=>evaluate(`Array.from(document.querySelectorAll('video')).some(v=>v.src.includes(${JSON.stringify(savedFirst)})&&v.currentTime>.2)`))
  await evaluate(`document.querySelector('[aria-label="下一录像段"]').click()`)
  await poll(()=>evaluate(`Array.from(document.querySelectorAll('video')).some(v=>v.src.includes(${JSON.stringify(savedSecond)})&&v.currentTime>.2)`))
  if(!await evaluate(`document.querySelector('[aria-label="下一录像段"]').disabled`)) throw new Error('Next segment remained enabled at the end')
  const savedScreenshot = await cdp('Page.captureScreenshot',{format:'png'})
  await writeFile(join(data,'saved.png'),Buffer.from(savedScreenshot.data,'base64'))
  const media = await evaluate(`(async () => {
    const response = await fetch('/api/playback/prepare', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({channelId:'smoke',fileName:'smoke-20261012-080000.ts',kind:'recordings'})});
    const result = await response.json(); if (!result.ok) throw Error(result.error);
    const video = document.createElement('video'); video.muted=true; video.src=result.url; document.body.append(video);
    await new Promise((done,fail) => {video.onloadedmetadata=done; video.onerror=fail});
    await video.play(); await new Promise(done => video.requestVideoFrameCallback(done));
    video.currentTime=5; await new Promise(done => video.onseeked=done);
    await new Promise(done => video.requestVideoFrameCallback(done));
    const info={duration:video.duration,currentTime:video.currentTime,width:video.videoWidth,
      decodedFrames:video.getVideoPlaybackQuality().totalVideoFrames}; video.remove(); return info;
  })()`)
  if (media.width !== 640 || media.currentTime < 5 || media.decodedFrames < 2) throw new Error('No decoded frames after seek')
  if(!await evaluate(`document.querySelector('.timeline .day').type==='date'`)) throw new Error('Playback date is not a calendar input')
  if (process.env.NAVORA_BROWSER_AUDIT === '1') {
    const snapshots = []
    const inspect = async (name) => {
      await pause(250)
      const layout = await evaluate(`(() => {
        const rect = el => {const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}}
        const visible = el => {const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'}
        const controls = Array.from(document.querySelectorAll('button,input,select,[role="slider"]')).filter(visible).map(el=>{
          let opacity=1;for(let p=el;p;p=p.parentElement) opacity*=Number(getComputedStyle(p).opacity)
          const style=getComputedStyle(el);return {name:el.getAttribute('aria-label')||el.title||el.textContent.trim().slice(0,60)||el.type,
          tag:el.tagName,disabled:el.disabled,rect:rect(el),color:style.color,background:style.backgroundColor,opacity}
        });return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,controls,
          timelinePanel:rect(document.querySelector('.timeline')),timelineHeader:rect(document.querySelector('.timeline .head')),timelineSources:rect(document.querySelector('.timeline .head-left')),timelineActions:rect(document.querySelector('.timeline .actions')),
          timeline:document.querySelector('.timeline')?.innerText,viewport:document.querySelector('.timeline .viewport') ? {...rect(document.querySelector('.timeline .viewport')),scale:+document.querySelector('.timeline .viewport').dataset.scale}:null,playback:document.querySelector('.playback')?.innerText,
          dialog:document.querySelector('[role="dialog"]')?.innerText}
      })()`)
      const shot=await cdp('Page.captureScreenshot',{format:'png'})
      await writeFile(join(data,`${name}.png`),Buffer.from(shot.data,'base64'))
      snapshots.push({name,...layout})
      const a=layout.timelineSources,b=layout.timelineActions,h=layout.timelineHeader
      if(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1 && Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>1) throw new Error('Timeline tools overlap source tabs: '+name)
      if(b.x<h.x-1 || b.x+b.w>h.x+h.w+1 || a.x<h.x-1 || a.x+a.w>h.x+h.w+1) throw new Error('Timeline header extends beyond panel: '+name)
      if(layout.viewport && (layout.viewport.y+layout.viewport.h>layout.timelinePanel.y+layout.timelinePanel.h+1 || layout.viewport.h<24)) throw new Error('Timeline tools displaced the track out of the panel: '+name)
      if(layout.viewport && (layout.viewport.w/layout.viewport.scale < 4990 || layout.viewport.w/layout.viewport.scale > 604800100)) throw new Error('Resize broke timeline zoom bounds: '+name)
      if(name.endsWith('-360') || name.endsWith('-390')) {
        const primary=layout.controls.filter(c=>['上一录像段','下一录像段','跳转'].includes(c.name))
        if(primary.some(c=>c.rect.x<0 || c.rect.x+c.rect.w>layout.width || c.rect.h<44)) throw new Error('Mobile primary controls are clipped or too small: '+name)

      }
    }
    for(const theme of ['light','dark']) {
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      for(const width of [1920,1440,1280,1100,1024,900,768,390,360]) {
        await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<768})
        await inspect(`${theme}-${width}`)
      }
    }
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
    await pause(300)
    await evaluate(`document.querySelector('.settings-btn').click()`)
    await poll(()=>evaluate(`Boolean(document.querySelector('[role="dialog"]'))`))
    for(const width of [360,768,1440]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<768})
      const categories=await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] .nav-item')).map(el=>el.textContent.trim())`)
      for(let index=0;index<categories.length;index++) {
        await evaluate(`document.querySelectorAll('[role="dialog"] .nav-item')[${index}].click()`)
        await inspect(`settings-${width}-${index}`)
      }
    }
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await evaluate(`document.querySelector('.saved-picker').value='smoke/${savedSecond}';document.querySelector('.saved-picker').dispatchEvent(new Event('change',{bubbles:true}))`)
    await poll(()=>evaluate(`Boolean(document.querySelector('.playback video') && !document.querySelector('.playback video').paused)`))
    await evaluate(`document.querySelector('.saved-picker').focus()`)
    await pause(3200)
    await evaluate(`document.querySelector('.playback .top-actions button:last-child').focus()`)
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
    const keyboard=await evaluate(`(() => {const el=document.activeElement;let opacity=1;for(let p=el;p;p=p.parentElement)opacity*=Number(getComputedStyle(p).opacity);return {focused:el.outerHTML.slice(0,500),opacity,chromeHidden:document.querySelector('.playback').classList.contains('chrome-hidden')}})()`)
    if(keyboard.opacity<.99) throw new Error('Keyboard focused an invisible playback control')
    await evaluate(`document.querySelector('.timeline .save').click()`)
    await poll(()=>evaluate(`Boolean(document.querySelector('.timeline .export-bar'))`))
    for(const width of [1440,1024,360]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<768})
      await inspect(`selection-${width}`)
      const selectionLayout=await evaluate(`(() => {const panel=document.querySelector('.timeline').getBoundingClientRect();const bar=document.querySelector('.export-bar').getBoundingClientRect();return {bottom:bar.bottom,panelBottom:panel.bottom,screen:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
      if(selectionLayout.bottom>selectionLayout.panelBottom+1 || selectionLayout.bottom>selectionLayout.screen || selectionLayout.overflow) throw new Error('Selection controls are clipped: '+JSON.stringify(selectionLayout))
    }
    await evaluate(`Array.from(document.querySelectorAll('.export-bar button')).find(el=>el.textContent.includes('退出选区')).click()`)
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
    await evaluate(`document.querySelector('.timeline-tools summary').click();document.querySelector('.timeline-tools summary').focus()`)
    if(!await evaluate(`document.querySelector('.timeline-tools').open`)) throw Error('Timeline tools did not open')
    await inspect('timeline-tools-open')
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    if(!await evaluate(`!document.querySelector('.timeline-tools').open&&Boolean(document.querySelector('.playback'))`)) throw Error('Closing timeline tools exited playback')
    await evaluate(`document.querySelector('.timeline .save').click()`)
    await poll(()=>evaluate(`Boolean(document.querySelector('.selection-edit input'))`))
    await evaluate(`(() => {const inputs=document.querySelectorAll('.selection-edit input');for(const [i,value] of ['2026-10-12T08:00:02','2026-10-12T08:00:06'].entries()){inputs[i].value=value;inputs[i].dispatchEvent(new Event('change',{bubbles:true}))}})()`)
    await evaluate(`document.querySelector('.export-bar .primary').click()`)
    await poll(()=>evaluate(`Boolean(document.querySelector('.export-feedback.success'))`))
    if(!await evaluate(`!document.querySelector('.export-bar')&&document.querySelector('.saved-picker')`)) throw Error('Saving did not finish in saved clips')
    await inspect('save-success')
    await evaluate(`document.querySelector('[aria-label="关闭保存提示"]').click()`)
    const corrupt=join(recording,'smoke-20261012-090000.ts')
    await writeFile(corrupt,Buffer.alloc(4096,0))
    const badTime=new Date('2026-10-12T09:00:08');await utimes(corrupt,badTime,badTime)
    await evaluate(`Array.from(document.querySelectorAll('.timeline [role="tab"]')).find(el=>el.textContent.trim()==='循环').click()`)
    await poll(()=>evaluate(`Number(document.querySelector('.timeline').dataset.segmentCount)>=3`))
    await evaluate(`(() => {const input=document.querySelector('.time-jump input');input.value='09:00:01';input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').requestSubmit()})()`)
    await poll(()=>evaluate(`Boolean(document.querySelector('.error-feedback'))`))
    if(!await evaluate(`document.querySelector('.playback video').classList.contains('idle')&&!document.querySelector('.failure-details').open`)) throw Error('Playback failure retained old image or expanded technical details')
    await inspect('playback-error')
    await copyFile(join(recording,'smoke-20261012-080000.ts'),corrupt)
    await evaluate(`document.querySelector('.error-feedback button').click()`)
    await poll(()=>evaluate(`!document.querySelector('.error-feedback')&&document.querySelector('.playback video').videoWidth===640&&!document.querySelector('.playback video').paused`))
    await writeFile(join(data,'browser-audit.json'),JSON.stringify({snapshots,keyboard,runtimeErrors:errors},null,2))
  }
  await cdp('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true})
  await pause(300)
  const mobile = await cdp('Page.captureScreenshot', {format:'png'})
  await writeFile(join(data,'mobile.png'),Buffer.from(mobile.data,'base64'))
  let continuity = null
  if (process.env.NAVORA_MEDIA_STRESS === '1') {
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
    const sample=join(data,'one-second.mp4')
    await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=25','-t','1','-c:v','libx264','-g','25','-bf','0','-movflags','+faststart',sample])
    const indexPath=join(savedDir,'index.json')
    const index=JSON.parse(await readFile(indexPath,'utf8'))
    const names=[]
    for(let i=0;i<20;i++) {
      const name=`clip-20261012-0100${String(i).padStart(2,'0')}-${String(i+100).padStart(16,'0')}.mp4`
      names.push(name)
      const path=join(savedDir,name)
      await copyFile(sample,path)
      const info=await stat(path,{bigint:true}),startMs=new Date('2026-10-12T01:00:00').getTime()+i*1000
      index.segments.push({fileName:name,startMs,endMs:startMs+1000,durationMs:1000,sizeBytes:Number(info.size),measured:true,sourceVersion:`${info.size}-${info.mtimeNs}`})
    }
    await writeFile(indexPath+'.stress',JSON.stringify(index))
    await rename(indexPath+'.stress',indexPath)
    await evaluate(`Array.from(document.querySelectorAll('.timeline [role="tab"]')).find(el=>el.textContent.includes('已保存')).click()`)
    await evaluate(`document.querySelector('.timeline .day').value='2026-10-12';document.querySelector('.timeline .day').dispatchEvent(new Event('input',{bubbles:true}))`)
    await poll(()=>evaluate(`Boolean(document.querySelector('.saved-picker option[value="smoke/${names[0]}"]'))`))
    await evaluate(`(() => {const select=document.querySelector('.saved-picker');select.value='smoke/${names[0]}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    await poll(()=>evaluate(`Boolean(document.querySelector('.playback .rates button'))`))
    await evaluate(`(() => {
      const video=document.querySelector('.playback video');
      window.continuityStats={sources:[],gaps:[],ended:0,lastEnd:null,done:false};
      video.addEventListener('ended',()=>{if(video.currentSrc.includes('clip-20261012-0100')){window.continuityStats.ended++;window.continuityStats.lastEnd=performance.now()}});
      const frame=()=>{const stats=window.continuityStats;if(stats.done)return;const src=video.currentSrc;
        if(src.includes('clip-20261012-0100')&&src!==stats.sources.at(-1)){stats.sources.push(src);if(stats.lastEnd!=null)stats.gaps.push(performance.now()-stats.lastEnd)}
        video.requestVideoFrameCallback(frame)};
      video.requestVideoFrameCallback(frame);
      Array.from(document.querySelectorAll('.playback .rates button')).find(el=>el.textContent.trim()==='4×').click();
      void video.play();
    })()`)
    await poll(()=>evaluate(`window.continuityStats.sources.length>=20&&window.continuityStats.ended>=20`),90000)
    continuity=await evaluate(`(() => {const stats=window.continuityStats;stats.done=true;const gaps=[...stats.gaps].sort((a,b)=>a-b);return {segments:stats.sources.length,transitions:gaps.length,rate:4,gapP95Ms:gaps[Math.floor(gaps.length*.95)],gapMaxMs:Math.max(...gaps)}})()`)
    if(continuity.segments!==20||continuity.transitions!==19) throw Error('Continuous playback lost segments: '+JSON.stringify(continuity))
    await writeFile(join(data,'continuity.json'),JSON.stringify(continuity,null,2))
  }
  let livePreview = null
  if (process.env.NAVORA_LIVE_STRESS === '1') {
    let upstreamRequests = 0
    fixtureServer=createHTTPServer((_req,res)=>{
      upstreamRequests++
      res.writeHead(200,{'Content-Type':'video/mp2t'})
      const feeder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-re','-stream_loop','-1','-i',join(recording,'smoke-20261012-080000.ts'),'-map','0:v:0','-an','-c:v','copy','-f','mpegts','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','ignore']})
      feeders.add(feeder);feeder.once('exit',()=>feeders.delete(feeder));feeder.stdout.pipe(res)
      feeder.once('error',()=>res.destroy());res.once('close',()=>feeder.kill())
    })
    await new Promise(done=>fixtureServer.listen(0,'127.0.0.1',done))
    const ids=['smoke','live-1','live-2','live-3']
    const channels=ids.map((id,i)=>({id,name:`预览验证 ${i+1}`,url:`http://127.0.0.1:${fixtureServer.address().port}/stream.ts`,enabled:true,segmentTimeSec:10}))
    const upsert=await fetch(`${base}/api/channels/upsert-many`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({channels})})
    if(!upsert.ok) throw Error('Could not configure isolated preview fixtures')
    await evaluate(`(async()=>{const api=window.navoraMonitor,layout=await api.getLayout();layout.mosaic=4;layout.slotIds=${JSON.stringify(ids)}.concat(Array(12).fill(null));await api.setLayout(layout)})()`)
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
    await cdp('Page.reload')
    await poll(()=>evaluate(`document.querySelectorAll('.mosaic video').length===4&&Array.from(document.querySelectorAll('.mosaic video')).every(video=>video.videoWidth===640&&video.getVideoPlaybackQuality().totalVideoFrames>10)`),45000)
    const workers=(await cdp('Target.getTargets')).targetInfos.filter(target=>target.type==='worker')
    if(workers.length<4) throw Error('Live previews did not create background workers')
    await pause(3000)
    const videos=await evaluate(`Array.from(document.querySelectorAll('.mosaic video')).map(video=>({width:video.videoWidth,frames:video.getVideoPlaybackQuality().totalVideoFrames,dropped:video.getVideoPlaybackQuality().droppedVideoFrames}))`)
    const upstreamBeforeVisibility = upstreamRequests
    await evaluate(`(() => {
      window.__previewVideos = Array.from(document.querySelectorAll('.mosaic video'));
      window.__previewSources = window.__previewVideos.map(v=>v.src);
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
    })()`)
    await pause(30000)
    await evaluate(`(() => {
      delete document.hidden; delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    })()`)
    await pause(2000)
    if (!await evaluate(`Array.from(document.querySelectorAll('.mosaic video')).length===4 && window.__previewVideos.every((v,i)=>v===document.querySelectorAll('.mosaic video')[i] && v.src===window.__previewSources[i] && !v.paused)`)) throw Error('Background visibility recreated or paused live players')
    if (upstreamRequests !== upstreamBeforeVisibility) throw Error('Background visibility reopened upstream camera connections')
    // Exercise the actual layout action, including persistence across reload.
    for(const count of [6,8,13]) {
      await evaluate(`Array.from(document.querySelectorAll('.menus button')).find(b=>b.textContent.trim()==='查看').click()`)
      await evaluate(`Array.from(document.querySelectorAll('.dropdown button')).find(b=>b.textContent.includes('1 大 ${count-1} 小')).click()`)
      await poll(()=>evaluate(`document.querySelectorAll('.mosaic.featured .cell').length===${count}`))
      const boxes=await evaluate(`Array.from(document.querySelectorAll('.mosaic .cell')).map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}})`)
      for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) {
        const a=boxes[i],b=boxes[j]
        if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1) throw Error('Featured cells overlap: '+count)
      }
      if(boxes[0].width<boxes[1].width*1.9||boxes[0].height<boxes[1].height*1.9) throw Error('Featured main cell is not enlarged: '+count)
      await pause(500)
      const persisted=await evaluate(`window.navoraMonitor.getLayout()`)
      if(persisted.mosaic!==count||!persisted.featuredLayout) throw Error('Featured count not persisted: '+count)
    }
    await evaluate(`(() => {const button=Array.from(document.querySelectorAll('.menus button')).find(b=>b.textContent.trim()==='查看');button.click()})()`)
    await evaluate(`Array.from(document.querySelectorAll('.dropdown button')).find(b=>b.textContent.includes('主辅布局')).click()`)
    await poll(()=>evaluate(`Boolean(document.querySelector('.mosaic.featured'))`))
    const featured=await evaluate(`Array.from(document.querySelectorAll('.mosaic .cell')).map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})`)
    if(featured[0].height<featured[1].height*2.8 || featured[0].width<featured[1].width*2.8 || featured[1].x!==featured[2].x) throw Error('Featured layout geometry invalid')
    await pause(500)
    await cdp('Page.reload')
    await poll(()=>evaluate(`Boolean(document.querySelector('.mosaic.featured'))&&document.querySelectorAll('.mosaic video').length===4`))
    await poll(()=>evaluate(`Array.from(document.querySelectorAll('.mosaic video')).every(v=>v.videoWidth===640&&v.currentTime>0)`),45000)
    await evaluate(`document.querySelector('.mosaic .cell:nth-child(2)').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:900,clientY:180}))`)
    await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent==='设为主画面').click()`)
    await poll(()=>evaluate(`document.querySelector('.mosaic .cell:first-child .name').textContent==='预览验证 2'`))
    await poll(()=>evaluate(`document.querySelector('.mosaic video').videoWidth===640`),45000)
    await evaluate(`document.querySelector('.mosaic-shell button[title="暂停画面"]').click()`)
    const pausedSrc=await evaluate(`document.querySelector('.mosaic video').src`)
    await pause(10000)
    if(!await evaluate(`(() => {const v=document.querySelector('.mosaic video');return v.paused&&v.src===${JSON.stringify(pausedSrc)}})()`)) throw Error('Intentional pause triggered live recovery')
    await evaluate(`document.querySelector('.mosaic-shell button[title="继续播放"]').click()`)
    const stalledSrc=await evaluate(`(() => {const v=document.querySelector('.mosaic video');v.pause();return v.src})()`)
    await poll(()=>evaluate(`(() => {const v=document.querySelector('.mosaic video');return v.src!==${JSON.stringify(stalledSrc)}&&v.videoWidth===640&&!v.paused&&v.currentTime>0})()`),30000)
    const beforeEnlargeRequests=upstreamRequests
    await evaluate(`window.__enlargeVideos=Array.from(document.querySelectorAll('.mosaic video'))`)
    await evaluate(`document.querySelector('.mosaic .osd-btn[title="放大（一路独占）"]').click()`)
    await poll(()=>evaluate(`Array.from(document.querySelectorAll('.mosaic .cell')).filter(c=>c.getBoundingClientRect().width>0).length===1`))
    await pause(2000)
    if (!await evaluate(`document.querySelectorAll('.mosaic video').length===4&&window.__enlargeVideos.every(v=>v.isConnected)`)) throw Error('Enlargement immediately released sibling streams')
    await evaluate(`document.querySelector('.mosaic .osd-btn[title="还原宫格（Esc）"]').click()`)
    await pause(1000)
    if (upstreamRequests!==beforeEnlargeRequests || !await evaluate(`window.__enlargeVideos.every(v=>v.isConnected)`)) throw Error('Quick enlargement roundtrip reopened camera streams')
    await evaluate(`document.querySelector('.mosaic .osd-btn[title="放大（一路独占）"]').click()`)
    await pause(61000)
    await poll(()=>evaluate(`document.querySelectorAll('.mosaic video').length===1`))
    await poll(async()=>{const states=await(await fetch(`${base}/api/states`,{headers:{Cookie:cookie}})).json();return states.filter(state=>state.preview==='live').length===1},15000)
    await evaluate(`document.querySelector('.mosaic .osd-btn[title="还原宫格（Esc）"]').click()`)
    await poll(()=>evaluate(`document.querySelectorAll('.mosaic video').length===4&&Array.from(document.querySelectorAll('.mosaic video')).every(video=>video.videoWidth===640&&video.getVideoPlaybackQuality().totalVideoFrames>1)`),45000)
    const beforeEdit = upstreamRequests
    const edited = {...channels[0], url: channels[0].url+'?edited=1'}
    const editResponse = await fetch(`${base}/api/channels/upsert`, {method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({channel:edited})})
    if(!editResponse.ok) throw Error('Could not edit running preview source')
    await poll(()=>upstreamRequests>beforeEdit,15000)
    await poll(()=>evaluate(`Array.from(document.querySelectorAll('.mosaic video')).every(video=>video.videoWidth===640&&!video.paused&&video.currentTime>0)`),45000)
    const disabled = await fetch(`${base}/api/channels/upsert`, {method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({channel:{...edited,enabled:false}})})
    if(!disabled.ok) throw Error('Could not disable running preview')
    await poll(async()=>{const states=await(await fetch(`${base}/api/states`,{headers:{Cookie:cookie}})).json();return states.find(state=>state.id===edited.id)?.preview==='idle'},15000)
    livePreview={channels:4,workerCount:workers.length,videos,backgroundVisibilityKeepsConnections:true,featuredLayout:true,featuredPersistence:true,mainSwap:true,intentionalPause:true,silentStallRecovery:true,enlargeKeepsConnectionsFor60Seconds:true,enlargeReleasesHiddenAfterGrace:true,restore:true,sourceEditRestartsPreview:true,disableStopsPreview:true,scope:'Synthetic H.264 streams and visibility events on loopback; not real cameras or OS background suspension'}
    await writeFile(join(data,'live-preview.json'),JSON.stringify(livePreview,null,2))
  }
  let realSamples = null
  if(process.env.NAVORA_REAL_SAMPLE_DIR) {
    const samples=[{stamp:'20261013-015437',name:'20261013-015437-direct.ts',time:'01:54:38',duration:300},{stamp:'20261013-085709',name:'20261013-085709-direct.ts',time:'08:57:10',duration:298},{stamp:'20261013-080627',name:'20261013-080627.ts',time:'08:06:28',duration:23.2}]
    for(const sample of samples) await copyFile(join(process.env.NAVORA_REAL_SAMPLE_DIR,sample.name),join(recording,`smoke-${sample.stamp}.ts`))
    await poll(async()=> (await (await fetch(`${base}/api/recordings?channelId=smoke`,{headers:{Cookie:cookie}})).json()).some(s=>s.fileName.includes('20261013-015437')))
    await evaluate(`Array.from(document.querySelectorAll('.timeline [role="tab"]')).find(b=>b.textContent.includes('循环')).click()`)
    await evaluate(`document.querySelector('.timeline .day').value='2026-10-13';document.querySelector('.timeline .day').dispatchEvent(new Event('input',{bubbles:true}))`)
    realSamples=[]
    for(const sample of samples) {
      await evaluate(`(() => {const input=document.querySelector('.timeline input[type="time"]');input.value=${JSON.stringify(sample.time)};input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').requestSubmit()})()`)
      try { await poll(()=>evaluate(`(() => {const v=document.querySelector('.playback video');return v&&v.videoWidth>=1280&&v.currentTime>0&&v.duration>${sample.duration-1}&&v.duration<${sample.duration+1}&&!document.querySelector('.failure-details')})()`),180000) }
      catch(error) { throw Error(error.message+' '+JSON.stringify(await evaluate(`({sample:${JSON.stringify(sample.stamp)},video:Array.from(document.querySelectorAll('.playback video')).map(v=>({src:v.currentSrc,error:v.error?.message,width:v.videoWidth,duration:v.duration,time:v.currentTime})),timeline:document.querySelector('.timeline').innerText,playback:document.querySelector('.playback')?.innerText,hevc:document.createElement('video').canPlayType('video/mp4; codecs="hvc1"')})`))) }
      const state=await evaluate(`(() => {const v=document.querySelector('.playback video');return {width:v.videoWidth,duration:v.duration,decoded:v.getVideoPlaybackQuality().totalVideoFrames}})()`)
      if(state.decoded<1) throw Error('Real sample produced no decoded frames')
      realSamples.push({sample:sample.stamp,...state})
    }
  }
  console.log(JSON.stringify({ok:true,lazyPlaybackAssets:true,media,continuity,livePreview,realSamples,timeline:{pointerAnchor:true,zoomBounds:true,liveFollow:true,savedPlayback:true,savedDuration:true},runtimeErrors:errors,artifacts:data},null,2))
  if (errors.length) process.exitCode=1
} finally {
  socket?.close()
  browser?.kill()
  if (cookie) await fetch(`${base}/api/shutdown`,{method:'POST',headers:{Cookie:cookie}}).catch(()=>{})
  for (let attempt=0; attempt<100 && server.exitCode===null; attempt++) await pause(100)
  for(const feeder of feeders) feeder.kill()
  if(fixtureServer){fixtureServer.closeAllConnections();await new Promise(done=>fixtureServer.close(done))}
  if (server.exitCode===null) { server.kill(); throw new Error('Application did not shut down cleanly') }
}
