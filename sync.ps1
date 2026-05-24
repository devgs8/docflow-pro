# Sincronizar D:\DocFlow com OneDrive
$fonte = "D:\DocFlow"
$destino = "C:\Users\geral\OneDrive\DocFlow"

robocopy $fonte $destino /MIR /Z

Write-Host "✅ Sincronizado!" -ForegroundColor Green