// Account-scoped, read-only fallback. Only authoritative complete reads are cached.
(function(root){
  const version="2026-11-24.1",key="labtrack_snapshot_v2";
  const validSnapshot=d=>!!d&&["items","orders","deliveries","checkouts","reservations"].every(k=>Array.isArray(d[k]))
    &&Number(d.capabilities?.version)>=2&&typeof d.capabilities.scheduling==="boolean"
    &&Array.isArray(d.migration?.issues)&&Array.isArray(d.migration?.blockedItemIds);
  function saveSnapshot(storage,email,data,now=Date.now()) {
    if(!email||!validSnapshot(data))return;
    const {items,orders,deliveries,checkouts,reservations,capabilities,migration}=data;
    try {storage.setItem(key,JSON.stringify({email,savedAt:now,data:{items,orders,deliveries,checkouts,reservations,capabilities,migration,settings:{categories:data.settings?.categories}}}));storage.removeItem("labtrack_data");}catch{/* Storage quota/privacy restrictions must not break live reads. */}
  }
  function readSnapshot(storage,email) {
    try {const saved=JSON.parse(storage.getItem(key));return saved?.email===email&&Number.isFinite(saved.savedAt)&&validSnapshot(saved.data)?saved:null;}catch{return null;}
  }
  async function checkRelease(fetcher,href) {
    try {
      const url=new URL("release.json",href);url.searchParams.set("check",Date.now());
      const response=await fetcher(url.href,{cache:"no-store"});
      if(!response.ok)return null;
      const data=await response.json();
      return /^\d{4}-\d{2}-\d{2}\.\d+$/.test(data.version)&&data.version!==version?data.version:null;
    }catch{return null;}
  }
  function reloadUrl(href) {const url=new URL(href);url.searchParams.set("refresh",Date.now());return url.href;}
  const api={version,validSnapshot,saveSnapshot,readSnapshot,checkRelease,reloadUrl};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.LabTrackClient=api;
})(typeof window!=="undefined"?window:globalThis);
