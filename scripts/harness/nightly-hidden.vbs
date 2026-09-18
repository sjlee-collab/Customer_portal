' Run regression-nightly.sh with NO console window (Task Scheduler action).
' Why: the bash console shows up as an empty black window during the run and
' users repeatedly mistook it for a hang. Results still go to the log file
' (%USERPROFILE%\portal-nightly\), Slack, and the portal regression-alarm tab.
' Encoding note: this file and the command line must stay pure ASCII.
' WScript.Run passes args as ANSI, and the repo path contains a Korean folder
' name that has no 8.3 short name on this volume - so any non-ASCII path
' segment is replaced with a bash glob "*" (verified unique match).
Option Explicit
Dim fso, sh, here, bash, posix, parts, i, j, bad, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
bash = "C:\Program Files\Git\bin\bash.exe"
posix = fso.GetFile(here & "\regression-nightly.sh").ShortPath
posix = Replace(posix, "\", "/")
posix = "/" & LCase(Left(posix, 1)) & Mid(posix, 3)   ' C:/... -> /c/...
parts = Split(posix, "/")
For i = 0 To UBound(parts)
  bad = False
  For j = 1 To Len(parts(i))
    If AscW(Mid(parts(i), j, 1)) > 127 Then bad = True
  Next
  If bad Then parts(i) = "*"
Next
posix = Join(parts, "/")
cmd = """" & bash & """ -lc ""bash " & posix & """"
sh.Run cmd, 0, False   ' 0 = hidden window, False = do not wait
