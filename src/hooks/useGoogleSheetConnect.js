import { useState, useEffect, useRef, useCallback } from "react";
import { parseSpreadsheetId, listSheetTabs, fetchSheetGrid, switchGoogleAccount } from "../lib/googleSheets";

// src/hooks/useGoogleSheetConnect.js — shared Google Sheets connect/fetch flow (2026-07-25
// split, per Mo). Used by both the root app (Data Sources' spend pull, Campaign Tagger's tag
// import) and BudgetManager (Budget import) — extracted here specifically because it's needed
// by more than one of the split-out files, not just one tab.

export function useGoogleSheetConnect(onGrid){
  const[url,setUrl]=useState("");
  const[fetching,setFetching]=useState(false);
  const[error,setError]=useState("");
  const[tabs,setTabs]=useState(null); // null = not resolved yet; array once resolved (only shown when >1 — a single tab is fetched automatically)
  const[spreadsheetId,setSpreadsheetId]=useState("");
  // onGrid closes over caller-local state (e.g. `tags`, `campaignTags`) and is a fresh function
  // every render in every caller — held in a ref so fetchTab/connect below don't need it in their
  // own dependency arrays, the same tension the three original copies already navigated this way.
  // Updated inside an effect rather than directly in the render body — React (and its lint rule)
  // wants render to stay pure/side-effect-free, and by the time a user actually triggers connect()/
  // fetchTab() from a click, this effect has always already committed, so there's no real lag.
  const onGridRef=useRef(onGrid);
  useEffect(()=>{onGridRef.current=onGrid;});

  const fetchTab=useCallback(async(id,tabTitle)=>{
    setError("");setFetching(true);
    try{
      const grid=await fetchSheetGrid(id,tabTitle);
      if(!grid.length)throw new Error(`"${tabTitle}" is empty.`);
      await onGridRef.current(grid,tabTitle);
      setTabs(null);setUrl("");
    }catch(err){
      setError(err.message||"Couldn't read that sheet.");
    }finally{
      setFetching(false);
    }
  },[]);

  const connect=useCallback(async()=>{
    const id=parseSpreadsheetId(url);
    if(!id){setError("Couldn't find a spreadsheet ID in that link — paste the full Google Sheets URL.");return;}
    setError("");setFetching(true);setTabs(null);
    try{
      const{tabs:t}=await listSheetTabs(id);
      if(!t.length)throw new Error("That spreadsheet has no sheets/tabs.");
      setSpreadsheetId(id);
      if(t.length===1)await fetchTab(id,t[0].title);
      else setTabs(t);
    }catch(err){
      setError(err.message||"Couldn't connect to that Google Sheet.");
    }finally{
      setFetching(false);
    }
  },[url,fetchTab]);

  const cancelTabs=useCallback(()=>{setTabs(null);setSpreadsheetId("");},[]);
  // Same "switch account and retry from scratch" behavior all three originals had — re-listing
  // tabs (rather than just re-fetching the same tab) matters here since a different account may
  // not even see the same spreadsheet/tabs the first account did.
  const retryWithNewAccount=useCallback(()=>{switchGoogleAccount();connect();},[connect]);
  // Full blank-slate reset (url + error + tabs + spreadsheetId together) — distinct from cancelTabs,
  // which only backs out of an in-progress tab pick. Callers use this when closing/discarding the
  // whole surrounding import flow (e.g. the Budget import wizard's "start over" reset).
  const reset=useCallback(()=>{setUrl("");setError("");setTabs(null);setSpreadsheetId("");},[]);

  return{url,setUrl,fetching,error,tabs,spreadsheetId,connect,fetchTab,cancelTabs,retryWithNewAccount,reset};
}
