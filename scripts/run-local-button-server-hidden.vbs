Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\User\Documents\Codex\2026-05-26\vercel-https-github-com-sunnyngo86-vercel\khaiseong-vercel-binance-funding\scripts\run-local-button-server.ps1"""
code = shell.Run(command, 0, True)
WScript.Quit code
