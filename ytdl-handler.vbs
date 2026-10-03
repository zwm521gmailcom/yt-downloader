' ---------------------------------------------------------------------------
'  Handler for the ytdl:// protocol.
'
'  Windows invokes this when the extension's "Start bridge" button opens a
'  ytdl:// link. The URL is passed as the first argument.
'
'  WHY A .vbs AND NOT A .cmd
'  -------------------------
'  Registering a .cmd as a protocol handler always shows a console window:
'  Windows runs batch files through cmd.exe, which creates its console at
'  process start. There is no flag a registry entry can set to suppress it.
'
'  A .vbs runs under wscript.exe, which is a GUI-subsystem host and creates no
'  console at all. It also lets us validate the token before doing anything.
'
'  Usage from the browser:  ytdl://start/<token>
'
'  The token is a shared secret in server\.start-token. The extension reads it
'  through the bridge API and includes it in the URL, so a web page that merely
'  guesses ytdl://start cannot launch the service.
' ---------------------------------------------------------------------------

Option Explicit

Dim shell, fso, here, tokenFile, url, given, expected
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
tokenFile = fso.BuildPath(here, "server\.start-token")

' WScript.Arguments(0) is the URL Windows handed us.
If WScript.Arguments.Count = 0 Then
  Fail "expected ytdl://start/<token> / 需要 ytdl://start/<token> 形式的链接", 2
End If

url = WScript.Arguments(0)

' Strip any query string the browser appended.
If InStr(url, "?") > 0 Then url = Left(url, InStr(url, "?") - 1)

' Remove the known prefixes. "ytdl://" has two slashes, so a naive split would
' leave a leading "/start/" and never match the token.
given = url
given = Replace(given, "ytdl://start/", "")
given = Replace(given, "ytdl:start/", "")
given = Replace(given, "ytdl://", "")
given = Replace(given, "ytdl:", "")
Do While Left(given, 1) = "/"
  given = Mid(given, 2)
Loop

If given = "" Then
  Fail "expected ytdl://start/<token> / 需要 ytdl://start/<token> 形式的链接", 2
End If

' Read the expected token. Without one we refuse rather than launching for
' anyone: failing closed is the whole point of the token.
expected = ""
If fso.FileExists(tokenFile) Then
  Dim f
  Set f = fso.OpenTextFile(tokenFile, 1)
  If Not f.AtEndOfStream Then expected = Trim(f.ReadLine())
  f.Close
End If

If expected = "" Then
  Fail "no launch token found - run install-autostart.cmd once" & vbCrLf & _
       "未找到启动令牌，请先运行 install-autostart.cmd", 3
End If

If StrComp(given, expected, vbTextCompare) <> 0 Then
  Fail "invalid launch token - request ignored" & vbCrLf & _
       "启动令牌无效，已忽略该请求", 4
End If

' Already running? Then there is nothing to do.
If PortInUse(shell, fso, 8765) Then
  WScript.Quit 0
End If

' Start the bridge hidden, exactly as the logon task does.
Dim nodeExe, entry, cmd
entry = fso.BuildPath(here, "server\server.js")
nodeExe = FindNode(fso, shell)
If nodeExe = "" Then
  Fail "Node.js was not found on your PATH." & vbCrLf & _
       "未在 PATH 中找到 Node.js。", 5
End If

cmd = """" & nodeExe & """ """ & entry & """"
shell.Run cmd, 0, False

Set shell = Nothing
Set fso = Nothing
WScript.Quit 0


' Report a problem, but only when a human is likely watching. The browser
' invokes us silently, so we log to a file as well.
Sub Fail(message, code)
  Dim logPath, ts
  On Error Resume Next
  logPath = fso.BuildPath(here, "launch-error.log")
  Set ts = fso.OpenTextFile(logPath, 8, True)
  ts.WriteLine Now & "  " & message
  ts.Close
  On Error GoTo 0
  MsgBox "Video Downloader: " & message, 48, "Video Downloader"
  WScript.Quit code
End Sub


' True when something is already listening on the port.
' Uses a hidden shell run so no console appears.
Function PortInUse(shell, fso, port)
  Dim tmp, f, line
  PortInUse = False
  tmp = fso.GetSpecialFolder(2) & "\ytd-port-check.txt"
  On Error Resume Next
  shell.Run "cmd.exe /c netstat -ano | findstr "":" & port & """ | findstr LISTENING > """ & tmp & """", 0, True
  If Err.Number <> 0 Then
    On Error GoTo 0
    Exit Function
  End If
  On Error GoTo 0

  If fso.FileExists(tmp) Then
    Set f = fso.OpenTextFile(tmp, 1)
    If Not f.AtEndOfStream Then PortInUse = True
    f.Close
    fso.DeleteFile tmp, True
  End If
End Function


' Locate node.exe without leaving a console behind.
Function FindNode(fso, shell)
  Dim candidates, i, p, tmp, f
  FindNode = ""

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
