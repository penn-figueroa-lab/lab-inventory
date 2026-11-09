/* Google ID tokens remain short-lived. Renewal never bypasses server validation. */
(function(root) {
  function claims(token) {
    try {
      const part=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      return JSON.parse(decodeURIComponent(Array.from(atob(part),c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join('')));
    } catch { return {}; }
  }
  class LabTrackSession {
    constructor({clientId,google=()=>root.google?.accounts?.id,now=()=>Date.now(),visible=()=>root.document?.visibilityState!=='hidden',online=()=>root.navigator?.onLine!==false,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}) {
      Object.assign(this,{clientId,google,now,visible,online,setTimer,clearTimer});
      this.user=null;this.pending=null;this.ready=null;this.timer=null;this.retryAt=0;this.rejectedToken=null;
      this.onUser=()=>{};this.onState=()=>{};this.onError=()=>{};
    }
    expires(token=this.user?.token) { return Number(claims(token||'').exp||0)*1000; }
    initialize() {
      if(this.ready)return this.ready;
      this.ready=new Promise((resolve,reject)=>{
        const deadline=this.now()+15000;
        const check=()=>{
          const g=this.google();
          if(!g){if(this.now()>=deadline){reject(Error('Google sign-in could not load. Check your connection and try again.'));return;}this.setTimer(check,200);return;}
          try {g.initialize({client_id:this.clientId,hd:'engineering.upenn.edu',auto_select:true,callback:r=>this.accept(r.credential)});resolve(g);} catch(e){reject(e);}
        };check();
      }).catch(e=>{this.ready=null;throw e;});
      return this.ready;
    }
    accept(token) {
      const p=claims(token);
      if(p.hd!=='engineering.upenn.edu'||!p.email||this.expires(token)<=this.now()) {this.onError('Use a current @engineering.upenn.edu Google sign-in.');this.complete(null);return;}
      if(this.user&&this.user.email!==p.email){this.onError('Reconnect with '+this.user.email+'. To switch accounts, sign out first.');this.complete(null);return;}
      this.setUser({token,name:p.name,email:p.email,picture:p.picture});
      this.onUser(this.user);this.complete(token);
    }
    setUser(user) {
      this.user=user;this.rejectedToken=null;this.retryAt=0;
      this.clearTimer(this.timer);
      if(user){this.onState('ready');this.schedule();}
    }
    schedule() {
      this.clearTimer(this.timer);
      if(!this.user)return;
      this.timer=this.setTimer(()=>{if(this.visible()&&this.online())this.renew();},Math.max(1000,this.expires()-this.now()-300000,this.retryAt-this.now()));
    }
    complete(token) {
      const p=this.pending;
      if(!p)return;
      this.pending=null;this.clearTimer(p.timeout);p.resolve(token);
      if(!token){// Do not nag after Google declines/dismisses renewal. The visible sign-in button can always reconnect.
        this.retryAt=Infinity;this.onState(this.expires()>this.now()&&this.rejectedToken!==this.user?.token?'ready':'required');}
    }
    renew(manual=false) {
      if(this.pending)return this.pending.promise;
      if(!this.user||!this.visible()||!this.online())return Promise.resolve(null);
      if(!manual&&this.now()<this.retryAt)return Promise.resolve(null);
      let resolve;const promise=new Promise(r=>resolve=r);
      const pending={promise,resolve};this.pending=pending;this.onState('renewing');
      pending.timeout=this.setTimer(()=>this.complete(null),20000);
      this.initialize().then(g=>{
        if(this.pending!==pending)return;
        g.prompt(n=>{if(this.pending===pending&&(n.isNotDisplayed?.()||n.isSkippedMoment?.()))this.complete(null);});
      }).catch(e=>{this.onError(e.message);if(this.pending===pending)this.complete(null);});
      return promise;
    }
    resume() {
      if(this.user&&this.visible()&&this.online()&&(this.expires()<=this.now()+300000||this.rejectedToken===this.user.token))return this.renew();
      return Promise.resolve(this.user?.token);
    }
    async request(send) {
      const email=this.user?.email;
      if(!email)return {error:'Unauthorized',detail:'Sign in to continue.'};
      let token=this.user.token;
      if(this.expires(token)<=this.now()+60000||this.rejectedToken===token){
        await this.renew();token=this.user?.token;
        if(!token||this.expires(token)<=this.now()+10000||this.rejectedToken===token){this.onState('required');return {error:'Unauthorized',detail:'Reconnect with Google, then retry. Your form is still here.'};}
      }
      if(this.user?.email!==email)return {error:'Unauthorized',detail:'The signed-in account changed. Please retry.'};
      let result=await send(token);
      if(this.user?.email!==email)return {error:'Unauthorized',detail:'The signed-in account changed. Please retry.'};
      if(result?.error==='Unauthorized') {
        if(this.user.token===token){this.rejectedToken=token;await this.renew();}
        const fresh=this.user?.token;
        if(this.user?.email===email&&fresh&&fresh!==token&&this.expires(fresh)>this.now())result=await send(fresh);
        if(result?.error==='Unauthorized'){this.rejectedToken=this.user?.token;this.onState('required');}
      }
      if(this.user?.email!==email)return {error:"Unauthorized",detail:"The signed-in account changed. Please retry."};
      return result;
    }
    signOut() {
      this.clearTimer(this.timer);this.complete(null);this.user=null;this.rejectedToken=null;this.retryAt=0;
      this.google()?.cancel?.();this.google()?.disableAutoSelect?.();
    }
  }
  root.LabTrackSession=LabTrackSession;
  if(typeof module!=='undefined')module.exports={LabTrackSession,claims};
})(typeof window!=='undefined'?window:globalThis);
