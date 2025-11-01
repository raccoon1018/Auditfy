// auditfy.engine.js  v0.9.7  (엔진: 편집 데이터/설정 + 직렬화)

export class AuditfyEngine{
  constructor({settings={}}={}){
    this.settings = Object.assign({
      crossfadeSec: 3,
      fadeInSec: 1,
      fadeOutSec: 2,
      trackCount: 3,
      compOn: false,
      limitOn: false,
      theme: 'light',          // 'light' | 'dark'
      followSystem: false      // 시스템 설정 반영 여부
    }, settings||{});
    this.clips = []; // {id,name,start,duration,track,offset,gain,fx:{}}
    this._listeners = new Map();
  }
  on(ev, cb){ if(!this._listeners.has(ev)) this._listeners.set(ev,new Set()); this._listeners.get(ev).add(cb); }
  emit(ev,data){ const set=this._listeners.get(ev); if(!set) return; for(const cb of set) try{cb(data);}catch(e){console.error(e);} }
  updateSettings(partial){ this.settings=Object.assign({},this.settings,partial||{}); this.emit('settings',this.settings); }
  addClip(name, duration, start=0, track=0){
    const id='clip_'+Math.random().toString(36).slice(2);
    const c={ id, name, duration:Math.max(0.1,duration||0.1), start:Math.max(0,start||0), track:Math.max(0,track|0), offset:0, gain:1, fx:{} };
    this.clips.push(c); this.emit('clips', this.clips); return c;
  }
  toProjectJSON(){
    const data={
      meta:{ tool:'Auditfy', ver:'0.9.7', savedAt:new Date().toISOString(), projectName:(document.getElementById('projectName')?.textContent||'Untitled') },
      settings:this.settings,
      clips:this.clips.map(c=>({id:c.id,name:c.name,start:c.start,duration:c.duration,track:c.track,offset:c.offset||0,gain:c.gain||1,fx:c.fx||{}}))
    };
    return JSON.stringify(data,null,2);
  }
  fromProjectJSON(json){
    const data=(typeof json==='string')?JSON.parse(json):json;
    if(!data || !Array.isArray(data.clips)) throw new Error('잘못된 프로젝트 파일');
    this.settings=Object.assign({},this.settings,data.settings||{});
    this.clips=data.clips.map(c=>({...c}));
    this.emit('settings',this.settings); this.emit('clips',this.clips);
    return data.meta?.projectName || 'Untitled';
  }
}

// 파일 다운로드 유틸
export function downloadBlob(blob, filename){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename||'download';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 100);
}