# 构建说明（Luminox Mobile iOS）

这个文件存在的原因之一，是让 CI 能自动跑起来 ——
`.github/workflows/build-ios.yml` 的 `on.push.paths` 里包含 `LuminoxMobile/**`，
所以改动这个目录下任何文件都会触发一次构建。

---

## 目标

- iOS 15.0+
- arm64（iOS 设备）
- Bundle ID：`com.luminox.mobile`
- 版本：1.1.1
- 未签名（`CODE_SIGNING_ALLOWED=NO`），由 Sideloadly / AltStore 在本地签名

## 在 macOS 上本地构建

```bash
chmod +x build.sh
./build.sh
# 产物：build/Luminox-unsigned.ipa
```

`build.sh` 做的事：

1. `xcodebuild archive` → 未签名的 `.xcarchive`
2. 从 `.xcarchive/Products/Applications/` 取出 `LuminoxMobile.app`
3. 拷进 `Payload/` 并 `zip -r` 成 `.ipa`

## 在 GitHub Actions 上构建（不需要 Mac）

`.github/workflows/build-ios.yml`，`runs-on: macos-14`，触发方式：

- 手动：Actions → Build iOS ipa → Run workflow
- 自动：push 到 `main`/`master`，且改动命中下面任一路径
  - `LuminoxMobile/**`
  - `LuminoxMobile.xcodeproj/**`
  - `.github/workflows/build-ios.yml`

产物是 `Luminox-unsigned-ipa` artifact，含 `.ipa` 和 `build.log`。

## 结构要点

| 文件 | 作用 |
|---|---|
| `LuminoxApp.swift` | `@main` AppDelegate，创建窗口 |
| `RootViewController.swift` | WKWebView 外壳 + 错误页 + 安全区注入 |
| `LocalHTTPServer.swift` | 在 `127.0.0.1` 起一个极简 HTTP 服务提供 www |
| `www/` | **folder reference**（蓝色文件夹），12 个文件，与安卓版逐字节一致 |
| `Info.plist` | `NSAppTransportSecurity` 的 `NSAllowsLocalNetworking = true` |

### 为什么用 `http://127.0.0.1` 而不是 `loadFileURL`

`file://` 在 WebKit 里是不透明来源：

- `localStorage` 时灵时不灵
- `Origin` 变成 `null`，请求模型 API 会被 CORS 挡
- `crypto.subtle` 不可用

`http://127.0.0.1` 在规范里算**安全来源**，上面三个问题都没有。
所以 `LocalHTTPServer.swift` 承担了“替身静态服务器”的角色。

### `www` 必须是 folder reference

如果当成 group（黄色文件夹），Xcode 会把里面文件**摊平**到 bundle 根目录，
`Bundle.main.url(forResource: "www", withExtension: nil)` 就找不到 →
页面加载失败 → 白屏。

在 `project.pbxproj` 里对应的是 `PBXFileReference` 的 `lastKnownFileType = folder`。
`_test/v2751.js` 里有断言盯着这一点。

## 已知没验证的

| 项 | 状态 |
|---|---|
| 能不能编译 | **不知道** —— 本机是 Windows，只有 Swift 语法解析 |
| 能不能装到 iPhone | 没试 —— 没有设备 |
| 键盘遮挡的实际效果 | 只在桌面浏览器模拟过 `--kb` |
| LaunchScreen 视觉 | 纯白（`UILaunchScreen` 空字典） |

语法这一层用 Swift 5.10.1 for Windows 的 `swift-frontend -parse` 验过：
3 个 Swift 文件 0 error。但 `-parse` 不查类型、不查 API 签名，
所以那**不等于**能编译。
