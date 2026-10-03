' ---------------------------------------------------------------------------
'  Launch the download-bridge launcher with no visible console window.
'
'  This is the piece that runs at logon. It keeps a tiny loopback service alive
'  so the extension can start or stop the bridge by itself.
'
'  WHY THIS DOES NOT CALL A .cmd FILE
'  ----------------------------------
'  The obvious approach — shell.Run "cmd.exe /c start-launcher.cmd", 0 — still
'  flashes a black window. cmd.exe creates its console when the process starts,
'  and window style 0 is applied to it a moment later, so a frame is visible.
'
'  Instead we invoke node.exe directly. Node is a GUI-subsystem-capable binary
'  and, launched with a hidden window style and no inherited console, it never
'  creates a console window at all.
'
'  Run it by hand any time with:   wscript start-launcher-hidden.vbs
' ---------------------------------------------------------------------------

Option Explicit

Dim shell, fso, here, entry, nodeExe, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
entry = fso.BuildPath(here, "launcher\launcher.js")

If Not fso.FileExists(entry) Then
  MsgBox "Cannot find launcher\launcher.js next to this script:" & vbCrLf & entry, _
         16, "Video Downloader"
  WScript.Quit 1
End If

nodeExe = FindNode(fso, shell)
If nodeExe = "" Then
  MsgBox "Node.js was not found on your PATH." & vbCrLf & vbCrLf & _
         "Install Node.js 18 or newer from https://nodejs.org", _
         16, "Video Downloader"
  WScript.Quit 1
End If

' Quote both paths: they may contain spaces.
cmd = """" & nodeExe & """ """ & entry & """"

' 0 = hidden window, False = do not wait for it to finish.
shell.Run cmd, 0, False

Set shell = Nothing
Set fso = Nothing
WScript.Quit 0


' Locate node.exe without starting a shell. Returns "" when not found.
Function FindNode(fso, shell)
  Dim candidates, i, p
  FindNode = ""

  ' 1. Ask where.exe via a hidden run (its output goes to a temp file).
  '    WScript.Shell.Exec would flash a console, so avoid it.
  Dim tmp, f
  tmp = fso.GetSpecialFolder(2) & "\ytd-node-path.txt"
  On Error Resume Next
  shell.Run "cmd.exe /c where node > """ & tmp & """ 2>nul", 0, True
  If Err.Number = 0 Then
    If fso.FileExists(tmp) Then
      Set f = fso.OpenTextFile(tmp, 1)
      If Not f.AtEndOfStream Then
        p = Trim(f.ReadLine())
        If fso.FileExists(p) Then FindNode = p
      End If
      f.Close
      fso.DeleteFile tmp, True
    End If
  End If
  On Error GoTo 0
  If FindNode <> "" Then Exit Function

  ' 2. Fall back to the usual install locations.
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%APPDATA%\npm\node.exe") _
  )
  For i = 0 To UBound(candidates)
    If fso.FileExists(candidates(i)) Then
      FindNode = candidates(i)
      Exit Function
    End If
  Next
End Function
