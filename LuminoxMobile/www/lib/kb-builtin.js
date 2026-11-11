/* Luminox Mobile — 内置知识库（来自桌面版 agent/kb-builtin.js）
 * 12 篇 / 11KB 正文。
 * 这是「随程序发行的运维处置手册」，不是用户自己的知识库。
 * id 前缀 kb-bi- 与原版一致，方便和用户自己加的东西区分。 */
window.LX_KB = [
 {
  "id": "kb-bi-1",
  "name": "Linux 磁盘占满：定位与清理（df / du / lsof）",
  "tags": [
   "磁盘",
   "df",
   "du",
   "inode",
   "日志清理"
  ],
  "category": "manual",
  "content": "## 第一步：确认是\"空间满\"还是\"inode 满\"\ndf -h           # 看各分区使用率\ndf -i           # 看 inode 使用率（小文件太多时 inode 先满，但 df -h 看起来还有空间）\n\n两种情况的处理完全不同：\n- Used% 100% 但 inode 正常 → 删大文件\n- inode 100% → 找小文件多的目录：find / -xdev -type f | cut -d/ -f2 | sort | uniq -c | sort -rn | head\n\n## 第二步：找出到底是谁占了\ndu -xh --max-depth=1 / 2>/dev/null | sort -rh | head -20\n然后逐层往下：du -xh --max-depth=1 /var | sort -rh | head\n\n最常见的三处：\n1) /var/log 日志\n   du -xh /var/log | sort -rh | head\n   清法（不要直接 rm 正在写的日志，会让进程继续往已删除的 inode 里写，空间不释放）：\n   : > /var/log/messages          # 推荐：截断，不删文件\n   journalctl --vacuum-size=200M  # systemd 日志\n2) /var/lib/docker 镜像层\n   docker system df\n   docker system prune -a --volumes   # 注意：会删掉未使用的镜像和卷，先确认\n3) 被删除但没释放的文件（df 和 du 对不上时就是它）\n   lsof +L1 | sort -k7 -rn | head\n   找到 PID 后重启该进程即可释放，例如：systemctl restart rsyslog\n\n## 第三步：验证\ndf -h   # 确认使用率降下来\ndf -i   # 顺手看一眼 inode\n\n## 坑\n- 不要 rm -rf /var/log/* 了事：正在写的日志文件被删后，进程还持有句柄，空间不释放，而且审计线索全没了。\n- 日志膨胀通常说明有东西在刷错误，清日志只是止血，要回头看 journalctl -p err -n 200。\n- 根分区 100% 时 sshd 可能登录失败（无法写 /var/run），需要先在控制台处理。"
 },
 {
  "id": "kb-bi-2",
  "name": "端口不通排查顺序（从本机到对端）",
  "tags": [
   "网络",
   "端口",
   "ss",
   "firewall",
   "telnet"
  ],
  "category": "manual",
  "content": "## 顺序：本机监听 → 本机防火墙 → 链路 → 对端防火墙 → 服务本身\n\n### 1. 服务真的在监听吗（在目标机器上执行）\nss -lntp | grep 22          # 老系统用 netstat -lntp\n注意 Listen 的地址：\n- 0.0.0.0:22 或 [::]:22 → 所有网卡都收\n- 127.0.0.1:22 → 只有本机能连，外部必然不通（改配置里的 ListenAddress / bind）\n\n### 2. 本机防火墙放行了吗\n# firewalld\nfirewall-cmd --list-all\nfirewall-cmd --add-port=8080/tcp --permanent && firewall-cmd --reload\n# iptables\niptables -L -n --line-numbers | head -30\n# ufw（Ubuntu）\nufw status verbose\n\n### 3. 链路通不通（在客户端执行）\nping 目标IP                  # 只证明 IP 可达，ICMP 常被禁，不通不代表端口不通\ntraceroute 目标IP            # Linux；Windows 用 tracert\ntelnet 目标IP 端口            # 或 nc -vz 目标IP 端口；Windows 可用 Test-NetConnection\nPowerShell 等价写法：Test-NetConnection 目标IP -Port 端口\n\ntelnet 的结果怎么读：\n- 连接成功（有欢迎信息或光标闪烁）→ 端口通，问题在应用层（认证/协议）\n- 连接被拒绝（Connection refused）→ 有主机响应但端口没监听 / 被 REJECT\n- 一直卡住超时 → 被 DROP 或路由不通（防火墙 DROP 或网络设备挡了）\n\n### 4. 云主机/物理机之外还可能有\n- 安全组 / 网络 ACL（云上最常见，控制台里要单独放行）\n- NAT / 端口映射没配\n- 中间交换机 ACL、VLAN 间路由没放通\n- 同一台机器上的 SELinux 也会拦端口：getenforce，需 semanage port -a -t http_port_t -p tcp 8080\n\n## 常见误判\n- 用 ping 通不通来判断端口通不通 —— 不对，ICMP 和 TCP 是两套策略。\n- 只在客户端测，不去目标机器看 ss —— 会错过\"服务根本没起来\"。"
 },
 {
  "id": "kb-bi-3",
  "name": "DNS 解析异常：分层排查（客户端 / 服务器 / 缓存）",
  "tags": [
   "DNS",
   "nslookup",
   "dig",
   "resolv.conf"
  ],
  "category": "manual",
  "content": "## 1. 先确认是\"解析不出来\"还是\"解析到错的地址\"\nLinux:   dig 目标域名 +short        / nslookup 目标域名\nWindows: nslookup 目标域名          （注意看用的是哪个 DNS 服务器）\n指定服务器测：dig @223.5.5.5 目标域名 +short\n\n## 2. 看客户端用的是谁\nLinux:   cat /etc/resolv.conf     （有 systemd-resolved 时可能是 127.0.0.53，要看 resolvectl status）\nWindows: ipconfig /all | findstr /i \"DNS\"\n确认里面没有已经不存在的旧 DNS（换了网段最常见的就是这个）。\n\n## 3. 清缓存\nWindows: ipconfig /flushdns\nLinux(systemd): resolvectl flush-caches\nnscd:    nscd -i hosts\n\n## 4. 本机 hosts 有没有覆盖\nLinux: cat /etc/hosts ；Windows: C:\\Windows\\System32\\drivers\\etc\\hosts\nhosts 优先级高于 DNS，排查时经常被忽略。\n\n## 5. 服务器侧（如果是自建 DNS）\ndig @DNS服务器 目标域名            # 绕过客户端直接用服务器查\n查区域文件、转发器、以及\"是否只监听了 127.0.0.1\"。\n\n## 6. 内网 DHCP 下发错 DNS\n内网机器换过网关/DHCP 之后，客户端拿到的还是旧 DNS。表现为：能 ping 通 IP，但域名全部解析失败。\n处理：ipconfig /release + /renew，或手动指定 DNS。\n\n## 判断口诀\n- 能 ping IP、不能 ping 域名 → DNS 问题\n- dig 直连公共 DNS 能解析、本机不能 → 客户端 DNS 配置/缓存问题\n- dig 用对方 DNS 也不能解析 → 服务器侧或上游问题"
 },
 {
  "id": "kb-bi-4",
  "name": "Windows 蓝屏 / 意外重启：定位真实原因",
  "tags": [
   "Windows",
   "蓝屏",
   "BSOD",
   "minidump",
   "事件查看器"
  ],
  "category": "manual",
  "content": "## 1. 先拿到蓝屏代码和转储文件\n- 转储位置：C:\\Windows\\Minidump\\*.dmp（小内存转储）\n- 事件查看器 → Windows 日志 → 系统 → 筛选\"关键/错误\"，找 BugCheck 事件（事件 ID 1001）\n  里面会写 Stop code，例如 0x0000007E、0x000000D1。\n\n## 2. 常见 Stop code 与方向\n- 0x0000007E / 0x0000008E：驱动异常（新装驱动、显卡、杀软滤驱动最常见）\n- 0x000000D1：驱动访问了非法内存地址，多半还是驱动\n- 0x00000050：内存或驱动\n- 0x000000EF：关键系统进程终止（常与杀软/系统文件损坏有关）\n- 0x00000124：硬件（CPU/内存/供电），先跑内存检测\n- 0xC000021A：用户态关键进程崩溃（系统文件损坏）\n\n## 3. 快速定位到具体驱动\n用 WinDbg / BlueScreenView 打开 dmp，看 \"Probably caused by\" 后面那个 .sys。\n没有工具时，按时间点对齐：最近装了什么驱动/软件/更新。\n\n## 4. 通用处置顺序\n1) 卸载最近安装的驱动或更新（设备管理器回滚驱动）\n2) sfc /scannow 修系统文件\n3) DISM /Online /Cleanup-Image /RestoreHealth\n4) 内存检测：mdsched.exe，或换条子再压测\n5) 关掉超频/XMP 再复现\n\n## 5. 排查时别踩的坑\n- 只看\"重启了\"就换电源 —— 先看有没有 BugCheck 记录，没有才是断电/硬件。\n- 蓝屏代码是\"结果\"不是\"原因\"，同一个代码可能对应不同驱动。\n- 虚拟机上蓝屏，先看宿主机资源（内存超分会导致各种诡异蓝屏）。"
 },
 {
  "id": "kb-bi-5",
  "name": "SSH 免密登录配置与排错（publickey 失败）",
  "tags": [
   "SSH",
   "免密",
   "publickey",
   "authorized_keys",
   "权限"
  ],
  "category": "manual",
  "content": "## 标准配置（客户端生成，服务端装公钥）\nssh-keygen -t ed25519 -C \"备注\"          # 一路回车，默认 ~/.ssh/id_ed25519\nssh-copy-id -i ~/.ssh/id_ed25519.pub 用户@主机     # 会自动建目录和权限\n手动装则必须注意权限（这是 90% 失败的原因）：\nmkdir -p ~/.ssh && chmod 700 ~/.ssh\ncat id_ed25519.pub >> ~/.ssh/authorized_keys\nchmod 600 ~/.ssh/authorized_keys\n\n## 排错顺序\n1) ssh -vvv 用户@主机    看最后卡在哪一步\n   - \"Offering public key\" 之后 \"Authentications that can continue\" → 服务端拒绝了这把钥匙\n2) 确认公钥装到了**正确用户**的家目录\n   whoami 是谁，就要装到谁的家目录。用 root 装、用普通用户连，是常见错误。\n   同理 docker/服务账号的 HOME 可能不是 /home/xxx，装之前先 echo $HOME。\n3) 家目录本身权限太大也会失败\n   chmod g-w,o-w ~          # 家目录不能对 group/other 可写，否则 sshd 认为不安全\n4) SELinux 上下文\n   restorecon -R -v ~/.ssh\n5) 服务端配置\n   grep -Ei \"pubkey|authorized\" /etc/ssh/sshd_config\n   需要 PubkeyAuthentication yes，AuthorizedKeysFile 路径要对\n   改完 systemctl reload sshd\n6) 看服务端日志（最直接）\n   journalctl -u sshd -n 50 --no-pager   或   tail -f /var/log/secure\n   会明确写 \"Authentication refused: bad ownership or modes\"。\n\n## 其他常见原因\n- 用户名写错（比如用 root 连一个禁止 root 登录的机器，PermitRootLogin no）\n- 客户端用了错误的私钥：ssh -i 指定，或在 ~/.ssh/config 里配对\n- 家里/公司网络有设备做 SSH 审计，会改写认证流程\n- Windows 的 OpenSSH 服务端：管理员公钥要放 C:\\ProgramData\\ssh\\administrators_authorized_keys"
 },
 {
  "id": "kb-bi-6",
  "name": "VMware 虚拟机常见故障：快照、磁盘、网络",
  "tags": [
   "VMware",
   "快照",
   "虚拟机",
   "vmrun",
   "虚拟网络"
  ],
  "category": "manual",
  "content": "## 1. 虚拟机突然变慢 / 磁盘 IO 高\n- 先看宿主机磁盘剩余空间：快照和挂起文件会长得非常大，宿主机满了整个 VM 会卡死。\n- 检查是否有一长串快照（快照不影响使用但会拖慢写入，且占空间成倍增长）。\n- 精简置备（thin）磁盘删除文件后空间不自动归还，需要 vmware-vdiskmanager -k 收缩（需先清理客户机内空间）。\n\n## 2. 快照相关\n- 不要在虚拟机运行时长期保留快照；开机状态快照包含内存，文件极大。\n- 合并快照（Manage → Consolidate / 命令行 vmware-vdiskmanager）在磁盘 IO 高时容易失败，最好先关机。\n- 快照链损坏时不要硬删 .vmdk，先复制整个目录备份。\n\n## 3. 虚拟网络三种模式\n- 桥接（Bridged）：虚拟机直接拿到局域网 IP，能被同网段其他机器访问。\n- NAT：虚拟机在 VMnet8 后面，出网正常，外面访问需要端口转发。\n- 仅主机（Host-only）：只有宿主机能访问。\n症状对照：虚拟机 ping 不通外网但宿主机能 → 看虚拟网络编辑器里的 NAT 服务是否在运行。\n虚拟机拿到 169.254.x.x → DHCP 没拿到地址，检查 VMnet 的 DHCP 服务。\n\n## 4. 常用命令（Windows 宿主机）\nvmrun -T ws list                                  # 列出运行中的虚拟机\nvmrun -T ws start \"路径.vmx\" nogui                 # 无界面启动\nvmrun -T ws -gu 用户 -gp 密码 runProgramInGuest \"路径.vmx\" 程序 参数\n注意：runProgramInGuest 不回传标准输出，要执行的命令建议写成脚本，输出重定向到文件再拷回来。\n\n## 5. 拷贝/克隆后网络不通\n- Linux：MAC 地址变了但网卡配置文件里还是旧 MAC，删掉 /etc/sysconfig/network-scripts/ifcfg-* 里的 HWADDR 或重新生成。\n- Windows：克隆后 SID 相同会有各种域问题，用 sysprep 处理。\n\n## 6. 虚拟机时间不对\n- 装了 VMware Tools 后默认与宿主机同步，若客户机时间仍漂移，检查是否同时开了 NTP 与 Tools 同步（两者会打架）。"
 },
 {
  "id": "kb-bi-7",
  "name": "交换机端口不通 / 环路 / VLAN 排查",
  "tags": [
   "交换机",
   "VLAN",
   "端口",
   "环路",
   "STP",
   "网络设备"
  ],
  "category": "manual",
  "content": "## 1. 端口物理层\ndisplay interface GigabitEthernet 0/0/1        # 华为/H3C\nshow interfaces status                          # 思科/锐捷\n看 Up/Down、速率双工是否协商一致（一端强制千兆一端自协商 → 大量 CRC 错、丢包）。\n\n## 2. 端口 VLAN 划分\ndisplay port vlan                               # 华为\nshow vlan brief                                 # 思科\naccess 口旁边接的是终端，trunk 口连交换机/AP。最常见的错：把终端接在 trunk 口上，或对端也配成了 access。\n\n## 3. 端口被 STP 阻塞\ndisplay stp brief\n状态里出现 ALTE（Alternate）/ DISCARDING，说明有环路，被生成树挡了。要么是线接成环，要么是双上行没做链路聚合。\n\n## 4. 环路自查\n- 同一对交换机之间接了两根线却没做聚合\n- 面板上两个口用一根网线自环（最常见的误插）\n- 无线 AP 和有线同时桥接\n环路的特征是：所有交换机 CPU 飙高、MAC 地址表不停漂移、全网卡顿。\n紧急处置：拔掉可疑端口，或 shutdown 端口，再逐步恢复。\n\n## 5. 三层不通\n- VLANIF 有没有配 IP、有没有 up（VLAN 里至少要有一个 up 的物理口）\n- 有没有默认路由 / 回程路由（能过去回不来是最常见的\"单向不通\"）\n- ACL 方向搞反\n\n## 6. 端口安全\ndisplay port-security                            # 端口绑定了 MAC，换机器就上不了网\ndisplay mac-address                              # 看 MAC 学到哪个口，判断终端实际接在哪\n\n## 口诀\n物理（灯/速率）→ 二层（VLAN/STP/MAC）→ 三层（IP/路由/ACL）→ 应用（认证/地址池）。"
 },
 {
  "id": "kb-bi-8",
  "name": "CPU 占用过高定位（Linux / Windows）",
  "tags": [
   "CPU",
   "top",
   "性能",
   "进程",
   "任务管理器"
  ],
  "category": "manual",
  "content": "## Linux\n1) 先看整体：top -b -n1 | head -20    或   uptime（看 load average 与核数关系）\n   load 高但 CPU 空闲 → 在等 IO，不是 CPU 问题。\n2) 按 CPU 排序：ps -eo pid,ppid,pcpu,pmem,etime,cmd --sort=-pcpu | head -15\n3) 看线程级：top -H -p 进程PID，找到占 CPU 的线程 TID\n   转成 16 进制：printf \"%x\\n\" TID，再 jstack PID | grep -A 30 nid=0x…（Java 场景）\n4) 常见元凶：\n   - 定时任务撞车（crontab 同时启动多个备份）\n   - 日志轮转/压缩把 CPU 打满\n   - 数据库缺索引导致全表扫描\n   - 病毒/挖矿（进程名伪装成 kdevtmpfsi、xmrig 之类，看 cpu 时间与启动路径）\n\n## Windows\n1) 任务管理器 → 详细信息 → 按 CPU 排序；或\n   Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,Id,CPU\n2) 单个进程高：用 Process Explorer 看线程和栈；\n3) svchost 高：tasklist /svc /fi \"PID eq 1234\" 看到底是哪个服务\n4) 高频见：Windows Update（TiWorker）、杀软全盘扫描、搜索索引（SearchIndexer）、\n   WMI 查询泄漏（wmiprvse）、驱动异常导致 DPC 高（用 LatencyMon 看）。\n\n## 判断是不是\"真的不够用\"\n- 看 CPU 的 %idle 与 %steal（虚拟机被宿主机抢 CPU 时 steal 高）\n- steal 高 → 不是客户机的问题，去宿主机看资源分配/超分。\n- 内存不足导致频繁换页时，CPU 也会被 iowait 拉高，先查 free -h 与 swap 使用。"
 },
 {
  "id": "kb-bi-9",
  "name": "备份与恢复：3-2-1 原则与校验",
  "tags": [
   "备份",
   "恢复",
   "3-2-1",
   "校验",
   "演练"
  ],
  "category": "manual",
  "content": "## 原则\n3-2-1：至少 3 份数据、2 种介质、1 份异地。\n\n## 只有\"能恢复\"的备份才算备份\n- 定期做恢复演练，并在演练记录里写上\"恢复耗时\"和\"数据截止点\"。\n- 校验：备份完成后比对校验和（sha256sum / Get-FileHash），而不是只看文件大小。\n- 数据库不要只备份数据文件（冷备容易不一致），要么逻辑导出（mysqldump --single-transaction），\n  要么用支持一致性快照的方式（LVM 快照 / 存储快照）。\n\n## 常见失败原因\n- 备份任务\"看起来成功\"，其实磁盘满了写到一半（脚本要检查退出码和结果文件大小）\n- 备份文件权限过宽，泄露比丢数据更严重\n- 备份和源在同一块盘 / 同一台机器 → 一起坏\n- 只备份了数据库，忘了配置文件和证书\n- 保留策略（retention）配错，把最近的可恢复点删掉了\n\n## 恢复清单（建议照抄成 checklist）\n1) 明确恢复目标：整机 / 单库 / 单文件 / 某个时间点\n2) 确认备份完整性（校验和 + 能否解包）\n3) 在隔离环境先恢复一次，验证数据可用\n4) 正式恢复前，把当前状态也备份一份（避免二次事故）\n5) 恢复后核对：行数、关键表、时间戳、业务连通性\n6) 记录：谁操作的、用了哪份备份、耗时多久\n\n## 版本化的小技巧\n备份文件名带时间戳与来源，例如：db-2026-01-01T02-00-00_full.sql.gz，\n避免\"backup_final_new.zip\"这种半年后没人敢动的命名。"
 },
 {
  "id": "kb-bi-10",
  "name": "Windows 共享 / 权限 / 映射盘常见问题",
  "tags": [
   "Windows",
   "共享",
   "SMB",
   "权限",
   "映射网络驱动器"
  ],
  "category": "manual",
  "content": "## 1. 能 ping 通但打不开共享\n- 445 端口是否被防火墙拦：Test-NetConnection 服务器 -Port 445\n- Windows 10/11 默认关闭了 SMB1，老 NAS 只支持 SMB1 就会连不上（不建议为了兼容重新开启，优先升级设备固件）\n\n## 2. 提示\"无法访问，您可能没有权限\"\n- 共享权限（网络层）和 NTFS 权限（本地层）取**交集**，两边都要放行。\n- 判断当前有效权限：在服务器上 有效访问 → 选择用户 查看。\n- 用不同账号测试：net use \\\\服务器\\共享 /user:域\\账号 密码\n\n## 3. 凭据缓存导致一直用旧账号\n控制面板 → 凭据管理器 → Windows 凭据，删掉对应条目；\n或命令行：net use * /delete /y  然后 cmdkey /list 检查。\n\n## 4. 映射盘开机不自动连接\n- 用组策略/登录脚本映射，比\"记住凭据\"可靠。\n- 映射时加 /persistent:yes，并确认凭据已保存在该用户下（不是 SYSTEM）。\n\n## 5. 访问慢（点开要等十几秒）\n- 常见是 DNS 反解超时、或客户端在找已下线的浏览主控。\n- 关闭\"自动搜索网络文件夹/打印机\"；服务器侧检查反向解析。\n\n## 6. 文件被占用删不掉\n- 资源监视器 → CPU → 关联的句柄，搜索文件名。\n- 或 handle.exe（Sysinternals）查占用进程。"
 },
 {
  "id": "kb-bi-11",
  "name": "日志该看哪里：Linux 与 Windows 对照表",
  "tags": [
   "日志",
   "journalctl",
   "事件查看器",
   "排查"
  ],
  "category": "manual",
  "content": "## Linux\n- systemd 服务：journalctl -u 服务名 -n 200 --no-pager（加 -f 跟踪，--since \"10 min ago\" 看时间窗）\n- 系统通用：/var/log/messages（RHEL 系）、/var/log/syslog（Debian 系）\n- 认证：/var/log/secure（RHEL）、/var/log/auth.log（Debian）\n- 内核/硬件：dmesg -T | tail -50（-T 显示可读时间）\n- 启动失败：journalctl -b -1 -p err（上一次启动的错误）\n- Web：/var/log/nginx/error.log、access.log；Tomcat 在 logs/catalina.out\n\n## Windows（事件查看器 eventvwr.msc）\n- 系统日志：驱动、服务、硬件、蓝屏（BugCheck 1001）\n- 应用程序日志：应用崩溃（Application Error 1000、.NET Runtime 1026）\n- 安全日志：登录审计（4624 登录成功 / 4625 登录失败 / 4740 账户锁定）\n- 远程桌面：Microsoft-Windows-TerminalServices-LocalSessionManager/Operational\n- 开关机与意外断电：Kernel-Power 41（断电/死机）与 6008（非正常关机）\n\n## 常用命令行\nwevtutil qe System /c:20 /rd:true /f:text\nGet-WinEvent -LogName System -MaxEvents 20 | Format-Table TimeCreated,Id,LevelDisplayName,Message -AutoSize\n按时间窗筛：Get-WinEvent -FilterHashtable @{LogName=\"System\"; StartTime=(Get-Date).AddHours(-2)}\n\n## 看日志的三个习惯\n1) 先按**时间点**对齐（故障发生在几点，就只看那前后 10 分钟）\n2) 同一个错误反复出现，先看第一次出现的时刻，那才是转折点\n3) 记下\"报错原文\"再搜，不要用自己的转述去搜"
 },
 {
  "id": "kb-bi-12",
  "name": "RAID / 硬盘故障判断与更换",
  "tags": [
   "RAID",
   "硬盘",
   "SMART",
   "阵列",
   "硬件"
  ],
  "category": "manual",
  "content": "## 1. 先判断是盘坏了还是链路问题\n- 看 SMART：smartctl -a /dev/sdX  （重点看 Reallocated_Sector_Ct、Pending_Sector、UDMA_CRC_Error_Count）\n- CRC 错误增长通常是线缆/背板，不是盘本身。\n- 系统日志：dmesg | grep -i -E \"ata|scsi|error\"，出现 medium error / I/O error 要警惕。\n\n## 2. RAID 状态\ncat /proc/mdstat                       # Linux 软 RAID\nmegacli -LDInfo -Lall -aALL            # LSI 硬 RAID\nstorcli /c0 show                      # 新版 LSI\nHP：ssacli ctrl all show config\n看到 Degraded / Rebuild 时：\n- Rebuild 期间不要做其他高 IO 操作，也不要重启\n- 一块盘掉线但盘还能识别，可能是背板/线缆松动，先重新插拔\n\n## 3. 更换硬盘的正确顺序\n1) 确认这块盘确实不在阵列里（或已在冗余降级状态），别拔错盘\n2) 记录槽位与序列号（lsblk -o NAME,SERIAL,MODEL）\n3) 拔盘前先定位指示灯（identify/闪灯命令）\n4) 换新盘后确认自动 Rebuild；不自动需手动加回阵列\n5) 全程盯重建进度，重建完成后再做一次数据校验\n\n## 4. 重要提醒\n- RAID 不是备份。误删、勒索病毒、控制器故障都会同时毁掉所有盘。\n- RAID 5 在单盘故障 + 重建期间风险最高，大容量盘重建时间长，重要业务优先 RAID 6 / RAID 10。\n- 换盘前一定先做一份可用的数据备份（如果还能读）。"
 }
];
