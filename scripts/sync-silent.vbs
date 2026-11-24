' =============================================================================
' scripts/sync-silent.vbs - silent wrapper for relic-sync scheduled task (win32)
' =============================================================================
' Why this exists: install-schedule.mjs win32 branch needs /TR target that runs
'   npm run sync WITHOUT a visible console (schtasks InteractiveToken logon
'   pops a cmd window for console programs every 5 minutes).
' SILENT mechanism: wscript is a GUI-subsystem host (no console allocated);
'   Shell.Run(..., 0) additionally hides any child console completely.
' GATE NOTE (2026-09-22): the DSH-alive gate used to live here (fdaf102).
'   It moved INTO scripts/sync.mjs step 0 (platform-agnostic, any-harness
'   consumer probe + isTTY manual override). This wrapper now does ONE thing:
'   silent execution. npm run sync itself decides run-or-skip.
' DEPLOYMENT: install-schedule.mjs copies this file to
'   %LOCALAPPDATA%\relic\sync-silent.vbs, replacing __REPO__ with the local
'   engine clone path. The task /TR points at THAT copy, never at the repo,
'   so git pull never clobbers the live wrapper (repo copy stays portable).
' CONSTRAINT: keep this file PURE ASCII. wscript on CJK Windows may read a
'   UTF-8-without-BOM file as GBK and shift string boundaries -> parse chaos.
' NOTE: REPO below ("__REPO__") is replaced by install-schedule.mjs at install time.
' =============================================================================

Option Explicit

Dim REPO, shell
REPO = "__REPO__"
Set shell = CreateObject("WScript.Shell")

' --- run sync silently (gate decision is sync.mjs internal now) ---
shell.Run "cmd /c ""cd /d " & REPO & " && npm run sync""", 0, True
