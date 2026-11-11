# Luminox Mobile — iOS

和安卓版 **同一套 web 层**（android 那边跑过 102 项回归），只是外壳换成了
`WKWebView + 本地 HTTP 服务`。

---

## ⚡ 最快路径（不需要 Mac）

工程已经在这台机器上 init 成 git 仓库并 commit 完了（34 个文件）。

```
1. GitHub 建空仓库（不勾 README / .gitignore / license）
2. 双击 D:\tc\push-to-github.bat，粘贴仓库地址，浏览器登录
3. GitHub → Actions → 「Build iOS ipa」→ Run workflow
4. 等 3~5 分钟 → Artifacts 下载 Luminox-unsigned-ipa
5. Windows 装 Sideloadly + 苹果官网版 iTunes → 填 Apple ID 签名
```

签名前**务必改 Bundle ID**（`project.pbxproj` 里 `PRODUCT_BUNDLE_IDENTIFIER`，
Debug 和 Release 两处都要改），否则 `com.luminox.mobile` 被别人占用会签名失败。

---

## 本地能验到什么程度（别把它当成「能编译」）

这台 Windows 上装了 **Swift 5.10.1 for Windows** 工具链，所以能跑：

```
node D:\tc\_test\swift-parse.js    ← 用真的 swift-frontend -parse 解析语法
node D:\tc\_test\v2751.js          ← 95 项工程校验（含上一项）
```

实测结果：3 个 Swift 文件 **0 error**，合并解析无冲突。

| 能证明 | 不能证明 |
|---|---|
| 语法合法（词法 + 语法分析通过） | **能不能编译**（`-parse` 不查类型、不查 API 签名） |
| 没有括号/引号/声明结构错误 | UIKit / WebKit / Network 是否存在 |
| 没有跨文件语法冲突 | 能不能运行（没有 iOS 运行时） |

**为什么不用 stub 模块去做 `-typecheck`：**
stub 的行为和真 API 不同。万一我的 stub 和真 API 不一致，验证通过反而会给出
**错误的信心**。那种「看起来验过其实没验」的事不做。

真正的答案只有 GitHub Actions 那个 **真 macOS + 真 Xcode**。
第一次跑如果报错，把 `build/build.log` 发出来。

---

```
ios/
├─ LuminoxMobile.xcodeproj/          ← 可以直接双击打开
├─ LuminoxMobile/
│  ├─ LuminoxApp.swift               ← AppDelegate
│  ├─ RootViewController.swift       ← WKWebView 外壳 + 错误界面
│  ├─ LocalHTTPServer.swift          ← 127.0.0.1 上的极简 HTTP 服务
│  ├─ Info.plist                     ← ATS 本地网络例外在这里
│  ├─ Assets.xcassets/AppIcon.appiconset/   ← 10 个尺寸，全部 RGB 无 alpha
│  └─ www/                           ← 12 个文件，和安卓版逐字节一致
├─ project.yml                       ← XcodeGen 兜底重建用
├─ build.sh                          ← 一条命令出 ipa（在 Mac 上跑）
└─ .github/workflows/build-ios.yml   ← 没有 Mac 时用云端构建
```

---

## 为什么是「本地起 HTTP 服务」而不是直接读文件

安卓用 `shouldInterceptRequest` 拦截 `https://luminox.local`，页面拿到的是
真实 https 安全来源。iOS 没有等价接口，`WKURLSchemeHandler` 只支持自定义
scheme。如果直接 `loadFileURL`：

| 问题 | 后果 |
|---|---|
| `file://` 在 WebKit 里是「不透明来源」 | localStorage 时灵时不灵，历史上多次「写完刷新就没了」 |
| `fetch` 的 Origin 变成 `null` | DeepSeek 宽容能过，换一家就废 |
| 自定义 scheme 不是安全上下文 | `crypto.subtle` 直接不可用 |

所以在 `127.0.0.1` 起一个极简 HTTP 服务：
- `http://127.0.0.1` 属于 **potentially trustworthy origin**（安全上下文）
- 页面来源是正常 http 源，Origin 头正确，跨域行为可预期
- 只绑 loopback，端口随机，外部连不进来

代价是 Info.plist 里要开 `NSAllowsLocalNetworking`（苹果给本地网络的正式例外），
**没有关掉 ATS** —— 对 `api.deepseek.com` 依然强制 HTTPS。

---

## 三种拿到 ipa 的路（按推荐排序）

### 路 A：GitHub Actions 云端构建（没有 Mac 时唯一可行）

免费额度：**公开仓库无限分钟**，私有仓库 2000 分钟/月。macOS 跑 2 倍计费，
一次构建约 3-5 分钟 ≈ 6-10 计费分钟。一个月够跑 200-300 次。

```bash
# 1. 在 GitHub 建一个仓库，把 ios/ 整个目录推上去
cd ios
git init && git add -A && git commit -m "ios"
git remote add origin https://github.com/<你的用户名>/luminox-ios.git
git push -u origin main

# 2. Actions 会自动跑，产物在 Actions → 那次运行 → Artifacts
#    下载 Luminox-unsigned-ipa
```

产物是**未签名**的 `Luminox-unsigned.ipa`，拿到之后走路 C 或路 D 签名。

### 路 B：有 Mac（或借一台）

```bash
cd ios
./build.sh --team <你的10位TeamID> --export
```

产出 `build/Luminox.ipa`（已签名，**已内置你的证书**，可以直接装）。

用免费 Apple ID 的话 `--team` 填你的 Team ID，Xcode 会自动申请开发证书。

### 路 C：Windows 上用 Sideloadly 签名（拿到 ipa 之后）

1. 下载 [Sideloadly](https://sideloadly.io)（Windows 版，约 40MB）
2. 装 iTunes（不是 Microsoft Store 版，要 Apple 官网的，提供驱动）
3. iPhone 用数据线连电脑，信任此电脑
4. Sideloadly 里：
   - IPA 选 `Luminox-unsigned.ipa`
   - Apple ID 填你的 Apple ID（**不是**密码给第三方，它走的是苹果官方
     `anisette` 协议在本地换票，但如果你不放心就走路 D）
   - 点 Start
5. iPhone 上：设置 → 通用 → VPN 与设备管理 → 信任你的开发者证书

### 路 D：iPhone 上自签（AltStore / SideStore，不需要电脑长期在线）

- **AltStore**：Windows 上装 AltServer，之后同一 WiFi 下自动续签
- **SideStore**：装一次之后可以完全脱离电脑续签（需要配合 WireGuard 本地 VPN）

---

## ⚠ 签名有效期：这是 iOS 绕不过去的硬限制

| 证书类型 | 有效期 | 重新签名 | 设备数 | 费用 |
|---|---|---|---|---|
| **免费 Apple ID** | **7 天** | 每 7 天必须重新签一次 | 3 个 App | 免费 |
| **付费开发者 ($99/年)** | **1 年** | 一年一次 | 100 台 | ≈ ¥688/年 |

**这就是 iOS 和安卓最本质的区别。** 安卓侧载一次永久有效，iOS 免费证书
每 7 天过期，过期后 App 点开直接闪退，必须连电脑重新签。

所以如果你想要「装一次就不管」，只有两条路：
1. 买付费开发者账号（1 年）
2. 用 AltStore/SideStore 自动续签（仍需每 7 天有一次「能连上电脑/本地网络」的机会）

对「出差在外、完全没有电脑」的场景，iOS 免费签名做不到。这一点我不粉饰。

---

## 手动构建（Xcode 图形界面）

1. 双击 `LuminoxMobile.xcodeproj`
2. 选中 target → Signing & Capabilities
   - Team 选你的 Apple ID
   - Bundle Identifier 改成**全局唯一**的，例如 `com.你的名字.luminox`
     （`com.luminox.mobile` 如果被别人占了会签名失败）
3. 顶部选你的 iPhone（不是模拟器）
4. Product → Run（直接装到手机）
   或 Product → Archive → Distribute App → Development

---

## 已知限制（写清楚，免得当成 bug）

| 项 | 说明 |
|---|---|
| App 图标 | 我用纯 Node 从 512 源图缩放生成，Box 滤波。**1024 那张是从 512 放大的**，边缘会比原生 1024 稍软 |
| 没有 LaunchScreen.storyboard | 用 `UILaunchScreen` 空字典代替（iOS 14+ 支持，全屏、纯白） |
| 不支持 HTTP/2 / Range 请求 | 本地服务只服务静态文件，用不到 |
| 后台不运行 | 切到后台 WebView 暂停，回来会恢复。没有真正的后台任务 |
| 键盘遮挡 | 会把键盘高度通过 `__lxApplyInsets({keyboard:H})` 告诉页面，但**页面那边的 CSS 我给的是安卓的写法**，iOS 上的实际效果没验证过 |

---

## 调试

用 Mac 上的 Safari：
```
Safari → 高级 → 勾选「显示网页开发者功能」
Safari → 开发 → <你的 iPhone> → Luminox
```
可以看到 WebView 里的 `console.log`、网络请求、localStorage。

App 内的错误会在界面上显示（本地服务起不来 / 页面加载失败都有人话提示，
不会白屏）。
