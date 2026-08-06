' Double-click to open Grok Desktop (no console window).
' If Electron is missing, falls back to the .bat installer/launcher.

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

electronExe = dir & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(electronExe) Then
  ' First-time: show the bat so install progress is visible
  sh.Run "cmd /c """ & dir & "\Start Grok Desktop.bat""", 1, False
Else
  ' Launch electron; if it fails immediately, open bat with pause so user sees why
  sh.Run """" & electronExe & """ .", 1, False
End If
