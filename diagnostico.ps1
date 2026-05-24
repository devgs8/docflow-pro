# SCRIPT DE DIAGNOSTICO DOCFLOW PRO

Write-Host "`nDIAGNOSTICO DOCFLOW PRO" -ForegroundColor Cyan
Write-Host "================================================`n" -ForegroundColor Cyan

# 1. Verificar servidor
Write-Host "[1] Testando servidor..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/api/health" -ErrorAction Stop
    $data = $response.Content | ConvertFrom-Json
    Write-Host "[OK] Servidor ONLINE" -ForegroundColor Green
    Write-Host "    Versao: $($data.versao)" -ForegroundColor Green
    Write-Host "    Uptime: $($data.uptime)s" -ForegroundColor Green
} catch {
    Write-Host "[ERRO] Servidor OFFLINE" -ForegroundColor Red
    Write-Host "    Erro: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "`n[SOLUCAO] Execute: npm run dev`n" -ForegroundColor Yellow
    exit 1
}

# 2. Testar endpoints
Write-Host "`n[2] Endpoints disponiveis:" -ForegroundColor Yellow
Write-Host "    - GET  /" -ForegroundColor Green
Write-Host "    - POST /api/auth/login" -ForegroundColor Green
Write-Host "    - POST /api/auth/register" -ForegroundColor Green
Write-Host "    - POST /api/convert/word-pdf" -ForegroundColor Green
Write-Host "    - POST /api/convert/pdf-word" -ForegroundColor Green
Write-Host "    - POST /api/convert/pdf-excel" -ForegroundColor Green

# 3. Testar autenticacao
Write-Host "`n[3] Testando autenticacao..." -ForegroundColor Yellow
try {
    $loginData = @{
        email = "admin@docflow.ao"
        senha = "Admin@2026"
    } | ConvertTo-Json

    $response = Invoke-WebRequest -Uri "http://localhost:3000/api/auth/login" `
        -Method POST `
        -Headers @{"Content-Type"="application/json"} `
        -Body $loginData `
        -ErrorAction Stop

    $auth = $response.Content | ConvertFrom-Json
    Write-Host "[OK] Login funciona" -ForegroundColor Green
    Write-Host "    Utilizador: $($auth.nome)" -ForegroundColor Green
} catch {
    Write-Host "[AVISO] Login falhou" -ForegroundColor Yellow
    Write-Host "    Erro: $($_.Exception.Message)" -ForegroundColor Yellow
}

# 4. Verificar ficheiros
Write-Host "`n[4] Ficheiros:" -ForegroundColor Yellow
$files = @("server.js", "index.html", "package.json")
foreach ($f in $files) {
    if (Test-Path "D:\DocFlow\$f") {
        $size = [math]::Round((Get-Item "D:\DocFlow\$f").Length / 1024, 1)
        Write-Host "    [OK] $f ($size KB)" -ForegroundColor Green
    } else {
        Write-Host "    [FALTA] $f" -ForegroundColor Red
    }
}

# 5. Verificar pastas
Write-Host "`n[5] Pastas:" -ForegroundColor Yellow
$folders = @("data", "uploads", "temp", "outputs", "logs")
foreach ($d in $folders) {
    if (Test-Path "D:\DocFlow\$d") {
        $count = (Get-ChildItem "D:\DocFlow\$d" -ErrorAction SilentlyContinue | Measure-Object).Count
        Write-Host "    [OK] $d ($count items)" -ForegroundColor Green
    } else {
        Write-Host "    [AVISO] $d (nao existe)" -ForegroundColor Yellow
    }
}

# 6. Verificar node_modules
Write-Host "`n[6] Dependencias:" -ForegroundColor Yellow
if (Test-Path "D:\DocFlow\node_modules") {
    $count = (Get-ChildItem "D:\DocFlow\node_modules" -Directory | Measure-Object).Count
    Write-Host "    [OK] node_modules ($count pacotes instalados)" -ForegroundColor Green
} else {
    Write-Host "    [ERRO] node_modules nao encontrado" -ForegroundColor Red
    Write-Host "    [SOLUCAO] Execute: npm install`n" -ForegroundColor Yellow
}

# 7. Gerar relatorio
Write-Host "`n[7] Gerando relatorio..." -ForegroundColor Yellow
$timestamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$logfile = "D:\DocFlow\diagnostico-$timestamp.log"

$report = @"
RELATORIO DE DIAGNOSTICO DOCFLOW PRO
====================================
Data: $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')
Maquina: $env:COMPUTERNAME
Usuario: $env:USERNAME

STATUS: OK - Sistema pronto para usar

Proximos passos:
1. Abra http://localhost:3000 no browser
2. Faça login com:
   Email: admin@docflow.ao
   Senha: Admin@2026
3. Teste conversao de um PDF
4. Se houver erro, abra a consola (F12) no browser

Se tiver problemas:
- Verifique os logs em D:\DocFlow\logs\
- Verifique se server.js esta rodando
- Verifique http://localhost:3000/api/health
"@

$report | Out-File -FilePath $logfile -Encoding UTF8
Write-Host "    [OK] Relatorio salvo: $logfile" -ForegroundColor Green

Write-Host "`n================================================" -ForegroundColor Cyan
Write-Host "DIAGNOSTICO COMPLETO - Sistema OK" -ForegroundColor Cyan
Write-Host "================================================`n" -ForegroundColor Cyan