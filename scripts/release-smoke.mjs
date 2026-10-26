import {spawn, spawnSync} from 'node:child_process'
import {mkdtemp, mkdir, writeFile, readFile} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {createServer} from 'node:net'
import {createHash} from 'node:crypto'

const root=resolve(import.meta.dirname,'..')
const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const exe=join(root,'release/stage-win-x64/navora.exe')
await mkdir(join(root,'.navora-dev-data'),{recursive:true})
const data=await mkdtemp(join(root,'.navora-dev-data','release-'))
await writeFile(join(data,'settings.json'),JSON.stringify({
  recordingsPath:join(data,'recordings'), savedClipsPath:join(data,'saved'), snapshotsPath:join(data,'snapshots'),
  recordCacheEnabled:false, remoteEnabled:false,
}))
const initialize=()=>{
  const result=spawnSync(exe,['--data',data,'--init-only'],{windowsHide:true,encoding:'utf8'})
  if(result.status!==0) throw Error('Release initialization failed')
  return result.stdout
}
const first=initialize()
const password=first.split(/\r?\n/).find(line=>line.includes('初始密码'))?.split(': ').at(-1)?.trim()
if(!password) throw Error('Initial password was not presented')
const authHash=()=>readFile(join(data,'auth.json')).then(bytes=>createHash('sha256').update(bytes).digest('hex'))
const before=await authHash()
if(initialize().includes('初始密码') || before!==await authHash()) throw Error('Reinitialization replaced existing credentials')
const port=await new Promise(done=>{const listener=createServer();listener.listen(0,'127.0.0.1',()=>{
  const value=listener.address().port; listener.close(()=>done(value))
})})
const base=`http://127.0.0.1:${port}`
const child=spawn(exe,['--data',data,'--port',String(port)],{windowsHide:true,stdio:'ignore'})
let cookie
try {
  let status
  for(let attempt=0;attempt<100;attempt++) {
    try {status=await (await fetch(base+'/api/status')).json();break} catch {await new Promise(done=>setTimeout(done,100))}
  }
  if(status?.version!==version) throw Error('Packaged version readiness check failed')
  const duplicate=spawnSync(exe,['--data',data,'--init-only','--reset-password'],{windowsHide:true,encoding:'utf8',timeout:5000})
  if(!Number.isInteger(duplicate.status) || duplicate.status===0 || !duplicate.stderr.includes('无法独占数据目录')) throw Error('Active data directory did not reject password reset')
  if(before!==await authHash()) throw Error('Blocked password reset modified credentials')
  const response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'navora',password})})
  if(!response.ok) throw Error('Packaged login failed')
  cookie=response.headers.get('set-cookie').split(';')[0]
  const html=await (await fetch(base)).text()
  const assets=[...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)].map(match=>match[1])
  if(!assets.length) throw Error('Packaged UI assets missing')
  for(const asset of assets) {
    const url=new URL(asset,base)
    const result=await fetch(url)
    if(!result.ok) throw Error('Embedded UI asset unavailable')
    const actual=Buffer.from(await result.arrayBuffer())
    const expected=await readFile(join(root,'server/internal/webui/files',url.pathname))
    if(!actual.equals(expected)) throw Error('Packaged UI differs from the latest built UI')
  }
  console.log(JSON.stringify({ok:true,version:status.version,initializationPreservesCredentials:true,duplicateInstanceBlocked:true,login:true,embeddedAssets:assets.length}))
} finally {
  if(cookie) await fetch(base+'/api/shutdown',{method:'POST',headers:{Cookie:cookie}}).catch(()=>{})
  for(let attempt=0;attempt<100 && child.exitCode===null;attempt++) await new Promise(done=>setTimeout(done,100))
  if(child.exitCode===null) {child.kill();throw Error('Packaged process did not shut down cleanly')}
  if(child.exitCode!==0) throw Error('Packaged process exited with an error')
}
