import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { askAIRun, askAIBuildView, aiConfigToViewConfig, ASK_AI_MODELS, ASK_AI_DEFAULT_MODEL } from "../lib/askAI.js";
import { Inp, Btn, Sel, Icon, SectionLabel, MarkdownLite } from "./shared.jsx";
import aiScienceDroneIcon from "../assets/icons/ai-science-drone.png";

// Persisted across chats/sessions (2026-07-28, per Mo's model-picker request) — a per-browser
// preference, not a per-workspace/server one, same tier as e.g. a UI theme choice would be. Reads
// happen once at mount via useState's lazy initializer.
const ASK_AI_MODEL_STORAGE_KEY="bhq_askai_model";
function loadStoredModel(){
  try{
    const v=localStorage.getItem(ASK_AI_MODEL_STORAGE_KEY);
    return ASK_AI_MODELS.some(m=>m.value===v)?v:ASK_AI_DEFAULT_MODEL;
  }catch{return ASK_AI_DEFAULT_MODEL;}
}

// Client-side image resize/compress before it ever leaves the browser (2026-07-28, per Mo's
// screenshot-upload request) — a raw PNG screenshot can easily be several MB, and these get
// persisted into the chat's JSON history (server-side per-user storage), sent to Anthropic on
// every subsequent turn of the same conversation (full history is replayed each round — see
// askAIRun), and there can be several attached to one message. Downscaling to a sane max
// dimension and re-encoding as JPEG keeps a chat's storage/bandwidth footprint reasonable without
// perceptibly hurting the model's ability to read a dashboard screenshot or chart.
const ASK_AI_IMAGE_MAX_DIM=1400;
const ASK_AI_IMAGE_QUALITY=0.82;
const ASK_AI_MAX_IMAGES=4;
const ASK_AI_MAX_SOURCE_BYTES=12*1024*1024; // reject absurdly large source files before even trying to decode them
function resizeImageFile(file){
  return new Promise((resolve,reject)=>{
    if(file.size>ASK_AI_MAX_SOURCE_BYTES){reject(new Error(`${file.name||"Image"} is too large (max 12MB)`));return;}
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error("Couldn't read that image"));
    reader.onload=e=>{
      const img=new Image();
      img.onerror=()=>reject(new Error("Couldn't read that image"));
      img.onload=()=>{
        let{width,height}=img;
        if(width>ASK_AI_IMAGE_MAX_DIM||height>ASK_AI_IMAGE_MAX_DIM){
          const scale=ASK_AI_IMAGE_MAX_DIM/Math.max(width,height);
          width=Math.round(width*scale);height=Math.round(height*scale);
        }
        const canvas=document.createElement("canvas");
        canvas.width=width;canvas.height=height;
        canvas.getContext("2d").drawImage(img,0,0,width,height);
        resolve({mediaType:"image/jpeg",dataUrl:canvas.toDataURL("image/jpeg",ASK_AI_IMAGE_QUALITY)});
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// CSV/XLSX-as-context attach (2026-07-29, per Mo — "build them all" follow-up). Deliberately
// separate and lighter-weight than the app's real import pipeline (Campaign Tagger's CSV/XLSX
// import, Budget Manager's budget-file import): this is for "here's a one-off file, tell me about
// it" questions, not for getting the data into the workspace's actual budget/spend records — no
// tag mapping, no dedup, no header-row picker. The parsed rows become a capped plain-text preview
// sent as extra context alongside the question (see askAIRun's system prompt, which explicitly
// tells the model this text is NOT the workspace's real imported data). Reuses the same
// Papa.parse/XLSX.read option shapes core.js's parseFileToRows already uses elsewhere in the app,
// for consistency, not because the parsed shape needs to match anything downstream here.
const ASK_AI_MAX_DOCS=3;
const ASK_AI_DOC_MAX_ROWS=200; // capped independently of char count so a huge-column-count file doesn't blow up the stringify step before the char cap even applies
const ASK_AI_DOC_MAX_CHARS=20000;
const ASK_AI_DOC_MAX_SOURCE_BYTES=8*1024*1024;
function parseDataFile(file){
  return new Promise((resolve,reject)=>{
    if(file.size>ASK_AI_DOC_MAX_SOURCE_BYTES){reject(new Error(`${file.name||"File"} is too large (max 8MB)`));return;}
    const isExcel=/\.(xlsx|xls)$/i.test(file.name||"");
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error(`Couldn't read ${file.name||"that file"}`));
    reader.onload=e=>{
      try{
        let rows;
        if(isExcel){
          const wb=XLSX.read(new Uint8Array(e.target.result),{type:"array"});
          const ws=wb.Sheets[wb.SheetNames[0]];
          rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:"",raw:false});
        }else{
          rows=Papa.parse(String(e.target.result),{header:false,skipEmptyLines:true}).data;
        }
        rows=(rows||[]).map(row=>(row||[]).map(v=>String(v??"")));
        const totalRows=rows.length;
        let preview=rows.slice(0,ASK_AI_DOC_MAX_ROWS);
        let text=preview.map(r=>r.join(",")).join("\n");
        let truncated=totalRows>preview.length;
        if(text.length>ASK_AI_DOC_MAX_CHARS){text=text.slice(0,ASK_AI_DOC_MAX_CHARS);truncated=true;}
        resolve({name:file.name,text:`${totalRows} row${totalRows===1?"":"s"} total${truncated?" (showing a truncated preview below)":""}:\n${text}`});
      }catch{
        reject(new Error(`Couldn't parse ${file.name||"that file"} — is it a valid CSV or Excel file?`));
      }
    };
    if(isExcel)reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

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
export default function AskAI({T,session,mergedNormRows,tags,tagDims,budgetDims,budgets,budgetRowMeta,defaultForecastModel,hasData,askChats,setAskChats,askProjects,setAskProjects,activeAskChatId,setActiveAskChatId,sidebarEl,initialQuestion,onConsumeInitialQuestion,onSaveAsView}){
  // initialQuestion seeds input via a lazy initializer rather than an effect — correct here (not
  // just convenient) because this component and PacingDashboard's "Ask AI about this view" button
  // are mutually exclusive: the button only exists on view==="pacing", AskAI only renders on
  // view==="ask" (see BudgetHQ.jsx), so AskAI is ALWAYS unmounted at the moment the button is
  // clickable and freshly mounts when the tab switch lands here — this genuinely only needs to run
  // once, at construction, not react to a later prop change on an already-mounted instance.
  const[input,setInput]=useState(()=>initialQuestion||"");
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState("");
  const[historyOpen,setHistoryOpen]=useState(false);
  const[examples,setExamples]=useState(pickAskAIExamples);
  const[model,setModel]=useState(loadStoredModel);
  const[attachedImages,setAttachedImages]=useState([]); // [{mediaType,dataUrl}] — pending, not yet sent
  const[attachedDocs,setAttachedDocs]=useState([]); // [{name,text}] — pending CSV/XLSX context, not yet sent
  const[attachError,setAttachError]=useState("");
  const[recording,setRecording]=useState(false);
  const[copiedIdx,setCopiedIdx]=useState(null);
  const[openStepsIdx,setOpenStepsIdx]=useState(null);
  const[streamingText,setStreamingText]=useState(""); // live partial answer text while loading — see runTurn's onTextDelta
  const[editingUserIdx,setEditingUserIdx]=useState(null); // index into messages of the user turn currently being edited, or null
  const[editDraft,setEditDraft]=useState("");
  const[buildingViewIdx,setBuildingViewIdx]=useState(null); // index of the assistant message whose "Save as view" is in flight
  const[viewBuildError,setViewBuildError]=useState("");
  const scrollRef=useRef(null);
  const taRef=useRef(null);
  const fileInputRef=useRef(null);
  const recognitionRef=useRef(null);
  const abortRef=useRef(null);

  const activeChat=askChats.find(c=>c.id===activeAskChatId)||null;
  const messages=activeChat?.messages||[];

  useEffect(()=>{if(scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight;},[messages,loading]);
  useEffect(()=>{if(taRef.current){taRef.current.style.height="auto";taRef.current.style.height=Math.min(taRef.current.scrollHeight,140)+"px";}},[input]);
  useEffect(()=>{try{localStorage.setItem(ASK_AI_MODEL_STORAGE_KEY,model);}catch{/* private browsing etc. — not worth surfacing */}},[model]);
  // Stop any in-progress recording / in-flight request if the whole component unmounts (tab
  // switch) mid-way, rather than leaking a live mic stream or an orphaned fetch.
  useEffect(()=>()=>{recognitionRef.current?.stop();abortRef.current?.abort();},[]);

  // Clear the parent's pendingAskQuestion once we've picked it up (see the lazy initializer above)
  // so a later fresh mount of this same tab (navigate away and back without going through
  // PacingDashboard's button again) doesn't re-seed stale text — and focus the box so it's obvious
  // something showed up. Only calls the parent's setter + an imperative focus, no local setState,
  // so this effect isn't "syncing a prop into state" (that already happened above, once, at
  // construction) — just acknowledging the handoff.
  useEffect(()=>{
    if(initialQuestion){
      onConsumeInitialQuestion?.();
      taRef.current?.focus();
    }
  },[initialQuestion,onConsumeInitialQuestion]);

  const addFiles=useCallback(async(fileList)=>{
    const files=Array.from(fileList||[]);
    if(!files.length)return;
    setAttachError("");
    const imageFiles=files.filter(f=>f.type?.startsWith("image/"));
    const docFiles=files.filter(f=>!f.type?.startsWith("image/")&&/\.(csv|xlsx|xls)$/i.test(f.name||""));
    const imgRoom=ASK_AI_MAX_IMAGES-attachedImages.length;
    if(imageFiles.length&&imgRoom<=0)setAttachError(`Up to ${ASK_AI_MAX_IMAGES} images per message`);
    for(const file of imageFiles.slice(0,Math.max(0,imgRoom))){
      try{
        const img=await resizeImageFile(file);
        setAttachedImages(prev=>[...prev,img]);
      }catch(err){setAttachError(err.message);}
    }
    const docRoom=ASK_AI_MAX_DOCS-attachedDocs.length;
    if(docFiles.length&&docRoom<=0)setAttachError(`Up to ${ASK_AI_MAX_DOCS} files per message`);
    for(const file of docFiles.slice(0,Math.max(0,docRoom))){
      try{
        const doc=await parseDataFile(file);
        setAttachedDocs(prev=>[...prev,doc]);
      }catch(err){setAttachError(err.message);}
    }
  },[attachedImages.length,attachedDocs.length]);
  const removeAttachedImage=useCallback(i=>{setAttachedImages(prev=>prev.filter((_,idx)=>idx!==i));},[]);
  const removeAttachedDoc=useCallback(i=>{setAttachedDocs(prev=>prev.filter((_,idx)=>idx!==i));},[]);
  const handlePaste=useCallback(e=>{
    const items=Array.from(e.clipboardData?.items||[]);
    const imageItems=items.filter(it=>it.type?.startsWith("image/"));
    if(!imageItems.length)return;
    e.preventDefault();
    addFiles(imageItems.map(it=>it.getAsFile()).filter(Boolean));
  },[addFiles]);

  // Voice input (2026-07-28, per Mo). Browser-native Web Speech API — no backend involved, so
  // support is whatever the browser ships: solid in Chrome/Edge, absent in Firefox and most of
  // Safari, hence the hard support check gating whether the mic button renders at all rather than
  // rendering a button that silently does nothing.
  const speechSupported=typeof window!=="undefined"&&!!(window.SpeechRecognition||window.webkitSpeechRecognition);
  const toggleRecording=useCallback(()=>{
    if(!speechSupported)return;
    if(recording){recognitionRef.current?.stop();return;}
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    const rec=new SR();
    rec.lang="en-US";rec.interimResults=false;rec.maxAlternatives=1;
    rec.onresult=e=>{
      const transcript=Array.from(e.results).map(r=>r[0]?.transcript||"").join(" ").trim();
      if(transcript)setInput(prev=>(prev.trim()?prev.trim()+" ":"")+transcript);
    };
    rec.onerror=()=>setRecording(false);
    rec.onend=()=>setRecording(false);
    recognitionRef.current=rec;
    setRecording(true);
    rec.start();
  },[recording,speechSupported]);

  const copyMessage=useCallback((text,idx)=>{
    navigator.clipboard?.writeText(text).then(()=>{
      setCopiedIdx(idx);
      setTimeout(()=>setCopiedIdx(i=>i===idx?null:i),1500);
    }).catch(()=>{});
  },[]);

  const stopGenerating=useCallback(()=>{abortRef.current?.abort();},[]);

  const startNewChat=useCallback(()=>{setActiveAskChatId(null);setHistoryOpen(false);setExamples(pickAskAIExamples());setError("");setAttachedImages([]);setAttachError("");},[setActiveAskChatId]);
  const deleteChat=useCallback((id,e)=>{
    e?.stopPropagation();
    setAskChats(prev=>prev.filter(c=>c.id!==id));
    if(activeAskChatId===id)setActiveAskChatId(null);
  },[activeAskChatId,setAskChats,setActiveAskChatId]);

  // Shared core of every turn (2026-07-29, per Mo's "build them all" follow-up) — extracted out of
  // the old single-purpose `send` so regenerate/edit-and-resend can replay it against a truncated
  // prior history instead of duplicating the askAIRun-calling/state-updating logic. Every message
  // this writes (both the user turn and the assistant reply) records a `historyMark`: for the user
  // message it's priorHistory.length (the resume point BEFORE this turn — what resendFrom slices
  // back to when regenerating/editing this exact turn), for the assistant message it's
  // finalHistory.length (the resume point AFTER this turn — what a later edit of a LATER message
  // slices back to). Docs are folded into the question text as clearly-marked extra context per
  // askAIRun's system prompt, rather than becoming their own content blocks like images — there's
  // no "document" block type in the images/text vision shape this already uses.
  const runTurn=useCallback(async({chatId,priorMessages,priorHistory,questionText,imgs,docs})=>{
    const docsText=(docs||[]).map(d=>`\n\n[Attached file: ${d.name}]\n${d.text}`).join("");
    const newMessages=[...priorMessages,{role:"user",text:questionText,...(imgs?.length?{images:imgs}:{}),...(docs?.length?{docs}:{}),historyMark:priorHistory.length}];
    setAskChats(prev=>prev.map(c=>c.id===chatId?{...c,messages:newMessages,updatedAt:Date.now()}:c));
    setLoading(true);
    setStreamingText("");
    // Images attach as their own content blocks ahead of the text block, per Anthropic's vision
    // message shape — askAIRun passes this straight through to /api/analyze untouched (see its own
    // doc comment: it stays a dumb pass-through for anything content-block-shaped) rather than
    // needing to know anything about File objects or canvas resizing itself.
    const questionContent=imgs?.length
      ?[...imgs.map(img=>({type:"image",source:{type:"base64",media_type:img.mediaType,data:img.dataUrl.split(",")[1]}})),{type:"text",text:(questionText||"What's in this image?")+docsText}]
      :(questionText||"")+docsText;
    const controller=new AbortController();
    abortRef.current=controller;
    try{
      const{answer,messages:newHistory,steps,usage}=await askAIRun({question:questionContent,history:priorHistory,ctx:{mergedNormRows,tags,tagDims,budgetDims,budgets,budgetRowMeta,defaultForecastModel},model,signal:controller.signal,onTextDelta:setStreamingText,token:session?.access_token});
      const finalHistory=[...newHistory,{role:"assistant",content:answer}];
      const finalMessages=[...newMessages,{role:"assistant",text:answer,steps,usage,historyMark:finalHistory.length}];
      setAskChats(prev=>prev.map(c=>c.id===chatId?{...c,messages:finalMessages,history:finalHistory,updatedAt:Date.now()}:c));
    }catch(err){
      // A user-initiated Stop shows up as an AbortError — that's not a failure worth an error
      // banner, just quietly stop (the question the user sent stays visible in the thread so
      // they can see what went out, they just won't get a reply for it).
      if(err.name!=="AbortError")setError(err.message);
    }finally{
      setLoading(false);
      setStreamingText("");
      abortRef.current=null;
    }
  },[mergedNormRows,tags,tagDims,budgetDims,budgets,budgetRowMeta,defaultForecastModel,model,setAskChats,session]);

  const send=useCallback(async(question)=>{
    const q=(question||input).trim();
    const imgs=attachedImages;
    const docs=attachedDocs;
    if((!q&&!imgs.length)||loading)return;
    setInput("");setError("");setAttachedImages([]);setAttachedDocs([]);setAttachError("");
    let chatId=activeAskChatId;
    let priorMessages=[];
    let priorHistory=[];
    if(chatId){
      const existing=askChats.find(c=>c.id===chatId);
      priorMessages=existing?.messages||[];
      priorHistory=existing?.history||[];
    }else{
      chatId=`chat_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const title=q?(q.length>60?q.slice(0,57)+"…":q):"(image)";
      setAskChats(prev=>[{id:chatId,title,messages:[],history:[],updatedAt:Date.now(),pinned:false,projectId:null,labels:[]},...prev]);
      setActiveAskChatId(chatId);
    }
    await runTurn({chatId,priorMessages,priorHistory,questionText:q,imgs,docs});
  },[input,attachedImages,attachedDocs,loading,activeAskChatId,askChats,setAskChats,setActiveAskChatId,runTurn]);

  // Regenerate (same question, fresh answer) and edit-and-resend (changed question, fresh answer)
  // share this one function — both mean "throw away everything from this user turn onward and
  // replay it" — reached from a user message's Edit button (newText=the edited draft) or an
  // assistant message's Regenerate button (newText=null, meaning "keep the original text/
  // images/docs unchanged"). Slices both the visible messages array and the Anthropic-format
  // history array back to userMsg's own historyMark (recorded when that turn originally ran — see
  // runTurn), so the resend is indistinguishable from that turn never having happened.
  const resendFrom=useCallback((userIdx,newText)=>{
    if(loading)return;
    const chatId=activeAskChatId;
    if(!chatId)return;
    const existing=askChats.find(c=>c.id===chatId);
    if(!existing)return;
    const userMsg=existing.messages[userIdx];
    if(!userMsg||userMsg.role!=="user")return;
    const priorMessages=existing.messages.slice(0,userIdx);
    const priorHistory=(existing.history||[]).slice(0,userMsg.historyMark||0);
    const questionText=newText!=null?newText:(userMsg.text||"");
    runTurn({chatId,priorMessages,priorHistory,questionText,imgs:userMsg.images,docs:userMsg.docs});
  },[loading,activeAskChatId,askChats,runTurn]);

  // "Save as view" (2026-07-29, per Mo — reuses the exact askAIBuildView/aiConfigToViewConfig
  // pipeline PacingDashboard's own "✨ Ask AI to build a view" box already drives, so a chat answer
  // and that box can never resolve the same plain-English request into different configs). Re-asks
  // the ORIGINAL question that produced this answer (the preceding user turn) through the
  // view-building tool loop rather than trying to parse a View-by config out of the chat's prose
  // answer, then hands the resolved config up to the parent via onSaveAsView — same one-shot relay
  // pattern as the pendingAskQuestion flow already uses, just in the opposite direction (AskAI ->
  // PacingDashboard instead of PacingDashboard -> AskAI).
  const handleSaveAsView=useCallback(async assistantIdx=>{
    if(!onSaveAsView)return;
    const existing=askChats.find(c=>c.id===activeAskChatId);
    const userMsg=existing?.messages?.[assistantIdx-1];
    const q=(userMsg?.text||"").trim();
    if(!q){setViewBuildError("Couldn't find a question to build a view from.");return;}
    setBuildingViewIdx(assistantIdx);setViewBuildError("");
    try{
      const allDimOptions=["Platform","Campaign","Ad Group",...tagDims];
      const raw=await askAIBuildView({question:q,ctx:{mergedNormRows,tags,tagDims,budgetDims,budgets,budgetRowMeta},token:session?.access_token});
      const canonical=aiConfigToViewConfig(raw,{allDimOptions,budgetDims});
      onSaveAsView(canonical);
    }catch(err){
      setViewBuildError(err.message||"Couldn't build a view from this.");
    }finally{
      setBuildingViewIdx(null);
    }
  },[askChats,activeAskChatId,tagDims,mergedNormRows,tags,budgetDims,budgets,budgetRowMeta,onSaveAsView,session]);

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

  // Composer (2026-07-28, per Mo — image attach/paste, voice input, stop-generating). Attach and
  // mic sit to the left of the textarea rather than crowding the send button on the right, since
  // both are "add something before you send" actions, not send-adjacent ones. The send button
  // itself swaps to a Stop (square) icon while a request is in flight, same position — one button,
  // two meanings depending on state, rather than two separate buttons fighting for that spot.
  const canSend=(input.trim()||attachedImages.length>0)&&!loading;
  const composer=(
    <div style={{display:"flex",flexDirection:"column",gap:0,background:T.surface,border:`1px solid ${T.borderStrong}`,borderRadius:22,padding:"8px 8px 8px 12px",boxShadow:T.shadowMd}}>
      {(attachedImages.length>0||attachedDocs.length>0)&&(
        <div style={{display:"flex",gap:6,flexWrap:"wrap",padding:"4px 8px 8px"}}>
          {attachedImages.map((img,i)=>(
            <div key={`img_${i}`} style={{position:"relative",width:52,height:52,borderRadius:8,overflow:"hidden",border:`1px solid ${T.border}`,flexShrink:0}}>
              <img src={img.dataUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
              <button onClick={()=>removeAttachedImage(i)} title="Remove"
                style={{position:"absolute",top:1,right:1,width:16,height:16,borderRadius:"50%",background:"rgba(0,0,0,0.65)",border:"none",color:"#fff",fontSize:10,lineHeight:1,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>✕</button>
            </div>
          ))}
          {attachedDocs.map((doc,i)=>(
            <div key={`doc_${i}`} title={doc.name} style={{display:"flex",alignItems:"center",gap:5,height:30,padding:"0 8px",borderRadius:8,border:`1px solid ${T.border}`,background:T.surfaceEl,flexShrink:0,maxWidth:160}}>
              <span style={{fontSize:11,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'DM Sans',sans-serif"}}>{doc.name}</span>
              <button onClick={()=>removeAttachedDoc(i)} title="Remove"
                style={{width:14,height:14,borderRadius:"50%",background:"transparent",border:"none",color:T.textMuted,fontSize:10,lineHeight:1,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,flexShrink:0}}>✕</button>
            </div>
          ))}
        </div>
      )}
      {attachError&&<div style={{padding:"0 8px 6px",fontSize:11,color:T.danger}}>{attachError}</div>}
      <div style={{display:"flex",alignItems:"flex-end",gap:6}}>
        <input ref={fileInputRef} type="file" accept="image/*,.csv,.xlsx,.xls" multiple style={{display:"none"}}
          onChange={e=>{addFiles(e.target.files);e.target.value="";}}/>
        <button onClick={()=>fileInputRef.current?.click()} disabled={loading||(attachedImages.length>=ASK_AI_MAX_IMAGES&&attachedDocs.length>=ASK_AI_MAX_DOCS)} title="Attach an image or a CSV/Excel file for context"
          style={{width:32,height:32,borderRadius:"50%",background:"transparent",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:loading?"default":"pointer",flexShrink:0,opacity:loading||(attachedImages.length>=ASK_AI_MAX_IMAGES&&attachedDocs.length>=ASK_AI_MAX_DOCS)?0.35:1}}>
          <Icon name="paperclip" size={17} color={T.textMuted}/>
        </button>
        {speechSupported&&(
          <button onClick={toggleRecording} disabled={loading} title={recording?"Stop recording":"Speak your question"}
            style={{width:32,height:32,borderRadius:"50%",background:recording?T.dangerBg:"transparent",border:recording?`1px solid ${T.dangerBorder}`:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:loading?"default":"pointer",flexShrink:0,opacity:loading?0.35:1,animation:recording?"bhqPulse 1.1s ease-in-out infinite":"none"}}>
            <Icon name="mic" size={17} color={recording?T.danger:T.textMuted}/>
          </button>
        )}
        <textarea
          ref={taRef}
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
          onPaste={handlePaste}
          placeholder={recording?"Listening…":"Ask about your spend data…"}
          rows={1}
          style={{flex:1,resize:"none",border:"none",outline:"none",background:"transparent",color:T.text,fontSize:15,lineHeight:1.55,fontFamily:"'DM Sans',sans-serif",padding:"8px 0",maxHeight:140,overflow:"auto"}}
        />
        <button onClick={loading?stopGenerating:()=>send()} disabled={!loading&&!canSend}
          title={loading?"Stop":"Send"}
          style={{width:36,height:36,borderRadius:"50%",background:loading?T.text:canSend?T.accent:T.surfaceEl,border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:loading||canSend?"pointer":"default",flexShrink:0,transition:"background 0.15s"}}>
          <Icon name={loading?"stop":"send"} size={loading?14:16} color={loading||canSend?"#FFFFFF":T.textMuted}/>
        </button>
      </div>
    </div>
  );

  return(
    <>
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:T.bg}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 24px",borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
        <div style={{fontSize:13,fontWeight:700,color:T.text,display:"flex",alignItems:"center",gap:6,fontFamily:"'DM Sans',sans-serif"}}>
          <Icon name="sparkle" size={15} color={T.text}/> Ask AI
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",position:"relative"}}>
          {/* Model picker (2026-07-28, per Mo — "can we allow users to switch models from Sonnet
              to Opus, etc.") — persisted per-browser (see loadStoredModel), applies to the NEXT
              message sent in this chat, not retroactively to earlier turns in the same
              conversation. title carries each option's tradeoff since a plain dropdown label
              alone ("Opus") doesn't explain when you'd want it. */}
          <Sel value={model} onChange={setModel} T={T} style={{width:110}} title={ASK_AI_MODELS.find(m=>m.value===model)?.hint}>
            {ASK_AI_MODELS.map(m=><option key={m.value} value={m.value} title={m.hint}>{m.label}</option>)}
          </Sel>
          <span style={{width:1,alignSelf:"stretch",background:T.border}}/>
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
              {/* AI-science-drone illustration (2026-07-26, per Mo, licensed "Geometric Space
                  Collection 2.0" set) — a literal AI-themed bot for the AI-themed empty state. */}
              <img src={aiScienceDroneIcon} alt="" aria-hidden="true" style={{width:110,height:"auto",marginBottom:14}}/>
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
              {messages.map((m,i)=>{
                const isUser=m.role==="user";
                const hasSteps=!isUser&&m.steps?.length>0;
                const stepsOpen=openStepsIdx===i;
                const isEditingThis=isUser&&editingUserIdx===i;
                const totalTokens=!isUser&&m.usage?(m.usage.inputTokens||0)+(m.usage.outputTokens||0):0;
                return(
                <div key={i} style={{display:"flex",flexDirection:"column",alignItems:isUser?"flex-end":"flex-start",marginBottom:14}}>
                  {isEditingThis?(
                    <div style={{maxWidth:"80%",width:"100%",display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
                      <textarea autoFocus value={editDraft} onChange={e=>setEditDraft(e.target.value)}
                        rows={Math.min(8,Math.max(2,(editDraft.match(/\n/g)||[]).length+1))}
                        style={{width:"100%",resize:"vertical",padding:"10px 14px",borderRadius:12,border:`1px solid ${T.accentBorder}`,background:T.inputBg,color:T.text,fontSize:13,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif",outline:"none",boxSizing:"border-box"}}/>
                      <div style={{display:"flex",gap:6}}>
                        <Btn onClick={()=>setEditingUserIdx(null)} variant="ghost" size="sm" T={T}>Cancel</Btn>
                        <Btn onClick={()=>{const t=editDraft.trim();setEditingUserIdx(null);if(t)resendFrom(i,t);}} variant="primary" size="sm" T={T}>Save &amp; submit</Btn>
                      </div>
                    </div>
                  ):(
                    <div style={{maxWidth:"80%",padding:"10px 14px",borderRadius:12,background:isUser?T.accent:T.surface,border:isUser?"none":`1px solid ${T.border}`,color:isUser?"#FFFFFF":T.text,fontSize:13,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif"}}>
                      {m.images?.length>0&&(
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:(m.text||m.docs?.length)?8:0}}>
                          {m.images.map((img,ii)=><img key={ii} src={img.dataUrl} alt="" style={{width:120,height:120,objectFit:"cover",borderRadius:8,display:"block"}}/>)}
                        </div>
                      )}
                      {m.docs?.length>0&&(
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:m.text?8:0}}>
                          {m.docs.map((doc,ii)=>(
                            <div key={ii} title={doc.name} style={{display:"flex",alignItems:"center",gap:5,padding:"4px 9px",borderRadius:8,background:isUser?"rgba(255,255,255,0.18)":T.surfaceEl,border:isUser?"none":`1px solid ${T.border}`,maxWidth:180}}>
                              <Icon name="paperclip" size={11} color={isUser?"#FFFFFF":T.textMuted}/>
                              <span style={{fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{doc.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {isUser?<div style={{whiteSpace:"pre-wrap"}}>{m.text}</div>:<MarkdownLite text={m.text} T={T}/>}
                    </div>
                  )}
                  {/* Edit-and-resend (user turns) / Copy + regenerate + save-as-view + "what I
                      checked" trace + usage (assistant turns) — 2026-07-29, per Mo's "build them
                      all" follow-up. Sits just under the bubble rather than inside it, same
                      convention as Claude's own desktop app, so it doesn't compete with the
                      answer text. */}
                  {isUser&&!isEditingThis&&!loading&&(
                    <button onClick={()=>{setEditingUserIdx(i);setEditDraft(m.text||"");}} title="Edit & resend"
                      style={{display:"flex",alignItems:"center",gap:4,marginTop:4,background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11,padding:"2px 4px",fontFamily:"'DM Sans',sans-serif"}}>
                      <Icon name="pencil" size={11} color={T.textMuted}/> Edit
                    </button>
                  )}
                  {!isUser&&m.text&&(
                    <div style={{display:"flex",alignItems:"center",gap:10,marginTop:4,paddingLeft:2,flexWrap:"wrap"}}>
                      <button onClick={()=>copyMessage(m.text,i)} title="Copy"
                        style={{display:"flex",alignItems:"center",gap:4,background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11,padding:"2px 4px",fontFamily:"'DM Sans',sans-serif"}}>
                        <Icon name={copiedIdx===i?"check":"copy"} size={12} color={T.textMuted}/> {copiedIdx===i?"Copied":"Copy"}
                      </button>
                      {!loading&&(
                        <button onClick={()=>resendFrom(i-1)} title="Regenerate response"
                          style={{display:"flex",alignItems:"center",gap:4,background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11,padding:"2px 4px",fontFamily:"'DM Sans',sans-serif"}}>
                          <Icon name="refresh" size={11} color={T.textMuted}/> Regenerate
                        </button>
                      )}
                      {onSaveAsView&&(
                        <button onClick={()=>handleSaveAsView(i)} disabled={buildingViewIdx===i} title="Turn this question into a Reporting & Pacing view"
                          style={{display:"flex",alignItems:"center",gap:4,background:"transparent",border:"none",color:buildingViewIdx===i?T.textMuted:T.accent,cursor:buildingViewIdx===i?"default":"pointer",fontSize:11,padding:"2px 4px",fontFamily:"'DM Sans',sans-serif"}}>
                          <Icon name="sparkle" size={11} color={buildingViewIdx===i?T.textMuted:T.accent}/> {buildingViewIdx===i?"Building view…":"Save as view"}
                        </button>
                      )}
                      {hasSteps&&(
                        <button onClick={()=>setOpenStepsIdx(stepsOpen?null:i)}
                          style={{display:"flex",alignItems:"center",gap:4,background:"transparent",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11,padding:"2px 4px",fontFamily:"'DM Sans',sans-serif"}}>
                          <Icon name="chevronDown" size={11} color={T.textMuted} style={{transform:stepsOpen?"rotate(180deg)":"none",transition:"transform 0.12s"}}/>
                          What I checked ({m.steps.length})
                        </button>
                      )}
                      {totalTokens>0&&(
                        <span title={`${(m.usage.inputTokens||0).toLocaleString()} in / ${(m.usage.outputTokens||0).toLocaleString()} out`}
                          style={{fontSize:10.5,color:T.textMuted,fontFamily:"'DM Sans',sans-serif"}}>
                          {totalTokens.toLocaleString()} tokens
                        </span>
                      )}
                    </div>
                  )}
                  {!isUser&&i===messages.length-1&&viewBuildError&&(
                    <div style={{maxWidth:"80%",marginTop:6,fontSize:11,color:T.danger,fontFamily:"'DM Sans',sans-serif"}}>{viewBuildError}</div>
                  )}
                  {hasSteps&&stepsOpen&&(
                    <div style={{maxWidth:"80%",marginTop:6,display:"flex",flexDirection:"column",gap:6}}>
                      {m.steps.map((s,si)=>(
                        <div key={si} style={{padding:"8px 10px",borderRadius:8,background:T.surfaceEl,border:`1px solid ${T.border}`,fontSize:11,fontFamily:"monospace",color:T.textSub,overflow:"auto"}}>
                          <div style={{fontWeight:700,color:T.text,marginBottom:3}}>{s.tool}({JSON.stringify(s.input)})</div>
                          <div style={{whiteSpace:"pre-wrap",wordBreak:"break-word"}}>→ {JSON.stringify(s.output)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );})}
              {loading&&(
                <div style={{display:"flex",justifyContent:"flex-start",marginBottom:14}}>
                  <div style={{maxWidth:"80%",padding:"10px 14px",borderRadius:12,background:T.surface,border:`1px solid ${T.border}`,color:T.text,fontSize:13,lineHeight:1.6,fontFamily:"'DM Sans',sans-serif"}}>
                    {streamingText?<MarkdownLite text={streamingText} T={T}/>:<span style={{color:T.textMuted}}>Thinking…</span>}
                  </div>
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
