$desk = [Environment]::GetFolderPath("Desktop")
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$desk\鱼记得.lnk")
$s.TargetPath = "F:\tool\鱼记得\鱼记得.exe"
$s.WorkingDirectory = "F:\tool\鱼记得"
$s.Description = "鱼记得 note · 可同步的桌面便签"
$s.Save()
Write-Output ("快捷方式已创建: " + $desk + "\鱼记得.lnk")
