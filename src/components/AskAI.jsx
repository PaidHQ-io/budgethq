import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { askAIRun } from "../lib/askAI.js";
import { Inp, Btn, Icon, SectionLabel } from "./shared.jsx";

// src/components/AskAI.jsx — Ask AI tab (2026-07-25 split, per Mo). Includes the example-
// prompt pool and chat-sidebar grouping helper, since both are only ever used here.

const ASK_AI_EXAMPLE_POOL=[
  "How much did we spend on Spreadsheet Server in January vs March?",
  "Which product had the highest spend last quarter?",
  "Compare Google vs LinkedIn spend in EMEA this year",
  "What's our total spend broken down by Region?",
  "Which platform drove the most spend last month?",
  "How did Demand Gen spend trend month over month?",
  "What percentage of spend went to APAC vs NA this year?",
  "Break down Capterra spend by product for this year",
  "Which Funnel stage got the most spend in Q1?",
  "Compare this month's spend to last month by Platform",
];
function pickAskAIExamples(){
  const pool=[...ASK_AI_EXAMPLE_POOL];
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  return pool.slice(0,3);
}

// Buckets chats by recency for the Ask AI sidebar's chat list — same "Today / Yesterday /
// Previous 7 days / ..." grouping convention as the Claude desktop app's own history sidebar,
// which is explicitly what this was modeled after. Pinned chats are handled separately by the
// caller (their own always-on-top section, never bucketed by date).
function groupChatsByRecency(chats){
  const startOfDay=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const today=startOfDay(new Date());
  const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);
  const weekAgo=new Date(today);weekAgo.setDate(weekAgo.getDate()-7);
  const monthAgo=new Date(today);monthAgo.setDate(monthAgo.getDate()-30);
  const buckets={Today:[],Yesterday:[],"Previous 7 days":[],"Previous 30 days":[],Older:[]};
  chats.forEach(c=>{
    const d=startOfDay(new Date(c.updatedAt));
    if(d.getTime()===today.getTime())buckets.Today.push(c);
    else if(d.getTime()===yesterday.getTime())buckets.Yesterday.push(c);
    else if(d>weekAgo)buckets["Previous 7 days"].push(c);
    else if(d>monthAgo)buckets["Previous 30 days"].push(c);
    else buckets.Older.push(c);
  });
  return Object.entries(buckets).filter(([,list])=>list.length).map(([label,list])=>({label,chats:list}));
}

// Chat UI for the Ask AI view. Chats are lifted to the parent (askChats/setAskChats) so they
// persist server-side per (workspace,user) the same way tags/budgets/spend data already do —
// surviving both in-app navigation and a full page reload, and following the user across
// devices. activeAskChatId===null is the "blank/new chat" state; a chat record only gets created
// in askChats once its first message actually sends, so clicking "New chat" repeatedly doesn't
// leave a trail of empty entries behind.
//
// SIDEBAR REWORK (2026-07-21): the generic left <aside> (Total spend / stat tiles) this tab used
// to fall back to wasn't relevant here — Ask AI isn't a spend-data view, it's a chat interface —
// so `sidebarEl` is now a portal target this component owns entirely, used for chat management
// (search, pinning, projects, labels) modeled on the Claude desktop app's own history sidebar
// rather than the small header dropdown alone. The header History dropdown stays as-is
// underneath — it's the only access point on mobile, where sidebarEl is never mounted (see the
// `!isMobile` gate around the whole stats <aside> in BudgetHQ's render).
export default function AskAI({T,mergedNormRows,tags,tagDims,budgetDims,budgets,budgetRowMeta,defaultForecastModel,hasData,askChats,setAskChats,askProjects,setAskProjects,activeAskChatId,setActiveAskChatId,sidebarEl}){
  const[input,setInput]=useState("");
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState("");
  const[historyOpen,setHistoryOpen]=useState(false);
  const[examples,setExamples]=useState(pickAskAIExamples);
  const scrollRef=useRef(null);
  const taRef=useRef(null);

  const activeChat=askChats.find(c=>c.id===activeAskChatId)||null;
  const messages=activeChat?.messages||[];

  useEffect(()=>{if(scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight;},[messages,loading]);
  useEffect(()=>{if(taRef.current){taRef.current.style.height="auto";taRef.current.style.height=Math.min(taRef.current.scrollHeight,140)+"px";}},[input]);

  const startNewChat=useCallback(()=>{setActiveAskChatId(null);setHistoryOpen(false);setExamples(pickAskAIExamples());setError("");},[setActiveAskChatId]);
  const deleteChat=useCallback((id,e)=>{
    e?.stopPropagation();
    setAskChats(prev=>prev.filter(c=>c.id!==id));
    if(activeAskChatId===id)setActiveAskChatId(null);
  },[activeAskChatId,setAskChats,setActiveAskChatId]);

  const send=useCallback(async(question)=>{
    const q=(question||input).trim();
    if(!q||loading)return;
    setInput("");setError("");
    let chatId=activeAskChatId;
    let priorMessages=[];
    let priorHistory=[];
    if(chatId){
      const existing=askChats.find(c=>c.id===chatId);
      priorMessages=existing?.messages||[];
      priorHistory=existing?.history||[];
    }else{
      chatId=`chat_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const title=q.length>60?q.slice(0,57)+"…":q;
      setAskChats(prev=>[{id:chatId,title,messages:[],history:[],updatedAt:Date.now(),pinned:false,projectId:null,labels:[]},...prev]);
      setActiveAskChatId(chatId);
    }
    const newMessages=[...priorMessages,{role:"user",text:q}];
    setAskChats(prev=>prev.map(c=>c.id===chatId?{...c,messages:newMessages,updatedAt:Date.now()}:c));
    setLoading(true);
    try{
      const{answer,messages:newHistory}=await askAIRun({question:q,history:priorHistory,ctx:{mergedNormRows,tags,tagDims,budgetDims,budgets,budgetRowMeta,defaultForecastModel}});
      const finalHistory=[...newHistory,{role:"assistant",content:answer}];
      const finalMessages=[...newMessages,{role:"assistant",text:answer}];
      setAskChats(prev=>prev.map(c=>c.id===chatId?{...c,messages:finalMessages,history:finalHistory,updatedAt:Date.now()}:c));
    }catch(err){
      setError(err.message);
    }finally{
      setLoading(false);
    }
  },[input,loading,activeAskChatId,askChats,mergedNormRows,tags,tagDims,budgetDims,budgets,budgetRowMeta,defaultForecastModel,setAskChats,setActiveAskChatId]);

  // ── Sidebar chat management: search, pinning, projects, labels, rename (2026-07-21) ──
  const[sidebarSearch,setSidebarSearch]=useState("");
  const[activeProjectId,setActiveProjectId]=useState(null); // null="All chats"; "unfiled" sentinel; else a project id
  const[activeLabel,setActiveLabel]=useState(null);
  const[newProjectName,setNewProjectName]=useState("");
  const[editingProjectId,setEditingProjectId]=useState(null);
  const[editingProjectName,setEditingProjectName]=useState("");
  const[chatMenuOpenId,setChatMenuOpenId]=useState(null);
  const[chatMenuAnchorRect,setChatMenuAnchorRect]=useState(null);
  const[renamingChatId,setRenamingChatId]=useState(null);
  const[renamingTitle,setRenamingTitle]=useState("");
  const[newLabelInput,setNewLabelInput]=useState("");

  const togglePin=useCallback(id=>{setAskChats(prev=>prev.map(c=>c.id===id?{...c,pinned:!c.pinned}:c));},[setAskChats]);
  const commitRename=useCallback((id,title)=>{
    const trimmed=title.trim();
    if(trimmed)setAskChats(prev=>prev.map(c=>c.id===id?{...c,title:trimmed}:c));
    setRenamingChatId(null);
  },[setAskChats]);
  const assignProject=useCallback((chatId,projectId)=>{setAskChats(prev=>prev.map(c=>c.id===chatId?{...c,projectId}:c));},[setAskChats]);
  const toggleChatLabel=useCallback((chatId,label)=>{
    setAskChats(prev=>prev.map(c=>{
      if(c.id!==chatId)return c;
      const labels=c.labels||[];
      return{...c,labels:labels.includes(label)?labels.filter(l=>l!==label):[...labels,label]};
    }));
  },[setAskChats]);
  const addProject=useCallback(()=>{
    const name=newProjectName.trim();
    if(!name)return;
    setAskProjects(prev=>[...prev,{id:`proj_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,name}]);
    setNewProjectName("");
  },[newProjectName,setAskProjects]);
  const deleteProject=useCallback(id=>{
    setAskProjects(prev=>prev.filter(p=>p.id!==id));
    setAskChats(prev=>prev.map(c=>c.projectId===id?{...c,projectId:null}:c));
    setActiveProjectId(p=>p===id?null:p);
  },[setAskProjects,setAskChats]);
  const commitProjectRename=useCallback((id,name)=>{
    const trimmed=name.trim();
    if(trimmed)setAskProjects(prev=>prev.map(p=>p.id===id?{...p,name:trimmed}:p));
    setEditingProjectId(null);
  },[setAskProjects]);

  const allLabels=useMemo(()=>{
    const set=new Set();
    askChats.forEach(c=>(c.labels||[]).forEach(l=>set.add(l)));
    return Array.from(set).sort();
  },[askChats]);

  const filteredSidebarChats=useMemo(()=>{
    const q=sidebarSearch.trim().toLowerCase();
    return askChats.filter(c=>{
      if(q&&!c.title.toLowerCase().includes(q))return false;
      if(activeProjectId==="unfiled"){if(c.projectId)return false;}
      else if(activeProjectId&&c.projectId!==activeProjectId)return false;
      if(activeLabel&&!(c.labels||[]).includes(activeLabel))return false;
      return true;
    });
  },[askChats,sidebarSearch,activeProjectId,activeLabel]);
  const pinnedSidebarChats=useMemo(()=>filteredSidebarChats.filter(c=>c.pinned).sort((a,b)=>b.updatedAt-a.updatedAt),[filteredSidebarChats]);
  const unpinnedSidebarChats=useMemo(()=>filteredSidebarChats.filter(c=>!c.pinned).sort((a,b)=>b.updatedAt-a.updatedAt),[filteredSidebarChats]);
  const recencyGroups=useMemo(()=>groupChatsByRecency(unpinnedSidebarChats),[unpinnedSidebarChats]);

  const menuBtnStyle={display:"block",width:"100%",textAlign:"left",padding:"6px 8px",borderRadius:6,background:"transparent",border:"none",color:T.text,fontSize:12,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"};

  const renderChatRow=c=>{
    const isEditing=renamingChatId===c.id;
    return(
      <div key={c.id} onClick={()=>{if(!isEditing)setActiveAskChatId(c.id);}}
        className={c.id===activeAskChatId?undefined:"bhq-row"}
        style={{display:"flex",alignItems:"center",gap:4,padding:"5px 6px",borderRadius:6,cursor:"pointer",background:c.id===activeAskChatId?T.rowSelected:"transparent"}}>
        <span onClick={e=>{e.stopPropagation();togglePin(c.id);}} title={c.pinned?"Unpin":"Pin"} style={{flexShrink:0,cursor:"pointer",opacity:c.pinned?1:0.32,fontSize:11,lineHeight:1}}>📌</span>
        {isEditing?(
          <input autoFocus value={renamingTitle} onChange={e=>setRenamingTitle(e.target.value)} onClick={e=>e.stopPropagation()}
            onKeyDown={e=>{if(e.key==="Enter")commitRename(c.id,renamingTitle);if(e.key==="Escape")setRenamingChatId(null);}}
            onBlur={()=>commitRename(c.id,renamingTitle)}
            style={{flex:1,minWidth:0,fontSize:12,padding:"3px 5px",borderRadius:5,border:`1px solid ${T.accentBorder}`,background:T.inputBg,color:T.text,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
        ):(
          <span style={{flex:1,minWidth:0,fontSize:12,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.title}</span>
        )}
        {!isEditing&&(
          <button onClick={e=>{e.stopPropagation();setChatMenuAnchorRect(e.currentTarget.getBoundingClientRect());setChatMenuOpenId(chatMenuOpenId===c.id?null:c.id);}}
            style={{flexShrink:0,background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:13,padding:"2px 4px",lineHeight:1}}>⋯</button>
        )}
      </div>
    );
  };

  const sidebarPanel=sidebarEl&&createPortal(
    <div style={{display:"flex",flexDirection:"column",height:"100%",gap:14}}>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        <Inp value={sidebarSearch} onChange={setSidebarSearch} placeholder="Search chats…" T={T}/>
        <Btn onClick={startNewChat} variant="primary" size="sm" T={T} style={{width:"100%",justifyContent:"center",gap:6}}>
          <Icon name="plus" size={12} color={T.onAccent}/> New chat
        </Btn>
      </div>

      {pinnedSidebarChats.length>0&&(
        <div>
          <SectionLabel T={T} style={{marginBottom:6}}>Pinned</SectionLabel>
          <div style={{display:"flex",flexDirection:"column",gap:2}}>{pinnedSidebarChats.map(renderChatRow)}</div>
        </div>
      )}

      <div>
        <SectionLabel T={T} style={{marginBottom:6}}>Projects</SectionLabel>
        <div style={{display:"flex",flexDirection:"column",gap:2,marginBottom:6}}>
          <div onClick={()=>setActiveProjectId(null)} className={activeProjectId===null?undefined:"bhq-row"}
            style={{padding:"5px 8px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:activeProjectId===null?700:400,color:T.text,background:activeProjectId===null?T.accentBg:"transparent"}}>
            All chats ({askChats.length})
          </div>
          {askProjects.map(p=>{
            const count=askChats.filter(c=>c.projectId===p.id).length;
            const isEditing=editingProjectId===p.id;
            return(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:4}}>
                {isEditing?(
                  <input autoFocus value={editingProjectName} onChange={e=>setEditingProjectName(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter")commitProjectRename(p.id,editingProjectName);if(e.key==="Escape")setEditingProjectId(null);}}
                    onBlur={()=>commitProjectRename(p.id,editingProjectName)}
                    style={{flex:1,minWidth:0,fontSize:12,padding:"4px 6px",borderRadius:5,border:`1px solid ${T.accentBorder}`,background:T.inputBg,color:T.text,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
                ):(
                  <div onClick={()=>setActiveProjectId(p.id)} onDoubleClick={()=>{setEditingProjectId(p.id);setEditingProjectName(p.name);}}
                    className={activeProjectId===p.id?undefined:"bhq-row"} title="Double-click to rename"
                    style={{flex:1,minWidth:0,padding:"5px 8px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:activeProjectId===p.id?700:400,color:T.text,background:activeProjectId===p.id?T.accentBg:"transparent",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {p.name} ({count})
                  </div>
                )}
                {!isEditing&&<span onClick={()=>deleteProject(p.id)} title="Delete project (chats stay, just unfiled)" style={{color:T.textMuted,cursor:"pointer",fontSize:12,padding:"2px 4px",flexShrink:0}}>✕</span>}
              </div>
            );
          })}
          <div onClick={()=>setActiveProjectId("unfiled")} className={activeProjectId==="unfiled"?undefined:"bhq-row"}
            style={{padding:"5px 8px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:activeProjectId==="unfiled"?700:400,color:T.textMuted,background:activeProjectId==="unfiled"?T.accentBg:"transparent"}}>
            Unfiled ({askChats.filter(c=>!c.projectId).length})
          </div>
        </div>
        <div style={{display:"flex",gap:5}}>
          <Inp value={newProjectName} onChange={setNewProjectName} placeholder="New project…" T={T} style={{fontSize:11,padding:"5px 8px"}}/>
          <Btn onClick={addProject} variant="subtle" size="sm" T={T}>+</Btn>
        </div>
      </div>

      {allLabels.length>0&&(
        <div>
          <SectionLabel T={T} style={{marginBottom:6}}>Labels</SectionLabel>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {allLabels.map(l=>{
              const active=activeLabel===l;
              return(
                <button key={l} onClick={()=>setActiveLabel(active?null:l)}
                  style={{fontSize:10.5,padding:"3px 8px",borderRadius:12,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:500,background:active?T.accent:T.surfaceEl,color:active?T.onAccent:T.textSub,border:`1px solid ${active?T.accentHover:T.border}`}}>
                  {l}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <SectionLabel T={T} style={{marginBottom:6}}>Chats</SectionLabel>
        <div className="bhq-scroll" style={{flex:1,overflow:"auto"}}>
          {filteredSidebarChats.length===0&&<div style={{fontSize:11,color:T.textMuted,padding:"8px 2px"}}>No chats {sidebarSearch||activeProjectId||activeLabel?"match this filter":"yet"}</div>}
          {recencyGroups.map(g=>(
            <div key={g.label} style={{marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:T.textMuted,margin:"4px 0"}}>{g.label}</div>
              <div style={{display:"flex",flexDirection:"column",gap:2}}>{g.chats.map(renderChatRow)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    sidebarEl
  );

  const chatMenu=chatMenuOpenId&&chatMenuAnchorRect&&createPortal(
    <>
      <div onClick={()=>setChatMenuOpenId(null)} style={{position:"fixed",inset:0,zIndex:999}}/>
      <div style={{position:"fixed",top:chatMenuAnchorRect.bottom+4,left:Math.max(8,chatMenuAnchorRect.right-224),zIndex:1000,width:224,maxHeight:360,overflow:"auto",background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:T.shadowMd,padding:6,display:"flex",flexDirection:"column",gap:2}}>
        {(()=>{
          const c=askChats.find(x=>x.id===chatMenuOpenId);
          if(!c)return null;
          return(
            <>
              <button onClick={()=>{setRenamingChatId(c.id);setRenamingTitle(c.title);setChatMenuOpenId(null);}} style={menuBtnStyle}>Rename</button>
              <button onClick={()=>{togglePin(c.id);setChatMenuOpenId(null);}} style={menuBtnStyle}>{c.pinned?"Unpin":"Pin"}</button>
              <div style={{height:1,background:T.border,margin:"4px 0"}}/>
              <div style={{padding:"4px 8px",fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:T.textMuted}}>Project</div>
              <button onClick={()=>{assignProject(c.id,null);setChatMenuOpenId(null);}} style={{...menuBtnStyle,fontWeight:!c.projectId?700:400}}>No project</button>
              {askProjects.map(p=>(
                <button key={p.id} onClick={()=>{assignProject(c.id,p.id);setChatMenuOpenId(null);}} style={{...menuBtnStyle,fontWeight:c.projectId===p.id?700:400}}>{p.name}</button>
              ))}
              <div style={{height:1,background:T.border,margin:"4px 0"}}/>
              <div style={{padding:"4px 8px",fontSize:10,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:T.textMuted}}>Labels</div>
              {allLabels.length>0&&(
                <div style={{display:"flex",flexWrap:"wrap",gap:4,padding:"0 8px 6px"}}>
                  {allLabels.map(l=>{
                    const on=(c.labels||[]).includes(l);
                    return(
                      <button key={l} onClick={()=>toggleChatLabel(c.id,l)}
                        style={{fontSize:10.5,padding:"2px 7px",borderRadius:10,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",background:on?T.accent:T.surfaceEl,color:on?T.onAccent:T.textSub,border:`1px solid ${on?T.accentHover:T.border}`}}>
                        {l}
                      </button>
                    );
                  })}
                </div>
              )}
              <div style={{display:"flex",gap:4,padding:"0 8px 4px"}}>
                <input value={newLabelInput} onChange={e=>setNewLabelInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter"&&newLabelInput.trim()){toggleChatLabel(c.id,newLabelInput.trim());setNewLabelInput("");}}}
                  placeholder="Add label…" style={{flex:1,minWidth:0,fontSize:11,padding:"4px 6px",borderRadius:5,border:`1px solid ${T.border}`,background:T.inputBg,color:T.text,outline:"none",fontFamily:"'DM Sans',sans-serif"}}/>
              </div>
              <div style={{height:1,background:T.border,margin:"4px 0"}}/>
              <button onClick={()=>{if(window.confirm(`Delete "${c.title}"? This can't be undone.`))deleteChat(c.id);setChatMenuOpenId(null);}} style={{...menuBtnStyle,color:T.danger}}>Delete chat</button>
            </>
          );
        })()}
      </div>
    </>,
    document.body
  );

  if(!hasData){
    return(
      <>
        <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:T.bg}}>
          <div style={{textAlign:"center",maxWidth:380}}>
            <div style={{width:48,height:48,borderRadius:12,background:T.accent,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
              <Icon name="sparkle" size={24} color={T.onAccent}/>
            </div>
            <div style={{fontSize:16,fontWeight:700,color:T.text,marginBottom:6,fontFamily:"'DM Sans',sans-serif"}}>Ask AI needs spend data first</div>
            <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif"}}>Import or sync spend data in the Campaign Tagger, then come back here to ask questions about it.</div>
          </div>
        </div>
        {/* Sidebar still works even with no spend data yet — someone may have saved chats/
            projects from a previous dataset (see mergedNormRows-cleared edge case in the doc
            comment above the component). */}
        {sidebarPanel}
        {chatMenu}
      </>
    );
  }

  const composer=(
    <div style={{display:"flex",alignItems:"flex-end",gap:8,background:T.surface,border:`1px solid ${T.borderStrong}`,borderRadius:22,padding:"8px 8px 8px 20px",boxShadow:T.shadowMd}}>
      <textarea
        ref={taRef}
        value={input}
        onChange={e=>setInput(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
        placeholder="Ask about your spend data…"
        rows={1}
        style={{flex:1,resize:"none",border:"none",outline:"none",background:"transparent",color:T.text,fontSize:15,lineHeight:1.55,fontFamily:"'DM Sans',sans-serif",padding:"8px 0",maxHeight:140,overflow:"auto"}}
      />
      <button onClick={()=>send()} disabled={loading||!input.trim()}
        style={{width:36,height:36,borderRadius:"50%",background:input.trim()&&!loading?T.accent:T.surfaceEl,border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:input.trim()&&!loading?"pointer":"default",flexShrink:0,transition:"background 0.15s"}}>
        <Icon name="send" size={16} color={input.trim()&&!loading?"#FFFFFF":T.textMuted}/>
      </button>
    </div>
  );

  return(
    <>
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:T.bg}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 24px",borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
        <div style={{fontSize:13,fontWeight:700,color:T.text,display:"flex",alignItems:"center",gap:6,fontFamily:"'DM Sans',sans-serif"}}>
          <Icon name="sparkle" size={15} color={T.text}/> Ask AI
        </div>
        <div style={{display:"flex",gap:8,position:"relative"}}>
          <Btn onClick={()=>setHistoryOpen(o=>!o)} variant="ghost" size="sm" T={T} style={{gap:6}}>
            <Icon name="history" size={13} color={T.text}/> History{askChats.length>0?` (${askChats.length})`:""}
          </Btn>
          <Btn onClick={startNewChat} variant="ghost" size="sm" T={T} style={{gap:6}}>
            <Icon name="plus" size={13} color={T.text}/> New chat
          </Btn>
          {historyOpen&&(
            <>
              <div onClick={()=>setHistoryOpen(false)} style={{position:"fixed",inset:0,zIndex:35}}/>
              <div style={{position:"absolute",top:"120%",right:0,width:300,maxHeight:380,overflow:"auto",background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,boxShadow:T.shadowLg,zIndex:40}}>
                {askChats.length===0&&<div style={{padding:18,fontSize:12,color:T.textMuted,textAlign:"center",fontFamily:"'DM Sans',sans-serif"}}>No past chats yet</div>}
                {[...askChats].sort((a,b)=>b.updatedAt-a.updatedAt).map(c=>(
                  <div key={c.id} onClick={()=>{setActiveAskChatId(c.id);setHistoryOpen(false);}}
                    style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"10px 14px",borderBottom:`1px solid ${T.border}`,cursor:"pointer",background:c.id===activeAskChatId?T.rowSelected:"transparent"}}>
                    <span style={{fontSize:12,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,fontFamily:"'DM Sans',sans-serif"}}>{c.title}</span>
                    <span onClick={e=>deleteChat(c.id,e)} title="Delete chat"
                      style={{color:T.textMuted,cursor:"pointer",fontSize:14,padding:"2px 4px",flexShrink:0,lineHeight:1}}>✕</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {messages.length===0?(
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{width:"100%",maxWidth:640}}>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{fontSize:22,fontWeight:700,color:T.text,marginBottom:6,fontFamily:"'DM Sans',sans-serif"}}>Ask AI about your spend data</div>
              <div style={{fontSize:13,color:T.textSub,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif"}}>Ask in plain language — answers are pulled from your actual tagged campaigns, not guessed.</div>
            </div>
            {composer}
            <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:16}}>
              {examples.map(ex=>(
                <button key={ex} onClick={()=>send(ex)} style={{textAlign:"left",padding:"10px 14px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,color:T.text,fontSize:13,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                  {ex}
                </button>
              ))}
            </div>
            {error&&<div style={{marginTop:14,padding:"10px 14px",borderRadius:10,background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,color:T.danger,fontSize:12,fontFamily:"'DM Sans',sans-serif"}}>{error}</div>}
          </div>
        </div>
      ):(
        <>
          <div ref={scrollRef} style={{flex:1,overflow:"auto",padding:"24px 0"}}>
            <div style={{maxWidth:720,margin:"0 auto",padding:"0 24px"}}>
              {messages.map((m,i)=>(
                <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:14}}>
                  <div style={{maxWidth:"80%",padding:"10px 14px",borderRadius:12,background:m.role==="user"?T.accent:T.surface,border:m.role==="user"?"none":`1px solid ${T.border}`,color:m.role==="user"?"#FFFFFF":T.text,fontSize:13,lineHeight:1.6,whiteSpace:"pre-wrap",fontFamily:"'DM Sans',sans-serif"}}>
                    {m.text}
                  </div>
                </div>
              ))}
              {loading&&(
                <div style={{display:"flex",justifyContent:"flex-start",marginBottom:14}}>
                  <div style={{padding:"10px 14px",borderRadius:12,background:T.surface,border:`1px solid ${T.border}`,color:T.textMuted,fontSize:13,fontFamily:"'DM Sans',sans-serif"}}>Thinking…</div>
                </div>
              )}
              {error&&<div style={{padding:"10px 14px",borderRadius:10,background:T.dangerBg,border:`1px solid ${T.dangerBorder}`,color:T.danger,fontSize:12,marginBottom:14,fontFamily:"'DM Sans',sans-serif"}}>{error}</div>}
            </div>
          </div>
          <div style={{borderTop:`1px solid ${T.border}`,padding:"14px 16px 18px",flexShrink:0}}>
            <div style={{maxWidth:720,margin:"0 auto"}}>{composer}</div>
          </div>
        </>
      )}
    </div>
    {sidebarPanel}
    {chatMenu}
    </>
  );
}
