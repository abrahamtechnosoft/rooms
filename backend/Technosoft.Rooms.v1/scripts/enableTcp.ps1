$ErrorActionPreference = 'Stop'
$log = 'C:\Users\Facel\Documents\Abraham\Proyectos\Rooms\backend\Technosoft.Rooms.v1\scripts\enableTcp.log'

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
    Write-Output $line
}

try {
    Set-Content -Path $log -Value '' -Encoding utf8
    Log 'Inicio'

    $tcpKey = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp'
    $ipAll  = "$tcpKey\IPAll"

    Set-ItemProperty -Path $tcpKey -Name 'Enabled'         -Value 1
    Set-ItemProperty -Path $ipAll  -Name 'TcpPort'         -Value '1433'
    Set-ItemProperty -Path $ipAll  -Name 'TcpDynamicPorts' -Value ''

    $enabled = (Get-ItemProperty -Path $tcpKey).Enabled
    $port    = (Get-ItemProperty -Path $ipAll).TcpPort
    $dyn     = (Get-ItemProperty -Path $ipAll).TcpDynamicPorts
    Log ("TCP Enabled={0}  TcpPort={1}  TcpDynamicPorts='{2}'" -f $enabled, $port, $dyn)

    Log 'Reiniciando MSSQL$SQLEXPRESS ...'
    Restart-Service -Name 'MSSQL$SQLEXPRESS' -Force
    $svc = Get-Service -Name 'MSSQL$SQLEXPRESS'
    Log ("Servicio Status={0}" -f $svc.Status)

    # Esperar a que el listener TCP abra el 1433
    $listening = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue) {
            $listening = $true
            break
        }
    }
    Log ("Listening on 1433: {0}" -f $listening)

    Log 'OK'
    exit 0
}
catch {
    Log ('FAIL: ' + $_.Exception.Message)
    exit 1
}
