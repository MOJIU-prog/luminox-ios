# CI 构建结果（真实数据）

## 结论

**编译成功。** 这是第一份证明「这套工程真的能在 macOS 上编过」的证据 ——
之前几轮我只能说「语法合法，但不知道能不能编译」。

```
运行 #2   42985122744
状态      completed / success
耗时      72 秒
平台      macos-latest
产物      Luminox-unsigned-ipa   205.0 KB
过期      2026-12-11T08:12:57Z
```

## 9 个步骤全部 success

```
1.  Set up job                    success
2.  检出代码                        success
3.  环境信息                        success
4.  校验工程结构                     success
5.  列出 Scheme                    success
6.  构建（未签名）                   success   ← xcodebuild archive
7.  检查产物                        success   ← set -e，任一断言失败就红
8.  打包成 ipa                     success
9.  上传产物                        success
10. 构建失败时也上传日志              skipped  ← 因为没失败，正常跳过
```

第 7 步 `检查产物` 带 `set -e`，它内部强制检查了：

- `build/Luminox.xcarchive/Products/Applications/Luminox.app` 目录存在
- `Luminox.app/www/` **目录存在** ← 证明 folder reference 生效，没有被摊平
- 7 个关键文件逐个检查，缺一个就 `exit 1`：
  `index.html` `app.js` `app.css` `lib/llm.js` `lib/kb.js` `lib/memory.js` `lib/personas.js`

**所以这一步通过 = 编译成功 + www 正确打包进 bundle。**

---

## 排查过程：为什么第一次构建被立刻取消

第一次 push 之后，运行 #1 在 **1 秒内**变成 `cancelled`：

```
status       = completed
conclusion   = cancelled
created_at   = 08:06:15Z
updated_at   = 08:06:16Z      ← 只隔 1 秒
job          = Build unsigned ipa  cancelled
runner_name  = (空 → 从未分配到任何 runner)
steps        = 0 个
```

`runner_name` 为空 + `steps` 为 0，说明任务**从未被任何 runner 接走**。
这不是代码问题、不是 YAML 问题（YAML 错会显示 "invalid workflow file"）。

### 对照实验：ubuntu vs macOS

先加一个诊断 workflow，同时跑 `ubuntu-latest` 和 `macos-14`：

| job | 结论 | runner | steps |
|---|---|---|---|
| ubuntu probe | **success** | GitHub Actions 1000000001 | 3 |
| macos probe | cancelled | (从未分配) | 0 |

→ **Actions 本身对这个账号完全正常**，问题只在 macOS。

### 再对照：四个 macOS 标签

| 标签 | 结论 | runner | steps |
|---|---|---|---|
| macos-13 | queued（一直排队） | 从未分配 | 0 |
| **macos-14** | **cancelled** | **从未分配** | **0** |
| **macos-15** | **success** | GitHub Actions 1000000004 | 3 |
| **macos-latest** | **success** | GitHub Actions 1000000005 | 3 |

GitHub 状态页：`未解决事件 = 0`，不是平台故障。

### 根因

`runs-on: macos-14` 在这个仓库下**拿不到 runner**，会在 1 秒内被取消。
换成 `macos-15` 或 `macos-latest` 就正常。

### 修法

```diff
-    runs-on: macos-14
+    runs-on: macos-latest
```

改完立刻成功（72 秒）。

---

## 顺带排除的两个疑点

### 1. 不是 concurrency 把自己取消了

```
含 concurrency = false
```

### 2. git push 一开始根本连不上 GitHub

`github.com:443` 三次 TCP 直连全部 8 秒超时，但：

```
api.github.com:443      ✓ 101ms
ssh.github.com:443      ✓ 126ms
github.com:22           ✓  99ms
codeload.github.com:443 ✓ 155ms
```

查注册表：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
  ProxyEnable = 1
  ProxyServer = http://127.0.0.1:33210
```

**系统挂着代理，浏览器走代理所以能开 GitHub；git / curl / node 默认不读系统代理，
所以直连 443 全部超时。**

这就是为什么一开始 npm、gh CLI、GitHub releases 下载全部 timeou​t。

解法：SSH 走 `github.com:22`（实测 99ms 直连可用），不需要代理。

---

## 仍然没验证的

| 项 | 状态 |
|---|---|
| 装到真 iPhone | 没试 —— 没有设备 |
| 签名 | 没做 —— 需要你的 Apple ID |
| 键盘遮挡的实际效果 | 只在桌面浏览器模拟过 |
| App 实际运行 | 没有 iOS 运行时 |
| LaunchScreen 视觉 | 纯白（`UILaunchScreen` 空字典） |

编译过了 ≠ 跑得起来。要确认能跑，只能装到手机上。
