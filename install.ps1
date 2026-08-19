# dsh-vision-bridge 一键安装脚本（Windows）
# 用法（目标机一行命令）：
#   powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/li2482589349/dsh-vision-bridge/main/install.ps1 | iex"

$repo = 'https://github.com/li2482589349/dsh-vision-bridge.git'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$pluginDest = Join-Path $dshHome 'plugins\vision-bridge\index.mjs'
$tempClone = Join-Path $env:TEMP ('dsh-vision-bridge-' + [guid]::NewGuid().ToString('N'))

Write-Host '========== dsh-vision-bridge 安装 =========='

# 0) 检查 git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host '[失败] 未找到 git，请先安装 https://git-scm.com' -ForegroundColor Red
    exit 1
}

# 1) 克隆插件源码
Write-Host '[1/4] 下载插件源码...'
git clone --depth 1 $repo $tempClone 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $tempClone 'dsh\index.mjs'))) {
    Write-Host '    直连失败，尝试跳过 SSL 校验（国内网络常见）...'
    if (Test-Path $tempClone) { Remove-Item $tempClone -Recurse -Force }
    git -c http.sslVerify=false clone --depth 1 $repo $tempClone 2>&1 | Out-Null
}
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $tempClone 'dsh\index.mjs'))) {
    Write-Host '[失败] 克隆失败：网络或代理问题。可先手动 git clone 该仓库，或配置 git 代理后再运行。' -ForegroundColor Red
    exit 1
}

# 2) 拷贝插件文件到 DSH 目录
Write-Host '[2/4] 安装插件文件...'
New-Item -ItemType Directory -Path (Split-Path $pluginDest -Parent) -Force | Out-Null
Copy-Item (Join-Path $tempClone 'dsh\index.mjs') $pluginDest -Force
Remove-Item $tempClone -Recurse -Force

# 3) 挂载到 cordis.patch.yml
Write-Host '[3/4] 挂载到组合补丁...'
$fileUrl = 'file:///' + ($pluginDest -replace '\\', '/')
$block = @"

- insert:
    - id: vision-bridge
      name: '$fileUrl'
      config:
        families:
          - deepseek
        mode: auto
"@
if (Test-Path $patchFile) {
    $existing = (Get-Content $patchFile -Raw).Trim()
    if ($existing -eq '[]' -or $existing -eq '') {
        Set-Content -Path $patchFile -Value ("# dsh-vision-bridge install`n" + $block.TrimStart()) -Encoding utf8
    } else {
        Add-Content -Path $patchFile -Value $block -Encoding utf8
    }
} else {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Set-Content -Path $patchFile -Value ("# dsh-vision-bridge install`n" + $block.TrimStart()) -Encoding utf8
}
Write-Host "    已写入: $patchFile"

# 4) 提示视觉引擎配置
Write-Host '[4/4] 检查视觉引擎...'
$settingsFile = Join-Path $dshHome 'settings.yaml'
$hasXiaomi = $false
if (Test-Path $settingsFile) {
    $settingsText = Get-Content $settingsFile -Raw
    $hasXiaomi = $settingsText -match 'xiaomi'
}
if (-not $hasXiaomi) {
    Write-Host ''
    Write-Host '==================================================' -ForegroundColor Yellow
    Write-Host '还需配置一个视觉引擎（插件会自动发现）。' -ForegroundColor Yellow
    Write-Host '在 settings.yaml 添加（推荐 xiaomi/mimo-v2.5）：' -ForegroundColor Yellow
    Write-Host "    $settingsFile" -ForegroundColor Cyan
    Write-Host '--------------------------------------------------' -ForegroundColor Yellow
    Write-Host 'llm-pi-ai:' -ForegroundColor Green
    Write-Host '  providers:' -ForegroundColor Green
    Write-Host '    xiaomi:' -ForegroundColor Green
    Write-Host '      apiKeyEnv: XIAOMI_API_KEY' -ForegroundColor Green
    Write-Host '      models:' -ForegroundColor Green
    Write-Host '        - id: mimo-v2.5' -ForegroundColor Green
    Write-Host '          name: MiMo-V2.5' -ForegroundColor Green
    Write-Host '          contextWindow: 1048576' -ForegroundColor Green
    Write-Host '          maxTokens: 131072' -ForegroundColor Green
    Write-Host '--------------------------------------------------' -ForegroundColor Yellow
    Write-Host '并在 .credentials.yaml 添加（或设环境变量）：' -ForegroundColor Yellow
    Write-Host 'XIAOMI_API_KEY: <你的 key>' -ForegroundColor Green
    Write-Host '（也可用其他支持图片的 provider：Gemini / OpenAI 兼容 / Anthropic，改 providers 即可）' -ForegroundColor DarkGray
    Write-Host '==================================================' -ForegroundColor Yellow
} else {
    Write-Host '    检测到 settings.yaml 已含 xiaomi 路由，跳过提示。'
}

Write-Host ''
Write-Host '========== 安装完成 ==========' -ForegroundColor Green
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  1) 重启 dsh'
Write-Host '  2) 模型选择器选带 "(vision)" 后缀的变体（如 DeepSeek-V4-Flash (vision)）'
Write-Host '  3) 粘贴图片即可自动识别（文档→逐字转录，插画→结构化证据，照片→描述）'
