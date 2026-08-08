import { useState, useCallback, useMemo } from "react";
import { aiSummarizeBudgetPacing } from "../lib/askAI.js";

// src/components/shared.jsx — Small shared UI primitives used across the four tab components
// (2026-07-25 split, per Mo). Everything here takes T (the active theme) as a prop rather than
// importing THEME directly — THEME itself lives in lib/core.js and is imported once at the
// root, then threaded down, same as before this split. AISummaryCard lives here too (not its
// own file) since it's used by both BudgetManager and PacingDashboard and is small.

export const SectionLabel=({children,T,style={}})=>(<div style={{fontSize:10*(T.fsScale||1),fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted,marginBottom:6,...style}}>{children}</div>);
// No T prop here on purpose — bg/color/border are always passed explicitly by the caller (there
// are ~40 call sites across every tab), and r20 is one of the two radius tokens that's identical
// in both THEME_CLASSIC and THEME_AIDA (see core.js's RADIUS_AIDA comment), so a plain literal is
// exactly equivalent to T.r20 in either theme without threading T through every call site.
// No T prop here (unlike every other shared component) — Pill is called from many places that
// don't have a theme object handy at the call site (small inline status badges). fontSize stays
// a plain literal rather than T.fsScale-driven like everything else in this file; low-priority
// to fix given how small/secondary this text already is.
export const Pill=({children,color,bg,border,style,...rest})=>(<span style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:500,padding:"2px 9px",borderRadius:20,background:bg,color,border:`1px solid ${border}`,whiteSpace:"nowrap",...style}} {...rest}>{children}</span>);
// Real brand mark for a connector card (2026-07-24, per Mo — "Add data source" cards used to just
// show a plain colored dot next to the platform name; real logos read as much more polished).
//
// Tried Simple Icons' keyless CDN (cdn.simpleicons.org/<slug>) first, but its catalog turned out to
// be missing 6 of our 9 platforms entirely (LinkedIn, Bing, Capterra, Funnel.io, Supermetrics, and
// Microsoft Excel aren't in it at all — Simple Icons has removed several major brands over the years,
// apparently over trademark requests), and forcing the one Simple Icons DID have (Google Ads) into a
// single flat color lost enough of its real look to read as wrong.
//
// This pulls each platform's actual favicon straight from its own domain instead, via Google's
// public favicon endpoint (google.com/s2/favicons) — keyless, no signup, and since it's fetched live
// from the real site it's automatically in that brand's real (multi-)color, current at all times, and
// works for literally any domain (no per-brand catalog to be missing from). Lower resolution than a
// hand-vectored logo, but at the ~17px this renders at that isn't visible, and it beats a plain dot.
// Falls back to the original plain colored dot for platforms with no `domain` at all (the manual
// CSV/Screenshot/Budget file cards aren't real brands) and, via onError, for any fetch that fails —
// so this never looks worse than the pre-logo treatment even if Google's endpoint hiccups.
// Neutral tile background behind every favicon — favicons vary wildly in whether they include their
// own padding/background, so a fixed light-neutral square keeps the grid visually even regardless.
export const T_LOGO_BG="#F1F3F5";
// Hand-vectored marks for platforms where the live favicon didn't hold up (2026-07-24, per Mo, who
// flagged both against reference images of the real logos). Real vector data, not a redraw from
// memory, so these should be pixel-faithful to the current official marks:
//   Google Ads — the current (2018-) triangular "A" mark IS just three flat shapes (two diagonal
//   rounded bars + a circle), so this is built directly from that geometry — two round-capped
//   <line>s (a straight line with stroke-linecap="round" draws exactly the same rounded-bar shape
//   a hand-vectored path would, without needing bezier data) plus a <circle>, in Google's own brand
//   blue/yellow/green.
//   Bing — genuinely irregular (a folded-ribbon "b"), so freehand redrawing it risked being subtly
//   off the way the favicon was. Used the exact path data Bing itself ships on bing.com instead
//   (viewBox 0 0 35 50, two paths — the second at reduced opacity for the fold crease), recolored
//   from bing.com's white-on-teal original into Bing's teal directly, for use on a light background.
export const GoogleAdsMark=({size=18})=>(
  <svg viewBox="0 0 100 100" width={size} height={size}>
    <circle cx="19" cy="84" r="15" fill="#34A853"/>
    <line x1="50" y1="10" x2="19" y2="84" stroke="#FBBC04" strokeWidth="26" strokeLinecap="round"/>
    <line x1="50" y1="10" x2="86" y2="82" stroke="#4285F4" strokeWidth="26" strokeLinecap="round"/>
  </svg>
);
export const BingMark=({size=18,color="#00809D"})=>(
  <svg viewBox="0 0 35 50" width={size} height={size}>
    <path d="M35 24.25l-22.177-7.761 4.338 10.82 6.923 3.225H35V24.25z" fill={color} opacity=".72"/>
    <path d="M10 38.642V3.5L0 0v44.4L10 50l25-14.382V24.25z" fill={color}/>
  </svg>
);
// Generic (non-branded) marks for the manual-import cards on the "Add data source" grid — CSV,
// Screenshot, Budget file. These don't have a real company/domain to pull a favicon from, so
// PlatformLogo was falling back to a plain solid-color square for them. Outline style matches the
// rest of the app's Icon() set (24x24 viewBox, 1.8 stroke) rather than the flat brand-color fills
// used by GoogleAdsMark/BingMark above, since these represent a file type/action, not a company.
export const CsvMark=({size=18,color="#0F9D58"})=>(
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="1.5"/>
    <path d="M3 9h18M3 15h18M9 4v16M15 4v16"/>
  </svg>
);
export const ScreenshotMark=({size=18,color="#6366F1"})=>(
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8V6a2 2 0 0 1 2-2h2M4 16v2a2 2 0 0 0 2 2h2M20 8V6a2 2 0 0 0-2-2h-2M20 16v2a2 2 0 0 1-2 2h-2"/>
    <circle cx="12" cy="12" r="3.2"/>
  </svg>
);
export const BudgetFileMark=({size=18,color="#F59E0B"})=>(
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/>
    <path d="M14 3v5h5"/>
    <path d="M9 13.5c0-.9.9-1.5 2-1.5h1c1.1 0 2 .6 2 1.5S13.1 15 12 15h0c-1.1 0-2 .6-2 1.5s.9 1.5 2 1.5h1c1.1 0 2-.6 2-1.5"/>
    <path d="M12 11v1M12 17v1"/>
  </svg>
);
export const PlatformLogo=({domain,color,mark:Mark,size=28,T})=>{
  const[failed,setFailed]=useState(false);
  const r=T?T.r8:8;
  if(Mark){
    return(
      <span style={{width:size,height:size,borderRadius:r,background:T_LOGO_BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,overflow:"hidden"}}>
        <Mark size={Math.round(size*0.62)}/>
      </span>
    );
  }
  if(!domain||failed){
    return<span style={{width:size,height:size,borderRadius:r,background:color,flexShrink:0,display:"inline-block"}}/>;
  }
  return(
    <span style={{width:size,height:size,borderRadius:r,background:T_LOGO_BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,overflow:"hidden"}}>
      <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`} alt="" width={Math.round(size*0.62)} height={Math.round(size*0.62)}
        onError={()=>setFailed(true)} style={{display:"block"}}/>
    </span>
  );
};
// Flat, mostly-invisible-until-hover buttons — VaultHQ/Notion treatment. No shadows anywhere;
// "primary" is the only filled variant, "subtle" (filled with surfaceEl, no border) is the
// default choice for secondary actions, "ghost" and "danger" are transparent/bordered.
export const Btn=({children,onClick,variant="ghost",size="sm",disabled,T,style={}})=>{
  const s={sm:{padding:"6px 14px",fontSize:12*(T.fsScale||1)},md:{padding:"8px 18px",fontSize:13*(T.fsScale||1)},lg:{padding:"10px 24px",fontSize:14*(T.fsScale||1)}};
  const v={
    primary:{background:T.accent,color:T.onAccent,border:"1px solid transparent"},
    ghost:{background:"transparent",color:T.text,border:`1px solid ${T.border}`},
    subtle:{background:T.surfaceEl,color:T.text,border:"1px solid transparent"},
    success:{background:"transparent",color:T.success,border:`1px solid ${T.successBorder}`},
    danger:{background:"transparent",color:T.danger,border:`1px solid ${T.dangerBorder}`},
  };
  return <button className="bhq-btn" disabled={disabled} onClick={disabled?undefined:onClick} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,borderRadius:T.r6,cursor:disabled?"not-allowed":"pointer",fontWeight:500,transition:"background 0.1s",fontFamily:T.font,boxShadow:"none",opacity:disabled?0.5:1,...s[size],...v[variant],...style}}>{children}</button>;
};
export const Inp=({value,onChange,placeholder,T,style={},onKeyDown})=>(<input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} onKeyDown={onKeyDown} style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"6px 10px",fontSize:12*(T.fsScale||1),outline:"none",fontFamily:T.font,width:"100%",transition:"border-color 0.12s",...style}}/>);
// Forces a "name this file" step before an upload proceeds (2026-08-06, per Mo — "force the user
// to rename (or save the same name) upon import" so every file saved into File Store is findable
// under something recognizable later, not whatever the source system happened to export it as).
// Used by every real file-import entry point (spend CSV/XLSX, tag CSV, budget CSV/XLSX, pipeline
// CSV/XLSX) right after a file is picked, before it's archived/parsed — see PaidHQ.jsx's
// promptAndArchiveFile, the one shared choke point every one of those entry points now routes
// through. Deliberately generic/reusable (no import-flow-specific logic lives here) so
// BudgetManager.jsx's own separate file input can use the exact same modal via a prop from its
// parent rather than duplicating this UI.
// Callers should pass a `key` that changes every time a NEW prompt opens (e.g. keyed off which
// file is being named) — this component resets its own `name` state by remounting rather than by
// syncing a prop into state inside an effect (the latter trips react-hooks/set-state-in-effect and
// causes an extra render besides).
export const NameFileModal=({T,open,defaultName,onConfirm,onCancel})=>{
  const[name,setName]=useState(defaultName||"");
  if(!open)return null;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:600,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{width:420,maxWidth:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r8,boxShadow:T.shadowMd,fontFamily:T.font}}>
        <div style={{padding:"16px 20px",borderBottom:`1px solid ${T.border}`,fontSize:15*(T.fsScale||1),fontWeight:700,color:T.text}}>Name this file</div>
        <div style={{padding:20}}>
          <div style={{fontSize:12*(T.fsScale||1),color:T.textSub,marginBottom:10,lineHeight:1.5}}>Saved to File Store so you can find and reapply it later — keep the suggested name or give it something you'll recognize.</div>
          <input autoFocus value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&name.trim())onConfirm(name.trim());}}
            style={{width:"100%",boxSizing:"border-box",background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:T.text,padding:"8px 10px",fontSize:13*(T.fsScale||1),outline:"none",fontFamily:T.font}}/>
        </div>
        <div style={{padding:"14px 20px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end",gap:8}}>
          <Btn onClick={onCancel} variant="ghost" T={T}>Cancel</Btn>
          <Btn onClick={()=>name.trim()&&onConfirm(name.trim())} variant="primary" T={T} disabled={!name.trim()}>Continue</Btn>
        </div>
      </div>
    </div>
  );
};
export const Sel=({value,onChange,children,T,style={},...rest})=>(<select value={value} onChange={e=>onChange(e.target.value)} style={{background:T.inputBg,border:`1px solid ${T.border}`,borderRadius:T.r6,color:value?T.text:T.textMuted,padding:"6px 10px",fontSize:12*(T.fsScale||1),outline:"none",cursor:"pointer",fontFamily:T.font,width:"100%",...style}} {...rest}>{children}</select>);
// stopPropagation on both: several call sites wrap these in a parent <div> that has its own
// onClick doing the same toggle (for a bigger click target). Without stopping propagation here,
// clicking directly on the switch/checkbox fires both handlers and the toggle cancels itself out.
export const Tog=({value,onChange,T})=>(<div onClick={e=>{e.stopPropagation();onChange(!value);}} style={{width:30,height:17,borderRadius:T.r9,background:value?T.accent:T.borderStrong,position:"relative",cursor:"pointer",transition:"background 0.2s",flexShrink:0}}><div style={{position:"absolute",top:2,left:value?15:2,width:13,height:13,borderRadius:T.r7,background:"#fff",transition:"left 0.18s",boxShadow:"0 1px 3px rgba(0,0,0,0.25)"}}/></div>);
export const Chk=({checked,onChange,T})=>(<div onClick={e=>{e.stopPropagation();onChange();}} style={{width:15,height:15,borderRadius:T.r4,border:`1.5px solid ${checked?T.accent:T.borderStrong}`,background:checked?T.accent:"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0,transition:"all 0.12s"}}>{checked&&<svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke={T.text} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}</div>);
export const StatRow=({label,value,color,T,size=12,valueStyle})=>(<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0"}}><span style={{fontSize:size,color:T.textSub}}>{label}</span><span style={{fontSize:size,fontFamily:T.font,fontWeight:600,color:color||T.text,...valueStyle}}>{value}</span></div>);
// Big label/value card used by the populated Dashboard's summary row (Total budget/Spend/Pacing/
// Needs attention) — bigger type than StatRow since these are the headline numbers of the page.
// `sub`/`subColor` are optional — a small second line under the headline value, used for context
// that isn't worth its own tile (expected-pace vs actual, period-over-period delta). Omitted
// entirely (not even an empty reserved slot) when not passed, so plain tiles keep their original
// compact height.
export const DashStatTile=({label,value,valueColor,sub,subColor,T,variant})=>(
  <PixelPanel T={T} variant={variant} contentStyle={{padding:T.cardPad||"14px 16px"}}>
    <div style={{fontSize:10*(T.fsScale||1),fontWeight:700,color:T.textMuted,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:6,fontFamily:T.font}}>{label}</div>
    <div style={{fontSize:20*(T.fsScale||1),fontWeight:800,color:valueColor||T.text,fontFamily:T.font}}>{value}</div>
    {sub&&<div style={{fontSize:11*(T.fsScale||1),fontWeight:600,color:subColor||T.textMuted,marginTop:4,fontFamily:T.font}}>{sub}</div>}
  </PixelPanel>
);
// Single-period spend-vs-budget bar for the Dashboard. Replaced an earlier trailing-period trend
// chart that fell apart for any workspace without months of synced spend history (dashed budget
// markers floating over near-invisible bars, since most workspaces only have the current period
// actually synced) — this only ever looks at the one period that's guaranteed to have real numbers.
export const SpendVsBudgetBar=({T,spend,budget,fmtFull})=>{
  if(!budget)return<div style={{fontSize:12*(T.fsScale||1),color:T.textSub,lineHeight:1.6,fontFamily:T.font}}>No budget set for this period.</div>;
  const pct=spend/budget;
  const fillPct=Math.min(100,pct*100);
  const over=pct>1;
  return(
    <div>
      <div style={{position:"relative",height:14,borderRadius:T.r7,background:T.pill,overflow:"hidden"}}>
        <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${fillPct}%`,background:over?T.danger:T.accent,borderRadius:T.r7,transition:"width 0.2s"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginTop:9,fontFamily:T.font}}>
        <span style={{fontSize:15*(T.fsScale||1),fontWeight:800,color:over?T.danger:T.text}}>{fmtFull(spend)}</span>
        <span style={{fontSize:12*(T.fsScale||1),color:T.textMuted}}>of {fmtFull(budget)} · {Math.round(pct*100)}%</span>
      </div>
    </div>
  );
};
// Spend-by-platform breakdown — deliberately not tied to budget structure at all (derivePlatform
// works off raw campaign/spend rows), so unlike a budget-based visual this is available and
// meaningful for literally every workspace that has any synced spend, regardless of whether
// they've set up budget segments yet.
export const PlatformSpendBars=({T,rows,fmtFull})=>{
  if(rows.length===0)return<div style={{fontSize:12*(T.fsScale||1),color:T.textSub,lineHeight:1.6,fontFamily:T.font}}>No spend synced for this period yet.</div>;
  const maxSpend=Math.max(...rows.map(r=>r.spend));
  return(
    <div style={{display:"flex",flexDirection:"column",gap:9}}>
      {rows.map(r=>(
        <div key={r.platform}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11*(T.fsScale||1),marginBottom:3,fontFamily:T.font}}>
            <span style={{color:T.text,fontWeight:600}}>{r.platform}</span>
            <span style={{color:T.textMuted}}>{fmtFull(r.spend)}</span>
          </div>
          <div style={{height:6,borderRadius:T.r3,background:T.pill,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${maxSpend?(r.spend/maxSpend)*100:0}%`,background:T.accent,borderRadius:T.r3}}/>
          </div>
        </div>
      ))}
    </div>
  );
};
// Clickable row used by the populated Dashboard's Quick actions card — a count + label that
// navigates to wherever that count can be resolved (Tagger for untagged, Budget Panel for
// segments spending with no budget set, etc.).
export const DashQuickAction=({label,onClick,T})=>(
  <div onClick={onClick} className="bhq-row" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 8px",borderRadius:T.r6,cursor:"pointer"}}>
    <span style={{fontSize:12*(T.fsScale||1),color:T.text,fontFamily:T.font}}>{label}</span>
    <span style={{fontSize:13*(T.fsScale||1),color:T.textMuted,fontWeight:700}}>→</span>
  </div>
);
// Flips how a filter field's comma-separated terms combine — "or" (matches/excludes on ANY term)
// vs "and" (only when ALL terms are present in the same row). Labeled ANY/ALL rather than OR/AND —
// tested "OR"/"AND" as button text and it was genuinely confusing on the exclude side specifically:
// people read an exclude field's "AND" as "exclude on term1, AND ALSO exclude on term2" (natural
// language, = ANY term triggers exclusion) rather than the boolean-logic meaning this toggle
// actually implements ("and" = co-occurrence, both terms required in the same row). ANY/ALL avoids
// that ambiguity since it describes the terms directly instead of the boolean operator.
// iOS-style sliding switch instead of a two-button pill — same track/thumb treatment as the Tog
// component elsewhere in the app (grey off, papaya on), just with a small state label alongside
// since "ANY"/"ALL" isn't self-explanatory the way a plain on/off toggle is.
export const MatchModeToggle=({mode,onChange,T})=>{
  const isAll=mode==="and";
  return (
    <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}} title="How comma-separated terms combine">
      <div onClick={()=>onChange(isAll?"or":"and")} role="button" tabIndex={0}
        onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onChange(isAll?"or":"and");}}}
        style={{width:26,height:14,borderRadius:T.r7,background:isAll?T.accent:T.borderStrong,position:"relative",cursor:"pointer",transition:"background 0.2s",flexShrink:0,outline:"none"}}>
        <div style={{position:"absolute",top:1.5,left:isAll?13:1.5,width:11,height:11,borderRadius:"50%",background:"#fff",transition:"left 0.18s",boxShadow:"0 1px 2px rgba(0,0,0,0.25)"}}/>
      </div>
      <span style={{fontSize:9*(T.fsScale||1),fontWeight:700,letterSpacing:"0.03em",color:T.textMuted,fontFamily:T.font,minWidth:16}}>{isAll?"ALL":"ANY"}</span>
    </div>
  );
};
// Leading-icon wrapper for the Tagger's filter fields — a search icon inside a rounded pill input
// is the single most recognizable piece of the Vercel-style filter-bar look, so it's worth a small
// wrapper even though the rest of the toolbar keeps its existing include/exclude structure.
export const IconField=({icon,color,children,style})=>(
  <div style={{position:"relative",display:"flex",alignItems:"center",flex:1,...style}}>
    <span style={{position:"absolute",left:9,display:"flex",pointerEvents:"none",zIndex:1}}>
      <Icon name={icon} size={12} color={color}/>
    </span>
    {children}
  </div>
);
// Free-text input with a suggestions dropdown — used for tag values in the Tagger, sourced from
// values already used for that dimension in the Budget Panel (plus other campaigns' existing
// tags), so typing "EP" for a Pillar tag can complete to "EPM Suite" instead of risking a typo
// that silently creates a new, unmatched segment. Tab or a click accepts the highlighted/clicked
// suggestion; arrow keys move the highlight; Escape closes the dropdown first, then falls through
// to the caller's own onEscape (e.g. cancel-editing) on a second press.
export function TagAutocompleteInput({T,value,onChange,suggestions,onEnter,onEscape,onBlur,autoFocus,placeholder,style,inputStyle}){
  const[open,setOpen]=useState(false);
  const[hi,setHi]=useState(0);
  const filtered=useMemo(()=>{
    const q=(value||"").trim().toLowerCase();
    const list=suggestions||[];
    if(!q)return list.slice(0,8);
    const starts=[],contains=[];
    list.forEach(s=>{
      const l=s.toLowerCase();
      if(l===q)return;
      if(l.startsWith(q))starts.push(s);
      else if(l.includes(q))contains.push(s);
    });
    return[...starts.sort((a,b)=>a.localeCompare(b)),...contains.sort((a,b)=>a.localeCompare(b))].slice(0,8);
  },[value,suggestions]);
  // Clamped at render instead of reset via a useEffect (avoids a setState-in-effect cascade) —
  // whenever the filtered list shrinks below the stored index, this just falls back to the top
  // suggestion, which is what a reset-to-0 effect would have produced anyway.
  const safeHi=hi<filtered.length?hi:0;
  const commit=s=>{onChange(s);setOpen(false);setHi(0);};
  return(
    <div style={{position:"relative",...style}} onClick={e=>e.stopPropagation()}>
      <input autoFocus={autoFocus} value={value} placeholder={placeholder}
        onChange={e=>{onChange(e.target.value);setOpen(true);}}
        onFocus={()=>setOpen(true)}
        onBlur={()=>{setOpen(false);onBlur?.();}}
        onKeyDown={e=>{
          if(open&&filtered.length&&(e.key==="ArrowDown"||e.key==="ArrowUp")){
            e.preventDefault();
            const n=filtered.length;
            setHi(e.key==="ArrowDown"?(safeHi+1)%n:(safeHi-1+n)%n);
            return;
          }
          if(e.key==="Tab"&&open&&filtered.length){e.preventDefault();commit(filtered[safeHi]);return;}
          if(e.key==="Enter"){
            if(open&&filtered.length){const s=filtered[safeHi];e.preventDefault();commit(s);onEnter?.(s);}
            else onEnter?.(value);
            return;
          }
          if(e.key==="Escape"){
            if(open){e.preventDefault();setOpen(false);return;}
            onEscape?.();
            return;
          }
        }}
        style={{width:"100%",boxSizing:"border-box",...inputStyle}}/>
      {open&&filtered.length>0&&(
        <div style={{position:"absolute",top:"100%",left:0,marginTop:2,background:T.surface,border:`1px solid ${T.border}`,borderRadius:T.r6,boxShadow:T.shadowMd,zIndex:80,minWidth:140,maxWidth:240,overflow:"hidden"}}>
          {filtered.map((s,i)=>(
            <div key={s} onMouseDown={e=>{e.preventDefault();e.stopPropagation();commit(s);}}
              style={{padding:"6px 10px",fontSize:12*(T.fsScale||1),cursor:"pointer",fontFamily:T.font,background:i===safeHi?T.accentBg:"transparent",color:T.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export const Divider=({T})=><div style={{height:1,background:T.border,margin:"12px 0"}}/>;

// Minimal hand-rolled markdown renderer for Ask AI chat responses (2026-07-28, per Mo's "start
// building" on chat UX polish). Deliberately NOT a dependency (react-markdown etc.) — the app has
// zero markdown/component-library deps anywhere else, and the model's output for this use case is
// narrow enough (bold, bullet/numbered lists, simple pipe tables, plain paragraphs) that a small
// self-contained parser covers it without adding a new package. Not a general CommonMark
// implementation — headers, links, nested lists, and blockquotes are intentionally unsupported
// since Ask AI's system prompt never asks the model to produce them.
function mdInline(s,T,keyPrefix){
  const parts=[];
  let rest=s;
  let key=0;
  const re=/(\*\*([^*]+)\*\*|`([^`]+)`)/;
  while(rest.length){
    const m=re.exec(rest);
    if(!m){parts.push(rest);break;}
    if(m.index>0)parts.push(rest.slice(0,m.index));
    if(m[2]!==undefined)parts.push(<strong key={`${keyPrefix}-${key++}`}>{m[2]}</strong>);
    else parts.push(<code key={`${keyPrefix}-${key++}`} style={{background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r4,padding:"1px 5px",fontSize:"0.92em",fontFamily:"monospace"}}>{m[3]}</code>);
    rest=rest.slice(m.index+m[0].length);
  }
  return parts;
}
const MD_BULLET_RE=/^\s*[-*]\s+(.*)$/;
const MD_NUM_RE=/^\s*(\d+)\.\s+(.*)$/;
const MD_TABLE_SEP_RE=/^\s*\|?[\s:|-]+\|?\s*$/;
function mdTableCells(line){
  let s=line.trim();
  if(s.startsWith("|"))s=s.slice(1);
  if(s.endsWith("|"))s=s.slice(0,-1);
  return s.split("|").map(c=>c.trim());
}
export function MarkdownLite({text,T,style}){
  if(!text)return null;
  const lines=text.split("\n");
  const blocks=[];
  let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    // Pipe table: a row containing "|" immediately followed by a ---/:--/etc. separator row.
    if(line.includes("|")&&lines[i+1]&&MD_TABLE_SEP_RE.test(lines[i+1])&&lines[i+1].includes("-")){
      const header=mdTableCells(line);
      let j=i+2;
      const rows=[];
      while(j<lines.length&&lines[j].includes("|")){rows.push(mdTableCells(lines[j]));j++;}
      blocks.push(
        <table key={blocks.length} style={{borderCollapse:"collapse",width:"100%",margin:"6px 0",fontSize:"0.95em"}}>
          <thead><tr>{header.map((c,ci)=><th key={ci} style={{textAlign:"left",padding:"4px 10px 4px 0",borderBottom:`1.5px solid ${T.border}`,fontWeight:700,color:T.text,whiteSpace:"nowrap"}}>{mdInline(c,T,`th${blocks.length}-${ci}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r,ri)=><tr key={ri}>{r.map((c,ci)=><td key={ci} style={{padding:"4px 10px 4px 0",borderBottom:`1px solid ${T.border}`,color:T.text}}>{mdInline(c,T,`td${blocks.length}-${ri}-${ci}`)}</td>)}</tr>)}</tbody>
        </table>
      );
      i=j;continue;
    }
    // Bullet/numbered list — consecutive matching lines become one <ul>/<ol>.
    if(MD_BULLET_RE.test(line)||MD_NUM_RE.test(line)){
      const ordered=MD_NUM_RE.test(line);
      const items=[];
      while(i<lines.length&&(ordered?MD_NUM_RE.test(lines[i]):MD_BULLET_RE.test(lines[i]))){
        const m=ordered?MD_NUM_RE.exec(lines[i]):MD_BULLET_RE.exec(lines[i]);
        items.push(m[ordered?2:1]);
        i++;
      }
      const ListTag=ordered?"ol":"ul";
      blocks.push(<ListTag key={blocks.length} style={{margin:"4px 0",paddingLeft:20}}>{items.map((it,ii)=><li key={ii} style={{margin:"2px 0"}}>{mdInline(it,T,`li${blocks.length}-${ii}`)}</li>)}</ListTag>);
      continue;
    }
    // Paragraph — gather consecutive plain lines, preserving single line breaks within it.
    const para=[line];
    i++;
    while(i<lines.length&&lines[i].trim()&&!MD_BULLET_RE.test(lines[i])&&!MD_NUM_RE.test(lines[i])&&!(lines[i].includes("|")&&lines[i+1]&&lines[i+1].includes("|")&&MD_TABLE_SEP_RE.test(lines[i+1]))){
      para.push(lines[i]);i++;
    }
    blocks.push(<p key={blocks.length} style={{margin:blocks.length?"6px 0 0":0}}>{para.map((l,li)=><span key={li}>{li>0&&<br/>}{mdInline(l,T,`p${blocks.length}-${li}`)}</span>)}</p>);
  }
  return <div style={style}>{blocks}</div>;
}
// Pixel-block icon set (retro redesign, July 2026) — replaces the flat line-icon set.
// Every glyph is built from a handful of solid squares, no curves/strokes, matching the
// notched-panel / hard-shadow "8-bit" surface language used everywhere a soft rounded
// shadow card used to be.
// Flat lined icons (Obsidian-style) — thin strokes, no fill, replacing the earlier
// pixel-block rect icons as part of moving the whole app back to a softer, conventional look.
export const Icon=({name,size=18,color="currentColor",style})=>{
  const p={width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:color,strokeWidth:1.7,strokeLinecap:"round",strokeLinejoin:"round",...(style?{style}:{})};
  switch(name){
    case"bolt":return<svg {...p}><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H10v-5a2 2 0 0 1 4 0v5h3.5a1 1 0 0 0 1-1v-9"/></svg>; // home — Dashboard
    case"tag":return<svg {...p}><path d="M3 11.5V5a1 1 0 0 1 1-1h6.5L21 13.5a1 1 0 0 1 0 1.4l-6.1 6.1a1 1 0 0 1-1.4 0L3 11.5Z"/><circle cx="8" cy="8" r="1.3" fill={color} stroke="none"/></svg>;
    case"wallet":return<svg {...p}><path d="M3 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"/><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H6a2 2 0 0 1-2-2Z"/><path d="M16 13.2h2.2"/></svg>;
    case"chart":return<svg {...p}><path d="M4 20V13"/><path d="M10 20V9"/><path d="M16 20V5"/><path d="M3 20h18"/></svg>;
    case"export":return<svg {...p}><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>;
    case"sun":return<svg {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>;
    case"moon":return<svg {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>;
    case"alert":return<svg {...p}><path d="M12 3.5 21.5 20H2.5Z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17" r="0.6" fill={color} stroke="none"/></svg>;
    case"gear":return<svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.4 7.4 0 0 0 0-2l2-1.5-2-3.4-2.4.7a7.4 7.4 0 0 0-1.7-1L14.9 3h-3.8l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-.7-2 3.4L6.6 11a7.4 7.4 0 0 0 0 2l-2 1.5 2 3.4 2.4-.7a7.4 7.4 0 0 0 1.7 1l.4 2.4h3.8l.4-2.4a7.4 7.4 0 0 0 1.7-1l2.4.7 2-3.4-2-1.5Z"/></svg>;
    case"clock":return<svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>;
    case"lock":return<svg {...p}><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>;
    case"save":return<svg {...p}><path d="M5 3h11l3 3v15H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M8 3v6h7V3"/><path d="M8 21v-7h8v7"/></svg>;
    case"dots":return<svg {...p}><circle cx="5" cy="12" r="1.6" fill={color} stroke="none"/><circle cx="12" cy="12" r="1.6" fill={color} stroke="none"/><circle cx="19" cy="12" r="1.6" fill={color} stroke="none"/></svg>;
    case"mail":return<svg {...p}><path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"/><path d="M3.5 7 12 13l8.5-6"/></svg>;
    case"download":return<svg {...p}><path d="M12 4v11"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>;
    case"sparkle":return<svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4Z"/></svg>;
    case"send":return<svg {...p}><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>;
    case"plus":return<svg {...p}><path d="M12 5v14M5 12h14"/></svg>;
    case"history":return<svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>;
    case"trash":return<svg {...p}><path d="M4 7h16"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/></svg>;
    case"file":return<svg {...p}><path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/></svg>;
    case"chevronDown":return<svg {...p}><path d="M6 9l6 6 6-6"/></svg>;
    case"panelLeft":return<svg {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>;
    case"search":return<svg {...p}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>;
    case"check":return<svg {...p}><path d="M5 12.5l4.5 4.5L19 7"/></svg>;
    case"ban":return<svg {...p}><circle cx="12" cy="12" r="9"/><path d="M5.5 5.5l13 13"/></svg>;
    case"filter":return<svg {...p}><path d="M3 4.5h18L14 12.5v6l-4 2v-8Z"/></svg>;
    case"info":return<svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M11.25 11.5h1v5.5h1"/></svg>;
    // Goals & Objectives tab (2026-08-01, per Mo) — simple bullseye, matches the flat-line 24x24
    // language every other nav icon here uses.
    case"target":return<svg {...p}><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill={color} stroke="none"/></svg>;
    // "compass" (2026-08-06, per Mo — Account Planning tab) — direction-finding glyph for a
    // restructure/rebuild-planning tool, distinct from "target" (Goals & Objectives) even though
    // both are circle-based; the diamond needle is what reads as "compass" rather than "goal".
    case"compass":return<svg {...p}><circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5 13 13l-4.5 2.5L11 11Z" fill={color} stroke="none"/></svg>;
    // Ask AI improvements (2026-07-28, per Mo — "start building" on the model picker/voice/
    // image-upload/copy/stop set) — four new glyphs matching the same flat-line 24x24 language
    // as everything above.
    case"mic":return<svg {...p}><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/></svg>;
    case"stop":return<svg {...p}><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill={color} stroke="none"/></svg>;
    // Read-aloud toggle (2026-08-19, per Mo's "move the voice feature over" from VaultHQ — the
    // OTHER half of voice: this app already had mic/dictation, VaultHQ's chat additionally offered
    // SpeechSynthesis playback of an assistant answer). "volume" = idle/available, "volume-x" = the
    // same button while THIS message is actively playing (click again to stop).
    case"volume":return<svg {...p}><path d="M5 10v4h3.5L13 17.5v-11L8.5 10Z"/><path d="M16.5 9.5a4 4 0 0 1 0 5"/></svg>;
    case"volume-x":return<svg {...p}><path d="M5 10v4h3.5L13 17.5v-11L8.5 10Z"/><path d="M16 9.5l4 4"/><path d="M20 9.5l-4 4"/></svg>;
    case"copy":return<svg {...p}><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.5"/><path d="M15.5 8.5V5.5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1V15a1 1 0 0 0 1 1h3"/></svg>;
    case"paperclip":return<svg {...p}><path d="M20 11.5 12.5 19a4 4 0 0 1-5.7-5.7L14.6 5.6a2.7 2.7 0 0 1 3.8 3.8l-7.9 7.9a1.4 1.4 0 0 1-2-2l6.9-6.9"/></svg>;
    // Regenerate/edit (2026-07-29, per Mo — "build them all" follow-up: redo an answer, edit a
    // sent question and resend).
    case"refresh":return<svg {...p}><path d="M4 12a8 8 0 0 1 14-5.3L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-14 5.3L4 16"/><path d="M4 20v-4h4"/></svg>;
    case"pencil":return<svg {...p}><path d="M4 20l.9-4.2L15.4 5.3a1.5 1.5 0 0 1 2.1 0l1.2 1.2a1.5 1.5 0 0 1 0 2.1L8.2 19.1 4 20Z"/><path d="M13.5 7.3l3.2 3.2"/></svg>;
    default:return null;
  }
};
// Soft rounded card — replaces the earlier notched-corner / hard-offset-shadow "pixel
// panel" surface now that the app is moving back to a conventional, easier-to-read look.
// Kept the same component name and prop shape (notch/border/shadowOffset are accepted
// but no longer used) so the many existing call sites across the app didn't need to change.
// boxShadow was hardcoded to "none" here regardless of theme (2026-08-01 fix, per Mo — "PaidHQ
// doesn't look like the [Aida reference] png"). Now uses the dedicated T.shadowCard token, not
// T.shadow or T.shadowMd — the reference puts its barely-visible custom "soft" shadow on the
// outer app frame only (see PaidHQ.jsx's PAGE wrapper) and a distinctly different, more visible
// Tailwind stock `shadow-md` on individual content cards (that's T.shadowCard; T.shadowMd stays
// the app's existing general "elevated surface" shadow for dropdowns/modals, unrelated to this
// fix). Border likewise uses the dedicated T.borderCard token, not the general-purpose T.border —
// the reference's card border (`border-gray-100`) is nearly invisible, while T.border is the same
// value used for inputs/dividers/table rules elsewhere and needs to actually read as a line.
// Classic/Midnight's shadowCard is "none" (their prior PixelPanel behavior — flat cards), so this
// is a no-op there; the visual change is Aida-only. borderRadius uses the dedicated T.rCard token
// (not T.r10) — see its definition in core.js for why cards get their own radius scale.
// variant (2026-08-01, per Mo — "vary card backgrounds with featured/accent variants") — optional
// "featured" (soft gradient) or "accent" (mint highlight) background, both sourced from tokens
// that are only defined on THEME_AIDA (cardBgFeatured; "accent" reuses the existing accentSoft
// token rather than a new one). Falls back to the normal T.surface on Classic/Midnight and on
// Aida itself when no variant is passed, so this is purely additive — no existing call site
// changes behavior just from this prop existing.
export const PixelPanel=({T,children,style={},contentStyle={},onClick,variant})=>{
  const bg=variant==="featured"&&T.cardBgFeatured?T.cardBgFeatured:variant==="accent"&&T.accentSoft?T.accentSoft:T.surface;
  return(
    <div onClick={onClick} style={{borderRadius:T.rCard,border:`1px solid ${T.borderCard}`,background:bg,boxShadow:T.shadowCard,cursor:onClick?"pointer":undefined,...style,...contentStyle}}>
      {children}
    </div>
  );
};
// Breadcrumb (2026-08-01, per Mo — "add the breadcrumb and big page-title header") — matches the
// reference's "Home Page > Dashboard" trail above its big h1. Plain text "›" separators rather
// than an SVG chevron — no chevron-right glyph exists in the Icon set above yet and a text
// separator is a one-line addition instead of a new icon case for something this small. Only
// meant to be rendered when T.wideLayout is on; callers gate on that themselves (see Dashboard.jsx/
// DataAudit.jsx/PaidHQ.jsx's Settings view) rather than this component checking it internally, so
// it stays a plain, reusable "list of crumbs" primitive.
export const Breadcrumb=({T,items})=>(
  <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13*(T.fsScale||1),color:T.textMuted,marginBottom:10,fontFamily:T.font}}>
    {items.map((item,i)=>(
      <span key={i} style={{display:"flex",alignItems:"center",gap:8}}>
        {i>0&&<span style={{opacity:0.6}}>›</span>}
        <span style={i===items.length-1?{color:T.text,fontWeight:600}:undefined}>{item}</span>
      </span>
    ))}
  </div>
);

// Small hover tooltip for the warning-triangle icons scattered through the Budget/Reporting
// tables — replaces the native `title` attribute (invisible until a slow hover, unstyled)
// with a small styled callout box. Visibility is toggled by mutating the child's style
// directly on mouseenter/mouseleave, rather than adding per-row React state for 20+ rows.
export const WarnTip=({T,text,size=12,color})=>(
  <span
    onMouseEnter={e=>{const t=e.currentTarget.querySelector("[data-tip]");if(t)t.style.opacity=1;}}
    onMouseLeave={e=>{const t=e.currentTarget.querySelector("[data-tip]");if(t)t.style.opacity=0;}}
    style={{marginLeft:6,display:"inline-flex",position:"relative",cursor:"help"}}>
    <Icon name="alert" size={size} color={color||T.warning}/>
    <span data-tip style={{position:"absolute",bottom:"140%",left:"50%",transform:"translateX(-50%)",opacity:0,pointerEvents:"none",transition:"opacity 0.1s",background:T.surface,color:T.text,fontSize:11*(T.fsScale||1),fontWeight:500,lineHeight:1.45,padding:"8px 10px",borderRadius:T.r8,border:`1px solid ${T.border}`,boxShadow:T.shadowMd,width:220,whiteSpace:"normal",textAlign:"left",zIndex:50,fontFamily:T.font}}>
      {text}
    </span>
  </span>
);

// Neutral hover tooltip for explaining HOW something works (as opposed to WarnTip's "something's
// off, look at this") — same mouseenter/mouseleave opacity-toggle mechanism, but a plain "i" glyph
// instead of a warning triangle, opens downward instead of upward (meant for controls near the top
// of a panel, where an upward tooltip would clip against the header above), and is wider/left-
// aligned with `whiteSpace:"pre-line"` so callers can write real multi-paragraph explanations
// (blank lines in `text` become paragraph breaks) instead of one dense run-on sentence. Added
// 2026-07-25 for the forecasting-model explanation in PacingDashboard, but generic — safe to reuse
// anywhere else an "explain this" affordance is needed.
export const InfoTip=({T,text,size=13,width=320})=>(
  <span
    onMouseEnter={e=>{const t=e.currentTarget.querySelector("[data-tip]");if(t)t.style.opacity=1;}}
    onMouseLeave={e=>{const t=e.currentTarget.querySelector("[data-tip]");if(t)t.style.opacity=0;}}
    style={{marginLeft:6,display:"inline-flex",position:"relative",cursor:"help"}}>
    <Icon name="info" size={size} color={T.textMuted}/>
    <span data-tip style={{position:"absolute",top:"140%",left:0,opacity:0,pointerEvents:"none",transition:"opacity 0.1s",background:T.surface,color:T.text,fontSize:11.5*(T.fsScale||1),fontWeight:500,lineHeight:1.55,padding:"10px 12px",borderRadius:T.r8,border:`1px solid ${T.border}`,boxShadow:T.shadowMd,width,whiteSpace:"pre-line",textAlign:"left",zIndex:50,fontFamily:T.font}}>
      {text}
    </span>
  </span>
);

// Self-contained "✨ AI Summary" trigger + result card, shared by the Budget Panel and
// Reporting & Pacing tabs. Owns its own idle/loading/done/error state so each tab gets an
// independent summary rather than sharing one across navigation.
// each tab gets an independent summary rather than sharing one across navigation.
export function AISummaryCard({T,session,mergedNormRows,tags,budgetDims,budgets,budgetRowMeta,defaultForecastModel,mode,view,combineGoogleChannels=false}){
  const[state,setState]=useState({status:"idle",text:"",error:""});
  const run=useCallback(async()=>{
    setState({status:"loading",text:"",error:""});
    try{
      const text=await aiSummarizeBudgetPacing({mergedNormRows,tags,budgetDims,budgets,budgetRowMeta,defaultForecastModel,mode,view,token:session?.access_token,combineGoogleChannels});
      setState({status:"done",text,error:""});
    }catch(err){
      setState({status:"error",text:"",error:err.message||"Summary failed"});
    }
  },[mergedNormRows,tags,budgetDims,budgets,budgetRowMeta,defaultForecastModel,mode,view,session,combineGoogleChannels]);

  // The Budget Panel has nothing to summarize until a budget structure exists. The Reporting &
  // Pacing tab's Custom/Trend views don't need budgetDims at all (they group by whatever dimensions
  // the user picked, or by date) — see PacingDashboard's own default of viewMode="custom" when
  // budgetDims is empty — so only gate on budgetDims for the Budget Panel and for Pacing's own
  // "budget" view-by mode.
  if(mode==="budget"&&!budgetDims.length)return null;
  if(mode==="pacing"&&view?.viewMode==="budget"&&!budgetDims.length)return null;

  return(
    <div style={{marginBottom:14}}>
      {state.status!=="done"&&
        <Btn onClick={run} disabled={state.status==="loading"} variant="ghost" size="sm" T={T} style={{gap:6}}>
          {state.status==="loading"
            ?<span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:12,height:12,border:`2px solid ${T.border}`,borderTopColor:T.text,borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/> Summarizing…</span>
            :<span>✨ AI Summary</span>}
        </Btn>}
      {state.status==="error"&&<div style={{marginTop:8,padding:"9px 12px",background:T.warningBg,border:`1px solid ${T.warningBorder}`,borderRadius:T.r8,fontSize:12*(T.fsScale||1),color:T.warning}}>{state.error}</div>}
      {state.status==="done"&&(
        // Neutral Venture surface (2026-08-07, per Mo — was the legacy blue accent tint). Shared by
        // the Budget Panel and Pacing tabs.
        <div style={{padding:"11px 14px",background:T.surfaceEl,border:`1px solid ${T.border}`,borderRadius:T.r8,fontSize:12.5*(T.fsScale||1),color:T.text,lineHeight:1.6}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6,gap:8}}>
            <span style={{fontSize:10*(T.fsScale||1),fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted}}>✨ AI Summary</span>
            <div style={{display:"flex",gap:10,flexShrink:0}}>
              <button onClick={run} style={{background:"none",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),fontFamily:T.font,padding:0}}>Regenerate</button>
              <button onClick={()=>setState({status:"idle",text:"",error:""})} style={{background:"none",border:"none",color:T.textMuted,cursor:"pointer",fontSize:11*(T.fsScale||1),fontFamily:T.font,padding:0}}>Dismiss</button>
            </div>
          </div>
          {state.text}
        </div>
      )}
    </div>
  );
}
